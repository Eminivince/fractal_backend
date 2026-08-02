import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "../config/env.js";

let pool: Pool | null = null;

export async function connectPostgres({ required = env.POSTGRES_REQUIRED }: { required?: boolean } = {}): Promise<void> {
  if (pool) return;
  if (!env.DATABASE_URL) {
    if (required) throw new Error("DATABASE_URL is required for this runtime");
    return;
  }

  const nextPool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.POSTGRES_POOL_SIZE,
    ssl: env.POSTGRES_SSL ? { rejectUnauthorized: true } : undefined,
  });

  try {
    await nextPool.query("SELECT 1");
    pool = nextPool;
  } catch (error) {
    await nextPool.end();
    if (required) throw error;
    console.warn("[postgres] Failed to connect; Postgres-backed features are disabled");
  }
}

export async function disconnectPostgres(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export function getPostgres(): Pool | null {
  return pool;
}

export function requirePostgres(): Pool {
  if (!pool) throw new Error("PostgreSQL is not connected");
  return pool;
}

export async function withPostgresTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await requirePostgres().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function postgresQuery<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) {
  return requirePostgres().query<Row>(text, values ? [...values] : undefined);
}
