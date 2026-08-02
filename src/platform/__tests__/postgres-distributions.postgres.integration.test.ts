import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import { privacyContentProfileSourceKeysForRight, privacySafeFieldCatalog, type PrivacyContentFieldCatalogVersion } from "../../modules/privacy/domain/privacy-content-profile.js";
import { activateDuePlatformConfigurationVersions, decidePlatformConfigurationVersion, proposePlatformConfigurationVersion } from "../postgres-platform-configuration.js";
import { decideDistributionDeclaration, decideOwnershipSnapshot, DistributionAuthorityError, listDistributionDeclarations, listInvestorDistributionEntitlements, submitDistributionDeclaration, submitOwnershipSnapshot } from "../postgres-distributions.js";
import { addDistributionPayoutExceptionEvidence, approveDistributionPayoutExceptionPolicy, createDistributionPayoutExceptionPolicy, decideDistributionFundingRequest, decideDistributionPayoutExceptionHold, decideDistributionPayoutExceptionResolution, DistributionPayoutError, executeDistributionPayoutException, openDistributionPayoutException, proposeDistributionPayoutExceptionHold, proposeDistributionPayoutExceptionResolution, recordDistributionPayoutProviderOutcome, submitDistributionFundingRequest, verifyInvestorDistributionPayoutProfile } from "../postgres-distribution-payouts.js";
import { dispatchOneDistributionPayout } from "../../services/distribution-payout-worker.js";
import { approveDistributionTaxPolicy, createDistributionTaxPolicy, decideDistributionTaxFiling, decideDistributionTaxPayment, decideDistributionTaxRemittanceReversal, listInvestorDistributionTaxStatements, proposeDistributionTaxRemittanceReversal, submitDistributionTaxPaymentEvidence, submitDistributionTaxRemittance } from "../postgres-distribution-tax.js";
import { collectCanonicalPrivacySourceSections } from "../postgres-privacy-package-preparations.js";
import { decideLegalHoldChange, proposeLegalHoldChange, readDistributionLegalHoldLifecycle, SupportEvidenceLifecycleError } from "../postgres-support-evidence-lifecycle.js";
import { createPrivacyRightsRequest, decidePrivacyRightsDecision, getOwnPrivacyRightsRequest, proposePrivacyRightsDecision, transitionAdministratorPrivacyRightsRequest } from "../postgres-privacy-rights.js";
import { decideDistributionPrivacyTreatment, proposeDistributionPrivacyTreatment } from "../postgres-distribution-privacy-treatments.js";

