import type { AuthUser } from "../../../types.js";
import {
  ApplicationDecisionModel,
  ApplicationModel,
  ApplicationReviewItemModel,
  ApplicationReviewRoundModel,
  AssetModel,
  BusinessModel,
  DossierModel,
  OfferingModel,
  ProfessionalModel,
  ProfessionalWorkOrderModel,
  TaskModel,
  TemplateModel,
  UserModel,
} from "../../../db/models.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError, assert } from "../../../utils/errors.js";
import { assertTransition } from "../../../utils/state-machine.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { runInTransaction } from "../../../utils/tx.js";
import { persistDossierBinary } from "../../../services/storage.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import type {
  CreateApplicationPayload,
  CreateAndSubmitApplicationPayload,
  CreateReviewRoundPayload,
  DecisionPayload,
  ListApplicationsQuery,
  ListReviewItemsQuery,
  RequestServicePayload,
  RespondReviewItemPayload,
  TaskStatusPayload,
  VerifyReviewItemPayload,
} from "../schemas/applications.schemas.js";

function mapProfessionalCategory(
  category: string,
): "inspection" | "valuation" | "legal" | "servicing" {
  if (category === "inspector") return "inspection";
  if (category === "valuer") return "valuation";
  if (category === "lawyer" || category === "trustee") return "legal";
  return "servicing";
}

function ensureReviewerRole(authUser: AuthUser): void {
  if (!["operator", "admin"].includes(authUser.role)) {
    throw new HttpError(403, "Operator or admin role required");
  }
}

function parseOptionalDate(value?: string): Date | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(422, `Invalid date: ${value}`);
  }
  return date;
}

function sanitizeFilenameSegment(name: string): string {
  return name.replace(/[^a-z0-9.\-_]+/gi, "-").toLowerCase();
}

function toObject<T>(doc: T): T {
  if (doc && typeof doc === "object" && "toObject" in (doc as any)) {
    return (doc as any).toObject();
  }
  return doc;
}

async function resolveIssuerBusinessId(authUser: AuthUser): Promise<string | null> {
  const issuerUser = await UserModel.findById(authUser.userId)
    .select("businessId")
    .lean();
  const issuerBusinessId = issuerUser?.businessId
    ? String(issuerUser.businessId)
    : authUser.businessId;
  return issuerBusinessId ?? null;
}

async function findApplicationForReadScope(
  authUser: AuthUser,
  applicationId: string,
) {
  const application = await ApplicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "Application not found");
  assertIssuerBusinessScope(
    authUser,
    application.businessId ? String(application.businessId) : undefined,
  );
  return application;
}

async function ensureNoUnresolvedRequiredReviewItems(
  applicationId: string,
  session?: any,
): Promise<void> {
  const unresolvedCount = await ApplicationReviewItemModel.countDocuments({
    applicationId,
    required: true,
    status: { $ne: "verified" },
  }).session(session ?? null);

  if (unresolvedCount > 0) {
    throw new HttpError(
      422,
      "Cannot approve application: review items still unresolved",
    );
  }
}

