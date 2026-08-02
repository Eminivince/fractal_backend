import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class OfferingIssuanceTermsError extends Error {}

type TermsRow = {
  id: string; organization_id: string; offering_id: string; offering_version_id: string; currency: string;
  token_unit_price_minor: string; max_total_supply: string; allocation_policy_hash: string; allocation_policy_evidence_document_id: string | null; status: "submitted" | "approved" | "rejected";
  submitted_by_identity_id: string; submitted_at: Date; decided_by_identity_id: string | null; decided_at: Date | null; decision_reason: string | null;
};

function amount(value: bigint | number, field: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new OfferingIssuanceTermsError(`${field} must be a safe integer`);
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result <= 0n) throw new OfferingIssuanceTermsError(`${field} must be greater than zero`);
  return result;
}

function map(row: TermsRow) {
  return {
    id: row.id, organizationId: row.organization_id, offeringId: row.offering_id, offeringVersionId: row.offering_version_id,
    currency: row.currency, tokenUnitPriceMinor: row.token_unit_price_minor, maxTotalSupply: row.max_total_supply,
    allocationPolicyHash: row.allocation_policy_hash, allocationPolicyEvidenceDocumentId: row.allocation_policy_evidence_document_id, status: row.status, submittedByIdentityId: row.submitted_by_identity_id,
    submittedAt: row.submitted_at.toISOString(), decidedByIdentityId: row.decided_by_identity_id,
    decidedAt: row.decided_at?.toISOString() ?? null, decisionReason: row.decision_reason,
  };
}

export async function submitOfferingIssuanceTerms(input: {
  organizationId: string; offeringId: string; submittedByIdentityId: string; tokenUnitPriceMinor: bigint | number;
  maxTotalSupply: bigint | number; allocationPolicyEvidenceDocumentId: string;
}): Promise<{ requestId: string }> {
  const tokenUnitPriceMinor = amount(input.tokenUnitPriceMinor, "tokenUnitPriceMinor");
  const maxTotalSupply = amount(input.maxTotalSupply, "maxTotalSupply");
  const allocationPolicyEvidenceDocumentId = input.allocationPolicyEvidenceDocumentId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(allocationPolicyEvidenceDocumentId)) throw new OfferingIssuanceTermsError("allocationPolicyEvidenceDocumentId must be a UUID");
  const requestId = randomUUID();
  await withPostgresTransaction(async (client) => {
    const offering = await client.query<{ currency: string; capacity_minor: string; version_id: string }>(
      `SELECT product.currency, product.capacity_minor, version.id AS version_id
         FROM fractal.offering_products product
         JOIN LATERAL (SELECT id FROM fractal.offering_publication_versions WHERE offering_id = product.id ORDER BY version DESC LIMIT 1) version ON true
        WHERE product.id = $1 AND product.organization_id = $2 AND product.status = 'published' FOR SHARE`,
      [input.offeringId, input.organizationId],
    );
    const row = offering.rows[0];
    if (!row) throw new OfferingIssuanceTermsError("Only a published offering with immutable terms can receive issuance economics");
    if (tokenUnitPriceMinor * maxTotalSupply > BigInt(row.capacity_minor)) throw new OfferingIssuanceTermsError("Token supply at the proposed unit price exceeds offering capacity");
    const evidence = await client.query<{ content_sha256: string }>(
      `SELECT content_sha256 FROM fractal.governance_evidence_documents
        WHERE id = $1 AND organization_id = $2 AND offering_id = $3 AND evidence_kind = 'allocation_policy' FOR SHARE`,
      [allocationPolicyEvidenceDocumentId, input.organizationId, input.offeringId],
    );
    const allocationPolicyHash = evidence.rows[0]?.content_sha256;
    if (!allocationPolicyHash) throw new OfferingIssuanceTermsError("Issuance terms require allocation-policy evidence recorded for this offering");
    await client.query(
      `INSERT INTO fractal.offering_issuance_term_requests
         (id, organization_id, offering_id, offering_version_id, currency, token_unit_price_minor, max_total_supply, allocation_policy_hash, allocation_policy_evidence_document_id, status, submitted_by_identity_id, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'submitted', $10, now())`,
      [requestId, input.organizationId, input.offeringId, row.version_id, row.currency, tokenUnitPriceMinor.toString(), maxTotalSupply.toString(), allocationPolicyHash, allocationPolicyEvidenceDocumentId, input.submittedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.submittedByIdentityId, actorType: "user", action: "offering.issuance_terms.submitted", entityType: "offering_issuance_term_request", entityId: requestId, payload: { offeringId: input.offeringId, offeringVersionId: row.version_id, currency: row.currency, tokenUnitPriceMinor: tokenUnitPriceMinor.toString(), maxTotalSupply: maxTotalSupply.toString(), allocationPolicyHash, allocationPolicyEvidenceDocumentId } });
    await appendOutboxEvent(client, { aggregateType: "offering_issuance_term_request", aggregateId: requestId, eventType: "offering.issuance_terms.submitted", payload: { organizationId: input.organizationId, offeringId: input.offeringId, auditEventId: audit.id } });
  });
  return { requestId };
}

export async function decideOfferingIssuanceTerms(input: { requestId: string; decidedByIdentityId: string; approve: boolean; reason?: string }): Promise<{ requestId: string; status: "approved" | "rejected" }> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<TermsRow>("SELECT * FROM fractal.offering_issuance_term_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
    const request = result.rows[0];
    if (!request) throw new OfferingIssuanceTermsError("Offering issuance terms request not found");
    if (request.status !== "submitted") throw new OfferingIssuanceTermsError("Offering issuance terms request has already been decided");
    if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new OfferingIssuanceTermsError("A different person must approve or reject this request");
    const reason = input.reason?.trim();
    if (!input.approve && !reason) throw new OfferingIssuanceTermsError("A rejection reason is required");
    const status = input.approve ? "approved" : "rejected";
    await client.query("UPDATE fractal.offering_issuance_term_requests SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4 WHERE id = $1", [request.id, status, input.decidedByIdentityId, input.approve ? reason ?? null : reason]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${request.organization_id}`, organizationId: request.organization_id, actorId: input.decidedByIdentityId, actorType: "user", action: `offering.issuance_terms.${status}`, entityType: "offering_issuance_term_request", entityId: request.id, reason: reason ?? undefined, payload: { offeringId: request.offering_id, tokenUnitPriceMinor: request.token_unit_price_minor, maxTotalSupply: request.max_total_supply } });
    await appendOutboxEvent(client, { aggregateType: "offering_issuance_term_request", aggregateId: request.id, eventType: `offering.issuance_terms.${status}`, payload: { organizationId: request.organization_id, offeringId: request.offering_id, auditEventId: audit.id } });
    return { requestId: request.id, status };
  });
}

export async function getOfferingIssuanceTerms(requestId: string) {
  const row = (await requirePostgres().query<TermsRow>("SELECT * FROM fractal.offering_issuance_term_requests WHERE id = $1", [requestId])).rows[0];
  return row ? map(row) : null;
}

export async function listOfferingIssuanceTerms(input: { organizationId: string; status?: "submitted" | "approved" | "rejected" }) {
  const rows = await requirePostgres().query<TermsRow>("SELECT * FROM fractal.offering_issuance_term_requests WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY submitted_at DESC, id DESC", [input.organizationId, input.status ?? null]);
  return rows.rows.map(map);
}
