import type { PostgresMigration } from "./types.js";

/**
 * Makes privileged identity changes explicit, reviewable commands. The
 * database owns the before-state snapshot and prevents more than one pending
 * change for a target, so two browser requests cannot race an account into an
 * unreviewed state.
 */
export const identityAccessGovernanceMigration: PostgresMigration = {
  version: "058-identity-access-governance",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.identity_access_change_requests (
      id UUID PRIMARY KEY,
      target_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      change_type TEXT NOT NULL CHECK (change_type IN ('change_role', 'suspend', 'restore')),
      prior_role TEXT CHECK (prior_role IS NULL OR prior_role IN ('admin', 'operator', 'issuer', 'investor', 'professional')),
      proposed_role TEXT CHECK (proposed_role IS NULL OR proposed_role IN ('admin', 'operator', 'issuer', 'investor', 'professional')),
      prior_status TEXT NOT NULL CHECK (prior_status IN ('active', 'disabled')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 2000),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT identity_access_change_role_shape CHECK (
        (change_type = 'change_role' AND proposed_role IS NOT NULL AND prior_status = 'active' AND prior_role IS DISTINCT FROM proposed_role)
        OR (change_type IN ('suspend', 'restore') AND proposed_role IS NULL)
      ),
      CONSTRAINT identity_access_change_status_shape CHECK (
        (status = 'pending' AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status = 'rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
        OR (status = 'applied' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
        OR (status = 'cancelled' AND reviewed_at IS NULL AND applied_at IS NULL)
      ),
      CONSTRAINT identity_access_change_independent_reviewer CHECK (
        reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> requested_by_identity_id
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS identity_access_change_target_pending_unique_idx
      ON fractal.identity_access_change_requests (target_identity_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS identity_access_change_pending_queue_idx
      ON fractal.identity_access_change_requests (requested_at, id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS identity_access_change_history_idx
      ON fractal.identity_access_change_requests (target_identity_id, requested_at DESC, id DESC);
  `,
};
