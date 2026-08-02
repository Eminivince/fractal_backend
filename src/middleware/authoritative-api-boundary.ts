import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

const AUTHORITATIVE_AUTH_PATHS = new Set([
  "/v1/auth",
  "/v1/auth/csrf-token",
  "/v1/auth/login",
  "/v1/auth/register",
  "/v1/auth/refresh",
  "/v1/auth/logout",
  "/v1/auth/me",
  "/v1/auth/sessions",
  "/v1/auth/security-events",
  "/v1/auth/mfa/totp",
  "/v1/auth/mfa/totp/enroll",
  "/v1/auth/mfa/totp/confirm",
  "/v1/auth/mfa/step-up",
  "/v1/auth/mfa/recovery-codes/regenerate",
  "/v1/auth/mfa/totp/recover",
  "/v1/auth/forgot-password",
  "/v1/auth/request-email-verification",
  "/v1/auth/reset-password",
  "/v1/auth/verify-email",
  "/v1/auth/resend-verification",
]);

function pathFromUrl(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isAuthoritativeAuthPath(path: string): boolean {
  return AUTHORITATIVE_AUTH_PATHS.has(path) || /^\/v1\/auth\/sessions\/[^/]+\/revoke$/.test(path);
}

/**
 * Only these vertical slices have an approved production authority. Legacy
 * route modules remain registered in non-production for migration comparison,
 * but may never silently become a production capability.
 */
export function isAuthoritativeApiPath(url: string): boolean {
  const path = pathFromUrl(url);
  const authoritativeAdminPaths = new Set([
    "/v1/admin/access-identities",
    "/v1/admin/audit-events",
    "/v1/admin/system-health",
    "/v1/admin/access-change-requests",
    "/v1/admin/capabilities",
    "/v1/admin/capability-change-requests",
    "/v1/admin/audit-exports",
    "/v1/admin/provider-incidents",
    "/v1/admin/support-cases",
    "/v1/admin/privacy-requests",
    "/v1/admin/privacy-data-inventory",
    "/v1/admin/platform-content",
    "/v1/legal-consents/status",
    "/v1/legal-consents/accept",
  ]);
  const prefixMatch = [
    "/v1/webhooks",
    "/v1/investment-offerings",
    "/v1/public/investment-offerings",
    "/v1/public/legal-documents",
    "/v1/payment-intents",
    "/v1/investor/portfolio",
    "/v1/investor/documents",
    "/v1/investor/identity-verification",
    "/v1/investor/wallets",
    "/v1/investor/wallet-link-challenges",
    "/v1/organization-invitations",
    "/v1/governance",
    "/v1/professional",
    "/v1/control/professional-payout-exceptions",
    "/v1/control/professional-payout-recipient-recovery-cases",
    "/v1/control/professional-finance-exceptions",
    "/v1/control/organization-verifications",
    "/v1/control/distribution-payout-reconciliation",
    "/v1/control/distribution-payout-exceptions",
  ].some((prefix) => hasPrefix(path, prefix));
  // The legacy public offering catalogue still owns /v1/offerings. The only
  // approved route below that prefix is the PostgreSQL checkout command.
  return isAuthoritativeAuthPath(path)
    || authoritativeAdminPaths.has(path)
    || /^\/v1\/admin\/access-change-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/capability-change-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/audit-exports\/[^/]+\/download$/.test(path)
    || /^\/v1\/admin\/provider-incidents\/[^/]+$/.test(path)
    || /^\/v1\/admin\/provider-incidents\/[^/]+\/transitions$/.test(path)
    || /^\/v1\/admin\/support-cases\/[^/]+$/.test(path)
    || /^\/v1\/admin\/support-cases\/[^/]+\/transitions$/.test(path)
    || /^\/v1\/admin\/support-cases\/[^/]+\/attachments$/.test(path)
    || /^\/v1\/admin\/support-attachments\/[^/]+\/download$/.test(path)
    || /^\/v1\/admin\/support-attachments\/[^/]+\/lifecycle$/.test(path)
    || /^\/v1\/admin\/support-attachments\/[^/]+\/legal-hold-requests$/.test(path)
    || /^\/v1\/admin\/support-attachment-hold-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/support-attachments\/[^/]+\/disposition-requests$/.test(path)
    || /^\/v1\/admin\/support-attachment-disposition-requests\/[^/]+\/decision$/.test(path)
    || path === "/v1/admin/organization-documents/lifecycle"
    || /^\/v1\/admin\/organization-documents\/[^/]+\/lifecycle$/.test(path)
    || /^\/v1\/admin\/organization-documents\/[^/]+\/legal-hold-requests$/.test(path)
    || /^\/v1\/admin\/organization-document-hold-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/organization-documents\/[^/]+\/disposition-requests$/.test(path)
    || /^\/v1\/admin\/organization-document-disposition-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/distribution-lifecycle\/(?:distribution_declaration|distribution_payout_exception|distribution_tax_remittance)\/[^/]+$/.test(path)
    || /^\/v1\/admin\/distribution-lifecycle\/(?:distribution_declaration|distribution_payout_exception|distribution_tax_remittance)\/[^/]+\/legal-hold-requests$/.test(path)
    || /^\/v1\/admin\/distribution-lifecycle-hold-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/transitions$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/policy-binding$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/decision-requests$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/external-snapshots$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/sumsub-provider-exports$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/package-preparations$/.test(path)
    || /^\/v1\/admin\/privacy-package-preparations\/[^/]+\/deliveries$/.test(path)
    || /^\/v1\/privacy\/package-deliveries\/[^/]+\/download$/.test(path)
    || /^\/v1\/admin\/privacy-requests\/[^/]+\/distribution-treatment-requests$/.test(path)
    || /^\/v1\/admin\/distribution-privacy-treatment-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/privacy-decision-requests\/[^/]+\/decision$/.test(path)
    || /^\/v1\/admin\/platform-content\/[^/]+\/versions$/.test(path)
    || /^\/v1\/admin\/platform-content\/versions\/[^/]+$/.test(path)
    || /^\/v1\/admin\/platform-content\/versions\/[^/]+\/decision$/.test(path)
    || path === "/v1/investor/notices"
    || path === "/v1/investor/distributions"
    || path === "/v1/investor/distribution-payout-profile"
    || /^\/v1\/investor\/notices\/[^/]+\/(?:read|acknowledge)$/.test(path)
    || path === "/v1/support/cases"
    || /^\/v1\/support\/cases\/[^/]+$/.test(path)
    || /^\/v1\/support\/cases\/[^/]+\/messages$/.test(path)
    || /^\/v1\/support\/cases\/[^/]+\/attachments$/.test(path)
    || /^\/v1\/support\/attachments\/[^/]+\/download$/.test(path)
    || path === "/v1/privacy/requests"
    || /^\/v1\/privacy\/requests\/[^/]+$/.test(path)
    || /^\/v1\/privacy\/requests\/[^/]+\/(?:messages|withdraw)$/.test(path)
    || prefixMatch
    || /^\/v1\/offerings\/[^/]+\/checkout$/.test(path);
}

export function shouldBlockLegacyApiPath(url: string, isProduction: boolean): boolean {
  const path = pathFromUrl(url);
  if (!isProduction || isAuthoritativeApiPath(path)) return false;

  // Most retired API modules were migrated under `/v1`, but the older
  // blockchain controller remains registered at `/blockchain`. It can queue
  // legacy Mongo-backed operations and must not escape the production boundary
  // merely because it predates API versioning. Keep health/readiness and the
  // separately production-disabled docs route outside this predicate so their
  // intended handlers retain their explicit semantics.
  return path.startsWith("/v1/") || path === "/blockchain" || path.startsWith("/blockchain/");
}

export function registerAuthoritativeApiBoundary(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    if (!shouldBlockLegacyApiPath(request.url, env.NODE_ENV === "production")) return;
    throw new HttpError(410, "This legacy API capability is not available in production.");
  });
}
