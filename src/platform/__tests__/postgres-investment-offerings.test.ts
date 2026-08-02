import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query }) }));
import { getOpenInvestmentOffering, getPublicInvestmentOffering, listOpenInvestmentOfferings, listOrganizationIssuableOfferings, listPublicInvestmentOfferings } from "../postgres-investment-offerings.js";

const opensAt = new Date("2026-01-01T00:00:00.000Z"); const closesAt = new Date("2026-12-01T00:00:00.000Z");
const publicRow = { public_reference: "OFF-001", currency: "NGN", capacity_minor: "50000000", opens_at: opensAt, closes_at: closesAt, published_at: opensAt, legal_name: "Fractal Issuer Limited", asset_name: "Lagos Warehouse", asset_type: "Commercial", country_code: "NG", state: "Lagos", city: "Lagos", version: 3, terms: { publicSlug: "lagos-warehouse", name: "Lagos Warehouse Income", minimumTicketMinor: 100000, assetClass: "real_estate", summary: "Income property", thesis: "Stable leases", targetReturnBps: 1200, termMonths: 36, riskSummary: "Market risk", incomeSource: "Rent", structure: "SPV", security: "Asset charge", feeSummary: "2%", nextMilestone: "Close" } } as any;
const privateRow = { public_reference: "OFF-001", currency: "NGN", capacity_minor: "50000000", opens_at: opensAt, closes_at: closesAt, terms: { name: "Internal name" }, eligibility_policy: { minimumKyc: "approved" }, agreement_document_hash: "A".repeat(64), disclosure_bundle_hash: "B".repeat(64), version: 4 } as any;
beforeEach(() => { query.mockReset(); });

describe("PostgreSQL investment offering projections", () => {
  it("lists public offerings with a bounded limit and a complete safe projection", async () => {
    query.mockResolvedValueOnce({ rows: [publicRow] });
    await expect(listPublicInvestmentOfferings(1000)).resolves.toEqual([expect.objectContaining({ slug: "lagos-warehouse", issuerName: "Fractal Issuer Limited", opensAt: opensAt.toISOString(), publicationVersion: 3 })]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("organization.verification_status = 'verified'"), [100]);
  });

  it("reads a public offering by trimmed slug and fails closed when missing", async () => {
    query.mockResolvedValueOnce({ rows: [publicRow] }); await expect(getPublicInvestmentOffering(" lagos-warehouse ")).resolves.toMatchObject({ reference: "OFF-001", name: "Lagos Warehouse Income" }); expect(query).toHaveBeenCalledWith(expect.stringContaining("lower($1)"), ["lagos-warehouse"]);
    query.mockResolvedValueOnce({ rows: [] }); await expect(getPublicInvestmentOffering("missing")).resolves.toBeNull();
  });

  it("lists and reads open authenticated offerings with canonical document hashes", async () => {
    query.mockResolvedValueOnce({ rows: [privateRow] }); await expect(listOpenInvestmentOfferings(0)).resolves.toEqual([expect.objectContaining({ reference: "OFF-001", capacityMinor: "50000000", agreementDocumentHash: "a".repeat(64), disclosureBundleHash: "b".repeat(64) })]); expect(query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $1"), [1]);
    query.mockResolvedValueOnce({ rows: [privateRow] }); await expect(getOpenInvestmentOffering(" OFF-001 ")).resolves.toMatchObject({ version: 4 }); expect(query).toHaveBeenCalledWith(expect.stringContaining("offering.public_reference = $1"), ["OFF-001"]);
    query.mockResolvedValueOnce({ rows: [] }); await expect(getOpenInvestmentOffering("missing")).resolves.toBeNull();
  });

  it("returns organization issuable offerings with a safe display-name fallback", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...privateRow, id: "offering-id", version_id: "version-id", terms: { name: "  " } }] });
    await expect(listOrganizationIssuableOfferings("organization-1")).resolves.toEqual([{ id: "offering-id", publicReference: "OFF-001", displayName: "OFF-001", currency: "NGN", capacityMinor: "50000000", opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(), currentVersionId: "version-id", currentVersion: 4 }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("offering.organization_id = $1"), ["organization-1"]);
  });
});