export async function createAndSubmitApplication(
  authUser: AuthUser,
  payload: CreateAndSubmitApplicationPayload,
) {
  if (authUser.role !== "issuer") {
    throw new HttpError(403, "Issuer role required");
  }

  const template = await TemplateModel.findOne({
    code: payload.templateCode,
    enabled: true,
  }).lean();
  if (!template) throw new HttpError(404, "Template not found or disabled");

  const issuerBusinessId = await resolveIssuerBusinessId(authUser);
  if (!issuerBusinessId) {
    throw new HttpError(
      422,
      "Issuer business registration is required before creating an application",
    );
  }

  const issuerBusiness = await BusinessModel.findById(issuerBusinessId).lean();
  if (!issuerBusiness) throw new HttpError(404, "Issuer business not found");
  if (issuerBusiness.kybStatus !== "approved") {
    throw new HttpError(
      422,
      "Business KYB must be approved before creating applications",
    );
  }

  return runInTransaction(async (session) => {
    let assetId = payload.assetId;
    if (!assetId) {
      assert(
        payload.asset,
        422,
        "Asset details required when assetId is not supplied",
      );

      const valuation = payload.asset.valuation
        ? {
            amount: payload.asset.valuation.amount,
            currency: payload.asset.valuation.currency ?? "NGN",
            valuationDate: payload.asset.valuation.valuationDate
              ? new Date(payload.asset.valuation.valuationDate)
              : undefined,
            validUntil: payload.asset.valuation.validUntil
              ? new Date(payload.asset.valuation.validUntil)
              : undefined,
            valuedBy: payload.asset.valuation.valuedBy,
            reportDocumentRef: payload.asset.valuation.reportDocumentRef,
            methodology: payload.asset.valuation.methodology,
          }
        : undefined;

      const [asset] = await AssetModel.create(
        [
          {
            businessId: issuerBusinessId,
            type: "real_estate",
            name: payload.asset.name,
            location: {
              country: payload.asset.country,
              state: payload.asset.state,
              city: payload.asset.city,
              addressLine: payload.asset.addressLine,
            },
            summary: payload.asset.summary,
            legalTitle: payload.asset.legalTitle,
            ...(valuation && { valuation }),
          },
        ],
        { session },
      );
      assetId = String(asset._id);
    }

    const checklistState =
      payload.checklistState ??
      template.checklistItems.map((item: any) => ({
        key: item.key,
        label: item.label,
        stage: item.requiredStage,
        required: true,
        status: "missing" as const,
      }));

    const [application] = await ApplicationModel.create(
      [
        {
          businessId: issuerBusinessId,
          templateCode: payload.templateCode,
          assetId,
          stage: "Intake",
          status: "draft",
          checklistState,
          milestones: payload.milestones?.map((milestone) => ({
            ...milestone,
            targetDate: new Date(milestone.targetDate),
          })),
          createdBy: authUser.userId,
        },
      ],
      { session },
    );

    const [dossier] = await DossierModel.create(
      [
        {
          applicationId: application._id,
          structuredData: {},
          documents: [],
          hashes: [],
        },
      ],
      { session },
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationCreated",
      },
      session,
    );

    for (const document of payload.dossierDocuments ?? []) {
      let storageKey =
        document.storageKey ??
        `manual://dossiers/${application._id.toString()}/${Date.now()}-${sanitizeFilenameSegment(document.filename)}`;

      if (document.contentBase64) {
        const persisted = await persistDossierBinary({
          applicationId: String(application._id),
          filename: document.filename,
          contentBase64: document.contentBase64,
          mimeType: document.mimeType,
        });
        storageKey = persisted.storageKey;
        dossier.hashes.push({
          algo: "sha256",
          hash: persisted.sha256,
          createdAt: new Date(),
        } as any);
      }

      dossier.documents.push({
        type: document.type,
        filename: document.filename,
        mimeType: document.mimeType,
        storageKey,
        uploadedBy: authUser.userId as any,
        uploadedAt: new Date(),
        stageTag: document.stageTag,
      } as any);

      application.checklistState = application.checklistState.map((item: any) => {
        const labelMatch = item.label.toLowerCase() === document.type.toLowerCase();
        const keyMatch = item.key.toLowerCase() === document.type.toLowerCase();
        if ((labelMatch || keyMatch) && item.status === "missing") {
          return { ...item, status: "provided" as const };
        }
        return item;
      }) as any;

      await appendEvent(
        authUser,
        {
          entityType: "application",
          entityId: String(application._id),
          action: "Dossier document uploaded",
          notes: `${document.type}: ${document.filename}`,
        },
        session,
      );
    }

    const minimumDocsSatisfied = application.checklistState
      .filter((item: any) => item.stage === "Intake" && item.required)
      .every((item: any) => item.status !== "missing");

    assertTransition("application", application.status as any, "submitted", {
      minimumDocsSatisfied,
    });
    application.status = "submitted";
    application.submittedAt = new Date();
    application.stage = "Diligence";

    const createdTasks: any[] = [];
    for (const request of payload.requestedServices ?? []) {
      const professional = await ProfessionalModel.findById(request.professionalId).session(
        session,
      );
      if (!professional || professional.status !== "active") {
        throw new HttpError(404, "Professional not available");
      }

      const category = mapProfessionalCategory(professional.category);
      const [task] = await TaskModel.create(
        [
          {
            applicationId: application._id,
            stage: request.stage,
            category,
            assignedProfessionalId: professional._id,
            assignedAt: new Date(),
            status: "open",
            slaDays: professional.slaDays,
            evidenceDocs: [],
          },
        ],
        { session },
      );
      createdTasks.push(task);

      await appendEvent(
        authUser,
        {
          entityType: "task",
          entityId: String(task._id),
          action: "ApplicationTaskRequested",
          notes: `${professional.name} (${professional.category})`,
        },
        session,
      );
    }

    await application.save({ session });
    await dossier.save({ session });

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationSubmitted",
      },
      session,
    );

    return {
      application: toObject(application),
      tasks: createdTasks.map((task) => toObject(task)),
    };
  });
}

