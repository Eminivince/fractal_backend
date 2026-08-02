import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres } from "../postgres.js";
import { platformKernelMigration } from "./001-platform-kernel.js";
import { auditChainHeadsMigration } from "./002-audit-chain-heads.js";
import { authSessionsMigration } from "./003-auth-sessions.js";
import { securityNotificationsMigration } from "./004-security-notifications.js";
import { identitiesMigration } from "./005-identities.js";
import { organizationsAndMembershipsMigration } from "./006-organizations-and-memberships.js";
import { totpFactorsMigration } from "./007-totp-factors.js";
import { authSessionIdentitiesMigration } from "./008-auth-session-identities.js";
import { accountingJournalMigration } from "./009-accounting-journal.js";
import { inboxRetryLeasesMigration } from "./010-inbox-retry-leases.js";
import { ledgerAccountOwnershipMigration } from "./011-ledger-account-ownership.js";
import { paymentAccountingSliceMigration } from "./012-payment-accounting-slice.js";
import { offeringCheckoutFoundationMigration } from "./013-offering-checkout-foundation.js";
import { reservationCommitmentLinkMigration } from "./014-reservation-commitment-link.js";
import { paymentProviderInstructionsMigration } from "./015-payment-provider-instructions.js";
import { checkoutCommandIdempotencyMigration } from "./016-checkout-command-idempotency.js";
import { paymentExpiryInstructionsMigration } from "./017-payment-expiry-instructions.js";
import { providerInstructionTerminalStateMigration } from "./018-provider-instruction-terminal-state.js";
import { offeringGovernanceMigration } from "./019-offering-governance.js";
import { auditScopeVerificationMigration } from "./020-audit-scope-verification.js";
import { offeringChainDeploymentsMigration } from "./021-offering-chain-deployments.js";
import { offeringChainExecutionMigration } from "./022-offering-chain-execution.js";
import { investorWalletLinksMigration } from "./023-investor-wallet-links.js";
import { offeringIssuanceCapMigration } from "./024-offering-issuance-cap.js";
import { offeringIssuanceTermsMigration } from "./025-offering-issuance-terms.js";
import { investmentAllocationsMigration } from "./026-investment-allocations.js";
import { chainDeploymentIssuanceTermsMigration } from "./027-chain-deployment-issuance-terms.js";
import { allocationChainOperationsMigration } from "./028-allocation-chain-operations.js";
import { governanceEvidenceDocumentsMigration } from "./029-governance-evidence-documents.js";
import { offeringPublicationEvidenceMigration } from "./030-offering-publication-evidence.js";
import { assetApplicationGovernanceMigration } from "./031-asset-application-governance.js";
import { assetApplicationReviewItemsMigration } from "./032-asset-application-review-items.js";
import { assetApplicationSupersessionMigration } from "./033-asset-application-supersession.js";
import { assetApplicationAmendmentsMigration } from "./034-asset-application-amendments.js";
import { professionalWorkOrderFoundationMigration } from "./035-professional-work-order-foundation.js";
import { professionalDeliverableVersionsMigration } from "./036-professional-deliverable-versions.js";
import { professionalInvoiceFoundationMigration } from "./037-professional-invoice-foundation.js";
import { professionalPayoutInstructionsMigration } from "./038-professional-payout-instructions.js";
import { professionalPayoutDispatchSafetyMigration } from "./039-professional-payout-dispatch-safety.js";
import { professionalPayoutAuthorizationAndRecoveryMigration } from "./040-professional-payout-authorization-and-recovery.js";
import { professionalPayoutOutcomeImmutabilityMigration } from "./041-professional-payout-outcome-immutability.js";
import { professionalPayoutUnexpectedProviderOutcomeMigration } from "./042-professional-payout-unexpected-provider-outcome.js";
import { professionalRecipientRecoveryMigration } from "./043-professional-recipient-recovery.js";
import { professionalInvoiceTaxTreatmentMigration } from "./044-professional-invoice-tax-treatment.js";
import { professionalFinanceExceptionsMigration } from "./045-professional-finance-exceptions.js";
import { professionalCreditNotesMigration } from "./046-professional-credit-notes.js";
import { professionalReplacementPayoutsMigration } from "./047-professional-replacement-payouts.js";
import { professionalFinanceApprovalPoliciesMigration } from "./048-professional-finance-approval-policies.js";
import { professionalLedgerAccountingMigration } from "./049-professional-ledger-accounting.js";
import { authStepUpGrantsMigration } from "./050-auth-step-up-grants.js";
import { authStepUpSessionIdentityMigration } from "./051-auth-step-up-session-identity.js";
import { storageCleanupTasksMigration } from "./052-storage-cleanup-tasks.js";
import { totpRecoveryCodesMigration } from "./053-totp-recovery-codes.js";
import { providerIdentityVerificationEvidenceMigration } from "./054-provider-identity-verification-evidence.js";
import { providerIdentityVerificationApplicationsMigration } from "./055-provider-identity-verification-applications.js";
import { postgresIdentityAuthAuthorityMigration } from "./056-postgres-identity-auth-authority.js";
import { authEmailDeliveriesMigration } from "./057-auth-email-deliveries.js";
import { identityAccessGovernanceMigration } from "./058-identity-access-governance.js";
import { administratorBootstrapRecoveryMigration } from "./059-administrator-bootstrap-recovery.js";
import { credentialTokenPurposeMigration } from "./060-credential-token-purpose.js";
import { organizationAuthorityMigration } from "./061-organization-authority.js";
import { organizationOwnershipTransfersMigration } from "./062-organization-ownership-transfers.js";
import { publicOfferingCatalogueMigration } from "./063-public-offering-catalogue.js";
import { administratorCapabilitiesAuditExportsMigration } from "./064-administrator-capabilities-audit-exports.js";
import { administratorProviderIncidentsMigration } from "./065-administrator-provider-incidents.js";
import { supportCasesMigration } from "./066-support-cases.js";
import { supportCaseTriageOwnerMigration } from "./067-support-case-triage-owner.js";
import { platformConfigurationAuthorityMigration } from "./068-platform-configuration-authority.js";
import { retireUnboundConfigurationDefinitionsMigration } from "./069-retire-unbound-configuration-definitions.js";
import { platformConfigurationProjectionIntegrityMigration } from "./070-platform-configuration-projection-integrity.js";
import { strengthenPlatformConfigurationEventBindingMigration } from "./071-strengthen-platform-configuration-event-binding.js";
import { platformContentConsentAuthorityMigration } from "./072-platform-content-consent-authority.js";
import { strengthenLegalAcceptanceEvidenceMigration } from "./073-strengthen-legal-acceptance-evidence.js";
import { supportServicePolicyObligationsMigration } from "./074-support-service-policy-obligations.js";
import { strengthenSupportServiceEvidenceMigration } from "./075-strengthen-support-service-evidence.js";
import { supportRequesterNotificationsMigration } from "./076-support-requester-notifications.js";
import { supportCaseAttachmentsMigration } from "./077-support-case-attachments.js";
import { supportEvidenceLifecycleMigration } from "./078-support-evidence-lifecycle.js";
import { privacyRightsAuthorityMigration } from "./079-privacy-rights-authority.js";
import { privacyRightsResponsePolicyMigration } from "./080-privacy-rights-response-policy.js";
import { privacyDataSourceInventoryMigration } from "./081-privacy-data-source-inventory.js";
import { privacyPackagePreparationsMigration } from "./082-privacy-package-preparations.js";
import { privacyContentProfilesMigration } from "./083-privacy-content-profiles.js";
import { privacyIdentitySecurityCollectorsMigration } from "./084-privacy-identity-security-collectors.js";
import { privacyGovernanceEvidenceCollectorsMigration } from "./085-privacy-governance-evidence-collectors.js";
import { privacyIdentityVerificationCollectorsMigration } from "./086-privacy-identity-verification-collectors.js";
import { privacyLegalConsentCollectorsMigration } from "./087-privacy-legal-consent-collectors.js";
import { privacyPackagePreparationCollectorMigration } from "./088-privacy-package-preparation-collector.js";
import { privacyPlatformConfigurationCollectorsMigration } from "./089-privacy-platform-configuration-collectors.js";
import { privacyProviderIncidentCollectorsMigration } from "./090-privacy-provider-incident-collectors.js";
import { privacySupportCaseCollectorsMigration } from "./091-privacy-support-case-collectors.js";
import { privacySupportAttachmentCollectorsMigration } from "./092-privacy-support-attachment-collectors.js";
import { privacyInvestorWalletCollectorsMigration } from "./093-privacy-investor-wallet-collectors.js";
import { privacyInvestorComplianceCollectorsMigration } from "./094-privacy-investor-compliance-collectors.js";
import { privacyInvestmentLifecycleCollectorsMigration } from "./095-privacy-investment-lifecycle-collectors.js";
import { privacyInvestmentAllocationCollectorsMigration } from "./096-privacy-investment-allocation-collectors.js";
import { privacyPaymentLifecycleCollectorsMigration } from "./097-privacy-payment-lifecycle-collectors.js";
import { privacyPaymentAccountingCollectorsMigration } from "./098-privacy-payment-accounting-collectors.js";
import { privacySupportLifecycleCollectorsMigration } from "./099-privacy-support-lifecycle-collectors.js";
import { privacyOrganizationRelationshipCollectorsMigration } from "./100-privacy-organization-relationship-collectors.js";
import { privacyOrganizationVerificationCollectorsMigration } from "./101-privacy-organization-verification-collectors.js";
import { privacyAssetApplicationCollectorsMigration } from "./102-privacy-asset-application-collectors.js";
import { privacyOfferingPublicationCollectorsMigration } from "./103-privacy-offering-publication-collectors.js";
import { privacyOfferingIssuanceCollectorsMigration } from "./104-privacy-offering-issuance-collectors.js";
import { privacySupportDispositionCollectorsMigration } from "./105-privacy-support-disposition-collectors.js";
import { privacyProfessionalMandateCollectorsMigration } from "./106-privacy-professional-mandate-collectors.js";
import { privacyProfessionalDeliverableCollectorsMigration } from "./107-privacy-professional-deliverable-collectors.js";
import { privacyProfessionalInvoiceCollectorMigration } from "./108-privacy-professional-invoice-collector.js";
import { privacyProfessionalPayoutCollectorMigration } from "./109-privacy-professional-payout-collector.js";
import { privacyProfessionalCreditNoteCollectorMigration } from "./110-privacy-professional-credit-note-collector.js";
import { privacyProfessionalFinanceExceptionCollectorMigration } from "./111-privacy-professional-finance-exception-collector.js";
import { privacyProfessionalAuthoredEvidenceCollectorsMigration } from "./112-privacy-professional-authored-evidence-collectors.js";
import { privacyActorAuditGovernanceEvidenceCollectorsMigration } from "./113-privacy-actor-audit-governance-evidence-collectors.js";
import { privacyProfessionalFinanceParticipationCollectorsMigration } from "./114-privacy-professional-finance-participation-collectors.js";
import { privacyProfessionalFinanceResolutionCollectorsMigration } from "./115-privacy-professional-finance-resolution-collectors.js";
import { privacyAuditChainHeadCollectorMigration } from "./116-privacy-audit-chain-head-collector.js";
import { idempotencyActorAttributionMigration } from "./117-idempotency-actor-attribution.js";
import { privacySupportSweepClassificationMigration } from "./118-privacy-support-sweep-classification.js";
import { privacyAdministratorBootstrapCollectorMigration } from "./119-privacy-administrator-bootstrap-collector.js";
import { organizationBeneficialOwnerSelfLinkMigration } from "./120-organization-beneficial-owner-self-link.js";
import { privacyBeneficialOwnerCollectorMigration } from "./121-privacy-beneficial-owner-collector.js";
import { privacyStorageCleanupCollectorMigration } from "./122-privacy-storage-cleanup-collector.js";
import { organizationDocumentLifecycleMigration } from "./123-organization-document-lifecycle.js";
import { organizationDocumentRetentionDispositionMigration } from "./124-organization-document-retention-disposition.js";
import { offeringNoticeAuthorityMigration } from "./125-offering-notice-authority.js";
import { distributionAuthorityMigration } from "./126-distribution-authority.js";
import { distributionPayoutAuthorityMigration } from "./127-distribution-payout-authority.js";
import { distributionPayoutExceptionsMigration } from "./128-distribution-payout-exceptions.js";
import { distributionTaxRemittanceMigration } from "./129-distribution-tax-remittance.js";
import { privacyDistributionCollectorsMigration } from "./130-privacy-distribution-collectors.js";
import { distributionLegalHoldCoverageMigration } from "./131-distribution-legal-hold-coverage.js";
import { distributionLifecycleRetentionPolicyMigration } from "./132-distribution-lifecycle-retention-policy.js";
import { distributionPrivacyTreatmentAuthorityMigration } from "./133-distribution-privacy-treatment-authority.js";
import { privacyDistributionTreatmentCollectorsMigration } from "./134-privacy-distribution-treatment-collectors.js";
import { privacyPackageDeliveryAuthorityMigration } from "./135-privacy-package-delivery-authority.js";
import { privacyPackageDeliveryCollectorsMigration } from "./136-privacy-package-delivery-collectors.js";
import { privacyAuthoredLifecycleCollectorsMigration } from "./137-privacy-authored-lifecycle-collectors.js";
import { eventPrivacyAttributionMigration } from "./138-event-privacy-attribution.js";
import { privacyEventLifecycleCollectorsMigration } from "./139-privacy-event-lifecycle-collectors.js";
import { privacyExternalAdapterPolicyMigration } from "./140-privacy-external-adapter-policy.js";
import { privacyExternalAttestationAuthorityMigration } from "./141-privacy-external-attestation-authority.js";
import { emailProviderCorrelationMigration } from "./142-email-provider-correlation.js";
import { privacyExternalCollectionSnapshotsMigration } from "./143-privacy-external-collection-snapshots.js";
import { privacyExternalZeroRecordSnapshotsMigration } from "./144-privacy-external-zero-record-snapshots.js";
import { privacyExternalComponentCoverageMigration } from "./145-privacy-external-component-coverage.js";
import { privacyPackageArchiveFormatMigration } from "./146-privacy-package-archive-format.js";
import { sumsubPrivacyExportStagingMigration } from "./147-sumsub-privacy-export-staging.js";
import { sumsubPrivacySnapshotArtifactsMigration } from "./148-sumsub-privacy-snapshot-artifacts.js";
import type { PostgresMigration } from "./types.js";

