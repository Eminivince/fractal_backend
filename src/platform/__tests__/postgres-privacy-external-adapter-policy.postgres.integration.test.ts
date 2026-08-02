import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import { validPrivacyExternalAdapterPolicy } from "../../testing/privacy-external-adapter-policy.fixture.js";
import { structurallyValidPrivacyExternalAttestationSet } from "../../testing/privacy-external-attestation-set.fixture.js";
import { getAdministratorPrivacyDataInventory } from "../postgres-privacy-rights.js";
import {
  activateDuePlatformConfigurationVersions,
  decidePlatformConfigurationVersion,
  proposePlatformConfigurationVersion,
  proposePlatformConfigurationRollback,
  readActivePlatformConfiguration,
} from "../postgres-platform-configuration.js";

describe("PostgreSQL external privacy adapter policy", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("requires separate capability, exact validation, independent approval, and still refuses live readiness", async () => {
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const configurationOnlyId = randomUUID();
    const marker = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.identities(id,email,legal_name,status,email_verified_at)
       VALUES($1,$2,'External adapter maker','active',now()),
             ($3,$4,'External adapter checker','active',now()),
             ($5,$6,'Configuration-only administrator','active',now())`,
      [makerId, `external-maker-${marker}@example.test`, checkerId, `external-checker-${marker}@example.test`, configurationOnlyId, `external-config-${marker}@example.test`],
    );
    await postgresQuery(
      `INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type)
       VALUES($1,$2,'admin','global'),($3,$4,'admin','global'),($5,$6,'admin','global')`,
      [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), configurationOnlyId],
    );
    await postgresQuery(
      `INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key)
       VALUES($1,$2,'platform_configuration_manage'),($3,$2,'privacy_source_manage'),($4,$2,'privacy_request_manage'),
             ($5,$6,'platform_configuration_manage'),($7,$6,'privacy_source_manage'),
             ($8,$9,'platform_configuration_manage')`,
      [randomUUID(), makerId, randomUUID(), randomUUID(), randomUUID(), checkerId, randomUUID(), randomUUID(), configurationOnlyId],
    );

    const configurationKey = "privacy.external_source.adapter_policy";
    const policy = validPrivacyExternalAdapterPolicy();
    const initialPolicy = await readActivePlatformConfiguration(configurationKey);
    const expectedPolicyProjection = initialPolicy?.projectionVersion ?? null;
    await expect(proposePlatformConfigurationVersion({
      actorIdentityId: configurationOnlyId, configurationKey, proposedValue: policy,
      expectedProjectionVersion: expectedPolicyProjection, effectiveAt: new Date(),
      reason: "A configuration-only administrator must not control external privacy adapters.", commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "forbidden" });

    const invalid = await proposePlatformConfigurationVersion({
      actorIdentityId: makerId, configurationKey,
      proposedValue: { ...policy, sources: policy.sources.slice(1) },
      expectedProjectionVersion: expectedPolicyProjection, effectiveAt: new Date(),
      reason: "Prove that an incomplete external source contract cannot enter the approval queue.", commandKey: randomUUID(),
    });
    expect(invalid.version).toMatchObject({ status: "validation_failed", validationOutput: { valid: false } });
    expect(invalid.version.validationOutput).toEqual(expect.objectContaining({ errors: expect.arrayContaining([expect.stringMatching(/sources/)]) }));

    const proposed = await proposePlatformConfigurationVersion({
      actorIdentityId: makerId, configurationKey, proposedValue: policy,
      expectedProjectionVersion: expectedPolicyProjection, effectiveAt: new Date(Date.now() - 1_000),
      reason: "Submit the exact eleven-source fail-closed adapter contract for independent review.", commandKey: randomUUID(),
    });
    expect(proposed.version).toMatchObject({ status: "pending", validationOutput: { valid: true } });
    await expect(decidePlatformConfigurationVersion({
      actorIdentityId: makerId, versionId: proposed.version.id, action: "approve", expectedStateVersion: 1,
      decisionReason: "A proposer must not approve their own external source contract.", commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "forbidden" });
    await decidePlatformConfigurationVersion({
      actorIdentityId: checkerId, versionId: proposed.version.id, action: "approve", expectedStateVersion: 1,
      decisionReason: "Independently approve the complete contract while retaining the separate live-attestation gate.", commandKey: randomUUID(),
    });
    const activation = await activateDuePlatformConfigurationVersions(new Date());
    expect(activation.failed).toBe(0);
    const activeProjectionVersion = (expectedPolicyProjection ?? 0) + 1;
    expect(await readActivePlatformConfiguration(configurationKey)).toMatchObject({
      versionId: proposed.version.id,
      projectionVersion: activeProjectionVersion,
    });
    await expect(proposePlatformConfigurationRollback({
      actorIdentityId: configurationOnlyId, configurationKey, targetVersionId: proposed.version.id,
      expectedProjectionVersion: activeProjectionVersion, effectiveAt: new Date(),
      reason: "A configuration-only administrator must not roll back the external adapter contract.", commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "forbidden" });

    const inventory = await getAdministratorPrivacyDataInventory({ actorIdentityId: makerId });
    expect(inventory.externalAdapterPolicy).toMatchObject({
      status: "active_contract_only", versionId: proposed.version.id, contractSourceCount: 11,
      runtimeCompatibleSourceCount: 0, liveAttestedSourceCount: 0, blocksAvailability: true,
    });
    expect(inventory.externalAdapterPolicy.missingRuntimeSourceKeys).toHaveLength(11);
    expect(inventory.externalAttestation).toMatchObject({
      validSourceCount: 0, blocksAvailability: true,
    });
    expect(["not_activated", "active_invalid"]).toContain(inventory.externalAttestation.status);
    const externalSources = inventory.authorities.flatMap((authority) => authority.sources)
      .filter((source) => source.kind !== "postgres_relation");
    expect(externalSources).toHaveLength(11);
    expect(externalSources.every((source) => (source.rightsStatus as { access: string }).access === "unavailable")).toBe(true);

    const activePolicy = await readActivePlatformConfiguration(configurationKey);
    expect(activePolicy).not.toBeNull();
    const attestationSet = structurallyValidPrivacyExternalAttestationSet(policy, {
      configurationKey,
      versionId: activePolicy!.versionId,
      versionNumber: activePolicy!.versionNumber,
      projectionVersion: activePolicy!.projectionVersion,
      valueSha256: activePolicy!.valueSha256,
    });
    const initialAttestation = await readActivePlatformConfiguration(
      "privacy.external_source.attestation_set",
    );
    const expectedAttestationProjection = initialAttestation?.projectionVersion ?? null;
    await expect(proposePlatformConfigurationVersion({
      actorIdentityId: configurationOnlyId,
      configurationKey: "privacy.external_source.attestation_set",
      proposedValue: attestationSet,
      expectedProjectionVersion: expectedAttestationProjection,
      effectiveAt: new Date(),
      reason: "A configuration-only administrator must not control signed external-source evidence.",
      commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "forbidden" });
    const refusedAttestations = await proposePlatformConfigurationVersion({
      actorIdentityId: makerId,
      configurationKey: "privacy.external_source.attestation_set",
      proposedValue: attestationSet,
      expectedProjectionVersion: expectedAttestationProjection,
      effectiveAt: new Date(),
      reason: "Prove that untrusted signatures and missing runtime implementations fail before review.",
      commandKey: randomUUID(),
    });
    expect(refusedAttestations.version).toMatchObject({
      status: "validation_failed",
      validationOutput: { valid: false },
    });
    expect(refusedAttestations.version.validationOutput).toEqual(expect.objectContaining({
      errors: expect.arrayContaining([
        expect.stringMatching(/runtime_missing/),
        expect.stringMatching(/key_unknown/),
        expect.stringMatching(/At least one external source/),
      ]),
    }));
  });
});
