import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import {
  CheckoutPolicyError,
  publishOfferingInTransaction,
  upsertInvestorComplianceProfileInTransaction,
  type EligibilityPolicy,
  type InvestorComplianceProfileInput,
  type PublishOfferingInput,
} from "./postgres-offering-checkout.js";

export class OfferingGovernanceError extends Error {}

type PublicationRequestRow = {
  id: string; organization_id: string; public_reference: string; currency: string; capacity_minor: string;
  opens_at: Date; closes_at: Date; terms: Record<string, unknown>; eligibility_policy: EligibilityPolicy;
  agreement_document_hash: string; disclosure_bundle_hash: string; status: string; submitted_by_identity_id: string;
  agreement_evidence_document_id: string; disclosure_evidence_document_id: string;
  approved_asset_application_version_id: string;
};

type ComplianceRequestRow = {
  id: string; organization_id: string; investor_identity_id: string; kyc_status: InvestorComplianceProfileInput["kycStatus"];
  investor_class: InvestorComplianceProfileInput["investorClass"]; accreditation_status: InvestorComplianceProfileInput["accreditationStatus"];
  jurisdiction_code: string; reviewed_at: Date; expires_at: Date | null; evidence: Record<string, unknown>; status: string;
  submitted_by_identity_id: string;
};

type ProviderIdentityVerificationEvidenceRow = {
  id: string;
  provider: string;
  identity_id: string | null;
  external_event_id: string;
  event_type: string;
  review_status: string | null;
  review_answer: "GREEN" | "RED" | null;
  reject_labels: string[];
  provider_created_at: Date | null;
  payload_hash: string;
  received_at: Date;
  recorded_at: Date;
};

function text(value: string, name: string, max = 2_000): string {
  const output = value.trim();
  if (!output || output.length > max) throw new OfferingGovernanceError(`${name} is required and must be at most ${max} characters`);
  return output;
}

function hash(value: string, name: string): string {
  const output = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(output)) throw new OfferingGovernanceError(`${name} must be a SHA-256 hash`);
  return output;
}

export const PUBLIC_OFFERING_ASSET_CLASSES = [
  "logistics_industrial",
  "mixed_use_real_estate",
  "renewable_energy",
  "infrastructure",
  "healthcare",
  "education",
  "agribusiness",
  "other",
] as const;

export type PublicOfferingAssetClass = (typeof PUBLIC_OFFERING_ASSET_CLASSES)[number];

export interface PublicOfferingTerms extends Record<string, unknown> {
  name: string;
  publicSlug: string;
  minimumTicketMinor: number;
  assetClass: PublicOfferingAssetClass;
  summary: string;
  thesis: string;
  targetReturnBps: number;
  termMonths: number;
  riskSummary: string;
  incomeSource: string;
  structure: string;
  security: string;
  feeSummary: string;
  nextMilestone: string;
}

function publicTerms(value: Record<string, unknown>, capacity: bigint): PublicOfferingTerms {
  const number = (field: "minimumTicketMinor" | "targetReturnBps" | "termMonths", maximum: number) => {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
      throw new OfferingGovernanceError(`${field} must be a positive integer no greater than ${maximum}`);
    }
    return candidate;
  };
  const minimumTicketMinor = number("minimumTicketMinor", Number.MAX_SAFE_INTEGER);
  if (BigInt(minimumTicketMinor) > capacity) throw new OfferingGovernanceError("minimumTicketMinor cannot exceed offering capacity");
  const publicSlug = text(String(value.publicSlug ?? ""), "publicSlug", 120).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publicSlug)) throw new OfferingGovernanceError("publicSlug must be a lowercase URL slug");
  if (!PUBLIC_OFFERING_ASSET_CLASSES.includes(value.assetClass as PublicOfferingAssetClass)) {
    throw new OfferingGovernanceError("assetClass is not supported");
  }
  return {
    ...value,
    name: text(String(value.name ?? ""), "name", 200),
    publicSlug,
    minimumTicketMinor,
    assetClass: value.assetClass as PublicOfferingAssetClass,
    summary: text(String(value.summary ?? ""), "summary", 500),
    thesis: text(String(value.thesis ?? ""), "thesis", 2_000),
    targetReturnBps: number("targetReturnBps", 10_000),
    termMonths: number("termMonths", 600),
    riskSummary: text(String(value.riskSummary ?? ""), "riskSummary", 2_000),
    incomeSource: text(String(value.incomeSource ?? ""), "incomeSource", 1_000),
    structure: text(String(value.structure ?? ""), "structure", 1_000),
    security: text(String(value.security ?? ""), "security", 1_000),
    feeSummary: text(String(value.feeSummary ?? ""), "feeSummary", 1_000),
    nextMilestone: text(String(value.nextMilestone ?? ""), "nextMilestone", 1_000),
  };
}

