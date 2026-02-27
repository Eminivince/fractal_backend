import bcrypt from "bcrypt";
import type { FastifyInstance } from "fastify";
import {
  InvestorProfileModel,
  ProfessionalModel,
  UserModel,
} from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import type {
  AuthLoginPayload,
  AuthRegisterPayload,
  AuthSyncPayload,
} from "../schemas/auth.schemas.js";

type AuthRecord = {
  _id: { toString: () => string };
  role: string;
  businessId?: { toString: () => string };
  professionalId?: { toString: () => string };
  investorProfileId?: { toString: () => string };
  status?: string;
  [key: string]: unknown;
};

const SELF_SERVE_ROLES = new Set(["issuer", "investor", "professional"]);

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

  return user as AuthRecord;
}

export async function registerAuthUser(
  payload: AuthRegisterPayload,
): Promise<AuthRecord> {
  const email = payload.email.toLowerCase();
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

  return user;
}

export async function syncAuthUser(payload: AuthSyncPayload): Promise<AuthRecord> {
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
    return ensureInvestorProfileForUser(user as AuthRecord);
  }

  if (user.status === "disabled") {
    throw new HttpError(403, "User disabled");
  }

  if (payload.role && user.role !== payload.role) {
    if (isPrivilegedRole(user.role)) {
      // A-75: Privileged roles cannot be changed via sync — return existing record
      return user as AuthRecord;
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
      return ensureInvestorProfileForUser(updated as AuthRecord);
    }
  }

  return ensureInvestorProfileForUser(user as AuthRecord);
}

export async function issueAuthToken(
  app: FastifyInstance,
  user: AuthRecord,
): Promise<string> {
  return app.jwt.sign({
    userId: user._id.toString(),
    role: user.role,
    businessId: user.businessId?.toString(),
  });
}

export async function getAuthUserById(userId: string): Promise<AuthRecord> {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw new HttpError(404, "User not found");
  return user as AuthRecord;
}
