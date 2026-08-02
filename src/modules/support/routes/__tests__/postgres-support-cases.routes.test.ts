import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  commandId: vi.fn(),
  stepUp: vi.fn(),
  requireRole: vi.fn(),
  listOwn: vi.fn(),
  create: vi.fn(),
  getOwn: vi.fn(),
  message: vi.fn(),
  listAdmin: vi.fn(),
  getAdmin: vi.fn(),
  transition: vi.fn(),
  authorizeAttachment: vi.fn(),
  recordAttachment: vi.fn(),
  getAttachment: vi.fn(),
  recordDownload: vi.fn(),
  store: vi.fn(),
  retrieve: vi.fn(),
  recordDocument: vi.fn(),
  lifecycle: vi.fn(),
  holdTarget: vi.fn(),
  proposeHold: vi.fn(),
  decideHold: vi.fn(),
  proposeDisposition: vi.fn(),
  decideDisposition: vi.fn(),
}));

const {
  TestIdentityUnavailableError,
  TestSupportCaseError,
  TestStepUpRequiredError,
  TestCapabilityError,
  TestIdempotencyConflictError,
  TestAttachmentError,
  TestAttachmentReplayError,
  TestLifecycleError,
} = vi.hoisted(() => ({
  TestIdentityUnavailableError: class TestIdentityUnavailableError extends Error {},
  TestSupportCaseError: class TestSupportCaseError extends Error { constructor(readonly code: string, message: string) { super(message); } },
  TestStepUpRequiredError: class TestStepUpRequiredError extends Error {},
  TestCapabilityError: class TestCapabilityError extends Error { constructor(readonly code: string, message: string) { super(message); } },
  TestIdempotencyConflictError: class TestIdempotencyConflictError extends Error {},
  TestAttachmentError: class TestAttachmentError extends Error { constructor(readonly code: string, message: string) { super(message); } },
  TestAttachmentReplayError: class TestAttachmentReplayError extends Error { constructor(readonly attachment: unknown) { super("replayed"); } },
  TestLifecycleError: class TestLifecycleError extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));

vi.mock("../../../../middleware/role-guard.js", () => ({ requireRole: mocks.requireRole }));
vi.mock("../../../../platform/postgres-administrator-capabilities.js", () => ({ AdministratorCapabilityError: TestCapabilityError }));
vi.mock("../../../../platform/postgres-idempotency.js", () => ({ PostgresIdempotencyConflictError: TestIdempotencyConflictError }));
vi.mock("../../../../platform/postgres-identities.js", () => ({
  requirePostgresIdentityForSubject: mocks.identity,
  PostgresIdentityUnavailableError: TestIdentityUnavailableError,
}));
vi.mock("../../../../platform/postgres-support-cases.js", () => ({
  SupportCaseError: TestSupportCaseError,
  addRequesterSupportMessage: mocks.message,
  createSupportCase: mocks.create,
  getAdministratorSupportCase: mocks.getAdmin,
  getOwnSupportCase: mocks.getOwn,
  listAdministratorSupportCases: mocks.listAdmin,
  listOwnSupportCases: mocks.listOwn,
  transitionAdministratorSupportCase: mocks.transition,
}));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.commandId }));
vi.mock("../../../../platform/auth-step-up.js", () => ({
  requireFreshTotpStepUp: mocks.stepUp,
  StepUpRequiredError: TestStepUpRequiredError,
}));
vi.mock("../../../../platform/postgres-support-attachments.js", () => ({
  SupportAttachmentError: TestAttachmentError,
  SupportAttachmentReplayError: TestAttachmentReplayError,
  authorizeSupportCaseAttachmentUpload: mocks.authorizeAttachment,
  getSupportCaseAttachmentForDownload: mocks.getAttachment,
  recordSupportCaseAttachment: mocks.recordAttachment,
  recordSupportCaseAttachmentDownload: mocks.recordDownload,
}));
vi.mock("../../../../services/storage.js", () => ({ persistSupportAttachmentBinary: mocks.store, retrieveFile: mocks.retrieve }));
vi.mock("../../../../services/storage-metadata-guard.js", () => ({ recordStoredDocument: mocks.recordDocument }));
vi.mock("../../../../platform/postgres-support-evidence-lifecycle.js", () => ({
  SupportEvidenceLifecycleError: TestLifecycleError,
  decideLegalHoldChange: mocks.decideHold,
  decideSupportAttachmentDisposition: mocks.decideDisposition,
  proposeLegalHoldChange: mocks.proposeHold,
  proposeSupportAttachmentDisposition: mocks.proposeDisposition,
  readSupportAttachmentLifecycle: mocks.lifecycle,
  resolveSupportEvidenceHoldTarget: mocks.holdTarget,
}));

