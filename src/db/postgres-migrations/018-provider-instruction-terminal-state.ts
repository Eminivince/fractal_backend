import type { PostgresMigration } from "./types.js";

/** Separate retryable provider failure from a terminally unprocessable command. */
export const providerInstructionTerminalStateMigration: PostgresMigration = {
  version: "018-provider-instruction-terminal-state",
  sql: `
    ALTER TABLE fractal.payment_provider_instructions
      ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS payment_provider_instructions_retryable_idx
      ON fractal.payment_provider_instructions (next_attempt_at, created_at, id)
      WHERE status IN ('pending', 'failed') AND terminal_at IS NULL;
  `,
};
