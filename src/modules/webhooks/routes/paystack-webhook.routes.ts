import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClientSession } from "mongoose";
import {
  BusinessModel,
  DedicatedVirtualAccountModel,
  DistributionLineModel,
  DistributionModel,
  EscrowReceiptModel,
  LedgerEntryModel,
  OfferingModel,
  OutboundTransferModel,
  PaymentIntentModel,
  ReconciliationIssueModel,
  SubscriptionModel,
  TrancheModel,
} from "../../../db/models.js";
import { z } from "zod";
import { toDecimal } from "../../../utils/decimal.js";
import { escrowAccountRef, postLedger } from "../../../services/ledger.js";
import { appendEvent } from "../../../utils/audit.js";
import { runInTransaction } from "../../../utils/tx.js";
import {
  verifyPaystackWebhookSignature,
  verifyPaystackTransaction,
} from "../../../services/paystack.js";
import { env } from "../../../config/env.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { InboxPayloadConflictError, receiveInboxEvent } from "../../../platform/postgres-inbox.js";
import { hashPayload } from "../../../utils/idempotency.js";
import { PaymentIntentNotFoundError, recordProviderPaymentReceipt } from "../../../platform/postgres-payments.js";
import { recordProfessionalPayoutProviderOutcome } from "../../../platform/postgres-professional-invoices.js";
import { recordDistributionPayoutProviderOutcome } from "../../../platform/postgres-distribution-payouts.js";

const SYSTEM_ACTOR = {
  userId: "system",
  role: "admin" as const,
  email: "system@fractal",
  businessId: undefined,
};

// ─── Amount tolerance: 1 kobo (₦0.01) ───
const AMOUNT_TOLERANCE_KOBO = 1;

// ─── Helper: check if all distribution lines are terminal and update parent ───
async function checkDistributionCompletion(
  distributionId: string,
  session: ClientSession,
  log: FastifyInstance["log"],
) {
  const lines = await DistributionLineModel.find({ distributionId }).session(session).lean();
  if (lines.length === 0) return;

  const allTerminal = lines.every((l: any) =>
    ["paid", "failed", "skipped", "reversed"].includes(l.status),
  );
  if (!allTerminal) return;

  const dist = await DistributionModel.findById(distributionId).session(session);
  // 3.4: distributions sit in "paying" during Paystack settlement (older rows may
  // still be "scheduled"); accept both as the source state for completion.
  if (!dist || !["scheduled", "paying"].includes(dist.status)) return;

  const allPaidOrSkipped = lines.every((l: any) =>
    ["paid", "skipped"].includes(l.status),
  );

  if (allPaidOrSkipped) {
    dist.status = "paid";
    dist.paidAt = new Date();
    await dist.save({ session });
    log.info({ distributionId }, "Distribution auto-completed: all lines paid/skipped");
  } else {
    dist.status = "failed";
    await dist.save({ session });
    log.warn({ distributionId }, "Distribution marked failed: one or more lines failed");
  }

  await appendEvent(
    SYSTEM_ACTOR as any,
    {
      entityType: "distribution",
      entityId: distributionId,
      action: allPaidOrSkipped ? "DistributionPaid" : "DistributionFailed",
      notes: `Auto-completed by webhook: ${lines.filter((l: any) => l.status === "paid").length}/${lines.length} paid`,
    },
    session,
  );
}

