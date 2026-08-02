import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applicationCount: vi.fn(),
  applicationFind: vi.fn(),
  applicationFindById: vi.fn(),
  decisionUpsert: vi.fn(),
  event: vi.fn(),
  itemCount: vi.fn(),
  itemCreate: vi.fn(),
  itemFind: vi.fn(),
  itemFindById: vi.fn(),
  notification: vi.fn(),
  offeringCount: vi.fn(),
  professionalFindById: vi.fn(),
  roundCount: vi.fn(),
  roundCreate: vi.fn(),
  roundFind: vi.fn(),
  roundFindById: vi.fn(),
  roundFindOne: vi.fn(),
  taskCreate: vi.fn(),
  taskFind: vi.fn(),
  taskFindById: vi.fn(),
  transaction: vi.fn(),
  transition: vi.fn(),
  workOrderFind: vi.fn(),
  issuerScope: vi.fn(),
}));

vi.mock("../../../../db/models.js", () => ({
  ApplicationDecisionModel: { findOneAndUpdate: mocks.decisionUpsert },
  ApplicationModel: {
    countDocuments: mocks.applicationCount,
    find: mocks.applicationFind,
    findById: mocks.applicationFindById,
  },
  ApplicationReviewItemModel: {
    countDocuments: mocks.itemCount,
    create: mocks.itemCreate,
    find: mocks.itemFind,
    findById: mocks.itemFindById,
  },
  ApplicationReviewRoundModel: {
    countDocuments: mocks.roundCount,
    create: mocks.roundCreate,
    find: mocks.roundFind,
    findById: mocks.roundFindById,
    findOne: mocks.roundFindOne,
  },
  AssetModel: {},
  BusinessModel: {},
  DossierModel: {},
  OfferingModel: { countDocuments: mocks.offeringCount },
  ProfessionalModel: { findById: mocks.professionalFindById },
  ProfessionalWorkOrderModel: { find: mocks.workOrderFind },
  TaskModel: {
    create: mocks.taskCreate,
    find: mocks.taskFind,
    findById: mocks.taskFindById,
  },
  TemplateModel: {},
  UserModel: {},
}));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.event }));
vi.mock("../../../../utils/state-machine.js", () => ({ assertTransition: mocks.transition }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.issuerScope }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../services/storage.js", () => ({ persistDossierBinary: vi.fn() }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notification }));

import {
  approveApplication,
  closeApplicationReviewRound,
  createApplicationReviewRound,
  getApplication,
  listApplicationReviewItems,
  listApplicationReviewRounds,
  listApplicationTasks,
  listApplications,
  markApplicationNeedsInfo,
  rejectApplication,
  requestApplicationService,
  respondToReviewItem,
  resubmitApplication,
  reviewApplicationItemResponse,
  startApplicationReview,
  submitApplication,
  updateTaskStatus,
  withdrawApplication,
} from "../applications.service.js";

const issuer = { userId: "issuer-1", role: "issuer", businessId: "business-1" } as any;
const operator = { userId: "operator-1", role: "operator" } as any;

function query(value: unknown) {
  const result: any = {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn(),
    select: vi.fn(),
    session: vi.fn().mockResolvedValue(value),
    skip: vi.fn(),
    sort: vi.fn(),
  };
  result.limit.mockReturnValue(result);
  result.select.mockReturnValue(result);
  result.skip.mockReturnValue(result);
  result.sort.mockReturnValue(result);
  return result;
}

function document(overrides: Record<string, unknown> = {}) {
  const value: any = {
    _id: "application-1",
    businessId: "business-1",
    checklistState: [],
    stage: "Intake",
    status: "draft",
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(function (this: any) {
      return { _id: this._id, businessId: this.businessId, stage: this.stage, status: this.status };
    }),
    ...overrides,
  };
  return value;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.transaction.mockImplementation(async (work: (session: unknown) => unknown) => work({ id: "session-1" }));
  mocks.transition.mockReturnValue(undefined);
  mocks.issuerScope.mockReturnValue(undefined);
  mocks.event.mockResolvedValue(undefined);
  mocks.notification.mockResolvedValue(undefined);
  mocks.itemCount.mockReturnValue(query(0));
  mocks.roundCount.mockReturnValue(query(0));
  mocks.offeringCount.mockResolvedValue(0);
  mocks.workOrderFind.mockReturnValue(query([]));
  mocks.roundFindOne.mockReturnValue(query(null));
});

