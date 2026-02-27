/**
 * 4.2: Investor suitability assessment routes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SuitabilityAssessmentModel } from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";

const ASSESSMENT_VALIDITY_MONTHS = 12;

// Simple risk scoring: each "high risk" answer adds points
const HIGH_RISK_ANSWERS = new Set(["no_experience", "short_term", "high_risk_tolerance", "speculative", "cannot_afford_loss"]);

function computeRiskScore(responses: { questionId: string; answer: string }[]): { score: number; tier: number } {
  let score = 0;
  for (const r of responses) {
    if (HIGH_RISK_ANSWERS.has(r.answer)) score += 2;
    else score += 1;
  }
  // Tier 1 = lowest risk, 5 = highest risk
  const tier = score <= 5 ? 1 : score <= 10 ? 2 : score <= 15 ? 3 : score <= 20 ? 4 : 5;
  return { score, tier };
}

export async function suitabilityRoutes(app: FastifyInstance) {
  app.post(
    "/v1/investor/suitability/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");

      const payload = z.object({
        responses: z.array(z.object({
          questionId: z.string().min(1),
          answer: z.string().min(1),
        })).min(1),
      }).parse(request.body);

      const { score, tier } = computeRiskScore(payload.responses as any);

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + ASSESSMENT_VALIDITY_MONTHS);

      const assessment = await SuitabilityAssessmentModel.create({
        investorUserId: request.authUser.userId,
        responses: payload.responses,
        riskScore: score,
        riskTier: tier,
        completedAt: new Date(),
        expiresAt,
      });

      return serialize(assessment.toObject());
    },
  );

  app.get(
    "/v1/investor/suitability/status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");

      const latest = await SuitabilityAssessmentModel.findOne({
        investorUserId: request.authUser.userId,
      }).sort({ completedAt: -1 }).lean();

      if (!latest) {
        return { valid: false, assessment: null };
      }

      const isValid = new Date() < new Date((latest as any).expiresAt);
      return serialize({ valid: isValid, assessment: latest });
    },
  );
}
