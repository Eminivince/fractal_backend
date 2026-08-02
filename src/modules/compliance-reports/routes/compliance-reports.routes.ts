/**
 * C10: Regulatory compliance reporting endpoints.
 * Admin-only endpoints for generating compliance reports.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BusinessModel,
  InvestorProfileModel,
  SubscriptionModel,
  LedgerEntryModel,
  EventLogModel,
} from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import { toCsv } from "../../../utils/csv.js";

const MAX_EXPORT_ROWS = 100_000;

const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function parseDateRange(query: unknown) {
  const parsed = dateRangeSchema.parse(query);
  const from = parsed.from ? new Date(parsed.from) : new Date(new Date().getFullYear(), 0, 1);
  const to = parsed.to ? new Date(parsed.to) : new Date();
  return { from, to };
}

function assertAdmin(request: FastifyRequest) {
  // Route through the RBAC matrix (compliance_report: read = admin, operator).
  authorize(request.authUser, "read", "compliance_report");
}

export async function complianceReportRoutes(app: FastifyInstance) {
  // C10-1: KYB status report — businesses grouped by KYB status
  app.get(
    "/v1/admin/reports/kyb-status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      assertAdmin(request);
      const result = await BusinessModel.aggregate([
        { $group: { _id: "$kybStatus", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);
      return serialize({ report: "kyb-status", generatedAt: new Date(), data: result });
    },
  );

  // C10-2: AML flags report — investors with non-clear AML status
  app.get(
    "/v1/admin/reports/aml-flags",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      assertAdmin(request);
      const flagged = await InvestorProfileModel.find({
        amlStatus: { $in: ["flagged", "rejected"] },
      })
        .select("userId amlStatus amlCheckedAt kycStatus eligibility jurisdiction")
        .populate("userId", "email firstName lastName")
        .lean();
      return serialize({
        report: "aml-flags",
        generatedAt: new Date(),
        total: flagged.length,
        data: flagged,
      });
    },
  );

  // C10-3: Investor summary — counts by eligibility, jurisdiction, accreditation
  app.get(
    "/v1/admin/reports/investor-summary",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      assertAdmin(request);

      const [byEligibility, byJurisdiction, byAccreditation, byKycStatus, byAmlStatus] =
        await Promise.all([
          InvestorProfileModel.aggregate([
            { $group: { _id: "$eligibility", count: { $sum: 1 } } },
          ]),
          InvestorProfileModel.aggregate([
            { $group: { _id: "$jurisdiction", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ]),
          InvestorProfileModel.aggregate([
            { $group: { _id: "$accreditationStatus", count: { $sum: 1 } } },
          ]),
          InvestorProfileModel.aggregate([
            { $group: { _id: "$kycStatus", count: { $sum: 1 } } },
          ]),
          InvestorProfileModel.aggregate([
            { $group: { _id: "$amlStatus", count: { $sum: 1 } } },
          ]),
        ]);

      return serialize({
        report: "investor-summary",
        generatedAt: new Date(),
        data: { byEligibility, byJurisdiction, byAccreditation, byKycStatus, byAmlStatus },
      });
    },
  );

  // C10-4: Transaction volume report — subscription payments by period
  app.get(
    "/v1/admin/reports/transaction-volume",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      assertAdmin(request);
      const { from, to } = parseDateRange(request.query);

      const [subscriptionVolume, ledgerVolume] = await Promise.all([
        SubscriptionModel.aggregate([
          {
            $match: {
              status: { $in: ["paid", "allocation_confirmed"] },
              createdAt: { $gte: from, $lte: to },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
              count: { $sum: 1 },
              totalAmount: { $sum: "$amount" },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        LedgerEntryModel.aggregate([
          {
            $match: {
              createdAt: { $gte: from, $lte: to },
            },
          },
          {
            $group: {
              _id: { direction: "$direction", feeType: "$feeType" },
              count: { $sum: 1 },
              totalAmount: { $sum: "$amount" },
            },
          },
        ]),
      ]);

      return serialize({
        report: "transaction-volume",
        generatedAt: new Date(),
        period: { from, to },
        data: { subscriptionVolume, ledgerVolume },
      });
    },
  );

  // C10-5: Compliance events report — audit trail for compliance-relevant events.
  // Supports ?format=csv for download; cap raised to MAX_EXPORT_ROWS (was 1000).
  app.get(
    "/v1/admin/reports/compliance-events",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      assertAdmin(request);
      const { from, to } = parseDateRange(request.query);
      const format = z
        .object({ format: z.enum(["json", "csv"]).default("json") })
        .parse(request.query).format;

      const complianceActions = [
        "KYCApproved", "KYCRejected", "KYCRenewalRequired",
        "AMLScreeningCompleted", "AccreditationCheckFailed", "AMLCheckFailed",
        "SuitabilityAssessmentCompleted",
        "SubscriptionCommitted", "CoolingOffRefundInitiated",
        "RefundInitiated", "SubscriptionRefunded",
      ];

      const events = await EventLogModel.find({
        action: { $in: complianceActions },
        timestamp: { $gte: from, $lte: to },
      })
        .sort({ timestamp: -1 })
        .limit(MAX_EXPORT_ROWS)
        .lean();

      if (format === "csv") {
        const rows = events.map((e: any) => ({
          timestamp: e.timestamp,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          actorUserId: e.actorUserId,
          roleAtTime: e.roleAtTime,
          notes: e.notes,
          hash: e.hash,
        }));
        const csv = toCsv(rows, [
          "timestamp", "action", "entityType", "entityId", "actorUserId", "roleAtTime", "notes", "hash",
        ]);
        const filename = `compliance-events_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv`;
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .send(csv);
      }

      return serialize({
        report: "compliance-events",
        generatedAt: new Date(),
        period: { from, to },
        total: events.length,
        truncated: events.length >= MAX_EXPORT_ROWS,
        data: events,
      });
    },
  );
}
