import type { FastifyInstance, FastifyRequest } from "fastify";
import { EscrowReceiptModel, LedgerEntryModel, SubscriptionModel } from "../../../db/models.js";
import { toDecimal } from "../../../utils/decimal.js";
import { appendEvent } from "../../../utils/audit.js";
import { runInTransaction } from "../../../utils/tx.js";
import { verifyPaystackWebhookSignature } from "../../../services/paystack.js";
import { env } from "../../../config/env.js";

const SYSTEM_ACTOR = {
  userId: "system",
  role: "admin" as const,
  email: "system@fractal",
  businessId: undefined,
};

export async function paystackWebhookRoutes(app: FastifyInstance) {
  // Capture raw body for HMAC signature verification
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  app.post(
    "/v1/webhooks/paystack",
    {},
    async (request: FastifyRequest, reply) => {
      if (!env.PAYSTACK_ENABLED) {
        return reply.status(200).send({ ok: true });
      }

      const signature = request.headers["x-paystack-signature"];
      if (typeof signature !== "string") {
        return reply.status(400).send({ error: "Missing signature" });
      }

      const rawBody = (request as any).rawBody as string | undefined;
      if (!rawBody) {
        return reply.status(400).send({ error: "Raw body unavailable" });
      }

      if (!verifyPaystackWebhookSignature(rawBody, signature)) {
        return reply.status(401).send({ error: "Invalid signature" });
      }

      const event = request.body as Record<string, unknown>;
      const eventType = event.event as string;

      if (eventType === "charge.success") {
        const data = event.data as Record<string, unknown>;
        const reference = data.reference as string;
        const metadata = (data.metadata ?? {}) as Record<string, unknown>;
        const subscriptionId = metadata.subscriptionId as string | undefined;

        if (!subscriptionId) {
          app.log.warn({ reference }, "Paystack charge.success has no subscriptionId in metadata");
          return reply.status(200).send({ ok: true });
        }

        await runInTransaction(async (session) => {
          const subscription = await SubscriptionModel.findById(subscriptionId).session(session);
          if (!subscription) {
            app.log.warn({ subscriptionId }, "Subscription not found for Paystack webhook");
            return;
          }

          if (subscription.status === "paid" || subscription.status === "allocation_confirmed") {
            return;
          }

          const amountKobo = data.amount as number;
          const currency = (data.currency as string | undefined) ?? "NGN";

          // 2.1: Atomic upsert for idempotent receipt creation
          const receipt = await EscrowReceiptModel.findOneAndUpdate(
            { externalRef: reference },
            {
              $setOnInsert: {
                externalRef: reference,
                source: "provider",
                amount: toDecimal(amountKobo / 100),
                payerRef: String(subscription.investorUserId),
                currency,
                status: "confirmed",
                occurredAt: new Date(),
                metadata: { paystackEvent: "charge.success", paystackData: data },
              },
            },
            { upsert: true, new: true, session },
          );

          // If this receipt already existed, skip duplicate processing
          const isNewReceipt = receipt.createdAt?.getTime() === receipt.updatedAt?.getTime();
          if (!isNewReceipt) {
            app.log.info({ reference }, "Duplicate Paystack webhook - receipt already exists");
            return;
          }

          subscription.status = "paid";
          subscription.externalReceiptRef = reference;
          await subscription.save({ session });

          await LedgerEntryModel.create(
            [
              {
                ledgerType: "escrow",
                accountRef: `offering:${String(subscription.offeringId)}`,
                direction: "credit",
                amount: toDecimal(amountKobo / 100),
                currency,
                entityType: "subscription",
                entityId: String(subscription._id),
                externalRef: reference,
                idempotencyKey: `paystack:charge:${reference}`,
                postedAt: new Date(),
                metadata: {
                  source: "provider",
                  investorUserId: String(subscription.investorUserId),
                  paystackReference: reference,
                },
              },
            ],
            { session },
          );

          await appendEvent(
            SYSTEM_ACTOR as any,
            {
              entityType: "subscription",
              entityId: String(subscription._id),
              action: "SubscriptionPaid",
              notes: `paystack:${reference}`,
            },
            session,
          );
        });
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
