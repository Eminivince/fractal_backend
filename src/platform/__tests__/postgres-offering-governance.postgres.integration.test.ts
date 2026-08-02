import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import {
  decideInvestorComplianceReview,
  decideOfferingPublicationRequest,
  OfferingGovernanceError,
  listInvestorComplianceReviewRequests,
  listOfferingPublicationRequests,
  submitInvestorComplianceReview,
  submitOfferingPublicationRequest,
  type PublicOfferingTerms,
} from "../postgres-offering-governance.js";
import {
  decideOfferingChainDeploymentRequest,
  OfferingChainDeploymentError,
  submitOfferingChainDeploymentRequest,
} from "../postgres-offering-chain-deployments.js";
import {
  decideOfferingIssuanceTerms,
  OfferingIssuanceTermsError,
  submitOfferingIssuanceTerms,
} from "../postgres-offering-issuance-terms.js";
import { getOpenInvestmentOffering, getPublicInvestmentOffering, listOpenInvestmentOfferings, listOrganizationIssuableOfferings, listPublicInvestmentOfferings } from "../postgres-investment-offerings.js";
import { recordAllocationPolicyEvidence } from "../postgres-governance-evidence.js";
import { recordOfferingPublicationEvidence } from "../postgres-offering-publication-evidence.js";
import { createAssetApplicationReviewItem, decideAssetApplicationRequest, decideAssetApplicationReviewItem, recordAssetApplicationEvidence, respondToAssetApplicationReviewItem, submitAssetApplicationRequest } from "../postgres-asset-applications.js";
import { assertProfessionalDeliverableEvidenceUploadAllowed, createProfessionalWorkOrder, decideProfessionalDeliverable, listAssignedProfessionalWorkOrderDeliverables, listAssignedProfessionalWorkOrders, listIssuerProfessionalWorkOrderDeliverables, ProfessionalWorkOrderError, recordProfessionalDeliverableEvidence, respondToProfessionalWorkOrder, submitProfessionalDeliverable } from "../postgres-professional-work-orders.js";
import { approveProfessionalFinanceApprovalPolicy, approveProfessionalInvoiceTaxTreatment, authorizeProfessionalPayout, authorizeProfessionalReplacementPayout, createProfessionalFinanceApprovalPolicy, createProfessionalInvoiceTaxTreatment, decideProfessionalFinanceExceptionResolution, decideProfessionalInvoice, executeProfessionalFinanceCreditNote, listProfessionalFinanceApprovalPolicies, listProfessionalFinanceExceptions, listProfessionalInvoiceTaxTreatments, listProfessionalPayoutExceptions, listProfessionalPayouts, openProfessionalFinanceException, prepareProfessionalFinanceExceptionResolution, ProfessionalInvoiceError, recordProfessionalFinanceExceptionEvidence, recordProfessionalPayoutProviderOutcome, submitProfessionalInvoice } from "../postgres-professional-invoices.js";
import { dispatchOneProfessionalPayout } from "../../services/professional-payout-dispatcher.js";
import { recordSumsubIdentityVerificationEvidence } from "../postgres-provider-identity-verification.js";

let organizationId = "";
let makerId = "";
let checkerId = "";
let investorId = "";
let professionalId = "";
const agreementHash = "c".repeat(64);
const disclosureHash = "d".repeat(64);

function offeringTerms(name: string): PublicOfferingTerms {
  return {
    name,
    publicSlug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${randomUUID()}`,
    minimumTicketMinor: 10_000,
    assetClass: "infrastructure",
    summary: "A governed public investment summary derived from an approved publication request.",
    thesis: "A controlled infrastructure investment thesis supported by approved source-asset evidence.",
    targetReturnBps: 1_500,
    termMonths: 24,
    riskSummary: "Capital is at risk and operating, liquidity, counterparty, and market risks may affect returns.",
    incomeSource: "Contracted operating receipts from the governed source asset.",
    structure: "A ring-fenced investment vehicle governed by the approved offering terms.",
    security: "The approved security package is described in the controlled offering documents.",
    feeSummary: "Fees are charged according to the approved offering memorandum.",
    nextMilestone: "The next controlled milestone will be reported through the issuer workspace.",
  };
}

async function recordPolicyEvidence(offeringId: string, contentSha256: string) {
  return recordAllocationPolicyEvidence({
    organizationId, offeringId, uploadedByIdentityId: makerId, filename: "allocation-policy.pdf", mimeType: "application/pdf",
    storageKey: `local://test/${randomUUID()}.pdf`, contentSha256, bytes: 128,
  });
}

async function recordPublicationEvidence() {
  const agreement = await recordOfferingPublicationEvidence({
    organizationId, evidenceKind: "agreement", uploadedByIdentityId: makerId, filename: "subscription-agreement.pdf", mimeType: "application/pdf",
    storageKey: `local://test/${randomUUID()}-agreement.pdf`, contentSha256: agreementHash, bytes: 128,
  });
  const disclosure = await recordOfferingPublicationEvidence({
    organizationId, evidenceKind: "disclosure_bundle", uploadedByIdentityId: makerId, filename: "disclosure-bundle.pdf", mimeType: "application/pdf",
    storageKey: `local://test/${randomUUID()}-disclosure.pdf`, contentSha256: disclosureHash, bytes: 128,
  });
  return { agreementEvidenceDocumentId: agreement.evidenceDocumentId, disclosureEvidenceDocumentId: disclosure.evidenceDocumentId };
}

async function createApprovedOrigin() {
  const evidence = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "asset-dossier.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-asset.pdf`, contentSha256: "a".repeat(64), bytes: 128 });
  const application = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference: `APP-${randomUUID()}`, applicationVersion: 1, assetName: "Governed asset", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "A governed asset application with immutable dossier evidence.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: evidence.evidenceDocumentId });
  const approved = await decideAssetApplicationRequest({ requestId: application.requestId, decidedByIdentityId: checkerId, approve: true });
  if (!approved.approvedApplicationVersionId) throw new Error("Expected approved asset application version");
  return approved.approvedApplicationVersionId;
}

