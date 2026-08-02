import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import type { OrganizationMembershipRole } from "./tenant-access.js";

export const organizationEntityTypes = [
  "private_company",
  "public_company",
  "partnership",
  "trust",
  "special_purpose_vehicle",
  "cooperative",
  "other",
] as const;
export type OrganizationEntityType = (typeof organizationEntityTypes)[number];

export const organizationVerificationEvidenceTypes = [
  "registration_evidence",
  "registry_extract",
  "registered_address",
  "ownership_structure",
  "representative_authority",
  "tax_registration",
  "other",
] as const;
export type OrganizationVerificationEvidenceType = (typeof organizationVerificationEvidenceTypes)[number];

export interface RegisteredAddress {
  line1: string;
  line2?: string;
  city: string;
  stateOrProvince?: string;
  postalCode?: string;
  countryCode: string;
}

export interface BeneficialOwnerDeclarationInput {
  ownerType: "natural_person" | "legal_entity";
  legalName: string;
  ownershipBps: number;
  isControlPerson: boolean;
  nationalityOrJurisdictionCode: string;
  countryOfResidenceCode?: string;
  identityLink?: "self";
}

export class OrganizationAuthorityError extends Error {}

type OrganizationRow = {
  id: string;
  legal_name: string;
  registration_number: string | null;
  jurisdiction_code: string | null;
  entity_type: OrganizationEntityType | null;
  primary_activity: string | null;
  registered_address: RegisteredAddress | null;
  status: "active" | "suspended" | "closed";
  verification_status: "not_started" | "pending" | "verified" | "rejected" | "expired" | "suspended";
  verification_version: number;
  verification_updated_at: Date;
  verified_at: Date | null;
  verification_expires_at: Date | null;
};

type VerificationRequestRow = {
  id: string;
  organization_id: string;
  version: number;
  legal_name: string;
  registration_number: string;
  jurisdiction_code: string;
  entity_type: OrganizationEntityType;
  primary_activity: string;
  registered_address: RegisteredAddress;
  representative_authority_basis: string;
  status: "draft" | "submitted" | "under_review" | "approved" | "rejected" | "superseded";
  submitted_by_identity_id: string;
  submitted_at: Date | null;
  decided_by_identity_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  verification_expires_at: Date | null;
};

function requiredText(value: string, field: string, min: number, max: number): string {
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new OrganizationAuthorityError(`${field} must be between ${min} and ${max} characters`);
  }
  return result;
}

function countryCode(value: string, field: string): string {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(result)) throw new OrganizationAuthorityError(`${field} must be a two-letter country code`);
  return result;
}

function normalizeAddress(value: RegisteredAddress): RegisteredAddress {
  return {
    line1: requiredText(value.line1, "registeredAddress.line1", 2, 240),
    ...(value.line2?.trim() ? { line2: requiredText(value.line2, "registeredAddress.line2", 1, 240) } : {}),
    city: requiredText(value.city, "registeredAddress.city", 2, 120),
    ...(value.stateOrProvince?.trim() ? { stateOrProvince: requiredText(value.stateOrProvince, "registeredAddress.stateOrProvince", 1, 120) } : {}),
    ...(value.postalCode?.trim() ? { postalCode: requiredText(value.postalCode, "registeredAddress.postalCode", 1, 32) } : {}),
    countryCode: countryCode(value.countryCode, "registeredAddress.countryCode"),
  };
}

function effectiveVerificationStatus(row: Pick<OrganizationRow, "verification_status" | "verification_expires_at">) {
  return row.verification_status === "verified" && row.verification_expires_at && row.verification_expires_at <= new Date()
    ? "expired" as const
    : row.verification_status;
}

function mapOrganization(row: OrganizationRow) {
  return {
    id: row.id,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    jurisdictionCode: row.jurisdiction_code,
    entityType: row.entity_type,
    primaryActivity: row.primary_activity,
    registeredAddress: row.registered_address,
    status: row.status,
    verificationStatus: effectiveVerificationStatus(row),
    verificationVersion: row.verification_version,
    verificationUpdatedAt: row.verification_updated_at.toISOString(),
    verifiedAt: row.verified_at?.toISOString() ?? null,
    verificationExpiresAt: row.verification_expires_at?.toISOString() ?? null,
  };
}