const migrations: readonly PostgresMigration[] = [
  platformKernelMigration,
  auditChainHeadsMigration,
  authSessionsMigration,
  securityNotificationsMigration,
  identitiesMigration,
  organizationsAndMembershipsMigration,
  totpFactorsMigration,
  authSessionIdentitiesMigration,
  accountingJournalMigration,
  inboxRetryLeasesMigration,
  ledgerAccountOwnershipMigration,
  paymentAccountingSliceMigration,
  offeringCheckoutFoundationMigration,
  reservationCommitmentLinkMigration,
  paymentProviderInstructionsMigration,
  checkoutCommandIdempotencyMigration,
  paymentExpiryInstructionsMigration,
  providerInstructionTerminalStateMigration,
  offeringGovernanceMigration,
  auditScopeVerificationMigration,
  offeringChainDeploymentsMigration,
  offeringChainExecutionMigration,
  investorWalletLinksMigration,
  offeringIssuanceCapMigration,
  offeringIssuanceTermsMigration,
  investmentAllocationsMigration,
  chainDeploymentIssuanceTermsMigration,
  allocationChainOperationsMigration,
  governanceEvidenceDocumentsMigration,
  offeringPublicationEvidenceMigration,
  assetApplicationGovernanceMigration,
  assetApplicationReviewItemsMigration,
  assetApplicationSupersessionMigration,
  assetApplicationAmendmentsMigration,
  professionalWorkOrderFoundationMigration,
  professionalDeliverableVersionsMigration,
  professionalInvoiceFoundationMigration,
  professionalPayoutInstructionsMigration,
  professionalPayoutDispatchSafetyMigration,
  professionalPayoutAuthorizationAndRecoveryMigration,
  professionalPayoutOutcomeImmutabilityMigration,
  professionalPayoutUnexpectedProviderOutcomeMigration,
  professionalRecipientRecoveryMigration,
  professionalInvoiceTaxTreatmentMigration,
  professionalFinanceExceptionsMigration,
  professionalCreditNotesMigration,
  professionalReplacementPayoutsMigration,
  professionalFinanceApprovalPoliciesMigration,
  professionalLedgerAccountingMigration,
  authStepUpGrantsMigration,
  authStepUpSessionIdentityMigration,
  storageCleanupTasksMigration,
  totpRecoveryCodesMigration,
  providerIdentityVerificationEvidenceMigration,
  providerIdentityVerificationApplicationsMigration,
  postgresIdentityAuthAuthorityMigration,
  authEmailDeliveriesMigration,
  identityAccessGovernanceMigration,
  administratorBootstrapRecoveryMigration,
  credentialTokenPurposeMigration,
  organizationAuthorityMigration,
  organizationOwnershipTransfersMigration,
  publicOfferingCatalogueMigration,
  administratorCapabilitiesAuditExportsMigration,
  administratorProviderIncidentsMigration,
  supportCasesMigration,
  supportCaseTriageOwnerMigration,
  platformConfigurationAuthorityMigration,
  retireUnboundConfigurationDefinitionsMigration,
  platformConfigurationProjectionIntegrityMigration,
  strengthenPlatformConfigurationEventBindingMigration,
  platformContentConsentAuthorityMigration,
  strengthenLegalAcceptanceEvidenceMigration,
  supportServicePolicyObligationsMigration,
  strengthenSupportServiceEvidenceMigration,
  supportRequesterNotificationsMigration,
  supportCaseAttachmentsMigration,
  supportEvidenceLifecycleMigration,
  privacyRightsAuthorityMigration,
  privacyRightsResponsePolicyMigration,
  privacyDataSourceInventoryMigration,
  privacyPackagePreparationsMigration,
  privacyContentProfilesMigration,
  privacyIdentitySecurityCollectorsMigration,
  privacyGovernanceEvidenceCollectorsMigration,
  privacyIdentityVerificationCollectorsMigration,
  privacyLegalConsentCollectorsMigration,
  privacyPackagePreparationCollectorMigration,
  privacyPlatformConfigurationCollectorsMigration,
  privacyProviderIncidentCollectorsMigration,
  privacySupportCaseCollectorsMigration,
  privacySupportAttachmentCollectorsMigration,
  privacyInvestorWalletCollectorsMigration,
  privacyInvestorComplianceCollectorsMigration,
  privacyInvestmentLifecycleCollectorsMigration,
  privacyInvestmentAllocationCollectorsMigration,
  privacyPaymentLifecycleCollectorsMigration,
  privacyPaymentAccountingCollectorsMigration,
  privacySupportLifecycleCollectorsMigration,
  privacyOrganizationRelationshipCollectorsMigration,
  privacyOrganizationVerificationCollectorsMigration,
  privacyAssetApplicationCollectorsMigration,
  privacyOfferingPublicationCollectorsMigration,
  privacyOfferingIssuanceCollectorsMigration,
  privacySupportDispositionCollectorsMigration,
  privacyProfessionalMandateCollectorsMigration,
  privacyProfessionalDeliverableCollectorsMigration,
  privacyProfessionalInvoiceCollectorMigration,
  privacyProfessionalPayoutCollectorMigration,
  privacyProfessionalCreditNoteCollectorMigration,
  privacyProfessionalFinanceExceptionCollectorMigration,
  privacyProfessionalAuthoredEvidenceCollectorsMigration,
  privacyActorAuditGovernanceEvidenceCollectorsMigration,
  privacyProfessionalFinanceParticipationCollectorsMigration,
  privacyProfessionalFinanceResolutionCollectorsMigration,
  privacyAuditChainHeadCollectorMigration,
  idempotencyActorAttributionMigration,
  privacySupportSweepClassificationMigration,
  privacyAdministratorBootstrapCollectorMigration,
  organizationBeneficialOwnerSelfLinkMigration,
  privacyBeneficialOwnerCollectorMigration,
  privacyStorageCleanupCollectorMigration,
  organizationDocumentLifecycleMigration,
  organizationDocumentRetentionDispositionMigration,
  offeringNoticeAuthorityMigration,
  distributionAuthorityMigration,
  distributionPayoutAuthorityMigration,
  distributionPayoutExceptionsMigration,
  distributionTaxRemittanceMigration,
  privacyDistributionCollectorsMigration,
  distributionLegalHoldCoverageMigration,
  distributionLifecycleRetentionPolicyMigration,
  distributionPrivacyTreatmentAuthorityMigration,
  privacyDistributionTreatmentCollectorsMigration,
  privacyPackageDeliveryAuthorityMigration,
  privacyPackageDeliveryCollectorsMigration,
  privacyAuthoredLifecycleCollectorsMigration,
  eventPrivacyAttributionMigration,
  privacyEventLifecycleCollectorsMigration,
  privacyExternalAdapterPolicyMigration,
  privacyExternalAttestationAuthorityMigration,
  emailProviderCorrelationMigration,
  privacyExternalCollectionSnapshotsMigration,
  privacyExternalZeroRecordSnapshotsMigration,
  privacyExternalComponentCoverageMigration,
  privacyPackageArchiveFormatMigration,
  sumsubPrivacyExportStagingMigration,
  sumsubPrivacySnapshotArtifactsMigration,
];

