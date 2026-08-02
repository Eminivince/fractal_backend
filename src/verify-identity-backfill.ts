import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { UserModel } from "./db/models.js";
import { connectPostgres, disconnectPostgres, requirePostgres } from "./db/postgres.js";
import {
  buildIdentityCutoverReport,
  type LegacyIdentitySnapshot,
  type PostgresLegacyIdentitySnapshot,
} from "./platform/identity-cutover-verification.js";

type LegacyMongoIdentity = {
  _id: { toString(): string };
  email?: string;
  name?: string;
  role?: string;
  status?: string;
  passwordHash?: string;
  emailVerified?: boolean;
  tokenInvalidatedAt?: Date;
};

try {
  await connectMongo();
  await connectPostgres({ required: true });

  const [mongo, postgres, activeSessionGaps] = await Promise.all([
    UserModel.find({})
      .select("_id email name role status passwordHash emailVerified tokenInvalidatedAt")
      .lean(),
    requirePostgres().query<{
      id: string;
      legacy_mongo_id: string;
      email: string;
      legal_name: string;
      status: "active" | "disabled";
      password_hash: string | null;
      email_verified_at: Date | null;
      credential_invalidated_at: Date | null;
      active_global_roles: string[];
    }>(
      `SELECT identity.id, identity.legacy_mongo_id, identity.email, identity.legal_name,
              identity.status, identity.password_hash, identity.email_verified_at,
              identity.credential_invalidated_at,
              COALESCE(array_agg(role.role) FILTER (WHERE role.id IS NOT NULL), ARRAY[]::text[]) AS active_global_roles
         FROM fractal.identities identity
         LEFT JOIN fractal.identity_role_assignments role
           ON role.identity_id = identity.id
          AND role.scope_type = 'global'
          AND role.revoked_at IS NULL
        WHERE identity.legacy_mongo_id IS NOT NULL
        GROUP BY identity.id
        ORDER BY identity.legacy_mongo_id`,
    ),
    requirePostgres().query<{ count: string }>(
      `SELECT count(*) AS count
         FROM fractal.auth_sessions
         LEFT JOIN fractal.identities legacy_identity
           ON legacy_identity.legacy_mongo_id = auth_sessions.subject_id
         LEFT JOIN fractal.identities native_identity
           ON native_identity.id::text = auth_sessions.subject_id
        WHERE auth_sessions.revoked_at IS NULL
          AND auth_sessions.expires_at > now()
          AND (
            auth_sessions.identity_id IS NULL
            OR (legacy_identity.id IS NOT NULL AND auth_sessions.identity_id IS DISTINCT FROM legacy_identity.id)
            OR (native_identity.id IS NOT NULL AND auth_sessions.identity_id IS DISTINCT FROM native_identity.id)
            OR (legacy_identity.id IS NULL AND native_identity.id IS NULL)
          )`,
    ),
  ]);
  const legacy = (mongo as LegacyMongoIdentity[]).map((identity) => ({
    legacyMongoId: String(identity._id),
    email: String(identity.email ?? ""),
    legalName: String(identity.name ?? ""),
    status: identity.status === "disabled" ? "disabled" : "active",
    passwordHash: typeof identity.passwordHash === "string" ? identity.passwordHash : null,
    emailVerified: identity.emailVerified === true,
    credentialInvalidatedAt: identity.tokenInvalidatedAt instanceof Date ? identity.tokenInvalidatedAt : null,
    role: String(identity.role ?? ""),
  })) satisfies LegacyIdentitySnapshot[];
  const postgresLegacy = postgres.rows.map((identity) => ({
    id: identity.id,
    legacyMongoId: identity.legacy_mongo_id,
    email: identity.email,
    legalName: identity.legal_name,
    status: identity.status,
    passwordHash: identity.password_hash,
    emailVerified: identity.email_verified_at !== null,
    credentialInvalidatedAt: identity.credential_invalidated_at,
    activeGlobalRoles: identity.active_global_roles,
  })) satisfies PostgresLegacyIdentitySnapshot[];
  const report = buildIdentityCutoverReport({
    legacy,
    postgresLegacy,
    unmappedActiveSessions: Number(activeSessionGaps.rows[0]?.count ?? 0),
  });
  console.log(JSON.stringify({ kind: "identity-cutover-reconciliation", ...report }));
  if (!report.ok) throw new Error("Identity backfill validation failed; inspect the reconciliation report above without relying on aggregate counts.");
} finally {
  await disconnectPostgres();
  await disconnectMongo();
}
