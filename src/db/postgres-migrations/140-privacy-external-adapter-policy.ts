import type { PostgresMigration } from "./types.js";

/** Govern the exact contract for every known external privacy source without claiming live adapter evidence. */
export const privacyExternalAdapterPolicyMigration: PostgresMigration = {
  version: "140-privacy-external-adapter-policy",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions(capability_key,label,description)
    VALUES(
      'privacy_source_manage',
      'External privacy source governance',
      'Propose, review, activate, and roll back exact external privacy-source adapter contracts; live conformance evidence remains separately required.'
    ) ON CONFLICT(capability_key) DO NOTHING;

    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding)
    VALUES(
      'privacy.external_source.adapter_policy',
      'External privacy source adapter policy',
      'Exact versioned contract for all declared external privacy sources, including implementation binding, correlation, field minimization, rights operations, execution bounds, residency, retention, processor, and fail-closed requirements. Activation is not live-provider attestation and does not change source availability.',
      'json',
      '{"type":"object","required":["schemaVersion","policyReference","policyName","jurisdictionCode","controllerReference","sources"],"operationalValidator":"privacy_external_source_adapter_policy_v1","exactExternalSourceCount":11,"requiresSeparateLiveAttestation":true}'::jsonb,
      'next_request'
    ) ON CONFLICT(configuration_key) DO NOTHING;
  `,
};
