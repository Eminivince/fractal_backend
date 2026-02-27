import type mongoose from "mongoose";
import {
  ApplicationModel,
  ApplicationReviewItemModel,
  ApplicationReviewRoundModel,
  ProfessionalInvoiceModel,
  ProfessionalModel,
  ProfessionalWorkOrderEventModel,
  ProfessionalWorkOrderModel,
  TaskModel,
  UserModel,
} from "../../../db/models.js";
import type { AuthUser } from "../../../types.js";
import { persistWorkOrderBinary } from "../../../services/storage.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { assertTransition } from "../../../utils/state-machine.js";
import { runInTransaction } from "../../../utils/tx.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { toDecimal } from "../../../utils/decimal.js";
import type {
  AcceptWorkOrderPayload,
  AssignTaskWorkOrderPayload,
  BulkAssignTasksPayload,
  DeclineWorkOrderPayload,
  EscalateOverdueWorkOrdersPayload,
  ListWorkOrdersQuery,
  RequestWorkOrderInfoPayload,
  ReviewWorkOrderPayload,
  SubmitWorkOrderOutcomePayload,
  UploadDeliverablePayload,
} from "../schemas/work-orders.schemas.js";
import { env } from "../../../config/env.js";

const ACTIVE_WORK_ORDER_STATUSES = [
  "assigned",
  "accepted",
  "in_progress",
  "needs_info",
  "submitted",
  "under_review",
] as const;

function toObject<T>(doc: T): T {
  if (doc && typeof doc === "object" && "toObject" in (doc as any)) {
    return (doc as any).toObject();
  }
  return doc;
}

function parseOptionalDate(value?: string): Date | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `Invalid date: ${value}`);
  }
  return parsed;
}

function mapTaskCategory(category: string):
  | "legal"
  | "valuation"
  | "inspection"
  | "trustee"
  | "servicing" {
  if (category === "inspection") return "inspection";
  if (category === "valuation") return "valuation";
  if (category === "legal") return "legal";
  if (category === "trustee") return "trustee";
  return "servicing";
}

function ensureOperatorOrAdmin(authUser: AuthUser): void {
  if (!["operator", "admin"].includes(authUser.role)) {
    throw new HttpError(403, "Operator or admin role required");
  }
}

function ensureProfessionalRole(authUser: AuthUser): void {
  if (authUser.role !== "professional") {
    throw new HttpError(403, "Professional role required");
  }
}

function assertWorkOrderScope(authUser: AuthUser, workOrder: any): void {
  if (["admin", "operator"].includes(authUser.role)) return;

  if (authUser.role === "professional") {
    if (String(workOrder.assigneeUserId) !== String(authUser.userId)) {
      throw new HttpError(403, "Professional out of work order scope");
    }
    return;
  }

  if (authUser.role === "issuer") {
    assertIssuerBusinessScope(authUser, String(workOrder.businessId));
    return;
  }

  throw new HttpError(403, "Out of scope");
}

async function appendWorkOrderEvent(
  authUser: AuthUser,
  input: {
    workOrderId: string;
    eventType: string;
    payload?: Record<string, unknown>;
  },
  session?: mongoose.ClientSession,
) {
  await ProfessionalWorkOrderEventModel.create(
    [
      {
        workOrderId: input.workOrderId,
        actorUserId: authUser.userId,
        actorRole: authUser.role,
        eventType: input.eventType,
        payload: input.payload ?? {},
      },
    ],
    { session },
  );
}

async function loadWorkOrderOrFail(workOrderId: string, session?: mongoose.ClientSession) {
  const workOrder = await ProfessionalWorkOrderModel.findById(workOrderId).session(
    session ?? null,
  );
  if (!workOrder) throw new HttpError(404, "Work order not found");
  return workOrder;
}

function canStartWorkOrder(status: string): boolean {
  return status === "accepted" || status === "needs_info" || status === "in_progress";
}