function candidate(input: Omit<PublishOfferingInput, "publishedByIdentityId">): Omit<PublishOfferingInput, "publishedByIdentityId"> {
  const capacity = typeof input.capacityMinor === "bigint" ? input.capacityMinor : BigInt(input.capacityMinor);
  if (capacity <= 0n || (typeof input.capacityMinor === "number" && !Number.isSafeInteger(input.capacityMinor))) throw new OfferingGovernanceError("capacityMinor must be a positive safe integer");
  if (input.opensAt >= input.closesAt) throw new OfferingGovernanceError("Offering close must follow open");
  if (!/^[A-Za-z]{3}$/.test(input.currency.trim())) throw new OfferingGovernanceError("currency must be a three-letter code");
  if (!input.eligibilityPolicy.allowedInvestorClasses.length) throw new OfferingGovernanceError("Eligibility policy requires an investor class");
  const terms = publicTerms(input.terms, capacity);
  return {
    ...input,
    publicReference: text(input.publicReference, "publicReference", 200),
    currency: input.currency.trim().toUpperCase(),
    agreementDocumentHash: hash(input.agreementDocumentHash, "agreementDocumentHash"),
    disclosureBundleHash: hash(input.disclosureBundleHash, "disclosureBundleHash"),
    terms,
  };
}

export interface SubmitPublicationRequestInput extends Omit<PublishOfferingInput, "publishedByIdentityId" | "agreementDocumentHash" | "disclosureBundleHash" | "terms"> {
  submittedByIdentityId: string;
  terms: PublicOfferingTerms;
  agreementEvidenceDocumentId: string;
  disclosureEvidenceDocumentId: string;
  approvedAssetApplicationVersionId: string;
}

export async function submitOfferingPublicationRequest(input: SubmitPublicationRequestInput): Promise<{ requestId: string }> {
  const requestId = randomUUID();
  try {
    await withPostgresTransaction(async (client) => {
    if (input.agreementEvidenceDocumentId === input.disclosureEvidenceDocumentId) throw new OfferingGovernanceError("Agreement and disclosure evidence must be distinct documents");
    const evidence = await client.query<{ id: string; evidence_kind: "agreement" | "disclosure_bundle"; content_sha256: string }>(
      `SELECT id, evidence_kind, content_sha256 FROM fractal.offering_publication_evidence_documents
       WHERE organization_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
      [input.organizationId, [input.agreementEvidenceDocumentId, input.disclosureEvidenceDocumentId]],
    );
    const agreement = evidence.rows.find((document) => document.id === input.agreementEvidenceDocumentId && document.evidence_kind === "agreement");
    const disclosure = evidence.rows.find((document) => document.id === input.disclosureEvidenceDocumentId && document.evidence_kind === "disclosure_bundle");
    if (!agreement || !disclosure) throw new OfferingGovernanceError("Publication requires agreement and disclosure evidence belonging to this organization");
    const facts = candidate({ ...input, agreementDocumentHash: agreement.content_sha256, disclosureBundleHash: disclosure.content_sha256 });
    await client.query(
      `INSERT INTO fractal.offering_publication_requests
         (id, organization_id, public_reference, currency, capacity_minor, opens_at, closes_at, terms, eligibility_policy,
          agreement_document_hash, disclosure_bundle_hash, agreement_evidence_document_id, disclosure_evidence_document_id, approved_asset_application_version_id,
          status, submitted_by_identity_id, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'submitted', $15, now())`,
      [requestId, facts.organizationId, facts.publicReference, facts.currency, BigInt(facts.capacityMinor).toString(), facts.opensAt, facts.closesAt,
        facts.terms, facts.eligibilityPolicy, facts.agreementDocumentHash, facts.disclosureBundleHash,
        input.agreementEvidenceDocumentId, input.disclosureEvidenceDocumentId, input.approvedAssetApplicationVersionId, input.submittedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${facts.organizationId}`, organizationId: facts.organizationId,
      actorId: input.submittedByIdentityId, actorType: "user", action: "offering.publication.submitted",
      entityType: "offering_publication_request", entityId: requestId,
      payload: { publicReference: facts.publicReference, currency: facts.currency, capacityMinor: BigInt(facts.capacityMinor).toString() },
    });
    await appendOutboxEvent(client, { aggregateType: "offering_publication_request", aggregateId: requestId, eventType: "offering.publication.submitted", payload: { organizationId: facts.organizationId, auditEventId: audit.id } });
    });
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === "23505" && databaseError.constraint === "offering_publication_requests_public_slug_unique") {
      throw new OfferingGovernanceError("publicSlug is already in use");
    }
    throw error;
  }
  return { requestId };
}

