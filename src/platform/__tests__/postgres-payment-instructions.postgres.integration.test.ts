import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import { createPaymentCommitment } from "../postgres-payments.js";
import { claimOutboxEvents, markOutboxEventPublished } from "../postgres-outbox.js";
import { projectPaymentIntentCreated } from "../postgres-payment-instructions.js";
import { dispatchPendingPaymentProviderInstructions } from "../../services/payment-instruction-dispatcher.js";
import { PaystackRequestError } from "../../services/paystack.js";

describe("PostgreSQL payment provider instructions", () => {
  let organizationId = "";
  let investorId = "";

  beforeAll(async () => { await connectPostgres({ required: true }); await applyPostgresMigrations(); });
  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.payment_provider_instructions, fractal.investment_reservations, fractal.payment_reconciliation_cases, fractal.payment_receipts, fractal.payment_intents, fractal.investment_commitments, fractal.journal_postings, fractal.journal_entries, fractal.ledger_accounts, fractal.security_notifications, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events CASCADE");
    organizationId = randomUUID(); investorId = randomUUID();
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, $2, 'active')", [organizationId, `Provider org ${organizationId}`]);
    await postgresQuery("INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Payment investor', 'active')", [investorId, `provider-${investorId}@example.test`]);
  });
  afterAll(async () => { await disconnectPostgres(); });

  it("projects a payment intent into one leased provider instruction and persists the returned checkout", async () => {
    const payment = await createPaymentCommitment({
      organizationId, investorIdentityId: investorId, offeringReference: "offering:provider-test", currency: "NGN", committedMinor: 125_050,
      provider: "paystack", providerReference: "provider-reference-1", expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const [event] = await claimOutboxEvents({ workerId: "projector", eventTypes: ["payment.intent.created"], limit: 1, claimTimeoutSeconds: 60 });
    expect(event?.aggregateId).toBe(payment.paymentIntentId);
    await withPostgresTransaction(async (client) => {
      await projectPaymentIntentCreated(client, event!);
      await markOutboxEventPublished(client, event!.id, "projector");
    });
    const logger = { info: () => undefined, error: () => undefined };
    const dispatched = await dispatchPendingPaymentProviderInstructions({
      workerId: "paystack-worker", logger,
      initialize: async (input) => {
        expect(input).toMatchObject({ amountKobo: 125_050, reference: "provider-reference-1", metadata: { paymentIntentId: payment.paymentIntentId } });
        return { authorization_url: "https://checkout.example.test/1", access_code: "access-1", reference: input.reference };
      },
    });
    expect(dispatched).toBe(1);
    const instruction = await postgresQuery<{ status: string; checkout_url: string; provider_access_code: string }>(
      "SELECT status, checkout_url, provider_access_code FROM fractal.payment_provider_instructions WHERE payment_intent_id = $1", [payment.paymentIntentId],
    );
    expect(instruction.rows[0]).toEqual({ status: "initialized", checkout_url: "https://checkout.example.test/1", provider_access_code: "access-1" });
  });

  it("marks an unsupported provider instruction terminal so it cannot loop forever", async () => {
    const payment = await createPaymentCommitment({
      organizationId, investorIdentityId: investorId, offeringReference: "offering:terminal-test", currency: "NGN", committedMinor: 10_000,
      provider: "unsupported", providerReference: "unsupported-reference-1", expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const [event] = await claimOutboxEvents({ workerId: "projector", eventTypes: ["payment.intent.created"], limit: 1, claimTimeoutSeconds: 60 });
    await withPostgresTransaction(async (client) => { await projectPaymentIntentCreated(client, event!); await markOutboxEventPublished(client, event!.id, "projector"); });
    const logger = { info: () => undefined, error: () => undefined };
    expect(await dispatchPendingPaymentProviderInstructions({ workerId: "unsupported-worker", logger })).toBe(1);
    expect(await dispatchPendingPaymentProviderInstructions({ workerId: "unsupported-worker", logger })).toBe(0);
    const instruction = await postgresQuery<{ status: string; terminal_at: Date | null }>(
      "SELECT status, terminal_at FROM fractal.payment_provider_instructions WHERE payment_intent_id = $1", [payment.paymentIntentId],
    );
    expect(instruction.rows[0]?.status).toBe("failed");
    expect(instruction.rows[0]?.terminal_at).toBeTruthy();
  });

  it("does not retry a terminal Paystack request error", async () => {
    const payment = await createPaymentCommitment({
      organizationId, investorIdentityId: investorId, offeringReference: "offering:paystack-terminal-test", currency: "NGN", committedMinor: 10_000,
      provider: "paystack", providerReference: "paystack-terminal-reference", expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const [event] = await claimOutboxEvents({ workerId: "projector", eventTypes: ["payment.intent.created"], limit: 1, claimTimeoutSeconds: 60 });
    await withPostgresTransaction(async (client) => { await projectPaymentIntentCreated(client, event!); await markOutboxEventPublished(client, event!.id, "projector"); });
    const logger = { info: () => undefined, error: () => undefined };
    await dispatchPendingPaymentProviderInstructions({
      workerId: "paystack-terminal-worker", logger,
      initialize: async () => { throw new PaystackRequestError("invalid Paystack request", false, 400); },
    });
    expect(await dispatchPendingPaymentProviderInstructions({ workerId: "paystack-terminal-worker", logger })).toBe(0);
    const instruction = await postgresQuery<{ terminal_at: Date | null }>(
      "SELECT terminal_at FROM fractal.payment_provider_instructions WHERE payment_intent_id = $1", [payment.paymentIntentId],
    );
    expect(instruction.rows[0]?.terminal_at).toBeTruthy();
  });
});
