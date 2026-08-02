import { beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => postgres }));

import { getInvestorAgreementDocument, listInvestorAgreementDocuments } from "../postgres-investor-documents.js";

const row = { agreement_acceptance_id: "acceptance-1", public_reference: "HARBOUR-1", offering_name: "Harbour Income", version: 2, accepted_at: new Date("2026-07-29T10:00:00.000Z"), filename: "agreement.pdf", mime_type: "application/pdf", storage_key: "agreements/acceptance-1.pdf", content_sha256: "a".repeat(64) };
beforeEach(() => postgres.query.mockReset());

describe("investor agreement documents", () => {
  it("lists only the current investor's accepted agreement metadata", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [row] });
    await expect(listInvestorAgreementDocuments("investor-1")).resolves.toEqual([{ id: "acceptance-1", type: "agreement", publicReference: "HARBOUR-1", offeringName: "Harbour Income", offeringVersion: 2, acceptedAt: "2026-07-29T10:00:00.000Z", filename: "agreement.pdf", mimeType: "application/pdf" }]);
    expect(postgres.query).toHaveBeenCalledWith(expect.stringContaining("acceptance.investor_identity_id = $1"), ["investor-1", null]);
  });

  it("returns storage facts only when the ownership-filtered agreement exists", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    await expect(getInvestorAgreementDocument({ identityId: "investor-1", agreementAcceptanceId: "acceptance-1" })).resolves.toMatchObject({ id: "acceptance-1", storageKey: "agreements/acceptance-1.pdf", contentSha256: "a".repeat(64) });
    await expect(getInvestorAgreementDocument({ identityId: "investor-1", agreementAcceptanceId: "other" })).resolves.toBeNull();
    expect(postgres.query).toHaveBeenLastCalledWith(expect.stringContaining("($2::uuid IS NULL OR acceptance.id = $2)"), ["investor-1", "other"]);
  });
});
