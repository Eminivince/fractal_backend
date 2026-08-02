import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import { recordProviderPaymentReceipt } from "../postgres-payments.js";
import { expirePendingPaymentIntents } from "../../services/payment-expiry-worker.js";
import {
  CheckoutPolicyError,
  createCheckout,
  publishOffering,
  upsertInvestorComplianceProfile,
} from "../postgres-offering-checkout.js";
import { decideOfferingIssuanceTerms, submitOfferingIssuanceTerms } from "../postgres-offering-issuance-terms.js";
import { decideInvestmentAllocation, InvestmentAllocationError, submitInvestmentAllocation } from "../postgres-investment-allocations.js";
import { confirmInvestorWalletLinkChallenge, createInvestorWalletLinkChallenge } from "../postgres-investor-wallets.js";
import { listAllocationChainOperations, materializeAllocationChainOperations, releaseMintOperation } from "../postgres-allocation-chain-operations.js";
import { recordAllocationPolicyEvidence } from "../postgres-governance-evidence.js";
import { listInvestorPortfolioPositions } from "../postgres-investor-portfolio.js";
import { listInvestorAgreementDocuments } from "../postgres-investor-documents.js";
import { recordOfferingPublicationEvidence } from "../postgres-offering-publication-evidence.js";
import { env } from "../../config/env.js";
import { activateDuePlatformConfigurationVersions, decidePlatformConfigurationVersion, proposePlatformConfigurationVersion } from "../postgres-platform-configuration.js";
import { acknowledgeInvestorOfferingNotice, decideOfferingNotice, listInvestorOfferingNotices, markInvestorOfferingNoticeRead, submitOfferingNotice } from "../postgres-offering-notices.js";
import { collectCanonicalPrivacySourceSections } from "../postgres-privacy-package-preparations.js";
import {
  parsePrivacyContentProfile,
  privacyContentProfileSourceKeysForRight,
  privacySafeFieldCatalog,
  type PrivacyContentFieldCatalogVersion,
} from "../../modules/privacy/domain/privacy-content-profile.js";

const chain = vi.hoisted(() => ({
  assertTokenFactoryOwner: vi.fn(),
  assertTokenFactorySupportsImmutableIssuanceCap: vi.fn(),
  batchMint: vi.fn(),
  waitForTransaction: vi.fn(),
  whitelistInvestor: vi.fn(),
}));

vi.mock("../../services/blockchain.service.js", () => chain);

let organizationId = "";
let publisherId = "";
let investorId = "";
let checkerId = "";
const agreementHash = "a".repeat(64);
const disclosureHash = "b".repeat(64);
const walletAccount = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

function currentPrivacyProfile() {
  const fieldCatalogVersion: PrivacyContentFieldCatalogVersion = "privacy-safe-fields-v45";
  const rules = (right: "access" | "portability") => privacyContentProfileSourceKeysForRight(fieldCatalogVersion, right).map((sourceKey) => ({
    sourceKey,
    includedFields: [...privacySafeFieldCatalog[sourceKey]],
    excludedFields: [],
  }));
  return parsePrivacyContentProfile({
    profileReference: "PRIV-NOTICE-TEST-1",
    profileName: "Offering notice privacy collector test profile",
    schemaVersion: "privacy-content-profile-v1",
    fieldCatalogVersion,
    jurisdictionCode: "NG",
    legalBasisReference: "Authenticated data subject access test authority",
    effectiveScope: "authenticated_data_subject_access_and_portability",
    access: { sourceRules: rules("access") },
    portability: { sourceRules: rules("portability") },
  });
}

async function publish(capacityMinor = 200_000) {
  return publishOffering({
    organizationId,
    publishedByIdentityId: publisherId,
    publicReference: `offering-${randomUUID()}`,
    currency: "NGN",
    capacityMinor,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 60 * 60 * 1_000),
    terms: { name: "Verified offering", minimumTicketMinor: 10_000 },
    eligibilityPolicy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"], requiresAccreditation: false },
    agreementDocumentHash: agreementHash,
    disclosureBundleHash: disclosureHash,
  });
}

async function makeEligible() {
  await upsertInvestorComplianceProfile({
    identityId: investorId,
    kycStatus: "approved",
    investorClass: "retail",
    accreditationStatus: "not_required",
    jurisdictionCode: "NG",
    reviewedAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    evidence: { source: "test" },
  });
}

