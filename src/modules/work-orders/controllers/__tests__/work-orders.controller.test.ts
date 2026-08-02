import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCommandId: vi.fn(), idempotent: vi.fn(), authorize: vi.fn(), serialize: vi.fn((value: unknown) => value), retrieve: vi.fn(),
  assignTask: vi.fn(), list: vi.fn(), escalate: vi.fn(), get: vi.fn(), accept: vi.fn(), decline: vi.fn(), start: vi.fn(), requestInfo: vi.fn(), submit: vi.fn(), startReview: vi.fn(), review: vi.fn(), events: vi.fn(), score: vi.fn(), invoice: vi.fn(), withdraw: vi.fn(), bulkAssign: vi.fn(), upload: vi.fn(),
}));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.readCommandId, runIdempotentCommand: mocks.idempotent }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../services/storage.js", () => ({ retrieveFile: mocks.retrieve }));
vi.mock("../../services/work-orders.service.js", () => ({ assignTaskWorkOrder: mocks.assignTask, listWorkOrders: mocks.list, escalateOverdueWorkOrders: mocks.escalate, getWorkOrder: mocks.get, acceptWorkOrder: mocks.accept, declineWorkOrder: mocks.decline, startWorkOrder: mocks.start, requestWorkOrderInfo: mocks.requestInfo, submitWorkOrderOutcome: mocks.submit, startWorkOrderReview: mocks.startReview, reviewWorkOrder: mocks.review, listWorkOrderEvents: mocks.events, scoreWorkOrder: mocks.score, getWorkOrderInvoice: mocks.invoice, withdrawWorkOrder: mocks.withdraw, bulkAssignTasks: mocks.bulkAssign, uploadWorkOrderDeliverable: mocks.upload }));

import { createWorkOrderController } from "../work-orders.controller.js";

const user = { userId: "professional-1", role: "professional" } as never;
const request = (input: Record<string, unknown> = {}) => ({ authUser: user, headers: {}, params: { id: "work-1" }, body: undefined, query: {}, ...input }) as never;
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.serialize.mockImplementation((value: unknown) => value); mocks.readCommandId.mockReturnValue("command-1");
  mocks.idempotent.mockImplementation(async ({ execute }: { execute: () => Promise<unknown> }) => execute());
});

describe("work-order controller", () => {
  it("lists and reads scoped work orders after authorization", async () => {
    const controller = createWorkOrderController();
    mocks.list.mockResolvedValue({ data: [{ id: "work-1" }] }); mocks.get.mockResolvedValue({ workOrder: { id: "work-1" } });
    await expect(controller.list(request({ query: { status: "assigned", limit: 10 } }))).resolves.toEqual({ data: [{ id: "work-1" }] });
    await expect(controller.getById(request())).resolves.toEqual({ workOrder: { id: "work-1" } });
    expect(mocks.authorize).toHaveBeenNthCalledWith(1, user, "read", "work_order");
    expect(mocks.list).toHaveBeenCalledWith(user, expect.objectContaining({ status: "assigned", limit: 10 }));
    expect(mocks.get).toHaveBeenCalledWith(user, "work-1");
  });

  it("uses idempotency for task assignment and review requests", async () => {
    const controller = createWorkOrderController();
    mocks.assignTask.mockResolvedValue({ id: "work-1" }); mocks.requestInfo.mockResolvedValue({ id: "work-1", status: "needs_info" });
    await expect(controller.assignTask(request({ params: { id: "task-1" }, body: { professionalId: "professional-1", assigneeUserId: "professional-1", priority: "high", instructions: "Review all legal evidence.", dueAt: "2026-09-01" } }))).resolves.toEqual({ id: "work-1" });
    await expect(controller.requestInfo(request({ body: { title: "More evidence", message: "Upload the signed report.", required: true, dueAt: "2026-09-01" } }))).resolves.toEqual({ id: "work-1", status: "needs_info" });
    expect(mocks.idempotent).toHaveBeenNthCalledWith(1, expect.objectContaining({ route: "POST:/v1/tasks/:id/assign", commandId: "command-1" }));
    expect(mocks.idempotent).toHaveBeenNthCalledWith(2, expect.objectContaining({ route: "POST:/v1/work-orders/:id/request-info" }));
  });

  it("accepts an optional conflict declaration and delegates lifecycle actions", async () => {
    const controller = createWorkOrderController();
    mocks.accept.mockResolvedValue({ status: "accepted" }); mocks.start.mockResolvedValue({ status: "in_progress" }); mocks.events.mockResolvedValue([]); mocks.invoice.mockResolvedValue(null);
    await expect(controller.accept(request())).resolves.toEqual({ status: "accepted" });
    await expect(controller.start(request())).resolves.toEqual({ status: "in_progress" });
    await expect(controller.events(request())).resolves.toEqual([]);
    await expect(controller.getInvoice(request())).resolves.toBeNull();
    expect(mocks.accept).toHaveBeenCalledWith(user, "work-1", undefined);
    expect(mocks.start).toHaveBeenCalledWith(user, "work-1");
  });

  it("returns safe deliverable download responses and follows storage redirects", async () => {
    const controller = createWorkOrderController();
    const reply = { status: vi.fn(function (this: object) { return this; }), send: vi.fn(), redirect: vi.fn(), header: vi.fn(function (this: object) { return this; }) };
    mocks.get.mockResolvedValueOnce({ workOrder: { outcome: { deliverables: [] } } });
    await controller.downloadDeliverable(request({ params: { id: "work-1", deliverableIndex: "0" } }), reply);
    expect(reply.status).toHaveBeenCalledWith(404);

    mocks.get.mockResolvedValueOnce({ workOrder: { outcome: { deliverables: [{ storageKey: "private/report.pdf", filename: 'report".pdf', mimeType: "application/pdf" }] } } });
    mocks.retrieve.mockResolvedValueOnce({ redirectUrl: "https://storage.example/report" });
    await controller.downloadDeliverable(request({ params: { id: "work-1", deliverableIndex: "0" } }), reply);
    expect(reply.redirect).toHaveBeenCalledWith(302, "https://storage.example/report");

    mocks.get.mockResolvedValueOnce({ workOrder: { outcome: { deliverables: [{ storageKey: "private/report.pdf", filename: 'report".pdf', mimeType: "application/pdf" }] } } });
    mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("report") });
    await controller.downloadDeliverable(request({ params: { id: "work-1", deliverableIndex: "0" } }), reply);
    expect(reply.header).toHaveBeenCalledWith("Content-Disposition", 'attachment; filename="report.pdf"');
    expect(reply.send).toHaveBeenLastCalledWith(Buffer.from("report"));
  });
});
