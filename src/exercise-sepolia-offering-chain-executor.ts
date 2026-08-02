/**
 * Deliberately explicit, no-funds Sepolia smoke exercise for the governed
 * offering-chain executor. It creates a separate local PostgreSQL database
 * record and a real testnet token, but never mints a token or moves payout
 * assets. Do not use this as a production issuance workflow.
 */
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "./db/postgres.js";
import { applyPostgresMigrations } from "./db/postgres-migrations/index.js";
import { submitOfferingPublicationRequest, decideOfferingPublicationRequest } from "./platform/postgres-offering-governance.js";
import { decideOfferingChainDeploymentRequest, submitOfferingChainDeploymentRequest } from "./platform/postgres-offering-chain-deployments.js";
import { decideOfferingIssuanceTerms, submitOfferingIssuanceTerms } from "./platform/postgres-offering-issuance-terms.js";
import { recordAllocationPolicyEvidence } from "./platform/postgres-governance-evidence.js";
import { recordOfferingPublicationEvidence } from "./platform/postgres-offering-publication-evidence.js";
import { decideAssetApplicationRequest, recordAssetApplicationEvidence, submitAssetApplicationRequest } from "./platform/postgres-asset-applications.js";
import { dispatchOfferingChainDeployments } from "./services/postgres-offering-chain-executor.js";

const confirmation = process.env.TESTNET_CHAIN_EXECUTION_CONFIRMATION;
if (confirmation !== "I_UNDERSTAND_TESTNET_ISSUANCE") {
  throw new Error("Set TESTNET_CHAIN_EXECUTION_CONFIRMATION=I_UNDERSTAND_TESTNET_ISSUANCE to run the Sepolia executor smoke exercise");
}
if (env.CHAIN_ID !== 11155111) throw new Error("This smoke exercise is Sepolia-only");
if (!env.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED) throw new Error("CHAIN_DEPLOYMENT_EXECUTOR_ENABLED must be true for this smoke exercise");
const tokenFactoryAddress = env.TOKEN_FACTORY_ADDRESS ?? (() => { throw new Error("TOKEN_FACTORY_ADDRESS must be configured"); })();

const logger = {
  info: (obj: unknown, message?: string) => console.log(message ?? "info", JSON.stringify(obj)),
  error: (obj: unknown, message?: string) => console.error(message ?? "error", obj),
};