import { postgresSupportCaseRoutes } from "../postgres-support-cases.routes.js";

const caseId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
let role = "investor";
let app: ReturnType<typeof Fastify>;

const createPayload = {
  category: "payment_status",
  reportedImpact: "blocked",
  subject: "A payment does not appear in my account",
  description: "The completed payment does not yet appear in my investment record.",
  occurredAt: "2026-07-01T10:00:00.000Z",
};

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "investor";
  mocks.identity.mockResolvedValue("identity-1");
  mocks.commandId.mockImplementation((headers: Record<string, string | undefined>) => headers["x-command-id"]);
  mocks.stepUp.mockResolvedValue(undefined);
  mocks.requireRole.mockImplementation((user: { role?: string } | undefined, required: string) => {
    if (user?.role !== required) throw new HttpError(403, "Insufficient role");
  });
  mocks.listOwn.mockResolvedValue({ cases: [] });
  mocks.create.mockResolvedValue({ case: { id: caseId }, replayed: false });
  mocks.getOwn.mockResolvedValue({ case: { id: caseId }, events: [], serviceEvents: [], notificationDeliveries: [], attachments: [] });
  mocks.message.mockResolvedValue({ case: { id: caseId }, replayed: false });
  mocks.listAdmin.mockResolvedValue({ cases: [] });
  mocks.getAdmin.mockResolvedValue({ case: { id: caseId }, events: [], serviceEvents: [], notificationDeliveries: [], attachments: [] });
  mocks.transition.mockResolvedValue({ case: { id: caseId }, replayed: false });
  mocks.lifecycle.mockResolvedValue({ attachmentId, retentionDueAt: "2026-12-01T00:00:00.000Z", retentionElapsed: false, activeHolds: [], pendingHoldChanges: [], pendingDispositionRequest: null, disposition: null });
  mocks.holdTarget.mockResolvedValue({ targetType: "support_attachment", targetId: attachmentId });
  mocks.proposeHold.mockResolvedValue({ request: { id: requestId }, replayed: false });
  mocks.decideHold.mockResolvedValue({ request: { id: requestId }, replayed: false });
  mocks.proposeDisposition.mockResolvedValue({ request: { id: requestId }, replayed: false });
  mocks.decideDisposition.mockResolvedValue({ request: { id: requestId }, replayed: false });
  mocks.authorizeAttachment.mockResolvedValue(undefined);
  mocks.store.mockResolvedValue({ storageKey: "support/case-1/evidence.pdf", bytes: 4, sha256: "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860", scanner: "clamav_instream", scannedAt: new Date("2026-07-01T10:00:00.000Z") });
  mocks.recordDocument.mockImplementation(async ({ record }: { record: () => Promise<unknown> }) => record());
  mocks.recordAttachment.mockResolvedValue({ attachment: { id: attachmentId } });
  mocks.getAttachment.mockResolvedValue({ id: attachmentId, filename: "evidence.pdf", mimeType: "application/pdf", storageKey: "support/case-1/evidence.pdf", contentSha256: "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860", classification: "general" });
  mocks.retrieve.mockResolvedValue({ buffer: Buffer.from("safe"), redirectUrl: null });
  mocks.recordDownload.mockResolvedValue(undefined);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500);
    return reply.status(statusCode).send({ message: error.message });
  });
  app.setSerializerCompiler(() => (value: unknown) => JSON.stringify(value));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    request.authUser = { userId: "subject-1", sessionId: "session-1", role };
  });
  await app.register(postgresSupportCaseRoutes);
});

