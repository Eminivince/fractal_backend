import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));

import { acknowledgeInvestorOfferingNotice, listInvestorOfferingNotices, markInvestorOfferingNoticeRead, OfferingNoticeError } from "../postgres-offering-notices.js";

const now = new Date("2026-07-29T10:00:00.000Z");
function transactionWithResponses(...responses: Array<{ rows?: unknown[] }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); });

describe("offering notices", () => {
  it("maps only notices delivered to the investor and preserves acknowledgment state", async () => {
    mocks.postgres.query.mockResolvedValueOnce({ rows: [{ notice_id: "notice-1", organization_name: "Issuer One", public_reference: "HARBOUR-1", offering_name: "Harbour Income", category: "material_update", subject: "Material update", body: "The offering has a material update.", policy_reference: "POL-1", policy_legal_basis_reference: "legal-basis", retain_until: new Date("2030-01-01T00:00:00.000Z"), acknowledgment_required: true, acknowledgment_due_at: new Date("2026-08-01T00:00:00.000Z"), published_at: now, first_read_at: null, acknowledged_at: null, terms: { name: "Harbour Income" } }] });
    await expect(listInvestorOfferingNotices("investor-1")).resolves.toEqual([expect.objectContaining({ id: "notice-1", offeringName: "Harbour Income", acknowledgmentRequired: true, firstReadAt: null, acknowledgedAt: null })]);
    expect(mocks.postgres.query).toHaveBeenCalledWith(expect.stringContaining("recipient.investor_identity_id=$1"), ["investor-1"]);
  });

  it("records an open event once and replays a prior open", async () => {
    transactionWithResponses({ rows: [{ id: "recipient-1", first_read_at: null, acknowledged_at: null, acknowledgment_required: true }] }, {}, {});
    await expect(markInvestorOfferingNoticeRead("investor-1", "notice-1")).resolves.toMatchObject({ noticeId: "notice-1", replayed: false, occurredAt: expect.any(String) });
    transactionWithResponses({ rows: [{ id: "recipient-1", first_read_at: now, acknowledged_at: null, acknowledgment_required: true }] });
    await expect(markInvestorOfferingNoticeRead("investor-1", "notice-1")).resolves.toEqual({ noticeId: "notice-1", replayed: true, occurredAt: now.toISOString() });
  });

  it("requires an acknowledgment obligation and an earlier open event", async () => {
    transactionWithResponses({ rows: [{ id: "recipient-1", first_read_at: null, acknowledged_at: null, acknowledgment_required: false }] });
    await expect(acknowledgeInvestorOfferingNotice("investor-1", "notice-1")).rejects.toBeInstanceOf(OfferingNoticeError);
    transactionWithResponses({ rows: [{ id: "recipient-1", first_read_at: null, acknowledged_at: null, acknowledgment_required: true }] });
    await expect(acknowledgeInvestorOfferingNotice("investor-1", "notice-1")).rejects.toThrow("Open the notice");
  });

  it("records acknowledgment after the investor opened the notice", async () => {
    transactionWithResponses({ rows: [{ id: "recipient-1", first_read_at: now, acknowledged_at: null, acknowledgment_required: true }] }, {}, {});
    await expect(acknowledgeInvestorOfferingNotice("investor-1", "notice-1")).resolves.toMatchObject({ replayed: false, noticeId: "notice-1" });
  });
});
