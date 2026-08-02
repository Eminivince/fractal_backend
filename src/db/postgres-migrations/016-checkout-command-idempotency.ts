import type { PostgresMigration } from "./types.js";

/** Idempotency identity belongs to the reservation, not an HTTP process. */
export const checkoutCommandIdempotencyMigration: PostgresMigration = {
  version: "016-checkout-command-idempotency",
  sql: `
    ALTER TABLE fractal.investment_reservations
      ADD COLUMN IF NOT EXISTS command_key TEXT,
      ADD COLUMN IF NOT EXISTS eligibility_snapshot_id UUID REFERENCES fractal.investment_eligibility_snapshots(id),
      ADD COLUMN IF NOT EXISTS agreement_acceptance_id UUID REFERENCES fractal.agreement_acceptances(id);

    CREATE UNIQUE INDEX IF NOT EXISTS investment_reservations_checkout_command_key
      ON fractal.investment_reservations (offering_id, investor_identity_id, command_key)
      WHERE command_key IS NOT NULL;
  `,
};
