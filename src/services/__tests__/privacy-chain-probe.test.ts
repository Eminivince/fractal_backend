import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrivacyExternalAdapterPolicy } from "../../modules/privacy/domain/privacy-external-adapter-policy.js";
import type { ChainPrivacyRecord } from "../../platform/postgres-chain-privacy-references.js";
import { validPrivacyExternalAdapterPolicy } from "../../testing/privacy-external-adapter-policy.fixture.js";
import { hashPayload } from "../../utils/idempotency.js";
import {
  CHAIN_PRIVACY_ADAPTER_KEY,
  CHAIN_PRIVACY_ADAPTER_VERSION,
  CHAIN_PRIVACY_OUTPUT_FIELDS,
} from "../privacy-external-chain-adapter.js";
import {
  type PrivacyChainProbeJob,
  runPrivacyChainProbe,
} from "../privacy-chain-probe.js";

const wallet = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";
const transaction = `0x${"3".repeat(64)}`;
const chainId = 11155111;
const rpcUrl = "https://secret-token.rpc.example/v1/private-token";
const publicRpcAddress = "8.8.8.8";

function endpointSha256(value: string): string {
  return createHash("sha256").update(new URL(value).href).digest("hex");
}

function policy(): PrivacyExternalAdapterPolicy {
  const value = validPrivacyExternalAdapterPolicy();
  const source = value.sources.find(
    (candidate) => candidate.sourceKey === "external.chain.public_records",
  )!;
  source.implementation = {
    adapterKey: CHAIN_PRIVACY_ADAPTER_KEY,
    version: CHAIN_PRIVACY_ADAPTER_VERSION,
    sha256: "3".repeat(64),
    releaseBinding: "exact_release_sha256",
  };
  source.correlation = {
    mode: "exact_wallet_binding",
    referenceFields: ["walletAddress", "transactionHash"],
    maximumSubjectsPerRecord: 1,
    ambiguityBehavior: "reject",
    unmatchedBehavior: "remain_unlinked",
  };
  source.fields = CHAIN_PRIVACY_OUTPUT_FIELDS.map((field) => ({
    sourceField: field,
    outputField: field,
    classification: "public_record" as const,
    handling: "include" as const,
    reason: "This field is part of the bounded public-chain disclosure record.",
  }));
  source.fields.push({
    sourceField: "rpcUrlAndInternalExecution",
    outputField: null,
    classification: "secret_or_internal",
    handling: "omit",
    reason: "RPC credentials and internal chain execution data are excluded.",
  });
  return value;
}

function job(
  publicKeyPem: string,
  activePolicy: PrivacyExternalAdapterPolicy,
): PrivacyChainProbeJob {
  const evidenceHash = "1".repeat(64);
  const source = activePolicy.sources.find(
    (candidate) => candidate.sourceKey === "external.chain.public_records",
  )!;
  return {
    schemaVersion: "privacy-chain-probe-job-v2",
    probeReference: "PRIVACY-CHAIN-PROBE-2026-07-26",
    identityId: "0f63af0e-ffda-47de-9319-c6175655034b",
    policyBinding: {
      configurationKey: "privacy.external_source.adapter_policy",
      versionId: "7b09a632-f144-4a96-b9b1-2e45ad0822be",
      versionNumber: 5,
      projectionVersion: 10,
      valueSha256: hashPayload(activePolicy),
    },
    implementation: {
      adapterKey: CHAIN_PRIVACY_ADAPTER_KEY,
      version: CHAIN_PRIVACY_ADAPTER_VERSION,
      sha256: "3".repeat(64),
      releaseSha256: "4".repeat(64),
    },
    coverage: {
      inventoryVersion: source.coverage!.inventoryVersion,
      componentKeys: [...source.coverage!.componentKeys],
    },
    provider: {
      environment: "production",
      accountReference: "Approved production chain RPC account reference",
      regionReference: "Approved chain processing region register entry",
    },
    chains: [{
      chainId,
      endpointReference: "Approved production Sepolia RPC endpoint reference",
      endpointSha256: endpointSha256(rpcUrl),
    }],
    execution: {
      timeoutMs: source.execution.timeoutMs,
      maximumRecords: source.execution.maximumRecords,
      maximumBytes: source.execution.maximumBytes,
      evidenceMaximumAgeSeconds: source.execution.evidenceMaximumAgeSeconds,
    },
    governedEvidence: {
      portability: evidenceHash,
      correction: evidenceHash,
      erasure: evidenceHash,
      restriction: evidenceHash,
      objection: evidenceHash,
      residency: evidenceHash,
      retention: evidenceHash,
      deletion: evidenceHash,
      security: evidenceHash,
    },
    signer: {
      keyId: "privacy-probe-2026-01",
      publicKeyPem,
    },
  };
}

