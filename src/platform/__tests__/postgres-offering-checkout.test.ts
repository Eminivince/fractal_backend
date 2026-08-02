import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn(), appendAudit: vi.fn(), appendOutbox: vi.fn(), createPayment: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));
vi.mock("../postgres-payments.js", () => ({ createPaymentCommitmentInTransaction: mocks.createPayment }));

import {
  CheckoutPolicyError,
  createCheckout,
  publishOffering,
  publishOfferingInTransaction,
  upsertInvestorComplianceProfile,
  upsertInvestorComplianceProfileInTransaction,
} from "../postgres-offering-checkout.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
const hash = "A".repeat(64);
const now = new Date("2026-07-29T12:00:00.000Z");
const offering = { id: "offering-1", organization_id: "organization-1", currency: "USD", capacity_minor: "10000", opens_at: new Date("2026-07-01"), closes_at: new Date("2026-08-01"), status: "published" };
const version = { id: "version-1", eligibility_policy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["US"], requiresAccreditation: false }, agreement_document_hash: hash };
const profile = { kyc_status: "approved", investor_class: "retail", accreditation_status: "not_required", jurisdiction_code: "US", reviewed_at: new Date("2026-07-01"), expires_at: null, evidence: { provider: "sumsub" } };
function checkoutInput(overrides: Record<string, unknown> = {}) {
  return { publicReference: "OFF-1", investorIdentityId: "identity-1", amountMinor: 1000, signatureName: "Investor One", agreementDocumentHash: hash, provider: "paystack", providerReference: "reference-1", paymentExpiresAt: new Date("2026-07-30"), acceptedAt: now, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
  mocks.createPayment.mockResolvedValue({ commitmentId: "commitment-1", paymentIntentId: "intent-1" });
});

describe("offering publication and investor profiles", () => {
  it("publishes a validated immutable offering version with evidence", async () => {
    const client = clientWith({}, {});
    const result = await publishOfferingInTransaction(client as any, { organizationId: "organization-1", publishedByIdentityId: "identity-1", publicReference: " OFF-1 ", currency: "usd", capacityMinor: 10_000, opensAt: new Date("2026-07-01"), closesAt: new Date("2026-08-01"), terms: { name: "Offering" }, eligibilityPolicy: { allowedInvestorClasses: ["retail", "retail"], allowedJurisdictions: ["us"] }, agreementDocumentHash: hash, disclosureBundleHash: hash });
    expect(result).toMatchObject({ version: 1, offeringId: expect.any(String), offeringVersionId: expect.any(String) });
    expect(client.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["OFF-1", "USD", "10000"]));
    expect(client.query.mock.calls[1]?.[1]?.[3]).toMatchObject({ allowedInvestorClasses: ["retail"], allowedJurisdictions: ["US"] });
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "offering.published" }));
  });

  it("rejects invalid publication policy and persists a compliance profile through the transaction wrapper", async () => {
    await expect(publishOfferingInTransaction({ query: vi.fn() } as any, { organizationId: "organization-1", publishedByIdentityId: "identity-1", publicReference: "OFF-1", currency: "USD", capacityMinor: 100, opensAt: new Date("2026-07-01"), closesAt: new Date("2026-08-01"), terms: {}, eligibilityPolicy: { allowedInvestorClasses: [] }, agreementDocumentHash: hash, disclosureBundleHash: hash })).rejects.toThrow("Eligibility policy");
    const client = clientWith({});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await upsertInvestorComplianceProfile({ identityId: "identity-1", kycStatus: "approved", investorClass: "retail", accreditationStatus: "not_required", jurisdictionCode: "us", reviewedAt: now });
    expect(client.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["US"]));
    await expect(upsertInvestorComplianceProfileInTransaction({ query: vi.fn() } as any, { identityId: "identity-1", kycStatus: "approved", investorClass: "retail", accreditationStatus: "not_required", jurisdictionCode: "invalid-code", reviewedAt: now })).rejects.toThrow("jurisdictionCode");
  });

  it("publishes through the transaction wrapper", async () => {
    const client = clientWith({}, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(publishOffering({ organizationId: "organization-1", publishedByIdentityId: "identity-1", publicReference: "OFF-1", currency: "USD", capacityMinor: 10000, opensAt: new Date("2026-07-01"), closesAt: new Date("2026-08-01"), terms: {}, eligibilityPolicy: { allowedInvestorClasses: ["retail"] }, agreementDocumentHash: hash, disclosureBundleHash: hash })).resolves.toMatchObject({ version: 1 });
  });
});

