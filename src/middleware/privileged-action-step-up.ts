import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthUser } from "../types.js";
import type { Role } from "../utils/constants.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../platform/auth-step-up.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../platform/postgres-identities.js";
import { HttpError } from "../utils/errors.js";

export interface PrivilegedActionPolicy {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly capability: string;
  readonly allowedRoles: readonly Role[];
}

/**
 * One enforceable inventory for every currently enabled action that can approve
 * an offering/investor/ownership state, redirect a payout destination, or
 * approve or execute money movement. It supplements each command's own
 * maker-checker and tenant checks; it does not replace them.
 */
export const privilegedActionPolicies: readonly PrivilegedActionPolicy[] = [
  { method: "POST", path: "/v1/admin/access-change-requests", capability: "privileged access-change proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/access-change-requests/:requestId/decision", capability: "privileged access-change decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/capability-change-requests", capability: "administrator capability-change proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/capability-change-requests/:requestId/decision", capability: "administrator capability-change decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/audit-exports", capability: "administrator audit-evidence export", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/audit-exports/:exportId/download", capability: "administrator audit-evidence retrieval", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/provider-incidents", capability: "provider incident creation", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/provider-incidents/:incidentId/transitions", capability: "provider incident transition", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/support-cases/:caseId/transitions", capability: "support case transition", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/support-cases/:caseId/attachments", capability: "classified support attachment upload", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/support-attachments/:attachmentId/download", capability: "classified support attachment retrieval", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/support-attachments/:attachmentId/lifecycle", capability: "classified support evidence lifecycle review", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/support-attachments/:attachmentId/legal-hold-requests", capability: "support evidence legal hold proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/support-attachment-hold-requests/:requestId/decision", capability: "support evidence legal hold decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/support-attachments/:attachmentId/disposition-requests", capability: "support evidence disposition proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/support-attachment-disposition-requests/:requestId/decision", capability: "support evidence disposition decision", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/organization-documents/lifecycle", capability: "organization document lifecycle register access", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/organization-documents/:documentId/lifecycle", capability: "organization document lifecycle review", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/organization-documents/:documentId/legal-hold-requests", capability: "organization document legal hold proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/organization-document-hold-requests/:requestId/decision", capability: "organization document legal hold decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/organization-documents/:documentId/disposition-requests", capability: "organization document disposition proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/organization-document-disposition-requests/:requestId/decision", capability: "organization document disposition decision", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/distribution-lifecycle/:targetType/:targetId", capability: "distribution legal hold review", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/distribution-lifecycle/:targetType/:targetId/legal-hold-requests", capability: "distribution legal hold proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/distribution-lifecycle-hold-requests/:requestId/decision", capability: "distribution legal hold decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/governance/offering-notice-requests/:requestId/decision", capability: "offering notice publication decision", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/ownership-snapshot-requests", capability: "record-date ownership snapshot proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/ownership-snapshot-requests/:requestId/decision", capability: "record-date ownership snapshot decision", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/distribution-declarations", capability: "distribution declaration proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-declarations/:requestId/decision", capability: "distribution declaration decision", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/investor/distribution-payout-profile", capability: "investor distribution payout destination replacement", allowedRoles: ["investor"] },
  { method: "POST", path: "/v1/governance/distribution-declarations/:requestId/funding-requests", capability: "distribution funding proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-funding-requests/:requestId/decision", capability: "distribution funding and payout authorization", allowedRoles: ["issuer"] },
  { method: "GET", path: "/v1/control/distribution-payout-reconciliation", capability: "distribution payout reconciliation evidence access", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/policies", capability: "distribution payout correction policy proposal", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/policies/:policyId/approve", capability: "distribution payout correction policy approval", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/payouts/:payoutInstructionId", capability: "distribution payout exception opening", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/:exceptionCaseId/evidence", capability: "distribution payout exception evidence", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/:exceptionCaseId/resolution", capability: "distribution payout correction proposal", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/:exceptionCaseId/decision", capability: "distribution payout correction decision", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/:exceptionCaseId/execute", capability: "distribution payout corrective execution", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/:exceptionCaseId/hold-requests", capability: "distribution payout fraud-hold proposal", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/distribution-payout-exceptions/hold-requests/:holdRequestId/decision", capability: "distribution payout fraud-hold decision", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/distribution-tax-policies", capability: "distribution tax-remittance policy proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-tax-policies/:policyId/approve", capability: "distribution tax-remittance policy approval", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-declarations/:declarationRequestId/tax-remittance", capability: "distribution tax-filing proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-tax-remittances/:requestId/filing-decision", capability: "distribution tax-filing decision", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-tax-remittances/:requestId/payment-evidence", capability: "distribution tax-payment evidence submission", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-tax-remittances/:requestId/payment-decision", capability: "distribution tax-remittance confirmation", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-tax-remittances/:requestId/reversal-requests", capability: "distribution tax-remittance reversal proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/distribution-tax-remittance-reversals/:reversalRequestId/decision", capability: "distribution tax-remittance reversal decision", allowedRoles: ["issuer"] },
  { method: "GET", path: "/v1/admin/privacy-requests", capability: "privacy-rights register access", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/privacy-data-inventory", capability: "restricted privacy data-source inventory access", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/admin/privacy-requests/:requestId", capability: "restricted privacy-rights evidence access", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/transitions", capability: "privacy-rights request transition", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/policy-binding", capability: "privacy response-policy binding", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/decision-requests", capability: "privacy-rights outcome proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/external-snapshots", capability: "external privacy snapshot collection", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/sumsub-provider-exports", capability: "Sumsub privacy export staging", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/package-preparations", capability: "privacy package preparation evidence", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-package-preparations/:preparationId/deliveries", capability: "privacy package delivery authorization", allowedRoles: ["admin"] },
  { method: "GET", path: "/v1/privacy/package-deliveries/:deliveryId/download", capability: "privacy package download", allowedRoles: ["investor", "issuer", "professional", "operator", "admin"] },
  { method: "POST", path: "/v1/admin/privacy-requests/:requestId/distribution-treatment-requests", capability: "distribution privacy treatment proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/distribution-privacy-treatment-requests/:treatmentRequestId/decision", capability: "distribution privacy treatment decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/privacy-decision-requests/:decisionRequestId/decision", capability: "privacy-rights outcome decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/platform-configuration/:configurationKey/versions", capability: "platform configuration proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/platform-configuration/versions/:versionId/decision", capability: "platform configuration decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/platform-configuration/:configurationKey/rollbacks", capability: "platform configuration rollback proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/platform-content/:documentKey/versions", capability: "legal content proposal", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/admin/platform-content/versions/:versionId/decision", capability: "legal content decision", allowedRoles: ["admin"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/invitations", capability: "organization access invitation", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/invitations/:invitationId/revoke", capability: "organization invitation revocation", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/invitations/:invitationId/resend", capability: "organization invitation redelivery", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/memberships/:membershipId/role", capability: "organization membership role change", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/memberships/:membershipId/status", capability: "organization membership status change", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/ownership-transfers", capability: "organization ownership transfer proposal", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/ownership-transfers/:transferId/decision", capability: "organization ownership transfer decision", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/governance/organizations/:organizationId/verification-requests", capability: "organization authority declaration", allowedRoles: ["issuer"] },
  { method: "POST", path: "/v1/control/organization-verifications/:requestId/decision", capability: "organization verification decision", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/governance/asset-application-requests/:requestId/decision", capability: "asset application decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/asset-application-review-items/:reviewItemId/decision", capability: "asset-application diligence decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/offering-publication-requests/:requestId/decision", capability: "offering publication decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/investor-compliance-reviews/:requestId/decision", capability: "investor compliance decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/chain-deployment-requests/:requestId/decision", capability: "chain deployment decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/issuance-terms/:requestId/decision", capability: "issuance terms decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/investment-allocations/:requestId/decision", capability: "investment allocation decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/offerings/:reference/checkout", capability: "investment checkout", allowedRoles: ["investor"] },
  { method: "POST", path: "/v1/investor/wallet-link-challenges/confirm", capability: "investor wallet-link confirmation", allowedRoles: ["investor"] },
  { method: "POST", path: "/v1/professional/firms/:firmOrganizationId/payout-profile", capability: "professional payout-profile replacement", allowedRoles: ["professional"] },
  { method: "POST", path: "/v1/governance/professional-deliverables/:deliverableVersionId/decision", capability: "professional deliverable decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/professional-invoices/:invoiceId/decision", capability: "professional invoice decision", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/professional-invoices/:invoiceId/payout-instruction", capability: "professional payout authorization", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/professional-finance-approval-policies/:financeApprovalPolicyId/approve", capability: "professional finance-approval policy approval", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/governance/professional-invoice-tax-treatments/:taxTreatmentId/approve", capability: "professional invoice tax-treatment approval", allowedRoles: ["issuer", "operator", "admin"] },
  { method: "POST", path: "/v1/control/professional-finance-exceptions/:financeExceptionCaseId/decision", capability: "professional finance-exception decision", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/professional-finance-exceptions/:financeExceptionCaseId/execute-credit-note", capability: "professional finance credit-note execution", allowedRoles: ["operator", "admin"] },
  { method: "POST", path: "/v1/control/professional-finance-exceptions/:financeExceptionCaseId/authorize-replacement-payout", capability: "professional replacement-payout authorization", allowedRoles: ["operator", "admin"] },
] as const;

function withoutQuery(path: string): string {
  return path.split("?", 1)[0] ?? path;
}

function pathMatchesTemplate(template: string, path: string): boolean {
  const expected = template.split("/");
  const actual = withoutQuery(path).split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => segment.startsWith(":") || segment === actual[index]);
}

/** Resolves both Fastify route templates and concrete request paths. */
export function resolvePrivilegedActionPolicy(method: string, path: string): PrivilegedActionPolicy | undefined {
  const normalizedMethod = method.toUpperCase();
  return privilegedActionPolicies.find(
    (policy) => policy.method === normalizedMethod && pathMatchesTemplate(policy.path, path),
  );
}

async function enforceStepUp(request: FastifyRequest, policy: PrivilegedActionPolicy): Promise<void> {
  const actor = request.authUser;
  if (!actor?.userId) throw new HttpError(401, "Authentication is required for this action.");
  assertPrivilegedActionRole(actor, policy);

  let identityId: string;
  try {
    identityId = await requirePostgresIdentityForSubject(actor.userId);
  } catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) {
      throw new HttpError(409, "Your account migration is not ready for the governed workflow");
    }
    throw error;
  }

  try {
    await requireFreshTotpStepUp({ sessionId: actor.sessionId, identityId });
  } catch (error) {
    if (error instanceof StepUpRequiredError) throw new HttpError(403, error.message);
    throw error;
  }
}

export function assertPrivilegedActionRole(actor: AuthUser, policy: PrivilegedActionPolicy): void {
  if (!policy.allowedRoles.includes(actor.role)) {
    throw new HttpError(403, `Role ${actor.role} is not permitted to perform ${policy.capability}.`);
  }
}

export interface PrivilegedActionStepUpPolicyOptions {
  /** Test seam: production always uses the database-backed enforcement path. */
  readonly enforce?: (request: FastifyRequest, policy: PrivilegedActionPolicy) => Promise<void>;
}

/**
 * Appends a step-up guard after each matched route's existing authentication
 * pre-handler. Keeping this registration adjacent to API route registration
 * means a new privileged policy entry cannot be documented without protection.
 */
export function registerPrivilegedActionStepUpPolicy(
  app: FastifyInstance,
  options: PrivilegedActionStepUpPolicyOptions = {},
): void {
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const policy = methods
      .map((method) => resolvePrivilegedActionPolicy(String(method), routeOptions.url))
      .find((candidate): candidate is PrivilegedActionPolicy => Boolean(candidate));
    if (!policy) return;

    const enforce = options.enforce ?? enforceStepUp;
    const guard = async (request: FastifyRequest) => enforce(request, policy);
    const existing = routeOptions.preHandler;
    routeOptions.preHandler = existing === undefined
      ? [guard]
      : Array.isArray(existing)
        ? [...existing, guard]
        : [existing, guard];
  });
}
