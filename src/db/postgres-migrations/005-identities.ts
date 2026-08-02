import type { PostgresMigration } from "./types.js";

export const identitiesMigration: PostgresMigration = {
  version: "005-identities",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.identities (
      id UUID PRIMARY KEY,
      legacy_mongo_id TEXT UNIQUE,
      email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
      legal_name TEXT NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      password_hash TEXT,
      email_verified_at TIMESTAMPTZ,
      credential_invalidated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fractal.identity_role_assignments (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      role TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'organization', 'professional')),
      scope_id UUID,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type <> 'global' AND scope_id IS NOT NULL)),
      UNIQUE NULLS NOT DISTINCT (identity_id, role, scope_type, scope_id)
    );
    CREATE INDEX IF NOT EXISTS identity_role_assignments_active_idx
      ON fractal.identity_role_assignments (identity_id, scope_type, scope_id)
      WHERE revoked_at IS NULL;
  `,
};
