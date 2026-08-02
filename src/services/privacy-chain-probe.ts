import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import {
  privacyExternalAdapterPolicySchema,
} from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import {
  EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
  requiredExternalPrivacyCoverage,
} from "../modules/privacy/domain/privacy-external-coverage.js";
import {
  externalPrivacyAttestationEvidenceKeys,
  privacyExternalAttestationPayloadSchema,
  privacyExternalSignedAttestationSchema,
  type PrivacyExternalAttestationPayload,
  type PrivacyExternalSignedAttestation,
} from "../modules/privacy/domain/privacy-external-attestation-set.js";
import type { ChainPrivacyRecord } from "../platform/postgres-chain-privacy-references.js";
import { hashPayload, stableJsonStringify } from "../utils/idempotency.js";
import {
  CHAIN_PRIVACY_ADAPTER_KEY,
  CHAIN_PRIVACY_ADAPTER_VERSION,
  CHAIN_PRIVACY_OUTPUT_FIELDS,
  collectPublicChainPrivacyRecords,
} from "./privacy-external-chain-adapter.js";
import type { PrivacyProbeSigner } from "./privacy-resend-probe.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const evidenceReferenceSchema = z.object({
  portability: sha256Schema,
  correction: sha256Schema,
  erasure: sha256Schema,
  restriction: sha256Schema,
  objection: sha256Schema,
  residency: sha256Schema,
  retention: sha256Schema,
  deletion: sha256Schema,
  security: sha256Schema,
}).strict();

export const privacyChainProbeJobSchema = z.object({
  schemaVersion: z.literal("privacy-chain-probe-job-v2"),
  probeReference: z.string().trim().min(10).max(160),
  identityId: z.string().uuid(),
  policyBinding: z.object({
    configurationKey: z.literal("privacy.external_source.adapter_policy"),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    projectionVersion: z.number().int().positive(),
    valueSha256: sha256Schema,
  }).strict(),
  implementation: z.object({
    adapterKey: z.literal(CHAIN_PRIVACY_ADAPTER_KEY),
    version: z.literal(CHAIN_PRIVACY_ADAPTER_VERSION),
    sha256: sha256Schema,
    releaseSha256: sha256Schema,
  }).strict(),
  coverage: z.object({
    inventoryVersion: z.literal(EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION),
    componentKeys: z.array(
      z.string().regex(/^[a-z][a-z0-9_]{2,119}$/),
    ).min(1).max(32),
  }).strict(),
  provider: z.object({
    environment: z.literal("production"),
    accountReference: z.string().trim().min(10).max(500),
    regionReference: z.string().trim().min(10).max(500),
  }).strict(),
  chains: z.array(z.object({
    chainId: z.number().int().positive(),
    endpointReference: z.string().trim().min(10).max(500),
    endpointSha256: sha256Schema,
  }).strict()).min(1).max(20),
  execution: z.object({
    timeoutMs: z.number().int().min(500).max(120_000),
    maximumRecords: z.number().int().min(1).max(100_000),
    maximumBytes: z.number().int().min(1_024).max(100 * 1024 * 1024),
    evidenceMaximumAgeSeconds: z.number().int().min(30).max(604_800),
  }).strict(),
  governedEvidence: evidenceReferenceSchema,
  signer: z.object({
    keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    publicKeyPem: z.string().min(80).max(2_000),
  }).strict(),
}).strict().superRefine((job, context) => {
  const chainIds = job.chains.map((chain) => chain.chainId);
  const endpointReferences = job.chains.map((chain) => chain.endpointReference);
  if (new Set(chainIds).size !== chainIds.length) {
    context.addIssue({ code: "custom", path: ["chains"], message: "Probe chain IDs must be unique." });
  }
  if (new Set(endpointReferences).size !== endpointReferences.length) {
    context.addIssue({ code: "custom", path: ["chains"], message: "Probe endpoint references must be unique." });
  }
  if (new Set(job.chains.map((chain) => chain.endpointSha256)).size !== job.chains.length) {
    context.addIssue({ code: "custom", path: ["chains"], message: "Probe endpoint hashes must be unique." });
  }
});

export type PrivacyChainProbeJob = z.infer<typeof privacyChainProbeJobSchema>;