async function recordPolicyEvidence(offeringId: string, contentSha256: string) {
  return recordAllocationPolicyEvidence({
    organizationId, offeringId, uploadedByIdentityId: publisherId, filename: "allocation-policy.pdf", mimeType: "application/pdf",
    storageKey: `local://test/${randomUUID()}.pdf`, contentSha256, bytes: 128,
  });
}

describe("PostgreSQL offering checkout", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.professional_payout_instructions, fractal.professional_invoices, fractal.professional_payout_profile_versions, fractal.professional_deliverable_version_documents, fractal.professional_deliverable_versions, fractal.professional_deliverable_evidence_documents, fractal.professional_work_order_events, fractal.professional_work_order_conflicts, fractal.professional_work_order_assignments, fractal.professional_work_orders, fractal.professional_firm_memberships, fractal.professional_firm_profiles, fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.investor_wallets, fractal.investor_wallet_link_challenges, fractal.offering_chain_operation_dispatch_claims, fractal.offering_chain_operations, fractal.offering_chain_deployment_requests, fractal.offering_issuance_term_requests, fractal.governance_evidence_documents, fractal.offering_publication_requests, fractal.offering_publication_evidence_documents, fractal.asset_application_review_items, fractal.asset_application_version_supersessions, fractal.approved_asset_application_versions, fractal.asset_application_requests, fractal.asset_application_evidence_documents, fractal.investor_compliance_profile_reviews, fractal.investor_compliance_review_requests, fractal.payment_provider_instructions, fractal.investment_reservations, fractal.agreement_acceptances, fractal.investor_compliance_profiles, fractal.offering_publication_versions, fractal.offering_products, fractal.payment_reconciliation_cases, fractal.payment_receipts, fractal.payment_intents, fractal.journal_postings, fractal.journal_entries, fractal.ledger_accounts, fractal.security_notifications, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events CASCADE");
    organizationId = randomUUID();
    publisherId = randomUUID();
    investorId = randomUUID();
    checkerId = randomUUID();
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, jurisdiction_code, status) VALUES ($1, $2, 'NG', 'active')", [organizationId, `Checkout org ${organizationId}`]);
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Publisher', 'active'), ($3, $4, 'Investor', 'active'), ($5, $6, 'Checker', 'active')",
      [publisherId, `publisher-${publisherId}@example.test`, investorId, `investor-${investorId}@example.test`, checkerId, `checker-${checkerId}@example.test`],
    );
  });

  afterAll(async () => { await disconnectPostgres(); });

  it("freezes terms, eligibility and agreement before creating a reserved payment intent", async () => {
    const offering = await publish();
    const publishedAgreement = await postgresQuery<{ agreement_document_hash: string }>(
      "SELECT agreement_document_hash FROM fractal.offering_publication_versions WHERE id = $1",
      [offering.offeringVersionId],
    );
    await recordOfferingPublicationEvidence({ organizationId, evidenceKind: "agreement", uploadedByIdentityId: publisherId, filename: "governed-agreement.pdf", mimeType: "application/pdf", storageKey: `local://test/${randomUUID()}.pdf`, contentSha256: publishedAgreement.rows[0]!.agreement_document_hash, bytes: 128 });
    await makeEligible();
    const checkout = await createCheckout({
      publicReference: (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [offering.offeringId])).rows[0]!.public_reference,
      investorIdentityId: investorId,
      amountMinor: 125_050,
      signatureName: "Investor Name",
      agreementDocumentHash: agreementHash,
      provider: "paystack",
      providerReference: "checkout-reference-1",
      paymentExpiresAt: new Date(Date.now() + 30 * 60 * 1_000),
    });
    const reservation = await postgresQuery<{ status: string; amount_minor: string; commitment_id: string }>(
      "SELECT status, amount_minor, commitment_id FROM fractal.investment_reservations WHERE id = $1", [checkout.reservationId],
    );
    expect(reservation.rows[0]).toEqual({ status: "pending_payment", amount_minor: "125050", commitment_id: checkout.commitmentId });
    expect((await postgresQuery("SELECT * FROM fractal.investment_eligibility_snapshots WHERE id = $1", [checkout.eligibilitySnapshotId])).rowCount).toBe(1);
    expect((await postgresQuery("SELECT * FROM fractal.agreement_acceptances WHERE id = $1", [checkout.agreementAcceptanceId])).rowCount).toBe(1);
    await expect(listInvestorAgreementDocuments(investorId)).resolves.toEqual([expect.objectContaining({
      id: checkout.agreementAcceptanceId,
      type: "agreement",
      offeringVersion: 1,
      filename: "governed-agreement.pdf",
    })]);
    await expect(listInvestorAgreementDocuments(randomUUID())).resolves.toEqual([]);

    await recordProviderPaymentReceipt({
      provider: "paystack", providerReference: "checkout-reference-1", providerEventId: "charge.success:checkout-reference-1",
      amountMinor: 125_050, currency: "NGN", receivedAt: new Date(),
    });
    const confirmed = await postgresQuery<{ status: string }>("SELECT status FROM fractal.investment_reservations WHERE id = $1", [checkout.reservationId]);
    expect(confirmed.rows[0]?.status).toBe("confirmed");
  });

  it("publishes policy-bound notices to an exact confirmed-investor audience under maker-checker control",async()=>{
    await postgresQuery(`INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type) VALUES($1,$2,'admin','global'),($3,$4,'admin','global')`,[randomUUID(),publisherId,randomUUID(),checkerId]);
    await postgresQuery(`INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key) VALUES($1,$2,'platform_configuration_manage'),($3,$4,'platform_configuration_manage')`,[randomUUID(),publisherId,randomUUID(),checkerId]);
    const rules=Object.fromEntries(["material_event","operational_update","financial_report","meeting_notice","distribution_information"].map(category=>[category,{retentionDays:2555,acknowledgmentRequired:category==="material_event",acknowledgmentWindowDays:category==="material_event"?14:null}]));
    const policy=await proposePlatformConfigurationVersion({actorIdentityId:publisherId,configurationKey:"offering.notice.policy",proposedValue:{policyReference:"NOTICE-POLICY-NG-TEST-1",policyName:"Approved Nigerian investor notice test policy",schemaVersion:"offering-notice-policy-v1",jurisdictions:{NG:{legalBasisReference:"Test authority for retained material investor communications in Nigeria",rules}}},expectedProjectionVersion:null,effectiveAt:new Date(Date.now()-1000),reason:"Bind test offering notices to approved retention and acknowledgment rules.",commandKey:randomUUID()});
    await decidePlatformConfigurationVersion({actorIdentityId:checkerId,versionId:policy.version.id,action:"approve",expectedStateVersion:1,decisionReason:"Independently approve the complete investor-notice policy matrix.",commandKey:randomUUID()});
    await activateDuePlatformConfigurationVersions(new Date());
    const offering=await publish();await makeEligible();const reference=(await postgresQuery<{public_reference:string}>("SELECT public_reference FROM fractal.offering_products WHERE id=$1",[offering.offeringId])).rows[0]!.public_reference;
    const checkout=await createCheckout({publicReference:reference,investorIdentityId:investorId,amountMinor:100_000,signatureName:"Investor",agreementDocumentHash:agreementHash,provider:"paystack",providerReference:"notice-audience-payment",paymentExpiresAt:new Date(Date.now()+10*60*1000)});
    await recordProviderPaymentReceipt({provider:"paystack",providerReference:"notice-audience-payment",providerEventId:"charge.success:notice-audience-payment",amountMinor:100_000,currency:"NGN",receivedAt:new Date()});
    const submitted=await submitOfferingNotice({organizationId,offeringId:offering.offeringId,category:"material_event",subject:"Material operating event update",body:"A material operating event has occurred. Review this retained notice and acknowledge receipt within the policy window.",actorIdentityId:publisherId,commandKey:randomUUID()});
    await expect(decideOfferingNotice({requestId:submitted.requestId,actorIdentityId:publisherId,decision:"approve",decisionReason:"A submitter must never publish their own material notice."})).rejects.toThrow("submitter cannot decide");
    const approved=await decideOfferingNotice({requestId:submitted.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The material event, frozen audience, wording, and policy binding were independently reviewed."});
    expect(approved).toMatchObject({status:"approved",publishedNoticeId:expect.any(String)});
    const notices=await listInvestorOfferingNotices(investorId);expect(notices).toEqual([expect.objectContaining({id:approved.publishedNoticeId,subject:"Material operating event update",acknowledgmentRequired:true,firstReadAt:null,acknowledgedAt:null})]);
    await expect(acknowledgeInvestorOfferingNotice(investorId,approved.publishedNoticeId!)).rejects.toThrow("Open the notice");
    await markInvestorOfferingNoticeRead(investorId,approved.publishedNoticeId!);await acknowledgeInvestorOfferingNotice(investorId,approved.publishedNoticeId!);
    await expect(listInvestorOfferingNotices(investorId)).resolves.toEqual([expect.objectContaining({firstReadAt:expect.any(String),acknowledgedAt:expect.any(String)})]);
    await expect(listInvestorOfferingNotices(randomUUID())).resolves.toEqual([]);
    const investorSections=await withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,investorId,"access",currentPrivacyProfile()));
    const publisherSections=await withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,publisherId,"access",currentPrivacyProfile()));
    const checkerSections=await withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,checkerId,"access",currentPrivacyProfile()));
    const outsiderSections=await withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,randomUUID(),"access",currentPrivacyProfile()));
    const investorNotice=[
      investorSections.get("postgres.fractal.offering_notice_requests")?.canonicalContent??"",
      investorSections.get("postgres.fractal.offering_notices")?.canonicalContent??"",
      investorSections.get("postgres.fractal.offering_notice_recipients")?.canonicalContent??"",
      investorSections.get("postgres.fractal.offering_notice_recipient_events")?.canonicalContent??"",
    ].join("\n");
    expect(investorNotice).toContain('"participationRole":"recipient"');
    expect(investorNotice).toContain("Material operating event update");
    expect(investorNotice).toContain('"eventType":"opened"');
    expect(investorNotice).toContain('"eventType":"acknowledged"');
    expect(investorNotice).not.toContain(checkout.reservationId);
    expect(investorNotice).not.toContain(organizationId);
    expect(investorNotice).not.toContain(policy.version.id);
    expect(investorNotice).not.toContain("The material event, frozen audience, wording, and policy binding were independently reviewed.");
    expect(publisherSections.get("postgres.fractal.offering_notice_requests")?.canonicalContent).toContain('"participationRole":"submitter"');
    expect(checkerSections.get("postgres.fractal.offering_notice_requests")?.canonicalContent).toContain('"participationRole":"reviewer"');
    expect(checkerSections.get("postgres.fractal.offering_notices")?.canonicalContent).toContain('"participationRole":"publisher"');
    expect(outsiderSections.get("postgres.fractal.offering_notice_recipients")?.canonicalContent).toContain('"records":[]');
    await expect(postgresQuery("UPDATE fractal.offering_notices SET body='tampered notice' WHERE id=$1",[approved.publishedNoticeId])).rejects.toThrow("published offering notice evidence is immutable");
    expect(checkout.reservationId).toBeTruthy();
  });

  it("rejects an ineligible investor and prevents capacity over-reservation", async () => {
    const offering = await publish(200_000);
    const reference = (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [offering.offeringId])).rows[0]!.public_reference;
    await expect(createCheckout({
      publicReference: reference, investorIdentityId: investorId, amountMinor: 10_000, signatureName: "Investor",
      agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "ineligible-ref", paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    })).rejects.toBeInstanceOf(CheckoutPolicyError);
    const denial = await postgresQuery<{ status: string; reason_codes: string[] }>(
      "SELECT status, reason_codes FROM fractal.investment_eligibility_snapshots",
    );
    expect(denial.rows[0]?.status).toBe("ineligible");
    expect(denial.rows[0]?.reason_codes).toContain("kyc_not_approved");

    await makeEligible();
    await createCheckout({
      publicReference: reference, investorIdentityId: investorId, amountMinor: 150_000, signatureName: "Investor",
      agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "capacity-ref-1", paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    });
    await expect(createCheckout({
      publicReference: reference, investorIdentityId: investorId, amountMinor: 60_000, signatureName: "Investor",
      agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "capacity-ref-2", paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    })).rejects.toBeInstanceOf(CheckoutPolicyError);
  });

  it("replays a checkout command without reserving or creating a second payment intent", async () => {
    const offering = await publish();
    await makeEligible();
    const reference = (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [offering.offeringId])).rows[0]!.public_reference;
    const input = {
      publicReference: reference, investorIdentityId: investorId, amountMinor: 25_000, signatureName: "Investor",
      agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "idempotent-reference-1",
      paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1_000), commandKey: "checkout-command-1",
    };
    const first = await createCheckout(input);
    const replay = await createCheckout({ ...input, providerReference: "ignored-on-replay" });
    expect(replay).toEqual(first);
    expect((await postgresQuery("SELECT * FROM fractal.investment_reservations")).rowCount).toBe(1);
    expect((await postgresQuery("SELECT * FROM fractal.payment_intents")).rowCount).toBe(1);
  });

  it("expires an unpaid checkout, releases capacity, and prevents it remaining payable", async () => {
    const offering = await publish();
    await makeEligible();
    const reference = (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [offering.offeringId])).rows[0]!.public_reference;
    const expiresAt = new Date(Date.now() + 1_000);
    const checkout = await createCheckout({
      publicReference: reference, investorIdentityId: investorId, amountMinor: 25_000, signatureName: "Investor",
      agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "expiry-reference-1", paymentExpiresAt: expiresAt,
    });
    expect(await expirePendingPaymentIntents(new Date(expiresAt.getTime() + 1_000))).toBe(1);
    const state = await postgresQuery<{ intent: string; reservation: string }>(
      `SELECT intent.status AS intent, reservation.status AS reservation
         FROM fractal.payment_intents intent JOIN fractal.investment_reservations reservation ON reservation.commitment_id = intent.commitment_id
        WHERE intent.id = $1`, [checkout.paymentIntentId],
    );
    expect(state.rows[0]).toEqual({ intent: "expired", reservation: "expired" });
    await expect(recordProviderPaymentReceipt({
      provider: "paystack", providerReference: "expiry-reference-1", providerEventId: "charge.success:expiry-reference-1",
      amountMinor: 25_000, currency: "NGN", receivedAt: new Date(expiresAt.getTime() + 2_000),
    })).rejects.toThrow(/expired/);
  });

  it("derives a wallet-bound allocation from matched payment and approved terms", async () => {
    const offering = await publish();
    await makeEligible();
    const reference = (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [offering.offeringId])).rows[0]!.public_reference;
    const checkout = await createCheckout({ publicReference: reference, investorIdentityId: investorId, amountMinor: 100_000, signatureName: "Investor", agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "allocation-reference-1", paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1_000) });
    await recordProviderPaymentReceipt({ provider: "paystack", providerReference: "allocation-reference-1", providerEventId: "charge.success:allocation-reference-1", amountMinor: 100_000, currency: "NGN", receivedAt: new Date() });
    const challenge = await createInvestorWalletLinkChallenge({ investorIdentityId: investorId, chainId: 11155111, walletAddress: walletAccount.address });
    const wallet = await confirmInvestorWalletLinkChallenge({ investorIdentityId: investorId, challengeId: challenge.challengeId, signature: await walletAccount.signMessage({ message: challenge.message }) });
    const evidence = await recordPolicyEvidence(offering.offeringId, "f".repeat(64));
    const terms = await submitOfferingIssuanceTerms({ organizationId, offeringId: offering.offeringId, submittedByIdentityId: publisherId, tokenUnitPriceMinor: 100, maxTotalSupply: 2_000, allocationPolicyEvidenceDocumentId: evidence.evidenceDocumentId });
    await decideOfferingIssuanceTerms({ requestId: terms.requestId, decidedByIdentityId: checkerId, approve: true });
    const allocation = await submitInvestmentAllocation({ organizationId, offeringId: offering.offeringId, issuanceTermsRequestId: terms.requestId, reservationId: checkout.reservationId, walletId: wallet.walletId, chainId: 11155111, submittedByIdentityId: publisherId });
    expect(allocation.tokenAmount).toBe("1000");
    await expect(decideInvestmentAllocation({ requestId: allocation.requestId, decidedByIdentityId: publisherId, approve: true })).rejects.toBeInstanceOf(InvestmentAllocationError);
    expect(await decideInvestmentAllocation({ requestId: allocation.requestId, decidedByIdentityId: checkerId, approve: true })).toMatchObject({ status: "approved" });
    await expect(postgresQuery("UPDATE fractal.investment_allocation_requests SET token_amount = 1 WHERE id = $1", [allocation.requestId])).rejects.toThrow(/may only be decided once|immutable/);

    const deploymentRequestId = randomUUID();
    const deploymentOperationId = randomUUID();
    const factoryAddress = `0x${"1".repeat(40)}`;
    const tokenAddress = `0x${"2".repeat(40)}`;
    const transactionHash = `0x${"3".repeat(64)}`;
    await postgresQuery(
      `INSERT INTO fractal.offering_chain_deployment_requests
       (id, organization_id, offering_id, offering_version_id, issuance_terms_request_id, chain_id, token_factory_address, offering_name, token_name, token_symbol, max_balance_per_holder, retail_cap, max_total_supply, status, submitted_by_identity_id, submitted_at, decided_by_identity_id, decided_at)
       SELECT $1, $2, product.id, version.id, $3, 11155111, $4, 'Allocation test offering', 'Allocation test token', 'ALLOC-T', 0, 0, 2000, 'approved', $5, now(), $6, now()
         FROM fractal.offering_products product JOIN LATERAL (SELECT id FROM fractal.offering_publication_versions WHERE offering_id = product.id ORDER BY version DESC LIMIT 1) version ON true WHERE product.id = $7`,
      [deploymentRequestId, organizationId, terms.requestId, factoryAddress, publisherId, checkerId, offering.offeringId],
    );
    await postgresQuery(
      `INSERT INTO fractal.offering_chain_operations
       (id, request_id, organization_id, offering_id, chain_id, token_factory_address, operation_type, status, transaction_hash, token_contract_address, block_number, submitted_at, confirmed_at)
       VALUES ($1,$2,$3,$4,11155111,$5,'deploy_token','confirmed',$6,$7,1,now(),now())`,
      [deploymentOperationId, deploymentRequestId, organizationId, offering.offeringId, factoryAddress, transactionHash, tokenAddress],
    );
    expect(await materializeAllocationChainOperations()).toBe(1);
    const whitelist = (await listAllocationChainOperations({ organizationId, allocationRequestId: allocation.requestId }))[0]!;
    expect(whitelist).toMatchObject({ operationType: "whitelist", status: "approved", tokenContractAddress: tokenAddress });
    await postgresQuery("UPDATE fractal.investment_allocation_chain_operations SET status = 'submitted', transaction_hash = $2, submitted_at = now(), updated_at = now() WHERE id = $1", [whitelist.id, `0x${"4".repeat(64)}`]);
    await postgresQuery("UPDATE fractal.investment_allocation_chain_operations SET status = 'confirmed', confirmed_at = now(), updated_at = now() WHERE id = $1", [whitelist.id]);
    const mintId = await releaseMintOperation({ whitelistOperationId: whitelist.id });
    expect((await listAllocationChainOperations({ organizationId, allocationRequestId: allocation.requestId })).find((operation) => operation.id === mintId)).toMatchObject({ operationType: "mint", status: "approved", tokenAmount: "1000" });
    const positions = await listInvestorPortfolioPositions(investorId);
    expect(positions).toEqual([expect.objectContaining({
      allocationRequestId: allocation.requestId,
      publicReference: reference,
      offeringName: "Verified offering",
      investedMinor: "100000",
      tokenAmount: "1000",
      allocationStatus: "approved",
      mint: expect.objectContaining({ status: "approved", tokenContractAddress: tokenAddress }),
    })]);
    await expect(listInvestorPortfolioPositions(randomUUID())).resolves.toEqual([]);
  });

  it("holds an allocation operation for manual reconciliation when broadcast certainty is lost", async () => {
    const offering = await publish();
    await makeEligible();
    const reference = (await postgresQuery<{ public_reference: string }>("SELECT public_reference FROM fractal.offering_products WHERE id = $1", [offering.offeringId])).rows[0]!.public_reference;
    const checkout = await createCheckout({ publicReference: reference, investorIdentityId: investorId, amountMinor: 100_000, signatureName: "Investor", agreementDocumentHash: agreementHash, provider: "paystack", providerReference: "uncertain-allocation-reference", paymentExpiresAt: new Date(Date.now() + 10 * 60 * 1_000) });
    await recordProviderPaymentReceipt({ provider: "paystack", providerReference: "uncertain-allocation-reference", providerEventId: "charge.success:uncertain-allocation-reference", amountMinor: 100_000, currency: "NGN", receivedAt: new Date() });
    const challenge = await createInvestorWalletLinkChallenge({ investorIdentityId: investorId, chainId: 11155111, walletAddress: walletAccount.address });
    const wallet = await confirmInvestorWalletLinkChallenge({ investorIdentityId: investorId, challengeId: challenge.challengeId, signature: await walletAccount.signMessage({ message: challenge.message }) });
    const evidence = await recordPolicyEvidence(offering.offeringId, "e".repeat(64));
    const terms = await submitOfferingIssuanceTerms({ organizationId, offeringId: offering.offeringId, submittedByIdentityId: publisherId, tokenUnitPriceMinor: 100, maxTotalSupply: 2_000, allocationPolicyEvidenceDocumentId: evidence.evidenceDocumentId });
    await decideOfferingIssuanceTerms({ requestId: terms.requestId, decidedByIdentityId: checkerId, approve: true });
    const allocation = await submitInvestmentAllocation({ organizationId, offeringId: offering.offeringId, issuanceTermsRequestId: terms.requestId, reservationId: checkout.reservationId, walletId: wallet.walletId, chainId: 11155111, submittedByIdentityId: publisherId });
    await decideInvestmentAllocation({ requestId: allocation.requestId, decidedByIdentityId: checkerId, approve: true });

    const deploymentRequestId = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.offering_chain_deployment_requests
       (id, organization_id, offering_id, offering_version_id, issuance_terms_request_id, chain_id, token_factory_address, offering_name, token_name, token_symbol, max_balance_per_holder, retail_cap, max_total_supply, status, submitted_by_identity_id, submitted_at, decided_by_identity_id, decided_at)
       SELECT $1, $2, product.id, version.id, $3, 11155111, $4, 'Uncertain allocation offering', 'Uncertain allocation token', 'UNCERT', 0, 0, 2000, 'approved', $5, now(), $6, now()
         FROM fractal.offering_products product JOIN LATERAL (SELECT id FROM fractal.offering_publication_versions WHERE offering_id = product.id ORDER BY version DESC LIMIT 1) version ON true WHERE product.id = $7`,
      [deploymentRequestId, organizationId, terms.requestId, `0x${"1".repeat(40)}`, publisherId, checkerId, offering.offeringId],
    );
    await postgresQuery(
      `INSERT INTO fractal.offering_chain_operations
       (id, request_id, organization_id, offering_id, chain_id, token_factory_address, operation_type, status, transaction_hash, token_contract_address, block_number, submitted_at, confirmed_at)
       VALUES ($1,$2,$3,$4,11155111,$5,'deploy_token','confirmed',$6,$7,1,now(),now())`,
      [randomUUID(), deploymentRequestId, organizationId, offering.offeringId, `0x${"1".repeat(40)}`, `0x${"3".repeat(64)}`, `0x${"2".repeat(40)}`],
    );
    expect(await materializeAllocationChainOperations()).toBe(1);

    const { dispatchAllocationChainOperations } = await import("../../services/postgres-allocation-chain-executor.js");
    const wasEnabled = env.ALLOCATION_CHAIN_EXECUTOR_ENABLED;
    const configuredChainId = env.CHAIN_ID;
    env.ALLOCATION_CHAIN_EXECUTOR_ENABLED = true;
    env.CHAIN_ID = 11155111;
    chain.assertTokenFactoryOwner.mockResolvedValue(undefined);
    chain.assertTokenFactorySupportsImmutableIssuanceCap.mockResolvedValue(undefined);
    chain.whitelistInvestor.mockRejectedValue(new Error("broadcast outcome unknown"));
    const logger = { info: vi.fn(), error: vi.fn() };
    try {
      expect(await dispatchAllocationChainOperations({ workerId: "fault-test", logger })).toBe(1);
      expect(await dispatchAllocationChainOperations({ workerId: "fault-test-retry", logger })).toBe(0);
    } finally {
      env.ALLOCATION_CHAIN_EXECUTOR_ENABLED = wasEnabled;
      env.CHAIN_ID = configuredChainId;
    }

    const whitelist = (await listAllocationChainOperations({ organizationId, allocationRequestId: allocation.requestId }))[0]!;
    expect(whitelist).toMatchObject({ operationType: "whitelist", status: "approved", transactionHash: null, requiresManualReconciliation: true });
    expect(chain.whitelistInvestor).toHaveBeenCalledTimes(1);
    expect((await postgresQuery<{ status: string; failure_reason: string }>("SELECT status, failure_reason FROM fractal.investment_allocation_chain_dispatch_claims WHERE operation_id = $1", [whitelist.id])).rows[0])
      .toEqual({ status: "uncertain", failure_reason: "broadcast outcome unknown" });
  });
});
