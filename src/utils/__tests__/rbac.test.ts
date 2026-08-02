// A-81: Seed unit tests for the RBAC utility
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { describe, it, expect, vi } from "vitest";
import { authorize } from "../rbac.js";
import { HttpError } from "../errors.js";
import type { AuthUser } from "../../types.js";
import { isAuthoritativeApiPath, shouldBlockLegacyApiPath } from "../../middleware/authoritative-api-boundary.js";
import { assertPrivilegedActionRole, privilegedActionPolicies, registerPrivilegedActionStepUpPolicy, resolvePrivilegedActionPolicy } from "../../middleware/privileged-action-step-up.js";
import { booleanFromString } from "../boolean.js";
import { registerRateLimit } from "../../middleware/rate-limit.js";

function makeUser(role: AuthUser["role"]): AuthUser {
  return { userId: "test-user", role };
}

describe("authorize()", () => {
  it("allows admin to read any resource", () => {
    const user = makeUser("admin");
    expect(() => authorize(user, "read", "business")).not.toThrow();
    expect(() => authorize(user, "read", "distribution")).not.toThrow();
    expect(() => authorize(user, "read", "user")).not.toThrow();
  });

  it("allows operator to approve distributions", () => {
    const user = makeUser("operator");
    expect(() => authorize(user, "approve", "distribution")).not.toThrow();
  });

  it("blocks investor from approving distributions", () => {
    const user = makeUser("investor");
    expect(() => authorize(user, "approve", "distribution")).toThrow(HttpError);
  });

  it("allows issuer to create applications", () => {
    const user = makeUser("issuer");
    expect(() => authorize(user, "create", "application")).not.toThrow();
  });

  it("allows issuer to submit a governed offering request but not execute it", () => {
    const user = makeUser("issuer");
    expect(() => authorize(user, "submit", "offering")).not.toThrow();
    expect(() => authorize(user, "execute", "offering")).toThrow(HttpError);
  });

  it("blocks professional from creating offerings", () => {
    const user = makeUser("professional");
    expect(() => authorize(user, "create", "offering")).toThrow(HttpError);
  });

  it("throws HttpError with 403 status code on denial", () => {
    const user = makeUser("investor");
    try {
      authorize(user, "create", "business");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }
  });

  it("allows admin to execute reconciliation", () => {
    const user = makeUser("admin");
    expect(() => authorize(user, "execute", "reconciliation")).not.toThrow();
  });

  it("blocks issuer from executing reconciliation", () => {
    const user = makeUser("issuer");
    expect(() => authorize(user, "execute", "reconciliation")).toThrow(HttpError);
  });

  it("allows professional to submit work orders", () => {
    const user = makeUser("professional");
    expect(() => authorize(user, "submit", "work_order")).not.toThrow();
  });

  it("allows admin to update platform config", () => {
    const user = makeUser("admin");
    expect(() => authorize(user, "update", "platform")).not.toThrow();
  });

  it("blocks operator from updating platform config", () => {
    const user = makeUser("operator");
    expect(() => authorize(user, "update", "platform")).toThrow(HttpError);
  });
});

describe("production authoritative API boundary", () => {
  it("allows only the production-governed vertical slices", () => {
    expect(isAuthoritativeApiPath("/v1/auth/login")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/auth/sessions/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/revoke")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/offerings/offer-1/checkout")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/investor/portfolio?limit=20")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/investor/identity-verification/application")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/governance/organizations")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/professional/work-orders")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/offerings/offer-1")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/investor/suitability/status")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/professionals")).toBe(false);
  });

  it("does not classify legacy actor endpoints as production capabilities", () => {
    expect(isAuthoritativeApiPath("/v1/businesses")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/distributions")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/reports")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/access-identities")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/audit-events?limit=25")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/system-health")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/access-change-requests?status=pending")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/access-change-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/access-change-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/capabilities")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/capability-change-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/capability-change-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/capability-change-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/audit-exports")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/audit-exports/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/download")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/audit-exports/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/provider-incidents")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/provider-incidents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/provider-incidents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/transitions")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/provider-incidents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/support/cases")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/support/cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/messages")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/support/cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/attachments")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/support/attachments/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/download")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/support/cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/support-cases")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/transitions")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/attachments")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-attachments/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/download")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-attachments/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/lifecycle")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-attachments/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/legal-hold-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-attachment-hold-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-attachments/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/disposition-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/support-attachment-disposition-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-documents/lifecycle")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-documents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/lifecycle")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-documents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/legal-hold-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-document-hold-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-documents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/disposition-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-document-disposition-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/organization-documents/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/distribution-lifecycle/distribution_declaration/0150cae6-6696-4b9a-a862-8f9ed9b88d4c")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/distribution-lifecycle/distribution_declaration/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/legal-hold-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/distribution-lifecycle-hold-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/investor/notices")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/investor/notices/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/read")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/investor/notices/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/support-cases/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/delete")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/privacy/requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/privacy/requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/privacy/requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/messages")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/privacy/requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/withdraw")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-data-inventory")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/transitions")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/policy-binding")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/external-snapshots")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/sumsub-provider-exports")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/package-preparations")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/distribution-treatment-requests")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/distribution-privacy-treatment-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/admin/privacy-decision-requests/0150cae6-6696-4b9a-a862-8f9ed9b88d4c/decision")).toBe(true);
    expect(isAuthoritativeApiPath("/v1/investor/data-export")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/investor/deletion-request")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/admin/webhooks")).toBe(false);
    expect(isAuthoritativeApiPath("/v1/auth/sync")).toBe(false);
    expect(shouldBlockLegacyApiPath("/v1/distributions", true)).toBe(true);
    expect(shouldBlockLegacyApiPath("/blockchain/provision-wallet", true)).toBe(true);
    expect(shouldBlockLegacyApiPath("/v1/auth/sync", true)).toBe(true);
    expect(shouldBlockLegacyApiPath("/v1/investor/suitability/status", true)).toBe(true);
    expect(shouldBlockLegacyApiPath("/v1/professionals", true)).toBe(true);
    expect(shouldBlockLegacyApiPath("/v1/investor/portfolio", true)).toBe(false);
    expect(shouldBlockLegacyApiPath("/readyz", true)).toBe(false);
    expect(shouldBlockLegacyApiPath("/v1/distributions", false)).toBe(false);
  });
});

