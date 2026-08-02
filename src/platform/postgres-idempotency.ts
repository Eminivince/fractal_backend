import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hashPayload } from "../utils/idempotency.js";
import { withPostgresTransaction } from "../db/postgres.js";

export class PostgresIdempotencyConflictError extends Error {}

interface StoredResponse<T> {
  actor_identity_id: string | null;
  attribution_status: "attributed" | "legacy_unattributed";
  response_body: T | null;
  response_status: number | null;
  request_hash: string;
}

export interface PostgresIdempotentCommandOptions<T> {
  actorIdentityId: string;
  scopeKey: string;
  route: string;
  commandKey?: string;
  payload: unknown;
  expiresAt: Date;
  execute: (client: PoolClient) => Promise<{ body: T; status: number }>;
}

/**
 * Runs the business write, response persistence, and outbox writes made by
 * `execute` in one PostgreSQL transaction. A duplicate command either returns
 * the original response or rejects a payload mismatch; it can never replay the
 * business write.
 */
export async function runPostgresIdempotentCommand<T>(
  options: PostgresIdempotentCommandOptions<T>,
): Promise<{ body: T; status: number; replayed: boolean }> {
  return withPostgresTransaction(async (client) => {
    if (!options.commandKey) {
      const result = await options.execute(client);
      return { ...result, replayed: false };
    }

    const actorIdentityId = options.actorIdentityId.trim();
    if (!actorIdentityId) throw new PostgresIdempotencyConflictError("Idempotent commands require an attributed actor");
    const requestHash = hashPayload(options.payload);
    const inserted = await client.query(
      `INSERT INTO fractal.idempotency_commands
         (id, actor_identity_id, scope_key, route, command_key, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scope_key, route, command_key) DO NOTHING
       RETURNING id`,
      [randomUUID(), actorIdentityId, options.scopeKey, options.route, options.commandKey, requestHash, options.expiresAt],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<StoredResponse<T>>(
        `SELECT actor_identity_id, attribution_status, request_hash, response_body, response_status
           FROM fractal.idempotency_commands
          WHERE scope_key = $1 AND route = $2 AND command_key = $3
          FOR UPDATE`,
        [options.scopeKey, options.route, options.commandKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Idempotency command disappeared during conflict resolution");
      if (row.attribution_status !== "attributed" || !row.actor_identity_id) {
        throw new PostgresIdempotencyConflictError("Command key cannot be reused; submit a new command key");
      }
      if (row.actor_identity_id !== actorIdentityId) {
        throw new PostgresIdempotencyConflictError("Command key cannot be reused; submit a new command key");
      }
      if (row.request_hash !== requestHash) {
        throw new PostgresIdempotencyConflictError("Command key has already been used with a different payload");
      }
      if (row.response_body === null || row.response_status === null) {
        throw new Error("Idempotency command exists without a completed response");
      }
      return { body: row.response_body, status: row.response_status, replayed: true };
    }

    const result = await options.execute(client);
    const updated = await client.query(
      `UPDATE fractal.idempotency_commands
          SET response_body = $1, response_status = $2
        WHERE scope_key = $3 AND route = $4 AND command_key = $5
          AND actor_identity_id = $6 AND attribution_status = 'attributed'`,
      [result.body, result.status, options.scopeKey, options.route, options.commandKey, actorIdentityId],
    );
    if (updated.rowCount !== 1) throw new Error("Attributed idempotency command disappeared before response persistence");
    return { ...result, replayed: false };
  });
}