/**
 * One lock across every Fractal PostgreSQL migration command.  The key is a
 * stable application namespace, not a database object name, so it also
 * protects the first creation of the migration ledger.
 */
export const POSTGRES_MIGRATION_ADVISORY_LOCK = 4_182_901_517;

type AppliedMigrationRow = {
  version: string;
  checksum: string;
  applied_at: Date;
};

export type PostgresMigrationStatus = {
  version: string;
  expectedChecksum: string;
  appliedChecksum: string | null;
  appliedAt: Date | null;
  state: "applied" | "pending";
};

export type PostgresSchemaVerification = {
  expectedTables: string[];
  expectedIndexes: string[];
  expectedConstraints: string[];
  missingTables: string[];
  missingIndexes: string[];
  missingConstraints: string[];
  expectedDefinitionCount: number;
  definitionDifferences: string[];
};

export class PostgresSchemaDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresSchemaDriftError";
  }
}

const migrationsByVersion = new Map<string, PostgresMigration>();
for (const migration of migrations) {
  if (migrationsByVersion.has(migration.version)) {
    throw new Error(`Duplicate PostgreSQL migration version: ${migration.version}`);
  }
  migrationsByVersion.set(migration.version, migration);
}

function checksum(migration: PostgresMigration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

/**
 * Keep the lightweight named-object manifest derived from the same migration
 * SQL so error reports remain readable. `verifyPostgresSchema` additionally
 * derives an exact PostgreSQL catalog shape from every migration in an isolated
 * scratch schema, so it detects definition drift without maintaining a second
 * hand-authored schema manifest. Backup/restore assurance remains a separate
 * deployment and operations control.
 */
function expectedSchemaObjects() {
  const tables = new Set<string>(["schema_migrations"]);
  const indexes = new Set<string>();
  const constraints = new Set<string>();

  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?fractal\.([a-z_][a-z0-9_]*)/gi)) {
      tables.add(match[1]!.toLowerCase());
    }
    for (const match of migration.sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      indexes.add(match[1]!.toLowerCase());
    }
    for (const match of migration.sql.matchAll(/\b(?:ADD\s+)?CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)/gi)) {
      constraints.add(match[1]!.toLowerCase());
    }
  }

  return {
    tables: [...tables].sort(),
    indexes: [...indexes].sort(),
    constraints: [...constraints].sort(),
  };
}

