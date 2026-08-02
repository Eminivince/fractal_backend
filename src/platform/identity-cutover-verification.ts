import { createHash } from "node:crypto";

export interface LegacyIdentitySnapshot {
  legacyMongoId: string;
  email: string;
  legalName: string;
  status: "active" | "disabled";
  passwordHash: string | null;
  emailVerified: boolean;
  credentialInvalidatedAt: Date | null;
  role: string;
}

export interface PostgresLegacyIdentitySnapshot {
  id: string;
  legacyMongoId: string;
  email: string;
  legalName: string;
  status: "active" | "disabled";
  passwordHash: string | null;
  emailVerified: boolean;
  credentialInvalidatedAt: Date | null;
  activeGlobalRoles: string[];
}

export interface IdentityCutoverReport {
  ok: boolean;
  legacyIdentityCount: number;
  postgresLegacyIdentityCount: number;
  mismatches: {
    missingPostgresIdentity: number;
    unexpectedPostgresIdentity: number;
    fieldMismatch: number;
    roleMismatch: number;
    unmappedActiveSessions: number;
  };
}

function credentialFingerprint(value: string | null): string | null {
  // The report must prove equality without ever printing a password hash.
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  if (!left || !right) return left === right;
  return left.getTime() === right.getTime();
}

/**
 * Compares the selected legacy source slice with only its mapped PostgreSQL
 * identities. Native PostgreSQL identities are intentionally not inputs, so
 * new accounts cannot make a source backfill look inconsistent.
 */
export function buildIdentityCutoverReport(input: {
  legacy: readonly LegacyIdentitySnapshot[];
  postgresLegacy: readonly PostgresLegacyIdentitySnapshot[];
  unmappedActiveSessions: number;
}): IdentityCutoverReport {
  const legacyById = new Map(input.legacy.map((identity) => [identity.legacyMongoId, identity]));
  const postgresByLegacyId = new Map(input.postgresLegacy.map((identity) => [identity.legacyMongoId, identity]));
  let missingPostgresIdentity = 0;
  let unexpectedPostgresIdentity = 0;
  let fieldMismatch = 0;
  let roleMismatch = 0;

  for (const [legacyMongoId, legacy] of legacyById) {
    const postgres = postgresByLegacyId.get(legacyMongoId);
    if (!postgres) {
      missingPostgresIdentity += 1;
      continue;
    }
    if (
      postgres.email !== legacy.email.trim().toLowerCase()
      || postgres.legalName !== legacy.legalName
      || postgres.status !== legacy.status
      || credentialFingerprint(postgres.passwordHash) !== credentialFingerprint(legacy.passwordHash)
      || postgres.emailVerified !== legacy.emailVerified
      || !sameTimestamp(postgres.credentialInvalidatedAt, legacy.credentialInvalidatedAt)
    ) {
      fieldMismatch += 1;
    }
    const activeRoles = [...new Set(postgres.activeGlobalRoles)].sort();
    if (activeRoles.length !== 1 || activeRoles[0] !== legacy.role) roleMismatch += 1;
  }

  for (const legacyMongoId of postgresByLegacyId.keys()) {
    if (!legacyById.has(legacyMongoId)) unexpectedPostgresIdentity += 1;
  }

  const mismatches = {
    missingPostgresIdentity,
    unexpectedPostgresIdentity,
    fieldMismatch,
    roleMismatch,
    unmappedActiveSessions: input.unmappedActiveSessions,
  };
  return {
    ok: Object.values(mismatches).every((count) => count === 0),
    legacyIdentityCount: input.legacy.length,
    postgresLegacyIdentityCount: input.postgresLegacy.length,
    mismatches,
  };
}