export async function createApplication(
  authUser: AuthUser,
  payload: CreateApplicationPayload,
) {
  if (authUser.role !== "issuer") {
    throw new HttpError(403, "Issuer role required");
  }

  const template = await TemplateModel.findOne({
    code: payload.templateCode,
    enabled: true,
  }).lean();
  if (!template) throw new HttpError(404, "Template not found or disabled");

  const issuerBusinessId = await resolveIssuerBusinessId(authUser);
  if (!issuerBusinessId) {
    throw new HttpError(
      422,
      "Issuer business registration is required before creating an application",
    );
  }

  const issuerBusiness = await BusinessModel.findById(issuerBusinessId).lean();
  if (!issuerBusiness) throw new HttpError(404, "Issuer business not found");
  if (issuerBusiness.kybStatus !== "approved") {
    throw new HttpError(
      422,
      "Business KYB must be approved before creating applications",
    );
  }

  // 2.2: Move rate-limit + cooldown checks inside transaction to prevent race conditions
  return runInTransaction(async (session) => {
    // I-75: Rate limiting — max 5 active applications per business
    const MAX_ACTIVE_APPLICATIONS = 5;
    const activeApplicationCount = await ApplicationModel.countDocuments({
      businessId: issuerBusinessId,
      status: { $in: ["draft", "submitted", "in_review", "needs_info"] },
    }).session(session);
    if (activeApplicationCount >= MAX_ACTIVE_APPLICATIONS) {
      throw new HttpError(
        429,
        `You already have ${activeApplicationCount} active applications. Withdraw or wait for existing applications to resolve before creating new ones (max ${MAX_ACTIVE_APPLICATIONS} active).`,
      );
    }

    // I-75: 7-day cooldown after rejection with the same template code
    const REJECTION_COOLDOWN_DAYS = 7;
    const cooldownStart = new Date(Date.now() - REJECTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    const recentRejection = await ApplicationModel.findOne({
      businessId: issuerBusinessId,
      templateCode: payload.templateCode,
      status: "rejected",
      updatedAt: { $gte: cooldownStart },
    })
      .select("_id updatedAt")
      .session(session)
      .lean();
    if (recentRejection) {
      const eligibleAt = new Date((recentRejection as any).updatedAt.getTime() + REJECTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
      throw new HttpError(
        429,
        `A Template ${payload.templateCode} application was recently rejected. You may reapply after ${eligibleAt.toLocaleDateString("en-NG")}.`,
      );
    }
    let assetId = payload.assetId;
    if (!assetId) {
      assert(
        payload.asset,
        422,
        "Asset details required when assetId is not supplied",
      );

      const valuation = payload.asset.valuation
        ? {
            amount: payload.asset.valuation.amount,
            currency: payload.asset.valuation.currency ?? "NGN",
            valuationDate: payload.asset.valuation.valuationDate
              ? new Date(payload.asset.valuation.valuationDate)
              : undefined,
            validUntil: payload.asset.valuation.validUntil
              ? new Date(payload.asset.valuation.validUntil)
              : undefined,
            valuedBy: payload.asset.valuation.valuedBy,
            reportDocumentRef: payload.asset.valuation.reportDocumentRef,
            methodology: payload.asset.valuation.methodology,
          }
        : undefined;

      const [asset] = await AssetModel.create(
        [
          {
            businessId: issuerBusinessId,
            type: "real_estate",
            name: payload.asset.name,
            location: {
              country: payload.asset.country,
              state: payload.asset.state,
              city: payload.asset.city,
              addressLine: payload.asset.addressLine,
            },
            summary: payload.asset.summary,
            legalTitle: payload.asset.legalTitle,
            ...(valuation && { valuation }),
          },
        ],
        { session },
      );
      assetId = String(asset._id);
    }

    const checklistState =
      payload.checklistState ??
      template.checklistItems.map((item: any) => ({
        key: item.key,
        label: item.label,
        stage: item.requiredStage,
        required: true,
        status: "missing" as const,
      }));

    const [application] = await ApplicationModel.create(
      [
        {
          businessId: issuerBusinessId,
          templateCode: payload.templateCode,
          assetId,
          stage: "Intake",
          status: "draft",
          checklistState,
          milestones: payload.milestones?.map((milestone) => ({
            ...milestone,
            targetDate: new Date(milestone.targetDate),
          })),
          createdBy: authUser.userId,
        },
      ],
      { session },
    );

    await DossierModel.create(
      [
        {
          applicationId: application._id,
          structuredData: {},
          documents: [],
          hashes: [],
        },
      ],
      { session },
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationCreated",
      },
      session,
    );

    return toObject(application);
  });
}

export async function listApplications(
  authUser: AuthUser,
  query: ListApplicationsQuery,
) {
  const filter: Record<string, unknown> = {};
  if (authUser.role === "issuer") filter.businessId = authUser.businessId;
  if (query.status) filter.status = query.status;
  if (query.templateCode) filter.templateCode = query.templateCode;
  if (query.stage) filter.stage = query.stage;

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    ApplicationModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ApplicationModel.countDocuments(filter),
  ]);

  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getApplication(
  authUser: AuthUser,
  applicationId: string,
) {
  const application = await ApplicationModel.findById(applicationId).lean();
  if (!application) throw new HttpError(404, "Application not found");
  assertIssuerBusinessScope(
    authUser,
    application.businessId ? String(application.businessId) : undefined,
  );
  return application;
}

