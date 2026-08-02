import { beforeEach, describe, expect, it, vi } from "vitest";

const transaction = vi.hoisted(() => vi.fn());
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: transaction }));

import { PostgresIdempotencyConflictError, runPostgresIdempotentCommand } from "../postgres-idempotency.js";
import { hashPayload } from "../../utils/idempotency.js";

function execute() { return vi.fn().mockResolvedValue({ body: { ok: true }, status: 201 }); }
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}
beforeEach(() => transaction.mockReset());

describe("PostgreSQL idempotent commands", () => {
  const base = { actorIdentityId: "actor-1", scopeKey: "organization:org-1", route: "/v1/test", payload: { value: 1 }, expiresAt: new Date("2026-08-01T00:00:00.000Z") };

  it("runs a command normally when no command key is supplied", async () => {
    const run = execute();
    transactionWithResponses();
    await expect(runPostgresIdempotentCommand({ ...base, execute: run })).resolves.toEqual({ body: { ok: true }, status: 201, replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("persists the first attributed command response", async () => {
    const run = execute();
    const query = transactionWithResponses({ rowCount: 1 }, { rowCount: 1 });
    await expect(runPostgresIdempotentCommand({ ...base, commandKey: "key-1", execute: run })).resolves.toMatchObject({ replayed: false, status: 201 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a completed matching response without replaying the business write", async () => {
    const run = execute();
    transactionWithResponses({ rowCount: 0 }, { rows: [{ actor_identity_id: "actor-1", attribution_status: "attributed", request_hash: hashPayload(base.payload), response_body: { saved: true }, response_status: 202 }] });
    await expect(runPostgresIdempotentCommand({ ...base, commandKey: "key-1", execute: run })).resolves.toEqual({ body: { saved: true }, status: 202, replayed: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects blank actors and conflicting command payloads", async () => {
    transactionWithResponses();
    await expect(runPostgresIdempotentCommand({ ...base, actorIdentityId: " ", commandKey: "key-1", execute: execute() })).rejects.toThrow("attributed actor");
    transactionWithResponses({ rowCount: 0 }, { rows: [{ actor_identity_id: "other-actor", attribution_status: "attributed", request_hash: "anything", response_body: { ok: true }, response_status: 200 }] });
    await expect(runPostgresIdempotentCommand({ ...base, commandKey: "key-1", execute: execute() })).rejects.toThrow("cannot be reused");
  });
});
