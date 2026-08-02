import type { PoolClient } from "pg";

const DATA_LIFECYCLE_LOCK = 4_182_901_519;

export async function lockDataLifecycleAuthority(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [DATA_LIFECYCLE_LOCK]);
}