describe("application service reads and issuer actions", () => {
  it("filters and pages issuer applications", async () => {
    mocks.applicationFind.mockReturnValue(query([{ _id: "application-1" }]));
    mocks.applicationCount.mockResolvedValue(3);

    await expect(listApplications(issuer, { status: "draft", page: 2, limit: 2 } as any)).resolves.toMatchObject({ total: 3, page: 2, limit: 2, pages: 2 });
    expect(mocks.applicationFind).toHaveBeenCalledWith({ businessId: "business-1", status: "draft" });
  });

  it("reads an application, its tasks, review rounds, and review items within issuer scope", async () => {
    mocks.applicationFindById.mockReturnValue(query(document()));
    mocks.taskFind.mockReturnValue(query([{ _id: "task-1" }]));
    mocks.roundFind.mockReturnValue(query([{ _id: "round-1" }]));
    mocks.itemFind.mockReturnValue(query([{ _id: "item-1" }]));

    await expect(getApplication(issuer, "application-1")).resolves.toMatchObject({ _id: "application-1" });
    await expect(listApplicationTasks(issuer, "application-1")).resolves.toEqual([{ _id: "task-1" }]);
    await expect(listApplicationReviewRounds(issuer, "application-1")).resolves.toEqual([{ _id: "round-1" }]);
    await expect(listApplicationReviewItems(issuer, "application-1", { roundId: "round-1", status: "open" } as any)).resolves.toEqual([{ _id: "item-1" }]);
    expect(mocks.itemFind).toHaveBeenCalledWith({ applicationId: "application-1", roundId: "round-1", status: "open" });
    expect(mocks.issuerScope).toHaveBeenCalled();
  });

  it("submits a complete intake application and records the event", async () => {
    const application = document({ checklistState: [{ stage: "Intake", required: true, status: "provided" }] });
    mocks.applicationFindById.mockReturnValue(query(application));

    await expect(submitApplication(issuer, "application-1")).resolves.toMatchObject({ status: "submitted", stage: "Diligence" });
    expect(application.save).toHaveBeenCalledWith({ session: { id: "session-1" } });
    expect(mocks.event).toHaveBeenCalledWith(issuer, expect.objectContaining({ action: "ApplicationSubmitted" }), { id: "session-1" });
  });

  it("creates a professional task and advances an intake application", async () => {
    const application = document();
    mocks.applicationFindById.mockReturnValue(query(application));
    mocks.professionalFindById.mockReturnValue(query({ _id: "professional-1", name: "Ada", category: "valuer", status: "active", slaDays: 5 }));
    mocks.taskCreate.mockResolvedValue([document({ _id: "task-1" })]);

    await expect(requestApplicationService(issuer, "application-1", { professionalId: "professional-1", stage: "Diligence" } as any)).resolves.toMatchObject({ _id: "task-1" });
    expect(mocks.taskCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ category: "valuation", status: "open" })]), expect.any(Object));
    expect(application.stage).toBe("Diligence");
  });

  it("updates a task and checks the issuer application scope", async () => {
    const task = document({ _id: "task-1", applicationId: "application-1", status: "open" });
    mocks.taskFindById.mockResolvedValue(task);
    mocks.applicationFindById.mockReturnValue(query(document()));

    await expect(updateTaskStatus(issuer, "task-1", { status: "completed" } as any)).resolves.toMatchObject({ status: "completed" });
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(mocks.issuerScope).toHaveBeenCalled();
  });

  it("resubmits only when required review items are resolved", async () => {
    const application = document({ status: "needs_info" });
    mocks.applicationFindById.mockResolvedValue(application);
    mocks.roundFind.mockReturnValue(query([{ _id: "round-1" }]));
    mocks.itemCount.mockResolvedValue(0);

    await expect(resubmitApplication(issuer, "application-1")).resolves.toMatchObject({ status: "submitted" });
    expect(application.save).toHaveBeenCalled();
  });

  it("blocks an issuer withdrawal when an active offering exists", async () => {
    mocks.applicationFindById.mockResolvedValue(document({ status: "approved" }));
    mocks.offeringCount.mockResolvedValue(1);

    await expect(withdrawApplication(issuer, "application-1")).rejects.toThrow("active offerings");
  });
});

