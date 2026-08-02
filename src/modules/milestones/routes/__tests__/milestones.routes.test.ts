import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(), assertScope: vi.fn(), assertTransition: vi.fn(), authorize: vi.fn(), businessFindById: vi.fn(), createAnchor: vi.fn(), escrowBalance: vi.fn(), ledgerCreate: vi.fn(), milestoneCount: vi.fn(), milestoneCreate: vi.fn(), milestoneFind: vi.fn(), milestoneFindById: vi.fn(), offeringFindById: vi.fn(), postLedger: vi.fn(), serialize: vi.fn((value: unknown) => value), trancheCreate: vi.fn(), trancheFind: vi.fn(), trancheFindById: vi.fn(), trancheFindOne: vi.fn(), trancheClaim: vi.fn(), transaction: vi.fn(), env: { PAYSTACK_ENABLED: false },
}));

vi.mock("../../../../db/models.js", () => ({
  BusinessModel: { findById: mocks.businessFindById }, LedgerEntryModel: { create: mocks.ledgerCreate }, MilestoneModel: { countDocuments: mocks.milestoneCount, create: mocks.milestoneCreate, find: mocks.milestoneFind, findById: mocks.milestoneFindById }, OfferingModel: { findById: mocks.offeringFindById }, OutboundTransferModel: {}, TrancheModel: { create: mocks.trancheCreate, find: mocks.trancheFind, findById: mocks.trancheFindById, findOne: mocks.trancheFindOne, findOneAndUpdate: mocks.trancheClaim },
}));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: (value: unknown) => value }));
vi.mock("../../../../services/ledger.js", () => ({ escrowAccountRef: vi.fn(() => "escrow:offering"), getEscrowBalance: mocks.escrowBalance, postLedger: mocks.postLedger }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/state-machine.js", () => ({ assertTransition: mocks.assertTransition }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.assertScope }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/anchor.js", () => ({ createAnchorRecord: mocks.createAnchor }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: vi.fn(() => "command-1"), runIdempotentCommand: vi.fn(async ({ execute }) => execute()) }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/paystack.js", () => ({ createPaystackTransferRecipient: vi.fn(), getAvailableBalanceKobo: vi.fn(), initiatePaystackTransfer: vi.fn(), nairaToKobo: vi.fn() }));

import { milestoneRoutes } from "../milestones.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "issuer";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const sessioned = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
const saved = (value: Record<string, unknown>): any => ({ ...value, save: vi.fn().mockResolvedValue(undefined), toObject: () => value });

beforeEach(async () => {
  for (const mock of Object.values(mocks)) if (typeof (mock as any).mockReset === "function") (mock as any).mockReset();
  role = "issuer";
  mocks.authorize.mockReturnValue(undefined); mocks.assertScope.mockReturnValue(undefined); mocks.assertTransition.mockReturnValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); mocks.appendEvent.mockResolvedValue(undefined); mocks.transaction.mockImplementation(async (callback: (session: string) => unknown) => callback("session-1")); mocks.createAnchor.mockResolvedValue({ id: "anchor-1" });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role, businessId: "business-1" }; });
  await app.register(milestoneRoutes); await app.ready();
});
afterEach(async () => { await app.close(); });

