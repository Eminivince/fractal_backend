import { createHash } from "node:crypto";
import {
  externalPrivacySourceKeys,
  type PrivacyExternalAdapterPolicy,
} from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import {
  requiredExternalPrivacyCoverage,
} from "../modules/privacy/domain/privacy-external-coverage.js";

export function privacyAdapterDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function validPrivacyExternalAdapterPolicy(): PrivacyExternalAdapterPolicy {
  return {
    schemaVersion: "privacy-external-source-adapter-policy-v2",
    policyReference: "PRIVACY-EXTERNAL-TEST-1",
    policyName: "Approved external privacy adapter policy",
    jurisdictionCode: "NG",
    controllerReference: "Controller register entry approved by accountable privacy leadership.",
    sources: externalPrivacySourceKeys.map((sourceKey) => {
      const immutable = sourceKey === "external.chain.public_records";
      return {
        sourceKey,
        implementation: {
          adapterKey: `${sourceKey}.adapter.v1`, version: "1.0.0", sha256: privacyAdapterDigest(sourceKey), releaseBinding: "exact_release_sha256" as const,
        },
        collectionMode: immutable ? "public_immutable_disclosure" as const : "live_api" as const,
        correlation: {
          mode: immutable ? "exact_wallet_binding" as const : "exact_provider_reference" as const,
          referenceFields: [immutable ? "walletAddress" : "providerReference"], maximumSubjectsPerRecord: 1,
          ambiguityBehavior: "reject" as const, unmatchedBehavior: "remain_unlinked" as const,
        },
        rights: {
          access: immutable
            ? { mode: "immutable_disclosure" as const, legalReason: "Public-chain records are disclosed as immutable and cannot be removed from consensus history." }
            : { mode: "collect" as const, operationReference: "Provider access operation and canonical safe-field projection." },
          portability: { mode: "collect" as const, operationReference: "Provider portability operation and canonical safe-field projection." },
          correction: { mode: "provider_action" as const, operationReference: "Governed provider correction workflow with outcome evidence." },
          erasure: immutable
            ? { mode: "not_applicable" as const, legalReason: "Consensus records cannot be erased; linked off-chain records remain separately governed." }
            : { mode: "provider_action" as const, operationReference: "Governed provider erasure workflow with outcome evidence." },
          restriction: { mode: "provider_action" as const, operationReference: "Governed provider restriction workflow with outcome evidence." },
          objection: { mode: "provider_action" as const, operationReference: "Governed provider objection workflow with outcome evidence." },
        },
        fields: [{
          sourceField: immutable ? "transactionHash" : "providerStatus", outputField: immutable ? "transactionHash" : "status",
          classification: immutable ? "public_record" as const : "personal_metadata" as const,
          handling: "include" as const, reason: "This bounded field is necessary to provide the requested lifecycle record.",
        }, {
          sourceField: "internalDiagnostic", outputField: null, classification: "secret_or_internal" as const,
          handling: "omit" as const, reason: "Internal diagnostics are excluded from data-subject package content.",
        }],
        execution: {
          timeoutMs: 10_000, maximumRecords: 10_000, maximumBytes: 10 * 1024 * 1024,
          evidenceMaximumAgeSeconds: 3_600, deterministicOrdering: true, failClosed: true,
          retryPolicy: "bounded_no_automatic_rights_side_effect" as const, requiresProductionAttestation: true,
        },
        governance: {
          processorAgreementReference: "Processor agreement register reference approved by legal and procurement.",
          lawfulBasisReference: "Applicable lawful basis and rights-handling register reference.",
          retentionPolicyReference: "Approved retention schedule and exception handling reference.",
          subprocessorInventoryReference: "Approved subprocessor inventory and change-control reference.",
          securityControlReference: "Security controls, access review, encryption, and incident response reference.",
          deletionSemantics: "Deletion covers provider production copies and returns durable outcome evidence or a lawful refusal.",
          residencyRegions: ["NG", "EU"],
        },
        coverage: requiredExternalPrivacyCoverage(sourceKey),
      };
    }),
  };
}
