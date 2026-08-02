import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExecutablePrivacyProbeSigner,
  PrivacyResendProbeError,
  runPrivacyResendProbe,
  type PrivacyResendProbeJob,
} from "../privacy-resend-probe.js";
import { hashPayload } from "../../utils/idempotency.js";
import { validPrivacyExternalAdapterPolicy } from "../../testing/privacy-external-adapter-policy.fixture.js";
import type { PrivacyExternalAdapterPolicy } from "../../modules/privacy/domain/privacy-external-adapter-policy.js";

function policy(): PrivacyExternalAdapterPolicy {
  const value = validPrivacyExternalAdapterPolicy();
  const source = value.sources.find(
    (candidate) => candidate.sourceKey === "external.resend.delivery",
  )!;
  source.implementation = {
    adapterKey: "fractal.external.resend.delivery",
    version: "1.0.0",
    sha256: "3".repeat(64),
    releaseBinding: "exact_release_sha256",
  };
  source.correlation = {
    mode: "exact_provider_reference",
    referenceFields: ["providerMessageId"],
    maximumSubjectsPerRecord: 1,
    ambiguityBehavior: "reject",
    unmatchedBehavior: "remain_unlinked",
  };
  source.fields = [{
    sourceField: "created_at",
    outputField: "createdAt",
    classification: "technical_metadata",
    handling: "include",
    reason: "Creation time is required for the bounded delivery lifecycle record.",
  }, {
    sourceField: "last_event",
    outputField: "lastEvent",
    classification: "personal_metadata",
    handling: "include",
    reason: "Last delivery event is required for the bounded delivery lifecycle record.",
  }, {
    sourceField: "message_content_and_addresses",
    outputField: null,
    classification: "secret_or_internal",
    handling: "omit",
    reason: "Addresses, subject, content, and internal provider fields are excluded.",
  }];
  return value;
}

