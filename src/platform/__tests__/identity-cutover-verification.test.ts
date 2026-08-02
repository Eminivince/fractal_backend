import { describe, expect, it } from "vitest";

import { buildIdentityCutoverReport } from "../identity-cutover-verification.js";

const legacy = { legacyMongoId: "mongo-1", email: "Person@Example.test", legalName: "Person One", status: "active" as const, passwordHash: "legacy-hash", emailVerified: true, credentialInvalidatedAt: new Date("2026-07-29T10:00:00.000Z"), role: "investor" };
const postgres = { id: "postgres-1", legacyMongoId: "mongo-1", email: "person@example.test", legalName: "Person One", status: "active" as const, passwordHash: "legacy-hash", emailVerified: true, credentialInvalidatedAt: new Date("2026-07-29T10:00:00.000Z"), activeGlobalRoles: ["investor"] };

describe("identity cutover verification", () => {
  it("accepts mapped identities with normalized email, equal credentials, matching role, and equal timestamps", () => {
    expect(buildIdentityCutoverReport({ legacy: [legacy], postgresLegacy: [postgres], unmappedActiveSessions: 0 })).toEqual({ ok: true, legacyIdentityCount: 1, postgresLegacyIdentityCount: 1, mismatches: { missingPostgresIdentity: 0, unexpectedPostgresIdentity: 0, fieldMismatch: 0, roleMismatch: 0, unmappedActiveSessions: 0 } });
  });

  it("reports missing and unexpected mapped records without treating native identities as input", () => {
    expect(buildIdentityCutoverReport({ legacy: [legacy], postgresLegacy: [{ ...postgres, legacyMongoId: "mongo-unexpected" }], unmappedActiveSessions: 0 })).toMatchObject({ ok: false, mismatches: { missingPostgresIdentity: 1, unexpectedPostgresIdentity: 1 } });
  });

  it("reports each field, role, and session mismatch without exposing a password hash", () => {
    const report = buildIdentityCutoverReport({ legacy: [legacy], postgresLegacy: [{ ...postgres, passwordHash: "other-hash", emailVerified: false, activeGlobalRoles: ["investor", "admin"] }], unmappedActiveSessions: 2 });
    expect(report).toMatchObject({ ok: false, mismatches: { fieldMismatch: 1, roleMismatch: 1, unmappedActiveSessions: 2 } });
    expect(JSON.stringify(report)).not.toContain("hash");
  });
});
