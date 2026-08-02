import type { PostgresMigration } from "./types.js";

export const auditChainHeadsMigration: PostgresMigration = {
  version: "002-audit-chain-heads",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.audit_chain_heads (
      scope_key TEXT PRIMARY KEY,
      latest_sequence BIGINT NOT NULL,
      latest_hash CHAR(64) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `,
};
