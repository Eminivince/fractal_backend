import { requirePostgres } from "../db/postgres.js";
import type { PublicOfferingAssetClass, PublicOfferingTerms } from "./postgres-offering-governance.js";

export interface InvestmentOfferingReadModel {
  reference: string;
  currency: string;
  capacityMinor: string;
  opensAt: string;
  closesAt: string;
  terms: Record<string, unknown>;
  eligibilityPolicy: Record<string, unknown>;
  agreementDocumentHash: string;
  disclosureBundleHash: string;
  version: number;
}

/**
 * Tenant-scoped operating projection. It carries the internal offering ID
 * only after membership is checked by the caller, so public investment reads
 * never gain a route to governed write targets.
 */
export interface OrganizationIssuableOffering {
  id: string;
  publicReference: string;
  displayName: string;
  currency: string;
  capacityMinor: string;
  opensAt: string;
  closesAt: string;
  currentVersionId: string;
  currentVersion: number;
}

type OfferingRow = {
  public_reference: string; currency: string; capacity_minor: string; opens_at: Date; closes_at: Date;
  terms: Record<string, unknown>; eligibility_policy: Record<string, unknown>;
  agreement_document_hash: string; disclosure_bundle_hash: string; version: number;
};

type OrganizationOfferingRow = OfferingRow & { id: string; version_id: string };

export interface PublicInvestmentOffering {
  slug: string;
  reference: string;
  name: string;
  issuerName: string;
  assetName: string;
  assetType: string;
  assetClass: PublicOfferingAssetClass;
  countryCode: string;
  state: string;
  city: string;
  summary: string;
  thesis: string;
  currency: string;
  capacityMinor: string;
  minimumTicketMinor: number;
  targetReturnBps: number;
  termMonths: number;
  riskSummary: string;
  incomeSource: string;
  structure: string;
  security: string;
  feeSummary: string;
  nextMilestone: string;
  opensAt: string;
  closesAt: string;
  publishedAt: string;
  publicationVersion: number;
}

type PublicOfferingRow = {
  public_reference: string;
  currency: string;
  capacity_minor: string;
  opens_at: Date;
  closes_at: Date;
  terms: PublicOfferingTerms;
  version: number;
  published_at: Date;
  legal_name: string;
  asset_name: string;
  asset_type: string;
  country_code: string;
  state: string;
  city: string;
};

function serializePublic(row: PublicOfferingRow): PublicInvestmentOffering {
  return {
    slug: row.terms.publicSlug,
    reference: row.public_reference,
    name: row.terms.name,
    issuerName: row.legal_name,
    assetName: row.asset_name,
    assetType: row.asset_type,
    assetClass: row.terms.assetClass,
    countryCode: row.country_code,
    state: row.state,
    city: row.city,
    summary: row.terms.summary,
    thesis: row.terms.thesis,
    currency: row.currency,
    capacityMinor: row.capacity_minor,
    minimumTicketMinor: row.terms.minimumTicketMinor,
    targetReturnBps: row.terms.targetReturnBps,
    termMonths: row.terms.termMonths,
    riskSummary: row.terms.riskSummary,
    incomeSource: row.terms.incomeSource,
    structure: row.terms.structure,
    security: row.terms.security,
    feeSummary: row.terms.feeSummary,
    nextMilestone: row.terms.nextMilestone,
    opensAt: row.opens_at.toISOString(),
    closesAt: row.closes_at.toISOString(),
    publishedAt: row.published_at.toISOString(),
    publicationVersion: row.version,
  };
}

const publicSelect = `
  SELECT offering.public_reference, offering.currency, offering.capacity_minor, offering.opens_at, offering.closes_at,
         publication.terms, publication.version, publication.published_at, organization.legal_name,
         origin.asset_name, origin.asset_type, origin.country_code, origin.state, origin.city
    FROM fractal.offering_products offering
    JOIN fractal.offering_publication_requests request
      ON request.published_offering_id = offering.id AND request.status = 'approved'
    JOIN fractal.approved_asset_application_versions origin
      ON origin.id = request.approved_asset_application_version_id
    JOIN fractal.organizations organization
      ON organization.id = offering.organization_id
    JOIN LATERAL (
      SELECT terms, version, published_at
        FROM fractal.offering_publication_versions
       WHERE offering_id = offering.id
       ORDER BY version DESC LIMIT 1
    ) publication ON true`;

const completePublicProfile = `publication.terms ?& ARRAY[
  'publicSlug', 'name', 'minimumTicketMinor', 'assetClass', 'summary', 'thesis', 'targetReturnBps',
  'termMonths', 'riskSummary', 'incomeSource', 'structure', 'security', 'feeSummary', 'nextMilestone'
]::text[]`;