function job(
  publicKeyPem: string,
  activePolicy: PrivacyExternalAdapterPolicy,
): PrivacyResendProbeJob {
  const evidenceHash = "1".repeat(64);
  const source = activePolicy.sources.find(
    (candidate) => candidate.sourceKey === "external.resend.delivery",
  )!;
  return {
    schemaVersion: "privacy-resend-probe-job-v2",
    probeReference: "PRIVACY-RESEND-PROBE-2026-07-26",
    identityId: "0f63af0e-ffda-47de-9319-c6175655034b",
    policyBinding: {
      configurationKey: "privacy.external_source.adapter_policy",
      versionId: "7b09a632-f144-4a96-b9b1-2e45ad0822be",
      versionNumber: 4,
      projectionVersion: 9,
      valueSha256: hashPayload(activePolicy),
    },
    implementation: {
      adapterKey: "fractal.external.resend.delivery",
      version: "1.0.0",
      sha256: "3".repeat(64),
      releaseSha256: "4".repeat(64),
    },
    coverage: {
      inventoryVersion: source.coverage!.inventoryVersion,
      componentKeys: [...source.coverage!.componentKeys],
    },
    provider: {
      environment: "production",
      accountReference: "Resend production account reference RESEND-01",
      regionReference: "Approved Resend processing region register entry",
    },
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

function providerResponse(): Response {
  return new Response(JSON.stringify({
    id: "resend-message-1",
    to: ["subject@example.test"],
    created_at: "2026-07-26T08:00:00.000Z",
    last_event: "delivered",
    subject: "Private subject",
    html: "<p>Private body</p>",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("independent Resend privacy probe", () => {
  it("creates a verified signed attestation without raw subject data", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    const result = await runPrivacyResendProbe({
      job: job(publicKeyPem, activePolicy),
      policy: activePolicy,
      references: [{
        providerMessageId: "resend-message-1",
        recipientEmail: "subject@example.test",
      }],
      resendApiKey: "re_test_probe_key",
      signer: async (payload) => sign(null, payload, keys.privateKey).toString("base64"),
      now: new Date("2026-07-26T08:05:00.000Z"),
      fetchImplementation: async () => providerResponse(),
    });
    expect(result).toMatchObject({
      schemaVersion: "privacy-resend-probe-result-v1",
      recordCount: 1,
      attestation: {
        payload: {
          sourceKey: "external.resend.delivery",
          observedAt: "2026-07-26T08:05:00.000Z",
          expiresAt: "2026-07-26T09:05:00.000Z",
        },
        signature: {
          algorithm: "Ed25519",
          keyId: "privacy-probe-2026-01",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /subject@example|resend-message-1|Private subject|Private body/,
    );
  });

  it("rejects a signature from a different private key", async () => {
    const trusted = generateKeyPairSync("ed25519");
    const untrusted = generateKeyPairSync("ed25519");
    const publicKeyPem = trusted.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    await expect(runPrivacyResendProbe({
      job: job(publicKeyPem, activePolicy),
      policy: activePolicy,
      references: [{
        providerMessageId: "resend-message-1",
        recipientEmail: "subject@example.test",
      }],
      resendApiKey: "re_test_probe_key",
      signer: async (payload) =>
        sign(null, payload, untrusted.privateKey).toString("base64"),
      fetchImplementation: async () => providerResponse(),
    })).rejects.toThrow("does not match");
  });

  it("rejects a policy that allows a different Resend output field", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    const source = activePolicy.sources.find(
      (candidate) => candidate.sourceKey === "external.resend.delivery",
    )!;
    source.fields[0]!.outputField = "providerMessageId";
    await expect(runPrivacyResendProbe({
      job: job(publicKeyPem, activePolicy),
      policy: activePolicy,
      references: [{
        providerMessageId: "resend-message-1",
        recipientEmail: "subject@example.test",
      }],
      resendApiKey: "re_test_probe_key",
      signer: async (payload) => sign(null, payload, keys.privateKey).toString("base64"),
      fetchImplementation: async () => {
        throw new Error("Provider access must not occur");
      },
    })).rejects.toThrow("safe output fields");
  });

  it("rejects an incomplete component inventory before provider access", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const activePolicy = policy();
    const alteredJob = job(publicKeyPem, activePolicy);
    alteredJob.coverage.componentKeys = ["authentication_delivery"];
    await expect(runPrivacyResendProbe({
      job: alteredJob,
      policy: activePolicy,
      references: [{
        providerMessageId: "resend-message-1",
        recipientEmail: "subject@example.test",
      }],
      resendApiKey: "re_test_probe_key",
      signer: async (payload) => sign(null, payload, keys.privateKey).toString("base64"),
      fetchImplementation: async () => {
        throw new Error("Provider access must not occur");
      },
    })).rejects.toThrow("exact Resend component inventory");
  });

  it("runs an external signer with an explicit isolated environment", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyBase64 = Buffer.from(keys.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString()).toString("base64");
    process.env.PRIVACY_PROBE_RESEND_API_KEY = "must-not-reach-signer";
    try {
      const signer = createExecutablePrivacyProbeSigner({
        executable: process.execPath,
        args: [
          "-e",
          [
            "const crypto=require('node:crypto');",
            "const chunks=[];",
            "process.stdin.on('data',chunk=>chunks.push(chunk));",
            "process.stdin.on('end',()=>{",
            "if(process.env.PRIVACY_PROBE_RESEND_API_KEY)process.exit(9);",
            "const key=Buffer.from(process.env.SIGNER_PRIVATE_KEY_B64,'base64').toString('utf8');",
            "process.stdout.write(crypto.sign(null,Buffer.concat(chunks),key).toString('base64'));",
            "});",
          ].join(""),
        ],
        environment: { SIGNER_PRIVATE_KEY_B64: privateKeyBase64 },
        timeoutMs: 2_000,
      });
      const signature = await signer(Buffer.from("canonical payload", "utf8"));
      expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    } finally {
      delete process.env.PRIVACY_PROBE_RESEND_API_KEY;
    }
  });

  it("rejects unsafe signer configuration and excessive output", async () => {
    expect(() => createExecutablePrivacyProbeSigner({
      executable: "relative-signer",
      args: [],
      environment: {},
      timeoutMs: 1_000,
    })).toThrow("absolute path");
    expect(() => createExecutablePrivacyProbeSigner({
      executable: process.execPath,
      args: [],
      environment: { NODE_OPTIONS: "--require=unsafe" },
      timeoutMs: 1_000,
    })).toThrow("NODE_OPTIONS");
    const signer = createExecutablePrivacyProbeSigner({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(300))"],
      environment: {},
      timeoutMs: 1_000,
    });
    await expect(signer(Buffer.from("payload"))).rejects.toEqual(
      new PrivacyResendProbeError("The probe signer output exceeds the limit"),
    );
  });
});