export async function listApplicationTasks(
  authUser: AuthUser,
  applicationId: string,
) {
  const application = await ApplicationModel.findById(applicationId).lean();
  if (!application) throw new HttpError(404, "Application not found");
  assertIssuerBusinessScope(
    authUser,
    application.businessId ? String(application.businessId) : undefined,
  );

  return TaskModel.find({ applicationId: application._id })
    .sort({ createdAt: 1 })
    .lean();
}

export async function submitApplication(authUser: AuthUser, applicationId: string) {
  return runInTransaction(async (session) => {
    const application = await ApplicationModel.findById(applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");
    assertIssuerBusinessScope(
      authUser,
      application.businessId ? String(application.businessId) : undefined,
    );

    const minimumDocsSatisfied = application.checklistState
      .filter((item: any) => item.stage === "Intake" && item.required)
      .every((item: any) => item.status !== "missing");

    assertTransition("application", application.status as any, "submitted", {
      minimumDocsSatisfied,
    });

    application.status = "submitted";
    application.submittedAt = new Date();
    application.stage = "Diligence";
    await application.save({ session });

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationSubmitted",
      },
      session,
    );

    return toObject(application);
  });
}

export async function requestApplicationService(
  authUser: AuthUser,
  applicationId: string,
  payload: RequestServicePayload,
) {
  return runInTransaction(async (session) => {
    const application = await ApplicationModel.findById(applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");
    assertIssuerBusinessScope(
      authUser,
      application.businessId ? String(application.businessId) : undefined,
    );

    const professional = await ProfessionalModel.findById(payload.professionalId).session(session);
    if (!professional || professional.status !== "active") {
      throw new HttpError(404, "Professional not available");
    }

    const category = mapProfessionalCategory(professional.category);

    const [task] = await TaskModel.create(
      [
        {
          applicationId: application._id,
          stage: payload.stage,
          category,
          assignedProfessionalId: professional._id,
          assignedAt: new Date(),
          status: "open",
          slaDays: professional.slaDays,
          evidenceDocs: [],
        },
      ],
      { session },
    );

    if (application.stage === "Intake") application.stage = payload.stage;
    await application.save({ session });

    await appendEvent(
      authUser,
      {
        entityType: "task",
        entityId: String(task._id),
        action: "ApplicationTaskRequested",
        notes: `${professional.name} (${professional.category})`,
      },
      session,
    );

    return toObject(task);
  });
}

export async function updateTaskStatus(
  authUser: AuthUser,
  taskId: string,
  payload: TaskStatusPayload,
) {
  const task = await TaskModel.findById(taskId);
  if (!task) throw new HttpError(404, "Task not found");

  if (authUser.role === "issuer") {
    const appRecord = await ApplicationModel.findById(task.applicationId).lean();
    assertIssuerBusinessScope(
      authUser,
      appRecord?.businessId ? String(appRecord.businessId) : undefined,
    );
  }

  task.status = payload.status;
  if (payload.status === "completed") task.completedAt = new Date();
  await task.save();

  await appendEvent(authUser, {
    entityType: "task",
    entityId: String(task._id),
    action: "ApplicationTaskStatusUpdated",
    notes: payload.status,
  });

  return toObject(task);
}

export async function startApplicationReview(authUser: AuthUser, applicationId: string) {
  ensureReviewerRole(authUser);
  const application = await ApplicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "Application not found");

  assertTransition("application", application.status as any, "in_review");
  application.status = "in_review";
  if (application.stage === "Intake") application.stage = "Diligence";
  await application.save();

  await appendEvent(authUser, {
    entityType: "application",
    entityId: String(application._id),
    action: "ApplicationReviewStarted",
  });

  await createNotificationsFromEvent(authUser, {
    entityType: "application",
    entityId: String(application._id),
    action: "ApplicationReviewStarted",
    notes: "Your application is now under review.",
  });

  return toObject(application);
}