describe("rate-limit registration", () => {
  it("limits one login account across peers without locking out distinct accounts behind one peer", async () => {
    const app = Fastify();
    await registerRateLimit(app);
    app.post("/v1/auth/login", async () => ({ ok: true }));
    await app.ready();

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: `shared-network-${attempt}@example.test` },
        headers: { "x-forwarded-for": `198.51.100.${attempt + 1}` },
      });
      expect(response.statusCode).toBe(200);
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "target@example.test" },
        headers: { "x-forwarded-for": `203.0.113.${attempt + 1}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: " TARGET@example.test " },
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    await app.close();
  });

  it("retains a peer-address ceiling and never trusts caller-supplied forwarding headers", async () => {
    const app = Fastify();
    await registerRateLimit(app);
    app.post("/v1/auth/login", async () => ({ ok: true }));
    await app.ready();

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: `network-ceiling-${attempt}@example.test` },
        headers: { "x-forwarded-for": `192.0.2.${(attempt % 250) + 1}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "network-ceiling-final@example.test" },
      headers: { "x-forwarded-for": "198.51.100.200" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    await app.close();
  });

  it("limits verification guesses per account without locking out distinct accounts behind one peer", async () => {
    const app = Fastify();
    await registerRateLimit(app);
    app.post("/v1/auth/verify-email", async () => ({ ok: true }));
    await app.ready();

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify-email",
        payload: { email: `shared-network-verification-${attempt}@example.test`, code: "123456" },
      });
      expect(response.statusCode).toBe(200);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify-email",
        payload: { email: "verification-target@example.test", code: "123456" },
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-email",
      payload: { email: " VERIFICATION-TARGET@example.test ", code: "123456" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    await app.close();
  });

  it("keeps routine authenticated session reads on the global ceiling", async () => {
    const app = Fastify();
    await registerRateLimit(app);
    app.get("/v1/auth/me", async () => ({ ok: true }));
    await app.ready();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/v1/auth/me" });
      expect(response.statusCode).toBe(200);
    }

    await app.close();
  });
});

