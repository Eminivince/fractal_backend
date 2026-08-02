import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  amlCheck: vi.fn(),
  appendEvent: vi.fn(),
  autowire: vi.fn(),
  evidence: vi.fn(),
  inbox: vi.fn(),
  isOnchain: vi.fn(),
  notification: vi.fn(),
  offeringFind: vi.fn(),
  parseAml: vi.fn(),
  profileFind: vi.fn(),
  subscriptionFind: vi.fn(),
  verifySignature: vi.fn(),
  webhookFindOneAndUpdate: vi.fn(),
  webhookUpdate: vi.fn(),
  env: { NODE_ENV: "development", SUMSUB_ENABLED: true, SUMSUB_INBOX_ENABLED: false },
}));
const InboxPayloadConflictError = vi.hoisted(() => class InboxPayloadConflictError extends Error {});

vi.mock("../../../../db/models.js", () => ({
  InvestorProfileModel: { findOne: mocks.profileFind },
  OfferingModel: { find: mocks.offeringFind },
  SubscriptionModel: { find: mocks.subscriptionFind },
  WebhookEventModel: { findOneAndUpdate: mocks.webhookFindOneAndUpdate, updateOne: mocks.webhookUpdate },
}));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../platform/postgres-inbox.js", () => ({ InboxPayloadConflictError, receiveInboxEvent: mocks.inbox }));
vi.mock("../../../../platform/postgres-provider-identity-verification.js", () => ({ recordSumsubIdentityVerificationEvidence: mocks.evidence }));
vi.mock("../../../../services/onchain-autowire.js", () => ({ autowireKycWhitelist: mocks.autowire, isOnchainEnabled: mocks.isOnchain }));
vi.mock("../../../../services/sumsub-aml.service.js", () => ({ initiateAmlCheck: mocks.amlCheck, parseAmlWebhookResult: mocks.parseAml }));
vi.mock("../../../../services/sumsub.js", () => ({ verifySumsubWebhookSignature: mocks.verifySignature }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notification }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));

import { processSumsubInboxEvent, sumsubWebhookRoutes } from "../sumsub-webhook.routes.js";

const body = {
  type: "applicantReviewed",
  applicantId: "applicant-1",
  externalUserId: "investor-1",
  reviewStatus: "completed",
  reviewResult: { reviewAnswer: "GREEN" },
  createdAtMs: "1700000000000",
};

function selectLean(value: unknown) {
  return { select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    _id: "profile-1",
    userId: "investor-1",
    kycStatus: "pending",
    amlStatus: "pending",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.env.NODE_ENV = "development";
  mocks.env.SUMSUB_ENABLED = true;
  mocks.env.SUMSUB_INBOX_ENABLED = false;
  mocks.verifySignature.mockReturnValue(true);
  mocks.webhookFindOneAndUpdate.mockResolvedValue({ _id: "webhook-1", status: "received" });
  mocks.webhookUpdate.mockResolvedValue(undefined);
  mocks.evidence.mockResolvedValue({ identityId: "identity-1", duplicate: false });
  mocks.amlCheck.mockResolvedValue(undefined);
  mocks.notification.mockResolvedValue(undefined);
  mocks.appendEvent.mockResolvedValue(undefined);
  mocks.isOnchain.mockReturnValue(false);
  mocks.parseAml.mockReturnValue(null);
  app = Fastify();
  await app.register(sumsubWebhookRoutes);
});

afterEach(async () => {
  await app.close();
});