export async function assignTaskWorkOrder(
  authUser: AuthUser,
  taskId: string,
  payload: AssignTaskWorkOrderPayload,
) {
  ensureOperatorOrAdmin(authUser);

  return runInTransaction(async (session) => {
    const task = await TaskModel.findById(taskId).session(session ?? null);
    if (!task) throw new HttpError(404, "Task not found");

    const application = await ApplicationModel.findById(task.applicationId).session(
      session ?? null,
    );
    if (!application) throw new HttpError(404, "Application not found");

    const professional = await ProfessionalModel.findById(
      payload.professionalId,
    ).session(session ?? null);
    if (!professional || professional.status !== "active") {
      throw new HttpError(404, "Professional not available");
    }
    if (professional.onboardingStatus !== "approved") {
      throw new HttpError(422, "Professional onboarding is not approved");
    }
    // PR-02: License expiry enforcement
    if (professional.licenseMeta?.expiresAt) {
      const now = new Date();
      if (professional.licenseMeta.expiresAt <= now) {
        const expiredDate = professional.licenseMeta.expiresAt.toISOString().slice(0, 10);
        throw new HttpError(422, `Professional's license expired on ${expiredDate} — please assign another professional`);
      }
    }
    // PR-10: Capacity management
    if (professional.availabilityStatus === "unavailable") {
      throw new HttpError(422, "Professional is currently unavailable for new assignments");
    }
    const maxConcurrent = professional.maxConcurrentWorkOrders ?? 5;
    const activeCount = await ProfessionalWorkOrderModel.countDocuments({
      professionalId: professional._id,
      status: { $in: ACTIVE_WORK_ORDER_STATUSES },
    }).session(session ?? null);
    if (activeCount >= maxConcurrent) {
      throw new HttpError(422, `Professional has reached their maximum concurrent work orders (${maxConcurrent}). Please assign another professional or wait for existing work orders to complete.`);
    }

    const assignee = await UserModel.findById(payload.assigneeUserId)
      .select("_id role status professionalId")
      .session(session ?? null);
    if (!assignee || assignee.status !== "active") {
      throw new HttpError(404, "Assignee user not found or disabled");
    }
    if (assignee.role !== "professional") {
      throw new HttpError(422, "Assignee must be a professional user");
    }
    if (!assignee.professionalId) {
      throw new HttpError(
        422,
        "Assignee user must be linked to a professional profile",
      );
    }
    if (String(assignee.professionalId) !== String(professional._id)) {
      throw new HttpError(422, "Assignee user is linked to a different professional profile");
    }

    const existingActive = await ProfessionalWorkOrderModel.findOne({
      taskId: task._id,
      assigneeUserId: assignee._id,
      status: { $in: ACTIVE_WORK_ORDER_STATUSES },
    }).session(session ?? null);
    if (existingActive) {
      throw new HttpError(409, "An active work order already exists for this assignee and task");
    }

    // PR-38: Prevent duplicate category work orders for same application
    const taskCategory = mapTaskCategory(task.category);
    const existingCategoryActive = await ProfessionalWorkOrderModel.findOne({
      applicationId: application._id,
      category: taskCategory,
      status: { $in: ACTIVE_WORK_ORDER_STATUSES },
    }).session(session ?? null);
    if (existingCategoryActive) {
      throw new HttpError(409, `An active ${taskCategory} work order already exists for this application`);
    }

    // PR-31: Check professional's COI exclusion list
    const businessIdStr = String(application.businessId);
    const excludedIds = (professional.excludedBusinessIds ?? []).map((id: any) => String(id));
    if (excludedIds.includes(businessIdStr)) {
      throw new HttpError(422, "Professional has a registered conflict of interest with this issuer and cannot be assigned");
    }

    task.assignedProfessionalId = professional._id;
    task.assignedAt = new Date();
    await task.save({ session });

    const [workOrder] = await ProfessionalWorkOrderModel.create(
      [
        {
          applicationId: application._id,
          taskId: task._id,
          businessId: application.businessId,
          professionalId: professional._id,
          assigneeUserId: assignee._id,
          category: taskCategory,
          status: "assigned",
          priority: payload.priority,
          instructions: payload.instructions,
          dueAt: parseOptionalDate(payload.dueAt),
          stageTag: task.stage,
          createdBy: authUser.userId,
        },
      ],
      { session },
    );

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId: String(workOrder._id),
        eventType: "Assigned",
        payload: {
          taskId: String(task._id),
          professionalId: String(professional._id),
          assigneeUserId: String(assignee._id),
        },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: String(workOrder._id),
        action: "WorkOrderAssigned",
        notes: `${professional.name} -> ${String(assignee._id)}`,
      },
      session,
    );

    // PR-25: Enrich assignment notification with work order details
    const instrPreview = workOrder.instructions
      ? workOrder.instructions.slice(0, 300)
      : "No instructions provided";
    const dueStr = workOrder.dueAt
      ? `Due: ${workOrder.dueAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
      : "Due date: not set";
    const workOrderLink = env.APP_BASE_URL
      ? `${env.APP_BASE_URL}/professional/work-orders/${String(workOrder._id)}`
      : "";
    const assignmentNotes = [
      `You have been assigned a new ${taskCategory} work order.`,
      `\nInstructions: ${instrPreview}`,
      `\n${dueStr}`,
      workOrderLink ? `\nView work order: ${workOrderLink}` : "",
    ]
      .filter(Boolean)
      .join("");

    await createNotificationsFromEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: String(workOrder._id),
        action: "WorkOrderAssigned",
        notes: assignmentNotes,
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "task",
        entityId: String(task._id),
        action: "WorkOrderAssigned",
        notes: `${professional.name} -> ${String(assignee._id)}`,
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function listWorkOrders(authUser: AuthUser, query: ListWorkOrdersQuery) {
  const filter: Record<string, unknown> = {};

  if (authUser.role === "professional") {
    filter.assigneeUserId = authUser.userId;
  }

  if (authUser.role === "issuer") {
    if (!authUser.businessId) return { data: [], total: 0, page: 1, limit: query.limit, pages: 0 };
    filter.businessId = authUser.businessId;
  }

  if (query.status) filter.status = query.status;
  if (query.applicationId) filter.applicationId = query.applicationId;
  if (query.taskId) filter.taskId = query.taskId;
  if (query.professionalId) filter.professionalId = query.professionalId;
  if ((query as any).category) filter.category = (query as any).category;
  if (query.assigneeUserId && authUser.role !== "professional") {
    filter.assigneeUserId = query.assigneeUserId;
  }
  if (query.dueBefore) {
    filter.dueAt = { $lte: parseOptionalDate(query.dueBefore) };
  }

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    ProfessionalWorkOrderModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ProfessionalWorkOrderModel.countDocuments(filter),
  ]);

  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getWorkOrder(authUser: AuthUser, workOrderId: string) {
  const workOrder = await ProfessionalWorkOrderModel.findById(workOrderId).lean();
  if (!workOrder) throw new HttpError(404, "Work order not found");
  assertWorkOrderScope(authUser, workOrder);

  const events = await ProfessionalWorkOrderEventModel.find({
    workOrderId: workOrder._id,
  })
    .sort({ createdAt: -1 })
    .lean();

  const linkedReviewItems =
    Array.isArray(workOrder.linkedReviewItemIds) && workOrder.linkedReviewItemIds.length
      ? await ApplicationReviewItemModel.find({
          _id: { $in: workOrder.linkedReviewItemIds },
        })
          .sort({ createdAt: -1 })
          .lean()
      : [];

  return {
    workOrder,
    events,
    linkedReviewItems,
  };
}

export async function acceptWorkOrder(
  authUser: AuthUser,
  workOrderId: string,
  payload?: AcceptWorkOrderPayload,
) {
  ensureProfessionalRole(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (workOrder.status !== "assigned") {
      throw new HttpError(409, "Only assigned work orders can be accepted");
    }

    const now = new Date();

    // PR-03: If professional declares a conflict, flag instead of accepting
    if (payload && !payload.coiDeclaredClear) {
      workOrder.status = "conflict_flagged";
      workOrder.coiDeclaredAt = now;
      workOrder.coiDeclaration = "conflict";
      if (payload.coiNotes) workOrder.coiNotes = payload.coiNotes;
      await workOrder.save({ session });

      await appendWorkOrderEvent(
        authUser,
        {
          workOrderId,
          eventType: "ConflictFlagged",
          payload: { coiNotes: payload.coiNotes },
        },
        session,
      );

      await appendEvent(
        authUser,
        {
          entityType: "work_order",
          entityId: workOrderId,
          action: "WorkOrderConflictFlagged",
          notes: payload.coiNotes ?? "Professional declared a conflict of interest",
        },
        session,
      );

      await createNotificationsFromEvent(
        authUser,
        {
          entityType: "work_order",
          entityId: workOrderId,
          action: "WorkOrderConflictFlagged",
          notes: `Professional has declared a conflict of interest for work order ${workOrderId}. Reassignment required.`,
        },
        session,
      );

      return toObject(workOrder);
    }

    // COI clear — store declaration and accept
    workOrder.status = "accepted";
    workOrder.acceptedAt = now;
    if (payload?.coiDeclaredClear) {
      workOrder.coiDeclaredAt = now;
      workOrder.coiDeclaration = "clear";
    }
    await workOrder.save({ session });

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "Accepted",
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderAccepted",
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function declineWorkOrder(
  authUser: AuthUser,
  workOrderId: string,
  payload: DeclineWorkOrderPayload,
) {
  ensureProfessionalRole(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (!["assigned", "accepted"].includes(workOrder.status)) {
      throw new HttpError(409, "Only assigned/accepted work orders can be declined");
    }

    workOrder.status = "declined";
    workOrder.declineReason = payload.reason;
    await workOrder.save({ session });

    const task = await TaskModel.findById(workOrder.taskId).session(session ?? null);
    if (task && task.status === "in_progress") {
      task.status = "open";
      await task.save({ session });
    }

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "Declined",
        payload: { reason: payload.reason },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderDeclined",
        notes: payload.reason,
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "task",
        entityId: String(workOrder.taskId),
        action: "WorkOrderDeclined",
        notes: payload.reason,
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function startWorkOrder(authUser: AuthUser, workOrderId: string) {
  ensureProfessionalRole(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (!canStartWorkOrder(workOrder.status)) {
      throw new HttpError(409, "Work order cannot be started from current status");
    }

    workOrder.status = "in_progress";
    if (!workOrder.startedAt) workOrder.startedAt = new Date();
    await workOrder.save({ session });

    const task = await TaskModel.findById(workOrder.taskId).session(session ?? null);
    if (task && task.status === "open") {
      task.status = "in_progress";
      await task.save({ session });
    }

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "Started",
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderStarted",
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function requestWorkOrderInfo(
  authUser: AuthUser,
  workOrderId: string,
  payload: RequestWorkOrderInfoPayload,
) {
  if (!["professional", "operator", "admin"].includes(authUser.role)) {
    throw new HttpError(403, "Professional, operator, or admin role required");
  }

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    if (authUser.role === "professional") {
      assertWorkOrderScope(authUser, workOrder);
    }

    if (!["accepted", "in_progress", "needs_info"].includes(workOrder.status)) {
      throw new HttpError(409, "Work order must be active to request information");
    }

    const application = await ApplicationModel.findById(workOrder.applicationId).session(
      session ?? null,
    );
    if (!application) throw new HttpError(404, "Application not found");

    const task = await TaskModel.findById(workOrder.taskId).session(session ?? null);
    if (!task) throw new HttpError(404, "Task not found");

    let round = await ApplicationReviewRoundModel.findOne({
      applicationId: application._id,
      status: "open",
    })
      .sort({ roundNumber: -1, createdAt: -1 })
      .session(session ?? null);

    if (!round) {
      const previousRound = await ApplicationReviewRoundModel.findOne({
        applicationId: application._id,
      })
        .sort({ roundNumber: -1 })
        .session(session ?? null);

      const nextRoundNumber = previousRound
        ? Number(previousRound.roundNumber) + 1
        : 1;

      const [createdRound] = await ApplicationReviewRoundModel.create(
        [
          {
            applicationId: application._id,
            roundNumber: nextRoundNumber,
            status: "open",
            stageTag: payload.stageTag ?? workOrder.stageTag ?? application.stage,
            summary: `Professional request for task ${String(task._id)}`,
            dueAt: parseOptionalDate(payload.dueAt),
            openedBy: authUser.userId,
            openedAt: new Date(),
          },
        ],
        { session },
      );
      round = createdRound;
    }

    const [reviewItem] = await ApplicationReviewItemModel.create(
      [
        {
          applicationId: application._id,
          roundId: round._id,
          itemType: "task",
          itemKey: String(task._id),
          title: payload.title,
          stageTag: payload.stageTag ?? round.stageTag,
          required: payload.required,
          requestMessage: payload.message,
          status: "open",
          sourceType: "work_order",
          sourceId: workOrder._id,
          sourceMeta: {
            workOrderId: String(workOrder._id),
            category: workOrder.category,
            professionalId: String(workOrder.professionalId),
          },
          requestedBy: authUser.userId,
          requestedAt: new Date(),
        },
      ],
      { session },
    );

    if (application.status === "submitted") {
      assertTransition("application", application.status as any, "in_review");
      application.status = "in_review";
    }
    if (application.status === "in_review") {
      assertTransition("application", application.status as any, "needs_info");
      application.status = "needs_info";
    }
    await application.save({ session });

    workOrder.status = "needs_info";
    if (!workOrder.startedAt) workOrder.startedAt = new Date();
    workOrder.linkedReviewRoundId = round._id;
    const linkedIds = (workOrder.linkedReviewItemIds ?? []).map((id: any) =>
      String(id),
    );
    if (!linkedIds.includes(String(reviewItem._id))) {
      workOrder.linkedReviewItemIds = [
        ...(workOrder.linkedReviewItemIds ?? []),
        reviewItem._id,
      ];
    }
    await workOrder.save({ session });

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "RequestedInfo",
        payload: {
          reviewRoundId: String(round._id),
          reviewItemId: String(reviewItem._id),
          required: payload.required,
        },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderRequestedInfo",
        notes: payload.title,
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "WorkOrderRequestedInfo",
        notes: payload.title,
      },
      session,
    );

    return {
      workOrder: toObject(workOrder),
      reviewRound: toObject(round),
      reviewItem: toObject(reviewItem),
    };
  });
}

export async function submitWorkOrderOutcome(
  authUser: AuthUser,
  workOrderId: string,
  payload: SubmitWorkOrderOutcomePayload,
) {
  ensureProfessionalRole(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (!["in_progress", "needs_info"].includes(workOrder.status)) {
      // PR-39: Idempotency — prevent re-submission when already submitted
      if (workOrder.status === "submitted") {
        throw new HttpError(409, "Outcome already submitted. Wait for operator review or address change requests before resubmitting.");
      }
      throw new HttpError(409, "Work order is not in a submittable status");
    }

    const linkedReviewItemIds = (workOrder.linkedReviewItemIds ?? []).map((id: any) =>
      String(id),
    );
    if (linkedReviewItemIds.length > 0) {
      const unresolvedRequiredItems = await ApplicationReviewItemModel.countDocuments(
        {
          _id: { $in: linkedReviewItemIds },
          required: true,
          status: { $ne: "verified" },
        },
      ).session(session ?? null);
      if (unresolvedRequiredItems > 0) {
        throw new HttpError(
          422,
          "Resolve all required linked review items before submitting outcome",
        );
      }
    }

    const normalizedDeliverables: Array<{
      type: string;
      filename: string;
      mimeType?: string;
      storageKey: string;
      uploadedAt: Date;
    }> = [];
    for (const item of payload.deliverables ?? []) {
      let storageKey = item.storageKey?.trim();
      if (item.contentBase64) {
        const persisted = await persistWorkOrderBinary({
          workOrderId: String(workOrder._id),
          filename: item.filename,
          contentBase64: item.contentBase64,
          mimeType: item.mimeType,
        });
        storageKey = persisted.storageKey;
      }

      if (!storageKey || storageKey.length === 0) {
        storageKey = `manual://work-orders/${workOrder._id}/${item.filename}`;
      }

      normalizedDeliverables.push({
        type: item.type,
        filename: item.filename,
        mimeType: item.mimeType,
        storageKey,
        uploadedAt: new Date(),
      });
    }

    // PR-17: Archive previous outcome before overwriting
    if (workOrder.outcome?.recommendation) {
      const prevOutcome = {
        submittedAt: workOrder.submittedAt ?? new Date(),
        submittedBy: authUser.userId,
        recommendation: workOrder.outcome.recommendation,
        summary: workOrder.outcome.summary,
        riskFlags: workOrder.outcome.riskFlags ?? [],
        riskFlagNotes: (workOrder.outcome as any).riskFlagNotes,
        deliverables: workOrder.outcome.deliverables ?? [],
        operatorRejectionNotes: workOrder.operatorNotes,
      };
      workOrder.outcomeHistory = [...(workOrder.outcomeHistory ?? []), prevOutcome] as any;
    }

    workOrder.status = "submitted";
    workOrder.submittedAt = new Date();
    workOrder.outcome = {
      recommendation: payload.recommendation,
      summary: payload.summary,
      riskFlags: payload.riskFlags,
      riskFlagNotes: (payload as any).riskFlagNotes,
      deliverables: normalizedDeliverables,
    } as any;
    await workOrder.save({ session });

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "SubmittedOutcome",
        payload: {
          recommendation: payload.recommendation,
          deliverablesCount: payload.deliverables?.length ?? 0,
        },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderOutcomeSubmitted",
        notes: payload.recommendation,
      },
      session,
    );

    await createNotificationsFromEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderOutcomeSubmitted",
        notes: `Work order outcome submitted with recommendation: ${payload.recommendation}.`,
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(workOrder.applicationId),
        action: "WorkOrderOutcomeSubmitted",
        notes: payload.recommendation,
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function startWorkOrderReview(authUser: AuthUser, workOrderId: string) {
  ensureOperatorOrAdmin(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (workOrder.status !== "submitted") {
      throw new HttpError(409, "Only submitted work orders can enter review");
    }

    workOrder.status = "under_review";
    await workOrder.save({ session });

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "ReviewStarted",
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderReviewStarted",
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function reviewWorkOrder(
  authUser: AuthUser,
  workOrderId: string,
  payload: ReviewWorkOrderPayload,
) {
  ensureOperatorOrAdmin(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (workOrder.status !== "under_review") {
      throw new HttpError(409, "Only work orders under review can be decided");
    }

    const task = await TaskModel.findById(workOrder.taskId).session(session ?? null);
    if (!task) throw new HttpError(404, "Task not found");

    if (payload.decision === "accepted") {
      workOrder.status = "completed";
      workOrder.completedAt = new Date();
      workOrder.operatorDecision = "accepted";
      workOrder.operatorNotes = payload.notes;

      task.status = "completed";
      task.completedAt = new Date();
      const deliverables = Array.isArray(workOrder.outcome?.deliverables)
        ? workOrder.outcome.deliverables
        : [];
      if (deliverables.length > 0) {
        const existingEvidence = Array.isArray(task.evidenceDocs)
          ? task.evidenceDocs
          : [];
        const nextEvidence = [...existingEvidence];
        const existingDocIds = new Set(
          existingEvidence
            .map((doc: any) => String(doc.docId ?? "").trim())
            .filter((value: string) => value.length > 0),
        );

        for (let index = 0; index < deliverables.length; index += 1) {
          const deliverable = deliverables[index] as any;
          const docIdCandidate = String(deliverable.storageKey ?? "").trim();
          const fallbackDocId = `${String(workOrder._id)}:${index + 1}`;
          const docId =
            docIdCandidate.length > 0 ? docIdCandidate : fallbackDocId;
          if (existingDocIds.has(docId)) continue;

          nextEvidence.push({
            docId,
            filename:
              String(deliverable.filename ?? "").trim() ||
              `deliverable-${index + 1}`,
          } as any);
          existingDocIds.add(docId);
        }

        task.evidenceDocs = nextEvidence as any;
      }
      await task.save({ session });

      const professional = await ProfessionalModel.findById(workOrder.professionalId).session(
        session ?? null,
      );
      if (professional?.pricing) {
        const existingInvoice = await ProfessionalInvoiceModel.findOne({
          workOrderId: workOrder._id,
        }).session(session ?? null);
        if (!existingInvoice) {
          // PR-20: Correct percentage pricing computation
          const pricingAmountNum = Number(professional.pricing.amount.toString());
          let computedAmount: number;
          let baseValue: number | undefined;

          if (professional.pricing.model === "pct") {
            // PR-20: Fetch application deal amount as base value for pct pricing
            const appForBase = await ApplicationModel.findById(workOrder.applicationId)
              .select("dealAmount requestedAmount")
              .session(session ?? null) as any;
            baseValue = Number(appForBase?.dealAmount ?? appForBase?.requestedAmount ?? 0);
            const raw = (pricingAmountNum / 100) * baseValue;
            // Round to nearest 100 NGN
            computedAmount = Math.round(raw / 100) * 100;
            // Apply floor/ceiling
            const floor = 50000; // ₦50,000 minimum
            const ceiling = 5000000; // ₦5,000,000 maximum
            computedAmount = Math.max(floor, Math.min(ceiling, computedAmount));
          } else {
            // Flat: round up to nearest ₦1
            computedAmount = Math.ceil(pricingAmountNum);
          }

          // PR-04/PR-24: Compute WHT and VAT
          const whtRate = professional.whtRate ?? (professional.organizationType === "individual" ? 5 : 10);
          const whtAmount = Math.ceil((computedAmount * whtRate) / 100);
          const vatAmount = professional.vatRegistered ? Math.ceil(computedAmount * 0.075) : 0;
          const netPayable = computedAmount + vatAmount - whtAmount;

          await ProfessionalInvoiceModel.create(
            [
              {
                workOrderId: workOrder._id,
                professionalId: professional._id,
                applicationId: workOrder.applicationId,
                pricingModel: professional.pricing.model,
                pricingAmount: professional.pricing.amount,
                baseValue: baseValue != null ? toDecimal(baseValue) : undefined,
                computedAmount: toDecimal(computedAmount),
                vatAmount: toDecimal(vatAmount),
                whtAmount: toDecimal(whtAmount),
                netPayable: toDecimal(netPayable),
                currency: "NGN",
                status: "pending",
              },
            ],
            { session },
          );
        }
      }
    } else if (payload.decision === "needs_changes") {
      workOrder.status = "in_progress";
      workOrder.operatorDecision = "needs_changes";
      workOrder.operatorNotes = payload.notes;

      if (task.status === "completed") {
        task.status = "in_progress";
        task.completedAt = undefined;
        await task.save({ session });
      }
    } else {
      workOrder.status = "cancelled";
      workOrder.operatorDecision = "rejected";
      workOrder.operatorNotes = payload.notes;

      task.status = "rejected";
      task.completedAt = undefined;
      await task.save({ session });
    }

    await workOrder.save({ session });

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "ReviewDecision",
        payload: {
          decision: payload.decision,
          notes: payload.notes,
        },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderReviewed",
        notes: payload.decision,
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(workOrder.applicationId),
        action: "WorkOrderReviewed",
        notes: payload.decision,
      },
      session,
    );

    return toObject(workOrder);
  });
}