function mapVerificationRequest(row: VerificationRequestRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    version: row.version,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    jurisdictionCode: row.jurisdiction_code,
    entityType: row.entity_type,
    primaryActivity: row.primary_activity,
    registeredAddress: row.registered_address,
    representativeAuthorityBasis: row.representative_authority_basis,
    status: row.status,
    submittedByIdentityId: row.submitted_by_identity_id,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    decidedByIdentityId: row.decided_by_identity_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    verificationExpiresAt: row.verification_expires_at?.toISOString() ?? null,
  };
}

async function requireIssuerIdentity(client: PoolClient, identityId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1
       FROM fractal.identities identity
       JOIN fractal.identity_role_assignments assignment ON assignment.identity_id = identity.id
      WHERE identity.id = $1
        AND identity.status = 'active'
        AND identity.email_verified_at IS NOT NULL
        AND assignment.scope_type = 'global'
        AND assignment.role = 'issuer'
        AND assignment.revoked_at IS NULL`,
    [identityId],
  );
  if (result.rowCount !== 1) throw new OrganizationAuthorityError("A verified issuer identity is required");
}

export async function createIssuerOrganization(input: {
  identityId: string;
  commandKey?: string;
  legalName: string;
  registrationNumber: string;
  jurisdictionCode: string;
  entityType: OrganizationEntityType;
  primaryActivity: string;
  registeredAddress: RegisteredAddress;
}) {
  const payload = {
    legalName: requiredText(input.legalName, "legalName", 2, 240),
    registrationNumber: requiredText(input.registrationNumber, "registrationNumber", 2, 120).toUpperCase(),
    jurisdictionCode: countryCode(input.jurisdictionCode, "jurisdictionCode"),
    entityType: input.entityType,
    primaryActivity: requiredText(input.primaryActivity, "primaryActivity", 2, 500),
    registeredAddress: normalizeAddress(input.registeredAddress),
  };
  if (!organizationEntityTypes.includes(payload.entityType)) throw new OrganizationAuthorityError("entityType is invalid");

  return runPostgresIdempotentCommand({
    actorIdentityId: input.identityId,
    scopeKey: `identity:${input.identityId}`,
    route: "organization.create",
    commandKey: input.commandKey,
    payload,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await requireIssuerIdentity(client, input.identityId);
      const organizationId = randomUUID();
      const membershipId = randomUUID();
      await client.query(
        `INSERT INTO fractal.organizations
           (id, legal_name, registration_number, status, created_by_identity_id, jurisdiction_code,
            entity_type, primary_activity, registered_address, verification_status)
         VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,'not_started')`,
        [organizationId, payload.legalName, payload.registrationNumber, input.identityId, payload.jurisdictionCode, payload.entityType, payload.primaryActivity, payload.registeredAddress],
      );
      await client.query(
        `INSERT INTO fractal.organization_memberships
           (id, organization_id, identity_id, role, status)
         VALUES ($1,$2,$3,'owner','active')`,
        [membershipId, organizationId, input.identityId],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${organizationId}`,
        organizationId,
        actorId: input.identityId,
        actorType: "identity",
        action: "organization.created",
        entityType: "organization",
        entityId: organizationId,
        payload: { jurisdictionCode: payload.jurisdictionCode, entityType: payload.entityType, verificationStatus: "not_started" },
      });
      await appendOutboxEvent(client, {
        aggregateType: "organization",
        aggregateId: organizationId,
        eventType: "organization.created",
        payload: { organizationId, ownerMembershipId: membershipId, auditEventId: audit.id },
      });
      return { status: 201, body: { organizationId, membershipId, verificationStatus: "not_started" as const } };
    },
  });
}

