import { randomUUID } from "node:crypto";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { UserModel } from "./db/models.js";
import { applyPostgresMigrations } from "./db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, withPostgresTransaction } from "./db/postgres.js";
import { roles } from "./utils/constants.js";

if (process.env.IDENTITY_BACKFILL_CONFIRM !== "COPY_MONGO_IDENTITIES") {
  throw new Error("Refusing identity import. Set IDENTITY_BACKFILL_CONFIRM=COPY_MONGO_IDENTITIES after reviewing the cutover runbook.");
}

type LegacyUser = {
  _id: { toString(): string };
  email: string;
  name: string;
  role: string;
  status?: "active" | "disabled";
  passwordHash?: string;
  emailVerified?: boolean;
  tokenInvalidatedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

try {
  await connectMongo();
  await connectPostgres({ required: true });
  await applyPostgresMigrations();

  let imported = 0;
  for await (const user of UserModel.find({}).lean().cursor() as AsyncIterable<LegacyUser>) {
    const legacyId = user._id.toString();
    const email = user.email.toLowerCase();
    if (!(roles as readonly string[]).includes(user.role)) {
      throw new Error(`Legacy identity ${legacyId} has an unsupported global role`);
    }
    await withPostgresTransaction(async (client) => {
      const conflict = await client.query<{ legacy_mongo_id: string | null }>(
        "SELECT legacy_mongo_id FROM fractal.identities WHERE email = $1 FOR UPDATE",
        [email],
      );
      const existing = conflict.rows[0];
      if (existing && existing.legacy_mongo_id !== legacyId) {
        throw new Error(`Identity email conflict for ${email}; PostgreSQL row is not mapped to legacy user ${legacyId}`);
      }

      const result = await client.query<{ id: string }>(
        `INSERT INTO fractal.identities
           (id, legacy_mongo_id, email, legal_name, status, password_hash, email_verified_at, credential_invalidated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), COALESCE($10, now()))
         ON CONFLICT (legacy_mongo_id) DO UPDATE
           SET email = EXCLUDED.email,
               legal_name = EXCLUDED.legal_name,
               status = EXCLUDED.status,
               password_hash = EXCLUDED.password_hash,
               email_verified_at = EXCLUDED.email_verified_at,
               credential_invalidated_at = EXCLUDED.credential_invalidated_at,
               updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [
          randomUUID(),
          legacyId,
          email,
          user.name,
          user.status === "disabled" ? "disabled" : "active",
          user.passwordHash ?? null,
          user.emailVerified ? user.updatedAt ?? new Date() : null,
          user.tokenInvalidatedAt ?? null,
          user.createdAt ?? null,
          user.updatedAt ?? null,
        ],
      );
      const identityId = result.rows[0]?.id;
      if (!identityId) throw new Error(`Identity import did not return an ID for ${legacyId}`);
      await client.query(
        `UPDATE fractal.identity_role_assignments
            SET revoked_at = now()
          WHERE identity_id = $1
            AND scope_type = 'global'
            AND revoked_at IS NULL
            AND role <> $2`,
        [identityId, user.role],
      );
      await client.query(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, $3, 'global')
         ON CONFLICT (identity_id, role, scope_type, scope_id) DO UPDATE SET revoked_at = NULL`,
        [randomUUID(), identityId, user.role],
      );
    });
    imported += 1;
  }
  console.log(`Imported or refreshed ${imported} legacy identities into PostgreSQL. Run db:identity:verify and the approved frozen-write cutover procedure before selecting PostgreSQL authority.`);
} finally {
  await disconnectPostgres();
  await disconnectMongo();
}