describe("privileged-action step-up policy", () => {
  it("covers every currently enabled ownership, money, and custody transition", () => {
    expect(privilegedActionPolicies).toHaveLength(97);
    const examples = [
      ["/v1/admin/access-change-requests", "admin"],
      ["/v1/admin/access-change-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/capability-change-requests", "admin"],
      ["/v1/admin/capability-change-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/audit-exports", "admin"],
      ["/v1/admin/provider-incidents", "admin"],
      ["/v1/admin/provider-incidents/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/transitions", "admin"],
      ["/v1/admin/support-cases/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/transitions", "admin"],
      ["/v1/admin/support-cases/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/attachments", "admin"],
      ["/v1/admin/support-attachments/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/legal-hold-requests", "admin"],
      ["/v1/admin/support-attachment-hold-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/support-attachments/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/disposition-requests", "admin"],
      ["/v1/admin/support-attachment-disposition-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/organization-documents/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/legal-hold-requests", "admin"],
      ["/v1/admin/organization-document-hold-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/organization-documents/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/disposition-requests", "admin"],
      ["/v1/admin/organization-document-disposition-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/transitions", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/policy-binding", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision-requests", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/external-snapshots", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/sumsub-provider-exports", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/package-preparations", "admin"],
      ["/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/distribution-treatment-requests", "admin"],
      ["/v1/admin/distribution-privacy-treatment-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/privacy-decision-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/platform-configuration/public.catalogue.default_page_size/versions", "admin"],
      ["/v1/admin/platform-configuration/versions/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/admin/platform-configuration/public.catalogue.default_page_size/rollbacks", "admin"],
      ["/v1/admin/platform-content/terms_global_public/versions", "admin"],
      ["/v1/admin/platform-content/versions/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/governance/organizations/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/memberships/81d8c7c2-a1be-4c18-b774-1c63ab52da26/status", "issuer"],
      ["/v1/governance/organizations/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/ownership-transfers/81d8c7c2-a1be-4c18-b774-1c63ab52da26/decision", "issuer"],
      ["/v1/governance/asset-application-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "issuer"],
      ["/v1/governance/investment-allocations/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "admin"],
      ["/v1/governance/offering-notice-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "issuer"],
      ["/v1/investor/distribution-payout-profile", "investor"],
      ["/v1/governance/distribution-declarations/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/funding-requests", "issuer"],
      ["/v1/governance/distribution-funding-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision", "issuer"],
      ["/v1/offerings/lagos-logistics/checkout", "investor"],
      ["/v1/investor/wallet-link-challenges/confirm", "investor"],
      ["/v1/professional/firms/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/payout-profile", "professional"],
      ["/v1/governance/professional-invoices/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/payout-instruction", "operator"],
      ["/v1/control/professional-finance-exceptions/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/execute-credit-note", "admin"],
    ] as const;

    for (const [path, role] of examples) {
      expect(resolvePrivilegedActionPolicy("POST", path)?.allowedRoles).toContain(role);
    }
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/support-attachments/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/download")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/support-attachments/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/lifecycle")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/organization-documents/lifecycle")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/organization-documents/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/lifecycle")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/distribution-lifecycle/distribution_declaration/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("POST", "/v1/admin/distribution-lifecycle/distribution_tax_remittance/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/legal-hold-requests")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("POST", "/v1/admin/distribution-lifecycle-hold-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/decision")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/control/distribution-payout-reconciliation")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/privacy-requests")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/privacy-data-inventory")?.allowedRoles).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/admin/privacy-requests/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee")?.allowedRoles).toContain("admin");
    expect(
      resolvePrivilegedActionPolicy(
        "GET",
        "/v1/admin/audit-exports/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/download",
      )?.allowedRoles,
    ).toContain("admin");
    expect(resolvePrivilegedActionPolicy("GET", "/v1/offerings/lagos-logistics/checkout")).toBeUndefined();
    expect(resolvePrivilegedActionPolicy("POST", "/v1/professional/work-orders/77b0cc37-6721-4607-bb9e-cb11a3b0d8ee/response")).toBeUndefined();
  });

  it("appends the guard after authentication and denies a role outside the policy", async () => {
    const enforced = vi.fn().mockResolvedValue(undefined);
    const app = Fastify();
    app.decorateRequest("authUser", "" as unknown as AuthUser);
    app.decorate("authenticate", async (request: FastifyRequest) => {
      request.authUser = { userId: "subject-1", role: "investor", sessionId: "session-1" };
    });
    registerPrivilegedActionStepUpPolicy(app, { enforce: enforced });
    app.post(
      "/v1/offerings/:reference/checkout",
      { preHandler: [app.authenticate] },
      async () => ({ protected: true }),
    );
    await app.ready();

    const allowed = await app.inject({ method: "POST", url: "/v1/offerings/example/checkout" });
    expect(allowed.statusCode).toBe(200);
    expect(enforced).toHaveBeenCalledWith(
      expect.objectContaining({ authUser: expect.objectContaining({ userId: "subject-1", role: "investor" }) }),
      expect.objectContaining({ capability: "investment checkout" }),
    );
    const checkoutPolicy = resolvePrivilegedActionPolicy("POST", "/v1/offerings/example/checkout");
    expect(checkoutPolicy).toBeDefined();
    expect(() => assertPrivilegedActionRole(makeUser("issuer"), checkoutPolicy!)).toThrow(HttpError);
    await app.close();
  });
});

describe("string boolean parsing", () => {
  it("does not treat the string false as enabled", () => {
    expect(booleanFromString(true).parse("false")).toBe(false);
    expect(booleanFromString(false).parse("0")).toBe(false);
    expect(booleanFromString(false).parse("true")).toBe(true);
    expect(booleanFromString(false).parse(undefined)).toBe(false);
    expect(() => booleanFromString(false).parse("disabled-maybe")).toThrow();
  });
});
