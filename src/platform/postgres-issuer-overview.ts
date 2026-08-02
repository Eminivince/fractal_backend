import { requirePostgres } from "../db/postgres.js";
import type { OrganizationMembershipRole } from "./tenant-access.js";

export const organizationVerificationStatuses = [
  "not_started", "pending", "verified", "rejected", "expired", "suspended",
] as const;

export type OrganizationVerificationStatus = (typeof organizationVerificationStatuses)[number];

type OverviewRow = {
  id: string;
  legal_name: string;
  role: OrganizationMembershipRole;
  verification_status: OrganizationVerificationStatus;
  verification_updated_at: Date;
  verification_expires_at: Date | null;
  active_members: string;
  pending_invitations: string;
  submitted_applications: string;
  approved_applications: string;
  rejected_applications: string;
  unresolved_diligence_items: string;
  submitted_publication_requests: string;
  published_offerings: string;
  paused_offerings: string;
  closed_offerings: string;
};

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Issuer overview count is outside the safe integer range");
  return parsed;
}

/**
 * Returns one transactionally consistent, tenant-scoped issuer dashboard.
 * Every aggregate begins from the caller's active organization memberships;
 * no organization identifier supplied by a client participates in the query.
 */
export async function getIssuerOverview(identityId: string) {
  const result = await requirePostgres().query<OverviewRow>(
    `WITH accessible_organizations AS (
       SELECT organization.id,organization.legal_name,membership.role,
              organization.verification_status,organization.verification_updated_at,
              organization.verification_expires_at
         FROM fractal.organization_memberships membership
         JOIN fractal.organizations organization ON organization.id=membership.organization_id
        WHERE membership.identity_id=$1
          AND membership.status='active'
          AND membership.revoked_at IS NULL
          AND organization.status='active'
     )
     SELECT organization.*,
       (SELECT count(*) FROM fractal.organization_memberships member
         WHERE member.organization_id=organization.id AND member.status='active' AND member.revoked_at IS NULL) AS active_members,
       (SELECT count(*) FROM fractal.organization_invitations invitation
         WHERE invitation.organization_id=organization.id AND invitation.accepted_at IS NULL
           AND invitation.revoked_at IS NULL AND invitation.expires_at>now()) AS pending_invitations,
       (SELECT count(*) FROM fractal.asset_application_requests application
         WHERE application.organization_id=organization.id AND application.status='submitted') AS submitted_applications,
       (SELECT count(*) FROM fractal.asset_application_requests application
         WHERE application.organization_id=organization.id AND application.status='approved') AS approved_applications,
       (SELECT count(*) FROM fractal.asset_application_requests application
         WHERE application.organization_id=organization.id AND application.status='rejected') AS rejected_applications,
       (SELECT count(*) FROM fractal.asset_application_review_items item
         WHERE item.organization_id=organization.id AND item.status IN ('open','responded','rejected')) AS unresolved_diligence_items,
       (SELECT count(*) FROM fractal.offering_publication_requests publication
         WHERE publication.organization_id=organization.id AND publication.status='submitted') AS submitted_publication_requests,
       (SELECT count(*) FROM fractal.offering_products offering
         WHERE offering.organization_id=organization.id AND offering.status='published') AS published_offerings,
       (SELECT count(*) FROM fractal.offering_products offering
         WHERE offering.organization_id=organization.id AND offering.status='paused') AS paused_offerings,
       (SELECT count(*) FROM fractal.offering_products offering
         WHERE offering.organization_id=organization.id AND offering.status='closed') AS closed_offerings
      FROM accessible_organizations organization
      ORDER BY organization.legal_name,organization.id`,
    [identityId],
  );

  const generatedAt = new Date();
  const organizations = result.rows.map((row) => {
    const verificationStatus = row.verification_status === "verified" &&
      row.verification_expires_at && row.verification_expires_at <= generatedAt
      ? "expired"
      : row.verification_status;
    const applications = {
      submitted: count(row.submitted_applications),
      approved: count(row.approved_applications),
      rejected: count(row.rejected_applications),
      unresolvedDiligenceItems: count(row.unresolved_diligence_items),
    };
    const offerings = {
      pendingPublicationRequests: count(row.submitted_publication_requests),
      published: count(row.published_offerings),
      paused: count(row.paused_offerings),
      closed: count(row.closed_offerings),
    };
    return {
      id: row.id,
      legalName: row.legal_name,
      role: row.role,
      verification: {
        status: verificationStatus,
        updatedAt: row.verification_updated_at.toISOString(),
        expiresAt: row.verification_expires_at?.toISOString() ?? null,
      },
      team: {
        activeMembers: count(row.active_members),
        pendingInvitations: count(row.pending_invitations),
      },
      applications,
      offerings,
      actionRequiredCount: applications.unresolvedDiligenceItems +
        (verificationStatus === "verified" ? 0 : 1),
    };
  });

  return {
    generatedAt: generatedAt.toISOString(),
    summary: organizations.reduce((summary, organization) => ({
      organizationCount: summary.organizationCount + 1,
      actionRequiredCount: summary.actionRequiredCount + organization.actionRequiredCount,
      submittedApplications: summary.submittedApplications + organization.applications.submitted,
      publishedOfferings: summary.publishedOfferings + organization.offerings.published,
    }), { organizationCount: 0, actionRequiredCount: 0, submittedApplications: 0, publishedOfferings: 0 }),
    organizations,
  };
}