export async function decideOfferingPublicationRequest(input: {
  requestId: string; decidedByIdentityId: string; approve: boolean; reason?: string;
}): Promise<{ requestId: string; status: "approved" | "rejected"; offeringId?: string; offeringVersionId?: string }> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<PublicationRequestRow>("SELECT * FROM fractal.offering_publication_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
    const request = result.rows[0];
    if (!request) throw new OfferingGovernanceError("Offering publication request not found");
    if (request.status !== "submitted") throw new OfferingGovernanceError("Offering publication request has already been decided");
    if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new OfferingGovernanceError("A different person must approve or reject this request");
    const reason = input.reason?.trim();
    if (!input.approve && !reason) throw new OfferingGovernanceError("A rejection reason is required");

    let offering: Awaited<ReturnType<typeof publishOfferingInTransaction>> | undefined;
    if (input.approve) {
      const origin = await client.query<{ organization_id: string; application_reference: string }>(
        "SELECT organization_id, application_reference FROM fractal.approved_asset_application_versions WHERE id = $1 FOR SHARE",
        [request.approved_asset_application_version_id],
      );
      if (!origin.rows[0] || origin.rows[0].organization_id !== request.organization_id) throw new OfferingGovernanceError("Offering publication origin is unavailable");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${origin.rows[0].organization_id}:${origin.rows[0].application_reference}`]);
      const superseded = await client.query("SELECT 1 FROM fractal.asset_application_version_supersessions WHERE superseded_application_version_id = $1", [request.approved_asset_application_version_id]);
      if (superseded.rowCount) throw new OfferingGovernanceError("Offering publication origin has been superseded by a material application change");
      try {
        offering = await publishOfferingInTransaction(client, {
          organizationId: request.organization_id, publishedByIdentityId: input.decidedByIdentityId,
          publicReference: request.public_reference, currency: request.currency, capacityMinor: BigInt(request.capacity_minor),
          opensAt: request.opens_at, closesAt: request.closes_at, terms: request.terms,
          eligibilityPolicy: request.eligibility_policy, agreementDocumentHash: request.agreement_document_hash,
          disclosureBundleHash: request.disclosure_bundle_hash,
        });
      } catch (error) {
        if (error instanceof CheckoutPolicyError) throw new OfferingGovernanceError(error.message);
        throw error;
      }
    }
    const status = input.approve ? "approved" : "rejected";
    await client.query(
      `UPDATE fractal.offering_publication_requests
          SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4, published_offering_id = $5
        WHERE id = $1`,
      [request.id, status, input.decidedByIdentityId, input.approve ? reason ?? null : text(reason!, "reason"), offering?.offeringId ?? null],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${request.organization_id}`, organizationId: request.organization_id,
      actorId: input.decidedByIdentityId, actorType: "user", action: `offering.publication.${status}`,
      entityType: "offering_publication_request", entityId: request.id, reason: reason ?? undefined,
      payload: { publicReference: request.public_reference, offeringId: offering?.offeringId ?? null },
    });
    await appendOutboxEvent(client, { aggregateType: "offering_publication_request", aggregateId: request.id, eventType: `offering.publication.${status}`, payload: { organizationId: request.organization_id, offeringId: offering?.offeringId ?? null, auditEventId: audit.id } });
    return { requestId: request.id, status, ...(offering ? { offeringId: offering.offeringId, offeringVersionId: offering.offeringVersionId } : {}) };
  });
}

export interface SubmitComplianceReviewInput extends InvestorComplianceProfileInput {
  organizationId: string;
  submittedByIdentityId: string;
}

