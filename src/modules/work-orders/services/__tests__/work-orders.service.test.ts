import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  applicationById: vi.fn(),
  reviewItemFind: vi.fn(),
  reviewItemCount: vi.fn(),
  reviewItemCreate: vi.fn(),
  reviewRoundFind: vi.fn(),
  reviewRoundCreate: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceCreate: vi.fn(),
  professionalById: vi.fn(),
  eventCreate: vi.fn(),
  eventFind: vi.fn(),
  workOrderById: vi.fn(),
  workOrderCount: vi.fn(),
  workOrderFind: vi.fn(),
  workOrderFindOne: vi.fn(),
  workOrderCreate: vi.fn(),
  taskById: vi.fn(),
  userById: vi.fn(),
  binary: vi.fn(),
  audit: vi.fn(),
  issuerScope: vi.fn(),
  transition: vi.fn(),
  transaction: vi.fn(),
  notification: vi.fn(),
  decimal: vi.fn(),
  env: { APP_BASE_URL: undefined },
}));

vi.mock("../../../../db/models.js", () => ({
  ApplicationModel: { findById: mocks.applicationById },
  ApplicationReviewItemModel: { find: mocks.reviewItemFind, countDocuments: mocks.reviewItemCount, create: mocks.reviewItemCreate },
  ApplicationReviewRoundModel: { findById: vi.fn(), findOne: mocks.reviewRoundFind, create: mocks.reviewRoundCreate },
  ProfessionalInvoiceModel: { create: mocks.invoiceCreate, findOne: mocks.invoiceFind },
  ProfessionalModel: { findById: mocks.professionalById },
  ProfessionalWorkOrderEventModel: { create: mocks.eventCreate, find: mocks.eventFind },
  ProfessionalWorkOrderModel: { findById: mocks.workOrderById, countDocuments: mocks.workOrderCount, find: mocks.workOrderFind, findOne: mocks.workOrderFindOne, create: mocks.workOrderCreate },
  TaskModel: { findById: mocks.taskById },
  UserModel: { findById: mocks.userById },
}));
vi.mock("../../../../services/storage.js", () => ({ persistWorkOrderBinary: mocks.binary }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.audit }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.issuerScope }));
vi.mock("../../../../utils/state-machine.js", () => ({ assertTransition: mocks.transition }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notification }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));

import {
  acceptWorkOrder,
  assignTaskWorkOrder,
  declineWorkOrder,
  getWorkOrder,
  listWorkOrders,
  requestWorkOrderInfo,
  reviewWorkOrder,
  withdrawWorkOrder,
  escalateOverdueWorkOrders,
  listWorkOrderEvents,
  scoreWorkOrder,
  getWorkOrderInvoice,
  uploadWorkOrderDeliverable,
  bulkAssignTasks,
  startWorkOrderReview,
  startWorkOrder,
  submitWorkOrderOutcome,
} from "../work-orders.service.js";

const operator = { userId: "operator-1", role: "operator" } as any;
const professionalUser = { userId: "professional-user-1", role: "professional" } as any;
const taskId = "task-1";
const workOrderId = "work-order-1";

function sessionValue(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) };
}

function selectedSessionValue(value: unknown) {
  return { select: vi.fn(() => ({ session: vi.fn().mockResolvedValue(value) })) };
}

function leanValue(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function listQuery(value: unknown) {
  return { sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })) })) };
}

function sortedSessionValue(value: unknown) {
  return { sort: vi.fn(() => ({ session: vi.fn().mockResolvedValue(value) })) };
}

function sortedLimitedSessionValue(value: unknown) {
  return { sort: vi.fn(() => ({ limit: vi.fn(() => ({ session: vi.fn().mockResolvedValue(value) })) })) };
}

