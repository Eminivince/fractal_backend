import type { PostgresMigration } from "./types.js";

export const organizationsAndMembershipsMigration: PostgresMigration = {
  version: "006-organizations-and-memberships",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.organizations (
      id UUID PRIMARY KEY,
      legal_name TEXT NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 240),
      registration_number TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fractal.organization_memberships (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'offering_manager', 'finance_operator', 'compliance_reviewer', 'viewer')),
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
      invited_by_identity_id UUID REFERENCES fractal.identities(id),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
      UNIQUE (organization_id, identity_id)
    );
    CREATE INDEX IF NOT EXISTS organization_memberships_identity_active_idx
      ON fractal.organization_memberships (identity_id, organization_id)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS fractal.organization_invitations (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      email TEXT NOT NULL CHECK (email = lower(email)),
      role TEXT NOT NULL CHECK (role IN ('administrator', 'offering_manager', 'finance_operator', 'compliance_reviewer', 'viewer')),
      token_hash CHAR(64) NOT NULL UNIQUE,
      invited_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (expires_at > created_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_open_email_idx
      ON fractal.organization_invitations (organization_id, email)
      WHERE accepted_at IS NULL AND revoked_at IS NULL;
  `,
};
