import type { PoolClient } from "pg";
import {
  parsePrivacyExternalAdapterPolicy,
} from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import {
  evaluateExternalPrivacyAdapterRuntime,
  externalPrivacyAdapterRuntimeRegistry,
} from "./privacy-external-adapter-registry.js";

export {
  evaluateExternalPrivacyAdapterRuntime,
  externalPrivacyAdapterRuntimeRegistry,
  type ExternalPrivacyAdapterRuntimeDescriptor,
} from "./privacy-external-adapter-registry.js";

export const EXTERNAL_PRIVACY_ADAPTER_POLICY_KEY = "privacy.external_source.adapter_policy";

export async function readActiveExternalPrivacyAdapterPolicyForBinding(
  client: PoolClient,
  registry = externalPrivacyAdapterRuntimeRegistry,
) {
  const binding = await readActivePlatformConfigurationForBinding(client, EXTERNAL_PRIVACY_ADAPTER_POLICY_KEY);
  if (!binding) return null;
  const policy = parsePrivacyExternalAdapterPolicy(binding.value);
  return { binding, policy, runtime: evaluateExternalPrivacyAdapterRuntime(policy, registry) };
}