async function normalizedComplianceEvidence(
  client: PoolClient,
  input: InvestorComplianceProfileInput,
): Promise<Record<string, unknown>> {
  const evidence = { ...(input.evidence ?? {}) };
  const providerEvidenceId = evidence.providerIdentityVerificationEventId;
  // A canonical record below prevents a caller from supplying a fabricated
  // provider verdict alongside a valid-looking UUID.
  delete evidence.providerIdentityVerification;
  if (providerEvidenceId === undefined) return evidence;
  if (typeof providerEvidenceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providerEvidenceId)) {
    throw new OfferingGovernanceError("providerIdentityVerificationEventId must be a UUID");
  }

  const result = await client.query<ProviderIdentityVerificationEvidenceRow>(
    `SELECT id, provider, identity_id, external_event_id, event_type, review_status, review_answer,
            reject_labels, provider_created_at, payload_hash, received_at, recorded_at
       FROM fractal.provider_identity_verification_events
      WHERE id = $1 AND identity_id = $2
      FOR SHARE`,
    [providerEvidenceId, input.identityId],
  );
  const providerEvidence = result.rows[0];
  if (!providerEvidence) {
    throw new OfferingGovernanceError("Provider identity-verification evidence is unavailable for this investor");
  }
  if (input.kycStatus === "approved" && providerEvidence.review_answer !== "GREEN") {
    throw new OfferingGovernanceError("Approved compliance cannot cite provider evidence without a GREEN review answer");
  }
  evidence.providerIdentityVerification = {
    eventId: providerEvidence.id,
    provider: providerEvidence.provider,
    externalEventId: providerEvidence.external_event_id,
    eventType: providerEvidence.event_type,
    reviewStatus: providerEvidence.review_status,
    reviewAnswer: providerEvidence.review_answer,
    rejectLabels: providerEvidence.reject_labels,
    providerCreatedAt: providerEvidence.provider_created_at?.toISOString() ?? null,
    receivedAt: providerEvidence.received_at.toISOString(),
    recordedAt: providerEvidence.recorded_at.toISOString(),
    payloadHash: providerEvidence.payload_hash,
  };
  return evidence;
}

export async function submitInvestorComplianceReview(input: SubmitComplianceReviewInput): Promise<{ requestId: string }> {
  const jurisdictionCode = input.jurisdictionCode.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(jurisdictionCode)) throw new OfferingGovernanceError("jurisdictionCode is invalid");
  if (input.expiresAt && input.expiresAt <= input.reviewedAt) throw new OfferingGovernanceError("expiresAt must follow reviewedAt");
  const requestId = randomUUID();
  await withPostgresTransaction(async (client) => {
    const evidence = await normalizedComplianceEvidence(client, input);
    await client.query(
      `INSERT INTO fractal.investor_compliance_review_requests
         (id, organization_id, investor_identity_id, kyc_status, investor_class, accreditation_status, jurisdiction_code,
          reviewed_at, expires_at, evidence, status, submitted_by_identity_id, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', $11, now())`,
      [requestId, input.organizationId, input.identityId, input.kycStatus, input.investorClass, input.accreditationStatus,
        jurisdictionCode, input.reviewedAt, input.expiresAt ?? null, evidence, input.submittedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.submittedByIdentityId,
      actorType: "user", action: "investor.compliance.submitted", entityType: "investor_compliance_review_request", entityId: requestId,
      payload: { investorIdentityId: input.identityId, kycStatus: input.kycStatus, investorClass: input.investorClass, jurisdictionCode },
    });
    await appendOutboxEvent(client, { aggregateType: "investor_compliance_review_request", aggregateId: requestId, eventType: "investor.compliance.submitted", payload: { organizationId: input.organizationId, auditEventId: audit.id } });
  });
  return { requestId };
}

