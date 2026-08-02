import type { PostgresMigration } from "./types.js";

/** Durable, worker-owned instructions for external payment-provider calls. */
export const paymentProviderInstructionsMigration: PostgresMigration = {
  version: "015-payment-provider-instructions",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.payment_provider_instructions (
      id UUID PRIMARY KEY,
      payment_intent_id UUID NOT NULL UNIQUE REFERENCES fractal.payment_intents(id),
      outbox_event_id UUID NOT NULL UNIQUE REFERENCES fractal.outbox_events(id),
      provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'initialized', 'failed')),
      checkout_url TEXT,
      provider_access_code TEXT,
      initialized_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'initialized') = (initialized_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS payment_provider_instructions_claimable_idx
      ON fractal.payment_provider_instructions (provider, next_attempt_at, created_at, id)
      WHERE status IN ('pending', 'failed');
  `,
};
