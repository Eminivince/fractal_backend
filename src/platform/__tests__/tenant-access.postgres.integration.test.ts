import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import { listAccessibleOrganizations, requireOrganizationAccess, TenantAccessError } from "../tenant-access.js";
import { getIssuerOverview } from "../postgres-issuer-overview.js";
import { createAssetApplicationReviewItem, recordAssetApplicationEvidence, submitAssetApplicationRequest } from "../postgres-asset-applications.js";
import {
  addOrganizationDocumentVersion,
  archiveOrganizationDocument,
  createOrganizationDocument,
  listOrganizationDocumentAccessEvents,
  listOrganizationDocuments,
  recordOrganizationDocumentDownload,
} from "../postgres-organization-documents.js";
import { activateDuePlatformConfigurationVersions, decidePlatformConfigurationVersion, proposePlatformConfigurationVersion } from "../postgres-platform-configuration.js";
import { decideLegalHoldChange, proposeLegalHoldChange } from "../postgres-support-evidence-lifecycle.js";
import { decideOrganizationDocumentDisposition, proposeOrganizationDocumentDisposition, readOrganizationDocumentLifecycle } from "../postgres-organization-document-lifecycle.js";
import { dispatchPendingStorageCleanupTasks } from "../../services/postgres-storage-cleanup-worker.js";
import { collectCanonicalPrivacySourceSections } from "../postgres-privacy-package-preparations.js";
import {
  parsePrivacyContentProfile,
  privacyContentProfileSourceKeysForRight,
  privacySafeFieldCatalog,
  type PrivacyContentFieldCatalogVersion,
} from "../../modules/privacy/domain/privacy-content-profile.js";

function currentPrivacyProfile() {
  const fieldCatalogVersion: PrivacyContentFieldCatalogVersion = "privacy-safe-fields-v45";
  const rules = (right: "access" | "portability") => privacyContentProfileSourceKeysForRight(fieldCatalogVersion, right).map((sourceKey) => ({
    sourceKey,
    includedFields: [...privacySafeFieldCatalog[sourceKey]],
    excludedFields: [],
  }));
  return parsePrivacyContentProfile({
    profileReference: "PRIV-ORG-DOC-TEST-1",
    profileName: "Organization document privacy collector test profile",
    schemaVersion: "privacy-content-profile-v1",
    fieldCatalogVersion,
    jurisdictionCode: "NG",
    legalBasisReference: "Authenticated data subject access test authority",
    effectiveScope: "authenticated_data_subject_access_and_portability",
    access: { sourceRules: rules("access") },
    portability: { sourceRules: rules("portability") },
  });
}

async function createIdentity(email: string) {
  const id = randomUUID();
  await postgresQuery(
    `INSERT INTO fractal.identities (id, email, legal_name, status)
     VALUES ($1, $2, $3, 'active')`,
    [id, email, "Tenant test identity"],
  );
  return id;
}

async function createOrganization(legalName: string) {
  const id = randomUUID();
  await postgresQuery(
    `INSERT INTO fractal.organizations (id, legal_name, status, jurisdiction_code)
     VALUES ($1, $2, 'active', 'NG')`,
    [id, legalName],
  );
  return id;
}