export async function recordOrganizationVerificationEvidence(input: {
  organizationId: string;
  uploadedByIdentityId: string;
  evidenceType: OrganizationVerificationEvidenceType;
  filename: string;
  mimeType: string;
  storageKey: string;
  contentSha256: string;
  bytes: number;
}) {
  const filename = requiredText(input.filename, "filename", 1, 240);
  const mimeType = requiredText(input.mimeType, "mimeType", 3, 120).toLowerCase();
  const storageKey = requiredText(input.storageKey, "storageKey", 1, 1000);
  const contentSha256 = input.contentSha256.trim().toLowerCase();
  if (!organizationVerificationEvidenceTypes.includes(input.evidenceType)) throw new OrganizationAuthorityError("evidenceType is invalid");
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw new OrganizationAuthorityError("contentSha256 must be a SHA-256 hash");
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) throw new OrganizationAuthorityError("bytes must be a positive safe integer");
  return withPostgresTransaction(async (client) => {
    const membership = await client.query(
      `SELECT 1 FROM fractal.organization_memberships
        WHERE organization_id = $1 AND identity_id = $2 AND status = 'active'
          AND revoked_at IS NULL AND role IN ('owner', 'administrator') FOR SHARE`,
      [input.organizationId, input.uploadedByIdentityId],
    );
    if (membership.rowCount !== 1) throw new OrganizationAuthorityError("Access denied to organization verification evidence");
    const evidenceDocumentId = randomUUID();
    await client.query(
      `INSERT INTO fractal.organization_verification_evidence_documents
         (id, organization_id, evidence_type, filename, mime_type, storage_key, content_sha256, bytes, uploaded_by_identity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [evidenceDocumentId, input.organizationId, input.evidenceType, filename, mimeType, storageKey, contentSha256, input.bytes, input.uploadedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`,
      organizationId: input.organizationId,
      actorId: input.uploadedByIdentityId,
      actorType: "identity",
      action: "organization.verification_evidence.recorded",
      entityType: "organization_verification_evidence_document",
      entityId: evidenceDocumentId,
      payload: { evidenceType: input.evidenceType, contentSha256, bytes: input.bytes },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_verification_evidence_document",
      aggregateId: evidenceDocumentId,
      eventType: "organization.verification_evidence.recorded",
      payload: { organizationId: input.organizationId, auditEventId: audit.id },
    });
    return { evidenceDocumentId, contentSha256 };
  });
}