type SchemaDefinition = {
  key: string;
  value: string;
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeDefinition(value: string | null, schema: string): string {
  const escapedSchema = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (value ?? "")
    .replace(new RegExp(`"${escapedSchema}"|\\b${escapedSchema}\\b`, "g"), "<fractal-schema>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads a schema shape in PostgreSQL's own canonical terms rather than trying
 * to parse DDL with regular expressions. The keys intentionally include every
 * migration-owned definition that can change integrity semantics: tables and
 * columns, constraints, indexes, PL/pgSQL functions, and triggers.
 */
async function readSchemaDefinitions(client: PoolClient, schema: string): Promise<SchemaDefinition[]> {
  const definitions: SchemaDefinition[] = [];
  const tables = await client.query<{
    table_name: string; relkind: string; relpersistence: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
  }>(`
    SELECT c.relname AS table_name, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  `, [schema]);
  for (const row of tables.rows) {
    definitions.push({
      key: `table:${row.table_name}`,
      value: `${row.relkind}|${row.relpersistence}|${row.relrowsecurity}|${row.relforcerowsecurity}`,
    });
  }

  const columns = await client.query<{
    table_name: string; attnum: number; column_name: string; column_type: string; not_null: boolean;
    identity_kind: string; generated_kind: string; default_expression: string | null;
  }>(`
    SELECT relation.relname AS table_name, attribute.attnum, attribute.attname AS column_name,
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type,
           attribute.attnotnull AS not_null, attribute.attidentity AS identity_kind,
           attribute.attgenerated AS generated_kind,
           pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
 LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
     WHERE namespace.nspname = $1
       AND relation.relkind IN ('r', 'p')
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY relation.relname, attribute.attnum
  `, [schema]);
  for (const row of columns.rows) {
    definitions.push({
      key: `column:${row.table_name}:${row.attnum}:${row.column_name}`,
      value: [
        row.column_type,
        row.not_null,
        row.identity_kind,
        row.generated_kind,
        normalizeDefinition(row.default_expression, schema),
      ].join("|"),
    });
  }

  const constraints = await client.query<{
    table_name: string; constraint_name: string; constraint_type: string; deferrable: boolean; deferred: boolean;
    validated: boolean; definition: string;
  }>(`
    SELECT relation.relname AS table_name, constraint_data.conname AS constraint_name, constraint_data.contype AS constraint_type,
           constraint_data.condeferrable AS deferrable, constraint_data.condeferred AS deferred,
           constraint_data.convalidated AS validated, pg_get_constraintdef(constraint_data.oid, true) AS definition
      FROM pg_constraint constraint_data
      JOIN pg_class relation ON relation.oid = constraint_data.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
     ORDER BY relation.relname, constraint_data.conname
  `, [schema]);
  for (const row of constraints.rows) {
    definitions.push({
      key: `constraint:${row.table_name}:${row.constraint_name}`,
      value: [row.constraint_type, row.deferrable, row.deferred, row.validated, normalizeDefinition(row.definition, schema)].join("|"),
    });
  }

  const indexes = await client.query<{
    table_name: string; index_name: string; unique_index: boolean; primary_index: boolean; valid_index: boolean; nulls_not_distinct: boolean; definition: string;
  }>(`
    SELECT relation.relname AS table_name, index_relation.relname AS index_name,
           index_data.indisunique AS unique_index, index_data.indisprimary AS primary_index,
           index_data.indisvalid AS valid_index, index_data.indnullsnotdistinct AS nulls_not_distinct,
           pg_get_indexdef(index_relation.oid) AS definition
      FROM pg_index index_data
      JOIN pg_class relation ON relation.oid = index_data.indrelid
      JOIN pg_class index_relation ON index_relation.oid = index_data.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
     ORDER BY relation.relname, index_relation.relname
  `, [schema]);
  for (const row of indexes.rows) {
    definitions.push({
      key: `index:${row.table_name}:${row.index_name}`,
      value: [row.unique_index, row.primary_index, row.valid_index, row.nulls_not_distinct, normalizeDefinition(row.definition, schema)].join("|"),
    });
  }

  const functions = await client.query<{ name: string; identity_arguments: string; definition: string }>(`
    SELECT procedure.proname AS name, pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
           pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = $1
     ORDER BY procedure.proname, pg_get_function_identity_arguments(procedure.oid)
  `, [schema]);
  for (const row of functions.rows) {
    definitions.push({
      key: `function:${row.name}:${normalizeDefinition(row.identity_arguments, schema)}`,
      value: normalizeDefinition(row.definition, schema),
    });
  }

  const triggers = await client.query<{ table_name: string; trigger_name: string; enabled: string; definition: string }>(`
    SELECT relation.relname AS table_name, trigger.tgname AS trigger_name, trigger.tgenabled AS enabled,
           pg_get_triggerdef(trigger.oid, true) AS definition
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND NOT trigger.tgisinternal
     ORDER BY relation.relname, trigger.tgname
  `, [schema]);
  for (const row of triggers.rows) {
    definitions.push({
      key: `trigger:${row.table_name}:${row.trigger_name}`,
      value: `${row.enabled}|${normalizeDefinition(row.definition, schema)}`,
    });
  }

  const sequences = await client.query<{
    sequence_name: string; data_type: string; start_value: string; min_value: string; max_value: string;
    increment_value: string; cycle: boolean; cache_size: string;
  }>(`
    SELECT relation.relname AS sequence_name, pg_catalog.format_type(sequence_data.seqtypid, NULL) AS data_type,
           sequence_data.seqstart::text AS start_value, sequence_data.seqmin::text AS min_value,
           sequence_data.seqmax::text AS max_value, sequence_data.seqincrement::text AS increment_value,
           sequence_data.seqcycle AS cycle, sequence_data.seqcache::text AS cache_size
      FROM pg_sequence sequence_data
      JOIN pg_class relation ON relation.oid = sequence_data.seqrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
     ORDER BY relation.relname
  `, [schema]);
  for (const row of sequences.rows) {
    definitions.push({
      key: `sequence:${row.sequence_name}`,
      value: [row.data_type, row.start_value, row.min_value, row.max_value, row.increment_value, row.cycle, row.cache_size].join("|"),
    });
  }

  return definitions.sort((left, right) => left.key.localeCompare(right.key));
}

function rewriteMigrationSchema(sql: string, schema: string): string {
  // All migration-owned identifiers are explicitly schema-qualified. Rewriting
  // the schema into a transaction-local scratch namespace lets PostgreSQL
  // itself produce the expected catalog without applying or repairing anything
  // in the live namespace. Rewriting error-message text is harmless here.
  return sql.replace(/\bfractal\b/g, schema);
}

async function readExpectedSchemaDefinitions(client: PoolClient): Promise<SchemaDefinition[]> {
  const schema = `fractal_schema_verify_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteIdentifier(schema);
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    // PostgreSQL omits a referenced table's schema from constraint output when
    // it is on the active search path. Use the scratch schema in the same way
    // so the canonical catalog shape matches the live schema's definitions.
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
    await client.query(`
      CREATE TABLE ${quotedSchema}.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const migration of migrations) {
      await client.query(rewriteMigrationSchema(migration.sql, schema));
    }
    return await readSchemaDefinitions(client, schema);
  } finally {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
  }
}

function schemaDefinitionDifferences(expected: readonly SchemaDefinition[], actual: readonly SchemaDefinition[]): string[] {
  const expectedByKey = new Map(expected.map((definition) => [definition.key, definition.value]));
  const actualByKey = new Map(actual.map((definition) => [definition.key, definition.value]));
  const keys = [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])].sort();
  return keys.flatMap((key) => {
    const expectedValue = expectedByKey.get(key);
    const actualValue = actualByKey.get(key);
    if (expectedValue === undefined) return [`unexpected ${key}`];
    if (actualValue === undefined) return [`missing ${key}`];
    return expectedValue === actualValue ? [] : [`mismatch ${key}`];
  });
}