// PR-09: Professional withdrawal after starting work
export async function withdrawWorkOrder(
  authUser: AuthUser,
  workOrderId: string,
  payload: { reason: string },
) {
  ensureProfessionalRole(authUser);

  if (!payload.reason || payload.reason.trim().length < 50) {
    throw new HttpError(422, "Withdrawal reason must be at least 50 characters");
  }

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);
    assertWorkOrderScope(authUser, workOrder);

    if (workOrder.status !== "in_progress") {
      throw new HttpError(409, "Only in-progress work orders can be withdrawn");
    }

    workOrder.status = "withdrawn";
    workOrder.withdrawReason = payload.reason.trim();
    workOrder.withdrawnAt = new Date();
    await workOrder.save({ session });

    const task = await TaskModel.findById(workOrder.taskId).session(session ?? null);
    if (task && task.status === "in_progress") {
      task.status = "open";
      await task.save({ session });
    }

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "Withdrawn",
        payload: { reason: payload.reason.trim() },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderWithdrawn",
        notes: payload.reason.trim(),
      },
      session,
    );

    await createNotificationsFromEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderWithdrawn",
        notes: `Work order was withdrawn by professional. Reason: ${payload.reason.trim().slice(0, 200)}`,
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function escalateOverdueWorkOrders(
  authUser: AuthUser,
  payload: EscalateOverdueWorkOrdersPayload,
) {
  ensureOperatorOrAdmin(authUser);
  const now = new Date();

  return runInTransaction(async (session) => {
    const overdueRows = await ProfessionalWorkOrderModel.find({
      status: { $in: ACTIVE_WORK_ORDER_STATUSES },
      dueAt: { $lte: now },
      $or: [{ slaBreachedAt: { $exists: false } }, { slaBreachedAt: null }],
    })
      .sort({ dueAt: 1, createdAt: 1 })
      .limit(payload.limit)
      .session(session ?? null);

    const escalated: Array<Record<string, unknown>> = [];
    for (const workOrder of overdueRows) {
      workOrder.slaBreachedAt = now;
      await workOrder.save({ session });

      await appendWorkOrderEvent(
        authUser,
        {
          workOrderId: String(workOrder._id),
          eventType: "SlaBreached",
          payload: {
            dueAt: workOrder.dueAt ? workOrder.dueAt.toISOString() : undefined,
          },
        },
        session,
      );

      await appendEvent(
        authUser,
        {
          entityType: "work_order",
          entityId: String(workOrder._id),
          action: "WorkOrderSlaBreached",
          notes: workOrder.dueAt
            ? `dueAt=${workOrder.dueAt.toISOString()}`
            : undefined,
        },
        session,
      );

      escalated.push({
        id: String(workOrder._id),
        status: workOrder.status,
        dueAt: workOrder.dueAt,
        slaBreachedAt: workOrder.slaBreachedAt,
      });
    }

    return {
      escalatedCount: escalated.length,
      workOrders: escalated,
    };
  });
}

