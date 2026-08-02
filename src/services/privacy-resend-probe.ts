import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { spawn } from "node:child_process";
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
import type { ResendPrivacyDeliveryReference } from "../platform/postgres-resend-privacy-references.js";
import { hashPayload, stableJsonStringify } from "../utils/idempotency.js";
import {
  collectResendPrivacyRecords,
  RESEND_PRIVACY_ADAPTER_KEY,
  RESEND_PRIVACY_ADAPTER_VERSION,
  type ResendPrivacyRecord,
} from "./privacy-external-resend-adapter.js";

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

export const privacyResendProbeJobSchema = z.object({
  schemaVersion: z.literal("privacy-resend-probe-job-v2"),
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
    adapterKey: z.literal(RESEND_PRIVACY_ADAPTER_KEY),
    version: z.literal(RESEND_PRIVACY_ADAPTER_VERSION),
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
}).strict();

export type PrivacyResendProbeJob = z.infer<typeof privacyResendProbeJobSchema>;

export const privacyResendProbeResultSchema = z.object({
  schemaVersion: z.literal("privacy-resend-probe-result-v1"),
  probeReference: z.string().trim().min(10).max(160),
  generatedAt: z.string().datetime({ offset: true }),
  recordCount: z.number().int().positive(),
  attestation: privacyExternalSignedAttestationSchema,
}).strict();

export type PrivacyResendProbeResult = z.infer<typeof privacyResendProbeResultSchema>;

export type PrivacyProbeSigner = (
  canonicalPayload: Uint8Array,
) => Promise<string>;

export class PrivacyResendProbeError extends Error {}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(stableJsonStringify(value))
    .digest("hex");
}

function assertEd25519PublicKey(publicKeyPem: string) {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new PrivacyResendProbeError("The probe public key must use Ed25519");
    }
    return publicKey;
  } catch (error) {
    if (error instanceof PrivacyResendProbeError) throw error;
    throw new PrivacyResendProbeError("The probe public key is invalid");
  }
}

function buildEvidence(input: {
  references: readonly ResendPrivacyDeliveryReference[];
  records: readonly ResendPrivacyRecord[];
  governedEvidence: PrivacyResendProbeJob["governedEvidence"];
}): PrivacyExternalAttestationPayload["evidence"] {
  const references = [...input.references]
    .sort((left, right) => left.providerMessageId.localeCompare(right.providerMessageId))
    .map((reference) => ({
      providerMessageId: reference.providerMessageId,
      recipientEmail: reference.recipientEmail.trim().toLowerCase(),
    }));
  const records = [...input.records];
  const evidence = {
    subjectCorrelation: sha256(references),
    fieldMinimization: sha256({
      allowedOutputFields: ["createdAt", "lastEvent"],
      records,
    }),
    access: sha256(records),
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
      recordCount: records.length,
      lastEvents: records.map((record) => record.lastEvent).sort(),
    }),
  };
  const actualKeys = Object.keys(evidence).sort();
  const requiredKeys = [...externalPrivacyAttestationEvidenceKeys].sort();
  if (stableJsonStringify(actualKeys) !== stableJsonStringify(requiredKeys)) {
    throw new PrivacyResendProbeError("The probe evidence set is incomplete");
  }
  return evidence;
}