async function ensureMigrationTable(client: PoolClient) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS fractal;
    CREATE TABLE IF NOT EXISTS fractal.schema_migrations (
      version TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function readAppliedMigrations(client: PoolClient): Promise<AppliedMigrationRow[]> {
  const result = await client.query<AppliedMigrationRow>(
    "SELECT version, checksum, applied_at FROM fractal.schema_migrations ORDER BY version",
  );
  return result.rows;
}

function assertMigrationLedgerIntegrity(appliedMigrations: readonly AppliedMigrationRow[]) {
  for (const applied of appliedMigrations) {
    const migration = migrationsByVersion.get(applied.version);
    if (!migration) {
      throw new Error(`Postgres migration ledger contains an unrecognized version: ${applied.version}`);
    }
    if (applied.checksum !== checksum(migration)) {
      throw new Error(`Postgres migration checksum changed after application: ${applied.version}`);
    }
  }
}

async function withMigrationLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await requirePostgres().connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [POSTGRES_MIGRATION_ADVISORY_LOCK]);
    locked = true;
    return await fn(client);
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [POSTGRES_MIGRATION_ADVISORY_LOCK]).catch(() => undefined);
    }
    client.release();
  }
}

export async function postgresMigrationStatus(): Promise<PostgresMigrationStatus[]> {
  return withMigrationLock(async (client) => {
    await ensureMigrationTable(client);
    const appliedMigrations = await readAppliedMigrations(client);
    assertMigrationLedgerIntegrity(appliedMigrations);
    const appliedByVersion = new Map(appliedMigrations.map((migration) => [migration.version, migration]));

    return migrations.map((migration) => {
      const applied = appliedByVersion.get(migration.version);
      return {
        version: migration.version,
        expectedChecksum: checksum(migration),
        appliedChecksum: applied?.checksum ?? null,
        appliedAt: applied?.applied_at ?? null,
        state: applied ? "applied" : "pending",
      };
    });
  });
}