// ─── charge.success handler ───
async function handleChargeSuccess(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const reference = data.reference as string;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const subscriptionId = metadata.subscriptionId as string | undefined;
  const amountKobo = data.amount as number;
  const currency = (data.currency as string | undefined) ?? "NGN";

  if (!subscriptionId) {
    // Might be a DVA charge — try to match via PaymentIntent by reference
    const intent = await PaymentIntentModel.findOne({ paystackReference: reference });
    if (intent) {
      return handleChargeWithIntent(app, data, intent);
    }
    app.log.warn({ reference }, "Paystack charge.success has no subscriptionId and no matching intent");
    return;
  }

  await runInTransaction(async (session) => {
    const subscription = await SubscriptionModel.findById(subscriptionId).session(session);
    if (!subscription) {
      app.log.warn({ subscriptionId }, "Subscription not found for Paystack webhook");
      return;
    }

    // Idempotency: skip if already paid
    if (["paid", "allocation_confirmed"].includes(subscription.status)) {
      return;
    }

    // Amount verification via PaymentIntent
    const intent = await PaymentIntentModel.findOne({
      subscriptionId: subscription._id,
      paystackReference: reference,
    }).session(session);

    if (intent) {
      intent.receivedAmountKobo = amountKobo;

      if (Math.abs(amountKobo - intent.expectedAmountKobo) > AMOUNT_TOLERANCE_KOBO) {
        // Amount mismatch — DO NOT auto-credit
        intent.status = "amount_mismatch";
        await intent.save({ session });

        await ReconciliationIssueModel.create(
          [
            {
              issueType: "amount_mismatch",
              externalRef: reference,
              expectedAmount: toDecimal(intent.expectedAmountKobo / 100),
              actualAmount: toDecimal(amountKobo / 100),
              entityType: "subscription",
              entityId: String(subscription._id),
              message: `Paystack charge amount (${amountKobo} kobo) does not match expected (${intent.expectedAmountKobo} kobo). Subscription left in payment_pending. Operator resolution required.`,
            },
          ],
          { session },
        );

        app.log.warn(
          { reference, expected: intent.expectedAmountKobo, received: amountKobo },
          "Amount mismatch on charge.success — subscription NOT auto-credited",
        );

        await appendEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "PaymentAmountMismatch",
            notes: `expected:${intent.expectedAmountKobo} received:${amountKobo} ref:${reference}`,
          },
          session,
        );
        return;
      }

      intent.status = "amount_matched";
      intent.matchedAt = new Date();
      await intent.save({ session });
    }

    // Belt-and-suspenders: verify transaction with Paystack API
    try {
      const verification = await verifyPaystackTransaction(reference);
      if (verification.status !== "success") {
        app.log.error(
          { reference, paystackStatus: verification.status },
          "Paystack verification returned non-success — rejecting charge",
        );
        return;
      }
    } catch (err: any) {
      // If verification fails (e.g. network), still proceed — we have the signed webhook
      app.log.warn(
        { reference, err: err.message },
        "Paystack transaction verification failed — proceeding with signed webhook",
      );
    }

    // Idempotent receipt creation
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

    const isNewReceipt = receipt.createdAt?.getTime() === receipt.updatedAt?.getTime();
    if (!isNewReceipt) {
      app.log.info({ reference }, "Duplicate Paystack webhook — receipt already exists");
      return;
    }

    subscription.status = "paid";
    subscription.externalReceiptRef = reference;
    await subscription.save({ session });

    await LedgerEntryModel.create(
      [
        {
          ledgerType: "escrow",
          accountRef: escrowAccountRef(subscription.offeringId),
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

// Handle charge matched to a PaymentIntent (e.g. DVA or orphan reference)
async function handleChargeWithIntent(
  app: FastifyInstance,
  data: Record<string, unknown>,
  intent: any,
) {
  const reference = data.reference as string;
  const amountKobo = data.amount as number;
  const currency = (data.currency as string | undefined) ?? "NGN";

  await runInTransaction(async (session) => {
    const freshIntent = await PaymentIntentModel.findById(intent._id).session(session);
    if (!freshIntent || freshIntent.status !== "pending") return;

    freshIntent.receivedAmountKobo = amountKobo;

    if (Math.abs(amountKobo - freshIntent.expectedAmountKobo) > AMOUNT_TOLERANCE_KOBO) {
      freshIntent.status = "amount_mismatch";
      await freshIntent.save({ session });
      app.log.warn({ reference, intentId: String(freshIntent._id) }, "DVA amount mismatch");
      return;
    }

    freshIntent.status = "amount_matched";
    freshIntent.matchedAt = new Date();
    await freshIntent.save({ session });

    const subscription = await SubscriptionModel.findById(freshIntent.subscriptionId).session(session);
    if (!subscription || ["paid", "allocation_confirmed"].includes(subscription.status)) return;

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
          metadata: { paystackEvent: "charge.success", via: "dva" },
        },
      },
      { upsert: true, new: true, session },
    );

    const isNewReceipt = receipt.createdAt?.getTime() === receipt.updatedAt?.getTime();
    if (!isNewReceipt) return;

    subscription.status = "paid";
    subscription.externalReceiptRef = reference;
    await subscription.save({ session });

    await LedgerEntryModel.create(
      [
        {
          ledgerType: "escrow",
          accountRef: escrowAccountRef(subscription.offeringId),
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
            via: "dva",
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
        notes: `paystack:${reference} via:dva`,
      },
      session,
    );
  });
}

// ─── transfer.success handler (CRITICAL: closes the fund-loss gap) ───
async function handleTransferSuccess(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const transferCode = data.transfer_code as string;
  const reference = data.reference as string;

  await runInTransaction(async (session) => {
    const transfer = await OutboundTransferModel.findOne({
      $or: [{ transferCode }, { reference }],
    }).session(session);

    if (!transfer) {
      app.log.info({ transferCode, reference }, "transfer.success for unknown transfer — ignoring");
      return;
    }

    if (transfer.status === "success") {
      app.log.info({ transferCode }, "Duplicate transfer.success webhook — ignoring");
      return;
    }

    transfer.status = "success";
    transfer.paystackStatus = (data.status as string) ?? "success";
    transfer.settledAt = new Date();
    transfer.webhookReceivedAt = new Date();
    await transfer.save({ session });

    if (transfer.entityType === "distribution_line") {
      await DistributionLineModel.updateOne(
        { _id: transfer.entityId },
        { status: "paid", paymentRef: transferCode, paidAt: new Date() },
      ).session(session);

      const line = await DistributionLineModel.findById(transfer.entityId).session(session).lean();
      if (line) {
        await checkDistributionCompletion(String(line.distributionId), session, app.log);
      }

      await appendEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "distribution_line",
          entityId: String(transfer.entityId),
          action: "DistributionLinePaid",
          notes: `transfer:${transferCode}`,
        },
        session,
      );

      // Notify investor that their payout has been deposited
      if (line) {
        await createNotificationsFromEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "distribution_line",
            entityId: String(transfer.entityId),
            action: "DistributionLinePaid",
            notes: `investorUserId:${String(line.investorUserId)} amount:${transfer.amountKobo / 100}`,
          },
          session,
        );
      }
    } else if (transfer.entityType === "refund") {
      const subscription = await SubscriptionModel.findById(transfer.entityId).session(session);
      if (subscription && subscription.status === "refund_pending") {
        subscription.status = "refunded";
        await subscription.save({ session });

        // Create escrow debit ledger entry for the refund
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "escrow",
              accountRef: escrowAccountRef(subscription.offeringId),
              direction: "debit",
              amount: toDecimal(transfer.amountKobo / 100),
              currency: transfer.currency,
              entityType: "subscription",
              entityId: String(subscription._id),
              externalRef: transferCode,
              idempotencyKey: `paystack:refund:${reference}`,
              postedAt: new Date(),
              metadata: { reason: "refund", transferCode },
            },
          ],
          { session },
        );

        await appendEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "SubscriptionRefunded",
            notes: `paystack_refund:${transferCode}`,
          },
          session,
        );

        // Notify investor that their refund has been processed
        await createNotificationsFromEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "SubscriptionRefunded",
            notes: `investorUserId:${String(subscription.investorUserId)} amount:${transfer.amountKobo / 100}`,
          },
          session,
        );
      }
    } else if (transfer.entityType === "tranche_release") {
      const tranche = await TrancheModel.findById(transfer.entityId).session(session);
      if (tranche && ["eligible", "processing"].includes(tranche.status)) {
        tranche.status = "released";
        tranche.releasedAt = new Date();
        tranche.payoutReceiptRefs = [reference] as any;
        await tranche.save({ session });

        // Look up business for issuer credit
        const offering = await OfferingModel.findById(tranche.offeringId).session(session).lean();
        const businessId = offering?.businessId ? String(offering.businessId) : "unknown";

        // Debit escrow (funds leaving escrow to issuer)
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "tranche",
              accountRef: escrowAccountRef(tranche.offeringId),
              direction: "debit",
              amount: toDecimal(transfer.amountKobo / 100),
              currency: transfer.currency,
              entityType: "tranche",
              entityId: String(tranche._id),
              externalRef: transferCode,
              idempotencyKey: `paystack:tranche:${reference}:debit`,
              postedAt: new Date(),
              metadata: { transferCode },
            },
          ],
          { session },
        );

        // Credit issuer (funds arriving at issuer bank account)
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "tranche",
              accountRef: `issuer:business:${businessId}`,
              direction: "credit",
              amount: toDecimal(transfer.amountKobo / 100),
              currency: transfer.currency,
              entityType: "tranche",
              entityId: String(tranche._id),
              externalRef: transferCode,
              idempotencyKey: `paystack:tranche:${reference}:credit`,
              postedAt: new Date(),
              metadata: { transferCode, disbursementType: "tranche_payout" },
            },
          ],
          { session },
        );

        await appendEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "tranche",
            entityId: String(tranche._id),
            action: "TrancheReleased",
            notes: `transfer:${transferCode}`,
          },
          session,
        );
      }
    } else if (transfer.entityType === "fund_release") {
      // Fund release to issuer — create escrow debit + issuer credit ledger entries
      const offering = await OfferingModel.findById(transfer.entityId).session(session);
      if (offering) {
        const businessId = String(offering.businessId);
        const amountNaira = transfer.amountKobo / 100;

        // Debit escrow (funds leaving escrow)
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "tranche",
              accountRef: escrowAccountRef(offering._id),
              direction: "debit",
              amount: toDecimal(amountNaira),
              currency: transfer.currency,
              entityType: "offering",
              entityId: String(offering._id),
              externalRef: transferCode,
              idempotencyKey: `paystack:fund-release:${reference}:debit`,
              postedAt: new Date(),
              metadata: { transferCode, disbursementType: "issuer_payout" },
            },
          ],
          { session },
        );

        // Credit issuer (funds arriving at issuer bank)
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "tranche",
              accountRef: `issuer:business:${businessId}`,
              direction: "credit",
              amount: toDecimal(amountNaira),
              currency: transfer.currency,
              entityType: "offering",
              entityId: String(offering._id),
              externalRef: transferCode,
              idempotencyKey: `paystack:fund-release:${reference}:credit`,
              postedAt: new Date(),
              metadata: { transferCode, disbursementType: "issuer_payout" },
            },
          ],
          { session },
        );

        await appendEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "FundReleaseCompleted",
            notes: `transfer:${transferCode} amount:${amountNaira}`,
          },
          session,
        );
      }
    }
  });
}

