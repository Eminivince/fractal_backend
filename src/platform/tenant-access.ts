import { requirePostgres } from "../db/postgres.js";

export const organizationMembershipRoles = [
  "owner",
  "administrator",
  "offering_manager",
  "finance_operator",
  "compliance_reviewer",
  "viewer",
] as const;

export type OrganizationMembershipRole = (typeof organizationMembershipRoles)[number];

export class TenantAccessError extends Error {}

/**
 * The only supported organization-scope check for new PostgreSQL domains.
 * A missing, revoked, suspended, or wrong-role membership is intentionally the
 * same denial, so callers do not disclose tenant membership details.
 */
export async function requireOrganizationAccess(input: {
  identityId: string;
  organizationId: string;
  allowedRoles?: readonly OrganizationMembershipRole[];
}): Promise<{ role: OrganizationMembershipRole }> {
  const allowedRoles = input.allowedRoles ?? organizationMembershipRoles;
  const result = await requirePostgres().query<{ role: OrganizationMembershipRole }>(
    `SELECT membership.role
       FROM fractal.organization_memberships membership
       JOIN fractal.organizations organization ON organization.id = membership.organization_id
      WHERE membership.identity_id = $1
        AND membership.organization_id = $2
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND organization.status = 'active'
        AND membership.role = ANY($3::text[])`,
    [input.identityId, input.organizationId, allowedRoles],
  );
  const membership = result.rows[0];
  if (!membership) throw new TenantAccessError("Access denied to organization");
  return membership;
}

export async function listAccessibleOrganizations(identityId: string) {
  const result = await requirePostgres().query<{
    id: string;
    legal_name: string;
    role: OrganizationMembershipRole;
  }>(
    `SELECT organization.id, organization.legal_name, membership.role
       FROM fractal.organization_memberships membership
       JOIN fractal.organizations organization ON organization.id = membership.organization_id
      WHERE membership.identity_id = $1
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND organization.status = 'active'
      ORDER BY organization.legal_name, organization.id`,
    [identityId],
  );
  return result.rows.map((row) => ({ id: row.id, legalName: row.legal_name, role: row.role }));
}