function references(): ChainPrivacyRecord[] {
  return [{
    recordType: "wallet",
    chainId,
    walletAddress: wallet,
  }, {
    recordType: "allocation_transaction",
    chainId,
    walletAddress: wallet,
    transactionHash: transaction,
    tokenContractAddress: contract,
    operationType: "mint",
  }];
}

function rpcResponse(result = "0xaa36a7"): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: chainId,
    result,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("independent public-chain privacy probe", () => {
  it("creates signed evidence without subject records or RPC credentials", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    const fetchImplementation = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        method: "eth_chainId",
        params: [],
      });
      return rpcResponse();
    });
    const result = await runPrivacyChainProbe({
      job: job(publicKeyPem, activePolicy),
      policy: activePolicy,
      references: references(),
      rpcEndpoints: new Map([[chainId, rpcUrl]]),
      signer: async (payload) => sign(null, payload, keys.privateKey).toString("base64"),
      now: new Date("2026-07-26T08:05:00.000Z"),
      fetchImplementation,
      resolveHostname: async () => [publicRpcAddress],
    });
    expect(result).toMatchObject({
      schemaVersion: "privacy-chain-probe-result-v1",
      chainCount: 1,
      recordCount: 2,
      attestation: {
        payload: {
          sourceKey: "external.chain.public_records",
          observedAt: "2026-07-26T08:05:00.000Z",
          expiresAt: "2026-07-26T09:05:00.000Z",
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(wallet);
    expect(serialized).not.toContain(transaction);
    expect(serialized).not.toContain(rpcUrl);
  });

  it("rejects the wrong chain, an incomplete endpoint set, and unsafe policy fields", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    const common = {
      job: job(publicKeyPem, activePolicy),
      policy: activePolicy,
      references: references(),
      signer: async (payload: Uint8Array) =>
        sign(null, payload, keys.privateKey).toString("base64"),
      resolveHostname: async () => [publicRpcAddress],
    };
    await expect(runPrivacyChainProbe({
      ...common,
      rpcEndpoints: new Map([[chainId, rpcUrl]]),
      fetchImplementation: async () => rpcResponse("0x1"),
    })).rejects.toThrow("wrong chain ID");
    await expect(runPrivacyChainProbe({
      ...common,
      rpcEndpoints: new Map(),
      fetchImplementation: async () => rpcResponse(),
    })).rejects.toThrow("does not match");
    const privateEndpoint = "https://127.0.0.1/rpc";
    const privateEndpointJob = job(publicKeyPem, activePolicy);
    privateEndpointJob.chains[0]!.endpointSha256 = endpointSha256(privateEndpoint);
    await expect(runPrivacyChainProbe({
      ...common,
      job: privateEndpointJob,
      rpcEndpoints: new Map([[chainId, privateEndpoint]]),
      fetchImplementation: async () => {
        throw new Error("Private host access must not occur");
      },
    })).rejects.toThrow("unsafe network address");
    await expect(runPrivacyChainProbe({
      ...common,
      rpcEndpoints: new Map([[chainId, rpcUrl]]),
      resolveHostname: async () => ["10.0.0.5"],
      fetchImplementation: async () => {
        throw new Error("Private resolved address access must not occur");
      },
    })).rejects.toThrow("unsafe network address");
    const wrongEndpointJob = job(publicKeyPem, activePolicy);
    wrongEndpointJob.chains[0]!.endpointSha256 = "9".repeat(64);
    await expect(runPrivacyChainProbe({
      ...common,
      job: wrongEndpointJob,
      rpcEndpoints: new Map([[chainId, rpcUrl]]),
      fetchImplementation: async () => {
        throw new Error("Unapproved endpoint access must not occur");
      },
    })).rejects.toThrow("approved endpoint hash");
    const unsafePolicy = policy();
    unsafePolicy.sources.find(
      (candidate) => candidate.sourceKey === "external.chain.public_records",
    )!.fields[0]!.outputField = "rpcUrl";
    await expect(runPrivacyChainProbe({
      ...common,
      job: job(publicKeyPem, unsafePolicy),
      policy: unsafePolicy,
      rpcEndpoints: new Map([[chainId, rpcUrl]]),
      fetchImplementation: async () => {
        throw new Error("RPC access must not occur");
      },
    })).rejects.toThrow("safe output fields");
  });

  it("rejects an incomplete component inventory before RPC access", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    const alteredJob = job(publicKeyPem, activePolicy);
    alteredJob.coverage.componentKeys = ["verified_wallet_links"];
    await expect(runPrivacyChainProbe({
      job: alteredJob,
      policy: activePolicy,
      references: references(),
      rpcEndpoints: new Map([[chainId, rpcUrl]]),
      signer: async (payload) => sign(null, payload, keys.privateKey).toString("base64"),
      fetchImplementation: async () => {
        throw new Error("RPC access must not occur");
      },
      resolveHostname: async () => [publicRpcAddress],
    })).rejects.toThrow("exact public-chain component inventory");
  });
});
