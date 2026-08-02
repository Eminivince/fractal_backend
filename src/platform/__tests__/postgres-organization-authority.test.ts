import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn(), idempotency: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotency }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { createIssuerOrganization, OrganizationAuthorityError, recordOrganizationVerificationEvidence, submitOrganizationVerification } from "../postgres-organization-authority.js";

const address = { line1: "1 Market Street", city: "Lagos", countryCode: "ng" };
type QueryClient = { query: ReturnType<typeof vi.fn> };
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
function idempotentCommand(client: QueryClient) { mocks.idempotency.mockImplementationOnce(async (input: { execute: (client: QueryClient) => Promise<{ body: unknown; status: number }> }) => { const result = await input.execute(client); return { body: result.body, replayed: false }; }); }
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.idempotency.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("organization authority", () => {
  it("validates organization registration fields before it opens an idempotent command", async () => {
    await expect(createIssuerOrganization({ identityId: "issuer-1", legalName: " ", registrationNumber: "REG-1", jurisdictionCode: "NG", entityType: "private_company", primaryActivity: "Investment management", registeredAddress: address })).rejects.toBeInstanceOf(OrganizationAuthorityError);
    await expect(createIssuerOrganization({ identityId: "issuer-1", legalName: "Issuer One", registrationNumber: "REG-1", jurisdictionCode: "NGA", entityType: "private_company", primaryActivity: "Investment management", registeredAddress: address })).rejects.toThrow("two-letter country");
    expect(mocks.idempotency).not.toHaveBeenCalled();
  });

  it("creates a normalized organization and owner membership for a verified issuer", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ value: 1 }], rowCount: 1 }).mockResolvedValueOnce({}).mockResolvedValueOnce({}) };
    idempotentCommand(client);
    await expect(createIssuerOrganization({ identityId: "issuer-1", commandKey: "organization-create-1", legalName: " Issuer One ", registrationNumber: " reg-1 ", jurisdictionCode: "ng", entityType: "private_company", primaryActivity: " Investment management ", registeredAddress: address })).resolves.toMatchObject({ body: { organizationId: expect.any(String), membershipId: expect.any(String), verificationStatus: "not_started" }, replayed: false });
    expect(mocks.audit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "organization.created" }));
    expect(mocks.outbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "organization.created" }));
  });

  it("records verification evidence only for an active organization authority member", async () => {
    transactionWithResponses({ rowCount: 0 });
    await expect(recordOrganizationVerificationEvidence({ organizationId: "organization-1", uploadedByIdentityId: "issuer-1", evidenceType: "registration_evidence", filename: "registry.pdf", mimeType: "application/pdf", storageKey: "organizations/1/registry.pdf", contentSha256: "a".repeat(64), bytes: 100 })).rejects.toThrow("Access denied");
    transactionWithResponses({ rowCount: 1 }, {});
    await expect(recordOrganizationVerificationEvidence({ organizationId: "organization-1", uploadedByIdentityId: "issuer-1", evidenceType: "registration_evidence", filename: " registry.pdf ", mimeType: "Application/PDF", storageKey: "organizations/1/registry.pdf", contentSha256: "A".repeat(64), bytes: 100 })).resolves.toMatchObject({ evidenceDocumentId: expect.any(String), contentSha256: "a".repeat(64) });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "organization.verification_evidence.recorded" }));
  });

  it("requires a complete beneficial-owner declaration and three required evidence categories", async () => {
    const base = { organizationId: "organization-1", submittedByIdentityId: "issuer-1", legalName: "Issuer One", registrationNumber: "REG-1", jurisdictionCode: "NG", entityType: "private_company" as const, primaryActivity: "Investment management", registeredAddress: address, representativeAuthorityBasis: "Board resolution authorizes this representative.", evidenceDocumentIds: ["one", "two", "three"] };
    await expect(submitOrganizationVerification({ ...base, beneficialOwners: [] })).rejects.toThrow("Between 1 and 50");
    await expect(submitOrganizationVerification({ ...base, beneficialOwners: [{ ownerType: "natural_person", legalName: "Person One", ownershipBps: 10_000, isControlPerson: true, nationalityOrJurisdictionCode: "NG" }] })).rejects.toThrow("country of residence");
  });
});
