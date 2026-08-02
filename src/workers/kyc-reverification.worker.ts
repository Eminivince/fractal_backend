/**
 * 4.4: KYC re-verification worker.
 * Runs weekly, identifies investors with expired KYC approvals
 * and triggers Sumsub re-verification.
 */

import type { FastifyBaseLogger } from "fastify";
import { InvestorProfileModel } from "../db/models.js";
import { createNotificationsFromEvent } from "../services/notifications.js";
import { resetApplicant } from "../services/sumsub.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };
const POLL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly
const DEFAULT_KYC_VALIDITY_MONTHS = 12;

export function startKycReverificationWorker(log: FastifyBaseLogger) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - DEFAULT_KYC_VALIDITY_MONTHS);

      // Find approved investors whose KYC approval is older than the validity period
      const expiredProfiles = await InvestorProfileModel.find({
        kycStatus: "approved",
        kycApprovedAt: { $lt: cutoffDate },
      }).lean();

      for (const profile of expiredProfiles) {
        // Actually trigger Sumsub re-verification: reset the applicant so the
        // investor must re-submit KYC. Without this, status only flips locally.
        if (env.SUMSUB_ENABLED && profile.sumsubApplicantId) {
          try {
            await resetApplicant(profile.sumsubApplicantId);
          } catch (err) {
            log.error(
              { err, investorProfileId: String(profile._id) },
              "[kyc-reverification] Sumsub applicant reset failed — flagging renewal anyway",
            );
          }
        }

        await InvestorProfileModel.findByIdAndUpdate(profile._id, {
          kycStatus: "renewal_required",
          sumsubReviewAnswer: null,
        });

        await createNotificationsFromEvent(SYSTEM_ACTOR, {
          entityType: "user",
          entityId: String(profile.userId),
          action: "KYCRenewalRequired",
          notes: "Your KYC verification has expired and needs to be renewed. Please complete the re-verification process to continue investing.",
        });

        log.info({ investorProfileId: String(profile._id) }, "KYC renewal required");
      }

      if (expiredProfiles.length > 0) {
        log.info(`[kyc-reverification] Flagged ${expiredProfiles.length} profiles for renewal`);
      }
    } catch (err) {
      log.error(err, "[kyc-reverification-worker] error");
    } finally {
      running = false;
    }
  }

  timer = setInterval(tick, POLL_INTERVAL_MS);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    triggerNow: tick,
  };
}
