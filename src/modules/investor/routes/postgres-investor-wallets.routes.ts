import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize } from "../../../utils/rbac.js";
import { HttpError } from "../../../utils/errors.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import {
  confirmInvestorWalletLinkChallenge,
  createInvestorWalletLinkChallenge,
  InvestorWalletLinkError,
  listInvestorWallets,
} from "../../../platform/postgres-investor-wallets.js";

const challengeSchema = z.object({ chainId: z.number().int().positive(), walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/) });
const confirmationSchema = z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/) });

async function currentIdentity(request: FastifyRequest) {
  try { return await requirePostgresIdentityForSubject(request.authUser.userId); }
  catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Your account migration is not ready for wallet linking");
    throw error;
  }
}

function requireInvestorActor(request: FastifyRequest): void {
  if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
}

async function requireHighRiskStepUp(request: FastifyRequest, identityId: string): Promise<void> {
  try {
    await requireFreshTotpStepUp({ sessionId: request.authUser.sessionId, identityId });
  } catch (error) {
    if (error instanceof StepUpRequiredError) throw new HttpError(403, error.message);
    throw error;
  }
}

function walletOperation<T>(operation: () => Promise<T>) {
  return operation().catch((error) => {
    if (error instanceof InvestorWalletLinkError) throw new HttpError(422, error.message);
    throw error;
  });
}

/** Self-scoped PG wallet binding; a raw address alone is never allocation authority. */
export async function postgresInvestorWalletRoutes(app: FastifyInstance) {
  app.get("/v1/investor/wallets", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireInvestorActor(request);
    authorize(request.authUser, "read", "investor_profile");
    return { wallets: await listInvestorWallets(await currentIdentity(request)) };
  });
  app.post("/v1/investor/wallet-link-challenges", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireInvestorActor(request);
    authorize(request.authUser, "update", "investor_profile");
    const payload = challengeSchema.parse(request.body);
    const identityId = await currentIdentity(request);
    return walletOperation(() => createInvestorWalletLinkChallenge({ investorIdentityId: identityId, ...payload }));
  });
  app.post("/v1/investor/wallet-link-challenges/confirm", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireInvestorActor(request);
    authorize(request.authUser, "update", "investor_profile");
    const payload = confirmationSchema.parse(request.body);
    const identityId = await currentIdentity(request);
    await requireHighRiskStepUp(request, identityId);
    return walletOperation(() => confirmInvestorWalletLinkChallenge({ investorIdentityId: identityId, ...payload }));
  });
}