function workOrder(overrides: Record<string, unknown> = {}) {
  return {
    _id: workOrderId,
    taskId,
    businessId: "business-1",
    professionalId: "professional-1",
    assigneeUserId: professionalUser.userId,
    status: "assigned",
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }),
    ...overrides,
  } as any;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.env.APP_BASE_URL = undefined;
  mocks.transaction.mockImplementation(async (operation: (session: unknown) => Promise<unknown>) => operation({ id: "session-1" }));
  mocks.audit.mockResolvedValue(undefined);
  mocks.eventCreate.mockResolvedValue(undefined);
  mocks.notification.mockResolvedValue(undefined);
  mocks.transition.mockReturnValue(undefined);
  mocks.decimal.mockImplementation((value: number) => `decimal:${value}`);
});

describe("work order service", () => {
  it("assigns an approved available professional, updates the task, and emits the full audit trail", async () => {
    const task = { _id: taskId, applicationId: "application-1", category: "valuation", stage: "due_diligence", save: vi.fn().mockResolvedValue(undefined) } as any;
    mocks.taskById.mockReturnValueOnce(sessionValue(task));
    mocks.applicationById.mockReturnValueOnce(sessionValue({ _id: "application-1", businessId: "business-1" }));
    mocks.professionalById.mockReturnValueOnce(sessionValue({ _id: "professional-1", name: "Ada Advisory", status: "active", onboardingStatus: "approved", availabilityStatus: "available", maxConcurrentWorkOrders: 3, excludedBusinessIds: [] }));
    mocks.workOrderCount.mockReturnValueOnce(sessionValue(0));
    mocks.userById.mockReturnValueOnce(selectedSessionValue({ _id: professionalUser.userId, role: "professional", status: "active", professionalId: "professional-1" }));
    mocks.workOrderFindOne.mockReturnValueOnce(sessionValue(null)).mockReturnValueOnce(sessionValue(null));
    mocks.workOrderCreate.mockResolvedValueOnce([workOrder({ category: "valuation", instructions: "Review the valuation evidence." })]);

    const result = await assignTaskWorkOrder(operator, taskId, { professionalId: "professional-1", assigneeUserId: professionalUser.userId, priority: "high", instructions: "Review the valuation evidence.", dueAt: "2026-08-31" } as any);

    expect(result).toMatchObject({ _id: workOrderId, category: "valuation", status: "assigned" });
    expect(task.assignedProfessionalId).toBe("professional-1");
    expect(task.save).toHaveBeenCalledWith({ session: { id: "session-1" } });
    expect(mocks.workOrderCreate).toHaveBeenCalledWith([expect.objectContaining({ category: "valuation", status: "assigned", dueAt: expect.any(Date) })], { session: { id: "session-1" } });
    expect(mocks.eventCreate).toHaveBeenCalledWith([expect.objectContaining({ eventType: "Assigned" })], { session: { id: "session-1" } });
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.notification).toHaveBeenCalledWith(operator, expect.objectContaining({ action: "WorkOrderAssigned" }), { id: "session-1" });
  });

  it("rejects non-operators and assignment risks before it creates a work order", async () => {
    await expect(assignTaskWorkOrder({ userId: "investor-1", role: "investor" } as any, taskId, {} as any)).rejects.toMatchObject({ statusCode: 403 });

    mocks.taskById.mockReturnValueOnce(sessionValue({ _id: taskId, applicationId: "application-1" }));
    mocks.applicationById.mockReturnValueOnce(sessionValue({ _id: "application-1", businessId: "business-1" }));
    mocks.professionalById.mockReturnValueOnce(sessionValue({ _id: "professional-1", status: "active", onboardingStatus: "approved", licenseMeta: { expiresAt: new Date("2020-01-01") } }));
    await expect(assignTaskWorkOrder(operator, taskId, { professionalId: "professional-1" } as any)).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("license expired") });

    mocks.taskById.mockReturnValueOnce(sessionValue({ _id: taskId, applicationId: "application-1" }));
    mocks.applicationById.mockReturnValueOnce(sessionValue({ _id: "application-1", businessId: "business-1" }));
    mocks.professionalById.mockReturnValueOnce(sessionValue({ _id: "professional-1", status: "active", onboardingStatus: "approved", availabilityStatus: "unavailable" }));
    await expect(assignTaskWorkOrder(operator, taskId, { professionalId: "professional-1" } as any)).rejects.toMatchObject({ statusCode: 422, message: "Professional is currently unavailable for new assignments" });
  });

  it("lists scoped registers and returns no issuer records when the issuer has no business scope", async () => {
    mocks.workOrderFind.mockReturnValueOnce(listQuery([{ _id: workOrderId }]));
    mocks.workOrderCount.mockResolvedValueOnce(3);
    const professionalList = await listWorkOrders(professionalUser, { page: 2, limit: 2, status: "assigned", dueBefore: "2026-09-01" } as any);
    expect(mocks.workOrderFind).toHaveBeenCalledWith({ assigneeUserId: professionalUser.userId, status: "assigned", dueAt: { $lte: new Date("2026-09-01") } });
    expect(professionalList).toEqual({ data: [{ _id: workOrderId }], total: 3, page: 2, limit: 2, pages: 2 });

    const empty = await listWorkOrders({ userId: "issuer-1", role: "issuer" } as any, { limit: 20 } as any);
    expect(empty).toEqual({ data: [], total: 0, page: 1, limit: 20, pages: 0 });
  });

  it("lets the assignee accept or conflict-flag an assigned work order", async () => {
    const accepted = workOrder();
    mocks.workOrderById.mockReturnValueOnce(sessionValue(accepted));
    await expect(acceptWorkOrder(professionalUser, workOrderId, { coiDeclaredClear: true } as any)).resolves.toMatchObject({ status: "accepted", coiDeclaration: "clear" });
    expect(accepted.save).toHaveBeenCalledWith({ session: { id: "session-1" } });
    expect(mocks.eventCreate).toHaveBeenCalledWith([expect.objectContaining({ eventType: "Accepted" })], { session: { id: "session-1" } });

    const conflict = workOrder();
    mocks.workOrderById.mockReturnValueOnce(sessionValue(conflict));
    await expect(acceptWorkOrder(professionalUser, workOrderId, { coiDeclaredClear: false, coiNotes: "Related-party adviser." } as any)).resolves.toMatchObject({ status: "conflict_flagged", coiDeclaration: "conflict" });
    expect(mocks.notification).toHaveBeenCalledWith(professionalUser, expect.objectContaining({ action: "WorkOrderConflictFlagged" }), { id: "session-1" });
  });

  it("declines and starts only work orders in valid professional scope and synchronizes the task", async () => {
    const declined = workOrder({ status: "accepted" });
    const task = { _id: taskId, status: "in_progress", save: vi.fn().mockResolvedValue(undefined) };
    mocks.workOrderById.mockReturnValueOnce(sessionValue(declined));
    mocks.taskById.mockReturnValueOnce(sessionValue(task));
    await expect(declineWorkOrder(professionalUser, workOrderId, { reason: "The evidence requires a specialist." } as any)).resolves.toMatchObject({ status: "declined" });
    expect(task.status).toBe("open");
    expect(task.save).toHaveBeenCalledWith({ session: { id: "session-1" } });

    const started = workOrder({ status: "accepted" });
    const openTask = { _id: taskId, status: "open", save: vi.fn().mockResolvedValue(undefined) };
    mocks.workOrderById.mockReturnValueOnce(sessionValue(started));
    mocks.taskById.mockReturnValueOnce(sessionValue(openTask));
    await expect(startWorkOrder(professionalUser, workOrderId)).resolves.toMatchObject({ status: "in_progress", startedAt: expect.any(Date) });
    expect(openTask.status).toBe("in_progress");

    mocks.workOrderById.mockReturnValueOnce(sessionValue(workOrder({ status: "submitted" })));
    await expect(startWorkOrder(professionalUser, workOrderId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("returns scoped details with events and linked review items", async () => {
    mocks.workOrderById.mockReturnValueOnce(leanValue({ _id: workOrderId, assigneeUserId: professionalUser.userId, linkedReviewItemIds: ["item-1"] }));
    mocks.eventFind.mockReturnValueOnce({ sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ eventType: "Assigned" }]) })) });
    mocks.reviewItemFind.mockReturnValueOnce({ sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: "item-1" }]) })) });

    await expect(getWorkOrder(professionalUser, workOrderId)).resolves.toEqual({ workOrder: expect.objectContaining({ _id: workOrderId }), events: [{ eventType: "Assigned" }], linkedReviewItems: [{ _id: "item-1" }] });
  });

  it("submits stored deliverables only after required review items are resolved", async () => {
    const current = workOrder({ status: "in_progress", linkedReviewItemIds: ["item-1"] });
    mocks.workOrderById.mockReturnValueOnce(sessionValue(current));
    mocks.reviewItemCount.mockReturnValueOnce(sessionValue(0));
    mocks.binary.mockResolvedValueOnce({ storageKey: "work-orders/work-order-1/report.pdf" });

    await expect(submitWorkOrderOutcome(professionalUser, workOrderId, {
      recommendation: "approve",
      summary: "Evidence supports the valuation.",
      riskFlags: [],
      deliverables: [{ type: "report", filename: "report.pdf", mimeType: "application/pdf", contentBase64: "cGRm" }],
    } as any)).resolves.toMatchObject({ status: "submitted", outcome: expect.objectContaining({ recommendation: "approve", deliverables: [expect.objectContaining({ storageKey: "work-orders/work-order-1/report.pdf" })] }) });
    expect(mocks.binary).toHaveBeenCalledWith(expect.objectContaining({ workOrderId, filename: "report.pdf" }));
    expect(mocks.notification).toHaveBeenCalledWith(professionalUser, expect.objectContaining({ action: "WorkOrderOutcomeSubmitted" }), { id: "session-1" });

    mocks.workOrderById.mockReturnValueOnce(sessionValue(workOrder({ status: "needs_info", linkedReviewItemIds: ["item-1"] })));
    mocks.reviewItemCount.mockReturnValueOnce(sessionValue(1));
    await expect(submitWorkOrderOutcome(professionalUser, workOrderId, { recommendation: "approve", summary: "not ready", riskFlags: [] } as any)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("moves a submitted work order into operator review and prevents invalid review starts", async () => {
    const current = workOrder({ status: "submitted" });
    mocks.workOrderById.mockReturnValueOnce(sessionValue(current));
    await expect(startWorkOrderReview(operator, workOrderId)).resolves.toMatchObject({ status: "under_review" });
    expect(mocks.eventCreate).toHaveBeenCalledWith([expect.objectContaining({ eventType: "ReviewStarted" })], { session: { id: "session-1" } });

    mocks.workOrderById.mockReturnValueOnce(sessionValue(workOrder({ status: "in_progress" })));
    await expect(startWorkOrderReview(operator, workOrderId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("creates a review round and required item when a professional requests missing information", async () => {
    const current = workOrder({ status: "accepted", applicationId: "application-1", category: "valuation", stageTag: "due_diligence" });
    const application = { _id: "application-1", status: "submitted", stage: "due_diligence", save: vi.fn().mockResolvedValue(undefined) } as any;
    const task = { _id: taskId };
    mocks.workOrderById.mockReturnValueOnce(sessionValue(current));
    mocks.applicationById.mockReturnValueOnce(sessionValue(application));
    mocks.taskById.mockReturnValueOnce(sessionValue(task));
    mocks.reviewRoundFind.mockReturnValueOnce(sortedSessionValue(null)).mockReturnValueOnce(sortedSessionValue(null));
    mocks.reviewRoundCreate.mockResolvedValueOnce([{ _id: "round-1", stageTag: "due_diligence", toObject: () => ({ _id: "round-1" }) }]);
    mocks.reviewItemCreate.mockResolvedValueOnce([{ _id: "review-item-1", toObject: () => ({ _id: "review-item-1" }) }]);

    const result = await requestWorkOrderInfo(professionalUser, workOrderId, { title: "Upload valuation evidence", message: "Please upload the signed report.", required: true, dueAt: "2026-09-01" } as any);

    expect(result).toEqual({ workOrder: expect.objectContaining({ status: "needs_info" }), reviewRound: { _id: "round-1" }, reviewItem: { _id: "review-item-1" } });
    expect(application.status).toBe("needs_info");
    expect(current.linkedReviewItemIds).toEqual(["review-item-1"]);
    expect(mocks.transition).toHaveBeenCalledWith("application", "submitted", "in_review");
    expect(mocks.reviewItemCreate).toHaveBeenCalledWith([expect.objectContaining({ itemType: "task", required: true, sourceType: "work_order" })], { session: { id: "session-1" } });
  });

  it("accepts a reviewed outcome, copies deliverable evidence, and creates a priced invoice", async () => {
    const current = workOrder({
      status: "under_review",
      applicationId: "application-1",
      outcome: { deliverables: [{ storageKey: "work-orders/work-order-1/report.pdf", filename: "report.pdf" }] },
    });
    const task = { _id: taskId, status: "in_progress", evidenceDocs: [], save: vi.fn().mockResolvedValue(undefined) } as any;
    const professional = { _id: "professional-1", pricing: { model: "pct", amount: { toString: () => "2" } }, organizationType: "company", vatRegistered: true, save: vi.fn().mockResolvedValue(undefined) };
    mocks.workOrderById.mockReturnValueOnce(sessionValue(current));
    mocks.taskById.mockReturnValueOnce(sessionValue(task));
    mocks.professionalById.mockReturnValueOnce(sessionValue(professional));
    mocks.invoiceFind.mockReturnValueOnce(sessionValue(null));
    mocks.applicationById.mockReturnValueOnce(selectedSessionValue({ dealAmount: 1_000_000 }));
    mocks.invoiceCreate.mockResolvedValueOnce([]);

    await expect(reviewWorkOrder(operator, workOrderId, { decision: "accepted", notes: "Evidence is complete." } as any)).resolves.toMatchObject({ status: "completed", operatorDecision: "accepted" });
    expect(task.status).toBe("completed");
    expect(task.evidenceDocs).toEqual([{ docId: "work-orders/work-order-1/report.pdf", filename: "report.pdf" }]);
    expect(mocks.invoiceCreate).toHaveBeenCalledWith([expect.objectContaining({ pricingModel: "pct", computedAmount: "decimal:50000", vatAmount: "decimal:3750", whtAmount: "decimal:5000", netPayable: "decimal:48750" })], expect.any(Object));
  });

  it("returns a work order to the professional when the operator requests changes or rejects it", async () => {
    const needsChanges = workOrder({ status: "under_review" });
    const completedTask = { _id: taskId, status: "completed", save: vi.fn().mockResolvedValue(undefined) } as any;
    mocks.workOrderById.mockReturnValueOnce(sessionValue(needsChanges));
    mocks.taskById.mockReturnValueOnce(sessionValue(completedTask));
    await expect(reviewWorkOrder(operator, workOrderId, { decision: "needs_changes", notes: "Clarify the source." } as any)).resolves.toMatchObject({ status: "in_progress" });
    expect(completedTask.status).toBe("in_progress");

    const rejected = workOrder({ status: "under_review" });
    const task = { _id: taskId, status: "in_progress", save: vi.fn().mockResolvedValue(undefined) } as any;
    mocks.workOrderById.mockReturnValueOnce(sessionValue(rejected));
    mocks.taskById.mockReturnValueOnce(sessionValue(task));
    await expect(reviewWorkOrder(operator, workOrderId, { decision: "rejected", notes: "The report is unreliable." } as any)).resolves.toMatchObject({ status: "cancelled", operatorDecision: "rejected" });
    expect(task.status).toBe("rejected");
  });

  it("withdraws an in-progress work order and reopens its task", async () => {
    const current = workOrder({ status: "in_progress" });
    const task = { _id: taskId, status: "in_progress", save: vi.fn().mockResolvedValue(undefined) } as any;
    mocks.workOrderById.mockReturnValueOnce(sessionValue(current));
    mocks.taskById.mockReturnValueOnce(sessionValue(task));
    const reason = "A regulated conflict was found after the evidence review began and must be declared immediately.";

    await expect(withdrawWorkOrder(professionalUser, workOrderId, { reason })).resolves.toMatchObject({ status: "withdrawn" });
    expect(task.status).toBe("open");
    expect(mocks.notification).toHaveBeenCalledWith(professionalUser, expect.objectContaining({ action: "WorkOrderWithdrawn" }), expect.anything());
  });

  it("escalates overdue active work orders", async () => {
    const overdue = workOrder({ dueAt: new Date("2026-01-01"), status: "in_progress" });
    mocks.workOrderFind.mockReturnValueOnce(sortedLimitedSessionValue([overdue]));

    await expect(escalateOverdueWorkOrders(operator, { limit: 10 } as any)).resolves.toMatchObject({ escalatedCount: 1, workOrders: [expect.objectContaining({ id: workOrderId, status: "in_progress" })] });
    expect(overdue.slaBreachedAt).toBeInstanceOf(Date);
    expect(mocks.eventCreate).toHaveBeenCalledWith([expect.objectContaining({ eventType: "SlaBreached" })], expect.any(Object));
  });

  it("lists events, returns an invoice, and uploads active deliverables in scope", async () => {
    mocks.workOrderById.mockReturnValueOnce(leanValue(workOrder({ status: "accepted" })));
    mocks.eventFind.mockReturnValueOnce({ sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ eventType: "Assigned" }]) })) });
    await expect(listWorkOrderEvents(professionalUser, workOrderId)).resolves.toEqual([{ eventType: "Assigned" }]);

    mocks.workOrderById.mockReturnValueOnce(leanValue(workOrder()));
    mocks.invoiceFind.mockReturnValueOnce(leanValue({ _id: "invoice-1", status: "pending" }));
    await expect(getWorkOrderInvoice(professionalUser, workOrderId)).resolves.toEqual({ _id: "invoice-1", status: "pending" });

    mocks.workOrderById.mockReturnValueOnce(leanValue(workOrder({ status: "needs_info" })));
    mocks.binary.mockResolvedValueOnce({ storageKey: "work-orders/work-order-1/evidence.pdf", sha256: "a".repeat(64), bytes: 3 });
    await expect(uploadWorkOrderDeliverable(professionalUser, workOrderId, { filename: "evidence.pdf", mimeType: "application/pdf", contentBase64: "cGRm" } as any)).resolves.toMatchObject({ bytes: 3 });
  });

  it("scores a completed work order and updates the professional average", async () => {
    const current = workOrder({ status: "completed" });
    const professional: any = { qualityScoreCount: 2, qualityScoreAvg: 4, save: vi.fn().mockResolvedValue(undefined) };
    mocks.workOrderById.mockReturnValueOnce(sessionValue(current));
    mocks.professionalById.mockReturnValueOnce(sessionValue(professional));

    await expect(scoreWorkOrder(operator, workOrderId, { score: 5, review: "Excellent work." })).resolves.toMatchObject({ qualityScore: 5 });
    expect(professional.qualityScoreCount).toBe(3);
    expect(professional.qualityScoreAvg).toBe(4.33);
  });

  it("returns an empty result for an empty bulk assignment command", async () => {
    await expect(bulkAssignTasks(operator, { assignments: [] } as any)).resolves.toEqual({ succeeded: 0, failed: [] });
  });
});
