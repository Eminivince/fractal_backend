import { requirePostgres } from "../db/postgres.js";

type InvestorAgreementDocumentRow = {
  agreement_acceptance_id: string;
  public_reference: string;
  offering_name: string;
  version: number;
  accepted_at: Date;
  filename: string;
  mime_type: string;
  storage_key: string;
  content_sha256: string;
};

function map(row: InvestorAgreementDocumentRow) {
  return {
    id: row.agreement_acceptance_id,
    type: "agreement" as const,
    publicReference: row.public_reference,
    offeringName: row.offering_name,
    offeringVersion: row.version,
    acceptedAt: row.accepted_at.toISOString(),
    filename: row.filename,
    mimeType: row.mime_type,
  };
}

const agreementDocumentQuery = `
  SELECT acceptance.id AS agreement_acceptance_id,
         product.public_reference,
         COALESCE(NULLIF(version.terms ->> 'name', ''), product.public_reference) AS offering_name,
         version.version,
         acceptance.accepted_at,
         evidence.filename,
         evidence.mime_type,
         evidence.storage_key,
         evidence.content_sha256
    FROM fractal.agreement_acceptances acceptance
    JOIN fractal.offering_publication_versions version ON version.id = acceptance.offering_version_id
    JOIN fractal.offering_products product ON product.id = version.offering_id
    JOIN fractal.offering_publication_evidence_documents evidence
      ON evidence.organization_id = product.organization_id
     AND evidence.evidence_kind = 'agreement'
     -- Evidence intake canonicalizes digests to lowercase while the immutable
     -- checkout snapshot canonicalizes its digest to uppercase. Compare the
     -- digest values canonically, never by their storage representation.
     AND lower(evidence.content_sha256) = lower(acceptance.agreement_document_hash)
   WHERE acceptance.investor_identity_id = $1
     AND ($2::uuid IS NULL OR acceptance.id = $2)
   ORDER BY acceptance.accepted_at DESC, acceptance.id DESC`;

/** Lists only agreements that the current investor actually accepted. */
export async function listInvestorAgreementDocuments(identityId: string) {
  const result = await requirePostgres().query<InvestorAgreementDocumentRow>(agreementDocumentQuery, [identityId, null]);
  return result.rows.map(map);
}

/** Returns the storage fact only after applying the investor ownership predicate. */
export async function getInvestorAgreementDocument(input: { identityId: string; agreementAcceptanceId: string }) {
  const result = await requirePostgres().query<InvestorAgreementDocumentRow>(agreementDocumentQuery, [input.identityId, input.agreementAcceptanceId]);
  const row = result.rows[0];
  return row
    ? { ...map(row), storageKey: row.storage_key, contentSha256: row.content_sha256 }
    : null;
}
