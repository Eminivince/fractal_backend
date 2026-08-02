import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ applicationFindById: vi.fn(), businessFindById: vi.fn(), corporateCreate: vi.fn(), corporateFindOne: vi.fn(), dossierFindOne: vi.fn(), distributionCount: vi.fn(), distributionFind: vi.fn(), milestoneCreate: vi.fn(), offeringFind: vi.fn(), offeringCount: vi.fn(), offeringFindById: vi.fn(), offeringFindOne: vi.fn(), offeringCreate: vi.fn(), platformFindById: vi.fn(), subscriptionCount: vi.fn(), subscriptionFind: vi.fn(), ledgerCreate: vi.fn(), ledgerFind: vi.fn(), ledgerFindOne: vi.fn(), offeringUpdateCreate: vi.fn(), offeringUpdateFind: vi.fn(), offeringUpdateCount: vi.fn(), qaCreate: vi.fn(), qaFind: vi.fn(), qaFindOne: vi.fn(), qaCount: vi.fn(), userFind: vi.fn(), persistImage: vi.fn(), persistDossier: vi.fn(), retrieveFile: vi.fn(), trancheCreate: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), assertTransition: vi.fn(), assertScope: vi.fn(), transaction: vi.fn(), serialize: vi.fn((value: unknown) => value), idempotent: vi.fn(), readCommandId: vi.fn(), notifications: vi.fn(), dispatchWebhook: vi.fn(), decimal: vi.fn((value: unknown) => value), normalizePolicy: vi.fn(), policyHash: vi.fn(), policyValid: vi.fn(), createAnchor: vi.fn(), hasAnchor: vi.fn(), isOnchainEnabled: vi.fn(), autowireAllocationMint: vi.fn(), env: {} as Record<string, unknown> }));
vi.mock("../../../../db/models.js", () => ({ ApplicationModel: { findById: mocks.applicationFindById }, BusinessModel: { findById: mocks.businessFindById }, CorporateActionModel: { create: mocks.corporateCreate, findOne: mocks.corporateFindOne }, DossierModel: { findOne: mocks.dossierFindOne }, MilestoneModel: { create: mocks.milestoneCreate }, OfferingModel: { find: mocks.offeringFind, countDocuments: mocks.offeringCount, findById: mocks.offeringFindById, findOne: mocks.offeringFindOne, create: mocks.offeringCreate }, PlatformConfigModel: { findById: mocks.platformFindById }, SubscriptionModel: { countDocuments: mocks.subscriptionCount, find: mocks.subscriptionFind }, TrancheModel: { create: mocks.trancheCreate }, DistributionModel: { countDocuments: mocks.distributionCount, find: mocks.distributionFind }, InvestorProfileModel: {}, LedgerEntryModel: { create: mocks.ledgerCreate, find: mocks.ledgerFind, findOne: mocks.ledgerFindOne }, OfferingQAModel: { create: mocks.qaCreate, find: mocks.qaFind, findOne: mocks.qaFindOne, countDocuments: mocks.qaCount }, OfferingUpdateModel: { create: mocks.offeringUpdateCreate, find: mocks.offeringUpdateFind, countDocuments: mocks.offeringUpdateCount }, UserModel: { find: mocks.userFind }, OutboundTransferModel: {} }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../services/ledger.js", () => ({ escrowAccountRef: vi.fn() }));
vi.mock("../../../../services/issuer-webhooks.js", () => ({ dispatchIssuerWebhook: mocks.dispatchWebhook }));
vi.mock("../../../../services/onchain-autowire.js", () => ({ isOnchainEnabled: mocks.isOnchainEnabled, autowireAllocationMint: mocks.autowireAllocationMint }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/state-machine.js", () => ({ assertTransition: mocks.assertTransition }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.assertScope }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/economic-policy.js", () => ({ normalizeEconomicPolicy: mocks.normalizePolicy, economicPolicyHash: mocks.policyHash, isEconomicPolicyValid: mocks.policyValid }));
vi.mock("../../../../utils/anchor.js", () => ({ createAnchorRecord: mocks.createAnchor, hasAnchor: mocks.hasAnchor }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.readCommandId, runIdempotentCommand: mocks.idempotent }));
vi.mock("../../../../services/storage.js", () => ({ persistOfferingImage: mocks.persistImage, persistDossierBinary: mocks.persistDossier, retrieveFile: mocks.retrieveFile }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notifications }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/paystack.js", () => ({ createPaystackTransferRecipient: vi.fn(), getAvailableBalanceKobo: vi.fn(), initiatePaystackTransfer: vi.fn(), nairaToKobo: vi.fn() }));
import { offeringRoutes } from "../offerings.routes.js";

let app: ReturnType<typeof Fastify>; let role = "issuer"; let businessId = "business-1";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const sessioned = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
const selectedSession = (value: unknown) => ({ select: vi.fn(() => sessioned(value)) });
const saved = (value: Record<string, unknown>): any => ({ ...value, toObject: () => value, save: vi.fn().mockResolvedValue(undefined) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) {
    if (typeof (mock as any).mockReset === "function") (mock as any).mockReset();
  }
  mocks.authorize.mockReturnValue(undefined); mocks.appendEvent.mockResolvedValue(undefined); mocks.assertScope.mockReturnValue(undefined); mocks.assertTransition.mockReturnValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); mocks.decimal.mockImplementation((value: unknown) => value); mocks.transaction.mockImplementation(async (callback: (session: string) => unknown) => callback("session-1")); mocks.idempotent.mockImplementation(async ({ execute }: { execute: () => unknown }) => execute()); mocks.normalizePolicy.mockReturnValue({ version: 1, policyType: "rental_distribution", config: { templateCode: "A" } }); mocks.policyHash.mockReturnValue("policy-hash"); mocks.policyValid.mockReturnValue(true); mocks.notifications.mockResolvedValue(undefined); mocks.createAnchor.mockResolvedValue({ id: "anchor-1", canonicalHash: "anchor-hash" }); mocks.hasAnchor.mockResolvedValue(true); mocks.isOnchainEnabled.mockReturnValue(false); mocks.env.PAYSTACK_ENABLED = false; mocks.env.PAYSTACK_BALANCE_CHECK_ENABLED = false; role = "issuer"; businessId = "business-1";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role, businessId }; }); await app.register(offeringRoutes);
});
afterEach(async () => { await app.close(); });