export async function listWorkOrderEvents(authUser: AuthUser, workOrderId: string) {
  const workOrder = await ProfessionalWorkOrderModel.findById(workOrderId).lean();
  if (!workOrder) throw new HttpError(404, "Work order not found");
  assertWorkOrderScope(authUser, workOrder);

  return ProfessionalWorkOrderEventModel.find({ workOrderId: workOrder._id })
    .sort({ createdAt: -1 })
    .lean();
}

export async function scoreWorkOrder(
  authUser: AuthUser,
  workOrderId: string,
  payload: { score: number; review?: string },
) {
  ensureOperatorOrAdmin(authUser);

  return runInTransaction(async (session) => {
    const workOrder = await loadWorkOrderOrFail(workOrderId, session);

    if (workOrder.status !== "completed") {
      throw new HttpError(409, "Only completed work orders can be scored");
    }
    if (workOrder.scoredAt) {
      throw new HttpError(409, "Work order has already been scored");
    }

    workOrder.qualityScore = payload.score;
    workOrder.qualityReview = payload.review;
    workOrder.scoredBy = authUser.userId as any;
    workOrder.scoredAt = new Date();
    await workOrder.save({ session });

    const professional = await ProfessionalModel.findById(workOrder.professionalId).session(
      session ?? null,
    );
    if (professional) {
      const prevCount = professional.qualityScoreCount ?? 0;
      const prevAvg = professional.qualityScoreAvg ?? 0;
      const newCount = prevCount + 1;
      professional.qualityScoreAvg = Math.round(((prevAvg * prevCount) + payload.score) / newCount * 100) / 100;
      professional.qualityScoreCount = newCount;
      await professional.save({ session });
    }

    await appendWorkOrderEvent(
      authUser,
      {
        workOrderId,
        eventType: "Scored",
        payload: { score: payload.score },
      },
      session,
    );

    await appendEvent(
      authUser,
      {
        entityType: "work_order",
        entityId: workOrderId,
        action: "WorkOrderScored",
        notes: `score=${payload.score}`,
      },
      session,
    );

    return toObject(workOrder);
  });
}

