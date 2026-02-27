import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotificationModel, ProfessionalInvoiceModel, ProfessionalModel, ProfessionalTeamMemberModel, ProfessionalWorkOrderModel, UserModel } from "../../db/models.js";
import { toDecimal } from "../../utils/decimal.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { persistProfessionalBinary } from "../../services/storage.js";
import { sendEmailWithFallback } from "../../services/email.js";

const professionalBody = z.object({
  category: z.enum(["inspector", "valuer", "lawyer", "trustee", "servicer"]),
  name: z.string().min(2),
  regions: z.array(z.string()).min(1),
  slaDays: z.number().int().positive(),
  pricing: z.object({
    model: z.enum(["flat", "pct"]),
    amount: z.number().nonnegative(),
  }),
});

export async function professionalRoutes(app: FastifyInstance) {
  app.get(
    "/v1/professionals",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "professional");
      const query = z
        .object({
          category: z.enum(["inspector", "valuer", "lawyer", "trustee", "servicer"]).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        })
        .parse(request.query);

      const filter: Record<string, string> = {};
      if (query.category) filter.category = query.category;
      if (query.status) filter.status = query.status;

      const rows = await ProfessionalModel.find(filter).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/professionals/marketplace",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "professional");
      const query = z
        .object({
          category: z.enum(["inspector", "valuer", "lawyer", "trustee", "servicer"]).optional(),
          region: z.string().optional(),
          serviceCategory: z
            .enum(["legal", "valuation", "inspection", "trustee", "servicing"])
            .optional(),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {
        onboardingStatus: "approved",
        status: "active",
      };
      if (query.category) filter.category = query.category;
      if (query.region) filter.regions = query.region;
      if (query.serviceCategory) filter.serviceCategories = query.serviceCategory;

      const professionals = await ProfessionalModel.find(filter).lean();
      const professionalIds = professionals.map((p: any) => p._id);

      const ACTIVE_STATUSES = ["assigned", "accepted", "in_progress", "needs_info", "submitted", "under_review"];

      const [completedCounts, activeCounts, lastAssignments] = await Promise.all([
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds }, status: "completed" } },
          { $group: { _id: "$professionalId", count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: unknown; count: number }>>,
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds }, status: { $in: ACTIVE_STATUSES } } },
          { $group: { _id: "$professionalId", count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: unknown; count: number }>>,
        // PR-46: Last assignment date per professional
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds } } },
          { $sort: { createdAt: -1 } },
          { $group: { _id: "$professionalId", lastAssignedAt: { $first: "$createdAt" } } },
        ]) as Promise<Array<{ _id: unknown; lastAssignedAt: Date }>>,
      ]);

      const completedMap = new Map(completedCounts.map((row) => [String(row._id), row.count]));
      const activeMap = new Map(activeCounts.map((row) => [String(row._id), row.count]));
      const lastAssignedMap = new Map(lastAssignments.map((row) => [String(row._id), row.lastAssignedAt]));

      const enriched = professionals.map((p: any) => ({
        ...p,
        completedWorkOrders: completedMap.get(String(p._id)) ?? 0,
        activeWorkOrders: activeMap.get(String(p._id)) ?? 0,
        lastAssignedAt: lastAssignedMap.get(String(p._id)) ?? null,
        availabilityStatus: p.availabilityStatus ?? "available",
        maxConcurrentWorkOrders: p.maxConcurrentWorkOrders ?? 5,
      }));

      return serialize(enriched);
    },
  );

  app.post(
    "/v1/professionals",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "professional");
      const payload = professionalBody.parse(request.body);

      const created = await ProfessionalModel.create({
        ...payload,
        pricing: {
          model: payload.pricing.model,
          amount: toDecimal(payload.pricing.amount),
        },
      });

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(created._id),
        action: "Professional created",
        notes: created.name,
      });

      return serialize(created.toObject());
    },
  );

  app.put(
    "/v1/professionals/:id",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "professional");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = professionalBody.parse(request.body);

      const updated = await ProfessionalModel.findByIdAndUpdate(
        params.id,
        {
          ...payload,
          pricing: {
            model: payload.pricing.model,
            amount: toDecimal(payload.pricing.amount),
          },
        },
        { new: true },
      ).lean();

      if (!updated) throw new HttpError(404, "Professional not found");

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(updated._id),
        action: "Professional updated",
      });

      return serialize(updated);
    },
  );

  app.patch(
    "/v1/professionals/:id/status",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "professional");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ status: z.enum(["active", "disabled"]) }).parse(request.body);

      const updated = await ProfessionalModel.findByIdAndUpdate(
        params.id,
        { status: payload.status },
        { new: true },
      ).lean();

      if (!updated) throw new HttpError(404, "Professional not found");

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(updated._id),
        action: "Professional status changed",
        notes: payload.status,
      });

      return serialize(updated);
    },
  );

  app.get(
    "/v1/professionals/:id/invoices",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "professional");
      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          status: z.enum(["pending", "paid", "cancelled"]).optional(),
          limit: z.coerce.number().int().positive().max(200).default(100),
        })
        .parse(request.query);

      const professional = await ProfessionalModel.findById(params.id).lean();
      if (!professional) throw new HttpError(404, "Professional not found");

      const filter: Record<string, unknown> = { professionalId: params.id };
      if (query.status) filter.status = query.status;

      const invoices = await ProfessionalInvoiceModel.find(filter)
        .sort({ createdAt: -1 })
        .limit(query.limit)
        .lean();

      return serialize(invoices);
    },
  );

  // PR-21: Professional's own invoice list
  app.get(
    "/v1/professional-invoices",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const query = z
        .object({
          status: z.enum(["pending", "paid", "cancelled"]).optional(),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = { professionalId: user.professionalId };
      if (query.status) filter.status = query.status;

      const page = query.page;
      const limit = query.limit;
      const skip = (page - 1) * limit;

      const [invoices, total] = await Promise.all([
        ProfessionalInvoiceModel.find(filter)
          .populate("workOrderId", "category status")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        ProfessionalInvoiceModel.countDocuments(filter),
      ]);

      // Aggregate earnings summary
      const [earningsSummary] = await ProfessionalInvoiceModel.aggregate([
        { $match: { professionalId: user.professionalId } },
        {
          $group: {
            _id: null,
            totalPaid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, { $toDouble: "$netPayable" }, 0] } },
            totalPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, { $toDouble: "$netPayable" }, 0] } },
            totalComputed: { $sum: { $toDouble: "$computedAmount" } },
            count: { $sum: 1 },
          },
        },
      ]);

      return serialize({
        data: invoices,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        summary: earningsSummary ?? { totalPaid: 0, totalPending: 0, totalComputed: 0, count: 0 },
      });
    },
  );

  // PR-06: Save notification preferences
  app.patch(
    "/v1/professionals/me/notification-preferences",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          email: z.object({
            workOrderAssignments: z.boolean().optional(),
            statusChanges: z.boolean().optional(),
            reviewOutcomes: z.boolean().optional(),
          }).optional(),
          inApp: z.object({
            workOrderAssignments: z.boolean().optional(),
            statusChanges: z.boolean().optional(),
            reviewOutcomes: z.boolean().optional(),
          }).optional(),
        })
        .parse(request.body);

      const updateFields: Record<string, unknown> = {};
      if (payload.email?.workOrderAssignments !== undefined)
        updateFields["notificationPreferences.email.workOrderAssignments"] = payload.email.workOrderAssignments;
      if (payload.email?.statusChanges !== undefined)
        updateFields["notificationPreferences.email.statusChanges"] = payload.email.statusChanges;
      if (payload.email?.reviewOutcomes !== undefined)
        updateFields["notificationPreferences.email.reviewOutcomes"] = payload.email.reviewOutcomes;
      if (payload.inApp?.workOrderAssignments !== undefined)
        updateFields["notificationPreferences.inApp.workOrderAssignments"] = payload.inApp.workOrderAssignments;
      if (payload.inApp?.statusChanges !== undefined)
        updateFields["notificationPreferences.inApp.statusChanges"] = payload.inApp.statusChanges;
      if (payload.inApp?.reviewOutcomes !== undefined)
        updateFields["notificationPreferences.inApp.reviewOutcomes"] = payload.inApp.reviewOutcomes;

      const updated = await ProfessionalModel.findByIdAndUpdate(
        user.professionalId,
        { $set: updateFields },
        { new: true },
      ).lean();
      if (!updated) throw new HttpError(404, "Professional not found");

      return serialize(updated);
    },
  );

  // PR-05: Save payout account
  app.patch(
    "/v1/professionals/me/payout-account",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          bankName: z.string().trim().min(2).max(200),
          accountNumber: z.string().trim().min(10).max(20),
          accountName: z.string().trim().min(2).max(200),
        })
        .parse(request.body);

      const updated = await ProfessionalModel.findByIdAndUpdate(
        user.professionalId,
        {
          $set: {
            "payoutAccount.bankName": payload.bankName,
            "payoutAccount.accountNumber": payload.accountNumber,
            "payoutAccount.accountName": payload.accountName,
            "payoutAccount.updatedAt": new Date(),
          },
        },
        { new: true },
      ).lean();
      if (!updated) throw new HttpError(404, "Professional not found");

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(user.professionalId),
        action: "Professional payout account updated",
      });

      return serialize(updated);
    },
  );

  // PR-10: Update availability status
  app.patch(
    "/v1/professionals/me/availability",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          availabilityStatus: z.enum(["available", "busy", "unavailable"]),
          maxConcurrentWorkOrders: z.number().int().min(1).max(50).optional(),
        })
        .parse(request.body);

      const updateFields: Record<string, unknown> = {
        availabilityStatus: payload.availabilityStatus,
      };
      if (payload.maxConcurrentWorkOrders !== undefined) {
        updateFields.maxConcurrentWorkOrders = payload.maxConcurrentWorkOrders;
      }

      const updated = await ProfessionalModel.findByIdAndUpdate(
        user.professionalId,
        { $set: updateFields },
        { new: true },
      ).lean();
      if (!updated) throw new HttpError(404, "Professional not found");

      return serialize(updated);
    },
  );

  // PR-08: Suspend a professional
  app.post(
    "/v1/professionals/:id/suspend",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "professional");
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          reason: z.enum(["disciplinary", "license_lapsed", "conflict_found", "performance", "other"]),
          notes: z.string().trim().min(2).max(2000),
        })
        .parse(request.body);

      const professional = await ProfessionalModel.findByIdAndUpdate(
        params.id,
        {
          $set: {
            status: "disabled",
            suspensionReason: payload.reason,
            suspensionNotes: payload.notes,
            suspendedAt: new Date(),
            suspendedBy: request.authUser.userId,
          },
        },
        { new: true },
      ).lean();
      if (!professional) throw new HttpError(404, "Professional not found");

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: params.id,
        action: "Professional suspended",
        notes: `${payload.reason}: ${payload.notes}`,
      });

      return serialize(professional);
    },
  );

  // PR-22: Confirm receipt of payment
  app.post(
    "/v1/professional-invoices/:id/confirm-receipt",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const params = z.object({ id: z.string() }).parse(request.params);
      const invoice = await ProfessionalInvoiceModel.findOne({
        _id: params.id,
        professionalId: user.professionalId,
        status: "paid",
      });
      if (!invoice) throw new HttpError(404, "Paid invoice not found");
      if (invoice.receiptConfirmedAt) {
        return serialize(invoice.toObject());
      }

      invoice.receiptConfirmedAt = new Date();
      await invoice.save();

      await appendEvent(request.authUser, {
        entityType: "work_order",
        entityId: String(invoice.workOrderId),
        action: "InvoiceReceiptConfirmed",
        notes: `Invoice ${params.id} receipt confirmed by professional`,
      });

      return serialize(invoice.toObject());
    },
  );

  // PR-22: Dispute a payment
  app.post(
    "/v1/professional-invoices/:id/dispute",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({
        notes: z.string().trim().min(10).max(2000),
        expectedAmount: z.number().nonnegative().optional(),
      }).parse(request.body);

      const invoice = await ProfessionalInvoiceModel.findOne({
        _id: params.id,
        professionalId: user.professionalId,
        status: "paid",
      });
      if (!invoice) throw new HttpError(404, "Paid invoice not found");
      if (invoice.paymentDisputed) {
        throw new HttpError(409, "Invoice already has an active dispute");
      }

      invoice.paymentDisputed = true;
      invoice.disputeNotes = payload.notes;
      invoice.disputeRaisedAt = new Date();
      if (payload.expectedAmount != null) {
        invoice.expectedAmount = toDecimal(payload.expectedAmount);
      }
      await invoice.save();

      await appendEvent(request.authUser, {
        entityType: "work_order",
        entityId: String(invoice.workOrderId),
        action: "InvoiceDisputeRaised",
        notes: payload.notes,
      });

      return serialize(invoice.toObject());
    },
  );

  // PR-35: Professional network performance report for operators
  app.get(
    "/v1/analytics/professional-performance",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }

      const query = z
        .object({
          category: z.enum(["inspector", "valuer", "lawyer", "trustee", "servicer"]).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = { onboardingStatus: "approved" };
      if (query.category) filter.category = query.category;
      if (query.status) filter.status = query.status;

      const professionals = await ProfessionalModel.find(filter).lean();
      const professionalIds = professionals.map((p: any) => p._id);

      const TERMINAL_STATUSES = ["completed", "declined", "cancelled", "withdrawn"];
      const ACTIVE_STATUSES = ["assigned", "accepted", "in_progress", "needs_info", "submitted", "under_review"];

      const [completedAgg, activeAgg, avgTurnaroundAgg, slaBreachAgg, invoiceTotals] = await Promise.all([
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds }, status: "completed" } },
          { $group: { _id: "$professionalId", count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: unknown; count: number }>>,
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds }, status: { $in: ACTIVE_STATUSES } } },
          { $group: { _id: "$professionalId", count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: unknown; count: number }>>,
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds }, status: "completed", acceptedAt: { $exists: true }, submittedAt: { $exists: true } } },
          { $project: { professionalId: 1, turnaroundMs: { $subtract: ["$submittedAt", "$acceptedAt"] } } },
          { $group: { _id: "$professionalId", avgTurnaroundMs: { $avg: "$turnaroundMs" } } },
        ]) as Promise<Array<{ _id: unknown; avgTurnaroundMs: number }>>,
        ProfessionalWorkOrderModel.aggregate([
          { $match: { professionalId: { $in: professionalIds }, slaBreachedAt: { $exists: true } } },
          { $group: { _id: "$professionalId", breachCount: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: unknown; breachCount: number }>>,
        ProfessionalInvoiceModel.aggregate([
          { $match: { professionalId: { $in: professionalIds } } },
          { $group: { _id: "$professionalId", totalInvoiced: { $sum: { $toDouble: "$computedAmount" } } } },
        ]) as Promise<Array<{ _id: unknown; totalInvoiced: number }>>,
      ]);

      const completedMap = new Map(completedAgg.map((r) => [String(r._id), r.count]));
      const activeMap = new Map(activeAgg.map((r) => [String(r._id), r.count]));
      const turnaroundMap = new Map(avgTurnaroundAgg.map((r) => [String(r._id), r.avgTurnaroundMs]));
      const slaBreachMap = new Map(slaBreachAgg.map((r) => [String(r._id), r.breachCount]));
      const invoiceMap = new Map(invoiceTotals.map((r) => [String(r._id), r.totalInvoiced]));

      const report = professionals.map((p: any) => {
        const pid = String(p._id);
        const completed = completedMap.get(pid) ?? 0;
        const active = activeMap.get(pid) ?? 0;
        const slaBreaches = slaBreachMap.get(pid) ?? 0;
        const avgTurnaroundMs = turnaroundMap.get(pid) ?? null;
        const avgTurnaroundDays = avgTurnaroundMs !== null ? Math.round(avgTurnaroundMs / (1000 * 60 * 60 * 24) * 10) / 10 : null;
        const onTimeCount = Math.max(0, completed - slaBreaches);
        const onTimeRate = completed > 0 ? Math.round((onTimeCount / completed) * 100) : null;

        return {
          id: pid,
          name: p.name,
          category: p.category,
          status: p.status,
          availabilityStatus: p.availabilityStatus ?? "available",
          activeWorkOrders: active,
          maxConcurrentWorkOrders: p.maxConcurrentWorkOrders ?? 5,
          completedWorkOrders: completed,
          slaBreaches,
          avgQualityScore: p.qualityScoreAvg ?? 0,
          qualityScoreCount: p.qualityScoreCount ?? 0,
          avgTurnaroundDays,
          onTimeRate,
          totalInvoiced: invoiceMap.get(pid) ?? 0,
        };
      });

      return serialize(report);
    },
  );

  // PR-26: Operator broadcast to professional network
  app.post(
    "/v1/professionals/broadcast",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }

      const payload = z
        .object({
          subject: z.string().trim().min(2).max(200),
          message: z.string().trim().min(10).max(5000),
          category: z
            .enum(["all", "inspector", "valuer", "lawyer", "trustee", "servicer"])
            .default("all"),
          urgent: z.boolean().default(false),
        })
        .parse(request.body);

      // Find all active professionals matching the target category
      const professionalFilter: Record<string, unknown> = { status: "active", onboardingStatus: "approved" };
      if (payload.category !== "all") professionalFilter.category = payload.category;

      const professionals = await ProfessionalModel.find(professionalFilter).select("_id").lean();
      const professionalIds = professionals.map((p: any) => p._id);

      // Find users linked to those professionals
      const users = await UserModel.find({ professionalId: { $in: professionalIds } })
        .select("_id email name")
        .lean();

      if (!users.length) {
        return serialize({ sent: 0, message: "No matching professionals found" });
      }

      // Create in-app notifications and optionally send emails
      const notifications = users.map((u: any) => ({
        userId: String(u._id),
        type: "platform_announcement",
        title: payload.subject,
        message: payload.message,
        entityType: "platform_config",
        entityId: "broadcast",
        channels: {
          inApp: { status: "pending" },
          email: { status: "pending" },
        },
        urgent: payload.urgent,
      }));

      await NotificationModel.insertMany(notifications);

      // Send emails
      let emailsSent = 0;
      for (const u of users as any[]) {
        if (!u.email) continue;
        try {
          const result = await sendEmailWithFallback({
            to: u.email,
            subject: `[Fractal] ${payload.subject}`,
            text: payload.message,
            html: `<p>${payload.message.replace(/\n/g, "<br>")}</p>`,
          });
          if (result.status === "sent") emailsSent++;
        } catch {
          // non-fatal
        }
      }

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: "broadcast",
        action: "ProfessionalBroadcast",
        notes: `${payload.subject} — target: ${payload.category}, recipients: ${users.length}`,
      });

      return serialize({ sent: users.length, emailsSent, subject: payload.subject });
    },
  );

  // PR-07: Request re-credentialing (refresh credentials)
  app.post(
    "/v1/professionals/me/request-recredential",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const professional = await ProfessionalModel.findById(user.professionalId);
      if (!professional) throw new HttpError(404, "Professional not found");

      if (professional.onboardingStatus !== "approved") {
        throw new HttpError(409, "Re-credentialing is only available for approved professionals");
      }

      professional.onboardingStatus = "submitted";
      professional.reviewedBy = undefined;
      professional.reviewedAt = undefined;
      await professional.save();

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(user.professionalId),
        action: "RecredentialRequested",
        notes: "Professional initiated credential renewal",
      });

      return serialize({ onboardingStatus: "submitted", message: "Re-credentialing request submitted. An operator will review your updated credentials." });
    },
  );

  // PR-01: Upload credential document
  app.post(
    "/v1/professionals/me/credential-upload",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          documentType: z.enum(["license", "membership", "cv", "pi_insurance", "other"]),
          filename: z.string().trim().min(1).max(300),
          contentBase64: z.string().trim().min(8),
          mimeType: z.string().trim().max(150).optional(),
        })
        .parse(request.body);

      const persisted = await persistProfessionalBinary({
        professionalId: String(user.professionalId),
        filename: payload.filename,
        contentBase64: payload.contentBase64,
        mimeType: payload.mimeType,
      });

      // Store storageKey on the professional document based on document type
      const updateField =
        payload.documentType === "license"
          ? "licenseMeta.documentStorageKey"
          : payload.documentType === "pi_insurance"
            ? "piInsurance.documentStorageKey"
            : `credentialDocs.${payload.documentType}`;

      await ProfessionalModel.findByIdAndUpdate(
        user.professionalId,
        { $set: { [updateField]: persisted.storageKey } },
      );

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(user.professionalId),
        action: "CredentialDocumentUploaded",
        notes: `${payload.documentType}: ${payload.filename}`,
      });

      return serialize({ storageKey: persisted.storageKey, sha256: persisted.sha256, bytes: persisted.bytes, documentType: payload.documentType });
    },
  );

  // PR-32: Add disciplinary record to professional (admin/operator only)
  app.post(
    "/v1/professionals/:id/disciplinary",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          type: z.enum(["warning", "formal_complaint", "sla_breach", "coi_violation", "suspension"]),
          reason: z.string().trim().min(10).max(2000),
          notes: z.string().trim().max(2000).optional(),
        })
        .parse(request.body);

      const professional = await ProfessionalModel.findByIdAndUpdate(
        params.id,
        {
          $push: {
            disciplinaryRecord: {
              type: payload.type,
              reason: payload.reason,
              notes: payload.notes,
              issuedBy: request.authUser.userId,
              issuedAt: new Date(),
            },
          },
        },
        { new: true },
      ).lean();

      if (!professional) throw new HttpError(404, "Professional not found");

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: params.id,
        action: "DisciplinaryRecordAdded",
        notes: `${payload.type}: ${payload.reason}`,
      });

      return serialize(professional);
    },
  );

  // PR-27: Professional raises a formal dispute
  app.post(
    "/v1/professional-disputes",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          disputeType: z.enum(["invoice_dispute", "payment_dispute", "score_dispute", "assignment_dispute", "other"]),
          entityId: z.string().optional(),
          subject: z.string().trim().min(5).max(200),
          details: z.string().trim().min(20).max(5000),
        })
        .parse(request.body);

      const dispute = await (await import("../../db/models.js")).DisputeModel.create({
        entityType: "work_order",
        entityId: payload.entityId ?? String(user.professionalId),
        reason: payload.subject,
        details: payload.details,
        status: "open",
        raisedBy: request.authUser.userId,
        disputeType: payload.disputeType,
      });

      await appendEvent(request.authUser, {
        entityType: "work_order",
        entityId: payload.entityId ?? String(user.professionalId),
        action: "ProfessionalDisputeRaised",
        notes: `${payload.disputeType}: ${payload.subject}`,
      });

      return serialize(dispute.toObject());
    },
  );

  // PR-27: List professional's own disputes
  app.get(
    "/v1/professional-disputes",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const disputes = await (await import("../../db/models.js")).DisputeModel.find({
        raisedBy: request.authUser.userId,
      }).sort({ createdAt: -1 }).lean();

      return serialize(disputes);
    },
  );

  // PR-44: Professional's own document history (all deliverables)
  app.get(
    "/v1/professionals/me/documents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const workOrders = await ProfessionalWorkOrderModel.find({
        professionalId: user.professionalId,
        "outcome.deliverables": { $exists: true },
      })
        .select("_id applicationId category status outcome createdAt")
        .lean();

      const documents: Array<{
        workOrderId: string;
        applicationId: string | null;
        category: string;
        workOrderStatus: string;
        deliverableIndex: number;
        type: string;
        filename: string;
        mimeType?: string;
        storageKey?: string;
        submittedAt: Date | null;
      }> = [];

      for (const wo of workOrders as any[]) {
        const deliverables: any[] = wo.outcome?.deliverables ?? [];
        deliverables.forEach((d: any, idx: number) => {
          documents.push({
            workOrderId: String(wo._id),
            applicationId: wo.applicationId ? String(wo.applicationId) : null,
            category: wo.category,
            workOrderStatus: wo.status,
            deliverableIndex: idx,
            type: d.type,
            filename: d.filename,
            mimeType: d.mimeType,
            storageKey: d.storageKey,
            submittedAt: wo.outcome?.submittedAt ?? null,
          });
        });
      }

      documents.sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0));

      return serialize(documents);
    },
  );

  // PR-45: Export work order event log as CSV
  app.get(
    "/v1/work-orders/:id/events/export",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "work_order");
      const params = z.object({ id: z.string() }).parse(request.params);
      const { ProfessionalWorkOrderEventModel } = await import("../../db/models.js");

      const wo = await ProfessionalWorkOrderModel.findById(params.id).lean();
      if (!wo) throw new HttpError(404, "Work order not found");
      // Scope check: professional can only export their own
      if (request.authUser.role === "professional") {
        const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
        if (String((wo as any).professionalId) !== String(user?.professionalId)) {
          throw new HttpError(403, "Access denied");
        }
      }

      const events = await ProfessionalWorkOrderEventModel.find({ workOrderId: params.id })
        .sort({ createdAt: 1 })
        .lean();

      const csvLines = [
        "timestamp,event_type,actor_id,actor_role,notes",
        ...events.map((e: any) => {
          const ts = e.createdAt ? new Date(e.createdAt).toISOString() : "";
          const notes = (e.notes ?? "").replace(/"/g, '""');
          return `"${ts}","${e.eventType ?? ""}","${String(e.actorId ?? "")}","${e.actorRole ?? ""}","${notes}"`;
        }),
      ];

      reply.header("Content-Type", "text/csv");
      reply.header("Content-Disposition", `attachment; filename="work-order-${params.id}-events.csv"`);
      return reply.send(csvLines.join("\n"));
    },
  );

  // PR-42: List firm team members
  app.get(
    "/v1/professionals/me/team",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const members = await ProfessionalTeamMemberModel.find({
        professionalId: user.professionalId,
        status: { $ne: "removed" },
      })
        .populate("userId", "name email role")
        .lean();

      return serialize(members);
    },
  );

  // PR-42: Invite a team member to the firm
  app.post(
    "/v1/professionals/me/team/invite",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          userId: z.string(),
          role: z.enum(["partner", "associate", "admin"]),
        })
        .parse(request.body);

      const invitedUser = await UserModel.findById(payload.userId).select("_id email professionalId").lean();
      if (!invitedUser) throw new HttpError(404, "User not found");

      const existing = await ProfessionalTeamMemberModel.findOne({
        professionalId: user.professionalId,
        userId: payload.userId,
        status: { $ne: "removed" },
      });
      if (existing) throw new HttpError(409, "User is already a team member");

      const member = await ProfessionalTeamMemberModel.create({
        professionalId: user.professionalId,
        userId: payload.userId,
        role: payload.role,
        invitedBy: request.authUser.userId,
        inviteEmail: (invitedUser as any).email,
        invitedAt: new Date(),
        status: "active", // simplified: auto-join
        joinedAt: new Date(),
      });

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(user.professionalId),
        action: "TeamMemberInvited",
        notes: `${payload.role}: user ${payload.userId}`,
      });

      return serialize(member.toObject());
    },
  );

  // PR-42: Remove a team member
  app.delete(
    "/v1/professionals/me/team/:memberId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const params = z.object({ memberId: z.string() }).parse(request.params);

      const member = await ProfessionalTeamMemberModel.findOneAndUpdate(
        { _id: params.memberId, professionalId: user.professionalId },
        { $set: { status: "removed" } },
        { new: true },
      );
      if (!member) throw new HttpError(404, "Team member not found");

      return serialize(member.toObject());
    },
  );

  // PR-04: Save TIN / WHT configuration
  app.patch(
    "/v1/professionals/me/tax",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "professional") {
        throw new HttpError(403, "Professional role required");
      }
      const user = await UserModel.findById(request.authUser.userId).select("professionalId").lean();
      if (!user?.professionalId) throw new HttpError(422, "No professional profile linked");

      const payload = z
        .object({
          tin: z.string().trim().min(8).max(30),
          vatRegistered: z.boolean().optional(),
          vatNumber: z.string().trim().max(30).optional(),
        })
        .parse(request.body);

      const professional = await ProfessionalModel.findById(user.professionalId).lean();
      if (!professional) throw new HttpError(404, "Professional not found");

      // WHT rate derived from org type
      const whtRate = (professional as any).organizationType === "individual" ? 5 : 10;

      const updateFields: Record<string, unknown> = {
        tin: payload.tin,
        whtRate,
      };
      if (payload.vatRegistered !== undefined) updateFields.vatRegistered = payload.vatRegistered;
      if (payload.vatNumber !== undefined) updateFields.vatNumber = payload.vatNumber;

      const updated = await ProfessionalModel.findByIdAndUpdate(
        user.professionalId,
        { $set: updateFields },
        { new: true },
      ).lean();

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(user.professionalId),
        action: "Professional tax details updated",
      });

      return serialize(updated);
    },
  );
}