export async function markApplicationNeedsInfo(
  authUser: AuthUser,
  applicationId: string,
) {
  ensureReviewerRole(authUser);
  const application = await ApplicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "Application not found");

  assertTransition("application", application.status as any, "needs_info");
  application.status = "needs_info";
  await application.save();

  await appendEvent(authUser, {
    entityType: "application",
    entityId: String(application._id),
    action: "ApplicationNeedsInfo",
  });

  await createNotificationsFromEvent(authUser, {
    entityType: "application",
    entityId: String(application._id),
    action: "ApplicationNeedsInfo",
    notes: "Additional information is required for your application.",
  });

  return toObject(application);
}

export async function resubmitApplication(authUser: AuthUser, applicationId: string) {
  if (authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

  const application = await ApplicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "Application not found");
  assertIssuerBusinessScope(
    authUser,
    application.businessId ? String(application.businessId) : undefined,
  );

  const openRounds = await ApplicationReviewRoundModel.find({
    applicationId: application._id,
    status: "open",
  })
    .select("_id")
    .lean();

  if (openRounds.length > 0) {
    const openRoundIds = openRounds.map((round: any) => round._id);
    const unresolvedCount = await ApplicationReviewItemModel.countDocuments({
      roundId: { $in: openRoundIds },
      required: true,
      status: { $in: ["open", "rejected"] },
    });
    if (unresolvedCount > 0) {
      throw new HttpError(
        422,
        "Cannot resubmit while required review items remain unresolved",
      );
    }
  }

  assertTransition("application", application.status as any, "submitted");
  application.status = "submitted";
  await application.save();

  await appendEvent(authUser, {
    entityType: "application",
    entityId: String(application._id),
    action: "ApplicationSubmitted",
    notes: "resubmission",
  });

  return toObject(application);
}

