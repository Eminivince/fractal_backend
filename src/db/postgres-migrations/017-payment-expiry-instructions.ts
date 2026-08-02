import type { PostgresMigration } from "./types.js";

/** A terminally expired payment instruction must never be claimed again. */
export const paymentExpiryInstructionsMigration: PostgresMigration = {
  version: "017-payment-expiry-instructions",
  sql: `
    ALTER TABLE fractal.payment_provider_instructions
      DROP CONSTRAINT IF EXISTS payment_provider_instructions_status_check;
    ALTER TABLE fractal.payment_provider_instructions
      ADD CONSTRAINT payment_provider_instructions_status_check
      CHECK (status IN ('pending', 'initialized', 'failed', 'cancelled'));
  `,
};