/**
 * Read-only proof that a fully applied migration ledger still has every
 * migration-owned definition still matches the current migration source. It
 * derives the expected catalog in an isolated transaction-local scratch schema
 * and rolls it back, so verification never repairs or writes to the target
 * schema. It is intended for deployment/CI checks and must never repair a
 * drifted database implicitly.
 */
export async function verifyPostgresSchema(): Promise<PostgresSchemaVerification> {
  return withMigrationLock(async (client) => {
    await ensureMigrationTable(client);
    const appliedMigrations = await readAppliedMigrations(client);
    assertMigrationLedgerIntegrity(appliedMigrations);

    const appliedVersions = new Set(appliedMigrations.map((migration) => migration.version));
    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version)).map((migration) => migration.version);
    if (pending.length) {
      throw new PostgresSchemaDriftError(
        `Postgres schema verification requires all migrations to be applied; pending: ${pending.join(", ")}`,
      );
    }

    const expected = expectedSchemaObjects();
    // A pg Client has a single query queue. Keep these catalog reads serial so
    // verification does not rely on concurrent client.query behaviour that pg
    // is deprecating.
    const tableResult = await client.query<{ name: string }>(`
      SELECT c.relname AS name
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'fractal' AND c.relkind IN ('r', 'p')
    `);
    const indexResult = await client.query<{ name: string }>(`
      SELECT c.relname AS name
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'fractal' AND c.relkind = 'i'
    `);
    const constraintResult = await client.query<{ name: string }>(`
      SELECT con.conname AS name
      FROM pg_constraint con
      INNER JOIN pg_class rel ON rel.oid = con.conrelid
      INNER JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'fractal'
    `);

    const actualTables = new Set(tableResult.rows.map((row) => row.name.toLowerCase()));
    const actualIndexes = new Set(indexResult.rows.map((row) => row.name.toLowerCase()));
    const actualConstraints = new Set(constraintResult.rows.map((row) => row.name.toLowerCase()));
    const missingTables = expected.tables.filter((name) => !actualTables.has(name));
    const missingIndexes = expected.indexes.filter((name) => !actualIndexes.has(name));
    const missingConstraints = expected.constraints.filter((name) => !actualConstraints.has(name));

    // Build the canonical expected shape with PostgreSQL itself rather than a
    // second hand-maintained schema manifest. The scratch schema lives only in
    // this transaction and is rolled back before verification returns.
    const expectedDefinitions = await readExpectedSchemaDefinitions(client);
    const actualDefinitions = await readSchemaDefinitions(client, "fractal");
    const definitionDifferences = schemaDefinitionDifferences(expectedDefinitions, actualDefinitions);

    if (missingTables.length || missingIndexes.length || missingConstraints.length || definitionDifferences.length) {
      const missing = [
        missingTables.length ? `tables: ${missingTables.join(", ")}` : null,
        missingIndexes.length ? `indexes: ${missingIndexes.join(", ")}` : null,
        missingConstraints.length ? `constraints: ${missingConstraints.join(", ")}` : null,
        definitionDifferences.length
          ? `definitions: ${definitionDifferences.slice(0, 8).join(", ")}${definitionDifferences.length > 8 ? ` (+${definitionDifferences.length - 8} more)` : ""}`
          : null,
      ]
        .filter(Boolean)
        .join("; ");
      throw new PostgresSchemaDriftError(`Postgres schema drift detected (${missing})`);
    }

    return {
      expectedTables: expected.tables,
      expectedIndexes: expected.indexes,
      expectedConstraints: expected.constraints,
      missingTables,
      missingIndexes,
      missingConstraints,
      expectedDefinitionCount: expectedDefinitions.length,
      definitionDifferences,
    };
  });
}

export async function applyPostgresMigrations(): Promise<string[]> {
  return withMigrationLock(async (client) => {
    await ensureMigrationTable(client);
    const appliedMigrations = await readAppliedMigrations(client);
    assertMigrationLedgerIntegrity(appliedMigrations);
    const applied = new Map(appliedMigrations.map((migration) => [migration.version, migration]));
    const executed: string[] = [];

    for (const migration of migrations) {
      const expectedChecksum = checksum(migration);
      const existing = applied.get(migration.version);
      if (existing) {
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO fractal.schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, expectedChecksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      executed.push(migration.version);
    }

    return executed;
  });
}