export async function decideInvestorComplianceReview(input: {
  requestId: string; decidedByIdentityId: string; approve: boolean; reason?: string;
}): Promise<{ requestId: string; status: "approved" | "rejected" }> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<ComplianceRequestRow>("SELECT * FROM fractal.investor_compliance_review_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
    const request = result.rows[0];
    if (!request) throw new OfferingGovernanceError("Compliance review request not found");
    if (request.status !== "submitted") throw new OfferingGovernanceError("Compliance review request has already been decided");
    if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new OfferingGovernanceError("A different person must approve or reject this request");
    const reason = input.reason?.trim();
    if (!input.approve && !reason) throw new OfferingGovernanceError("A rejection reason is required");
    const status = input.approve ? "approved" : "rejected";
    await client.query(
      `UPDATE fractal.investor_compliance_review_requests
          SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4
        WHERE id = $1`,
      [request.id, status, input.decidedByIdentityId, input.approve ? reason ?? null : text(reason!, "reason")],
    );
    if (input.approve) {
      await upsertInvestorComplianceProfileInTransaction(client, {
        identityId: request.investor_identity_id, kycStatus: request.kyc_status, investorClass: request.investor_class,
        accreditationStatus: request.accreditation_status, jurisdictionCode: request.jurisdiction_code,
        reviewedAt: request.reviewed_at, expiresAt: request.expires_at ?? undefined, evidence: request.evidence,
      });
      await client.query(
        `INSERT INTO fractal.investor_compliance_profile_reviews
           (id, review_request_id, organization_id, investor_identity_id, approved_by_identity_id, approved_at, profile_snapshot)
         VALUES ($1, $2, $3, $4, $5, now(), $6)`,
        [randomUUID(), request.id, request.organization_id, request.investor_identity_id, input.decidedByIdentityId,
          { kycStatus: request.kyc_status, investorClass: request.investor_class, accreditationStatus: request.accreditation_status, jurisdictionCode: request.jurisdiction_code, reviewedAt: request.reviewed_at.toISOString(), expiresAt: request.expires_at?.toISOString() ?? null, evidence: request.evidence }],
      );
    }
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${request.organization_id}`, organizationId: request.organization_id, actorId: input.decidedByIdentityId,
      actorType: "user", action: `investor.compliance.${status}`, entityType: "investor_compliance_review_request", entityId: request.id,
      reason: reason ?? undefined, payload: { investorIdentityId: request.investor_identity_id, kycStatus: request.kyc_status },
    });
    await appendOutboxEvent(client, { aggregateType: "investor_compliance_review_request", aggregateId: request.id, eventType: `investor.compliance.${status}`, payload: { organizationId: request.organization_id, auditEventId: audit.id } });
    return { requestId: request.id, status };
  });
}

export async function getOfferingPublicationRequest(requestId: string) {
  return (await requirePostgres().query<PublicationRequestRow>("SELECT * FROM fractal.offering_publication_requests WHERE id = $1", [requestId])).rows[0] ?? null;
}

export async function listOfferingPublicationRequests(input: { organizationId: string; status?: "submitted" | "approved" | "rejected" }) {
  const result = await requirePostgres().query<PublicationRequestRow & { submitted_at: Date; decided_at: Date | null; decided_by_identity_id: string | null; decision_reason: string | null; published_offering_id: string | null }>(
    `SELECT * FROM fractal.offering_publication_requests
      WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY submitted_at DESC, id DESC`,
    [input.organizationId, input.status ?? null],
  );
  return result.rows.map((request) => ({
    id: request.id, publicReference: request.public_reference, currency: request.currency, capacityMinor: request.capacity_minor,
    opensAt: request.opens_at.toISOString(), closesAt: request.closes_at.toISOString(), terms: request.terms,
    eligibilityPolicy: request.eligibility_policy, agreementDocumentHash: request.agreement_document_hash.toLowerCase(),
    disclosureBundleHash: request.disclosure_bundle_hash.toLowerCase(), status: request.status,
    agreementEvidenceDocumentId: request.agreement_evidence_document_id, disclosureEvidenceDocumentId: request.disclosure_evidence_document_id,
    approvedAssetApplicationVersionId: request.approved_asset_application_version_id,
    submittedByIdentityId: request.submitted_by_identity_id, submittedAt: request.submitted_at.toISOString(),
    decidedByIdentityId: request.decided_by_identity_id, decidedAt: request.decided_at?.toISOString() ?? null,
    decisionReason: request.decision_reason, offeringId: request.published_offering_id,
  }));
}

export async function getInvestorComplianceReviewRequest(requestId: string) {
  return (await requirePostgres().query<ComplianceRequestRow>("SELECT * FROM fractal.investor_compliance_review_requests WHERE id = $1", [requestId])).rows[0] ?? null;
}

export async function listInvestorComplianceReviewRequests(input: { organizationId: string; status?: "submitted" | "approved" | "rejected" }) {
  const result = await requirePostgres().query<ComplianceRequestRow & { submitted_at: Date; decided_at: Date | null; decided_by_identity_id: string | null; decision_reason: string | null }>(
    `SELECT * FROM fractal.investor_compliance_review_requests
      WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY submitted_at DESC, id DESC`,
    [input.organizationId, input.status ?? null],
  );
  return result.rows.map((request) => ({
    id: request.id, investorIdentityId: request.investor_identity_id, kycStatus: request.kyc_status,
    investorClass: request.investor_class, accreditationStatus: request.accreditation_status,
    jurisdictionCode: request.jurisdiction_code, reviewedAt: request.reviewed_at.toISOString(),
    expiresAt: request.expires_at?.toISOString() ?? null, evidence: request.evidence, status: request.status,
    submittedByIdentityId: request.submitted_by_identity_id, submittedAt: request.submitted_at.toISOString(),
    decidedByIdentityId: request.decided_by_identity_id, decidedAt: request.decided_at?.toISOString() ?? null,
    decisionReason: request.decision_reason,
  }));
}