// ─── transfer.failed handler ───
async function handleTransferFailed(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const transferCode = data.transfer_code as string;
  const reference = data.reference as string;
  const failureReason = (data.reason as string) || (data.message as string) || "Unknown failure";

  await runInTransaction(async (session) => {
    const transfer = await OutboundTransferModel.findOne({
      $or: [{ transferCode }, { reference }],
    }).session(session);

    if (!transfer) {
      app.log.info({ transferCode }, "transfer.failed for unknown transfer — ignoring");
      return;
    }

    if (["failed", "reversed"].includes(transfer.status)) return;

    transfer.status = "failed";
    transfer.paystackStatus = (data.status as string) ?? "failed";
    transfer.failureReason = failureReason;
    transfer.webhookReceivedAt = new Date();
    await transfer.save({ session });

    if (transfer.entityType === "distribution_line") {
      await DistributionLineModel.updateOne(
        { _id: transfer.entityId },
        { status: "failed", failureReason },
      ).session(session);

      const line = await DistributionLineModel.findById(transfer.entityId).session(session).lean();
      if (line) {
        await checkDistributionCompletion(String(line.distributionId), session, app.log);
      }

      await appendEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "distribution_line",
          entityId: String(transfer.entityId),
          action: "DistributionLineFailed",
          notes: `transfer:${transferCode} reason:${failureReason.slice(0, 200)}`,
        },
        session,
      );

      // Notify investor that their payout failed
      if (line) {
        await createNotificationsFromEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "distribution_line",
            entityId: String(transfer.entityId),
            action: "DistributionLineFailed",
            notes: `investorUserId:${String(line.investorUserId)} amount:${transfer.amountKobo / 100}`,
          },
          session,
        );
      }
    } else if (transfer.entityType === "refund") {
      // Revert subscription from refund_pending back to paid
      const subscription = await SubscriptionModel.findById(transfer.entityId).session(session);
      if (subscription && subscription.status === "refund_pending") {
        subscription.status = "paid";
        await subscription.save({ session });

        await appendEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "RefundFailed",
            notes: `transfer:${transferCode} reason:${failureReason.slice(0, 200)}`,
          },
          session,
        );
      }
    } else if (transfer.entityType === "tranche_release") {
      // Revert tranche from processing back to failed
      const tranche = await TrancheModel.findById(transfer.entityId).session(session);
      if (tranche && ["processing", "eligible"].includes(tranche.status)) {
        tranche.status = "failed";
        tranche.failedAt = new Date();
        await tranche.save({ session });

        await appendEvent(
          SYSTEM_ACTOR as any,
          {
            entityType: "tranche",
            entityId: String(tranche._id),
            action: "TrancheFailed",
            notes: `transfer:${transferCode} reason:${failureReason.slice(0, 200)}`,
          },
          session,
        );
      }
    } else if (transfer.entityType === "fund_release") {
      await appendEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "offering",
          entityId: String(transfer.entityId),
          action: "FundReleaseFailed",
          notes: `transfer:${transferCode} reason:${failureReason.slice(0, 200)}`,
        },
        session,
      );
    }

    // Create reconciliation issue for operator attention
    await ReconciliationIssueModel.create(
      [
        {
          issueType: "transfer_failed",
          externalRef: transferCode,
          entityType: transfer.entityType,
          entityId: transfer.entityId,
          actualAmount: toDecimal(transfer.amountKobo / 100),
          message: `Paystack transfer failed: ${failureReason}. Funds remain in Paystack balance.`,
        },
      ],
      { session },
    );
  });
}