describe("PostgreSQL organization access", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("allows only an active membership in the requested tenant", async () => {
    const member = await createIdentity(`member-${randomUUID()}@example.test`);
    const outsider = await createIdentity(`outsider-${randomUUID()}@example.test`);
    const organization = await createOrganization(`Meridian ${randomUUID()}`);
    await postgresQuery(
      `INSERT INTO fractal.organization_memberships (id, organization_id, identity_id, role, status)
       VALUES ($1, $2, $3, 'offering_manager', 'active')`,
      [randomUUID(), organization, member],
    );

    await expect(requireOrganizationAccess({ identityId: member, organizationId: organization, allowedRoles: ["offering_manager"] }))
      .resolves.toEqual({ role: "offering_manager" });
    await expect(requireOrganizationAccess({ identityId: outsider, organizationId: organization }))
      .rejects.toBeInstanceOf(TenantAccessError);
  });

  it("does not let a membership in one organization reach another", async () => {
    const member = await createIdentity(`isolation-${randomUUID()}@example.test`);
    const permitted = await createOrganization(`Permitted ${randomUUID()}`);
    const denied = await createOrganization(`Denied ${randomUUID()}`);
    await postgresQuery(
      `INSERT INTO fractal.organization_memberships (id, organization_id, identity_id, role, status)
       VALUES ($1, $2, $3, 'viewer', 'active')`,
      [randomUUID(), permitted, member],
    );

    await expect(requireOrganizationAccess({ identityId: member, organizationId: denied }))
      .rejects.toThrow("Access denied to organization");
    await expect(listAccessibleOrganizations(member)).resolves.toEqual([
      { id: permitted, legalName: expect.stringMatching(/^Permitted /), role: "viewer" },
    ]);
  });

  it("lists only active memberships in active organizations", async () => {
    const member = await createIdentity(`directory-${randomUUID()}@example.test`);
    const active = await createOrganization(`Active ${randomUUID()}`);
    const suspended = await createOrganization(`Suspended ${randomUUID()}`);
    await postgresQuery("UPDATE fractal.organizations SET status = 'suspended' WHERE id = $1", [suspended]);
    await postgresQuery(
      `INSERT INTO fractal.organization_memberships (id, organization_id, identity_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active'), ($4, $5, $3, 'viewer', 'active')`,
      [randomUUID(), active, member, randomUUID(), suspended],
    );

    await expect(listAccessibleOrganizations(member)).resolves.toEqual([
      { id: active, legalName: expect.stringMatching(/^Active /), role: "owner" },
    ]);
  });

  it("derives issuer overview metrics only from the caller's active tenants", async () => {
    const member = await createIdentity(`overview-member-${randomUUID()}@example.test`);
    const reviewer = await createIdentity(`overview-reviewer-${randomUUID()}@example.test`);
    const outsider = await createIdentity(`overview-outsider-${randomUUID()}@example.test`);
    const organization = await createOrganization(`Overview ${randomUUID()}`);
    const hiddenOrganization = await createOrganization(`Hidden overview ${randomUUID()}`);
    await postgresQuery(
      `INSERT INTO fractal.organization_memberships (id,organization_id,identity_id,role,status)
       VALUES ($1,$2,$3,'owner','active'),($4,$2,$5,'compliance_reviewer','active'),
              ($6,$7,$8,'owner','active')`,
      [randomUUID(), organization, member, randomUUID(), reviewer, randomUUID(), hiddenOrganization, outsider],
    );
    await postgresQuery(
      `UPDATE fractal.organizations
          SET verification_status='verified',verification_version=1,verified_at=now(),
              verified_by_identity_id=$2,verification_updated_at=now(),verification_expires_at=now()+interval '1 year'
        WHERE id=$1`,
      [organization, reviewer],
    );
    await postgresQuery(
      `INSERT INTO fractal.organization_invitations
        (id,organization_id,email,role,invited_by_identity_id,expires_at)
       VALUES ($1,$2,$3,'viewer',$4,now()+interval '1 day')`,
      [randomUUID(), organization, `pending-${randomUUID()}@example.test`, member],
    );
    const evidence = await recordAssetApplicationEvidence({
      organizationId: organization, uploadedByIdentityId: member, filename: "overview-dossier.pdf",
      mimeType: "application/pdf", storageKey: `local://overview/${randomUUID()}.pdf`,
      contentSha256: "a".repeat(64), bytes: 128,
    });
    const application = await submitAssetApplicationRequest({
      organizationId: organization, submittedByIdentityId: member,
      applicationReference: `OVERVIEW-${randomUUID()}`, applicationVersion: 1,
      assetName: "Overview governed asset", assetType: "infrastructure", countryCode: "NG",
      state: "Lagos", city: "Lagos",
      summary: "A governed application used to verify exact issuer overview aggregation.",
      requestedCapacityMinor: 500_000, currency: "NGN",
      dossierEvidenceDocumentId: evidence.evidenceDocumentId,
    });
    await createAssetApplicationReviewItem({
      organizationId: organization, applicationRequestId: application.requestId,
      openedByIdentityId: reviewer, category: "financial", title: "Updated accounts",
      requestMessage: "Provide the current independently reviewed financial statements.", required: true,
    });

    await expect(getIssuerOverview(member)).resolves.toMatchObject({
      summary: { organizationCount: 1, actionRequiredCount: 1, submittedApplications: 1, publishedOfferings: 0 },
      organizations: [{
        id: organization, legalName: expect.stringMatching(/^Overview /), role: "owner",
        verification: { status: "verified", expiresAt: expect.any(String) },
        team: { activeMembers: 2, pendingInvitations: 1 },
        applications: { submitted: 1, approved: 0, rejected: 0, unresolvedDiligenceItems: 1 },
        offerings: { pendingPublicationRequests: 0, published: 0, paused: 0, closed: 0 },
        actionRequiredCount: 1,
      }],
    });
    expect(JSON.stringify(await getIssuerOverview(member))).not.toContain(hiddenOrganization);
    await postgresQuery(
      `UPDATE fractal.organizations
          SET verified_at=now()-interval '2 days',verification_expires_at=now()-interval '1 day'
        WHERE id=$1`,
      [organization],
    );
    await expect(getIssuerOverview(member)).resolves.toMatchObject({
      summary: { actionRequiredCount: 2 },
      organizations: [{ id: organization, verification: { status: "expired" }, actionRequiredCount: 2 }],
    });
    await expect(getIssuerOverview(outsider)).resolves.toMatchObject({
      summary: { organizationCount: 1 },
      organizations: [{ id: hiddenOrganization }],
    });
  });

  it("governs organization documents as immutable tenant-scoped evidence", async () => {
    const owner = await createIdentity(`document-owner-${randomUUID()}@example.test`);
    const reader = await createIdentity(`document-reader-${randomUUID()}@example.test`);
    const outsider = await createIdentity(`document-outsider-${randomUUID()}@example.test`);
    const organization = await createOrganization(`Document authority ${randomUUID()}`);
    const policyReviewer = await createIdentity(`document-policy-reviewer-${randomUUID()}@example.test`);
    await postgresQuery(`INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type) VALUES($1,$2,'admin','global'),($3,$4,'admin','global')`,[randomUUID(),owner,randomUUID(),policyReviewer]);
    await postgresQuery(`INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key) VALUES($1,$2,'platform_configuration_manage'),($3,$4,'platform_configuration_manage')`,[randomUUID(),owner,randomUUID(),policyReviewer]);
    const bases=["legal_requirement","contractual_record","corporate_record","operational_record"];
    const categories=["corporate","finance","operations","compliance","governance","other"];
    const rules=Object.fromEntries(categories.map(category=>[category,Object.fromEntries(bases.map(basis=>[basis,{retentionDays:365}]))]));
    const policy=await proposePlatformConfigurationVersion({actorIdentityId:owner,configurationKey:"organization.document.retention_policy",proposedValue:{policyReference:"ORG-DOC-RETENTION-TEST-1",policyName:"Approved organization document test retention policy",schemaVersion:"organization-document-retention-v1",jurisdictions:{NG:{legalBasisReference:"Test corporate records retention authority for Nigeria",rules}}},expectedProjectionVersion:null,effectiveAt:new Date(Date.now()-1000),reason:"Bind test organization documents to exact approved retention rules.",commandKey:randomUUID()});
    await decidePlatformConfigurationVersion({actorIdentityId:policyReviewer,versionId:policy.version.id,action:"approve",expectedStateVersion:1,decisionReason:"Independently approve the complete jurisdiction, category, basis, and retention matrix.",commandKey:randomUUID()});
    await activateDuePlatformConfigurationVersions(new Date());
    await postgresQuery(
      `INSERT INTO fractal.organization_memberships (id,organization_id,identity_id,role,status)
       VALUES ($1,$2,$3,'owner','active'),($4,$2,$5,'viewer','active')`,
      [randomUUID(), organization, owner, randomUUID(), reader],
    );

    await expect(requireOrganizationAccess({ identityId: outsider, organizationId: organization }))
      .rejects.toBeInstanceOf(TenantAccessError);
    await expect(requireOrganizationAccess({ identityId: reader, organizationId: organization, allowedRoles: ["viewer"] }))
      .resolves.toEqual({ role: "viewer" });

    const created = await createOrganizationDocument({
      organizationId: organization,
      actorIdentityId: owner,
      title: "Board-approved operating policy",
      category: "governance",
      reference: "GOV-001",
      retentionBasis: "corporate_record",
      filename: "operating-policy-v1.pdf",
      mimeType: "application/pdf",
      storageKey: `local://organization-documents/${organization}/${randomUUID()}.pdf`,
      contentSha256: "a".repeat(64),
      bytes: 512,
    });
    await expect(listOrganizationDocuments(organization)).resolves.toMatchObject([{
      id: created.documentId,
      organizationId: organization,
      status: "active",
      currentVersionNumber: 1,
      retention: { bindingStatus: "governed", days: 365, policy: { versionId: policy.version.id } },
      versions: [{ id: created.versionId, versionNumber: 1, contentSha256: "a".repeat(64), downloadCount: 0 }],
    }]);

    const governedDocument=(await listOrganizationDocuments(organization))[0]!;
    const retainUntil=governedDocument.retainUntil;
    await expect(postgresQuery(
      `INSERT INTO fractal.organization_document_versions
        (id,document_id,organization_id,version_number,filename,mime_type,storage_key,content_sha256,bytes,retain_until,uploaded_by_identity_id,created_at)
       VALUES ($1,$2,$3,2,'orphan-version.pdf','application/pdf',$4,$5,256,$6,$7,$8)`,
      [randomUUID(), created.documentId, organization, `local://organization-documents/${organization}/${randomUUID()}.pdf`, "f".repeat(64), new Date(retainUntil), owner, new Date(governedDocument.createdAt)],
    )).rejects.toThrow("requires exact projection and event evidence");

    const second = await addOrganizationDocumentVersion({
      documentId: created.documentId,
      organizationId: organization,
      actorIdentityId: owner,
      filename: "operating-policy-v2.pdf",
      mimeType: "application/pdf",
      storageKey: `local://organization-documents/${organization}/${randomUUID()}.pdf`,
      contentSha256: "b".repeat(64),
      bytes: 768,
      reason: "The board approved the revised operational control language.",
    });
    expect(second.versionNumber).toBe(2);

    await expect(recordOrganizationDocumentDownload({
      documentId: created.documentId,
      versionId: second.versionId,
      organizationId: organization,
      actorIdentityId: reader,
      contentSha256: "c".repeat(64),
    })).rejects.toThrow("must match the authoritative version");
    await recordOrganizationDocumentDownload({
      documentId: created.documentId,
      versionId: second.versionId,
      organizationId: organization,
      actorIdentityId: reader,
      contentSha256: "b".repeat(64),
    });
    await expect(listOrganizationDocumentAccessEvents({ documentId: created.documentId, organizationId: organization }))
      .resolves.toMatchObject([{ versionId: second.versionId, versionNumber: 2, accessedBy: { id: reader } }]);

    const ownerSections = await withPostgresTransaction((client) =>
      collectCanonicalPrivacySourceSections(client, owner, "access", currentPrivacyProfile()));
    const readerSections = await withPostgresTransaction((client) =>
      collectCanonicalPrivacySourceSections(client, reader, "access", currentPrivacyProfile()));
    const outsiderSections = await withPostgresTransaction((client) =>
      collectCanonicalPrivacySourceSections(client, outsider, "access", currentPrivacyProfile()));
    const ownerDocumentCollection = [
      ownerSections.get("postgres.fractal.organization_documents")?.canonicalContent ?? "",
      ownerSections.get("postgres.fractal.organization_document_versions")?.canonicalContent ?? "",
      ownerSections.get("postgres.fractal.organization_document_events")?.canonicalContent ?? "",
    ].join("\n");
    const readerAccessCollection = readerSections.get("postgres.fractal.organization_document_access_events")?.canonicalContent ?? "";
    expect(ownerDocumentCollection).toContain('"participationRole":"creator"');
    expect(ownerDocumentCollection).toContain('"filename":"operating-policy-v2.pdf"');
    expect(ownerDocumentCollection).toContain('"eventType":"version_added"');
    expect(ownerDocumentCollection).not.toContain("Board-approved operating policy");
    expect(ownerDocumentCollection).not.toContain(organization);
    expect(ownerDocumentCollection).not.toContain(created.documentId);
    expect(ownerDocumentCollection).not.toContain("local://organization-documents");
    expect(readerAccessCollection).toContain('"accessType":"download"');
    expect(readerAccessCollection).not.toContain("b".repeat(64));
    expect(readerSections.get("postgres.fractal.organization_documents")?.canonicalContent).toContain('"records":[]');
    expect(outsiderSections.get("postgres.fractal.organization_document_access_events")?.canonicalContent).toContain('"records":[]');

    await expect(postgresQuery(
      "UPDATE fractal.organization_document_versions SET filename='mutated.pdf' WHERE id=$1",
      [second.versionId],
    )).rejects.toThrow("organization document evidence is immutable");
    await expect(postgresQuery(
      "UPDATE fractal.organization_document_access_events SET content_sha256=$2 WHERE document_version_id=$1",
      [second.versionId, "d".repeat(64)],
    )).rejects.toThrow("organization document evidence is immutable");
    await expect(postgresQuery(
      "UPDATE fractal.organization_documents SET retain_until=retain_until-interval '1 day' WHERE id=$1",
      [created.documentId],
    )).rejects.toThrow("retention cannot be shortened");
    await expect(postgresQuery(
      "UPDATE fractal.organization_documents SET current_version_id=current_version_id WHERE id=$1",
      [created.documentId],
    )).rejects.toThrow("must bind the first version or advance exactly once");
    await expect(postgresQuery(
      `INSERT INTO fractal.organization_document_events
        (id,document_id,sequence,event_type,from_status,to_status,actor_identity_id,reason)
       VALUES ($1,$2,99,'archived','active','archived',$3,'A non-contiguous archive event must never enter the evidence chain.')`,
      [randomUUID(), created.documentId, owner],
    )).rejects.toThrow("event sequence must be contiguous");

    await expect(archiveOrganizationDocument({
      documentId: created.documentId,
      organizationId: organization,
      actorIdentityId: owner,
      reason: "The board superseded this policy and preserved its immutable history.",
    })).resolves.toEqual({ documentId: created.documentId, status: "archived" });
    await expect(addOrganizationDocumentVersion({
      documentId: created.documentId,
      organizationId: organization,
      actorIdentityId: owner,
      filename: "forbidden-v3.pdf",
      mimeType: "application/pdf",
      storageKey: `local://organization-documents/${organization}/${randomUUID()}.pdf`,
      contentSha256: "e".repeat(64),
      bytes: 128,
      reason: "This write must be rejected after the document has been archived.",
    })).rejects.toThrow("Archived organization documents cannot receive a new version");
  });

  it("requires independent legal-hold and retention-gated disposition decisions before deleting document objects", async()=>{
    const maker=await createIdentity(`lifecycle-maker-${randomUUID()}@example.test`);const checker=await createIdentity(`lifecycle-checker-${randomUUID()}@example.test`);const organization=await createOrganization(`Lifecycle authority ${randomUUID()}`);
    await postgresQuery(`INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type) VALUES($1,$2,'admin','global'),($3,$4,'admin','global')`,[randomUUID(),maker,randomUUID(),checker]);
    await postgresQuery(`INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key) VALUES($1,$2,'data_lifecycle_manage'),($3,$4,'data_lifecycle_manage')`,[randomUUID(),maker,randomUUID(),checker]);
    const policyResult=await postgresQuery<{id:string;version_number:number;projection_version:number;value_sha256:string;proposed_value:{policyReference:string;policyName:string;schemaVersion:string;jurisdictions:{NG:{legalBasisReference:string;rules:{governance:{corporate_record:{retentionDays:number}}}}}}}>(`SELECT version.id,version.version_number,projection.projection_version,version.value_sha256,version.proposed_value FROM fractal.platform_configuration_active_versions projection JOIN fractal.platform_configuration_versions version ON version.id=projection.active_version_id WHERE projection.configuration_key='organization.document.retention_policy'`);
    const policy=policyResult.rows[0]!;const documentId=randomUUID();const versionId=randomUUID();const createdAt=new Date(Date.now()-366*86_400_000);const retainUntil=new Date(createdAt.getTime()+365*86_400_000);const storageKey=`local://organization-documents/${organization}/${randomUUID()}.pdf`;
    await withPostgresTransaction(async client=>{
      await client.query(`INSERT INTO fractal.organization_documents(id,organization_id,title,category,status,current_version_number,retention_basis,retain_until,created_by_identity_id,created_at,retention_binding_status,retention_configuration_key,retention_policy_version_id,retention_policy_version_number,retention_policy_projection_version,retention_policy_value_sha256,retention_policy_reference,retention_policy_name,retention_policy_schema_version,retention_policy_jurisdiction_code,retention_policy_legal_basis_reference,retention_days) VALUES($1,$2,'Expired governed board record','governance','active',1,'corporate_record',$3,$4,$5,'governed','organization.document.retention_policy',$6,$7,$8,$9,$10,$11,$12,'NG',$13,365)`,[documentId,organization,retainUntil,maker,createdAt,policy.id,policy.version_number,policy.projection_version,policy.value_sha256,policy.proposed_value.policyReference,policy.proposed_value.policyName,policy.proposed_value.schemaVersion,policy.proposed_value.jurisdictions.NG.legalBasisReference]);
      await client.query(`INSERT INTO fractal.organization_document_versions(id,document_id,organization_id,version_number,filename,mime_type,storage_key,content_sha256,bytes,retain_until,uploaded_by_identity_id,created_at) VALUES($1,$2,$3,1,'expired-board-record.pdf','application/pdf',$4,$5,512,$6,$7,$8)`,[versionId,documentId,organization,storageKey,"9".repeat(64),retainUntil,maker,createdAt]);
      await client.query(`INSERT INTO fractal.organization_document_events(id,document_id,sequence,event_type,to_status,document_version_id,actor_identity_id,reason,occurred_at) VALUES($1,$2,1,'created','active',$3,$4,'The original governed organization document version was recorded.',$5)`,[randomUUID(),documentId,versionId,maker,createdAt]);
      await client.query("UPDATE fractal.organization_documents SET current_version_id=$2 WHERE id=$1",[documentId,versionId]);
    });
    await archiveOrganizationDocument({documentId,organizationId:organization,actorIdentityId:maker,reason:"The expired record was superseded and archived before governed disposition."});
    const hold=await proposeLegalHoldChange({actorIdentityId:maker,targetType:"organization_document",targetId:documentId,changeType:"impose",reasonCategory:"audit",reason:"Preserve the complete record while the independent control audit remains open.",commandKey:randomUUID()});
    await decideLegalHoldChange({actorIdentityId:checker,requestId:hold.request.id,decision:"approve",decisionReason:"The audit scope and preservation requirement were independently confirmed."});
    await expect(proposeOrganizationDocumentDisposition({actorIdentityId:maker,documentId,reason:"Delete every managed object after the approved retention period elapsed.",commandKey:randomUUID()})).rejects.toThrow("active legal hold");
    const release=await proposeLegalHoldChange({actorIdentityId:checker,targetType:"organization_document",targetId:documentId,changeType:"release",reasonCategory:"audit",reason:"The independent audit is closed and preservation is no longer required.",commandKey:randomUUID()});
    await decideLegalHoldChange({actorIdentityId:maker,requestId:release.request.id,decision:"approve",decisionReason:"Audit closure evidence was checked before independently releasing the hold."});
    const disposition=await proposeOrganizationDocumentDisposition({actorIdentityId:maker,documentId,reason:"Delete every managed version object because approved retention elapsed and no hold remains.",commandKey:randomUUID()});
    await expect(decideOrganizationDocumentDisposition({actorIdentityId:maker,requestId:disposition.request.id,decision:"approve",decisionReason:"A proposer must never approve their own destructive lifecycle command."})).rejects.toThrow("proposer cannot decide");
    await decideOrganizationDocumentDisposition({actorIdentityId:checker,requestId:disposition.request.id,decision:"approve",decisionReason:"Retention, archive state, policy binding, version count, and hold clearance were independently verified."});
    await expect(readOrganizationDocumentLifecycle({actorIdentityId:maker,documentId})).resolves.toMatchObject({disposition:{status:"cleanup_requested"}});
    await expect(recordOrganizationDocumentDownload({documentId,versionId,organizationId:organization,actorIdentityId:maker,contentSha256:"9".repeat(64)})).rejects.toThrow("governed disposition has begun");
    await expect(dispatchPendingStorageCleanupTasks({workerId:"organization-document-lifecycle-test",logger:{info:()=>undefined,error:()=>undefined},remove:async key=>{expect(key).toBe(storageKey);}})).resolves.toBe(1);
    await expect(readOrganizationDocumentLifecycle({actorIdentityId:maker,documentId})).resolves.toMatchObject({disposition:{status:"completed",completedAt:expect.any(String)}});
    const makerSections=await withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,maker,"access",currentPrivacyProfile()));
    const checkerSections=await withPostgresTransaction(client=>collectCanonicalPrivacySourceSections(client,checker,"access",currentPrivacyProfile()));
    const makerRequest=makerSections.get("postgres.fractal.organization_document_disposition_requests")?.canonicalContent??"";
    const makerDisposition=makerSections.get("postgres.fractal.organization_document_dispositions")?.canonicalContent??"";
    const checkerRequest=checkerSections.get("postgres.fractal.organization_document_disposition_requests")?.canonicalContent??"";
    expect(makerRequest).toContain('"participationRole":"requester"');
    expect(makerDisposition).toContain('"status":"completed"');
    expect(checkerRequest).toContain('"participationRole":"reviewer"');
    expect(makerRequest).not.toContain("Delete every managed version object because approved retention elapsed and no hold remains.");
    expect(checkerRequest).not.toContain("Retention, archive state, policy binding, version count, and hold clearance were independently verified.");
    expect(makerRequest).not.toContain(documentId);
    expect(makerRequest).not.toContain(policy.id);
    expect(makerRequest).not.toContain(storageKey);
    await expect(postgresQuery("UPDATE fractal.organization_document_disposition_requests SET reason='tampered disposition evidence' WHERE id=$1",[disposition.request.id])).rejects.toThrow("terminal organization document disposition request evidence is immutable");
  });
});
