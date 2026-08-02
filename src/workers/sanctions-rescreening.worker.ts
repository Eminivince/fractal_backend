/**
 * Sanctions / PEP re-screening worker.
 *
 * Onboarding AML is point-in-time; regulators expect ONGOING screening. This worker
 * periodically re-runs the Sumsub AML/sanctions check for approved investors whose
 * last screen is older than the configured interval. The Sumsub AML webhook updates
 * amlStatus on result (clear / flagged), which gates subscription eligibility.
 */
import type { FastifyBaseLogger } from "fastify";
import { InvestorProfileModel } from "../db/models.js";
import { initiateAmlCheck } from "../services/sumsub-aml.service.js";
import { appendEvent } from "../utils/audit.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily sweep
const RESCREEN_AFTER_DAYS = 30; // re-screen if last AML check older than this
const BATCH_LIMIT = 200;

export function startSanctionsRescreeningWorker(log: FastifyBaseLogger) {
  if (!env.SUMSUB_ENABLED) {
    log.info("Sanctions re-screening worker disabled (SUMSUB_ENABLED=false)");
    return { stop: () => {}, triggerNow: async () => {} };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cutoff = new Date(Date.now() - RESCREEN_AFTER_DAYS * 24 * 60 * 60 * 1000);
      // Approved investors with a Sumsub applicant whose AML screen is stale (or never set).
      const due = await InvestorProfileModel.find({
        kycStatus: "approved",
        sumsubApplicantId: { $exists: true, $ne: null },
        $or: [{ amlCheckedAt: { $lt: cutoff } }, { amlCheckedAt: { $exists: false } }],
      })
        .limit(BATCH_LIMIT)
        .lean();

      let rescreened = 0;
      for (const profile of due) {
        try {
          await initiateAmlCheck(profile.sumsubApplicantId as string);
          await InvestorProfileModel.updateOne(
            { _id: profile._id },
            { $set: { amlCheckedAt: new Date() } },
          );
          await appendEvent(SYSTEM_ACTOR, {
            entityType: "user",
            entityId: String(profile.userId),
            action: "SanctionsRescreenInitiated",
          });
          rescreened++;
        } catch (err) {
          log.error(
            { err, investorProfileId: String(profile._id) },
            "[sanctions-rescreening] AML re-screen failed",
          );
        }
      }

      if (rescreened > 0) {
        log.info(`[sanctions-rescreening] re-screened ${rescreened} investor(s)`);
      }
    } catch (err) {
      log.error(err, "[sanctions-rescreening] worker error");
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info(`Sanctions re-screening worker started (interval=${POLL_INTERVAL_MS}ms)`);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    triggerNow: tick,
  };
}