// ─── transfer.reversed handler ───
async function handleTransferReversed(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const transferCode = data.transfer_code as string;
  const reference = data.reference as string;

  await runInTransaction(async (session) => {
    const transfer = await OutboundTransferModel.findOne({
      $or: [{ transferCode }, { reference }],
    }).session(session);

    if (!transfer) {
      app.log.info({ transferCode }, "transfer.reversed for unknown transfer — ignoring");
      return;
    }

    if (transfer.status === "reversed") return;

    const previousStatus = transfer.status;
    transfer.status = "reversed";
    transfer.paystackStatus = "reversed";
    transfer.reversedAt = new Date();
    transfer.webhookReceivedAt = new Date();
    await transfer.save({ session });

    // If the transfer was previously "success", we need a reversal ledger entry
    if (previousStatus === "success" && transfer.entityType === "distribution_line") {
      const line = await DistributionLineModel.findById(transfer.entityId).session(session);
      if (line) {
        line.status = "reversed" as any;
        await line.save({ session });

        // Credit back to escrow — the bank returned the funds
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "distribution",
              accountRef: escrowAccountRef(line.offeringId),
              direction: "credit",
              amount: toDecimal(transfer.amountKobo / 100),
              currency: transfer.currency,
              entityType: "distribution_line",
              entityId: String(line._id),
              externalRef: `reversal:${transferCode}`,
              idempotencyKey: `paystack:reversal:${transferCode}`,
              postedAt: new Date(),
              metadata: { reversalOf: transferCode },
            },
          ],
          { session },
        );

        await checkDistributionCompletion(String(line.distributionId), session, app.log);
      }
    } else if (transfer.entityType === "distribution_line") {
      await DistributionLineModel.updateOne(
        { _id: transfer.entityId },
        { status: "failed", failureReason: "Transfer reversed by bank" },
      ).session(session);
    }

    // Handle tranche reversal — credit funds back to escrow if previously released
    if (transfer.entityType === "tranche_release") {
      const tranche = await TrancheModel.findById(transfer.entityId).session(session);
      if (tranche) {
        if (previousStatus === "success" && tranche.status === "released") {
          // Bank reversed a settled tranche payout — credit back to escrow
          tranche.status = "reversed";
          tranche.reversedAt = new Date();
          tranche.reversalReason = "Transfer reversed by bank";
          await tranche.save({ session });

          await LedgerEntryModel.create(
            [
              {
                ledgerType: "tranche",
                accountRef: escrowAccountRef(tranche.offeringId),
                direction: "credit",
                amount: toDecimal(transfer.amountKobo / 100),
                currency: transfer.currency,
                entityType: "tranche",
                entityId: String(tranche._id),
                externalRef: `reversal:${transferCode}`,
                idempotencyKey: `paystack:tranche:reversal:${transferCode}`,
                postedAt: new Date(),
                metadata: { reversalOf: transferCode },
              },
            ],
            { session },
          );
        } else {
          // Transfer reversed before settlement (was still processing)
          tranche.status = "failed";
          tranche.failedAt = new Date();
          await tranche.save({ session });
        }
      }
    }

    // Handle fund release reversal — credit funds back to offering escrow
    if (transfer.entityType === "fund_release" && previousStatus === "success") {
      const offering = await OfferingModel.findById(transfer.entityId).session(session);
      if (offering) {
        await LedgerEntryModel.create(
          [
            {
              ledgerType: "tranche",
              accountRef: escrowAccountRef(offering._id),
              direction: "credit",
              amount: toDecimal(transfer.amountKobo / 100),
              currency: transfer.currency,
              entityType: "offering",
              entityId: String(offering._id),
              externalRef: `reversal:${transferCode}`,
              idempotencyKey: `paystack:fund-release:reversal:${transferCode}`,
              postedAt: new Date(),
              metadata: { reversalOf: transferCode, disbursementType: "issuer_payout_reversal" },
            },
          ],
          { session },
        );
      }
    }

    await appendEvent(
      SYSTEM_ACTOR as any,
      {
        entityType: "outbound_transfer",
        entityId: String(transfer._id),
        action: "TransferReversed",
        notes: `transfer:${transferCode} previousStatus:${previousStatus}`,
      },
      session,
    );

    await ReconciliationIssueModel.create(
      [
        {
          issueType: "transfer_reversed",
          externalRef: transferCode,
          entityType: transfer.entityType,
          entityId: transfer.entityId,
          actualAmount: toDecimal(transfer.amountKobo / 100),
          message: `Paystack transfer reversed by bank. Previous status: ${previousStatus}. Funds returned to Paystack balance.`,
        },
      ],
      { session },
    );
  });
}