export const privacyChainProbeResultSchema = z.object({
  schemaVersion: z.literal("privacy-chain-probe-result-v1"),
  probeReference: z.string().trim().min(10).max(160),
  generatedAt: z.string().datetime({ offset: true }),
  chainCount: z.number().int().positive(),
  recordCount: z.number().int().nonnegative(),
  attestation: privacyExternalSignedAttestationSchema,
}).strict();

export type PrivacyChainProbeResult = z.infer<typeof privacyChainProbeResultSchema>;

export class PrivacyChainProbeError extends Error {}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ResolveHostname = (hostname: string) => Promise<readonly string[]>;

const unsafeNetworkAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  unsafeNetworkAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  unsafeNetworkAddresses.addSubnet(network, prefix, "ipv6");
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(stableJsonStringify(value))
    .digest("hex");
}

function assertEd25519PublicKey(publicKeyPem: string) {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new PrivacyChainProbeError("The probe public key must use Ed25519");
    }
    return publicKey;
  } catch (error) {
    if (error instanceof PrivacyChainProbeError) throw error;
    throw new PrivacyChainProbeError("The probe public key is invalid");
  }
}

function assertPublicNetworkAddress(address: string): void {
  const family = isIP(address);
  if (
    family === 0
    || unsafeNetworkAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
  ) {
    throw new PrivacyChainProbeError("A chain RPC endpoint resolved to an unsafe network address");
  }
}

async function resolvePublicHostname(
  hostname: string,
  resolver: ResolveHostname,
): Promise<void> {
  if (isIP(hostname)) {
    assertPublicNetworkAddress(hostname);
    return;
  }
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new PrivacyChainProbeError("A chain RPC endpoint host could not be resolved");
  }
  if (!addresses.length) {
    throw new PrivacyChainProbeError("A chain RPC endpoint host has no network address");
  }
  for (const address of addresses) {
    assertPublicNetworkAddress(address);
  }
}

async function readBoundedRpcResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new PrivacyChainProbeError("A chain RPC endpoint returned an error");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new PrivacyChainProbeError("A chain RPC endpoint returned non-JSON data");
  }
  if (!response.body) {
    throw new PrivacyChainProbeError("A chain RPC endpoint returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > 65_536) {
      await reader.cancel();
      throw new PrivacyChainProbeError("A chain RPC response exceeds the byte limit");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new PrivacyChainProbeError("A chain RPC endpoint returned invalid JSON");
  }
}

async function verifyRpcChain(input: {
  chainId: number;
  endpoint: string;
  endpointSha256: string;
  timeoutMs: number;
  fetchImplementation: FetchImplementation;
  resolveHostname: ResolveHostname;
}): Promise<void> {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new PrivacyChainProbeError("A chain RPC endpoint URL is invalid");
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || (endpoint.port && endpoint.port !== "443")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
  ) {
    throw new PrivacyChainProbeError("A chain RPC endpoint must use an approved public HTTPS host without URL credentials");
  }
  if (
    createHash("sha256").update(endpoint.href, "utf8").digest("hex")
    !== input.endpointSha256
  ) {
    throw new PrivacyChainProbeError("A chain RPC endpoint does not match the approved endpoint hash");
  }
  await resolvePublicHostname(hostname, input.resolveHostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImplementation(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.chainId,
        method: "eth_chainId",
        params: [],
      }),
      signal: controller.signal,
    });
    const value = await readBoundedRpcResponse(response);
    const parsed = z.object({
      jsonrpc: z.literal("2.0"),
      id: z.number().int(),
      result: z.string().regex(/^0x[0-9a-fA-F]+$/),
    }).strict().safeParse(value);
    if (
      !parsed.success
      || parsed.data.id !== input.chainId
      || BigInt(parsed.data.result) !== BigInt(input.chainId)
    ) {
      throw new PrivacyChainProbeError("A chain RPC endpoint returned the wrong chain ID");
    }
  } catch (error) {
    if (error instanceof PrivacyChainProbeError) throw error;
    if (controller.signal.aborted) {
      throw new PrivacyChainProbeError("The chain RPC probe exceeded the time limit");
    }
    throw new PrivacyChainProbeError("The chain RPC probe failed");
  } finally {
    clearTimeout(timer);
  }
}

