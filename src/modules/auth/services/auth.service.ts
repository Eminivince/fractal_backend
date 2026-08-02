import bcrypt from "bcrypt";
import {
  InvestorProfileModel,
  ProfessionalModel,
  UserModel,
} from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { env } from "../../../config/env.js";
import { projectLegacyIdentity, PostgresIdentityProjectionError } from "../../../platform/postgres-identities.js";
import {
  createPostgresAuthIdentity,
  getPostgresAuthIdentityByEmail,
  getPostgresAuthIdentityById,
  PostgresAuthIdentityConflictError,
  type PostgresAuthIdentity,
} from "../../../platform/postgres-identities.js";
import { sendEmailVerification } from "./account-security.service.js";
import type {
  AuthLoginPayload,
  AuthRegisterPayload,
  AuthSyncPayload,
} from "../schemas/auth.schemas.js";
import { PlatformContentError } from "../../../platform/postgres-platform-content.js";

type AuthRecord = {
  _id: { toString: () => string } | string;
  role: string;
  businessId?: { toString: () => string };
  professionalId?: { toString: () => string };
  investorProfileId?: { toString: () => string };
  status?: string;
  email?: string;
  name?: string;
  passwordHash?: string;
  emailVerified?: boolean;
  tokenInvalidatedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
};

const SELF_SERVE_ROLES = new Set(["issuer", "investor", "professional"]);

function rethrowRegistrationContentError(error: unknown): never {
  if (error instanceof PlatformContentError) {
    throw new HttpError(error.code === "unavailable" ? 503 : error.code === "stale_version" ? 409 : 400, error.message);
  }
  throw error;
}

function authRecordId(user: AuthRecord): string {
  return typeof user._id === "string" ? user._id : user._id.toString();
}