async function main() {
  await connectPostgres({ required: true });
  await applyPostgresMigrations();
  const suffix = randomUUID();
  const organizationId = randomUUID();
  const makerId = randomUUID();
  const checkerId = randomUUID();
  const reference = `sepolia-executor-smoke-${suffix}`;
  const tokenSymbol = `FS${suffix.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const now = Date.now();
  const agreementHash = "a".repeat(64);
  const disclosureHash = "b".repeat(64);

  try {
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, $2, 'active')", [organizationId, `Sepolia executor smoke ${suffix}`]);
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Smoke maker', 'active'), ($3, $4, 'Smoke checker', 'active')",
      [makerId, `sepolia-maker-${suffix}@example.test`, checkerId, `sepolia-checker-${suffix}@example.test`],
    );
    const agreementEvidence = await recordOfferingPublicationEvidence({ organizationId, evidenceKind: "agreement", uploadedByIdentityId: makerId, filename: "sepolia-smoke-agreement.pdf", mimeType: "application/pdf", storageKey: `local://sepolia-smoke/${suffix}-agreement.pdf`, contentSha256: agreementHash, bytes: 128 });
    const disclosureEvidence = await recordOfferingPublicationEvidence({ organizationId, evidenceKind: "disclosure_bundle", uploadedByIdentityId: makerId, filename: "sepolia-smoke-disclosure.pdf", mimeType: "application/pdf", storageKey: `local://sepolia-smoke/${suffix}-disclosure.pdf`, contentSha256: disclosureHash, bytes: 128 });
    const assetEvidence = await recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: makerId, filename: "sepolia-smoke-asset-dossier.pdf", mimeType: "application/pdf", storageKey: `local://sepolia-smoke/${suffix}-asset.pdf`, contentSha256: "c".repeat(64), bytes: 128 });
    const assetApplication = await submitAssetApplicationRequest({ organizationId, submittedByIdentityId: makerId, applicationReference: `APP-${suffix}`, applicationVersion: 1, assetName: "Sepolia smoke asset", assetType: "test infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "Isolated testnet-only asset approval used for a no-funds executor smoke exercise.", requestedCapacityMinor: 100_000, currency: "NGN", dossierEvidenceDocumentId: assetEvidence.evidenceDocumentId });
    const approvedAssetApplication = await decideAssetApplicationRequest({ requestId: assetApplication.requestId, decidedByIdentityId: checkerId, approve: true });
    if (!approvedAssetApplication.approvedApplicationVersionId) throw new Error("Approved smoke asset application did not create an immutable origin version");
    const publication = await submitOfferingPublicationRequest({
      organizationId, submittedByIdentityId: makerId, publicReference: reference, currency: "NGN", capacityMinor: 100_000,
      opensAt: new Date(now - 60_000), closesAt: new Date(now + 24 * 60 * 60 * 1_000),
      terms: {
        name: "Sepolia executor smoke only",
        publicSlug: `sepolia-smoke-${suffix}`,
        minimumTicketMinor: 10_000,
        assetClass: "infrastructure",
        summary: "A testnet-only governed offering used to exercise the Sepolia chain executor.",
        thesis: "This controlled smoke record validates the deployment path and is not an investment solicitation.",
        targetReturnBps: 1,
        termMonths: 1,
        riskSummary: "This is isolated testnet evidence only and has no monetary value or production investment rights.",
        incomeSource: "No production income source; this record exists only for testnet validation.",
        structure: "An isolated testnet-only deployment with no production capital or investor rights.",
        security: "No production security package applies to this testnet-only smoke exercise.",
        feeSummary: "No fees apply because this is a testnet-only smoke exercise.",
        nextMilestone: "Confirm the governed Sepolia deployment operation and retain its evidence.",
        testnetOnly: true,
      },
      eligibilityPolicy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"] },
      agreementEvidenceDocumentId: agreementEvidence.evidenceDocumentId, disclosureEvidenceDocumentId: disclosureEvidence.evidenceDocumentId,
      approvedAssetApplicationVersionId: approvedAssetApplication.approvedApplicationVersionId,
    });
    const published = await decideOfferingPublicationRequest({ requestId: publication.requestId, decidedByIdentityId: checkerId, approve: true });
    if (!published.offeringId) throw new Error("Approved smoke publication did not create an offering");
    const evidence = await recordAllocationPolicyEvidence({ organizationId, offeringId: published.offeringId, uploadedByIdentityId: makerId, filename: "sepolia-smoke-allocation-policy.pdf", mimeType: "application/pdf", storageKey: `local://sepolia-smoke/${suffix}.pdf`, contentSha256: disclosureHash, bytes: 128 });
    const issuanceTerms = await submitOfferingIssuanceTerms({ organizationId, offeringId: published.offeringId, submittedByIdentityId: makerId, tokenUnitPriceMinor: 100, maxTotalSupply: 1_000, allocationPolicyEvidenceDocumentId: evidence.evidenceDocumentId });
    await decideOfferingIssuanceTerms({ requestId: issuanceTerms.requestId, decidedByIdentityId: checkerId, approve: true });
    const deployment = await submitOfferingChainDeploymentRequest({
      organizationId, offeringId: published.offeringId, submittedByIdentityId: makerId, chainId: env.CHAIN_ID,
      tokenFactoryAddress, offeringName: "Sepolia executor smoke only",
      tokenName: `Fractal Sepolia Smoke ${suffix.slice(0, 8)}`, tokenSymbol, issuanceTermsRequestId: issuanceTerms.requestId, maxBalancePerHolder: 1_000, retailCap: 100,
    });
    const approved = await decideOfferingChainDeploymentRequest({ requestId: deployment.requestId, decidedByIdentityId: checkerId, approve: true });
    if (!approved.operationId) throw new Error("Approved chain deployment did not create an operation");
    await dispatchOfferingChainDeployments({ logger, workerId: `sepolia-smoke-${suffix}` });
    const operation = await postgresQuery<{
      status: string; transaction_hash: string | null; token_contract_address: string | null; block_number: string | null;
    }>("SELECT status, transaction_hash, token_contract_address, block_number FROM fractal.offering_chain_operations WHERE id = $1", [approved.operationId]);
    const result = operation.rows[0];
    if (!result || result.status !== "confirmed" || !result.transaction_hash || !result.token_contract_address || !result.block_number) {
      throw new Error(`Sepolia executor smoke did not confirm: ${JSON.stringify(result ?? null)}`);
    }
    console.log(JSON.stringify({ status: result.status, reference, operationId: approved.operationId, transactionHash: result.transaction_hash, tokenContractAddress: result.token_contract_address, blockNumber: result.block_number }));
  } finally {
    await disconnectPostgres();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