export async function approveApplication(
  authUser: AuthUser,
  applicationId: string,
  payload: DecisionPayload,
) {
  return runInTransaction(async (session) => {
    const application = await ApplicationModel.findById(applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");

    const openReviewRoundCount = await ApplicationReviewRoundModel.countDocuments({
      applicationId: application._id,
      status: "open",
    }).session(session ?? null);
    if (openReviewRoundCount > 0) {
      throw new HttpError(
        422,
        "Cannot approve application while review rounds are still open",
      );
    }

    await ensureNoUnresolvedRequiredReviewItems(String(application._id), session);

    const tasks = await TaskModel.find({ applicationId: application._id }).session(session);
    const allWorkOrders = await ProfessionalWorkOrderModel.find({
      applicationId: application._id,
    })
      .select("taskId status outcome.deliverables")
      .session(session ?? null);
    const completedWorkOrders = allWorkOrders.filter(
      (workOrder: any) => workOrder.status === "completed",
    );

    const completedTaskIdsFromWorkOrders = new Set(
      completedWorkOrders.map((workOrder: any) => String(workOrder.taskId)),
    );
    const taskIdsWithAnyWorkOrder = new Set(
      allWorkOrders.map((workOrder: any) => String(workOrder.taskId)),
    );

    const evidenceByTaskId = new Map<string, number>();
    for (const workOrder of completedWorkOrders as any[]) {
      const taskId = String(workOrder.taskId);
      const existing = evidenceByTaskId.get(taskId) ?? 0;
      const deliverableCount = Array.isArray(workOrder.outcome?.deliverables)
        ? workOrder.outcome.deliverables.length
        : 0;
      evidenceByTaskId.set(taskId, existing + deliverableCount);
    }

    const tasksComplete = tasks.every((task: any) => {
      const taskId = String(task._id);
      return task.status === "completed" || completedTaskIdsFromWorkOrders.has(taskId);
    });

    const evidenceVerified = tasks.every((task: any) => {
      const taskId = String(task._id);
      const isCompleted =
        task.status === "completed" || completedTaskIdsFromWorkOrders.has(taskId);
      if (!isCompleted) return true;

      const hasTaskEvidence =
        Array.isArray(task.evidenceDocs) && task.evidenceDocs.length > 0;
      const hasWorkOrderEvidence = (evidenceByTaskId.get(taskId) ?? 0) > 0;
      if (hasTaskEvidence || hasWorkOrderEvidence) return true;

      // Some tasks can be manually completed without generating work-orders.
      // Do not block approval in that case until explicit task evidence upload UI exists.
      const hasAnyWorkOrder = taskIdsWithAnyWorkOrder.has(taskId);
      return !hasAnyWorkOrder;
    });

    const requiredCategories = new Set(
      tasks
        .map((task: any) => String(task.category))
        .filter((category: string) => category !== "servicing"),
    );
    const completedCategories = new Set(
      tasks
        .filter((task: any) => {
          const taskId = String(task._id);
          return (
            task.status === "completed" ||
            completedTaskIdsFromWorkOrders.has(taskId)
          );
        })
        .map((task: any) => String(task.category)),
    );
    const legalChecklistSatisfied = [...requiredCategories].every((category) =>
      completedCategories.has(category),
    );

    assertTransition("application", application.status as any, "approved", {
      tasksComplete,
      evidenceVerified,
      legalChecklistSatisfied,
    });

    application.status = "approved";
    application.stage = "Compliance";
    application.approvedAt = new Date();
    await application.save({ session });

    const latestRound = await ApplicationReviewRoundModel.findOne({
      applicationId: application._id,
    })
      .sort({ roundNumber: -1 })
      .session(session ?? null);

    await ApplicationDecisionModel.findOneAndUpdate(
      { applicationId: application._id },
      {
        applicationId: application._id,
        reviewRoundId: latestRound?._id,
        decision: "approved",
        reasonCode: payload.reasonCode,
        notes: payload.notes,
        decidedBy: authUser.userId,
        decidedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationApproved",
        notes: payload.notes ?? payload.reasonCode,
      },
      session,
    );

    await createNotificationsFromEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationApproved",
        notes: payload.notes ?? "Your application has been approved.",
      },
      session,
    );

    return toObject(application);
  });
}

export async function rejectApplication(
  authUser: AuthUser,
  applicationId: string,
  payload: DecisionPayload,
) {
  return runInTransaction(async (session) => {
    const application = await ApplicationModel.findById(applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");

    assertTransition("application", application.status as any, "rejected");
    application.status = "rejected";
    application.rejectedAt = new Date();
    await application.save({ session });

    const latestRound = await ApplicationReviewRoundModel.findOne({
      applicationId: application._id,
    })
      .sort({ roundNumber: -1 })
      .session(session ?? null);

    await ApplicationDecisionModel.findOneAndUpdate(
      { applicationId: application._id },
      {
        applicationId: application._id,
        reviewRoundId: latestRound?._id,
        decision: "rejected",
        reasonCode: payload.reasonCode,
        notes: payload.notes,
        decidedBy: authUser.userId,
        decidedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationRejected",
        notes: payload.notes ?? payload.reasonCode,
      },
      session,
    );

    await createNotificationsFromEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationRejected",
        notes: payload.notes ?? "Your application has been rejected.",
      },
      session,
    );

    return toObject(application);
  });
}

