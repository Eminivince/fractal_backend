import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import {
  claimIdentityVerificationApplications,
  loadClaimedIdentityVerificationApplication,
  markIdentityVerificationApplicationForRetry,
  markIdentityVerificationApplicationReady,
  type ClaimedIdentityVerificationApplication,
} from "../platform/postgres-identity-verification-applications.js";
import {
  createApplicant,
  getApplicantByExternalUserId,
  SumsubApplicantNotFoundError,
  SumsubRequestError,
  type SumsubApplicant,
} from "./sumsub.js";

export interface IdentityVerificationApplicationLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export type SumsubApplicantLookup = (externalUserId: string) => Promise<SumsubApplicant>;
export type SumsubApplicantCreator = (externalUserId: string, email: string) => Promise<SumsubApplicant>;

/**
 * Resolve first, create second. If Sumsub created an applicant but this worker
 * crashes before marking it ready, the next lease finds that same applicant by
 * immutable external user ID and finishes the local transition.
 */
export async function processIdentityVerificationApplication(
  application: ClaimedIdentityVerificationApplication,
  workerId: string,
  lookup: SumsubApplicantLookup = getApplicantByExternalUserId,
  create: SumsubApplicantCreator = createApplicant,
): Promise<void> {
  if (application.provider !== "sumsub") throw new Error(`Unsupported identity-verification provider: ${application.provider}`);
  const details = await loadClaimedIdentityVerificationApplication({ applicationId: application.id, workerId });
  let applicant: SumsubApplicant;
  try {
    applicant = await lookup(details.externalUserId);
  } catch (error) {
    if (!(error instanceof SumsubApplicantNotFoundError)) throw error;
    try {
      applicant = await create(details.externalUserId, details.email);
    } catch (createError) {
      // A concurrent/replayed provider create may return a conflict after the
      // applicant already exists. One fresh lookup makes that safe recovery
      // explicit instead of relegating it to a manual operations runbook.
      if (!(createError instanceof SumsubRequestError) || createError.statusCode !== 409) throw createError;
      applicant = await lookup(details.externalUserId);
    }
  }
  if (
    !applicant.id.trim()
    || !applicant.inspectionId.trim()
    || applicant.externalUserId !== details.externalUserId
  ) {
    throw new Error("Sumsub applicant response did not match the requested identity");
  }
  await markIdentityVerificationApplicationReady({
    applicationId: application.id,
    workerId,
    applicantId: applicant.id,
    inspectionId: applicant.inspectionId,
  });
}

export async function dispatchPendingIdentityVerificationApplications(input: {
  workerId?: string;
  logger: IdentityVerificationApplicationLogger;
  lookup?: SumsubApplicantLookup;
  create?: SumsubApplicantCreator;
}): Promise<number> {
  const workerId = input.workerId ?? randomUUID();
  const applications = await claimIdentityVerificationApplications({
    workerId,
    limit: env.OUTBOX_DISPATCH_BATCH_SIZE,
    claimTimeoutSeconds: env.IDENTITY_VERIFICATION_APPLICATION_CLAIM_TIMEOUT_SECONDS,
  });
  for (const application of applications) {
    try {
      await processIdentityVerificationApplication(application, workerId, input.lookup, input.create);
      input.logger.info({ applicationId: application.id, identityId: application.identityId }, "Identity-verification applicant is ready");
    } catch (error) {
      const terminal = application.attempts >= env.IDENTITY_VERIFICATION_APPLICATION_MAX_ATTEMPTS
        || (error instanceof SumsubRequestError && !error.retryable)
        || (error instanceof Error && error.message.startsWith("Unsupported identity-verification provider"));
      const delaySeconds = Math.min(
        60 * 60,
        env.IDENTITY_VERIFICATION_APPLICATION_RETRY_BASE_SECONDS * 2 ** Math.max(0, application.attempts - 1),
      );
      await markIdentityVerificationApplicationForRetry({
        applicationId: application.id,
        workerId,
        retryAt: new Date(Date.now() + delaySeconds * 1_000),
        error,
        terminal,
      });
      input.logger.error({ err: error, applicationId: application.id, terminal, delaySeconds }, "Identity-verification applicant setup failed");
    }
  }
  return applications.length;
}

export function startIdentityVerificationApplicationDispatcher(input: {
  logger: IdentityVerificationApplicationLogger;
  lookup?: SumsubApplicantLookup;
  create?: SumsubApplicantCreator;
}): { stop: () => void } {
  const workerId = randomUUID();
  let stopped = false;
  let running = false;
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchPendingIdentityVerificationApplications({ ...input, workerId });
    } catch (error) {
      input.logger.error({ err: error }, "Identity-verification application dispatcher failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void dispatch(), env.IDENTITY_VERIFICATION_APPLICATION_DISPATCH_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