function buildEvidence(input: {
  sourceLegalReason: string;
  records: readonly ChainPrivacyRecord[];
  chains: readonly PrivacyChainProbeJob["chains"][number][];
  governedEvidence: PrivacyChainProbeJob["governedEvidence"];
}): PrivacyExternalAttestationPayload["evidence"] {
  const evidence = {
    subjectCorrelation: sha256(input.records),
    fieldMinimization: sha256({
      allowedOutputFields: CHAIN_PRIVACY_OUTPUT_FIELDS,
      recordShapeHashes: input.records.map((record) => sha256(Object.keys(record).sort())),
    }),
    access: sha256({
      immutableDisclosureReason: input.sourceLegalReason,
      records: input.records,
    }),
    portability: input.governedEvidence.portability,
    correction: input.governedEvidence.correction,
    erasure: input.governedEvidence.erasure,
    restriction: input.governedEvidence.restriction,
    objection: input.governedEvidence.objection,
    residency: input.governedEvidence.residency,
    retention: input.governedEvidence.retention,
    deletion: input.governedEvidence.deletion,
    security: input.governedEvidence.security,
    providerHealth: sha256({
      reachable: true,
      chainIds: input.chains.map((chain) => chain.chainId).sort((left, right) => left - right),
      endpointReferenceHashes: input.chains
        .map((chain) => sha256(chain.endpointReference))
        .sort(),
      endpointSha256s: input.chains
        .map((chain) => chain.endpointSha256)
        .sort(),
    }),
  };
  if (
    stableJsonStringify(Object.keys(evidence).sort())
    !== stableJsonStringify([...externalPrivacyAttestationEvidenceKeys].sort())
  ) {
    throw new PrivacyChainProbeError("The probe evidence set is incomplete");
  }
  return evidence;
}