export async function withdrawApplication(
  authUser: AuthUser,
  applicationId: string,
  reason?: string,
) {
  const application = await ApplicationModel.findById(applicationId);
  if (!application) throw new HttpError(404, "Application not found");
  assertIssuerBusinessScope(
    authUser,
    application.businessId ? String(application.businessId) : undefined,
  );

  // P1-BIZ-04: Block withdrawal if the application has active (non-draft/cancelled) offerings
  const activeOfferingCount = await OfferingModel.countDocuments({
    applicationId: application._id,
    status: { $nin: ["draft", "cancelled", "closed", "failed"] },
  });
  if (activeOfferingCount > 0) {
    throw new HttpError(
      422,
      "Cannot withdraw application with active offerings",
    );
  }

  assertTransition("application", application.status as any, "withdrawn");
  application.status = "withdrawn";
  application.withdrawnAt = new Date();
  await application.save();

  await appendEvent(authUser, {
    entityType: "application",
    entityId: String(application._id),
    action: "ApplicationWithdrawn",
    notes: reason,
  });

  return toObject(application);
}

export async function listApplicationReviewRounds(
  authUser: AuthUser,
  applicationId: string,
) {
  await findApplicationForReadScope(authUser, applicationId);
  return ApplicationReviewRoundModel.find({ applicationId })
    .sort({ roundNumber: -1, createdAt: -1 })
    .lean();
}

export async function listApplicationReviewItems(
  authUser: AuthUser,
  applicationId: string,
  query: ListReviewItemsQuery,
) {
  await findApplicationForReadScope(authUser, applicationId);
  const filter: Record<string, unknown> = { applicationId };
  if (query.roundId) filter.roundId = query.roundId;
  if (query.status) filter.status = query.status;
  return ApplicationReviewItemModel.find(filter).sort({ createdAt: -1 }).lean();
}

export async function createApplicationReviewRound(
  authUser: AuthUser,
  applicationId: string,
  payload: CreateReviewRoundPayload,
) {
  ensureReviewerRole(authUser);

  return runInTransaction(async (session) => {
    const application = await ApplicationModel.findById(applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");

    if (application.status === "submitted") {
      assertTransition("application", application.status as any, "in_review");
      application.status = "in_review";
    }
    if (application.status !== "in_review") {
      throw new HttpError(
        409,
        "Review round can only be opened when application is in review",
      );
    }

    const previousRound = await ApplicationReviewRoundModel.findOne({
      applicationId: application._id,
    })
      .sort({ roundNumber: -1 })
      .session(session ?? null);
    const roundNumber = previousRound ? Number(previousRound.roundNumber) + 1 : 1;

    const [round] = await ApplicationReviewRoundModel.create(
      [
        {
          applicationId: application._id,
          roundNumber,
          status: "open",
          stageTag: payload.stageTag,
          summary: payload.summary,
          dueAt: parseOptionalDate(payload.dueAt),
          openedBy: authUser.userId,
          openedAt: new Date(),
        },
      ],
      { session },
    );

    const items = await ApplicationReviewItemModel.create(
      payload.items.map((item) => ({
        applicationId: application._id,
        roundId: round._id,
        itemType: item.itemType,
        itemKey: item.itemKey,
        title: item.title,
        stageTag: item.stageTag ?? payload.stageTag,
        required: item.required,
        requestMessage: item.requestMessage,
        status: "open",
        requestedBy: authUser.userId,
        requestedAt: new Date(),
      })),
      { session },
    );

    assertTransition("application", application.status as any, "needs_info");
    application.status = "needs_info";
    if (payload.stageTag) application.stage = payload.stageTag;
    await application.save({ session });

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationReviewRoundOpened",
        notes: `round=${roundNumber}; items=${items.length}`,
      },
      session,
    );

    return {
      round: toObject(round),
      items: (items as any[]).map((item: any) => toObject(item)),
    };
  });
}