// ─── dedicatedaccount.assign.success handler ───
async function handleDVAAssigned(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const dedicatedAccount = data.dedicated_account as Record<string, unknown> | undefined;
  if (!dedicatedAccount) {
    app.log.warn("DVA assign event missing dedicated_account data");
    return;
  }

  const customer = data.customer as Record<string, unknown>;
  const customerCode = customer?.customer_code as string;
  const bank = dedicatedAccount.bank as Record<string, unknown>;

  await DedicatedVirtualAccountModel.findOneAndUpdate(
    { paystackCustomerCode: customerCode },
    {
      $set: {
        bankName: bank?.name ?? "",
        bankCode: String(bank?.id ?? ""),
        accountNumber: dedicatedAccount.account_number as string,
        accountName: dedicatedAccount.account_name as string,
        assignedAt: new Date(),
        active: true,
      },
    },
    { upsert: false },
  );

  app.log.info(
    { customerCode, accountNumber: dedicatedAccount.account_number },
    "DVA assigned via webhook",
  );
}

// ─── refund.processed handler ───
async function handleRefundProcessed(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const transaction = data.transaction as Record<string, unknown> | undefined;
  const reference = transaction?.reference as string | undefined;
  if (!reference) return;

  await runInTransaction(async (session) => {
    const transfer = await OutboundTransferModel.findOne({
      entityType: "refund",
      reference: { $regex: reference },
    }).session(session);

    if (!transfer) {
      app.log.info({ reference }, "refund.processed for unknown transfer — ignoring");
      return;
    }

    if (transfer.status === "success") return;

    transfer.status = "success";
    transfer.settledAt = new Date();
    transfer.webhookReceivedAt = new Date();
    await transfer.save({ session });

    const subscription = await SubscriptionModel.findById(transfer.entityId).session(session);
    if (subscription && subscription.status === "refund_pending") {
      subscription.status = "refunded";
      await subscription.save({ session });

      await postLedger(
        {
          ledgerType: "escrow",
          accountRef: escrowAccountRef(subscription.offeringId),
          direction: "debit",
          amount: transfer.amountKobo / 100,
          currency: transfer.currency,
          entityType: "subscription",
          entityId: String(subscription._id),
          externalRef: `refund:${reference}`,
          idempotencyKey: `paystack:refund:${reference}`,
          metadata: { reason: "refund" },
        },
        session,
      );

      await appendEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "subscription",
          entityId: String(subscription._id),
          action: "SubscriptionRefunded",
          notes: `refund processed ref:${reference}`,
        },
        session,
      );

      // Notify investor that their refund has been processed
      await createNotificationsFromEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "subscription",
          entityId: String(subscription._id),
          action: "SubscriptionRefunded",
          notes: `investorUserId:${String(subscription.investorUserId)} amount:${transfer.amountKobo / 100}`,
        },
        session,
      );
    }
  });
}