describe("PostgreSQL distribution authority", () => {
  let organizationId="",makerId="",checkerId="",investorA="",investorB="",offeringId="",tokenAddress="",walletA="",walletB="";
  beforeAll(async()=>{await connectPostgres({required:true});await applyPostgresMigrations();});
  beforeEach(async()=>{
    await postgresQuery("TRUNCATE fractal.investor_distribution_tax_statements, fractal.distribution_tax_remittance_reversal_requests, fractal.distribution_tax_remittance_requests, fractal.distribution_tax_remittance_policies, fractal.distribution_payout_exception_executions, fractal.distribution_payout_exception_hold_requests, fractal.distribution_payout_exception_evidence, fractal.distribution_payout_exception_cases, fractal.distribution_payout_exception_policies, fractal.distribution_payout_provider_events,fractal.distribution_payout_instructions,fractal.distribution_funding_requests,fractal.distribution_payout_recipient_recovery_cases,fractal.investor_distribution_payout_profiles,fractal.distribution_entitlements,fractal.distribution_declaration_requests,fractal.ownership_snapshot_holdings,fractal.ownership_snapshot_requests,fractal.offering_chain_operations,fractal.offering_chain_deployment_requests,fractal.investor_wallets,fractal.investor_wallet_link_challenges,fractal.offering_publication_versions,fractal.offering_products,fractal.platform_configuration_activation_attempts,fractal.platform_configuration_active_versions,fractal.platform_configuration_events,fractal.platform_configuration_versions,fractal.journal_postings,fractal.journal_entries,fractal.ledger_accounts,fractal.administrator_capability_assignments,fractal.identity_role_assignments,fractal.audit_chain_heads,fractal.audit_events,fractal.outbox_events,fractal.idempotency_commands,fractal.organizations,fractal.identities CASCADE");
    organizationId=randomUUID();makerId=randomUUID();checkerId=randomUUID();investorA=randomUUID();investorB=randomUUID();offeringId=randomUUID();tokenAddress=`0x${randomUUID().replaceAll("-","")}33333333`;walletA=`0x${randomUUID().replaceAll("-","")}11111111`;walletB=`0x${randomUUID().replaceAll("-","")}22222222`;
    await postgresQuery("INSERT INTO fractal.identities(id,email,legal_name,status,email_verified_at) VALUES($1,$2,'Distribution maker','active',now()),($3,$4,'Distribution checker','active',now()),($5,$6,'Holder A','active',now()),($7,$8,'Holder B','active',now())",[makerId,`maker-${makerId}@example.test`,checkerId,`checker-${checkerId}@example.test`,investorA,`a-${investorA}@example.test`,investorB,`b-${investorB}@example.test`]);
    await postgresQuery("INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type) VALUES($1,$2,'admin','global'),($3,$4,'admin','global'),($5,$6,'investor','global'),($7,$8,'investor','global')",[randomUUID(),makerId,randomUUID(),checkerId,randomUUID(),investorA,randomUUID(),investorB]);
    await postgresQuery("INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key) VALUES($1,$2,'platform_configuration_manage'),($3,$4,'platform_configuration_manage'),($5,$2,'data_lifecycle_manage'),($6,$4,'data_lifecycle_manage'),($7,$2,'privacy_request_manage'),($8,$4,'privacy_request_manage')",[randomUUID(),makerId,randomUUID(),checkerId,randomUUID(),randomUUID(),randomUUID(),randomUUID()]);
    await postgresQuery("INSERT INTO fractal.organizations(id,legal_name,status,jurisdiction_code) VALUES($1,'Distribution issuer','active','NG')",[organizationId]);
    const offeringVersionId=randomUUID(),deploymentRequestId=randomUUID();
    await postgresQuery("INSERT INTO fractal.offering_products(id,organization_id,public_reference,status,currency,capacity_minor,opens_at,closes_at) VALUES($1,$2,'DIST-TEST','published','NGN',1000000,now()-interval '1 day',now()+interval '1 day')",[offeringId,organizationId]);
    await postgresQuery("INSERT INTO fractal.offering_publication_versions(id,offering_id,version,terms,eligibility_policy,agreement_document_hash,disclosure_bundle_hash,published_by_identity_id,published_at) VALUES($1,$2,1,$3,'{}',$4,$5,$6,now())",[offeringVersionId,offeringId,{name:"Distribution test offering"},"a".repeat(64),"b".repeat(64),checkerId]);
    await postgresQuery("INSERT INTO fractal.offering_chain_deployment_requests(id,organization_id,offering_id,offering_version_id,chain_id,token_factory_address,token_name,token_symbol,status,submitted_by_identity_id,submitted_at,decided_by_identity_id,decided_at) VALUES($1,$2,$3,$4,11155111,$5,'Distribution Token','DIST','approved',$6,now(),$7,now())",[deploymentRequestId,organizationId,offeringId,offeringVersionId,`0x${"4".repeat(40)}`,makerId,checkerId]);
    await postgresQuery("INSERT INTO fractal.offering_chain_operations(id,request_id,organization_id,offering_id,chain_id,token_factory_address,operation_type,status,transaction_hash,token_contract_address,block_number,submitted_at,confirmed_at) VALUES($1,$2,$3,$4,11155111,$5,'deploy_token','confirmed',$6,$7,900,now(),now())",[randomUUID(),deploymentRequestId,organizationId,offeringId,`0x${"4".repeat(40)}`,`0x${"5".repeat(64)}`,tokenAddress]);
    for(const [identity,wallet] of [[investorA,walletA],[investorB,walletB]] as const){const challenge=randomUUID();await postgresQuery("INSERT INTO fractal.investor_wallet_link_challenges(id,investor_identity_id,chain_id,wallet_address,message_hash,expires_at,status,consumed_at) VALUES($1,$2,11155111,$3,$4,now()+interval '1 hour','consumed',now())",[challenge,identity,wallet,"c".repeat(64)]);await postgresQuery("INSERT INTO fractal.investor_wallets(id,investor_identity_id,chain_id,wallet_address,link_challenge_id,signature_hash,status,verified_at) VALUES($1,$2,11155111,$3,$4,$5,'active',now())",[randomUUID(),identity,wallet,challenge,"d".repeat(64)]);}
    const proposed=await proposePlatformConfigurationVersion({actorIdentityId:makerId,configurationKey:"offering.distribution.policy",proposedValue:{policyReference:"DIST-NG-TEST-1",policyName:"Approved test distribution policy",schemaVersion:"distribution-policy-v1",jurisdictions:{NG:{legalBasisReference:"Approved test legal and tax memorandum",currencies:{NGN:{minimumConfirmations:12,maximumDeclarationMinor:"1000000",maximumWithholdingTaxBps:1000,retentionDays:2555}}}}},expectedProjectionVersion:null,effectiveAt:new Date(Date.now()-1000),reason:"Bind distribution tests to an exact approved record-date and tax policy.",commandKey:randomUUID()});
    await decidePlatformConfigurationVersion({actorIdentityId:checkerId,versionId:proposed.version.id,action:"approve",expectedStateVersion:1,decisionReason:"Independently approve the complete test distribution limit and confirmation rule.",commandKey:randomUUID()});
    const treatment={correctionTreatment:"append_only_domain_correction" as const,erasureTreatment:"retain_then_review_for_minimization_or_disposition" as const,restrictionTreatment:"mandatory_processing_only" as const,objectionTreatment:"documented_lawful_basis_review" as const};
    const lifecycle=await proposePlatformConfigurationVersion({actorIdentityId:makerId,configurationKey:"privacy.distribution.lifecycle_policy",proposedValue:{policyReference:"DIST-LIFECYCLE-NG-TEST-1",policyName:"Approved test distribution lifecycle policy",schemaVersion:"distribution-lifecycle-policy-v1",jurisdictions:{NG:{legalBasisReference:"Approved test financial, tax, fraud, and ownership retention memorandum",rules:{ownership_snapshot:{retentionDays:2555,...treatment},distribution_declaration:{retentionDays:2555,...treatment},payout_exception:{retentionDays:2555,...treatment},tax_remittance:{retentionDays:3650,...treatment}}}}},expectedProjectionVersion:null,effectiveAt:new Date(Date.now()-1000),reason:"Bind every new organization-scoped distribution record chain to exact retention and rights-treatment rules.",commandKey:randomUUID()});
    await decidePlatformConfigurationVersion({actorIdentityId:checkerId,versionId:lifecycle.version.id,action:"approve",expectedStateVersion:1,decisionReason:"Independently approve the complete record-class retention and lawful privacy-treatment matrix.",commandKey:randomUUID()});
    const responsePolicy=await proposePlatformConfigurationVersion({actorIdentityId:makerId,configurationKey:"privacy.rights.response_policy",proposedValue:{policyReference:"PRIV-DIST-NG-TEST-1",policyName:"Nigeria distribution privacy response policy",jurisdiction:"Nigeria",controllerName:"Fractal Platform Limited",identityAssurance:"authenticated_verified_email_session",communicationChannel:"authenticated_register",deadlineBasis:"calendar_days_from_authenticated_intake",responseCalendarDays:{access:30,portability:30,correction:30,erasure:30,restriction:21,objection:21}},expectedProjectionVersion:null,effectiveAt:new Date(Date.now()-1000),reason:"Bind authenticated distribution privacy requests to an approved response clock.",commandKey:randomUUID()});
    await decidePlatformConfigurationVersion({actorIdentityId:checkerId,versionId:responsePolicy.version.id,action:"approve",expectedStateVersion:1,decisionReason:"Independently approve the controller, assurance, channel, and response deadlines.",commandKey:randomUUID()});
    expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({activated:3,failed:0});
  });
  afterAll(async()=>{await disconnectPostgres();});

  function snapshotCommand(confirmations=20){return{organizationId,offeringId,chainId:11155111,tokenContractAddress:tokenAddress,recordAt:new Date(Date.now()-60_000),blockNumber:"1000",blockHash:`0x${"6".repeat(64)}`,confirmations,sourceType:"independent_indexer" as const,sourceReference:"independent-indexer-export-1000",sourceManifestSha256:"e".repeat(64),totalSupplyUnits:"3",holdings:[{walletAddress:walletA,balanceUnits:"1",sourceRowSha256:"1".repeat(64)},{walletAddress:walletB,balanceUnits:"2",sourceRowSha256:"2".repeat(64)}],actorIdentityId:makerId,commandKey:randomUUID()};}
  function privacyProfile(){const fieldCatalogVersion:PrivacyContentFieldCatalogVersion="privacy-safe-fields-v43";const rules=(right:"access"|"portability")=>privacyContentProfileSourceKeysForRight(fieldCatalogVersion,right).map(sourceKey=>({sourceKey,includedFields:[...privacySafeFieldCatalog[sourceKey]],excludedFields:[]}));return{profileReference:"PRIV-DIST-NG-001",profileName:"Nigeria distribution privacy access profile",schemaVersion:"privacy-content-profile-v1" as const,fieldCatalogVersion,jurisdictionCode:"NG",legalBasisReference:"Approved distribution data-subject access basis",effectiveScope:"authenticated_data_subject_access_and_portability" as const,access:{sourceRules:rules("access")},portability:{sourceRules:rules("portability")}};}
  async function collectPrivacy(identityId:string){return withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,identityId,"access",privacyProfile()));}

  it("reconciles record-date ownership, allocates every minor unit, and journals only after independent approval",async()=>{
    const command=snapshotCommand(),snapshot=await submitOwnershipSnapshot(command);expect(await submitOwnershipSnapshot(command)).toMatchObject({requestId:snapshot.requestId,replayed:true});
    await expect(submitOwnershipSnapshot({...command,sourceReference:"changed-source"})).rejects.toThrow(/command key/);
    await expect(decideOwnershipSnapshot({requestId:snapshot.requestId,actorIdentityId:makerId,decision:"approve",decisionReason:"The submitting actor cannot approve their own snapshot evidence."})).rejects.toBeInstanceOf(DistributionAuthorityError);
    await decideOwnershipSnapshot({requestId:snapshot.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The token, block, manifest, linked wallets, balances, and total supply independently reconcile."});
    await expect(postgresQuery("UPDATE fractal.ownership_snapshot_holdings SET balance_units=2 WHERE snapshot_request_id=$1 AND investor_identity_id=$2",[snapshot.requestId,investorA])).rejects.toThrow(/immutable/);
    const declaration=await submitDistributionDeclaration({organizationId,offeringId,ownershipSnapshotRequestId:snapshot.requestId,periodLabel:"2026 Q2 operating distribution",currency:"ngn",grossAmountMinor:"100",withholdingTaxBps:1000,paymentDueAt:new Date(Date.now()+86_400_000),actorIdentityId:makerId,commandKey:randomUUID()});
    await expect(decideDistributionDeclaration({requestId:declaration.requestId,actorIdentityId:makerId,decision:"approve",decisionReason:"The submitting actor cannot approve their own financial declaration."})).rejects.toBeInstanceOf(DistributionAuthorityError);
    const approved=await decideDistributionDeclaration({requestId:declaration.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The approved snapshot, exact pro-rata calculation, tax treatment, policy limit, and journal were independently reviewed."});
    const entitlements=await postgresQuery<{gross_amount_minor:string;withholding_tax_minor:string;net_amount_minor:string}>("SELECT gross_amount_minor,withholding_tax_minor,net_amount_minor FROM fractal.distribution_entitlements WHERE declaration_request_id=$1 ORDER BY gross_amount_minor",[declaration.requestId]);expect(entitlements.rows).toEqual([{gross_amount_minor:"33",withholding_tax_minor:"3",net_amount_minor:"30"},{gross_amount_minor:"67",withholding_tax_minor:"6",net_amount_minor:"61"}]);
    expect((await postgresQuery<{direction:string;amount_minor:string}>("SELECT direction,amount_minor FROM fractal.journal_postings WHERE journal_id=$1 ORDER BY line_number",[approved.declarationJournalId])).rows).toEqual([{direction:"debit",amount_minor:"100"},{direction:"credit",amount_minor:"91"},{direction:"credit",amount_minor:"9"}]);
    expect(await listDistributionDeclarations(organizationId)).toContainEqual(expect.objectContaining({id:declaration.requestId,status:"approved",grossAmountMinor:"100",netAmountMinor:"91",payoutStatus:"not_instructed"}));
    expect(await listInvestorDistributionEntitlements(investorA)).toContainEqual(expect.objectContaining({reference:expect.stringMatching(/^DDR-/),payoutStatus:"not_instructed",declarationJournalId:approved.declarationJournalId}));
    await expect(postgresQuery("UPDATE fractal.distribution_entitlements SET gross_amount_minor=99 WHERE declaration_request_id=$1",[declaration.requestId])).rejects.toThrow(/immutable/);

    const policy=await createDistributionTaxPolicy({organizationId,jurisdictionCode:"NG",currency:"NGN",taxAuthorityName:"Federal Inland Revenue Service",taxAuthorityReference:"APPROVED-NG-WHT-REMITTANCE-POLICY",filingDueDays:21,paymentDueDays:21,effectiveFrom:new Date(Date.now()-1000),actorIdentityId:makerId});
    await expect(approveDistributionTaxPolicy({policyId:policy.policyId,actorIdentityId:makerId})).rejects.toThrow(/different person/);
    await approveDistributionTaxPolicy({policyId:policy.policyId,actorIdentityId:checkerId});
    const remittance=await submitDistributionTaxRemittance({organizationId,declarationRequestId:declaration.requestId,taxPeriodStart:new Date("2026-04-01T00:00:00.000Z"),taxPeriodEnd:new Date("2026-06-30T00:00:00.000Z"),filingReference:"FIRS-WHT-FILING-2026-Q2",filingEvidenceSha256:"9".repeat(64),actorIdentityId:makerId});
    await expect(decideDistributionTaxFiling({requestId:remittance.requestId,approve:true,decisionReason:"The filing maker cannot approve the same filing evidence and exact withholding liability.",actorIdentityId:makerId})).rejects.toThrow(/different person/);
    await decideDistributionTaxFiling({requestId:remittance.requestId,approve:true,decisionReason:"The declaration liability, tax period, filing evidence, authority policy, and deadlines independently reconcile.",actorIdentityId:checkerId});
    await submitDistributionTaxPaymentEvidence({requestId:remittance.requestId,paymentReference:"BANK-WHT-PAYMENT-2026-Q2",paymentEvidenceSha256:"a".repeat(64),actorIdentityId:makerId});
    await expect(decideDistributionTaxPayment({requestId:remittance.requestId,approve:true,decisionReason:"The payment submitter cannot confirm their own evidence as an authority-accepted remittance.",authorityReceiptReference:"FIRS-RECEIPT-2026-Q2",authorityReceiptSha256:"b".repeat(64),actorIdentityId:makerId})).rejects.toThrow(/different person/);
    const remitted=await decideDistributionTaxPayment({requestId:remittance.requestId,approve:true,decisionReason:"The bank evidence and tax-authority receipt independently prove the exact withholding liability was remitted.",authorityReceiptReference:"FIRS-RECEIPT-2026-Q2",authorityReceiptSha256:"b".repeat(64),actorIdentityId:checkerId});
    expect(remitted).toMatchObject({status:"remitted",remittanceJournalId:expect.any(String)});
    expect(await listInvestorDistributionTaxStatements(investorA)).toContainEqual(expect.objectContaining({distributionReference:expect.stringMatching(/^DDR-/),withholdingTaxMinor:"3",status:"active",authorityReceiptReference:"FIRS-RECEIPT-2026-Q2"}));
    expect((await postgresQuery<{count:number;tax:string}>("SELECT count(*)::integer AS count,sum(withholding_tax_minor)::text AS tax FROM fractal.investor_distribution_tax_statements WHERE remittance_request_id=$1",[remittance.requestId])).rows[0]).toEqual({count:2,tax:"9"});
    await expect(postgresQuery("UPDATE fractal.investor_distribution_tax_statements SET withholding_tax_minor=99 WHERE remittance_request_id=$1",[remittance.requestId])).rejects.toThrow(/immutable/);
    const reversal=await proposeDistributionTaxRemittanceReversal({requestId:remittance.requestId,reason:"The authority returned the payment, so the liability and every issued statement must be restored and revoked.",actorIdentityId:makerId});
    await expect(decideDistributionTaxRemittanceReversal({reversalRequestId:reversal.reversalRequestId,approve:true,actorIdentityId:makerId})).rejects.toThrow(/different person/);
    const reversedTax=await decideDistributionTaxRemittanceReversal({reversalRequestId:reversal.reversalRequestId,approve:true,actorIdentityId:checkerId});
    expect(reversedTax).toMatchObject({status:"executed",reversalJournalId:expect.any(String)});
    expect((await listInvestorDistributionTaxStatements(investorA))[0]).toMatchObject({status:"revoked",revokedAt:expect.any(String)});
    const taxActions=(await postgresQuery<{action:string}>("SELECT action FROM fractal.audit_events WHERE scope_key=$1 AND action LIKE 'distribution_tax%' ORDER BY sequence",[`organization:${organizationId}`])).rows.map(row=>row.action);
    expect(taxActions).toEqual(["distribution_tax_policy.proposed","distribution_tax_policy.approved","distribution_tax_remittance.submitted","distribution_tax_filing.approved","distribution_tax_payment_evidence.submitted","distribution_tax_remittance.confirmed","distribution_tax_remittance_reversal.proposed","distribution_tax_remittance_reversal.executed"]);
    const taxOutbox=(await postgresQuery<{event_type:string}>("SELECT event_type FROM fractal.outbox_events WHERE event_type LIKE 'distribution_tax%' ORDER BY occurred_at,id")).rows.map(row=>row.event_type);
    expect(taxOutbox).toEqual(taxActions);
    await expect(proposeLegalHoldChange({actorIdentityId:makerId,targetType:"distribution_declaration",targetId:randomUUID(),changeType:"impose",reasonCategory:"regulatory_request",reason:"A nonexistent distribution record must never accept a legal hold.",commandKey:randomUUID()})).rejects.toBeInstanceOf(SupportEvidenceLifecycleError);
    const declarationHold=await proposeLegalHoldChange({actorIdentityId:makerId,targetType:"distribution_declaration",targetId:declaration.requestId,changeType:"impose",reasonCategory:"regulatory_request",reason:"Preserve the complete distribution record chain for the regulator's formal evidence request.",commandKey:randomUUID()});
    await expect(decideLegalHoldChange({actorIdentityId:makerId,requestId:declarationHold.request.id,decision:"approve",decisionReason:"The proposer must not approve the same legal-hold change."})).rejects.toThrow(/proposer cannot decide/);
    await decideLegalHoldChange({actorIdentityId:checkerId,requestId:declarationHold.request.id,decision:"approve",decisionReason:"The declaration and every dependent investor record must remain preserved for regulatory review."});
    const taxHold=await proposeLegalHoldChange({actorIdentityId:makerId,targetType:"distribution_tax_remittance",targetId:remittance.requestId,changeType:"impose",reasonCategory:"audit",reason:"Preserve the remittance, authority evidence, and connected investor statements throughout the audit.",commandKey:randomUUID()});
    await decideLegalHoldChange({actorIdentityId:checkerId,requestId:taxHold.request.id,decision:"approve",decisionReason:"The approved audit scope requires preservation of the remittance record and all issued statements."});
    expect(await readDistributionLegalHoldLifecycle({actorIdentityId:checkerId,targetType:"distribution_declaration",targetId:declaration.requestId})).toMatchObject({targetType:"distribution_declaration",targetId:declaration.requestId,retentionPolicy:{reference:"DIST-LIFECYCLE-NG-TEST-1",recordClass:"distribution_declaration",retentionDays:2555,retainUntil:expect.any(String)},activeHolds:[{reference:expect.stringMatching(/^HLDA-/),targetType:"distribution_declaration"}],pendingChanges:[]});
    const lifecycleBindings=await postgresQuery<{target_type:string;record_class:string;retention_days:number;policy_reference:string}>("SELECT target_type,record_class,retention_days,policy_reference FROM fractal.distribution_lifecycle_policy_bindings ORDER BY target_type");
    expect(lifecycleBindings.rows).toEqual([
      {target_type:"distribution_declaration",record_class:"distribution_declaration",retention_days:2555,policy_reference:"DIST-LIFECYCLE-NG-TEST-1"},
      {target_type:"distribution_tax_remittance",record_class:"tax_remittance",retention_days:3650,policy_reference:"DIST-LIFECYCLE-NG-TEST-1"},
      {target_type:"ownership_snapshot",record_class:"ownership_snapshot",retention_days:2555,policy_reference:"DIST-LIFECYCLE-NG-TEST-1"},
    ]);
    await expect(postgresQuery("UPDATE fractal.distribution_lifecycle_policy_bindings SET retention_days=1 WHERE target_type='distribution_declaration' AND target_id=$1",[declaration.requestId])).rejects.toThrow(/immutable/);
    const investorASections=await collectPrivacy(investorA),investorBSections=await collectPrivacy(investorB),makerSections=await collectPrivacy(makerId);
    const aHolding=investorASections.get("postgres.fractal.ownership_snapshot_holdings")!.canonicalContent;
    const bHolding=investorBSections.get("postgres.fractal.ownership_snapshot_holdings")!.canonicalContent;
    expect(aHolding).toContain(walletA);expect(aHolding).not.toContain(walletB);expect(bHolding).toContain(walletB);expect(bHolding).not.toContain(walletA);
    const aEntitlement=investorASections.get("postgres.fractal.distribution_entitlements")!.canonicalContent;
    const bEntitlement=investorBSections.get("postgres.fractal.distribution_entitlements")!.canonicalContent;
    expect(aEntitlement).toContain('"grossAmountMinor":"33"');expect(aEntitlement).not.toContain('"grossAmountMinor":"67"');
    expect(bEntitlement).toContain('"grossAmountMinor":"67"');expect(bEntitlement).not.toContain('"grossAmountMinor":"33"');
    const aStatement=investorASections.get("postgres.fractal.investor_distribution_tax_statements")!.canonicalContent;
    const bStatement=investorBSections.get("postgres.fractal.investor_distribution_tax_statements")!.canonicalContent;
    expect(aStatement).toContain('"withholdingTaxMinor":"3"');expect(aStatement).not.toContain('"withholdingTaxMinor":"6"');
    expect(bStatement).toContain('"withholdingTaxMinor":"6"');expect(bStatement).not.toContain('"withholdingTaxMinor":"3"');
    expect(investorASections.get("postgres.fractal.distribution_tax_remittance_policies")!.records).toHaveLength(0);
    expect(makerSections.get("postgres.fractal.distribution_tax_remittance_policies")!.canonicalContent).toContain('"participationRole":"preparer"');
    for(const sections of [investorASections,investorBSections]){
      const holdChanges=sections.get("postgres.fractal.data_legal_hold_change_requests")!.canonicalContent;
      const activeHolds=sections.get("postgres.fractal.data_legal_holds")!.canonicalContent;
      expect(holdChanges).toContain('"targetType":"distribution_declaration"');expect(holdChanges).toContain('"targetType":"distribution_tax_remittance"');
      expect(activeHolds).toContain('"targetType":"distribution_declaration"');expect(activeHolds).toContain('"targetType":"distribution_tax_remittance"');
    }
    expect(makerSections.get("postgres.fractal.data_legal_holds")!.records).toHaveLength(0);
    for(const sections of [investorASections,investorBSections]){const bindings=sections.get("postgres.fractal.distribution_lifecycle_policy_bindings")!.canonicalContent;expect(bindings).toContain('"targetType":"ownership_snapshot"');expect(bindings).toContain('"targetType":"distribution_declaration"');expect(bindings).toContain('"targetType":"distribution_tax_remittance"');expect(bindings).toContain('"retentionDays":3650');}
    expect(makerSections.get("postgres.fractal.distribution_lifecycle_policy_bindings")!.records).toHaveLength(0);

    const erasure=await createPrivacyRightsRequest({actorIdentityId:investorA,requestType:"erasure",details:"Assess erasure of my personal data in the approved distribution declaration record.",commandKey:randomUUID()});
    expect(erasure.request.policy).toMatchObject({reference:"PRIV-DIST-NG-TEST-1",responseCalendarDays:30});
    await transitionAdministratorPrivacyRightsRequest({actorIdentityId:makerId,requestId:erasure.request.id,action:"begin_review",message:"Review the exact declaration anchor, financial retention rule, and active legal hold.",expectedVersion:1});
    const privacyDecision=await proposePrivacyRightsDecision({actorIdentityId:makerId,requestId:erasure.request.id,outcome:"refuse",decisionSummary:"The declaration cannot be erased while approved financial retention and an active audit hold apply.",lawfulBasis:"The approved financial-record retention memorandum and active audit hold require preservation until lawful review.",scopeOutcomes:[{category:"distribution declaration record",action:"retain",explanation:"Retain the immutable declaration anchor until the policy deadline and review again after every hold is released."}],commandKey:randomUUID()});
    await decidePrivacyRightsDecision({actorIdentityId:checkerId,decisionRequestId:privacyDecision.decision.id,decision:"approve",reviewReason:"The exact subject link, active hold, retention deadline, and refusal basis were independently verified."});
    const treatment=await proposeDistributionPrivacyTreatment({actorIdentityId:makerId,privacyRequestId:erasure.request.id,targetType:"distribution_declaration",targetId:declaration.requestId,decisionScopeCategory:"distribution declaration record",treatmentStatement:"Record the lawful retention outcome without deleting or rewriting the immutable declaration and entitlement history.",commandKey:randomUUID()});
    expect((await getOwnPrivacyRightsRequest({actorIdentityId:investorA,requestId:erasure.request.id})).distributionTreatments).toEqual([]);
    const pendingTreatmentSections=await collectPrivacy(investorA);
    expect(pendingTreatmentSections.get("postgres.fractal.distribution_privacy_treatment_requests")!.records).toHaveLength(0);
    expect(pendingTreatmentSections.get("postgres.fractal.distribution_privacy_treatment_executions")!.records).toHaveLength(0);
    await expect(decideDistributionPrivacyTreatment({actorIdentityId:makerId,treatmentRequestId:treatment.treatment.id,decision:"approve",reviewReason:"A proposer cannot approve the same treatment authority and execution.",requesterVisibleSummary:"The declaration remains retained under the approved policy and active audit hold."})).rejects.toThrow(/proposer/);
    const privateReviewReason="The applied privacy decision, exact lifecycle binding, subject link, active hold, and lawful basis independently reconcile.";
    const requesterVisibleSummary="The declaration remains retained until the approved policy deadline and any active legal hold is released.";
    const treatmentDecision=await decideDistributionPrivacyTreatment({actorIdentityId:checkerId,treatmentRequestId:treatment.treatment.id,decision:"approve",reviewReason:privateReviewReason,requesterVisibleSummary});
    expect(treatmentDecision.treatment).toMatchObject({status:"approved",targetType:"distribution_declaration",treatmentType:"erasure",policyTreatmentMode:"retain_then_review_for_minimization_or_disposition",execution:{result:"lawful_retention_confirmed",legalHoldActive:true}});
    expect((await getOwnPrivacyRightsRequest({actorIdentityId:investorA,requestId:erasure.request.id})).distributionTreatments).toContainEqual(expect.objectContaining({reference:expect.stringMatching(/^DPT-/),requesterVisibleSummary:expect.stringContaining("retained until"),execution:expect.objectContaining({result:"lawful_retention_confirmed"})}));
    const approvedTreatmentSections=await collectPrivacy(investorA);
    const treatmentRequestContent=approvedTreatmentSections.get("postgres.fractal.distribution_privacy_treatment_requests")!.canonicalContent;
    const treatmentExecutionContent=approvedTreatmentSections.get("postgres.fractal.distribution_privacy_treatment_executions")!.canonicalContent;
    expect(treatmentRequestContent).toContain(treatment.treatment.reference);
    expect(treatmentRequestContent).toContain(requesterVisibleSummary);
    expect(treatmentRequestContent).not.toContain(privateReviewReason);
    expect(treatmentRequestContent).not.toContain(declaration.requestId);
    expect(treatmentExecutionContent).toContain('"executionResult":"lawful_retention_confirmed"');
    expect(treatmentExecutionContent).toContain('"legalHoldActive":true');
    expect(treatmentExecutionContent).not.toContain(checkerId);
    for(const identity of [investorB,makerId]){
      const unrelatedSections=await collectPrivacy(identity);
      expect(unrelatedSections.get("postgres.fractal.distribution_privacy_treatment_requests")!.records).toHaveLength(0);
      expect(unrelatedSections.get("postgres.fractal.distribution_privacy_treatment_executions")!.records).toHaveLength(0);
    }
    expect(await readDistributionLegalHoldLifecycle({actorIdentityId:checkerId,targetType:"distribution_declaration",targetId:declaration.requestId})).toMatchObject({privacyTreatments:[{reference:treatment.treatment.reference,treatmentType:"erasure",executionResult:"lawful_retention_confirmed",legalHoldActive:true}]});
    await expect(postgresQuery("UPDATE fractal.distribution_privacy_treatment_executions SET legal_hold_active=false WHERE treatment_request_id=$1",[treatment.treatment.id])).rejects.toThrow(/immutable/);
  });

  it("fails closed on unreconciled supply and insufficient record-date confirmations",async()=>{
    await expect(submitOwnershipSnapshot({...snapshotCommand(),totalSupplyUnits:"4"})).rejects.toThrow(/reconcile/);
    const snapshot=await submitOwnershipSnapshot(snapshotCommand(5));await decideOwnershipSnapshot({requestId:snapshot.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The archive evidence reconciles while its confirmation count remains an explicit fact."});
    await expect(submitDistributionDeclaration({organizationId,offeringId,ownershipSnapshotRequestId:snapshot.requestId,periodLabel:"2026 Q2",currency:"NGN",grossAmountMinor:"100",withholdingTaxBps:1000,paymentDueAt:new Date(Date.now()+86_400_000),actorIdentityId:makerId,commandKey:randomUUID()})).rejects.toThrow(/fewer confirmations/);
  });

  it("separates verified destinations, funding approval, dispatch uncertainty, settlement, failure, and reversal",async()=>{
    const snapshot=await submitOwnershipSnapshot(snapshotCommand());
    await decideOwnershipSnapshot({requestId:snapshot.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The exact block, source manifest, linked holders, balances, and supply independently reconcile."});
    const declaration=await submitDistributionDeclaration({organizationId,offeringId,ownershipSnapshotRequestId:snapshot.requestId,periodLabel:"2026 Q2 payout lifecycle",currency:"NGN",grossAmountMinor:"100",withholdingTaxBps:1000,paymentDueAt:new Date(Date.now()+86_400_000),actorIdentityId:makerId,commandKey:randomUUID()});
    await decideDistributionDeclaration({requestId:declaration.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The exact entitlement calculation, withholding, policy limit, and declaration journal independently reconcile."});

    const profile = async(identityId:string,accountNumber:string,recipientCode:string)=>verifyInvestorDistributionPayoutProfile({investorIdentityId:identityId,bankCode:"058",accountNumber,resolve:async()=>({account_number:accountNumber,account_name:`Holder ${accountNumber.slice(-1)}`}),createRecipient:async()=>({recipient_code:recipientCode})});
    await profile(investorA,"0123456789",`RCP_${randomUUID()}`);
    const fundingCommand={organizationId,declarationRequestId:declaration.requestId,fundingEvidenceReference:"PAYSTACK-BALANCE-ATTESTATION-2026-Q2",fundingEvidenceSha256:"f".repeat(64),actorIdentityId:makerId,commandKey:randomUUID(),readBalance:async()=>1000};
    const funding=await submitDistributionFundingRequest(fundingCommand);
    expect(await submitDistributionFundingRequest({...fundingCommand,readBalance:async()=>{throw new Error("replay must not call provider");}})).toMatchObject({requestId:funding.requestId,replayed:true});
    await expect(decideDistributionFundingRequest({requestId:funding.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"Funding is visible but one entitled investor is still missing a verified destination.",readBalance:async()=>1000})).rejects.toThrow(/Every entitled investor/);
    await profile(investorB,"9876543210",`RCP_${randomUUID()}`);
    await expect(decideDistributionFundingRequest({requestId:funding.requestId,actorIdentityId:makerId,decision:"approve",decisionReason:"The submitter must not be able to authorize outbound distribution payouts.",readBalance:async()=>1000})).rejects.toBeInstanceOf(DistributionPayoutError);
    const approved=await decideDistributionFundingRequest({requestId:funding.requestId,actorIdentityId:checkerId,decision:"approve",decisionReason:"The live provider balance, evidence, current verified destinations, and exact net liability independently reconcile.",readBalance:async()=>1000});
    expect(approved).toMatchObject({status:"approved",instructionCount:2});
    const instructions=await postgresQuery<{id:string;reference:string;investor_identity_id:string;amount_minor:string;status:string}>("SELECT id,reference,investor_identity_id,amount_minor,status FROM fractal.distribution_payout_instructions ORDER BY amount_minor");
    expect(instructions.rows.map(row=>({amount:row.amount_minor,status:row.status}))).toEqual([{amount:"30",status:"authorized"},{amount:"61",status:"authorized"}]);
    await expect(postgresQuery("UPDATE fractal.distribution_payout_instructions SET amount_minor=999 WHERE id=$1",[instructions.rows[0]!.id])).rejects.toThrow(/immutable/);

    const transfers=new Map<string,string>();
    const initiate=async(input:{recipientCode:string;amountKobo:number;reference:string;reason:string})=>{const code=`TRF_${randomUUID()}`;transfers.set(input.reference,code);return{transfer_code:code,status:"pending"};};
    expect(await dispatchOneDistributionPayout("worker-a",initiate)).toBe(true);
    expect(await dispatchOneDistributionPayout("worker-a",initiate)).toBe(true);
    const submitted=await postgresQuery<{reference:string;amount_minor:string;status:string}>("SELECT reference,amount_minor,status FROM fractal.distribution_payout_instructions ORDER BY amount_minor");
    expect(submitted.rows.every(row=>row.status==="submitted")).toBe(true);
    const first=submitted.rows[0]!,second=submitted.rows[1]!;
    const confirmed=await recordDistributionPayoutProviderOutcome({reference:first.reference,outcome:"success",transferCode:transfers.get(first.reference)!,amountMinor:Number(first.amount_minor),currency:"NGN",source:"verification"});
    expect(confirmed).toMatchObject({handled:true,status:"confirmed"});
    await expect(recordDistributionPayoutProviderOutcome({reference:second.reference,outcome:"success",transferCode:transfers.get(second.reference)!,amountMinor:Number(second.amount_minor)+1,currency:"NGN",source:"verification"})).rejects.toThrow(/amount or currency/);
    await recordDistributionPayoutProviderOutcome({reference:second.reference,outcome:"failed",transferCode:transfers.get(second.reference)!,amountMinor:Number(second.amount_minor),currency:"NGN",source:"verification",reason:"Provider rejected the destination after dispatch"});
    const statements=await listInvestorDistributionEntitlements(investorA);expect(statements[0]).toMatchObject({payoutStatus:"confirmed",settlementJournalId:expect.any(String)});
    const settlement=await postgresQuery<{direction:string;amount_minor:string}>("SELECT posting.direction,posting.amount_minor FROM fractal.distribution_payout_instructions payout JOIN fractal.journal_postings posting ON posting.journal_id=payout.settlement_journal_id WHERE payout.reference=$1 ORDER BY posting.line_number",[first.reference]);
    expect(settlement.rows).toEqual([{direction:"debit",amount_minor:first.amount_minor},{direction:"credit",amount_minor:first.amount_minor}]);
    const reversed=await recordDistributionPayoutProviderOutcome({reference:first.reference,outcome:"reversed",transferCode:transfers.get(first.reference)!,amountMinor:Number(first.amount_minor),currency:"NGN",source:"webhook",reason:"Provider reversed the previously confirmed transfer"});
    expect(reversed).toMatchObject({status:"reversed"});
    expect((await postgresQuery<{status:string;reversal_journal_id:string}>("SELECT status,reversal_journal_id FROM fractal.distribution_payout_instructions WHERE reference=$1",[first.reference])).rows[0]).toMatchObject({status:"reversed",reversal_journal_id:expect.any(String)});

    const failedInstruction=(await postgresQuery<{id:string}>("SELECT id FROM fractal.distribution_payout_instructions WHERE reference=$1",[second.reference])).rows[0]!;
    const failedCase=await openDistributionPayoutException({payoutInstructionId:failedInstruction.id,actorIdentityId:makerId});
    await addDistributionPayoutExceptionEvidence({exceptionCaseId:failedCase.exceptionCaseId,evidenceType:"provider_verification",contentSha256:"7".repeat(64),storageKey:`distribution-exceptions/${failedCase.exceptionCaseId}/provider.json`,filename:"provider-failure.json",mimeType:"application/json",actorIdentityId:makerId});
    await proposeDistributionPayoutExceptionResolution({exceptionCaseId:failedCase.exceptionCaseId,resolutionType:"replacement_payout",resolutionReason:"The provider confirmed terminal failure and the exact unpaid investor liability remains outstanding.",actorIdentityId:makerId});
    await decideDistributionPayoutExceptionResolution({exceptionCaseId:failedCase.exceptionCaseId,approve:true,actorIdentityId:checkerId});
    await expect(executeDistributionPayoutException({exceptionCaseId:failedCase.exceptionCaseId,actorIdentityId:checkerId})).rejects.toThrow(/No active approval policy/);
    const policy=await createDistributionPayoutExceptionPolicy({organizationId,resolutionType:"replacement_payout",currency:"NGN",maximumAmountMinor:100,effectiveFrom:new Date(Date.now()-1000),policyReference:"DIST-REPLACEMENT-TEST-AUTHORITY",actorIdentityId:makerId});
    await expect(approveDistributionPayoutExceptionPolicy({policyId:policy.policyId,actorIdentityId:makerId})).rejects.toThrow(/different person/);
    await approveDistributionPayoutExceptionPolicy({policyId:policy.policyId,actorIdentityId:checkerId});
    const replacement=await executeDistributionPayoutException({exceptionCaseId:failedCase.exceptionCaseId,actorIdentityId:checkerId});
    expect(replacement).toMatchObject({resolutionType:"replacement_payout",replacementPayoutInstructionId:expect.any(String),correctionJournalId:null});
    expect((await postgresQuery<{instruction_kind:string;status:string;replaces_instruction_id:string}>("SELECT instruction_kind,status,replaces_instruction_id FROM fractal.distribution_payout_instructions WHERE id=$1",[replacement.replacementPayoutInstructionId])).rows[0]).toEqual({instruction_kind:"replacement",status:"authorized",replaces_instruction_id:failedInstruction.id});
    expect((await listInvestorDistributionEntitlements(investorB))).toHaveLength(1);

    const reversedInstruction=(await postgresQuery<{id:string}>("SELECT id FROM fractal.distribution_payout_instructions WHERE reference=$1",[first.reference])).rows[0]!;
    const heldCase=await openDistributionPayoutException({payoutInstructionId:reversedInstruction.id,actorIdentityId:makerId});
    const lifecycleHold=await proposeLegalHoldChange({actorIdentityId:makerId,targetType:"distribution_payout_exception",targetId:heldCase.exceptionCaseId,changeType:"impose",reasonCategory:"investigation",reason:"Preserve the exception case and connected payout evidence throughout the active fraud investigation.",commandKey:randomUUID()});
    await decideLegalHoldChange({actorIdentityId:checkerId,requestId:lifecycleHold.request.id,decision:"approve",decisionReason:"The fraud investigation requires an independently authorized preservation hold over this record chain."});
    const hold=await proposeDistributionPayoutExceptionHold({exceptionCaseId:heldCase.exceptionCaseId,action:"place",reason:"Fraud review must stop every corrective execution until an independent release decision.",actorIdentityId:makerId});
    await decideDistributionPayoutExceptionHold({holdRequestId:hold.holdRequestId,approve:true,actorIdentityId:checkerId});
    await addDistributionPayoutExceptionEvidence({exceptionCaseId:heldCase.exceptionCaseId,evidenceType:"fraud_review",contentSha256:"8".repeat(64),storageKey:`distribution-exceptions/${heldCase.exceptionCaseId}/fraud.json`,filename:"fraud-review.json",mimeType:"application/json",actorIdentityId:makerId});
    await proposeDistributionPayoutExceptionResolution({exceptionCaseId:heldCase.exceptionCaseId,resolutionType:"replacement_payout",resolutionReason:"The reversal is terminal, but the independently approved fraud hold must continue to block execution.",actorIdentityId:makerId});
    await decideDistributionPayoutExceptionResolution({exceptionCaseId:heldCase.exceptionCaseId,approve:true,actorIdentityId:checkerId});
    await expect(executeDistributionPayoutException({exceptionCaseId:heldCase.exceptionCaseId,actorIdentityId:checkerId})).rejects.toThrow(/approved, unheld/);
    const investorASections=await collectPrivacy(investorA),investorBSections=await collectPrivacy(investorB),makerSections=await collectPrivacy(makerId);
    const aProfiles=investorASections.get("postgres.fractal.investor_distribution_payout_profiles")!.canonicalContent;
    const bProfiles=investorBSections.get("postgres.fractal.investor_distribution_payout_profiles")!.canonicalContent;
    expect(aProfiles).toContain('"accountLast4":"6789"');expect(aProfiles).not.toContain('"accountLast4":"3210"');
    expect(bProfiles).toContain('"accountLast4":"3210"');expect(bProfiles).not.toContain('"accountLast4":"6789"');
    const aPayouts=investorASections.get("postgres.fractal.distribution_payout_instructions")!.canonicalContent;
    const bPayouts=investorBSections.get("postgres.fractal.distribution_payout_instructions")!.canonicalContent;
    expect(aPayouts).toContain('"amountMinor":"30"');expect(aPayouts).not.toContain('"amountMinor":"61"');
    expect(bPayouts).toContain('"amountMinor":"61"');expect(bPayouts).not.toContain('"amountMinor":"30"');
    const aEvidence=investorASections.get("postgres.fractal.distribution_payout_exception_evidence")!.canonicalContent;
    const bEvidence=investorBSections.get("postgres.fractal.distribution_payout_exception_evidence")!.canonicalContent;
    expect(aEvidence).toContain("fraud-review.json");expect(aEvidence).not.toContain("provider-failure.json");
    expect(bEvidence).toContain("provider-failure.json");expect(bEvidence).not.toContain("fraud-review.json");
    expect(investorASections.get("postgres.fractal.distribution_payout_exception_policies")!.records).toHaveLength(0);
    expect(makerSections.get("postgres.fractal.distribution_payout_exception_policies")!.canonicalContent).toContain('"participationRole":"preparer"');
    expect(investorASections.get("postgres.fractal.data_legal_holds")!.canonicalContent).toContain('"targetType":"distribution_payout_exception"');
    expect(investorBSections.get("postgres.fractal.data_legal_holds")!.canonicalContent).not.toContain('"targetType":"distribution_payout_exception"');
    for(const sections of [investorASections,investorBSections]){const bindings=sections.get("postgres.fractal.distribution_lifecycle_policy_bindings")!;expect(bindings.records).toHaveLength(3);expect(bindings.canonicalContent.match(/"targetType":"distribution_payout_exception"/g)).toHaveLength(1);}
  });
});