export async function respondToReviewItem(
  authUser: AuthUser,
  reviewItemId: string,
  payload: RespondReviewItemPayload,
) {
  if (authUser.role !== "issuer") {
    throw new HttpError(403, "Issuer role required");
  }

  return runInTransaction(async (session) => {
    const item = await ApplicationReviewItemModel.findById(reviewItemId).session(session);
    if (!item) throw new HttpError(404, "Review item not found");

    const application = await ApplicationModel.findById(item.applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");
    assertIssuerBusinessScope(
      authUser,
      application.businessId ? String(application.businessId) : undefined,
    );

    const round = await ApplicationReviewRoundModel.findById(item.roundId).session(session);
    if (!round || round.status !== "open") {
      throw new HttpError(409, "Review round is not open");
    }
    if (item.status === "verified") {
      throw new HttpError(409, "Review item already verified");
    }

    item.status = "responded";
    item.responseMessage = payload.responseMessage;
    item.responseMeta = payload.responseMeta ?? {};
    item.respondedBy = authUser.userId;
    item.respondedAt = new Date();
    await item.save({ session });

    if (item.itemType === "checklist") {
      const checklistEntry = application.checklistState.find(
        (entry: any) => entry.key === item.itemKey,
      );
      if (checklistEntry && checklistEntry.status === "missing") {
        checklistEntry.status = "provided";
        await application.save({ session });
      }
    }

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationReviewItemResponded",
        notes: `${item.itemType}:${item.itemKey}`,
      },
      session,
    );

    return toObject(item);
  });
}

export async function reviewApplicationItemResponse(
  authUser: AuthUser,
  reviewItemId: string,
  payload: VerifyReviewItemPayload,
) {
  ensureReviewerRole(authUser);

  return runInTransaction(async (session) => {
    const item = await ApplicationReviewItemModel.findById(reviewItemId).session(session);
    if (!item) throw new HttpError(404, "Review item not found");

    const application = await ApplicationModel.findById(item.applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");

    const nextStatus = payload.status;
    item.status = nextStatus;
    item.reviewNotes = payload.reviewNotes;
    item.verifiedBy = authUser.userId;
    item.verifiedAt = new Date();
    await item.save({ session });

    if (item.itemType === "checklist") {
      const checklistEntry = application.checklistState.find(
        (entry: any) => entry.key === item.itemKey,
      );
      if (checklistEntry) {
        checklistEntry.status = nextStatus === "verified" ? "verified" : "missing";
        await application.save({ session });
      }
    }

    if (item.itemType === "task") {
      const linkedTask = await TaskModel.findById(item.itemKey).session(session);
      if (
        linkedTask &&
        String(linkedTask.applicationId) === String(application._id)
      ) {
        linkedTask.status = nextStatus === "verified" ? "completed" : "open";
        linkedTask.completedAt = nextStatus === "verified" ? new Date() : undefined;
        await linkedTask.save({ session });
      }
    }

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationReviewItemReviewed",
        notes: `${nextStatus}:${item.itemType}:${item.itemKey}`,
      },
      session,
    );

    return toObject(item);
  });
}

export async function closeApplicationReviewRound(
  authUser: AuthUser,
  reviewRoundId: string,
) {
  ensureReviewerRole(authUser);

  return runInTransaction(async (session) => {
    const round = await ApplicationReviewRoundModel.findById(reviewRoundId).session(session);
    if (!round) throw new HttpError(404, "Review round not found");
    if (round.status !== "open") {
      throw new HttpError(409, "Review round is not open");
    }

    const unresolvedCount = await ApplicationReviewItemModel.countDocuments({
      roundId: round._id,
      required: true,
      status: { $ne: "verified" },
    }).session(session ?? null);

    if (unresolvedCount > 0) {
      throw new HttpError(
        422,
        "Cannot close review round while required items are unresolved",
      );
    }

    round.status = "closed";
    round.closedBy = authUser.userId;
    round.closedAt = new Date();
    await round.save({ session });

    const application = await ApplicationModel.findById(round.applicationId).session(session);
    if (!application) throw new HttpError(404, "Application not found");
    if (application.status === "submitted") {
      assertTransition("application", application.status as any, "in_review");
      application.status = "in_review";
      await application.save({ session });
    }

    await appendEvent(
      authUser,
      {
        entityType: "application",
        entityId: String(application._id),
        action: "ApplicationReviewRoundClosed",
        notes: `round=${round.roundNumber}`,
      },
      session,
    );

    return toObject(round);
  });
}
