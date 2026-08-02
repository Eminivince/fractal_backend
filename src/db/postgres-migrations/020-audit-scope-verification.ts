import type { PostgresMigration } from "./types.js";

/** Persist the scope that is already part of every new audit-event hash. */
export const auditScopeVerificationMigration: PostgresMigration = {
  version: "020-audit-scope-verification",
  sql: `
    ALTER TABLE fractal.audit_events ADD COLUMN IF NOT EXISTS scope_key TEXT;
    CREATE INDEX IF NOT EXISTS audit_events_scope_sequence_idx
      ON fractal.audit_events (scope_key, sequence)
      WHERE scope_key IS NOT NULL;
  `,
};