describe("milestone routes", () => {
  it("initializes Template B milestones and locked tranches", async () => {
    mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", businessId: "business-1", templateCode: "B", terms: { raiseAmount: 10000 } }));
    mocks.milestoneCount.mockReturnValueOnce(sessioned(0));
    mocks.milestoneCreate.mockResolvedValueOnce([saved({ _id: "milestone-1", name: "Land acquisition" })]).mockResolvedValueOnce([saved({ _id: "milestone-2", name: "Construction" })]);
    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/milestones", payload: { milestones: [{ name: "Land acquisition", percent: 40 }, { name: "Construction", percent: 60 }] } });
    expect(response.statusCode).toBe(200);
    expect(mocks.trancheCreate).toHaveBeenCalledTimes(2);
    expect(mocks.trancheCreate).toHaveBeenCalledWith([expect.objectContaining({ amount: 4000, status: "locked" })], { session: "session-1" });
  });

  it("lets an issuer submit milestone evidence for verification", async () => {
    const milestone = saved({ _id: "milestone-1", offeringId: "offering-1", status: "not_started" });
    mocks.milestoneFindById.mockReturnValueOnce(sessioned(milestone));
    mocks.offeringFindById.mockReturnValueOnce(sessioned({ businessId: "business-1" }));
    const response = await app.inject({ method: "POST", url: "/v1/milestones/milestone-1/request-verification", payload: { evidenceDocs: [{ docId: "document-1", filename: "completion.pdf" }] } });
    expect(response.statusCode).toBe(200);
    expect(milestone).toMatchObject({ status: "evidence_submitted", evidenceDocs: [{ docId: "document-1" }] });
  });

  it("lets an operator start, verify, and reject milestone reviews", async () => {
    role = "operator";
    const reviewing = saved({ _id: "milestone-1", status: "evidence_submitted" });
    mocks.milestoneFindById.mockReturnValueOnce(sessioned(reviewing));
    await expect(app.inject({ method: "POST", url: "/v1/milestones/milestone-1/start-review" })).resolves.toMatchObject({ statusCode: 200 });
    expect(reviewing).toMatchObject({ status: "in_review" });

    const verified = saved({ _id: "milestone-1", offeringId: "offering-1", status: "in_review", evidenceDocs: [{ docId: "document-1", filename: "completion.pdf" }] });
    const tranche = saved({ _id: "tranche-1", status: "locked" });
    mocks.milestoneFindById.mockReturnValueOnce(sessioned(verified)); mocks.trancheFindOne.mockReturnValueOnce(sessioned(tranche));
    await expect(app.inject({ method: "POST", url: "/v1/milestones/milestone-1/verify" })).resolves.toMatchObject({ statusCode: 200 });
    expect(verified).toMatchObject({ status: "verified" }); expect(tranche).toMatchObject({ status: "eligible" });

    const rejected = saved({ _id: "milestone-2", status: "in_review" });
    mocks.milestoneFindById.mockReturnValueOnce(sessioned(rejected));
    await expect(app.inject({ method: "POST", url: "/v1/milestones/milestone-2/reject", payload: { reason: "Evidence does not meet the completion standard." } })).resolves.toMatchObject({ statusCode: 200 });
    expect(rejected).toMatchObject({ status: "rejected" });
  });

  it("lists milestones and tranches for an issuer offering", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    mocks.milestoneFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "milestone-1" }])) });
    await expect(app.inject({ method: "GET", url: "/v1/offerings/offering-1/milestones" })).resolves.toMatchObject({ statusCode: 200 });
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    mocks.trancheFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "tranche-1" }])) });
    await expect(app.inject({ method: "GET", url: "/v1/offerings/offering-1/tranches" })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("marks a tranche failed or reverses it with a trustee ticket", async () => {
    role = "operator";
    const failed = saved({ _id: "tranche-1", status: "processing" });
    mocks.trancheFindById.mockReturnValueOnce(sessioned(failed));
    await expect(app.inject({ method: "POST", url: "/v1/tranches/tranche-1/mark-failed", payload: { reason: "Bank transfer failed." } })).resolves.toMatchObject({ statusCode: 200 });
    expect(failed).toMatchObject({ status: "failed" });

    const reversed = saved({ _id: "tranche-2", offeringId: "offering-1", amount: 5000, status: "released" });
    mocks.trancheFindById.mockReturnValueOnce(sessioned(reversed));
    const response = await app.inject({ method: "POST", url: "/v1/tranches/tranche-2/reverse", payload: { reason: "Trustee reversal is approved.", trusteeTicket: "trustee-ticket-1", confirm: "REVERSE" } });
    expect(response.statusCode).toBe(200);
    expect(reversed).toMatchObject({ status: "reversed", reversalReason: "Trustee reversal is approved." });
    expect(mocks.ledgerCreate).toHaveBeenCalledWith([expect.objectContaining({ direction: "credit", externalRef: "trustee-ticket-1" })], { session: "session-1" });
  });

  it("releases an eligible tranche in manual mode after an escrow check", async () => {
    role = "operator";
    const tranche = saved({ _id: "tranche-1", offeringId: "offering-1", amount: 5000, status: "processing" });
    mocks.trancheClaim.mockResolvedValueOnce(tranche);
    mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", businessId: "business-1" }));
    mocks.businessFindById.mockReturnValueOnce(sessioned({ payoutBankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Fractal Assets" } }));
    mocks.escrowBalance.mockResolvedValueOnce({ balance: 6000 });

    const response = await app.inject({ method: "POST", url: "/v1/tranches/tranche-1/release", payload: { payoutReceiptRefs: ["bank-receipt-1"] } });

    expect(response.statusCode).toBe(200);
    expect(tranche).toMatchObject({ status: "released", payoutReceiptRefs: ["bank-receipt-1"], releasedBy: "issuer-1" });
    expect(mocks.postLedger).toHaveBeenCalledTimes(2);
    expect(mocks.createAnchor).toHaveBeenCalledWith(expect.objectContaining({ eventType: "TrancheReleased" }), "session-1");
  });
});
