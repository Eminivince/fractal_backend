import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { roles, type Role } from "../utils/constants.js";
import { revokeAllAuthSessionsForSubjectInTransaction } from "./auth-sessions.js";
import { enqueueInitialEmailVerificationDelivery } from "./postgres-auth-email-deliveries.js";
import { recordLegalAcceptancesInTransaction, type LegalAcceptanceReference } from "./postgres-platform-content.js";

export class PostgresIdentityUnavailableError extends Error {}
export class PostgresIdentityProjectionError extends Error {}

export interface LegacyIdentityProjectionInput {
  legacyMongoId: string;
  email: string;
  legalName: string;
  role: string;
  status?: "active" | "disabled";
  passwordHash?: string | null;
  emailVerified?: boolean;
  credentialInvalidatedAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  legalAcceptances?: LegalAcceptanceReference[];
  acceptanceMetadata?: { ip?: string; userAgent?: string };
}

export interface PostgresAuthIdentity {
  id: string;
  email: string;
  legalName: string;
  role: Role;
  status: "active" | "disabled";
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  credentialInvalidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PostgresAuthIdentityConflictError extends Error {}

type PostgresAuthIdentityRow = {
  id: string;
  email: string;
  legal_name: string;
  role: string | null;
  status: "active" | "disabled";
  password_hash: string | null;
  email_verified_at: Date | null;
  credential_invalidated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function isRole(value: string | null): value is Role {
  return value !== null && (roles as readonly string[]).includes(value);
}

function normalizeAuthIdentity(row: PostgresAuthIdentityRow): PostgresAuthIdentity | null {
  // A credential record without an active global role is intentionally not
  // authenticatable. This prevents a partially migrated identity from gaining
  // a default role simply because its row exists.
  if (!isRole(row.role)) return null;
  return {
    id: row.id,
    email: row.email,
    legalName: row.legal_name,
    role: row.role,
    status: row.status,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    credentialInvalidatedAt: row.credential_invalidated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const authIdentitySelect = `
  SELECT identity.id, identity.email, identity.legal_name, global_role.role,
         identity.status, identity.password_hash, identity.email_verified_at,
         identity.credential_invalidated_at, identity.created_at, identity.updated_at
    FROM fractal.identities identity
    LEFT JOIN LATERAL (
      SELECT role
        FROM fractal.identity_role_assignments
       WHERE identity_id = identity.id
         AND scope_type = 'global'
         AND revoked_at IS NULL
       ORDER BY granted_at DESC, id DESC
       LIMIT 1
    ) global_role ON TRUE`;

/** Reads the authoritative PostgreSQL account, but never silently invents a role. */
export async function getPostgresAuthIdentityById(identityId: string): Promise<PostgresAuthIdentity | null> {
  const result = await requirePostgres().query<PostgresAuthIdentityRow>(
    `${authIdentitySelect} WHERE identity.id = $1`,
    [identityId],
  );
  const row = result.rows[0];
  return row ? normalizeAuthIdentity(row) : null;
}

export async function getPostgresAuthIdentityByEmail(email: string): Promise<PostgresAuthIdentity | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const result = await requirePostgres().query<PostgresAuthIdentityRow>(
    `${authIdentitySelect} WHERE identity.email = $1`,
    [normalizedEmail],
  );
  const row = result.rows[0];
  return row ? normalizeAuthIdentity(row) : null;
}

/**
 * Native PostgreSQL registration. Unlike the bridge projection, this writes no
 * MongoDB record and never shares a write authority for the identity fact.
 */
export async function createPostgresAuthIdentity(input: {
  email: string;
  legalName: string;
  role: Role;
  passwordHash: string;
  legalAcceptances?: LegalAcceptanceReference[];
  acceptanceMetadata?: { ip?: string; userAgent?: string };
}): Promise<PostgresAuthIdentity> {
  const email = input.email.trim().toLowerCase();
  const legalName = input.legalName.trim();
  if (!email || !legalName || !input.passwordHash) {
    throw new PostgresIdentityProjectionError("PostgreSQL identity registration requires email, legal name, role, and password hash");
  }

  return withPostgresTransaction(async (client) => {
    const identityId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fractal.identities
         (id, email, legal_name, status, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, now(), now())
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [identityId, email, legalName, input.passwordHash],
    );
    if (inserted.rowCount !== 1) {
      throw new PostgresAuthIdentityConflictError("An account with this email already exists");
    }
    await client.query(
      `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
       VALUES ($1, $2, $3, 'global')`,
      [randomUUID(), identityId, input.role],
    );
    if (input.legalAcceptances) {
      await recordLegalAcceptancesInTransaction(client, {
        identityId, references: input.legalAcceptances, context: "registration", affirmativeAction: "checkbox",
        ip: input.acceptanceMetadata?.ip, userAgent: input.acceptanceMetadata?.userAgent,
      });
    }
    await enqueueInitialEmailVerificationDelivery(client, identityId);
    const result = await client.query<PostgresAuthIdentityRow>(
      `${authIdentitySelect} WHERE identity.id = $1`,
      [identityId],
    );
    const identity = result.rows[0] ? normalizeAuthIdentity(result.rows[0]) : null;
    if (!identity) throw new PostgresIdentityProjectionError("PostgreSQL identity registration did not produce an active role assignment");
    return identity;
  });
}

export async function recordPostgresEmailVerificationToken(input: {
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<PostgresAuthIdentity | null> {
  const result = await requirePostgres().query<{ id: string }>(
    `UPDATE fractal.identities
        SET email_verification_token_hash = $2,
            email_verification_expires_at = $3,
            updated_at = now()
      WHERE id = $1 AND email_verified_at IS NULL
      RETURNING id`,
    [input.identityId, input.tokenHash, input.expiresAt],
  );
  if (result.rowCount !== 1) return null;
  return getPostgresAuthIdentityById(input.identityId);
}

export async function consumePostgresEmailVerificationToken(input: {
  email: string;
  tokenHash: string;
}): Promise<boolean> {
  const result = await requirePostgres().query(
    `UPDATE fractal.identities
        SET email_verified_at = now(),
            email_verification_token_hash = NULL,
            email_verification_expires_at = NULL,
            updated_at = now()
      WHERE email = $1
        AND email_verification_token_hash = $2
        AND email_verification_expires_at > now()
        AND email_verified_at IS NULL`,
    [input.email.toLowerCase(), input.tokenHash],
  );
  return result.rowCount === 1;
}

export async function recordPostgresPasswordResetToken(input: {
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<PostgresAuthIdentity | null> {
  const result = await requirePostgres().query<{ id: string }>(
    `UPDATE fractal.identities
        SET password_reset_token_hash = $2,
            password_reset_expires_at = $3,
            password_reset_purpose = 'password_reset',
            updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id`,
    [input.identityId, input.tokenHash, input.expiresAt],
  );
  if (result.rowCount !== 1) return null;
  return getPostgresAuthIdentityById(input.identityId);
}

export async function consumePostgresPasswordResetToken(input: {
  tokenHash: string;
  passwordHash: string;
}): Promise<string | null> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE fractal.identities
          SET password_hash = $2,
              -- OTP remains the verification authority for ordinary users.
              -- Only the non-public administrator activation ceremony may use
              -- its single-use mailbox link to establish verification.
              email_verified_at = CASE
                WHEN password_reset_purpose = 'administrator_activation'
                THEN COALESCE(email_verified_at, now())
                ELSE email_verified_at
              END,
              password_reset_token_hash = NULL,
              password_reset_expires_at = NULL,
              password_reset_purpose = NULL,
              credential_invalidated_at = now(),
              updated_at = now()
        WHERE password_reset_token_hash = $1
          AND password_reset_expires_at > now()
          AND status = 'active'
        RETURNING id`,
      [input.tokenHash, input.passwordHash],
    );
    const identityId = result.rows[0]?.id;
    if (!identityId) return null;
    await revokeAllAuthSessionsForSubjectInTransaction(client, identityId, "password_reset");
    return identityId;
  });
}

/**
 * Keeps the temporary Mongo authentication authority usable with new
 * PostgreSQL-only domains. The write is intentionally synchronous: the caller
 * must not issue a session for an account that cannot resolve to an identity.
 */
export async function projectLegacyIdentity(input: LegacyIdentityProjectionInput): Promise<string> {
  const legacyMongoId = input.legacyMongoId.trim();
  const email = input.email.trim().toLowerCase();
  const legalName = input.legalName.trim();
  if (!legacyMongoId || !email || !legalName || !input.role.trim()) throw new PostgresIdentityProjectionError("Identity projection requires legacy ID, email, legal name, and role");
  return withPostgresTransaction(async (client) => {
    const conflict = await client.query<{ id: string; legacy_mongo_id: string | null }>(
      "SELECT id, legacy_mongo_id FROM fractal.identities WHERE email = $1 FOR UPDATE",
      [email],
    );
    const conflictingIdentity = conflict.rows[0];
    if (conflictingIdentity && conflictingIdentity.legacy_mongo_id !== legacyMongoId) {
      throw new PostgresIdentityProjectionError("Identity email is already bound to a different account");
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO fractal.identities
         (id, legacy_mongo_id, email, legal_name, status, password_hash, email_verified_at, credential_invalidated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), COALESCE($10, now()))
       ON CONFLICT (legacy_mongo_id) DO UPDATE SET
         email = EXCLUDED.email, legal_name = EXCLUDED.legal_name, status = EXCLUDED.status,
         password_hash = EXCLUDED.password_hash, email_verified_at = EXCLUDED.email_verified_at,
         credential_invalidated_at = EXCLUDED.credential_invalidated_at, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [
        randomUUID(), legacyMongoId, email, legalName, input.status === "disabled" ? "disabled" : "active",
        input.passwordHash ?? null, input.emailVerified ? input.updatedAt ?? new Date() : null,
        input.credentialInvalidatedAt ?? null, input.createdAt ?? null, input.updatedAt ?? null,
      ],
    );
    const identityId = result.rows[0]?.id;
    if (!identityId) throw new PostgresIdentityProjectionError("Identity projection did not return an identity");
    await client.query(
      `UPDATE fractal.identity_role_assignments
          SET revoked_at = now()
        WHERE identity_id = $1 AND scope_type = 'global' AND revoked_at IS NULL AND role <> $2`,
      [identityId, input.role],
    );
    await client.query(
      `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
       VALUES ($1, $2, $3, 'global')
       ON CONFLICT (identity_id, role, scope_type, scope_id) DO UPDATE SET revoked_at = NULL`,
      [randomUUID(), identityId, input.role],
    );
    if (input.legalAcceptances) {
      await recordLegalAcceptancesInTransaction(client, {
        identityId, references: input.legalAcceptances, context: "registration", affirmativeAction: "checkbox",
        ip: input.acceptanceMetadata?.ip, userAgent: input.acceptanceMetadata?.userAgent,
      });
    }
    return identityId;
  });
}

/** Resolves the temporary Mongo session subject to the imported PG identity. */
export async function requirePostgresIdentityForSubject(subjectId: string): Promise<string> {
  const result = await requirePostgres().query<{ id: string }>(
    `SELECT id FROM fractal.identities
      WHERE (legacy_mongo_id = $1 OR id::text = $1) AND status = 'active'`,
    [subjectId],
  );
  const identityId = result.rows[0]?.id;
  if (!identityId) throw new PostgresIdentityUnavailableError("PostgreSQL identity is not available for this session");
  return identityId;
}