// ─── refund.failed handler (§4: prevents subscriptions stuck in refund_pending) ───
async function handleRefundFailed(
  app: FastifyInstance,
  data: Record<string, unknown>,
) {
  const transaction = data.transaction as Record<string, unknown> | undefined;
  const reference = (transaction?.reference as string | undefined) ?? (data.reference as string | undefined);
  if (!reference) {
    app.log.warn("refund.failed event missing transaction reference");
    return;
  }

  await runInTransaction(async (session) => {
    const transfer = await OutboundTransferModel.findOne({
      entityType: "refund",
      reference: { $regex: reference },
    }).session(session);

    if (transfer && transfer.status === "pending") {
      transfer.status = "failed";
      transfer.failureReason = (data.reason as string) || "Refund failed";
      transfer.webhookReceivedAt = new Date();
      await transfer.save({ session });
    }

    // Revert the subscription out of refund_pending so it can be retried.
    const subscriptionId = transfer?.entityId;
    const subscription = subscriptionId
      ? await SubscriptionModel.findById(subscriptionId).session(session)
      : null;
    if (subscription && subscription.status === "refund_pending") {
      subscription.status = "paid";
      await subscription.save({ session });

      await appendEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "subscription",
          entityId: String(subscription._id),
          action: "SubscriptionRefundFailed",
          notes: `refund failed ref:${reference} — reverted to paid for retry`,
        },
        session,
      );

      await createNotificationsFromEvent(
        SYSTEM_ACTOR as any,
        {
          entityType: "subscription",
          entityId: String(subscription._id),
          action: "SubscriptionRefundFailed",
          notes: `investorUserId:${String(subscription.investorUserId)} refund failed — will be retried`,
        },
        session,
      );
    }
  });
}