describe("PostgreSQL offering governance", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.distribution_privacy_treatment_executions, fractal.distribution_privacy_treatment_requests, fractal.distribution_lifecycle_policy_bindings");
    await postgresQuery("TRUNCATE fractal.investor_distribution_tax_statements, fractal.distribution_tax_remittance_reversal_requests, fractal.distribution_tax_remittance_requests, fractal.distribution_tax_remittance_policies, fractal.distribution_payout_exception_executions, fractal.distribution_payout_exception_hold_requests, fractal.distribution_payout_exception_evidence, fractal.distribution_payout_exception_cases, fractal.distribution_payout_exception_policies, fractal.distribution_payout_provider_events, fractal.distribution_payout_instructions, fractal.distribution_funding_requests, fractal.distribution_payout_recipient_recovery_cases, fractal.investor_distribution_payout_profiles, fractal.distribution_entitlements, fractal.distribution_declaration_requests, fractal.ownership_snapshot_holdings, fractal.ownership_snapshot_requests, fractal.offering_notice_recipient_events, fractal.offering_notice_recipients, fractal.offering_notices, fractal.offering_notice_requests, fractal.professional_replacement_payout_requests, fractal.professional_invoice_credit_notes, fractal.professional_finance_exception_evidence, fractal.professional_finance_exception_cases, fractal.professional_finance_approval_policies, fractal.professional_payout_recipient_recovery_cases, fractal.professional_payout_instructions, fractal.professional_invoices, fractal.professional_invoice_tax_treatments, fractal.professional_payout_profile_versions, fractal.professional_deliverable_version_documents, fractal.professional_deliverable_versions, fractal.professional_deliverable_evidence_documents, fractal.professional_work_order_events, fractal.professional_work_order_conflicts, fractal.professional_work_order_assignments, fractal.professional_work_orders, fractal.professional_firm_memberships, fractal.professional_firm_profiles, fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.offering_chain_operation_dispatch_claims, fractal.offering_chain_operations, fractal.offering_chain_deployment_requests, fractal.offering_issuance_term_requests, fractal.governance_evidence_documents, fractal.offering_publication_requests, fractal.offering_publication_evidence_documents, fractal.asset_application_review_items, fractal.asset_application_version_supersessions, fractal.approved_asset_application_versions, fractal.asset_application_requests, fractal.asset_application_evidence_documents, fractal.investor_compliance_profile_reviews, fractal.investor_compliance_review_requests, fractal.payment_provider_instructions, fractal.investment_reservations, fractal.agreement_acceptances, fractal.investment_eligibility_snapshots, fractal.investor_compliance_profiles, fractal.offering_publication_versions, fractal.offering_products, fractal.payment_reconciliation_cases, fractal.payment_receipts, fractal.payment_intents, fractal.journal_postings, fractal.journal_entries, fractal.ledger_accounts, fractal.security_notifications, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events");
    organizationId = randomUUID();
    makerId = randomUUID();
    checkerId = randomUUID();
    investorId = randomUUID();
    professionalId = randomUUID();
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, $2, 'active')", [organizationId, `Governance org ${organizationId}`]);
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Maker', 'active'), ($3, $4, 'Checker', 'active'), ($5, $6, 'Investor', 'active')",
      [makerId, `maker-${makerId}@example.test`, checkerId, `checker-${checkerId}@example.test`, investorId, `investor-${investorId}@example.test`],
    );
    await postgresQuery("INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Professional', 'active')", [professionalId, `professional-${professionalId}@example.test`]);
    await postgresQuery(
      `UPDATE fractal.organizations
          SET verification_status = 'verified', verification_version = 1,
              verified_at = now(), verified_by_identity_id = $2,
              verification_updated_at = now(), verification_expires_at = now() + interval '1 year'
        WHERE id = $1`,
      [organizationId, checkerId],
    );
  });

  afterAll(async () => { await disconnectPostgres(); });

  it("requires maker-checker approval for a versioned professional-invoice tax treatment", async () => {
    const draft = await createProfessionalInvoiceTaxTreatment({ issuerOrganizationId: organizationId, preparedByIdentityId: makerId, jurisdictionCode: "NG", serviceClass: "professional_services", currency: "NGN", indirectTaxRateBps: 0, withholdingTaxRateBps: 0, effectiveFrom: new Date(Date.now() - 60_000), legalSourceReference: "Approved test finance policy" });
    await expect(approveProfessionalInvoiceTaxTreatment({ taxTreatmentId: draft.taxTreatmentId, approvedByIdentityId: makerId })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    await expect(approveProfessionalInvoiceTaxTreatment({ taxTreatmentId: draft.taxTreatmentId, approvedByIdentityId: checkerId })).resolves.toMatchObject({ taxTreatmentId: draft.taxTreatmentId, status: "active" });
    expect(await listProfessionalInvoiceTaxTreatments(organizationId)).toContainEqual(expect.objectContaining({ id: draft.taxTreatmentId, version: 1, status: "active", jurisdictionCode: "NG", currency: "NGN" }));
    await expect(postgresQuery("UPDATE fractal.professional_invoice_tax_treatments SET withholding_tax_rate_bps = 500 WHERE id = $1", [draft.taxTreatmentId])).rejects.toThrow(/immutable/);
  });

  it("fails closed until a different reviewer activates a finance approval limit", async () => {
    const draft = await createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: organizationId, preparedByIdentityId: makerId, resolutionType: "credit_note", currency: "NGN", maximumAmountMinor: 250_000, effectiveFrom: new Date(Date.now() - 60_000), policyReference: "Approved test credit-note authority" });
    await expect(approveProfessionalFinanceApprovalPolicy({ financeApprovalPolicyId: draft.financeApprovalPolicyId, approvedByIdentityId: makerId })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    await expect(approveProfessionalFinanceApprovalPolicy({ financeApprovalPolicyId: draft.financeApprovalPolicyId, approvedByIdentityId: checkerId })).resolves.toMatchObject({ financeApprovalPolicyId: draft.financeApprovalPolicyId, status: "active" });
    expect(await listProfessionalFinanceApprovalPolicies(organizationId)).toContainEqual(expect.objectContaining({ id: draft.financeApprovalPolicyId, version: 1, resolutionType: "credit_note", currency: "NGN", maximumAmountMinor: "250000", status: "active" }));
    await expect(postgresQuery("UPDATE fractal.professional_finance_approval_policies SET maximum_amount_minor = 500000 WHERE id = $1", [draft.financeApprovalPolicyId])).rejects.toThrow(/immutable/);
  });

  it("publishes only after a different checker approves immutable submitted offering facts", async () => {
    const publicationEvidence = await recordPublicationEvidence();
    const approvedAssetApplicationVersionId = await createApprovedOrigin();
    await expect(postgresQuery(
      `INSERT INTO fractal.offering_publication_requests
       (id, organization_id, public_reference, currency, capacity_minor, opens_at, closes_at, terms, eligibility_policy,
        agreement_document_hash, disclosure_bundle_hash, agreement_evidence_document_id, disclosure_evidence_document_id,
        status, submitted_by_identity_id, submitted_at)
       VALUES ($1,$2,$3,'NGN',500000,now(),now() + interval '1 day',$4,$5,$6,$7,$8,$9,'submitted',$10,now())`,
      [randomUUID(), organizationId, `tampered-${randomUUID()}`, { name: "Tampered evidence" }, { allowedInvestorClasses: ["retail"] }, "0".repeat(64), disclosureHash, publicationEvidence.agreementEvidenceDocumentId, publicationEvidence.disclosureEvidenceDocumentId, makerId],
    )).rejects.toThrow(/agreement evidence does not match/);
    await expect(postgresQuery("UPDATE fractal.offering_publication_evidence_documents SET filename = 'tampered.pdf' WHERE id = $1", [publicationEvidence.agreementEvidenceDocumentId]))
      .rejects.toThrow(/immutable/);
    await expect(postgresQuery(
      `INSERT INTO fractal.offering_publication_requests
       (id, organization_id, public_reference, currency, capacity_minor, opens_at, closes_at, terms, eligibility_policy,
        agreement_document_hash, disclosure_bundle_hash, agreement_evidence_document_id, disclosure_evidence_document_id,
        approved_asset_application_version_id, status, submitted_by_identity_id, submitted_at)
       VALUES ($1,$2,$3,'NGN',500000,now(),now() + interval '1 day',$4,$5,$6,$7,$8,$9,$10,'submitted',$11,now())`,
      [randomUUID(), organizationId, `incomplete-${randomUUID()}`, { name: "Incomplete public profile", minimumTicketMinor: 10_000 },
        { allowedInvestorClasses: ["retail"] }, agreementHash, disclosureHash, publicationEvidence.agreementEvidenceDocumentId,
        publicationEvidence.disclosureEvidenceDocumentId, approvedAssetApplicationVersionId, makerId],
    )).rejects.toThrow(/public offering slug is invalid|public offering profile is incomplete/);
    const governedTerms = offeringTerms("Governed offering");
    const request = await submitOfferingPublicationRequest({
      organizationId, submittedByIdentityId: makerId, publicReference: `governed-${randomUUID()}`, currency: "ngn", capacityMinor: 500_000,
      opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000),
      terms: governedTerms,
      eligibilityPolicy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"] },
      ...publicationEvidence,
      approvedAssetApplicationVersionId,
    });
    const duplicateSlugEvidence = await recordPublicationEvidence();
    await expect(submitOfferingPublicationRequest({
      organizationId, submittedByIdentityId: makerId, publicReference: `duplicate-slug-${randomUUID()}`, currency: "NGN", capacityMinor: 500_000,
      opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000),
      terms: { ...governedTerms, name: "Different offering with duplicate slug" }, eligibilityPolicy: { allowedInvestorClasses: ["retail"] },
      ...duplicateSlugEvidence, approvedAssetApplicationVersionId,
    })).rejects.toThrow(/publicSlug is already in use/);
    await expect(decideOfferingPublicationRequest({ requestId: request.requestId, decidedByIdentityId: makerId, approve: true }))
      .rejects.toBeInstanceOf(OfferingGovernanceError);
    expect((await listOfferingPublicationRequests({ organizationId, status: "submitted" })).map((item) => item.id)).toContain(request.requestId);
    const approval = await decideOfferingPublicationRequest({ requestId: request.requestId, decidedByIdentityId: checkerId, approve: true });
    expect(approval.status).toBe("approved");
    expect(approval.offeringId).toBeTruthy();
    expect((await postgresQuery<{ status: string; published_offering_id: string }>("SELECT status, published_offering_id FROM fractal.offering_publication_requests WHERE id = $1", [request.requestId])).rows[0])
      .toEqual({ status: "approved", published_offering_id: approval.offeringId });
    expect((await postgresQuery("SELECT * FROM fractal.offering_products WHERE id = $1", [approval.offeringId])).rowCount).toBe(1);
    const publicReference = (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [approval.offeringId])).rows[0]!.public_reference;
    expect((await getOpenInvestmentOffering(publicReference))?.agreementDocumentHash).toBe(agreementHash);
    expect((await listOpenInvestmentOfferings()).map((offering) => offering.reference)).toContain(publicReference);
    const publicOffering = await getPublicInvestmentOffering((await listPublicInvestmentOfferings())[0]!.slug);
    expect(publicOffering).toMatchObject({
      reference: publicReference,
      name: "Governed offering",
      issuerName: `Governance org ${organizationId}`,
      countryCode: "NG",
      city: "Lagos",
      publicationVersion: 1,
    });
    expect(publicOffering).not.toHaveProperty("eligibilityPolicy");
    expect(publicOffering).not.toHaveProperty("agreementDocumentHash");
    await postgresQuery("UPDATE fractal.organizations SET verified_at = now() - interval '2 days', verification_expires_at = now() - interval '1 day' WHERE id = $1", [organizationId]);
    expect(await listPublicInvestmentOfferings()).toEqual([]);
    expect(await listOrganizationIssuableOfferings(organizationId)).toContainEqual(expect.objectContaining({ id: approval.offeringId, publicReference, currentVersion: 1 }));
    await expect(postgresQuery("UPDATE fractal.offering_publication_requests SET status = 'rejected' WHERE id = $1", [request.requestId]))
      .rejects.toThrow(/may only be decided once/);
  });

  it("projects compliance only after a different checker approves and retains a historical snapshot", async () => {
    const request = await submitInvestorComplianceReview({
      organizationId, submittedByIdentityId: makerId, identityId: investorId, kycStatus: "approved", investorClass: "retail",
      accreditationStatus: "not_required", jurisdictionCode: "ng", reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), evidence: { provider: "test-review" },
    });
    await expect(decideInvestorComplianceReview({ requestId: request.requestId, decidedByIdentityId: makerId, approve: true }))
      .rejects.toBeInstanceOf(OfferingGovernanceError);
    expect((await listInvestorComplianceReviewRequests({ organizationId, status: "submitted" })).map((item) => item.id)).toContain(request.requestId);
    await expect(decideInvestorComplianceReview({ requestId: request.requestId, decidedByIdentityId: checkerId, approve: false }))
      .rejects.toThrow(/rejection reason/);
    const approval = await decideInvestorComplianceReview({ requestId: request.requestId, decidedByIdentityId: checkerId, approve: true });
    expect(approval.status).toBe("approved");
    expect((await postgresQuery<{ kyc_status: string; jurisdiction_code: string }>("SELECT kyc_status, jurisdiction_code FROM fractal.investor_compliance_profiles WHERE identity_id = $1", [investorId])).rows[0])
      .toEqual({ kyc_status: "approved", jurisdiction_code: "NG" });
    expect((await postgresQuery("SELECT * FROM fractal.investor_compliance_profile_reviews WHERE review_request_id = $1", [request.requestId])).rowCount).toBe(1);
  });

  it("binds cited provider evidence to the reviewed investor instead of trusting caller-supplied compliance JSON", async () => {
    const greenEvidence = await recordSumsubIdentityVerificationEvidence({
      externalEventId: `sumsub-green-${randomUUID()}`,
      externalUserId: investorId,
      applicantId: `applicant-${randomUUID()}`,
      eventType: "applicantReviewed",
      reviewStatus: "completed",
      reviewAnswer: "GREEN",
      rawPayload: JSON.stringify({ answer: "GREEN", identityId: investorId }),
    });
    const request = await submitInvestorComplianceReview({
      organizationId, submittedByIdentityId: makerId, identityId: investorId, kycStatus: "approved", investorClass: "retail",
      accreditationStatus: "not_required", jurisdictionCode: "ng", reviewedAt: new Date(),
      evidence: {
        providerIdentityVerificationEventId: greenEvidence.id,
        providerIdentityVerification: { reviewAnswer: "RED", payloadHash: "forged" },
      },
    });
    const stored = await postgresQuery<{ evidence: Record<string, unknown> }>(
      "SELECT evidence FROM fractal.investor_compliance_review_requests WHERE id = $1",
      [request.requestId],
    );
    expect(stored.rows[0]?.evidence).toMatchObject({
      providerIdentityVerificationEventId: greenEvidence.id,
      providerIdentityVerification: {
        eventId: greenEvidence.id,
        provider: "sumsub",
        reviewAnswer: "GREEN",
      },
    });
    await expect(decideInvestorComplianceReview({ requestId: request.requestId, decidedByIdentityId: checkerId, approve: true }))
      .resolves.toMatchObject({ status: "approved" });

    const otherIdentityEvidence = await recordSumsubIdentityVerificationEvidence({
      externalEventId: `sumsub-other-${randomUUID()}`,
      externalUserId: checkerId,
      applicantId: `applicant-${randomUUID()}`,
      eventType: "applicantReviewed",
      reviewAnswer: "GREEN",
      rawPayload: JSON.stringify({ answer: "GREEN", identityId: checkerId }),
    });
    await expect(submitInvestorComplianceReview({
      organizationId, submittedByIdentityId: makerId, identityId: investorId, kycStatus: "approved", investorClass: "retail",
      accreditationStatus: "not_required", jurisdictionCode: "NG", reviewedAt: new Date(),
      evidence: { providerIdentityVerificationEventId: otherIdentityEvidence.id },
    })).rejects.toBeInstanceOf(OfferingGovernanceError);

    const redEvidence = await recordSumsubIdentityVerificationEvidence({
      externalEventId: `sumsub-red-${randomUUID()}`,
      externalUserId: investorId,
      applicantId: `applicant-${randomUUID()}`,
      eventType: "applicantReviewed",
      reviewAnswer: "RED",
      rawPayload: JSON.stringify({ answer: "RED", identityId: investorId }),
    });
    await expect(submitInvestorComplianceReview({
      organizationId, submittedByIdentityId: makerId, identityId: investorId, kycStatus: "approved", investorClass: "retail",
      accreditationStatus: "not_required", jurisdictionCode: "NG", reviewedAt: new Date(),
      evidence: { providerIdentityVerificationEventId: redEvidence.id },
    })).rejects.toThrow("without a GREEN review answer");
  });

  it("holds approval until required diligence evidence is independently verified", async () => {
    const dossier = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "review-dossier.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-review-dossier.pdf`, contentSha256: "1".repeat(64), bytes: 128 });
    const application = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference: `APP-${randomUUID()}`, applicationVersion: 1, assetName: "Review-bound asset", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "An asset application that must resolve required diligence evidence before approval.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: dossier.evidenceDocumentId });
    const item = await createAssetApplicationReviewItem({ organizationId, applicationRequestId: application.requestId, openedByIdentityId: checkerId, category: "title", title: "Confirm title chain", requestMessage: "Upload the signed title-chain evidence.", required: true });
    await expect(decideAssetApplicationRequest({ requestId: application.requestId, decidedByIdentityId: checkerId, approve: true })).rejects.toThrow(/Required diligence items/);
    const responseEvidence = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "title-chain.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-title-chain.pdf`, contentSha256: "2".repeat(64), bytes: 128 });
    await respondToAssetApplicationReviewItem({ reviewItemId: item.reviewItemId, respondedByIdentityId: makerId, responseMessage: "Signed title chain is attached.", responseEvidenceDocumentId: responseEvidence.evidenceDocumentId });
    await expect(decideAssetApplicationReviewItem({ reviewItemId: item.reviewItemId, reviewedByIdentityId: makerId, verify: true })).rejects.toThrow(/different person/);
    await decideAssetApplicationReviewItem({ reviewItemId: item.reviewItemId, reviewedByIdentityId: checkerId, verify: true });
    await expect(postgresQuery("UPDATE fractal.asset_application_review_items SET title = 'Tampered' WHERE id = $1", [item.reviewItemId])).rejects.toThrow(/immutable/);
    expect(await decideAssetApplicationRequest({ requestId: application.requestId, decidedByIdentityId: checkerId, approve: true })).toMatchObject({ requestId: application.requestId, status: "approved" });
  });

  it("supersedes an approved source only through a sequential, reasoned amendment and blocks stale publication", async () => {
    const applicationReference = `APP-${randomUUID()}`;
    const firstDossier = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "origin-v1.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-origin-v1.pdf`, contentSha256: "3".repeat(64), bytes: 128 });
    const first = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference, applicationVersion: 1, assetName: "Amendable asset", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "The original governed asset application used to prove version supersession.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: firstDossier.evidenceDocumentId });
    const firstApproved = await decideAssetApplicationRequest({ requestId: first.requestId, decidedByIdentityId: checkerId, approve: true });
    const originId = firstApproved.approvedApplicationVersionId!;
    const publicationEvidence = await recordPublicationEvidence();
    const stalePublication = await submitOfferingPublicationRequest({ organizationId, submittedByIdentityId: makerId, publicReference: `stale-${randomUUID()}`, currency: "NGN", capacityMinor: 500_000, opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000), terms: offeringTerms("Stale-origin offering"), eligibilityPolicy: { allowedInvestorClasses: ["retail"] }, ...publicationEvidence, approvedAssetApplicationVersionId: originId });
    const secondDossier = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "origin-v2.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-origin-v2.pdf`, contentSha256: "4".repeat(64), bytes: 128 });
    await expect(submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference, applicationVersion: 3, assetName: "Skipped version", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "This application incorrectly skips a version and must never be accepted.", materialChangeSummary: "This must fail because application version two has not been submitted.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: secondDossier.evidenceDocumentId })).rejects.toThrow(/next sequential version/);
    const second = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference, applicationVersion: 2, assetName: "Amendable asset", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "The amended governed asset application with a new immutable dossier.", materialChangeSummary: "Updated title-chain evidence changes the governed source application and requires a new approval.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: secondDossier.evidenceDocumentId });
    const secondApproved = await decideAssetApplicationRequest({ requestId: second.requestId, decidedByIdentityId: checkerId, approve: true });
    expect(secondApproved.approvedApplicationVersionId).toBeTruthy();
    expect((await postgresQuery<{ superseded_application_version_id: string; replacement_application_version_id: string; reason: string }>("SELECT superseded_application_version_id, replacement_application_version_id, reason FROM fractal.asset_application_version_supersessions")).rows[0])
      .toEqual({ superseded_application_version_id: originId, replacement_application_version_id: secondApproved.approvedApplicationVersionId, reason: "Updated title-chain evidence changes the governed source application and requires a new approval." });
    await expect(decideOfferingPublicationRequest({ requestId: stalePublication.requestId, decidedByIdentityId: checkerId, approve: true })).rejects.toThrow(/superseded/);
    const currentPublicationEvidence = await recordPublicationEvidence();
    await expect(submitOfferingPublicationRequest({ organizationId, submittedByIdentityId: makerId, publicReference: `obsolete-${randomUUID()}`, currency: "NGN", capacityMinor: 500_000, opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000), terms: offeringTerms("Obsolete-origin offering"), eligibilityPolicy: { allowedInvestorClasses: ["retail"] }, ...currentPublicationEvidence, approvedAssetApplicationVersionId: originId })).rejects.toThrow(/superseded/);
    await expect(submitOfferingPublicationRequest({ organizationId, submittedByIdentityId: makerId, publicReference: `current-${randomUUID()}`, currency: "NGN", capacityMinor: 500_000, opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000), terms: offeringTerms("Current-origin offering"), eligibilityPolicy: { allowedInvestorClasses: ["retail"] }, ...currentPublicationEvidence, approvedAssetApplicationVersionId: secondApproved.approvedApplicationVersionId! })).resolves.toMatchObject({ requestId: expect.any(String) });
  });

  it("binds professional work to a submitted application, an assigned verified firm member, and a no-conflict acceptance", async () => {
    const firmOrganizationId = randomUUID(); const firmMembershipId = randomUUID();
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, 'Verified diligence firm', 'active')", [firmOrganizationId]);
    await postgresQuery("INSERT INTO fractal.professional_firm_profiles (organization_id, status, credential_status) VALUES ($1, 'active', 'verified')", [firmOrganizationId]);
    await postgresQuery("INSERT INTO fractal.professional_firm_memberships (id, firm_organization_id, identity_id, role, status) VALUES ($1,$2,$3,'engagement_lead','active')", [firmMembershipId, firmOrganizationId, professionalId]);
    const dossier = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "professional-dossier.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-professional-dossier.pdf`, contentSha256: "5".repeat(64), bytes: 128 });
    const application = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference: `APP-${randomUUID()}`, applicationVersion: 1, assetName: "Professionally reviewed asset", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "A submitted asset application used to prove professional work-order governance.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: dossier.evidenceDocumentId });
    const workOrder = await createProfessionalWorkOrder({ issuerOrganizationId: organizationId, invitedByIdentityId: checkerId, professionalFirmOrganizationId: firmOrganizationId, assetApplicationRequestId: application.requestId, assignedFirmMembershipId: firmMembershipId, reference: `WO-${randomUUID()}`, title: "Independent valuation", scope: "Prepare an independent valuation with evidence-backed assumptions and a signed conclusion.", exclusions: "No legal title opinion or tax advice is included in this mandate.", confidentiality: "restricted", responseDueAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), deliveryDueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000), feeMinor: 250_000, currency: "NGN" });
    expect((await listAssignedProfessionalWorkOrders(professionalId)).map((item) => item.id)).toContain(workOrder.workOrderId);
    await expect(respondToProfessionalWorkOrder({ workOrderId: workOrder.workOrderId, actorIdentityId: makerId, response: "accept" })).rejects.toBeInstanceOf(ProfessionalWorkOrderError);
    expect(await respondToProfessionalWorkOrder({ workOrderId: workOrder.workOrderId, actorIdentityId: professionalId, response: "accept" })).toEqual({ workOrderId: workOrder.workOrderId, status: "accepted" });
    expect((await postgresQuery<{ declaration: string }>("SELECT declaration FROM fractal.professional_work_order_conflicts WHERE work_order_id = $1", [workOrder.workOrderId])).rows[0]).toEqual({ declaration: "no_conflict" });
    await expect(postgresQuery("UPDATE fractal.professional_work_orders SET title = 'Tampered' WHERE id = $1", [workOrder.workOrderId])).rejects.toThrow(/immutable/);
  });

  it("keeps professional deliverable evidence and versions immutable, independently reviewed, and auditable", async () => {
    const firmOrganizationId = randomUUID(); const firmMembershipId = randomUUID();
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, 'Audited delivery firm', 'active')", [firmOrganizationId]);
    await postgresQuery("INSERT INTO fractal.professional_firm_profiles (organization_id, status, credential_status) VALUES ($1, 'active', 'verified')", [firmOrganizationId]);
    await postgresQuery("INSERT INTO fractal.professional_firm_memberships (id, firm_organization_id, identity_id, role, status) VALUES ($1,$2,$3,'engagement_lead','active')", [firmMembershipId, firmOrganizationId, professionalId]);
    const dossier = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "delivery-dossier.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-delivery-dossier.pdf`, contentSha256: "6".repeat(64), bytes: 128 });
    const application = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference: `APP-${randomUUID()}`, applicationVersion: 1, assetName: "Deliverable-governed asset", assetType: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "A submitted asset application used to prove immutable, independently reviewed professional deliverables.", requestedCapacityMinor: 500_000, currency: "NGN", dossierEvidenceDocumentId: dossier.evidenceDocumentId });
    const workOrder = await createProfessionalWorkOrder({ issuerOrganizationId: organizationId, invitedByIdentityId: checkerId, professionalFirmOrganizationId: firmOrganizationId, assetApplicationRequestId: application.requestId, assignedFirmMembershipId: firmMembershipId, reference: `WO-${randomUUID()}`, title: "Independent valuation", scope: "Prepare an independently reviewed valuation and a signed evidence-backed final conclusion.", exclusions: "No legal title opinion or tax advice is included in this mandate.", confidentiality: "restricted", responseDueAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), deliveryDueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000), feeMinor: 250_000, currency: "NGN" });
    await expect(assertProfessionalDeliverableEvidenceUploadAllowed({ workOrderId: workOrder.workOrderId, identityId: makerId })).rejects.toThrow(/not assigned/);
    await expect(assertProfessionalDeliverableEvidenceUploadAllowed({ workOrderId: workOrder.workOrderId, identityId: professionalId })).rejects.toThrow(/accepted active/);
    await expect(recordProfessionalDeliverableEvidence({ workOrderId: workOrder.workOrderId, uploadedByIdentityId: professionalId, filename: "valuation.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-premature.pdf`, contentSha256: "7".repeat(64), bytes: 128 })).rejects.toThrow(/accepted active/);
    await respondToProfessionalWorkOrder({ workOrderId: workOrder.workOrderId, actorIdentityId: professionalId, response: "accept" });
    await expect(assertProfessionalDeliverableEvidenceUploadAllowed({ workOrderId: workOrder.workOrderId, identityId: professionalId })).resolves.toBeUndefined();
    const evidence = await recordProfessionalDeliverableEvidence({ workOrderId: workOrder.workOrderId, uploadedByIdentityId: professionalId, filename: "valuation.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-valuation.pdf`, contentSha256: "8".repeat(64), bytes: 128 });
    const submitted = await submitProfessionalDeliverable({ workOrderId: workOrder.workOrderId, submittedByIdentityId: professionalId, title: "Independent valuation", submissionSummary: "The signed report sets out evidence-backed assumptions, a valuation range, and the resulting conclusion.", evidenceDocumentIds: [evidence.evidenceDocumentId] });
    expect(submitted.version).toBe(1);
    await expect(listAssignedProfessionalWorkOrderDeliverables(workOrder.workOrderId, makerId)).rejects.toBeInstanceOf(ProfessionalWorkOrderError);
    expect(await listAssignedProfessionalWorkOrderDeliverables(workOrder.workOrderId, professionalId)).toContainEqual(expect.objectContaining({ id: submitted.deliverableVersionId, evidenceDocuments: [expect.objectContaining({ id: evidence.evidenceDocumentId, filename: "valuation.pdf" })] }));
    expect(await listIssuerProfessionalWorkOrderDeliverables({ issuerOrganizationId: organizationId, workOrderId: workOrder.workOrderId })).toContainEqual(expect.objectContaining({ id: submitted.deliverableVersionId }));
    await expect(decideProfessionalDeliverable({ deliverableVersionId: submitted.deliverableVersionId, reviewedByIdentityId: professionalId, decision: "accepted", notes: "The reviewer is intentionally different from the submitting professional." })).rejects.toBeInstanceOf(ProfessionalWorkOrderError);
    await expect(postgresQuery("UPDATE fractal.professional_deliverable_evidence_documents SET filename = 'tampered.pdf' WHERE id = $1", [evidence.evidenceDocumentId])).rejects.toThrow(/immutable/);
    expect(await decideProfessionalDeliverable({ deliverableVersionId: submitted.deliverableVersionId, reviewedByIdentityId: checkerId, decision: "revision_requested", notes: "Please add the sensitivity analysis supporting the central valuation conclusion." })).toMatchObject({ deliverableVersionId: submitted.deliverableVersionId, status: "revision_requested" });
    await expect(postgresQuery("UPDATE fractal.professional_deliverable_versions SET status = 'accepted' WHERE id = $1", [submitted.deliverableVersionId])).rejects.toThrow(/only be reviewed once/);
    const revisionEvidence = await recordProfessionalDeliverableEvidence({ workOrderId: workOrder.workOrderId, uploadedByIdentityId: professionalId, filename: "valuation-v2.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}-valuation-v2.pdf`, contentSha256: "9".repeat(64), bytes: 128 });
    const resubmitted = await submitProfessionalDeliverable({ workOrderId: workOrder.workOrderId, submittedByIdentityId: professionalId, title: "Independent valuation — revised", submissionSummary: "The revised signed report adds the requested sensitivity analysis and updates the final valuation conclusion.", evidenceDocumentIds: [revisionEvidence.evidenceDocumentId] });
    expect(resubmitted.version).toBe(2);
    expect(await decideProfessionalDeliverable({ deliverableVersionId: resubmitted.deliverableVersionId, reviewedByIdentityId: checkerId, decision: "accepted", notes: "The sensitivity analysis is complete and the final signed report is accepted." })).toMatchObject({ status: "accepted" });
    await expect(submitProfessionalInvoice({ workOrderId: workOrder.workOrderId, deliverableVersionId: resubmitted.deliverableVersionId, submittedByIdentityId: professionalId, reference: `INV-${randomUUID()}`, dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000) })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    const payoutProfileId = randomUUID(); const recipientReference = `recipient-${randomUUID()}`;
    await postgresQuery("INSERT INTO fractal.professional_payout_profile_versions (id, firm_organization_id, version, rail, currency, account_holder_name, account_last4, provider_recipient_reference, status, verified_by_identity_id) VALUES ($1,$2,1,'bank_transfer','NGN','Audited delivery firm','1234',$3,'verified',$4)", [payoutProfileId, firmOrganizationId, recipientReference, checkerId]);
    const taxTreatmentId = randomUUID();
    await postgresQuery("INSERT INTO fractal.professional_invoice_tax_treatments (id, issuer_organization_id, version, jurisdiction_code, service_class, currency, indirect_tax_rate_bps, withholding_tax_rate_bps, effective_from, legal_source_reference, status, prepared_by_identity_id, approved_by_identity_id, approved_at) VALUES ($1,$2,1,'NG','professional_services','NGN',0,0,now() - interval '1 minute','test finance policy','active',$3,$4,now())", [taxTreatmentId, organizationId, makerId, checkerId]);
    const creditNotePolicy = await createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: organizationId, preparedByIdentityId: makerId, resolutionType: "credit_note", currency: "NGN", maximumAmountMinor: 250_000, effectiveFrom: new Date(Date.now() - 60_000), policyReference: "Test credit-note authority" });
    await approveProfessionalFinanceApprovalPolicy({ financeApprovalPolicyId: creditNotePolicy.financeApprovalPolicyId, approvedByIdentityId: checkerId });
    const replacementPolicy = await createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: organizationId, preparedByIdentityId: makerId, resolutionType: "replacement_payout", currency: "NGN", maximumAmountMinor: 250_000, effectiveFrom: new Date(Date.now() - 60_000), policyReference: "Test replacement authority" });
    await approveProfessionalFinanceApprovalPolicy({ financeApprovalPolicyId: replacementPolicy.financeApprovalPolicyId, approvedByIdentityId: checkerId });
    const invoice = await submitProfessionalInvoice({ workOrderId: workOrder.workOrderId, deliverableVersionId: resubmitted.deliverableVersionId, submittedByIdentityId: professionalId, reference: `INV-${randomUUID()}`, dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000) });
    await expect(decideProfessionalInvoice({ invoiceId: invoice.invoiceId, decidedByIdentityId: professionalId, approve: true })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    const approvedInvoice = await decideProfessionalInvoice({ invoiceId: invoice.invoiceId, decidedByIdentityId: checkerId, approve: true });
    expect(approvedInvoice).toMatchObject({ invoiceId: invoice.invoiceId, status: "approved", accrualJournalId: expect.any(String) });
    expect((await postgresQuery<{ direction: string; amount_minor: string }>("SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number", [approvedInvoice.accrualJournalId])).rows).toEqual([{ direction: "debit", amount_minor: "250000" }, { direction: "credit", amount_minor: "250000" }]);
    await expect(authorizeProfessionalPayout({ invoiceId: invoice.invoiceId, authorizedByIdentityId: checkerId })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    const payout = await authorizeProfessionalPayout({ invoiceId: invoice.invoiceId, authorizedByIdentityId: makerId });
    expect((await postgresQuery<{ status: string; amount_minor: string; provider_recipient_reference: string }>("SELECT status, amount_minor, provider_recipient_reference FROM fractal.professional_payout_instructions WHERE id = $1", [payout.payoutInstructionId])).rows[0]).toEqual({ status: "authorized", amount_minor: "250000", provider_recipient_reference: recipientReference });
    expect((await postgresQuery<{ gross_minor: string; payout_profile_version_id: string; status: string }>("SELECT gross_minor, payout_profile_version_id, status FROM fractal.professional_invoices WHERE id = $1", [invoice.invoiceId])).rows[0]).toEqual({ gross_minor: "250000", payout_profile_version_id: payoutProfileId, status: "payment_instructed" });
    expect(await dispatchOneProfessionalPayout("test-worker", async () => ({ transfer_code: `TRF-${randomUUID()}`, status: "success" }))).toBe(true);
    expect((await postgresQuery<{ status: string }>("SELECT status FROM fractal.professional_payout_instructions WHERE id = $1", [payout.payoutInstructionId])).rows[0]).toEqual({ status: "submitted" });
    const transferCode = (await postgresQuery<{ provider_transfer_code: string }>("SELECT provider_transfer_code FROM fractal.professional_payout_instructions WHERE id = $1", [payout.payoutInstructionId])).rows[0]!.provider_transfer_code;
    await expect(recordProfessionalPayoutProviderOutcome({ outcome: "success", reference: payout.reference, transferCode, amountMinor: 249_999, currency: "NGN", source: "webhook" })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    const settled = await recordProfessionalPayoutProviderOutcome({ outcome: "success", reference: payout.reference, transferCode, amountMinor: 250_000, currency: "NGN", source: "webhook" });
    expect(settled).toMatchObject({ handled: true, payoutInstructionId: payout.payoutInstructionId, status: "confirmed" });
    const confirmedPayout = (await postgresQuery<{ status: string; settlement_journal_id: string }>("SELECT status, settlement_journal_id FROM fractal.professional_payout_instructions WHERE id = $1", [payout.payoutInstructionId])).rows[0]!;
    expect(confirmedPayout.status).toBe("confirmed");
    expect((await postgresQuery<{ direction: string; amount_minor: string }>("SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number", [confirmedPayout.settlement_journal_id])).rows).toEqual([{ direction: "debit", amount_minor: "250000" }, { direction: "credit", amount_minor: "250000" }]);
    expect((await postgresQuery<{ status: string }>("SELECT status FROM fractal.professional_invoices WHERE id = $1", [invoice.invoiceId])).rows[0]).toEqual({ status: "paid" });
    expect(await listProfessionalPayouts(professionalId)).toContainEqual(expect.objectContaining({ invoiceId: invoice.invoiceId, payoutStatus: "confirmed", confirmedAt: expect.any(String) }));
    const reversed = await recordProfessionalPayoutProviderOutcome({ outcome: "reversed", reference: payout.reference, transferCode, amountMinor: 250_000, currency: "NGN", reason: "Returned by beneficiary bank", source: "webhook" });
    expect(reversed).toMatchObject({ handled: true, payoutInstructionId: payout.payoutInstructionId, status: "reversed" });
    const reversedPayout = (await postgresQuery<{ reversal_journal_id: string }>("SELECT reversal_journal_id FROM fractal.professional_payout_instructions WHERE id = $1", [payout.payoutInstructionId])).rows[0]!;
    expect((await postgresQuery<{ direction: string; amount_minor: string }>("SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number", [reversedPayout.reversal_journal_id])).rows).toEqual([{ direction: "credit", amount_minor: "250000" }, { direction: "debit", amount_minor: "250000" }]);
    expect((await postgresQuery<{ status: string }>("SELECT status FROM fractal.professional_invoices WHERE id = $1", [invoice.invoiceId])).rows[0]).toEqual({ status: "payment_reversed" });
    expect(await listProfessionalPayoutExceptions()).toContainEqual(expect.objectContaining({ id: payout.payoutInstructionId, status: "reversed", invoiceId: invoice.invoiceId, failureReason: "Returned by beneficiary bank" }));
    const financeException = await openProfessionalFinanceException({ payoutInstructionId: payout.payoutInstructionId, openedByIdentityId: makerId });
    await recordProfessionalFinanceExceptionEvidence({ financeExceptionCaseId: financeException.financeExceptionCaseId, uploadedByIdentityId: makerId, evidenceType: "provider_webhook", storageKey: `local://test/${randomUUID()}-reversal.json`, filename: "reversal.json", mimeType: "application/json", contentSha256: "f".repeat(64) });
    await prepareProfessionalFinanceExceptionResolution({ financeExceptionCaseId: financeException.financeExceptionCaseId, preparedByIdentityId: makerId, resolutionType: "credit_note", resolutionReason: "The provider reversed the payout, so accounting must issue a governed credit note rather than retry the transfer.", resolutionPayload: { creditNote: { reference: `CN-${randomUUID()}`, grossMinor: 250_000, taxMinor: 0, withholdingTaxMinor: 0, netCreditMinor: 250_000 } } });
    await expect(decideProfessionalFinanceExceptionResolution({ financeExceptionCaseId: financeException.financeExceptionCaseId, reviewedByIdentityId: makerId, approve: true })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    await expect(decideProfessionalFinanceExceptionResolution({ financeExceptionCaseId: financeException.financeExceptionCaseId, reviewedByIdentityId: checkerId, approve: true })).resolves.toMatchObject({ status: "approved" });
    expect(await listProfessionalFinanceExceptions()).toContainEqual(expect.objectContaining({ id: financeException.financeExceptionCaseId, payoutInstructionId: payout.payoutInstructionId, status: "approved", resolutionType: "credit_note" }));
    await expect(executeProfessionalFinanceCreditNote({ financeExceptionCaseId: financeException.financeExceptionCaseId, executedByIdentityId: checkerId })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    const creditNote = await executeProfessionalFinanceCreditNote({ financeExceptionCaseId: financeException.financeExceptionCaseId, executedByIdentityId: professionalId });
    expect(creditNote).toMatchObject({ creditNoteId: expect.any(String), journalId: expect.any(String), replayed: false });
    const issuedCreditNote = (await postgresQuery<{ journal_id: string }>("SELECT journal_id FROM fractal.professional_invoice_credit_notes WHERE id = $1", [creditNote.creditNoteId])).rows[0]!;
    expect((await postgresQuery<{ direction: string; amount_minor: string }>("SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number", [issuedCreditNote.journal_id])).rows).toEqual([{ direction: "debit", amount_minor: "250000" }, { direction: "credit", amount_minor: "250000" }]);
    await expect(postgresQuery("UPDATE fractal.professional_invoice_credit_notes SET reference = 'tampered' WHERE id = $1", [creditNote.creditNoteId])).rejects.toThrow(/immutable/);
    await postgresQuery("UPDATE fractal.professional_finance_exception_cases SET status = 'closed', closed_at = now() WHERE id = $1", [financeException.financeExceptionCaseId]);
    const replacementException = await openProfessionalFinanceException({ payoutInstructionId: payout.payoutInstructionId, openedByIdentityId: makerId });
    await recordProfessionalFinanceExceptionEvidence({ financeExceptionCaseId: replacementException.financeExceptionCaseId, uploadedByIdentityId: makerId, evidenceType: "bank_confirmation", storageKey: `local://test/${randomUUID()}-bank-confirmation.pdf`, filename: "bank-confirmation.pdf", mimeType: "application/pdf", contentSha256: "e".repeat(64) });
    await prepareProfessionalFinanceExceptionResolution({ financeExceptionCaseId: replacementException.financeExceptionCaseId, preparedByIdentityId: makerId, resolutionType: "replacement_payout", resolutionReason: "The completed service remains payable after the provider reversal, so a new separately authorized replacement request is required.", resolutionPayload: { replacementPayout: { payoutProfileVersionId: payoutProfileId, amountMinor: 250_000 } } });
    await decideProfessionalFinanceExceptionResolution({ financeExceptionCaseId: replacementException.financeExceptionCaseId, reviewedByIdentityId: checkerId, approve: true });
    await expect(authorizeProfessionalReplacementPayout({ financeExceptionCaseId: replacementException.financeExceptionCaseId, authorizedByIdentityId: makerId })).rejects.toBeInstanceOf(ProfessionalInvoiceError);
    const replacement = await authorizeProfessionalReplacementPayout({ financeExceptionCaseId: replacementException.financeExceptionCaseId, authorizedByIdentityId: professionalId });
    expect(replacement).toMatchObject({ replacementPayoutRequestId: expect.any(String), reference: expect.stringMatching(/^pro_replacement_/), replayed: false });
    expect((await postgresQuery<{ status: string; amount_minor: string; provider_recipient_reference: string }>("SELECT status, amount_minor, provider_recipient_reference FROM fractal.professional_replacement_payout_requests WHERE id = $1", [replacement.replacementPayoutRequestId])).rows[0]).toEqual({ status: "authorized", amount_minor: "250000", provider_recipient_reference: recipientReference });
    expect((await postgresQuery<{ action: string }>("SELECT action FROM fractal.audit_events WHERE entity_id = ANY($1::text[]) ORDER BY occurred_at", [[evidence.evidenceDocumentId, submitted.deliverableVersionId, resubmitted.deliverableVersionId]])).rows.map((row) => row.action)).toEqual(["professional_deliverable.evidence_recorded", "professional_deliverable.submitted", "professional_deliverable.revision_requested", "professional_deliverable.submitted", "professional_deliverable.accepted"]);
    expect((await postgresQuery<{ event_type: string }>("SELECT event_type FROM fractal.outbox_events WHERE aggregate_id = ANY($1::text[]) ORDER BY occurred_at", [[workOrder.workOrderId, submitted.deliverableVersionId, resubmitted.deliverableVersionId]])).rows.map((row) => row.event_type)).toEqual(["professional_work_order.invited", "professional_work_order.accepted", "professional_deliverable.evidence_recorded", "professional_deliverable.submitted", "professional_deliverable.revision_requested", "professional_deliverable.evidence_recorded", "professional_deliverable.submitted", "professional_deliverable.accepted"]);
  });

  it("requires a separate approval before an immutable approved offering becomes a dispatchable chain operation", async () => {
    const publicationEvidence = await recordPublicationEvidence();
    const approvedAssetApplicationVersionId = await createApprovedOrigin();
    const publication = await submitOfferingPublicationRequest({
      organizationId, submittedByIdentityId: makerId, publicReference: `chain-${randomUUID()}`, currency: "NGN", capacityMinor: 500_000,
      opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000),
      terms: offeringTerms("Chain-governed offering"),
      eligibilityPolicy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"] },
      ...publicationEvidence,
      approvedAssetApplicationVersionId,
    });
    const published = await decideOfferingPublicationRequest({ requestId: publication.requestId, decidedByIdentityId: checkerId, approve: true });
    const evidence = await recordPolicyEvidence(published.offeringId!, "f".repeat(64));
    const issuanceTerms = await submitOfferingIssuanceTerms({ organizationId, offeringId: published.offeringId!, submittedByIdentityId: makerId, tokenUnitPriceMinor: 100, maxTotalSupply: 5_000, allocationPolicyEvidenceDocumentId: evidence.evidenceDocumentId });
    await decideOfferingIssuanceTerms({ requestId: issuanceTerms.requestId, decidedByIdentityId: checkerId, approve: true });
    const deployment = await submitOfferingChainDeploymentRequest({
      organizationId, offeringId: published.offeringId!, submittedByIdentityId: makerId, chainId: 11155111,
      tokenFactoryAddress: "0xb74d6011bd68d379d8816a5b50f24390759db469", offeringName: "Chain-governed offering", tokenName: "Fractal Chain Offering", tokenSymbol: "CHAIN-1",
      issuanceTermsRequestId: issuanceTerms.requestId, maxBalancePerHolder: 100_000, retailCap: 25_000,
    });
    await expect(decideOfferingChainDeploymentRequest({ requestId: deployment.requestId, decidedByIdentityId: makerId, approve: true }))
      .rejects.toBeInstanceOf(OfferingChainDeploymentError);
    const approval = await decideOfferingChainDeploymentRequest({ requestId: deployment.requestId, decidedByIdentityId: checkerId, approve: true });
    expect(approval).toMatchObject({ requestId: deployment.requestId, status: "approved" });
    expect(approval.operationId).toBeTruthy();
    expect((await postgresQuery<{ status: string; transaction_hash: string | null }>("SELECT status, transaction_hash FROM fractal.offering_chain_operations WHERE id = $1", [approval.operationId])).rows[0])
      .toEqual({ status: "approved", transaction_hash: null });
    const claimId = randomUUID();
    await postgresQuery(
      "INSERT INTO fractal.offering_chain_operation_dispatch_claims (id, operation_id, worker_id, status) VALUES ($1, $2, 'test-worker', 'claimed')",
      [claimId, approval.operationId],
    );
    await expect(postgresQuery("UPDATE fractal.offering_chain_operation_dispatch_claims SET status = 'confirmed' WHERE id = $1", [claimId]))
      .rejects.toThrow(/invalid offering chain operation dispatch claim transition|violates check constraint/);
    await expect(postgresQuery("UPDATE fractal.offering_chain_deployment_requests SET token_symbol = 'TAMPER' WHERE id = $1", [deployment.requestId]))
      .rejects.toThrow(/may only be decided once|immutable/);
    await expect(postgresQuery("UPDATE fractal.offering_chain_operations SET status = 'confirmed' WHERE id = $1", [approval.operationId]))
      .rejects.toThrow(/invalid offering chain operation transition|violates check constraint/);
  });

  it("governs immutable issuance economics and rejects supply above offering capacity", async () => {
    const publicationEvidence = await recordPublicationEvidence();
    const approvedAssetApplicationVersionId = await createApprovedOrigin();
    const publication = await submitOfferingPublicationRequest({
      organizationId, submittedByIdentityId: makerId, publicReference: `economics-${randomUUID()}`, currency: "NGN", capacityMinor: 500_000,
      opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60 * 60 * 1_000),
      terms: offeringTerms("Economics-governed offering"),
      eligibilityPolicy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"] }, ...publicationEvidence, approvedAssetApplicationVersionId,
    });
    const published = await decideOfferingPublicationRequest({ requestId: publication.requestId, decidedByIdentityId: checkerId, approve: true });
    const evidence = await recordPolicyEvidence(published.offeringId!, "e".repeat(64));
    await expect(postgresQuery(
      `INSERT INTO fractal.offering_issuance_term_requests
       (id, organization_id, offering_id, offering_version_id, currency, token_unit_price_minor, max_total_supply, allocation_policy_hash, allocation_policy_evidence_document_id, status, submitted_by_identity_id, submitted_at)
       SELECT $1, $2, product.id, version.id, 'NGN', 100, 100, $3, $4, 'submitted', $5, now()
         FROM fractal.offering_products product
         JOIN LATERAL (SELECT id FROM fractal.offering_publication_versions WHERE offering_id = product.id ORDER BY version DESC LIMIT 1) version ON true
        WHERE product.id = $6`,
      [randomUUID(), organizationId, "0".repeat(64), evidence.evidenceDocumentId, makerId, published.offeringId],
    )).rejects.toThrow(/evidence does not match/);
    await expect(submitOfferingIssuanceTerms({ organizationId, offeringId: published.offeringId!, submittedByIdentityId: makerId, tokenUnitPriceMinor: 101, maxTotalSupply: 5_000, allocationPolicyEvidenceDocumentId: evidence.evidenceDocumentId }))
      .rejects.toBeInstanceOf(OfferingIssuanceTermsError);
    const terms = await submitOfferingIssuanceTerms({ organizationId, offeringId: published.offeringId!, submittedByIdentityId: makerId, tokenUnitPriceMinor: 100, maxTotalSupply: 5_000, allocationPolicyEvidenceDocumentId: evidence.evidenceDocumentId });
    await expect(decideOfferingIssuanceTerms({ requestId: terms.requestId, decidedByIdentityId: makerId, approve: true })).rejects.toBeInstanceOf(OfferingIssuanceTermsError);
    expect(await decideOfferingIssuanceTerms({ requestId: terms.requestId, decidedByIdentityId: checkerId, approve: true })).toMatchObject({ requestId: terms.requestId, status: "approved" });
    await expect(postgresQuery("UPDATE fractal.offering_issuance_term_requests SET max_total_supply = 1 WHERE id = $1", [terms.requestId])).rejects.toThrow(/may only be decided once|immutable/);
  });
});