export async function runPrivacyChainProbe(input: {
  job: PrivacyChainProbeJob;
  policy: unknown;
  references: readonly ChainPrivacyRecord[];
  rpcEndpoints: ReadonlyMap<number, string>;
  signer: PrivacyProbeSigner;
  now?: Date;
  fetchImplementation?: FetchImplementation;
  resolveHostname?: ResolveHostname;
}): Promise<PrivacyChainProbeResult> {
  const job = privacyChainProbeJobSchema.parse(input.job);
  const policy = privacyExternalAdapterPolicySchema.parse(input.policy);
  if (hashPayload(policy) !== job.policyBinding.valueSha256) {
    throw new PrivacyChainProbeError("The active adapter policy does not match the bound value hash");
  }
  const sourcePolicy = policy.sources.find(
    (source) => source.sourceKey === "external.chain.public_records",
  );
  if (!sourcePolicy) {
    throw new PrivacyChainProbeError("The active adapter policy does not contain the public-chain source");
  }
  if (
    stableJsonStringify(sourcePolicy.implementation) !== stableJsonStringify({
      adapterKey: job.implementation.adapterKey,
      version: job.implementation.version,
      sha256: job.implementation.sha256,
      releaseBinding: "exact_release_sha256",
    })
  ) {
    throw new PrivacyChainProbeError("The probe implementation does not match the active adapter policy");
  }
  const requiredCoverage = requiredExternalPrivacyCoverage(
    "external.chain.public_records",
  );
  if (
    stableJsonStringify(sourcePolicy.coverage)
      !== stableJsonStringify(requiredCoverage)
    || stableJsonStringify(job.coverage)
      !== stableJsonStringify(requiredCoverage)
  ) {
    throw new PrivacyChainProbeError(
      "The probe coverage does not match the exact public-chain component inventory",
    );
  }
  const expectedExecution = {
    timeoutMs: sourcePolicy.execution.timeoutMs,
    maximumRecords: sourcePolicy.execution.maximumRecords,
    maximumBytes: sourcePolicy.execution.maximumBytes,
    evidenceMaximumAgeSeconds: sourcePolicy.execution.evidenceMaximumAgeSeconds,
  };
  if (stableJsonStringify(expectedExecution) !== stableJsonStringify(job.execution)) {
    throw new PrivacyChainProbeError("The probe limits do not match the active adapter policy");
  }
  const includedOutputFields = sourcePolicy.fields
    .filter((field) => field.handling === "include")
    .map((field) => field.outputField)
    .sort();
  if (
    stableJsonStringify(includedOutputFields)
    !== stableJsonStringify(CHAIN_PRIVACY_OUTPUT_FIELDS)
  ) {
    throw new PrivacyChainProbeError("The active adapter policy does not match the public-chain safe output fields");
  }
  if (
    sourcePolicy.collectionMode !== "public_immutable_disclosure"
    || sourcePolicy.correlation.mode !== "exact_wallet_binding"
    || !sourcePolicy.correlation.referenceFields.includes("walletAddress")
    || sourcePolicy.rights.access.mode !== "immutable_disclosure"
    || sourcePolicy.rights.portability.mode !== "collect"
  ) {
    throw new PrivacyChainProbeError("The active adapter policy does not match the public-chain disclosure contract");
  }
  const records = collectPublicChainPrivacyRecords({
    records: input.references,
    maximumRecords: job.execution.maximumRecords,
    maximumBytes: job.execution.maximumBytes,
  });
  const configuredChainIds = [...input.rpcEndpoints.keys()].sort((left, right) => left - right);
  const jobChainIds = job.chains.map((chain) => chain.chainId).sort((left, right) => left - right);
  if (stableJsonStringify(configuredChainIds) !== stableJsonStringify(jobChainIds)) {
    throw new PrivacyChainProbeError("The chain RPC configuration does not match the approved probe job");
  }
  if (records.some((record) => !input.rpcEndpoints.has(record.chainId))) {
    throw new PrivacyChainProbeError("A subject record uses a chain that is absent from the approved probe job");
  }
  const deadline = Date.now() + job.execution.timeoutMs;
  for (const chain of [...job.chains].sort((left, right) => left.chainId - right.chainId)) {
    const remainingTimeMs = deadline - Date.now();
    if (remainingTimeMs <= 0) {
      throw new PrivacyChainProbeError("The chain RPC probe exceeded the time limit");
    }
    await verifyRpcChain({
      chainId: chain.chainId,
      endpoint: input.rpcEndpoints.get(chain.chainId)!,
      endpointSha256: chain.endpointSha256,
      timeoutMs: remainingTimeMs,
      fetchImplementation: input.fetchImplementation ?? fetch,
      resolveHostname: input.resolveHostname ?? (async (hostname) => (
        await lookup(hostname, { all: true, verbatim: true })
      ).map((entry) => entry.address)),
    });
  }
  const now = input.now ?? new Date();
  const validUntil = new Date(
    now.getTime() + job.execution.evidenceMaximumAgeSeconds * 1_000,
  );
  const payload = privacyExternalAttestationPayloadSchema.parse({
    schemaVersion: "privacy-external-source-attestation-payload-v2",
    attestationId: randomUUID(),
    sourceKey: "external.chain.public_records",
    policyBinding: job.policyBinding,
    implementation: job.implementation,
    provider: job.provider,
    evidence: buildEvidence({
      sourceLegalReason: sourcePolicy.rights.access.legalReason,
      records,
      chains: job.chains,
      governedEvidence: job.governedEvidence,
    }),
    coverage: job.coverage,
    observedAt: now.toISOString(),
    validFrom: now.toISOString(),
    expiresAt: validUntil.toISOString(),
    nonce: randomBytes(32).toString("hex"),
  });
  const canonicalPayload = Buffer.from(stableJsonStringify(payload), "utf8");
  const valueBase64 = (await input.signer(canonicalPayload)).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(valueBase64) || valueBase64.length > 128) {
    throw new PrivacyChainProbeError("The probe signer returned an invalid signature");
  }
  const signature = Buffer.from(valueBase64, "base64");
  if (
    signature.length !== 64
    || !verify(
      null,
      canonicalPayload,
      assertEd25519PublicKey(job.signer.publicKeyPem),
      signature,
    )
  ) {
    throw new PrivacyChainProbeError("The probe signer returned a signature that does not match the configured public key");
  }
  const attestation: PrivacyExternalSignedAttestation =
    privacyExternalSignedAttestationSchema.parse({
      payload,
      signature: {
        algorithm: "Ed25519",
        keyId: job.signer.keyId,
        valueBase64,
      },
    });
  return privacyChainProbeResultSchema.parse({
    schemaVersion: "privacy-chain-probe-result-v1",
    probeReference: job.probeReference,
    generatedAt: now.toISOString(),
    chainCount: job.chains.length,
    recordCount: records.length,
    attestation,
  });
}
