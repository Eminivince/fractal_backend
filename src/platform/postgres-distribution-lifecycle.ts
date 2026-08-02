import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { parseDistributionLifecyclePolicy, type DistributionLifecycleRecordClass } from "../modules/distributions/domain/distribution-lifecycle-policy.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";

export type DistributionLifecycleTargetType = "ownership_snapshot" | "distribution_declaration" | "distribution_payout_exception" | "distribution_tax_remittance";

export class DistributionLifecyclePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistributionLifecyclePolicyError";
  }
}

const recordClassByTarget: Record<DistributionLifecycleTargetType, DistributionLifecycleRecordClass> = {
  ownership_snapshot: "ownership_snapshot",
  distribution_declaration: "distribution_declaration",
  distribution_payout_exception: "payout_exception",
  distribution_tax_remittance: "tax_remittance",
};

export async function bindDistributionLifecyclePolicy(client: PoolClient, input: {
  targetType: DistributionLifecycleTargetType;
  targetId: string;
  organizationId: string;
  retentionStartedAt: Date;
}) {
  const organization = await client.query<{ jurisdiction_code: string | null }>("SELECT jurisdiction_code FROM fractal.organizations WHERE id=$1", [input.organizationId]);
  const jurisdictionCode = organization.rows[0]?.jurisdiction_code;
  if (!jurisdictionCode) throw new DistributionLifecyclePolicyError("Distribution processing is unavailable until the organization has an approved jurisdiction.");
  const binding = await readActivePlatformConfigurationForBinding(client, "privacy.distribution.lifecycle_policy");
  if (!binding) throw new DistributionLifecyclePolicyError("Distribution processing is unavailable until an approved lifecycle and privacy-treatment policy is active.");
  const policy = parseDistributionLifecyclePolicy(binding.value);
  const jurisdiction = policy.jurisdictions[jurisdictionCode];
  const recordClass = recordClassByTarget[input.targetType];
  const rule = jurisdiction?.rules[recordClass];
  if (!jurisdiction || !rule) throw new DistributionLifecyclePolicyError(`The active distribution lifecycle policy does not cover ${jurisdictionCode}/${recordClass}.`);
  const retainUntil = new Date(input.retentionStartedAt.getTime() + rule.retentionDays * 86_400_000);
  const id = randomUUID();
  await client.query(`INSERT INTO fractal.distribution_lifecycle_policy_bindings(
    id,target_type,target_id,organization_id,record_class,configuration_key,policy_version_id,policy_version_number,
    policy_projection_version,policy_value_sha256,policy_reference,policy_name,policy_schema_version,jurisdiction_code,
    legal_basis_reference,retention_days,correction_treatment,erasure_treatment,restriction_treatment,objection_treatment,
    retention_started_at,retain_until)
    VALUES($1,$2,$3,$4,$5,'privacy.distribution.lifecycle_policy',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, [
    id,input.targetType,input.targetId,input.organizationId,recordClass,binding.versionId,binding.versionNumber,binding.projectionVersion,
    binding.valueSha256,policy.policyReference,policy.policyName,policy.schemaVersion,jurisdictionCode,jurisdiction.legalBasisReference,
    rule.retentionDays,rule.correctionTreatment,rule.erasureTreatment,rule.restrictionTreatment,rule.objectionTreatment,input.retentionStartedAt,retainUntil,
  ]);
  return { id, policyVersionId: binding.versionId, policyReference: policy.policyReference, recordClass, retentionDays: rule.retentionDays, retainUntil };
}