afterEach(async () => { await app.close(); });

describe("PostgreSQL support case routes", () => {
  it("allows a requester to list, create, read, and add information to only their case", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/support/cases?status=new" })).resolves.toMatchObject({ statusCode: 200 });
    const created = await app.inject({ method: "POST", url: "/v1/support/cases", headers: { "x-command-id": "open-1" }, payload: createPayload });
    expect(created.statusCode, created.body).toBe(201);
    await expect(app.inject({ method: "GET", url: `/v1/support/cases/${caseId}` })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/support/cases/${caseId}/messages`, headers: { "x-command-id": "message-1" }, payload: { message: "Please review the provider reference.", expectedVersion: 1 } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ actorIdentityId: "identity-1", actorRole: "investor", commandKey: "open-1" }));
    expect(mocks.message).toHaveBeenCalledWith(expect.objectContaining({ caseId, expectedVersion: 1, commandKey: "message-1" }));
  });

  it("rejects malformed requests and unavailable authenticated identities before support state changes", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/support/cases", headers: { "x-command-id": "open-1" }, payload: { ...createPayload, subject: "short" } })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/v1/support/cases", payload: createPayload })).resolves.toMatchObject({ statusCode: 400 });
    mocks.identity.mockRejectedValueOnce(new TestIdentityUnavailableError("identity migration pending"));
    const unavailable = await app.inject({ method: "GET", url: "/v1/support/cases" });
    expect(unavailable.statusCode).toBe(409);
    expect(mocks.listOwn).not.toHaveBeenCalled();
  });

  it("requires administrator authority and fresh step-up for support case administration", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/admin/support-cases" })).resolves.toMatchObject({ statusCode: 403 });
    role = "admin";
    await expect(app.inject({ method: "GET", url: "/v1/admin/support-cases?category=payment_status" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: `/v1/admin/support-cases/${caseId}` })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-cases/${caseId}/transitions`, headers: { "x-command-id": "transition-1" }, payload: { action: "resolve", expectedVersion: 1, message: "The payment record is now available." } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.stepUp).toHaveBeenCalledWith({ sessionId: "session-1", identityId: "identity-1" });
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({ caseId, actorIdentityId: "identity-1", commandKey: "transition-1" }));
  });

  it("maps support and capability conflicts to safe client status codes", async () => {
    role = "admin";
    mocks.listAdmin.mockRejectedValueOnce(new TestCapabilityError("forbidden", "Capability required"));
    await expect(app.inject({ method: "GET", url: "/v1/admin/support-cases" })).resolves.toMatchObject({ statusCode: 403 });
    mocks.getAdmin.mockRejectedValueOnce(new TestSupportCaseError("not_found", "Case not found"));
    await expect(app.inject({ method: "GET", url: `/v1/admin/support-cases/${caseId}` })).resolves.toMatchObject({ statusCode: 404 });
    mocks.transition.mockRejectedValueOnce(new TestIdempotencyConflictError("Command already used"));
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-cases/${caseId}/transitions`, headers: { "x-command-id": "transition-2" }, payload: { action: "note", expectedVersion: 1, message: "A valid internal case note." } })).resolves.toMatchObject({ statusCode: 409 });
    mocks.stepUp.mockRejectedValueOnce(new TestStepUpRequiredError("Complete step-up"));
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-cases/${caseId}/transitions`, headers: { "x-command-id": "transition-3" }, payload: { action: "note", expectedVersion: 1, message: "A valid internal case note." } })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("stores classified requester evidence and returns it only after an integrity check", async () => {
    const headers = {
      "content-type": "application/octet-stream",
      "x-command-id": "attachment-1",
      "x-fractal-attachment-classification": "general",
      "x-fractal-attachment-filename": "evidence.pdf",
      "x-fractal-attachment-mime-type": "application/pdf",
    };
    const uploaded = await app.inject({ method: "POST", url: `/v1/support/cases/${caseId}/attachments`, headers, payload: Buffer.from("safe") });
    expect(uploaded.statusCode).toBe(201);
    expect(mocks.authorizeAttachment).toHaveBeenCalledWith(expect.objectContaining({ caseId, actorIdentityId: "identity-1", staff: false, visibility: "requester" }));
    expect(mocks.recordAttachment).toHaveBeenCalledWith(expect.objectContaining({ commandKey: "attachment-1", storageKey: "support/case-1/evidence.pdf" }));
    const downloaded = await app.inject({ method: "GET", url: `/v1/support/attachments/${attachmentId}/download` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["x-fractal-content-sha256"]).toBe("8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860");
    expect(mocks.recordDownload).toHaveBeenCalledWith(expect.objectContaining({ attachmentId, staff: false }));

    mocks.recordAttachment.mockRejectedValueOnce(new TestAttachmentReplayError({ id: attachmentId }));
    const replayed = await app.inject({ method: "POST", url: `/v1/support/cases/${caseId}/attachments`, headers: { ...headers, "x-command-id": "attachment-1-replay" }, payload: Buffer.from("safe") });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ attachment: { id: attachmentId }, replayed: true });
  });

  it("fails attachment access when the payload is empty, data is redirected, or integrity fails", async () => {
    const headers = {
      "content-type": "application/octet-stream",
      "x-command-id": "attachment-2",
      "x-fractal-attachment-classification": "general",
      "x-fractal-attachment-filename": "%E0%A4%A",
      "x-fractal-attachment-mime-type": "application/pdf",
    };
    await expect(app.inject({ method: "POST", url: `/v1/support/cases/${caseId}/attachments`, headers, payload: Buffer.from("safe") })).resolves.toMatchObject({ statusCode: 400 });
    mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("safe"), redirectUrl: "https://storage.example.test/object" });
    await expect(app.inject({ method: "GET", url: `/v1/support/attachments/${attachmentId}/download` })).resolves.toMatchObject({ statusCode: 409 });
    mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("changed"), redirectUrl: null });
    await expect(app.inject({ method: "GET", url: `/v1/support/attachments/${attachmentId}/download` })).resolves.toMatchObject({ statusCode: 409 });
  });

  it("records maker-checker support evidence lifecycle actions under administrator authority", async () => {
    role = "admin";
    await expect(app.inject({ method: "GET", url: `/v1/admin/support-attachments/${attachmentId}/lifecycle` })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-attachments/${attachmentId}/legal-hold-requests`, headers: { "x-command-id": "hold-1" }, payload: { action: "impose", scope: "attachment", reasonCategory: "audit", reason: "An active audit requires this evidence to remain available." } })).resolves.toMatchObject({ statusCode: 201 });
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-attachment-hold-requests/${requestId}/decision`, payload: { decision: "approve", decisionReason: "A separate administrator confirms the audit hold." } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-attachments/${attachmentId}/disposition-requests`, headers: { "x-command-id": "disposition-1" }, payload: { reason: "The retention period is complete and no hold applies." } })).resolves.toMatchObject({ statusCode: 201 });
    await expect(app.inject({ method: "POST", url: `/v1/admin/support-attachment-disposition-requests/${requestId}/decision`, payload: { decision: "reject", decisionReason: "An evidence review requires the attachment to remain." } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.proposeHold).toHaveBeenCalledWith(expect.objectContaining({ targetId: attachmentId, commandKey: "hold-1" }));
    expect(mocks.proposeDisposition).toHaveBeenCalledWith(expect.objectContaining({ attachmentId, commandKey: "disposition-1" }));
  });
});