// ─── Event dispatcher ───
type WebhookHandler = (
  app: FastifyInstance,
  data: Record<string, unknown>,
) => Promise<void>;

const EVENT_HANDLERS: Record<string, WebhookHandler> = {
  "charge.success": handleChargeSuccess,
  "transfer.success": handleTransferSuccess,
  "transfer.failed": handleTransferFailed,
  "transfer.reversed": handleTransferReversed,
  "dedicatedaccount.assign.success": handleDVAAssigned,
  "refund.processed": handleRefundProcessed,
  "refund.failed": handleRefundFailed,
};

// §4: Validate signed webhook payloads. The HMAC proves origin, but a malformed
// (or schema-drifted) body must not yield NaN amounts in financial postings.
// `.passthrough()` tolerates extra fields Paystack may add.
const chargeDataSchema = z
  .object({
    reference: z.string().min(1),
    amount: z.number().int().nonnegative(),
    currency: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

const transferDataSchema = z
  .object({
    transfer_code: z.string().min(1),
    reference: z.string().min(1),
    status: z.string().optional(),
  })
  .passthrough();

const refundDataSchema = z
  .object({
    transaction: z.object({ reference: z.string().min(1) }).passthrough().optional(),
    reference: z.string().min(1).optional(),
  })
  .passthrough()
  .refine((d) => d.transaction?.reference || d.reference, {
    message: "refund payload must carry a transaction reference",
  });

const EVENT_DATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "charge.success": chargeDataSchema,
  "transfer.success": transferDataSchema,
  "transfer.failed": transferDataSchema,
  "transfer.reversed": transferDataSchema,
  "refund.processed": refundDataSchema,
  "refund.failed": refundDataSchema,
};

export class PaystackInboxPayloadError extends Error {}

/** A provider event can be retried safely only after this validation boundary. */
export async function processPaystackInboxEvent(
  app: FastifyInstance,
  eventType: string,
  data: Record<string, unknown>,
  providerEventId?: string,
  receivedAt?: Date,
): Promise<void> {
  const handler = EVENT_HANDLERS[eventType];
  if (!handler) {
    app.log.info({ eventType }, "Unhandled Paystack event type — recorded without business effect");
    return;
  }
  const schema = EVENT_DATA_SCHEMAS[eventType];
  if (schema) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackInboxPayloadError(`Paystack ${eventType} payload validation failed`);
    }
  }
  // New PostgreSQL payment intents are selected by their provider reference.
  // A legacy MongoDB reference is deliberately not mirrored: it stays wholly
  // on its current path until that commitment is explicitly migrated.
  if (eventType === "charge.success" && providerEventId) {
    const reference = data.reference;
    const amount = data.amount;
    const eventCurrency = data.currency ?? "NGN";
    if (typeof reference === "string" && typeof amount === "number" && typeof eventCurrency === "string") {
      try {
        const receipt = await recordProviderPaymentReceipt({
          provider: "paystack",
          providerReference: reference,
          providerEventId,
          amountMinor: amount,
          currency: eventCurrency,
          receivedAt: receivedAt ?? new Date(),
          metadata: { paystackData: data },
        });
        app.log.info({ paymentIntentId: receipt.paymentIntentId, receiptId: receipt.receiptId, status: receipt.status }, "Paystack receipt recorded in PostgreSQL payment domain");
        return;
      } catch (error) {
        if (!(error instanceof PaymentIntentNotFoundError)) throw error;
      }
    }
  }
  if (eventType === "transfer.success" || eventType === "transfer.failed" || eventType === "transfer.reversed") {
    const reference = data.reference;
    const transferCode = data.transfer_code;
    if (typeof reference === "string" && typeof transferCode === "string") {
      const outcome = eventType === "transfer.success" ? "success" : eventType === "transfer.failed" ? "failed" : "reversed";
      const amount = data.amount;
      const currency = data.currency;
      if (typeof amount === "number" && typeof currency === "string") {
        const distributionResult = await recordDistributionPayoutProviderOutcome({
          outcome,
          reference,
          transferCode,
          amountMinor: amount,
          currency,
          reason: typeof data.reason === "string" ? data.reason : typeof data.message === "string" ? data.message : undefined,
          occurredAt: receivedAt,
          source: "webhook",
        });
        if (distributionResult.handled) {
          app.log.info({ payoutInstructionId: distributionResult.payoutInstructionId, status: distributionResult.status }, "Paystack distribution payout outcome recorded in PostgreSQL");
          return;
        }
      }
      const result = await recordProfessionalPayoutProviderOutcome({
        outcome,
        reference,
        transferCode,
        amountMinor: typeof amount === "number" ? amount : undefined,
        currency: typeof currency === "string" ? currency : undefined,
        reason: typeof data.reason === "string" ? data.reason : typeof data.message === "string" ? data.message : undefined,
        occurredAt: receivedAt,
        source: "webhook",
      });
      if (result.handled) {
        app.log.info({ payoutInstructionId: result.payoutInstructionId, status: result.status }, "Paystack professional payout outcome recorded in PostgreSQL");
        return;
      }
    }
  }
  await handler(app, data);
}

