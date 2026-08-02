import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(), closeRound: vi.fn(), create: vi.fn(), createAndSubmit: vi.fn(), createRound: vi.fn(), get: vi.fn(), idempotent: vi.fn(), list: vi.fn(), listItems: vi.fn(), listRounds: vi.fn(), listTasks: vi.fn(), needsInfo: vi.fn(), authorize: vi.fn(), readCommandId: vi.fn(), reject: vi.fn(), requestService: vi.fn(), respondItem: vi.fn(), resubmit: vi.fn(), reviewItem: vi.fn(), serialize: vi.fn((value: unknown) => value), startReview: vi.fn(), submit: vi.fn(), updateTask: vi.fn(), withdraw: vi.fn(),
}));

vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.readCommandId, runIdempotentCommand: mocks.idempotent }));
vi.mock("../../services/applications.service.js", () => ({
  approveApplication: mocks.approve,
  closeApplicationReviewRound: mocks.closeRound,
  createApplication: mocks.create,
  createAndSubmitApplication: mocks.createAndSubmit,
  createApplicationReviewRound: mocks.createRound,
  getApplication: mocks.get,
  listApplicationReviewItems: mocks.listItems,
  listApplicationReviewRounds: mocks.listRounds,
  listApplications: mocks.list,
  listApplicationTasks: mocks.listTasks,
  markApplicationNeedsInfo: mocks.needsInfo,
  rejectApplication: mocks.reject,
  requestApplicationService: mocks.requestService,
  respondToReviewItem: mocks.respondItem,
  resubmitApplication: mocks.resubmit,
  reviewApplicationItemResponse: mocks.reviewItem,
  startApplicationReview: mocks.startReview,
  submitApplication: mocks.submit,
  updateTaskStatus: mocks.updateTask,
  withdrawApplication: mocks.withdraw,
}));

import { createApplicationController } from "../applications.controller.js";

const user = { userId: "issuer-1", role: "issuer", businessId: "business-1" };
const request = (body: unknown = {}, extra: Record<string, unknown> = {}) => ({ body, headers: { "idempotency-key": "command-1" }, params: { id: "application-1" }, query: {}, authUser: user, ...extra }) as any;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.readCommandId.mockReturnValue("command-1");
  mocks.idempotent.mockImplementation(async ({ execute }: { execute: () => unknown }) => execute());
  for (const mock of [mocks.approve, mocks.closeRound, mocks.create, mocks.createAndSubmit, mocks.createRound, mocks.get, mocks.list, mocks.listItems, mocks.listRounds, mocks.listTasks, mocks.needsInfo, mocks.reject, mocks.requestService, mocks.respondItem, mocks.resubmit, mocks.reviewItem, mocks.startReview, mocks.submit, mocks.updateTask, mocks.withdraw]) mock.mockResolvedValue({ id: "result-1" });
});

describe("application controller", () => {
  it("creates, submits, lists, and reads applications and tasks", async () => {
    const controller = createApplicationController();
    await expect(controller.create(request({ templateCode: "A" }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.createAndSubmit(request({ templateCode: "B", dossierDocuments: [], requestedServices: [] }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.list(request({}, { query: { status: "draft", page: "2", limit: "5" } }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.getById(request())).resolves.toEqual({ id: "result-1" });
    await expect(controller.listTasks(request())).resolves.toEqual({ id: "result-1" });
    await expect(controller.submit(request())).resolves.toEqual({ id: "result-1" });
    expect(mocks.create).toHaveBeenCalledWith(user, { templateCode: "A" });
    expect(mocks.list).toHaveBeenCalledWith(user, { status: "draft", page: 2, limit: 5 });
    expect(mocks.submit).toHaveBeenCalledWith(user, "application-1");
    expect(mocks.idempotent).toHaveBeenCalledWith(expect.objectContaining({ route: "POST:/v1/applications/:id/submit", commandId: "command-1" }));
  });

  it("handles service requests, task changes, and application review decisions", async () => {
    const controller = createApplicationController();
    await expect(controller.requestService(request({ professionalId: "professional-1", stage: "Diligence" }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.updateTaskStatus(request({ status: "completed" }, { params: { id: "task-1" } }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.startReview(request())).resolves.toEqual({ id: "result-1" });
    await expect(controller.needsInfo(request())).resolves.toEqual({ id: "result-1" });
    await expect(controller.resubmit(request())).resolves.toEqual({ id: "result-1" });
    await expect(controller.approve(request({ reasonCode: "APPROVED", notes: "All checks complete." }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.reject(request({ reasonCode: "RISK", notes: "Documentation is incomplete." }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.withdraw(request({ reason: "Asset sale was withdrawn." }))).resolves.toEqual({ id: "result-1" });
    expect(mocks.requestService).toHaveBeenCalledWith(user, "application-1", { professionalId: "professional-1", stage: "Diligence" });
    expect(mocks.updateTask).toHaveBeenCalledWith(user, "task-1", { status: "completed" });
    expect(mocks.approve).toHaveBeenCalledWith(user, "application-1", { reasonCode: "APPROVED", notes: "All checks complete." });
    expect(mocks.withdraw).toHaveBeenCalledWith(user, "application-1", "Asset sale was withdrawn.");
  });

  it("handles review rounds and review-item responses", async () => {
    const controller = createApplicationController();
    const round = { stageTag: "Diligence", summary: "Missing valuation evidence", items: [{ itemType: "document", itemKey: "valuation", title: "Valuation report", requestMessage: "Upload the signed valuation report." }] };
    await expect(controller.listReviewRounds(request())).resolves.toEqual({ id: "result-1" });
    await expect(controller.listReviewItems(request({}, { query: { roundId: "round-1", status: "open" } }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.openReviewRound(request(round))).resolves.toEqual({ id: "result-1" });
    await expect(controller.respondReviewItem(request({ responseMessage: "The signed report is now uploaded." }, { params: { id: "item-1" } }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.verifyReviewItem(request({ status: "verified", reviewNotes: "Verified against the source report." }, { params: { id: "item-1" } }))).resolves.toEqual({ id: "result-1" });
    await expect(controller.closeReviewRound(request({ notes: "All items are complete." }, { params: { id: "round-1" } }))).resolves.toEqual({ id: "result-1" });
    expect(mocks.createRound).toHaveBeenCalledWith(user, "application-1", expect.objectContaining({ stageTag: "Diligence" }));
    expect(mocks.respondItem).toHaveBeenCalledWith(user, "item-1", { responseMessage: "The signed report is now uploaded." });
    expect(mocks.reviewItem).toHaveBeenCalledWith(user, "item-1", { status: "verified", reviewNotes: "Verified against the source report." });
    expect(mocks.closeRound).toHaveBeenCalledWith(user, "round-1");
  });
});