describe("Sumsub webhook intake", () => {
  it("accepts a signed valid event into the durable inbox", async () => {
    mocks.env.SUMSUB_INBOX_ENABLED = true;
    mocks.inbox.mockResolvedValue({ duplicate: false });

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/sumsub",
      headers: { "content-type": "application/json", "x-payload-digest": "signed" },
      payload: JSON.stringify(body),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, queued: true, deduplicated: false });
    expect(mocks.inbox).toHaveBeenCalledWith(expect.objectContaining({ provider: "sumsub", externalEventId: "applicant-1:applicantReviewed:1700000000000" }));
  });

  it("handles disabled, unsigned, invalid, and malformed webhook requests", async () => {
    mocks.env.SUMSUB_ENABLED = false;
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: JSON.stringify(body), headers: { "content-type": "application/json" } })).resolves.toMatchObject({ statusCode: 200 });

    mocks.env.SUMSUB_ENABLED = true;
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: JSON.stringify(body), headers: { "content-type": "application/json" } })).resolves.toMatchObject({ statusCode: 401 });
    mocks.verifySignature.mockReturnValueOnce(false);
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: JSON.stringify(body), headers: { "content-type": "application/json", "x-payload-digest": "bad" } })).resolves.toMatchObject({ statusCode: 401 });
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: JSON.stringify({ type: "missing-fields" }), headers: { "content-type": "application/json", "x-payload-digest": "signed" } })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("returns a conflict or temporary failure when inbox intake cannot accept an event", async () => {
    mocks.env.SUMSUB_INBOX_ENABLED = true;
    mocks.inbox.mockRejectedValueOnce(new InboxPayloadConflictError("conflict"));
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: JSON.stringify(body), headers: { "content-type": "application/json", "x-payload-digest": "signed" } })).resolves.toMatchObject({ statusCode: 409 });
    mocks.inbox.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: JSON.stringify(body), headers: { "content-type": "application/json", "x-payload-digest": "signed" } })).resolves.toMatchObject({ statusCode: 503 });
  });
});

describe("Sumsub inbox processing", () => {
  it("records governed evidence and approves a newly verified investor in development", async () => {
    mocks.env.SUMSUB_INBOX_ENABLED = true;
    const investor = profile({ walletAddress: "0xabc" });
    mocks.profileFind.mockResolvedValue(investor);
    mocks.subscriptionFind.mockReturnValue(selectLean([{ offeringId: "offering-1" }]));
    mocks.offeringFind.mockReturnValue(selectLean([{ tokenDeployment: { status: "deployed", contractAddress: "0xToken" } }]));
    mocks.isOnchain.mockReturnValue(true);
    const localApp = Fastify();

    await processSumsubInboxEvent({ app: localApp, payload: body, externalEventId: "event-1", rawBody: JSON.stringify(body), signature: "signed" });

    expect(mocks.evidence).toHaveBeenCalledWith(expect.objectContaining({ externalEventId: "event-1", applicantId: "applicant-1" }));
    expect(investor.kycStatus).toBe("approved");
    expect(mocks.amlCheck).toHaveBeenCalledWith("applicant-1");
    expect(mocks.autowire).toHaveBeenCalledWith(expect.objectContaining({ walletAddress: "0xabc", tokenContractAddresses: ["0xToken"] }));
    expect(mocks.webhookUpdate).toHaveBeenCalledWith({ _id: "webhook-1" }, expect.any(Object));
    await localApp.close();
  });

  it("records rejection, pending review, AML outcome, and unknown-profile events safely", async () => {
    const rejected = profile({ kycStatus: "in_review", amlStatus: "pending" });
    mocks.profileFind.mockResolvedValueOnce(rejected);
    mocks.parseAml.mockReturnValueOnce({ status: "clear" });
    const localApp = Fastify();
    await processSumsubInboxEvent({ app: localApp, payload: { ...body, reviewResult: { reviewAnswer: "RED", rejectLabels: ["DOCUMENT_INVALID"], clientComment: "Document is invalid" } }, externalEventId: "event-red", rawBody: "red", signature: "signed" });
    expect(rejected.kycStatus).toBe("rejected");
    expect(rejected.amlStatus).toBe("clear");
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "KYCRejected" }));

    const pending = profile({ kycStatus: "pending" });
    mocks.profileFind.mockResolvedValueOnce(pending);
    await processSumsubInboxEvent({ app: localApp, payload: { ...body, type: "applicantPending", reviewResult: undefined }, externalEventId: "event-pending", rawBody: "pending", signature: "signed" });
    expect(pending.kycStatus).toBe("in_review");

    mocks.profileFind.mockResolvedValueOnce(null);
    await expect(processSumsubInboxEvent({ app: localApp, payload: body, externalEventId: "event-missing", rawBody: "missing", signature: "signed" })).resolves.toBeUndefined();
    await localApp.close();
  });
});