describe("investment checkout", () => {
  it("creates immutable eligibility, agreement, payment, and reservation records", async () => {
    const client = clientWith(
      { rows: [offering], rowCount: 1 }, { rows: [version], rowCount: 1 }, { rows: [profile], rowCount: 1 }, {},
      { rows: [{ total: "500" }], rowCount: 1 }, {}, {},
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    const result = await createCheckout(checkoutInput());
    expect(result).toMatchObject({ offeringId: "offering-1", offeringVersionId: "version-1", commitmentId: "commitment-1", paymentIntentId: "intent-1", reservationId: expect.any(String) });
    expect(client.query.mock.calls[3]?.[1]?.[3]).toBe("eligible");
    expect(mocks.createPayment).toHaveBeenCalledWith(client, expect.objectContaining({ committedMinor: 1000n, currency: "USD" }));
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "investment.checkout.created" }));
  });

  it("returns a complete idempotent checkout replay without new financial records", async () => {
    const client = clientWith({ rows: [offering], rowCount: 1 }, { rows: [{ id: "reservation-1", offering_version_id: "version-1", eligibility_snapshot_id: "snapshot-1", agreement_acceptance_id: "agreement-1", commitment_id: "commitment-1", payment_intent_id: "intent-1" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(createCheckout(checkoutInput({ commandKey: "checkout-command" }))).resolves.toEqual({ offeringId: "offering-1", offeringVersionId: "version-1", eligibilitySnapshotId: "snapshot-1", agreementAcceptanceId: "agreement-1", reservationId: "reservation-1", commitmentId: "commitment-1", paymentIntentId: "intent-1" });
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it("persists denial evidence then rejects an ineligible investor", async () => {
    const ineligibleProfile = { ...profile, kyc_status: "pending", investor_class: "institutional", jurisdiction_code: "NG", accreditation_status: "pending" };
    const client = clientWith({ rows: [offering], rowCount: 1 }, { rows: [version], rowCount: 1 }, { rows: [ineligibleProfile], rowCount: 1 }, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(createCheckout(checkoutInput())).rejects.toThrow("kyc_not_approved");
    expect(client.query.mock.calls[3]?.[1]?.[3]).toBe("ineligible");
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it("rejects closed offerings, invalid payment windows, mismatched agreements, and exhausted capacity", async () => {
    const unavailable = clientWith({ rows: [{ ...offering, status: "draft" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unavailable));
    await expect(createCheckout(checkoutInput())).rejects.toThrow("not open");

    const paymentExpiry = clientWith({ rows: [offering], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(paymentExpiry));
    await expect(createCheckout(checkoutInput({ paymentExpiresAt: new Date("2026-08-02") }))).rejects.toThrow("Payment expiry");

    const agreement = clientWith({ rows: [offering], rowCount: 1 }, { rows: [version], rowCount: 1 }, { rows: [profile], rowCount: 1 }, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(agreement));
    await expect(createCheckout(checkoutInput({ agreementDocumentHash: "b".repeat(64) }))).rejects.toThrow("does not match");

    const capacity = clientWith({ rows: [offering], rowCount: 1 }, { rows: [version], rowCount: 1 }, { rows: [profile], rowCount: 1 }, {}, { rows: [{ total: "9500" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(capacity));
    await expect(createCheckout(checkoutInput())).rejects.toThrow("capacity");
  });
});