describe("core offering routes", () => {
  it("creates a draft offering from an approved issuer application", async () => {
    mocks.applicationFindById.mockReturnValueOnce(sessioned({ _id: "application-1", businessId: "business-1", templateCode: "A", status: "approved" })); mocks.businessFindById.mockReturnValueOnce(selectedSession({ kybStatus: "approved", registrationApprovedAt: new Date() })); mocks.offeringFindOne.mockReturnValueOnce(selectedSession(null)); mocks.platformFindById.mockReturnValueOnce(sessioned({ featureFlags: { enableTemplateB: true }, feeConfig: { setupFee: 1, platformFeePct: 2, servicingFeePct: 3 } })); mocks.dossierFindOne.mockReturnValueOnce(selectedSession(null)); mocks.offeringCreate.mockResolvedValueOnce([saved({ _id: "offering-1", name: "Warehouse Income Note" })]);
    const response = await app.inject({ method: "POST", url: "/v1/offerings", headers: { "idempotency-key": "create-1" }, payload: { applicationId: "application-1", name: "Warehouse Income Note", summary: "A secured warehouse income opportunity.", opensAt: "2026-08-01T00:00:00.000Z", closesAt: "2026-09-01T00:00:00.000Z", terms: { raiseAmount: 1000000 } } });
    expect(response.statusCode).toBe(200); expect(mocks.offeringCreate).toHaveBeenCalledWith([expect.objectContaining({ status: "draft", businessId: "business-1", templateCode: "A", metrics: expect.objectContaining({ raiseAmount: 1000000 }) })], { session: "session-1" }); expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingCreated" }), "session-1");
  });

  it("blocks creation by non-issuers and invalid application states", async () => {
    role = "investor"; await expect(app.inject({ method: "POST", url: "/v1/offerings", payload: {} })).resolves.toMatchObject({ statusCode: 403 });
    role = "issuer"; mocks.applicationFindById.mockReturnValueOnce(sessioned({ _id: "application-1", businessId: "business-1", status: "submitted" })); await expect(app.inject({ method: "POST", url: "/v1/offerings", payload: { applicationId: "application-1", name: "Warehouse Income Note", summary: "A secured warehouse income opportunity.", opensAt: "2026-08-01T00:00:00.000Z", closesAt: "2026-09-01T00:00:00.000Z", terms: { raiseAmount: 1000000 } } })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("shows the public catalog with only public lifecycle statuses", async () => {
    mocks.platformFindById.mockReturnValueOnce(lean({ complianceRules: { requireKycToView: false } })); mocks.offeringFind.mockReturnValueOnce({ sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => lean([{ _id: "offering-1", status: "open" }])) })) })) }); mocks.offeringCount.mockResolvedValueOnce(1);
    const response = await app.inject({ method: "GET", url: "/v1/offerings?page=2&limit=10" });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ data: [{ status: "open" }], total: 1, page: 2, limit: 10, pages: 1 }); expect(mocks.offeringFind).toHaveBeenCalledWith({ status: { $in: ["open", "paused", "closed", "servicing", "exited"] } });
  });

  it("hides a non-public offering from anonymous visitors and returns public offerings", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", status: "draft" })); mocks.platformFindById.mockReturnValueOnce(lean({ complianceRules: { requireKycToView: false } })); await expect(app.inject({ method: "GET", url: "/v1/offerings/offering-1" })).resolves.toMatchObject({ statusCode: 403 });
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", status: "open" })); mocks.platformFindById.mockReturnValueOnce(lean({ complianceRules: { requireKycToView: false } })); await expect(app.inject({ method: "GET", url: "/v1/offerings/offering-1" })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("submits a draft offering for review and alerts operators", async () => {
    const offering = saved({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note", status: "draft" }); mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/submit-for-review" });
    expect(response.statusCode).toBe(200); expect(offering).toMatchObject({ status: "pending_review" }); expect(offering.save).toHaveBeenCalledWith({ session: "session-1" }); expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingSubmittedForReview" }), "session-1");
  });

  it("opens an approved offering only after its regulatory gates pass", async () => {
    role = "operator"; const offering = saved({ _id: "offering-1", id: "offering-1", applicationId: "application-1", businessId: "business-1", name: "Warehouse Income Note", templateCode: "A", status: "pending_review", opensAt: new Date(Date.now() + 60_000), economicPolicy: { version: 1, policyType: "rental_distribution", config: { templateCode: "A" } }, disclosurePack: { status: "ready", documentIds: ["doc-1"] }, valuation: { reportDocumentId: "valuation-1" }, feeSnapshot: { setupFee: 1, platformFeePct: 2, servicingFeePct: 3 } }); mocks.offeringFindById.mockReturnValueOnce(sessioned(offering)); mocks.applicationFindById.mockReturnValueOnce(sessioned({ _id: "application-1", status: "approved" }));
    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/approve-open" });
    expect(response.statusCode).toBe(200); expect(offering).toMatchObject({ status: "open" }); expect(offering.save).toHaveBeenCalledWith({ session: "session-1" }); expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingOpened" }), "session-1"); expect(mocks.dispatchWebhook).toHaveBeenCalledWith(expect.objectContaining({ type: "offering.opened", businessId: "business-1" }));
  });

  it("blocks opening by issuers and offerings without a valuation report", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/approve-open" })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator"; mocks.offeringFindById.mockReturnValueOnce(sessioned(saved({ _id: "offering-1", applicationId: "application-1", templateCode: "A", status: "pending_review", economicPolicy: { version: 1, policyType: "rental_distribution", config: {} }, disclosurePack: { status: "ready" }, feeSnapshot: { setupFee: 1, platformFeePct: 2, servicingFeePct: 3 } }))); mocks.applicationFindById.mockReturnValueOnce(sessioned({ status: "approved" })); await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/approve-open" })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("requires an operator to pause an offering and records the corporate action", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/pause", payload: { confirm: "PAUSE", notes: "Compliance review." } })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator"; const offering = saved({ _id: "offering-1", name: "Warehouse Income Note", status: "open" }); mocks.offeringFindById.mockReturnValueOnce(sessioned(offering)); mocks.corporateCreate.mockResolvedValueOnce([]);
    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/pause", payload: { confirm: "PAUSE", notes: "Compliance review.", regulatoryReason: "compliance_review" } });
    expect(response.statusCode).toBe(200); expect(offering).toMatchObject({ status: "paused" }); expect(mocks.corporateCreate).toHaveBeenCalledWith([expect.objectContaining({ type: "pause", status: "executed" })], { session: "session-1" });
  });

  it("requires an operator to resume an offering and notifies affected users", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/unpause" })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator";
    const offering = saved({ _id: "offering-1", name: "Warehouse Income Note", status: "paused" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/unpause", payload: { notes: "Review is complete." } });

    expect(response.statusCode).toBe(200);
    expect(offering).toMatchObject({ status: "open" });
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingResumed", notes: "Review is complete." }), "session-1");
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingResumed" }), "session-1");
  });

  it("creates an issuer close-date extension request for operator review", async () => {
    const closesAt = new Date("2026-08-01T00:00:00.000Z");
    const offering = saved({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note", status: "open", closesAt });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/request-extension", payload: { requestedClosesAt: "2026-08-31T00:00:00.000Z", reason: "The due-diligence period needs more time." } });

    expect(response.statusCode).toBe(200);
    expect(mocks.corporateCreate).toHaveBeenCalledWith([expect.objectContaining({ offeringId: "offering-1", type: "extend_close_date", status: "pending", requestedBy: "issuer-1" })], { session: "session-1" });
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "CloseDateExtensionRequested" }), "session-1");
  });

  it("lets an operator approve a close-date extension", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", name: "Warehouse Income Note", closesAt: new Date("2026-08-01T00:00:00.000Z") });
    const action = saved({ _id: "action-1", status: "pending", payload: { requestedClosesAt: "2026-08-31T00:00:00.000Z" } });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.corporateFindOne.mockReturnValueOnce(sessioned(action));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/approve-extension", payload: { corporateActionId: "action-1", approved: true, notes: "Approved after review." } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ approved: true, newClosesAt: "2026-08-31T00:00:00.000Z" });
    expect(offering.closesAt).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    expect(action).toMatchObject({ status: "executed", approvedBy: "issuer-1" });
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "CloseDateExtensionApproved" }), "session-1");
  });

  it("closes an offering after reconciliation and posts its setup fee", async () => {
    const offeringId = "507f1f77bcf86cd799439011";
    const offering = saved({ _id: offeringId, businessId: "business-1", name: "Warehouse Income Note", status: "open", feeSnapshot: { setupFee: { toString: () => "1500" } } });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.subscriptionCount.mockReturnValueOnce(sessioned(0));

    const response = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/close`, headers: { "idempotency-key": "close-1" }, payload: {} });

    expect(response.statusCode).toBe(200);
    expect(offering).toMatchObject({ status: "closed" });
    expect(mocks.corporateCreate).toHaveBeenCalledWith([expect.objectContaining({ type: "close", status: "executed" })], { session: "session-1" });
    expect(mocks.ledgerCreate).toHaveBeenCalledWith([expect.objectContaining({ ledgerType: "fee", amount: 1500, idempotencyKey: "fee:setup:undefined" })], { session: "session-1" });
  });

  it("finalizes paid allocations and writes ownership ledger entries", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", status: "closed", feeSnapshot: { setupFee: { toString: () => "100" }, platformFeePct: { toString: () => "2" } } });
    const subscription = saved({ _id: "subscription-1", investorUserId: "investor-1", status: "paid", amount: { toString: () => "5000" } });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.subscriptionFind.mockReturnValueOnce(sessioned([subscription]));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/finalize-allocation" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ offeringId: "offering-1", anchorId: "anchor-1", canonicalHash: "anchor-hash", allocatedCount: 1 });
    expect(subscription).toMatchObject({ status: "allocation_confirmed" });
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(2);
    expect(mocks.createAnchor).toHaveBeenCalledWith(expect.objectContaining({ eventType: "AllocationFinalized" }), "session-1");
  });

  it("enters servicing after an allocation anchor and cancels through an operator", async () => {
    role = "operator";
    const servicing = saved({ _id: "offering-1", status: "closed" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(servicing));
    const serviced = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/enter-servicing" });
    expect(serviced.statusCode).toBe(200);
    expect(servicing).toMatchObject({ status: "servicing" });

    const cancellable = saved({ _id: "offering-2", status: "draft" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(cancellable));
    const cancelled = await app.inject({ method: "POST", url: "/v1/offerings/offering-2/cancel", payload: { reason: "Issuer withdrawal" } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancellable).toMatchObject({ status: "cancelled" });
  });

  it("reports exit readiness when obligations are complete", async () => {
    const offering = { _id: "offering-1", businessId: "business-1", status: "servicing", exitWorkflow: { issuerAcknowledgedAt: new Date(), investorsNotifiedAt: new Date() } };
    mocks.offeringFindById.mockReturnValueOnce(lean(offering));
    mocks.distributionCount.mockResolvedValueOnce(0);
    mocks.subscriptionCount.mockResolvedValueOnce(0);

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/exit-readiness" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ offeringId: "offering-1", currentStatus: "servicing", canExit: true });
  });

  it("records issuer acknowledgment and operator investor notification for an exit", async () => {
    const acknowledgment = saved({ _id: "offering-1", businessId: "business-1", status: "servicing" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(acknowledgment));
    const acknowledged = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/exit/acknowledge", payload: { notes: "All obligations are complete." } });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledgment.exitWorkflow).toMatchObject({ issuerAcknowledgedBy: "issuer-1" });

    role = "operator";
    const notification = saved({ _id: "offering-1", status: "servicing" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(notification));
    const notified = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/exit/notify-investors", payload: { message: "The offering is ready for exit." } });
    expect(notified.statusCode).toBe(200);
    expect(notification.exitWorkflow).toMatchObject({ investorsNotifiedBy: "issuer-1" });
  });

  it("exits an acknowledged offering through an operator", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", status: "servicing", exitWorkflow: { issuerAcknowledgedAt: new Date() } });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/exit" });

    expect(response.statusCode).toBe(200);
    expect(offering).toMatchObject({ status: "exited" });
    expect(offering.exitWorkflow).toHaveProperty("finalReportGeneratedAt");
  });

  it("moves an offering through revision, resubmission, and issuer edits", async () => {
    role = "operator";
    const revision = saved({ _id: "offering-1", status: "pending_review" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(revision));
    const requested = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/request-revision", payload: { reason: "Add an updated valuation." } });
    expect(requested.statusCode).toBe(200);
    expect(revision).toMatchObject({ status: "needs_revision" });

    role = "issuer";
    const resubmission = saved({ _id: "offering-1", businessId: "business-1", status: "needs_revision" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(resubmission));
    const resubmitted = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/resubmit-after-revision" });
    expect(resubmitted.statusCode).toBe(200);
    expect(resubmission).toMatchObject({ status: "pending_review" });

    const editable = saved({ _id: "offering-1", businessId: "business-1", status: "draft", metrics: {} });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(editable));
    const updated = await app.inject({ method: "PATCH", url: "/v1/offerings/offering-1", payload: { name: "Updated Warehouse Note", softCap: 1000, isPrivate: true, valuation: { amount: 50000, date: "2026-01-01", reportDocumentId: "valuation-1" } } });
    expect(updated.statusCode).toBe(200);
    expect(editable).toMatchObject({ name: "Updated Warehouse Note", isPrivate: true });
    expect(editable.valuation).toMatchObject({ amount: 50000, reportDocumentId: "valuation-1" });
  });

  it("disburses an issuer payment in manual mode with frozen fees", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note", status: "closed", feeSnapshot: { setupFee: 100, platformFeePct: 2 } });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.businessFindById.mockReturnValueOnce(sessioned({ _id: "business-1", payoutBankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Fractal Assets" } }));
    mocks.ledgerFindOne.mockReturnValueOnce({ session: vi.fn(() => lean(null)) });

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/disburse-to-issuer", payload: { amount: 5000, externalRef: "bank-transfer-1", notes: "First approved release" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "manual", grossAmount: 5000, platformFee: 100, setupFee: 100, netAmount: 4800, externalRef: "bank-transfer-1" });
    expect(offering).toMatchObject({ status: "servicing" });
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(4);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "IssuerDisbursed" }), "session-1");
  });

  it("reports escrow balances and issuer disbursement history", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    mocks.ledgerFind.mockReturnValueOnce(lean([{ amount: { toString: () => "1000" } }])).mockReturnValueOnce(lean([{ amount: { toString: () => "250" } }]));
    mocks.distributionFind.mockReturnValueOnce(lean([{ amount: { toString: () => "100" } } ]));
    const balance = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/escrow-balance" });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ escrowBalance: "750.00", availableForDistribution: "650.00" });

    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    const entries = [{ _id: "ledger-1", amount: 500 }];
    mocks.ledgerFind.mockReturnValueOnce({ sort: vi.fn(() => lean(entries)) });
    const disbursements = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/disbursements" });
    expect(disbursements.statusCode).toBe(200);
    expect(disbursements.json()).toEqual(entries);
  });

  it("uploads and removes issuer offering images", async () => {
    const offering = saved({ _id: "offering-1", businessId: "business-1", images: [] });
    mocks.offeringFindById.mockReturnValueOnce(offering);
    mocks.persistImage.mockResolvedValueOnce({ storageKey: "offerings/offering-1/cover.png", bytes: 42 });
    const uploaded = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/images", payload: { filename: "cover.png", contentBase64: "aGVsbG8=", mimeType: "image/png" } });
    expect(uploaded.statusCode).toBe(200);
    expect(offering.images).toHaveLength(1);
    expect(mocks.persistImage).toHaveBeenCalledWith(expect.objectContaining({ offeringId: "offering-1", filename: "cover.png" }));

    offering.images[0]._id = "image-1";
    mocks.offeringFindById.mockReturnValueOnce(offering);
    const deleted = await app.inject({ method: "DELETE", url: "/v1/offerings/offering-1/images/image-1" });
    expect(deleted.statusCode).toBe(200);
    expect(offering.images).toHaveLength(0);
  });

  it("extends a close date through an operator and flags distribution arrears", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", name: "Warehouse Income Note", status: "open", closesAt: new Date("2026-08-01T00:00:00.000Z") });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    const extended = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/extend-close-date", payload: { newClosesAt: "2026-08-15T00:00:00.000Z", reason: "More investor diligence time" } });
    expect(extended.statusCode).toBe(200);
    expect(offering.closesAt).toEqual(new Date("2026-08-15T00:00:00.000Z"));
    expect(mocks.corporateCreate).toHaveBeenCalledWith([expect.objectContaining({ type: "extend_close_date", status: "executed" })], { session: "session-1" });

    const servicing = saved({ _id: "offering-1", name: "Warehouse Income Note", status: "servicing" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(servicing));
    const flagged = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/flag-distribution-arrears", payload: { notes: "Distribution is thirty days overdue." } });
    expect(flagged.statusCode).toBe(200);
    expect(flagged.json()).toEqual({ ok: true, offeringId: "offering-1" });
  });

  it("auto-cancels an offering below its soft cap and refunds eligible subscriptions", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", name: "Warehouse Income Note", status: "closed", metrics: { softCap: { toString: () => "10000" }, subscribedAmount: { toString: () => "7500" } } });
    const paid = saved({ _id: "subscription-1", status: "paid" });
    const pending = saved({ _id: "subscription-2", status: "payment_pending" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.subscriptionFind.mockReturnValueOnce(sessioned([paid, pending]));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/check-soft-cap" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ softCapConfigured: true, softCapReached: false, autoCancelled: true, refundedSubscriptions: 2 });
    expect(offering).toMatchObject({ status: "cancelled" });
    expect(paid).toMatchObject({ status: "refunded" });
    expect(pending).toMatchObject({ status: "refunded" });
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingAutoCancelledSoftCap" }), "session-1");
  });

  it("returns aggregate issuer metrics across offerings, distributions, and pending payments", async () => {
    const closesAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    mocks.offeringFind.mockReturnValueOnce(lean([
      { _id: "offering-1", status: "open", closesAt, metrics: { subscribedAmount: { toString: () => "10000" } } },
      { _id: "offering-2", status: "servicing", metrics: { subscribedAmount: { toString: () => "20000" } } },
    ]));
    mocks.distributionFind.mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([{ status: "paid", amount: { toString: () => "2500" } }]));
    mocks.subscriptionFind.mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([{ amount: { toString: () => "300" } }]));

    const response = await app.inject({ method: "GET", url: "/v1/issuer/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ businessId: "business-1", totalAum: "30000.00", totalRaised: "20000.00", totalDistributed: "2500.00", pendingPaymentCount: 1, pendingPaymentAmount: "300.00", activeOfferingsCount: 1, offeringCount: 2 });
  });

  it("returns offering and distribution fee entries with a combined fee total", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", feeSnapshot: { setupFee: { toString: () => "100" }, platformFeePct: { toString: () => "2" }, servicingFeePct: { toString: () => "1" } } }));
    mocks.ledgerFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "fee-1", amount: { toString: () => "100" }, postedAt: "2026-01-01" }])) }).mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "fee-2", amount: { toString: () => "20" }, postedAt: "2026-02-01" }])) });
    mocks.distributionFind.mockReturnValueOnce(lean([{ _id: "distribution-1" }]));

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/fee-ledger" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ offeringId: "offering-1", totalFeesCharged: "120.00", entries: [{ _id: "fee-2" }, { _id: "fee-1" }] });
  });

  it("lets an issuer cancel a draft and manage a private investor whitelist", async () => {
    const draft = saved({ _id: "offering-1", businessId: "business-1", status: "draft" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(draft));
    const cancelled = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/request-cancellation", payload: { reason: "The asset is no longer available for sale." } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ cancelled: true, requiresOperatorApproval: false });
    expect(draft).toMatchObject({ status: "cancelled", cancellationReason: "The asset is no longer available for sale." });

    const privateOffering = saved({ _id: "offering-1", businessId: "business-1", isPrivate: true, investorWhitelistUserIds: [] });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(privateOffering));
    const whitelisted = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/whitelist", payload: { action: "add", userId: "investor-1" } });
    expect(whitelisted.statusCode).toBe(200);
    expect(whitelisted.json()).toEqual({ whitelistCount: 1, action: "add", userId: "investor-1" });
    expect(privateOffering.investorWhitelistUserIds).toEqual(["investor-1"]);
  });

  it("records an issuer receipt confirmation and escalates a discrepancy", async () => {
    const offering = saved({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note", status: "servicing" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/confirm-receipt", payload: { amountReceived: 4800, receivedAt: "2026-08-02T00:00:00.000Z", hasDiscrepancy: true, discrepancyDetails: "The bank credited less than the approved amount." } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ confirmed: true, hasDiscrepancy: true, amountReceived: 4800 });
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "ReceiptConfirmedWithDiscrepancy" }), "session-1");
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "ReceiptDiscrepancyReported" }), "session-1");
  });

  it("calculates investor concentration for active subscriptions", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", terms: { raiseAmount: 10000 } }));
    mocks.subscriptionFind.mockReturnValueOnce({ select: vi.fn(() => lean([
      { investorUserId: "investor-1", amount: { toString: () => "7000" } },
      { investorUserId: "investor-2", amount: { toString: () => "3000" } },
    ])) });

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/concentration-report" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ concentrationRisk: "high", top1Pct: 70, investorCount: 2, totalCommitted: 10000, raiseAmount: 10000 });
  });

  it("computes pro-rata redemption amounts for an operator", async () => {
    role = "operator";
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", name: "Warehouse Income Note", status: "servicing" }));
    mocks.subscriptionFind.mockReturnValueOnce({ select: vi.fn(() => lean([
      { _id: "subscription-1", investorUserId: "investor-1", amount: { toString: () => "4000" } },
      { _id: "subscription-2", investorUserId: "investor-2", amount: { toString: () => "6000" } },
    ])) });

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/compute-redemption?totalPayoutAmount=12000" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ totalAllocated: 10000, totalPayoutAmount: 12000, totalCapitalGain: 2000, investorCount: 2, investorRedemptions: [expect.objectContaining({ redemptionAmount: 4800, capitalGain: 800 }), expect.objectContaining({ redemptionAmount: 7200, capitalGain: 1200 })] });
  });

  it("executes full redemption and posts ownership debits", async () => {
    role = "operator";
    const offering = saved({ _id: "offering-1", name: "Warehouse Income Note", status: "servicing" });
    const subscription = saved({ _id: "subscription-1", investorUserId: "investor-1", amount: { toString: () => "5000" }, status: "allocation_confirmed" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.subscriptionFind.mockReturnValueOnce(sessioned([subscription]));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/execute-redemption", payload: { totalPayoutAmount: 6000, externalRef: "sale-settlement-1", notes: "Asset sale completed" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ offeringId: "offering-1", totalPayoutAmount: 6000, investorCount: 1, externalRef: "sale-settlement-1" });
    expect(subscription).toMatchObject({ status: "redeemed" });
    expect(mocks.ledgerCreate).toHaveBeenCalledWith([expect.objectContaining({ ledgerType: "ownership", direction: "debit", externalRef: "sale-settlement-1" })], { session: "session-1" });
  });

  it("accepts Template A actual-versus-projected reporting and issuer broadcasts", async () => {
    const reporting = saved({ _id: "offering-1", businessId: "business-1", templateCode: "A" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(reporting));
    const report = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/actual-vs-projected", payload: { period: "2026-07", actualRentalIncome: 950, projectedRentalIncome: 1000, actualExpenses: 300, projectedExpenses: 250, vacancyDays: 2 } });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ period: "2026-07", variance: -50, variancePct: -5 });

    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note", status: "open" }));
    const broadcast = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/broadcast", payload: { subject: "July operating update", message: "Operations remain on schedule and the next report is available." } });
    expect(broadcast.statusCode).toBe(200);
    expect(broadcast.json()).toEqual({ ok: true, recipientsQueued: true });
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "IssuerBroadcast" }));
  });

  it("posts an issuer offering update and returns the public update feed", async () => {
    const offering = saved({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note" });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.offeringUpdateCreate.mockResolvedValueOnce([saved({ _id: "update-1", title: "July update", body: "Operations remain on schedule." })]);
    const created = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/updates", payload: { title: "July update", body: "Operations remain on schedule.", category: "operational", isPinned: true } });
    expect(created.statusCode).toBe(200);
    expect(mocks.offeringUpdateCreate).toHaveBeenCalledWith([expect.objectContaining({ offeringId: "offering-1", businessId: "business-1", isPinned: true })], { session: "session-1" });
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingUpdatePosted" }), "session-1");

    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", status: "open" }));
    const updates = [{ _id: "update-1", title: "July update" }];
    mocks.offeringUpdateFind.mockReturnValueOnce({ sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => lean(updates)) })) })) });
    mocks.offeringUpdateCount.mockResolvedValueOnce(1);
    const listed = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/updates?page=1&limit=10" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: updates, total: 1, pages: 1 });
  });

  it("records investor questions, permits issuer answers, and lists public Q&A", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", name: "Warehouse Income Note" }));
    mocks.qaCreate.mockResolvedValueOnce([saved({ _id: "question-1", question: "How is the warehouse insured?" })]);
    const asked = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/qa", payload: { question: "How is the warehouse insured and maintained?" } });
    expect(asked.statusCode).toBe(200);
    expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "OfferingQuestionAsked" }));

    const qa = saved({ _id: "question-1", question: "How is the warehouse insured?" });
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    mocks.qaFindOne.mockResolvedValueOnce(qa);
    const answered = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/qa/question-1/answer", payload: { answer: "The asset has comprehensive insurance cover." } });
    expect(answered.statusCode).toBe(200);
    expect(qa).toMatchObject({ answer: "The asset has comprehensive insurance cover.", answeredBy: "issuer-1" });

    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1" }));
    const questions = [{ _id: "question-1", answer: qa.answer }];
    mocks.qaFind.mockReturnValueOnce({ sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => lean(questions)) })) })) });
    mocks.qaCount.mockResolvedValueOnce(1);
    const listed = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/qa?answered=true" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: questions, total: 1, pages: 1 });
  });

  it("returns an issuer investor roster without investor email addresses", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    const subscriptions = [{ _id: "subscription-1", investorUserId: "investor-1", amount: { toString: () => "5000" }, status: "paid", createdAt: "2026-01-01" }];
    mocks.subscriptionFind.mockReturnValueOnce({ sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => lean(subscriptions)) })) })) });
    mocks.subscriptionCount.mockResolvedValueOnce(1);
    mocks.userFind.mockReturnValueOnce({ select: vi.fn(() => lean([{ _id: "investor-1", name: "Ada Investor", email: "ada@example.test" }])) });

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/investors?status=paid" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [expect.objectContaining({ investorName: "Ada Investor", amount: "5000", status: "paid" })], total: 1 });
    expect(response.json().data[0]).not.toHaveProperty("investorEmail");
  });

  it("exports a cap-table CSV for an issuer", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    const subscriptions = [{ _id: "subscription-1", investorUserId: "investor-1", amount: { toString: () => "5000" }, status: "allocation_confirmed", createdAt: "2026-01-01T00:00:00.000Z", allocationConfirmedAt: "2026-01-02T00:00:00.000Z" }];
    mocks.subscriptionFind.mockReturnValueOnce({ sort: vi.fn(() => lean(subscriptions)) });
    mocks.userFind.mockReturnValueOnce({ select: vi.fn(() => lean([{ _id: "investor-1", name: "Ada, Investor", email: "ada@example.test" }])) });

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/cap-table.csv" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).toContain("investorUserId,investorName,investorEmail");
    expect(response.body).toContain('investor-1,"Ada, Investor",ada@example.test');
  });

  it("returns an offering performance report with raise, yield, and fee totals", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({
      _id: "offering-1", businessId: "business-1", name: "Warehouse Income Note", templateCode: "A", status: "servicing", opensAt: "2026-01-01", closesAt: "2026-02-01",
      terms: { raiseAmount: 10000, targetYieldPct: 12 },
      feeSnapshot: { setupFee: { toString: () => "100" }, platformFeePct: { toString: () => "2" }, servicingFeePct: { toString: () => "1" } },
      valuation: { amount: { toString: () => "12000" }, date: "2026-01-01", valuedBy: "Independent Valuer" },
    }));
    mocks.subscriptionFind.mockReturnValueOnce(lean([
      { amount: { toString: () => "6000" }, status: "paid" },
      { amount: { toString: () => "4000" }, status: "allocation_confirmed" },
    ]));
    mocks.distributionFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "distribution-1", amount: { toString: () => "500" }, status: "paid", period: "2026-01", paidAt: "2026-02-01" }])) }).mockReturnValueOnce({ select: vi.fn(() => lean([{ _id: "distribution-1" }])) });
    mocks.ledgerFind.mockReturnValueOnce(lean([{ amount: { toString: () => "100" } }])).mockReturnValueOnce(lean([{ amount: { toString: () => "5" } }]));

    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/performance-report" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ raiseAmount: "10000.00", totalSubscribed: "10000.00", totalRaised: "10000.00", totalDistributed: "500.00", actualYieldPct: 5, projectedAnnualYield: "1200.00", totalFeesPaid: "105.00", currentValuation: { amount: 12000, valuedBy: "Independent Valuer" } });
  });

  it("uploads a disclosure document to a draft offering", async () => {
    const offering = saved({ _id: "offering-1", applicationId: "application-1", businessId: "business-1", status: "draft", disclosurePack: { status: "missing", documentIds: [] } });
    mocks.offeringFindById.mockReturnValueOnce(sessioned(offering));
    mocks.persistDossier.mockResolvedValueOnce({ storageKey: "dossiers/application-1/offering.pdf" });

    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/disclosure-documents", payload: { filename: "offering-memorandum.pdf", contentBase64: "cGRmLWNvbnRlbnQ=", mimeType: "application/pdf", documentType: "offering_memorandum" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ filename: "offering-memorandum.pdf", documentType: "offering_memorandum", disclosurePack: { status: "ready" } });
    expect(offering.disclosurePack.documentIds).toHaveLength(1);
    expect(mocks.persistDossier).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "application-1", filename: "offering-memorandum.pdf" }));
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DisclosureDocumentUploaded" }), "session-1");
  });
});
