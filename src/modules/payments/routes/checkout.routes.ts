import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { requirePostgres } from "../../../db/postgres.js";
import { requirePostgresIdentityForSubject, PostgresIdentityUnavailableError } from "../../../platform/postgres-identities.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import { serializePaymentIntentStatus } from "../../../platform/postgres-payment-status.js";
import { CheckoutPolicyError, createCheckout } from "../../../platform/postgres-offering-checkout.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";
import { authorize } from "../../../utils/rbac.js";

const checkoutSchema = z.object({
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  signatureName: z.string().trim().min(1).max(200),
  agreementDocumentHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

async function authenticatedIdentity(request: FastifyRequest): Promise<string> {
  try {
    return await requirePostgresIdentityForSubject(request.authUser.userId);
  } catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) {
      throw new HttpError(409, "Your account migration is not ready for the new checkout flow");
    }
    throw error;
  }
}

async function requireHighRiskStepUp(request: FastifyRequest, identityId: string): Promise<void> {
  try {
    await requireFreshTotpStepUp({ sessionId: request.authUser.sessionId, identityId });
  } catch (error) {
    if (error instanceof StepUpRequiredError) throw new HttpError(403, error.message);
    throw error;
  }
}

export async function paymentCheckoutRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings/:reference/checkout",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "create", "subscription");
      const commandKey = readCommandId(request.headers);
      if (!commandKey) throw new HttpError(400, "X-Command-Id is required for checkout");
      const payload = checkoutSchema.parse(request.body);
      const identityId = await authenticatedIdentity(request);
      await requireHighRiskStepUp(request, identityId);
      if (!env.PAYSTACK_ENABLED) throw new HttpError(422, "Payment provider is not configured");
      try {
        const checkout = await createCheckout({
          publicReference: (request.params as { reference: string }).reference,
          investorIdentityId: identityId,
          amountMinor: payload.amountMinor,
          signatureName: payload.signatureName,
          agreementDocumentHash: payload.agreementDocumentHash,
          provider: "paystack",
          providerReference: `fractal-${randomUUID()}`,
          paymentExpiresAt: new Date(Date.now() + 20 * 60 * 1_000),
          acceptedAt: new Date(),
          commandKey,
        });
        const payment = await requirePostgres().query<{ expires_at: Date }>(
          "SELECT expires_at FROM fractal.payment_intents WHERE id = $1",
          [checkout.paymentIntentId],
        );
        const expiresAt = payment.rows[0]?.expires_at;
        if (!expiresAt) throw new Error("Checkout payment intent disappeared");
        return {
          checkoutId: checkout.reservationId,
          paymentIntentId: checkout.paymentIntentId,
          paymentState: "initializing_provider_instruction",
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        if (error instanceof CheckoutPolicyError) throw new HttpError(422, error.message);
        throw error;
      }
    },
  );

  app.get(
    "/v1/payment-intents/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const identityId = await authenticatedIdentity(request);
      const id = (request.params as { id: string }).id;
      const result = await requirePostgres().query<{
        id: string; status: string; expires_at: Date; currency: string; expected_minor: string;
        instruction_status: string | null; checkout_url: string | null; last_error: string | null; terminal_at: Date | null;
      }>(
        `SELECT intent.id, intent.status, intent.expires_at, intent.currency, intent.expected_minor,
                instruction.status AS instruction_status, instruction.checkout_url, instruction.last_error, instruction.terminal_at
           FROM fractal.payment_intents intent
           JOIN fractal.investment_commitments commitment ON commitment.id = intent.commitment_id
           LEFT JOIN fractal.payment_provider_instructions instruction ON instruction.payment_intent_id = intent.id
          WHERE intent.id = $1 AND commitment.investor_identity_id = $2`,
        [id, identityId],
      );
      const payment = result.rows[0];
      if (!payment) throw new HttpError(404, "Payment intent not found");
      return serializePaymentIntentStatus({
        id: payment.id, status: payment.status, currency: payment.currency, amountMinor: payment.expected_minor,
        expiresAt: payment.expires_at, instructionStatus: payment.instruction_status, checkoutUrl: payment.checkout_url,
        terminalAt: payment.terminal_at,
      });
    },
  );
}