describe("application service review lifecycle", () => {
  it("moves an application into review or needs-information state and notifies the issuer", async () => {
    const reviewApplication = document({ status: "submitted" });
    mocks.applicationFindById.mockResolvedValue(reviewApplication);
    await expect(startApplicationReview(operator, "application-1")).resolves.toMatchObject({ status: "in_review", stage: "Diligence" });

    const needsInfoApplication = document({ status: "in_review", stage: "Diligence" });
    mocks.applicationFindById.mockResolvedValue(needsInfoApplication);
    await expect(markApplicationNeedsInfo(operator, "application-1")).resolves.toMatchObject({ status: "needs_info" });
    expect(mocks.notification).toHaveBeenCalledTimes(2);
  });

  it("opens a review round and creates its requested items", async () => {
    const application = document({ status: "submitted" });
    mocks.applicationFindById.mockReturnValue(query(application));
    mocks.roundCreate.mockResolvedValue([document({ _id: "round-1", roundNumber: 1, status: "open" })]);
    mocks.itemCreate.mockResolvedValue([document({ _id: "item-1", status: "open" })]);

    await expect(createApplicationReviewRound(operator, "application-1", {
      stageTag: "Diligence",
      summary: "Need valuation evidence.",
      items: [{ itemType: "checklist", itemKey: "valuation", title: "Valuation", required: true, requestMessage: "Upload report." }],
    } as any)).resolves.toMatchObject({ round: { _id: "round-1" }, items: [{ _id: "item-1" }] });
    expect(application.status).toBe("needs_info");
    expect(mocks.itemCreate).toHaveBeenCalled();
  });

  it("records an issuer response and updates the linked checklist item", async () => {
    const item = document({ _id: "item-1", applicationId: "application-1", roundId: "round-1", itemType: "checklist", itemKey: "valuation", status: "open" });
    const application = document({ checklistState: [{ key: "valuation", status: "missing" }] });
    mocks.itemFindById.mockReturnValue(query(item));
    mocks.applicationFindById.mockReturnValue(query(application));
    mocks.roundFindById.mockReturnValue(query({ _id: "round-1", status: "open" }));

    await expect(respondToReviewItem(issuer, "item-1", { responseMessage: "The report is uploaded." } as any)).resolves.toMatchObject({ status: "responded" });
    expect(application.checklistState[0].status).toBe("provided");
  });

  it("verifies a task review item and completes its linked task", async () => {
    const item = document({ _id: "item-1", applicationId: "application-1", itemType: "task", itemKey: "task-1", status: "responded" });
    const task = document({ _id: "task-1", applicationId: "application-1", status: "open" });
    mocks.itemFindById.mockReturnValue(query(item));
    mocks.applicationFindById.mockReturnValue(query(document()));
    mocks.taskFindById.mockReturnValue(query(task));

    await expect(reviewApplicationItemResponse(operator, "item-1", { status: "verified", reviewNotes: "Evidence checks out." } as any)).resolves.toMatchObject({ status: "verified" });
    expect(task.status).toBe("completed");
  });

  it("closes a resolved review round", async () => {
    const round = document({ _id: "round-1", applicationId: "application-1", roundNumber: 2, status: "open" });
    mocks.roundFindById.mockReturnValue(query(round));
    mocks.itemCount.mockReturnValue(query(0));
    mocks.applicationFindById.mockReturnValue(query(document({ status: "in_review" })));

    await expect(closeApplicationReviewRound(operator, "round-1")).resolves.toMatchObject({ status: "closed" });
    expect(round.closedBy).toBe("operator-1");
  });
});

describe("application service decisions", () => {
  it("approves a complete application and saves a decision", async () => {
    const application = document({ status: "in_review" });
    mocks.applicationFindById.mockReturnValue(query(application));
    mocks.roundCount.mockReturnValue(query(0));
    mocks.itemCount.mockReturnValue(query(0));
    mocks.taskFind.mockReturnValue(query([document({ _id: "task-1", status: "completed", category: "legal", evidenceDocs: [] })]));
    mocks.workOrderFind.mockReturnValue(query([]));

    await expect(approveApplication(operator, "application-1", { reasonCode: "APPROVED", notes: "All requirements met." } as any)).resolves.toMatchObject({ status: "approved", stage: "Compliance" });
    expect(mocks.decisionUpsert).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ decision: "approved" }), expect.any(Object));
    expect(mocks.notification).toHaveBeenCalled();
  });

  it("rejects an application and stores the rejection decision", async () => {
    const application = document({ status: "in_review" });
    mocks.applicationFindById.mockReturnValue(query(application));

    await expect(rejectApplication(operator, "application-1", { reasonCode: "RISK", notes: "Evidence is not sufficient." } as any)).resolves.toMatchObject({ status: "rejected" });
    expect(mocks.decisionUpsert).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ decision: "rejected" }), expect.any(Object));
  });
});