export async function getWorkOrderInvoice(authUser: AuthUser, workOrderId: string) {
  const workOrder = await ProfessionalWorkOrderModel.findById(workOrderId).lean();
  if (!workOrder) throw new HttpError(404, "Work order not found");
  assertWorkOrderScope(authUser, workOrder);

  const invoice = await ProfessionalInvoiceModel.findOne({ workOrderId: workOrder._id }).lean();
  if (!invoice) throw new HttpError(404, "Invoice not found for this work order");
  return invoice;
}

// PR-15: Upload deliverable (separate from outcome submission)
export async function uploadWorkOrderDeliverable(
  authUser: AuthUser,
  workOrderId: string,
  payload: UploadDeliverablePayload,
): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  ensureProfessionalRole(authUser);

  const workOrder = await ProfessionalWorkOrderModel.findById(workOrderId).lean();
  if (!workOrder) throw new HttpError(404, "Work order not found");
  assertWorkOrderScope(authUser, workOrder);

  if (!["accepted", "in_progress", "needs_info"].includes(workOrder.status)) {
    throw new HttpError(409, "Work order must be active to upload deliverables");
  }

  return persistWorkOrderBinary({
    workOrderId,
    filename: payload.filename,
    contentBase64: payload.contentBase64,
    mimeType: payload.mimeType,
  });
}

// PR-47: Bulk task assignment
export async function bulkAssignTasks(
  authUser: AuthUser,
  payload: BulkAssignTasksPayload,
): Promise<{ succeeded: number; failed: Array<{ taskId: string; error: string }> }> {
  ensureOperatorOrAdmin(authUser);

  const succeeded: string[] = [];
  const failed: Array<{ taskId: string; error: string }> = [];

  for (const item of payload.assignments) {
    try {
      await assignTaskWorkOrder(authUser, item.taskId, {
        professionalId: item.professionalId,
        assigneeUserId: item.assigneeUserId,
        instructions: item.instructions,
        dueAt: item.dueAt,
        priority: item.priority,
      });
      succeeded.push(item.taskId);
    } catch (err) {
      failed.push({
        taskId: item.taskId,
        error: err instanceof Error ? err.message : "Assignment failed",
      });
    }
  }

  return { succeeded: succeeded.length, failed };
}