function paystackExternalEventId(eventType: string, data: Record<string, unknown>, rawBody: string): string {
  const candidate = data.transfer_code ?? data.reference ?? data.id;
  const identity = typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : hashPayload(rawBody);
  return `${eventType}:${identity}`;
}

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
        return reply.status(env.NODE_ENV === "production" ? 503 : 200).send(
          env.NODE_ENV === "production" ? { error: "Payment webhook is not enabled" } : { ok: true },
        );
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
      const eventType = typeof event.event === "string" ? event.event : "unknown";
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (!env.PAYSTACK_INBOX_ENABLED) {
        if (env.NODE_ENV === "production") {
          return reply.status(503).send({ error: "Payment webhook intake is not configured" });
        }
        await processPaystackInboxEvent(app, eventType, data);
        return reply.status(200).send({ ok: true, legacy: true });
      }

      try {
        const accepted = await receiveInboxEvent({
          provider: "paystack",
          externalEventId: paystackExternalEventId(eventType, data, rawBody),
          payload: { eventType, data, rawBody, signature },
        });
        return reply.status(200).send({ ok: true, queued: true, deduplicated: accepted.duplicate });
      } catch (error) {
        if (error instanceof InboxPayloadConflictError) {
          app.log.error({ err: error, eventType }, "Conflicting Paystack webhook replay");
          return reply.status(409).send({ error: "Conflicting webhook replay" });
        }
        app.log.error({ err: error, eventType }, "Unable to durably accept Paystack webhook");
        return reply.status(503).send({ error: "Webhook intake unavailable" });
      }
    },
  );
}

// Export for use by sweep workers (process missed webhooks idempotently)
export { handleChargeSuccess, handleTransferSuccess, handleTransferFailed, checkDistributionCompletion };
