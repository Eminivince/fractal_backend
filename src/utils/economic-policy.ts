import { HttpError } from "./errors.js";
import { hashPayload } from "./idempotency.js";

export interface EconomicPolicyInput {
  version: number;
  policyType: string;
  config: Record<string, unknown>;
}

export function normalizeEconomicPolicy(
  policy: Partial<EconomicPolicyInput> | undefined,
  templateCode: "A" | "B",
): EconomicPolicyInput {
  if (!policy) {
    return {
      version: 1,
      policyType: templateCode === "A" ? "rental_distribution" : "milestone_tranche",
      config: {},
    };
  }

  if (!policy.version || policy.version <= 0) throw new HttpError(422, "economicPolicy.version must be > 0");
  if (!policy.policyType || policy.policyType.trim().length < 2) {
    throw new HttpError(422, "economicPolicy.policyType is required");
  }
  if (!policy.config || typeof policy.config !== "object" || Array.isArray(policy.config)) {
    throw new HttpError(422, "economicPolicy.config must be an object");
  }

  return {
    version: policy.version,
    policyType: policy.policyType.trim(),
    config: policy.config,
  };
}

export function isEconomicPolicyValid(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") return false;
  const row = policy as Record<string, unknown>;
  const version = row.version;
  const policyType = row.policyType;
  const config = row.config;

  if (typeof version !== "number" || version <= 0) return false;
  if (typeof policyType !== "string" || policyType.trim().length < 2) return false;
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  return true;
}

export function economicPolicyHash(policy: EconomicPolicyInput): string {
  return hashPayload(policy);
}