export async function runPrivacyResendProbe(input: {
  job: PrivacyResendProbeJob;
  policy: unknown;
  references: readonly ResendPrivacyDeliveryReference[];
  resendApiKey: string;
  signer: PrivacyProbeSigner;
  now?: Date;
  fetchImplementation?: typeof fetch;
}): Promise<PrivacyResendProbeResult> {
  const job = privacyResendProbeJobSchema.parse(input.job);
  const policy = privacyExternalAdapterPolicySchema.parse(input.policy);
  if (hashPayload(policy) !== job.policyBinding.valueSha256) {
    throw new PrivacyResendProbeError(
      "The active adapter policy does not match the bound value hash",
    );
  }
  const sourcePolicy = policy.sources.find(
    (source) => source.sourceKey === "external.resend.delivery",
  );
  if (!sourcePolicy) {
    throw new PrivacyResendProbeError(
      "The active adapter policy does not contain the Resend source",
    );
  }
  if (
    stableJsonStringify(sourcePolicy.implementation) !== stableJsonStringify({
      adapterKey: job.implementation.adapterKey,
      version: job.implementation.version,
      sha256: job.implementation.sha256,
      releaseBinding: "exact_release_sha256",
    })
  ) {
    throw new PrivacyResendProbeError(
      "The probe implementation does not match the active adapter policy",
    );
  }
  const requiredCoverage = requiredExternalPrivacyCoverage(
    "external.resend.delivery",
  );
  if (
    stableJsonStringify(sourcePolicy.coverage)
      !== stableJsonStringify(requiredCoverage)
    || stableJsonStringify(job.coverage)
      !== stableJsonStringify(requiredCoverage)
  ) {
    throw new PrivacyResendProbeError(
      "The probe coverage does not match the exact Resend component inventory",
    );
  }
  const expectedExecution = {
    timeoutMs: sourcePolicy.execution.timeoutMs,
    maximumRecords: sourcePolicy.execution.maximumRecords,
    maximumBytes: sourcePolicy.execution.maximumBytes,
    evidenceMaximumAgeSeconds: sourcePolicy.execution.evidenceMaximumAgeSeconds,
  };
  if (stableJsonStringify(expectedExecution) !== stableJsonStringify(job.execution)) {
    throw new PrivacyResendProbeError(
      "The probe limits do not match the active adapter policy",
    );
  }
  const includedOutputFields = sourcePolicy.fields
    .filter((field) => field.handling === "include")
    .map((field) => field.outputField)
    .sort();
  if (
    stableJsonStringify(includedOutputFields)
    !== stableJsonStringify(["createdAt", "lastEvent"])
  ) {
    throw new PrivacyResendProbeError(
      "The active adapter policy does not match the Resend safe output fields",
    );
  }
  if (
    sourcePolicy.collectionMode !== "live_api"
    || sourcePolicy.correlation.mode !== "exact_provider_reference"
    || !sourcePolicy.correlation.referenceFields.includes("providerMessageId")
    || sourcePolicy.rights.access.mode !== "collect"
  ) {
    throw new PrivacyResendProbeError(
      "The active adapter policy does not match the Resend collection contract",
    );
  }
  if (input.references.length === 0) {
    throw new PrivacyResendProbeError(
      "The probe identity has no exact Resend delivery reference",
    );
  }
  const records = await collectResendPrivacyRecords({
    apiKey: input.resendApiKey,
    references: input.references,
    timeoutMs: job.execution.timeoutMs,
    maximumRecords: job.execution.maximumRecords,
    maximumBytes: job.execution.maximumBytes,
    fetchImplementation: input.fetchImplementation,
  });
  if (records.length !== input.references.length) {
    throw new PrivacyResendProbeError("The Resend probe result is incomplete");
  }
  const now = input.now ?? new Date();
  const validUntil = new Date(
    now.getTime() + job.execution.evidenceMaximumAgeSeconds * 1_000,
  );
  const payload = privacyExternalAttestationPayloadSchema.parse({
    schemaVersion: "privacy-external-source-attestation-payload-v2",
    attestationId: randomUUID(),
    sourceKey: "external.resend.delivery",
    policyBinding: job.policyBinding,
    implementation: job.implementation,
    provider: job.provider,
    evidence: buildEvidence({
      references: input.references,
      records,
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
    throw new PrivacyResendProbeError("The probe signer returned an invalid signature");
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
    throw new PrivacyResendProbeError(
      "The probe signer returned a signature that does not match the configured public key",
    );
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
  return privacyResendProbeResultSchema.parse({
    schemaVersion: "privacy-resend-probe-result-v1",
    probeReference: job.probeReference,
    generatedAt: now.toISOString(),
    recordCount: records.length,
    attestation,
  });
}

const signerEnvironmentSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  z.string().max(8_192),
);

export function createExecutablePrivacyProbeSigner(input: {
  executable: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
}): PrivacyProbeSigner {
  if (!input.executable.startsWith("/") || input.executable.includes("\0")) {
    throw new PrivacyResendProbeError(
      "The probe signer executable must use an absolute path",
    );
  }
  if (
    input.args.length > 32
    || input.args.some((argument) => argument.length > 1_000 || argument.includes("\0"))
  ) {
    throw new PrivacyResendProbeError("The probe signer arguments are invalid");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 120_000) {
    throw new PrivacyResendProbeError("The probe signer time limit is invalid");
  }
  const environment = signerEnvironmentSchema.parse(input.environment);
  for (const forbidden of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "PRIVACY_PROBE_RESEND_API_KEY",
    "PRIVACY_PROBE_CHAIN_RPC_MAP_JSON",
    "PRIVACY_PROBE_DATABASE_URL",
    "RESEND_API_KEY",
    "DATABASE_URL",
  ]) {
    if (forbidden in environment) {
      throw new PrivacyResendProbeError(
        `The probe signer environment cannot set ${forbidden}`,
      );
    }
  }
  return async (canonicalPayload) => new Promise<string>((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { LANG: "C", ...environment },
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, signature?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(signature ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new PrivacyResendProbeError("The probe signer exceeded the time limit"));
    }, input.timeoutMs);
    child.once("error", () =>
      finish(new PrivacyResendProbeError("The probe signer could not start")));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > 256) {
        child.kill("SIGKILL");
        finish(new PrivacyResendProbeError("The probe signer output exceeds the limit"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 4_096) {
        child.kill("SIGKILL");
        finish(new PrivacyResendProbeError("The probe signer diagnostic output exceeds the limit"));
      }
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new PrivacyResendProbeError("The probe signer failed"));
        return;
      }
      finish(undefined, stdout.toString("utf8").trim());
    });
    child.stdin.once("error", () =>
      finish(new PrivacyResendProbeError("The probe signer input failed")));
    child.stdin.end(canonicalPayload);
  });
}