/** Public, safe projection. Drafts, paused records, expired windows, and unverified issuers fail closed. */
export async function listPublicInvestmentOfferings(limit = 50): Promise<PublicInvestmentOffering[]> {
  const result = await requirePostgres().query<PublicOfferingRow>(
    `${publicSelect}
      WHERE offering.status = 'published' AND offering.opens_at <= now() AND offering.closes_at > now()
        AND organization.status = 'active' AND organization.verification_status = 'verified'
        AND organization.verification_expires_at > now() AND ${completePublicProfile}
      ORDER BY offering.closes_at, offering.public_reference
      LIMIT $1`,
    [Math.max(1, Math.min(Math.floor(limit), 100))],
  );
  return result.rows.map(serializePublic);
}

export async function getPublicInvestmentOffering(slug: string): Promise<PublicInvestmentOffering | null> {
  const result = await requirePostgres().query<PublicOfferingRow>(
    `${publicSelect}
      WHERE lower(publication.terms->>'publicSlug') = lower($1)
        AND offering.status = 'published' AND offering.opens_at <= now() AND offering.closes_at > now()
        AND organization.status = 'active' AND organization.verification_status = 'verified'
        AND organization.verification_expires_at > now() AND ${completePublicProfile}`,
    [slug.trim()],
  );
  return result.rows[0] ? serializePublic(result.rows[0]) : null;
}

function serialize(row: OfferingRow): InvestmentOfferingReadModel {
  return {
    reference: row.public_reference, currency: row.currency, capacityMinor: row.capacity_minor,
    opensAt: row.opens_at.toISOString(), closesAt: row.closes_at.toISOString(), terms: row.terms,
    eligibilityPolicy: row.eligibility_policy, agreementDocumentHash: row.agreement_document_hash.toLowerCase(),
    disclosureBundleHash: row.disclosure_bundle_hash.toLowerCase(), version: row.version,
  };
}

function serializeOrganizationOffering(row: OrganizationOfferingRow): OrganizationIssuableOffering {
  return {
    id: row.id,
    publicReference: row.public_reference,
    displayName: typeof row.terms.name === "string" && row.terms.name.trim() ? row.terms.name.trim() : row.public_reference,
    currency: row.currency,
    capacityMinor: row.capacity_minor,
    opensAt: row.opens_at.toISOString(),
    closesAt: row.closes_at.toISOString(),
    currentVersionId: row.version_id,
    currentVersion: row.version,
  };
}

const select = `
  SELECT offering.public_reference, offering.currency, offering.capacity_minor, offering.opens_at, offering.closes_at,
         publication.terms, publication.eligibility_policy, publication.agreement_document_hash,
         publication.disclosure_bundle_hash, publication.version
    FROM fractal.offering_products offering
    JOIN LATERAL (
      SELECT terms, eligibility_policy, agreement_document_hash, disclosure_bundle_hash, version
        FROM fractal.offering_publication_versions
       WHERE offering_id = offering.id
       ORDER BY version DESC LIMIT 1
    ) publication ON true`;

/** Read-only projection used by the authenticated Invest UI; never returns drafts or requests. */
export async function listOpenInvestmentOfferings(limit = 50): Promise<InvestmentOfferingReadModel[]> {
  const result = await requirePostgres().query<OfferingRow>(
    `${select}
      WHERE offering.status = 'published' AND offering.opens_at <= now() AND offering.closes_at > now()
      ORDER BY offering.closes_at, offering.public_reference
      LIMIT $1`,
    [Math.max(1, Math.min(Math.floor(limit), 100))],
  );
  return result.rows.map(serialize);
}

export async function getOpenInvestmentOffering(reference: string): Promise<InvestmentOfferingReadModel | null> {
  const result = await requirePostgres().query<OfferingRow>(
    `${select}
      WHERE offering.public_reference = $1 AND offering.status = 'published'
        AND offering.opens_at <= now() AND offering.closes_at > now()`,
    [reference.trim()],
  );
  return result.rows[0] ? serialize(result.rows[0]) : null;
}

export async function listOrganizationIssuableOfferings(organizationId: string): Promise<OrganizationIssuableOffering[]> {
  const result = await requirePostgres().query<OrganizationOfferingRow>(
    `SELECT offering.id, offering.public_reference, offering.currency, offering.capacity_minor, offering.opens_at, offering.closes_at,
            publication.id AS version_id, publication.terms, publication.eligibility_policy, publication.agreement_document_hash,
            publication.disclosure_bundle_hash, publication.version
       FROM fractal.offering_products offering
       JOIN LATERAL (
         SELECT id, terms, eligibility_policy, agreement_document_hash, disclosure_bundle_hash, version
           FROM fractal.offering_publication_versions
          WHERE offering_id = offering.id
          ORDER BY version DESC LIMIT 1
       ) publication ON true
      WHERE offering.organization_id = $1 AND offering.status = 'published'
      ORDER BY offering.closes_at, offering.public_reference, offering.id`,
    [organizationId],
  );
  return result.rows.map(serializeOrganizationOffering);
}
