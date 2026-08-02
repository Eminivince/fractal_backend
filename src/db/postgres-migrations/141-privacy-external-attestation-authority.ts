import type { PostgresMigration } from "./types.js";

/** Add the governed set of signed production evidence for external sources. */
export const privacyExternalAttestationAuthorityMigration: PostgresMigration = {
  version: "141-privacy-external-attestation-authority",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding)
    VALUES(
      'privacy.external_source.attestation_set',
      'External privacy source attestation set',
      'Signed and time-limited production evidence for the exact active external-source policy, runtime implementations, provider environments, release, and conformance results. Proposal and activation fail unless all eleven sources pass cryptographic and binding checks.',
      'json',
      '{"type":"object","required":["schemaVersion","setReference","generatedAt","attestations"],"operationalValidator":"privacy_external_source_attestation_set_v1","exactExternalSourceCount":11,"signatureAlgorithm":"Ed25519","revalidatedAtActivation":true,"revalidatedAtRead":true}'::jsonb,
      'next_request'
    ) ON CONFLICT(configuration_key) DO NOTHING;
  `,
};