export async function submitOrganizationVerification(input: {
  organizationId: string;
  submittedByIdentityId: string;
  commandKey?: string;
  legalName: string;
  registrationNumber: string;
  jurisdictionCode: string;
  entityType: OrganizationEntityType;
  primaryActivity: string;
  registeredAddress: RegisteredAddress;
  representativeAuthorityBasis: string;
  beneficialOwners: BeneficialOwnerDeclarationInput[];
  evidenceDocumentIds: string[];
}) {
  const beneficialOwners = input.beneficialOwners.map((owner) => ({
    ownerType: owner.ownerType,
    legalName: requiredText(owner.legalName, "beneficialOwner.legalName", 2, 240),
    ownershipBps: owner.ownershipBps,
    isControlPerson: owner.isControlPerson,
    nationalityOrJurisdictionCode: countryCode(owner.nationalityOrJurisdictionCode, "beneficialOwner.nationalityOrJurisdictionCode"),
    ...(owner.countryOfResidenceCode ? { countryOfResidenceCode: countryCode(owner.countryOfResidenceCode, "beneficialOwner.countryOfResidenceCode") } : {}),
    ...(owner.identityLink ? { identityLink: owner.identityLink } : {}),
  }));
  if (beneficialOwners.length < 1 || beneficialOwners.length > 50) throw new OrganizationAuthorityError("Between 1 and 50 beneficial owners are required");
  if (beneficialOwners.some((owner) => !Number.isInteger(owner.ownershipBps) || owner.ownershipBps < 0 || owner.ownershipBps > 10000)) throw new OrganizationAuthorityError("Beneficial-owner ownership must use basis points between 0 and 10000");
  if (beneficialOwners.reduce((total, owner) => total + owner.ownershipBps, 0) !== 10000) throw new OrganizationAuthorityError("Beneficial-owner ownership must total exactly 10000 basis points");
  if (!beneficialOwners.some((owner) => owner.isControlPerson)) throw new OrganizationAuthorityError("At least one control person is required");
  if (beneficialOwners.some((owner) => owner.ownerType === "natural_person" && !owner.countryOfResidenceCode)) throw new OrganizationAuthorityError("Natural-person owners require a country of residence");
  if (beneficialOwners.some((owner) => owner.ownerType !== "natural_person" && owner.identityLink === "self")) throw new OrganizationAuthorityError("Only a natural-person owner may use the submitting identity self-declaration link");
  if (beneficialOwners.filter((owner) => owner.identityLink === "self").length > 1) throw new OrganizationAuthorityError("The submitting identity may self-declare only one beneficial-owner record per verification snapshot");
  const evidenceDocumentIds = [...new Set(input.evidenceDocumentIds)];
  if (evidenceDocumentIds.length < 3 || evidenceDocumentIds.length > 30) throw new OrganizationAuthorityError("Between 3 and 30 verification evidence documents are required");
  const payload = {
    legalName: requiredText(input.legalName, "legalName", 2, 240),
    registrationNumber: requiredText(input.registrationNumber, "registrationNumber", 2, 120).toUpperCase(),
    jurisdictionCode: countryCode(input.jurisdictionCode, "jurisdictionCode"),
    entityType: input.entityType,
    primaryActivity: requiredText(input.primaryActivity, "primaryActivity", 2, 500),
    registeredAddress: normalizeAddress(input.registeredAddress),
    representativeAuthorityBasis: requiredText(input.representativeAuthorityBasis, "representativeAuthorityBasis", 10, 2000),
    beneficialOwners,
    evidenceDocumentIds,
  };
  if (!organizationEntityTypes.includes(payload.entityType)) throw new OrganizationAuthorityError("entityType is invalid");

  return runPostgresIdempotentCommand({
    actorIdentityId: input.submittedByIdentityId,
    scopeKey: `organization:${input.organizationId}`,
    route: "organization.verification.submit",
    commandKey: input.commandKey,
    payload,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      const membership = await client.query(
        `SELECT 1 FROM fractal.organization_memberships
          WHERE organization_id = $1 AND identity_id = $2 AND status = 'active'
            AND revoked_at IS NULL AND role IN ('owner', 'administrator') FOR SHARE`,
        [input.organizationId, input.submittedByIdentityId],
      );
      if (membership.rowCount !== 1) throw new OrganizationAuthorityError("Only an active owner or administrator may submit organization verification");
      const selfLinkedOwner = beneficialOwners.find((owner) => owner.identityLink === "self");
      let canonicalBeneficialOwners = beneficialOwners;
      if (selfLinkedOwner) {
        const subject = await client.query<{ legal_name: string }>(
          `SELECT legal_name FROM fractal.identities
            WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE`,
          [input.submittedByIdentityId],
        );
        if (subject.rowCount !== 1) throw new OrganizationAuthorityError("A self-linked beneficial owner requires the active verified submitting identity");
        canonicalBeneficialOwners = beneficialOwners.map((owner) => owner.identityLink === "self"
          ? { ...owner, legalName: subject.rows[0]!.legal_name }
          : owner);
      }
      const organization = await client.query<{ next_version: number }>(
        `SELECT COALESCE((
                  SELECT MAX(request.version)
                    FROM fractal.organization_verification_requests request
                   WHERE request.organization_id = organization.id
                ), 0)::integer + 1 AS next_version
           FROM fractal.organizations organization
          WHERE organization.id = $1 AND organization.status = 'active'
          FOR UPDATE`,
        [input.organizationId],
      );
      const version = organization.rows[0]?.next_version;
      if (!version) throw new OrganizationAuthorityError("Organization is not active");
      const evidence = await client.query<{ id: string; evidence_type: OrganizationVerificationEvidenceType }>(
        `SELECT id, evidence_type FROM fractal.organization_verification_evidence_documents
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
        [input.organizationId, evidenceDocumentIds],
      );
      if (evidence.rowCount !== evidenceDocumentIds.length) throw new OrganizationAuthorityError("Every verification document must belong to this organization");
      const requiredTypes = new Set(evidence.rows.map((row) => row.evidence_type));
      for (const requiredType of ["registration_evidence", "ownership_structure", "representative_authority"] as const) {
        if (!requiredTypes.has(requiredType)) throw new OrganizationAuthorityError(`${requiredType} evidence is required`);
      }

      const requestId = randomUUID();
      await client.query(
        `INSERT INTO fractal.organization_verification_requests
           (id, organization_id, version, legal_name, registration_number, jurisdiction_code, entity_type,
            primary_activity, registered_address, representative_authority_basis, status, submitted_by_identity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)`,
        [requestId, input.organizationId, version, payload.legalName, payload.registrationNumber, payload.jurisdictionCode, payload.entityType, payload.primaryActivity, payload.registeredAddress, payload.representativeAuthorityBasis, input.submittedByIdentityId],
      );
      for (const owner of canonicalBeneficialOwners) {
        await client.query(
          `INSERT INTO fractal.organization_beneficial_owner_declarations
             (id, verification_request_id, owner_type, legal_name, ownership_bps, is_control_person,
              nationality_or_jurisdiction_code, country_of_residence_code, subject_identity_id,
              subject_link_basis, subject_linked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END)`,
          [randomUUID(), requestId, owner.ownerType, owner.legalName, owner.ownershipBps, owner.isControlPerson,
            owner.nationalityOrJurisdictionCode, owner.countryOfResidenceCode ?? null,
            owner.identityLink === "self" ? input.submittedByIdentityId : null,
            owner.identityLink === "self" ? "submitting_identity_self_declaration" : null],
        );
      }
      for (const document of evidence.rows) {
        await client.query(
          `INSERT INTO fractal.organization_verification_request_evidence
             (verification_request_id, organization_id, evidence_document_id, evidence_type)
           VALUES ($1,$2,$3,$4)`,
          [requestId, input.organizationId, document.id, document.evidence_type],
        );
      }
      await client.query(
        `UPDATE fractal.organization_verification_requests SET status = 'submitted', submitted_at = now() WHERE id = $1`,
        [requestId],
      );
      await client.query(
        `UPDATE fractal.organizations
            SET verification_status = 'pending', verification_updated_at = now(), updated_at = now()
          WHERE id = $1`,
        [input.organizationId],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${input.organizationId}`,
        organizationId: input.organizationId,
        actorId: input.submittedByIdentityId,
        actorType: "identity",
        action: "organization.verification.submitted",
        entityType: "organization_verification_request",
        entityId: requestId,
        payload: { version, beneficialOwnerCount: beneficialOwners.length, evidenceDocumentCount: evidenceDocumentIds.length },
      });
      await appendOutboxEvent(client, {
        aggregateType: "organization_verification_request",
        aggregateId: requestId,
        eventType: "organization.verification.submitted",
        payload: { organizationId: input.organizationId, version, auditEventId: audit.id },
      });
      return { status: 201, body: { requestId, version, status: "submitted" as const } };
    },
  });
}