function asPostgresAuthRecord(identity: PostgresAuthIdentity): AuthRecord {
  return {
    _id: identity.id,
    role: identity.role,
    status: identity.status,
    email: identity.email,
    name: identity.legalName,
    passwordHash: identity.passwordHash ?? undefined,
    emailVerified: identity.emailVerifiedAt !== null,
    tokenInvalidatedAt: identity.credentialInvalidatedAt ?? undefined,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

async function ensurePostgresIdentity(user: AuthRecord, legal?: { acceptances: AuthRegisterPayload["legalAcceptances"]; metadata: { ip?: string; userAgent?: string } }): Promise<AuthRecord> {
  try {
    await projectLegacyIdentity({
      legacyMongoId: authRecordId(user), email: String(user.email ?? ""), legalName: String(user.name ?? ""),
      role: user.role, status: user.status === "disabled" ? "disabled" : "active", passwordHash: user.passwordHash ?? null,
      emailVerified: user.emailVerified === true, credentialInvalidatedAt: user.tokenInvalidatedAt ?? null,
      createdAt: user.createdAt ?? null, updatedAt: user.updatedAt ?? null,
      legalAcceptances: legal?.acceptances, acceptanceMetadata: legal?.metadata,
    });
    return user;
  } catch (error) {
    if (error instanceof PostgresIdentityProjectionError) throw new HttpError(503, "Account identity provisioning is unavailable. Please try again.");
    throw error;
  }
}

function isPrivilegedRole(role: string): boolean {
  return role === "admin" || role === "operator";
}

async function ensureInvestorProfileForUser(
  user: AuthRecord,
): Promise<AuthRecord> {
  if (user.role !== "investor") return user;
  if (user.investorProfileId) return user;

  const userId = user._id.toString();
  const profile = await InvestorProfileModel.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        kycStatus: "draft",
        eligibility: "retail",
        documents: [],
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  if (profile?._id) {
    const hydrated = await UserModel.findByIdAndUpdate(
      userId,
      {
        $set: { investorProfileId: profile._id },
      },
      { new: true },
    ).lean();
    if (hydrated) return hydrated as AuthRecord;
  }

  const fallback = await UserModel.findById(userId).lean();
  if (fallback) return fallback as AuthRecord;
  throw new HttpError(404, "User not found");
}

export async function authenticateByPassword(
  payload: AuthLoginPayload,
): Promise<AuthRecord> {
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const identity = await getPostgresAuthIdentityByEmail(payload.email);
    if (!identity || identity.status === "disabled") throw new HttpError(401, "Invalid credentials");
    if (!identity.passwordHash || !(await bcrypt.compare(payload.password, identity.passwordHash))) {
      throw new HttpError(401, "Invalid credentials");
    }
    if (!identity.emailVerifiedAt) throw new HttpError(403, "Verify your email address before signing in");
    return asPostgresAuthRecord(identity);
  }

  const user = await UserModel.findOne({ email: payload.email.toLowerCase() }).lean();
  if (!user) throw new HttpError(401, "Invalid credentials");
  if (user.status === "disabled") throw new HttpError(403, "User disabled");

  const passwordHash = (user as { passwordHash?: string }).passwordHash;
  if (!passwordHash) {
    throw new HttpError(
      401,
      "Password not set for this account. Use seed:admin or reset flow.",
    );
  }

  const valid = await bcrypt.compare(payload.password, passwordHash);
  if (!valid) throw new HttpError(401, "Invalid credentials");
  if (!user.emailVerified) {
    throw new HttpError(403, "Verify your email address before signing in");
  }

  return ensurePostgresIdentity(user as AuthRecord);
}

export async function registerAuthUser(
  payload: AuthRegisterPayload,
  metadata: { ip?: string; userAgent?: string },
): Promise<AuthRecord> {
  const email = payload.email.toLowerCase();
  const legalAcceptances = env.NODE_ENV === "development" ? undefined : payload.legalAcceptances;
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const passwordHash = await bcrypt.hash(payload.password, 12);
    try {
      const identity = await createPostgresAuthIdentity({
        email,
        legalName: payload.name,
        role: payload.role,
        passwordHash,
        legalAcceptances,
        acceptanceMetadata: metadata,
      });
      const user = asPostgresAuthRecord(identity);
      // The identity transaction also creates a durable verification-email
      // command. It contains no bearer token; the worker creates one only
      // immediately before delivery.
      return user;
    } catch (error) {
      if (error instanceof PostgresAuthIdentityConflictError) {
        throw new HttpError(409, "An account with this email already exists");
      }
      if (error instanceof PostgresIdentityProjectionError) {
        throw new HttpError(503, "Account identity provisioning is unavailable. Please try again.");
      }
      rethrowRegistrationContentError(error);
    }
  }

  const existing = await UserModel.findOne({ email }).lean();
  if (existing) {
    throw new HttpError(409, "An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(payload.password, 12);
  const created = await UserModel.create({
    email,
    name: payload.name,
    role: payload.role,
    status: "active",
    passwordHash,
  });

  let user = created.toObject() as AuthRecord;
  try {
    await ensurePostgresIdentity(user, legalAcceptances ? { acceptances: legalAcceptances, metadata } : undefined);
  } catch (error) {
    // No durable session or profile exists yet. Remove the just-created legacy
    // row so a retried registration is not stranded behind a half-account.
    await UserModel.findByIdAndDelete(user._id).catch(() => undefined);
    rethrowRegistrationContentError(error);
  }
  if (payload.role === "investor") {
    user = await ensureInvestorProfileForUser(user);
  }

  if (payload.role === "professional") {
    if (!payload.professionalCategory) {
      throw new HttpError(
        422,
        "Professional category is required for professional accounts",
      );
    }

    const professional = await ProfessionalModel.create({
      category: payload.professionalCategory,
      name: payload.name,
      contactEmail: email,
      regions: [],
      slaDays: 5,
      pricing: { model: "flat", amount: 0 },
      onboardingStatus: "draft",
      status: "active",
    });

    const updatedUser = await UserModel.findByIdAndUpdate(
      user._id,
      {
        $set: { professionalId: professional._id },
      },
      { new: true },
    ).lean();

    if (!updatedUser) throw new HttpError(404, "User not found");
    user = updatedUser as AuthRecord;
  }

  // The legacy bridge retains its current non-blocking delivery behaviour.
  void sendEmailVerification(String(user._id)).catch(() => {});

  return user;
}

export async function syncAuthUser(payload: AuthSyncPayload): Promise<AuthRecord> {
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    // The native UI uses password registration. Do not allow this legacy
    // synchronization endpoint to become a second identity writer after the
    // cutover merely because it still exists for migration environments.
    throw new HttpError(410, "External identity synchronization is not available for the PostgreSQL identity authority.");
  }

  const email = payload.email.toLowerCase();
  let user = await UserModel.findOne({ email }).lean();

  if (!user) {
    if (!payload.role) {
      throw new HttpError(
        422,
        "Role is required for first-time account sync",
      );
    }

    const created = await UserModel.create({
      email,
      name: payload.name,
      role: payload.role,
      status: "active",
    });
    user = created.toObject();
    try {
      await ensurePostgresIdentity(user as AuthRecord);
    } catch (error) {
      await UserModel.findByIdAndDelete(created._id).catch(() => undefined);
      throw error;
    }
    return ensurePostgresIdentity(await ensureInvestorProfileForUser(user as AuthRecord));
  }

  if (user.status === "disabled") {
    throw new HttpError(403, "User disabled");
  }

  if (payload.role && user.role !== payload.role) {
    if (isPrivilegedRole(user.role)) {
      // A-75: Privileged roles cannot be changed via sync — return existing record
      return ensurePostgresIdentity(user as AuthRecord);
    }

    if (SELF_SERVE_ROLES.has(user.role)) {
      const hasLinkedEntities =
        user.businessId || user.professionalId || user.investorProfileId;

      if (hasLinkedEntities) {
        // A-75: Explicitly reject silent role change when the user has linked
        // entities — prevents mismatched state from propagating silently.
        throw new HttpError(
          409,
          `Role change from '${user.role}' to '${payload.role}' is not permitted: ` +
            "account has linked entities that must be detached first.",
        );
      }

      const updated = await UserModel.findByIdAndUpdate(
        user._id,
        {
          $set: {
            role: payload.role,
            name: payload.name,
          },
          $unset: {
            businessId: 1,
            professionalId: 1,
            professionalMembershipRole: 1,
            investorProfileId: 1,
          },
        },
        { new: true },
      ).lean();

      if (!updated) throw new HttpError(404, "User not found");
      return ensurePostgresIdentity(await ensureInvestorProfileForUser(updated as AuthRecord));
    }
  }

  return ensurePostgresIdentity(await ensureInvestorProfileForUser(user as AuthRecord));
}

export async function getAuthUserById(userId: string): Promise<AuthRecord> {
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const identity = await getPostgresAuthIdentityById(userId);
    if (!identity) throw new HttpError(404, "User not found");
    return asPostgresAuthRecord(identity);
  }

  const user = await UserModel.findById(userId).lean();
  if (!user) throw new HttpError(404, "User not found");
  return user as AuthRecord;
}