export async function decideOrganizationVerification(input: {
  requestId: string;
  decidedByIdentityId: string;
  approve: boolean;
  reason: string;
  validityDays?: number;
}) {
  const reason = requiredText(input.reason, "reason", 10, 2000);
  const validityDays = input.validityDays ?? 365;
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 730) throw new OrganizationAuthorityError("validityDays must be between 1 and 730");
  return withPostgresTransaction(async (client) => {
    const reviewer = await client.query(
      `SELECT 1
         FROM fractal.identities identity
         JOIN fractal.identity_role_assignments assignment ON assignment.identity_id = identity.id
        WHERE identity.id = $1 AND identity.status = 'active' AND identity.email_verified_at IS NOT NULL
          AND assignment.scope_type = 'global' AND assignment.role IN ('operator', 'admin')
          AND assignment.revoked_at IS NULL
        FOR SHARE OF identity, assignment`,
      [input.decidedByIdentityId],
    );
    if (reviewer.rowCount !== 1) throw new OrganizationAuthorityError("An active operator or administrator identity is required for organization verification decisions");
    const result = await client.query<VerificationRequestRow>(
      `SELECT * FROM fractal.organization_verification_requests WHERE id = $1 FOR UPDATE`,
      [input.requestId],
    );
    const request = result.rows[0];
    if (!request || !["submitted", "under_review"].includes(request.status)) throw new OrganizationAuthorityError("Organization verification request is not awaiting a decision");
    if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new OrganizationAuthorityError("The submitter cannot decide organization verification");
    const reviewerMembership = await client.query(
      `SELECT 1 FROM fractal.organization_memberships
        WHERE organization_id = $1 AND identity_id = $2 AND status = 'active' AND revoked_at IS NULL`,
      [request.organization_id, input.decidedByIdentityId],
    );
    if (reviewerMembership.rowCount) throw new OrganizationAuthorityError("An organization member cannot decide its verification");
    const decidedAt = new Date();
    const verificationExpiresAt = input.approve ? new Date(decidedAt.getTime() + validityDays * 24 * 60 * 60 * 1_000) : null;
    const status = input.approve ? "approved" : "rejected";
    await client.query(
      `UPDATE fractal.organization_verification_requests
          SET status = $2, decided_by_identity_id = $3, decided_at = $4,
              decision_reason = $5, verification_expires_at = $6
        WHERE id = $1`,
      [request.id, status, input.decidedByIdentityId, decidedAt, reason, verificationExpiresAt],
    );
    if (input.approve) {
      await client.query(
        `UPDATE fractal.organization_verification_requests
            SET status = 'superseded'
          WHERE organization_id = $1 AND status = 'approved' AND id <> $2`,
        [request.organization_id, request.id],
      );
      await client.query(
        `UPDATE fractal.organizations
            SET legal_name = $2, registration_number = $3, jurisdiction_code = $4, entity_type = $5,
                primary_activity = $6, registered_address = $7, verification_status = 'verified',
                verification_version = $8, verification_updated_at = $9, verified_at = $9,
                verified_by_identity_id = $10, verification_expires_at = $11, updated_at = $9
          WHERE id = $1`,
        [request.organization_id, request.legal_name, request.registration_number, request.jurisdiction_code, request.entity_type, request.primary_activity, request.registered_address, request.version, decidedAt, input.decidedByIdentityId, verificationExpiresAt],
      );
    } else {
      await client.query(
        `UPDATE fractal.organizations
            SET verification_status = 'rejected', verification_updated_at = $2, updated_at = $2
          WHERE id = $1`,
        [request.organization_id, decidedAt],
      );
    }
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${request.organization_id}`,
      organizationId: request.organization_id,
      actorId: input.decidedByIdentityId,
      actorType: "identity",
      action: `organization.verification.${status}`,
      entityType: "organization_verification_request",
      entityId: request.id,
      reason,
      payload: { version: request.version, verificationExpiresAt: verificationExpiresAt?.toISOString() ?? null },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_verification_request",
      aggregateId: request.id,
      eventType: `organization.verification.${status}`,
      payload: { organizationId: request.organization_id, version: request.version, auditEventId: audit.id },
    });
    return { requestId: request.id, organizationId: request.organization_id, status, verificationExpiresAt: verificationExpiresAt?.toISOString() ?? null };
  });
}

export async function getOrganizationAuthorityWorkspace(input: { organizationId: string; viewerRole?: OrganizationMembershipRole; currentIdentityId?: string }) {
  const viewerRole = input.viewerRole ?? "owner";
  const mayAdminister = viewerRole === "owner" || viewerRole === "administrator";
  const mayReviewRestrictedKyb = mayAdminister || viewerRole === "compliance_reviewer";
  const organization = await requirePostgres().query<OrganizationRow>(
    `SELECT id, legal_name, registration_number, jurisdiction_code, entity_type, primary_activity,
            registered_address, status, verification_status, verification_version, verification_updated_at,
            verified_at, verification_expires_at
       FROM fractal.organizations WHERE id = $1`,
    [input.organizationId],
  );
  const row = organization.rows[0];
  if (!row) throw new OrganizationAuthorityError("Organization not found");
  const [memberships, invitations, requests, owners, evidence, ownershipTransfers] = await Promise.all([
    requirePostgres().query<{ id: string; identity_id: string; legal_name: string; email: string; role: OrganizationMembershipRole; status: string; granted_at: Date; revoked_at: Date | null }>(
      `SELECT membership.id, membership.identity_id, identity.legal_name, identity.email,
              membership.role, membership.status, membership.granted_at, membership.revoked_at
         FROM fractal.organization_memberships membership
         JOIN fractal.identities identity ON identity.id = membership.identity_id
        WHERE membership.organization_id = $1
        ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END,
                 identity.legal_name, membership.id`, [input.organizationId]),
    mayAdminister ? requirePostgres().query<{ id: string; email: string; role: OrganizationMembershipRole; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; delivery_status: string; created_at: Date }>(
      `SELECT id, email, role, expires_at, accepted_at, revoked_at, delivery_status, created_at
         FROM fractal.organization_invitations
        WHERE organization_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 100`, [input.organizationId]) : Promise.resolve({ rows: [] }),
    requirePostgres().query<VerificationRequestRow>(
      `SELECT * FROM fractal.organization_verification_requests
        WHERE organization_id = $1 ORDER BY version DESC LIMIT 20`, [input.organizationId]),
    mayReviewRestrictedKyb ? requirePostgres().query<{ id: string; verification_request_id: string; owner_type: string; legal_name: string; ownership_bps: number; is_control_person: boolean; nationality_or_jurisdiction_code: string; country_of_residence_code: string | null; subject_link_basis: string | null }>(
      `SELECT owner.* FROM fractal.organization_beneficial_owner_declarations owner
         JOIN fractal.organization_verification_requests request ON request.id = owner.verification_request_id
        WHERE request.organization_id = $1 ORDER BY request.version DESC, owner.ownership_bps DESC, owner.id`, [input.organizationId]) : Promise.resolve({ rows: [] }),
    mayReviewRestrictedKyb ? requirePostgres().query<{ id: string; evidence_type: OrganizationVerificationEvidenceType; filename: string; mime_type: string; content_sha256: string; bytes: string; created_at: Date }>(
      `SELECT id, evidence_type, filename, mime_type, content_sha256, bytes, created_at
         FROM fractal.organization_verification_evidence_documents
        WHERE organization_id = $1 ORDER BY created_at DESC, id DESC`, [input.organizationId]) : Promise.resolve({ rows: [] }),
    requirePostgres().query<{ id: string; source_membership_id: string; target_membership_id: string; source_identity_id: string; target_identity_id: string; source_name: string; target_name: string; reason: string; status: string; expires_at: Date; decision_reason: string | null; decided_at: Date | null; created_at: Date }>(
      `SELECT transfer.id, transfer.source_membership_id, transfer.target_membership_id,
              source.identity_id AS source_identity_id, target.identity_id AS target_identity_id,
              source_identity.legal_name AS source_name, target_identity.legal_name AS target_name,
              transfer.reason, transfer.status, transfer.expires_at, transfer.decision_reason,
              transfer.decided_at, transfer.created_at
         FROM fractal.organization_ownership_transfer_requests transfer
         JOIN fractal.organization_memberships source ON source.id = transfer.source_membership_id
         JOIN fractal.organization_memberships target ON target.id = transfer.target_membership_id
         JOIN fractal.identities source_identity ON source_identity.id = source.identity_id
         JOIN fractal.identities target_identity ON target_identity.id = target.identity_id
        WHERE transfer.organization_id = $1
          AND ($2::boolean OR source.identity_id = $3 OR target.identity_id = $3)
        ORDER BY transfer.created_at DESC, transfer.id DESC LIMIT 50`,
      [input.organizationId, mayAdminister, input.currentIdentityId ?? null]),
  ]);
  const latestRequestId = requests.rows[0]?.id;
  return {
    organization: mapOrganization(row),
    memberships: memberships.rows.map((membership) => ({
      id: membership.id, identityId: membership.identity_id, legalName: membership.legal_name, email: membership.email,
      role: membership.role, status: membership.status, grantedAt: membership.granted_at.toISOString(), revokedAt: membership.revoked_at?.toISOString() ?? null,
    })),
    invitations: invitations.rows.map((invitation) => ({
      id: invitation.id, email: invitation.email, role: invitation.role,
      state: invitation.accepted_at ? "accepted" : invitation.revoked_at ? "revoked" : invitation.expires_at <= new Date() ? "expired" : invitation.delivery_status === "terminal" ? "delivery_failed" : invitation.delivery_status,
      deliveryStatus: invitation.delivery_status, expiresAt: invitation.expires_at.toISOString(), createdAt: invitation.created_at.toISOString(),
    })),
    verificationRequests: requests.rows.map(mapVerificationRequest),
    beneficialOwners: owners.rows.filter((owner) => owner.verification_request_id === latestRequestId).map((owner) => ({
      id: owner.id, ownerType: owner.owner_type, legalName: owner.legal_name, ownershipBps: owner.ownership_bps,
      isControlPerson: owner.is_control_person, nationalityOrJurisdictionCode: owner.nationality_or_jurisdiction_code,
      countryOfResidenceCode: owner.country_of_residence_code,
      identityLink: owner.subject_link_basis === "submitting_identity_self_declaration" ? "self" : null,
    })),
    evidenceDocuments: evidence.rows.map((document) => ({
      id: document.id, evidenceType: document.evidence_type, filename: document.filename, mimeType: document.mime_type,
      contentSha256: document.content_sha256, bytes: document.bytes, createdAt: document.created_at.toISOString(),
    })),
    ownershipTransfers: ownershipTransfers.rows.map((transfer) => ({
      id: transfer.id, sourceMembershipId: transfer.source_membership_id, targetMembershipId: transfer.target_membership_id,
      sourceIdentityId: transfer.source_identity_id, targetIdentityId: transfer.target_identity_id,
      sourceName: transfer.source_name, targetName: transfer.target_name, reason: transfer.reason,
      status: transfer.status === "pending" && transfer.expires_at <= new Date() ? "expired" : transfer.status,
      expiresAt: transfer.expires_at.toISOString(), decisionReason: transfer.decision_reason,
      decidedAt: transfer.decided_at?.toISOString() ?? null, createdAt: transfer.created_at.toISOString(),
    })),
  };
}

export async function listOrganizationVerificationReviewQueue(status?: "submitted" | "under_review" | "approved" | "rejected") {
  const result = await requirePostgres().query<VerificationRequestRow & { organization_legal_name: string }>(
    `SELECT request.*, organization.legal_name AS organization_legal_name
       FROM fractal.organization_verification_requests request
       JOIN fractal.organizations organization ON organization.id = request.organization_id
      WHERE ($1::text IS NULL AND request.status IN ('submitted', 'under_review')) OR request.status = $1
      ORDER BY request.submitted_at, request.id LIMIT 200`,
    [status ?? null],
  );
  return result.rows.map((row) => ({ ...mapVerificationRequest(row), organizationLegalName: row.organization_legal_name }));
}

export async function getOrganizationVerificationReview(requestId: string) {
  const requestResult = await requirePostgres().query<VerificationRequestRow & { organization_legal_name: string }>(
    `SELECT request.*, organization.legal_name AS organization_legal_name
       FROM fractal.organization_verification_requests request
       JOIN fractal.organizations organization ON organization.id = request.organization_id
      WHERE request.id = $1`,
    [requestId],
  );
  const request = requestResult.rows[0];
  if (!request) throw new OrganizationAuthorityError("Organization verification request not found");
  const [owners, evidence] = await Promise.all([
    requirePostgres().query<{ id: string; owner_type: string; legal_name: string; ownership_bps: number; is_control_person: boolean; nationality_or_jurisdiction_code: string; country_of_residence_code: string | null; subject_link_basis: string | null }>(
      `SELECT id, owner_type, legal_name, ownership_bps, is_control_person,
              nationality_or_jurisdiction_code, country_of_residence_code, subject_link_basis
         FROM fractal.organization_beneficial_owner_declarations
        WHERE verification_request_id = $1 ORDER BY ownership_bps DESC, id`, [requestId]),
    requirePostgres().query<{ id: string; evidence_type: OrganizationVerificationEvidenceType; filename: string; mime_type: string; content_sha256: string; bytes: string; created_at: Date }>(
      `SELECT document.id, link.evidence_type, document.filename, document.mime_type,
              document.content_sha256, document.bytes, document.created_at
         FROM fractal.organization_verification_request_evidence link
         JOIN fractal.organization_verification_evidence_documents document ON document.id = link.evidence_document_id
        WHERE link.verification_request_id = $1 ORDER BY link.evidence_type, document.created_at, document.id`, [requestId]),
  ]);
  return {
    request: { ...mapVerificationRequest(request), organizationLegalName: request.organization_legal_name },
    beneficialOwners: owners.rows.map((owner) => ({
      id: owner.id, ownerType: owner.owner_type, legalName: owner.legal_name, ownershipBps: owner.ownership_bps,
      isControlPerson: owner.is_control_person, nationalityOrJurisdictionCode: owner.nationality_or_jurisdiction_code,
      countryOfResidenceCode: owner.country_of_residence_code,
      identityLink: owner.subject_link_basis === "submitting_identity_self_declaration" ? "self" : null,
    })),
    evidenceDocuments: evidence.rows.map((document) => ({
      id: document.id, evidenceType: document.evidence_type, filename: document.filename, mimeType: document.mime_type,
      contentSha256: document.content_sha256, bytes: document.bytes, createdAt: document.created_at.toISOString(),
    })),
  };
}

export async function getOrganizationVerificationEvidence(input: { organizationId: string; evidenceDocumentId: string }) {
  const result = await requirePostgres().query<{
    id: string; organization_id: string; filename: string; mime_type: string; storage_key: string; content_sha256: string;
  }>(
    `SELECT id, organization_id, filename, mime_type, storage_key, content_sha256
       FROM fractal.organization_verification_evidence_documents
      WHERE id = $1 AND organization_id = $2`,
    [input.evidenceDocumentId, input.organizationId],
  );
  const document = result.rows[0];
  return document ? {
    id: document.id, organizationId: document.organization_id, filename: document.filename,
    mimeType: document.mime_type, storageKey: document.storage_key, contentSha256: document.content_sha256,
  } : null;
}

export async function requireOrganizationVerifiedForNewBusiness(client: PoolClient, organizationId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM fractal.organizations
      WHERE id = $1 AND status = 'active' AND verification_status = 'verified'
        AND verification_expires_at > now() FOR SHARE`,
    [organizationId],
  );
  if (result.rowCount !== 1) throw new OrganizationAuthorityError("Organization verification must be current before starting a new asset application");
}
