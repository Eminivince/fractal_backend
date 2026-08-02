import { randomUUID } from "node:crypto";
import {
  link,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Client } from "pg";
import { z } from "zod";
import {
  privacyResendProbeJobSchema,
  createExecutablePrivacyProbeSigner,
  runPrivacyResendProbe,
} from "./services/privacy-resend-probe.js";
import {
  privacyChainProbeJobSchema,
  runPrivacyChainProbe,
} from "./services/privacy-chain-probe.js";
import { queryResendPrivacyDeliveryReferencesForIdentity } from "./platform/postgres-resend-privacy-references.js";
import { queryChainPrivacyRecordsForIdentity } from "./platform/postgres-chain-privacy-references.js";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const probeEnvironmentSchema = z.object({
  PRIVACY_PROBE_DATABASE_URL: z.string().url(),
  PRIVACY_PROBE_DATABASE_SSL: booleanString.default(true),
  PRIVACY_PROBE_RESEND_API_KEY: z.string().startsWith("re_").min(10).optional(),
  PRIVACY_PROBE_CHAIN_RPC_MAP_JSON: z.string().optional(),
  PRIVACY_PROBE_SIGNER_EXECUTABLE: z.string().startsWith("/").min(2),
  PRIVACY_PROBE_SIGNER_ARGS_JSON: z.string().default("[]"),
  PRIVACY_PROBE_SIGNER_ENV_JSON: z.string().default("{}"),
  PRIVACY_PROBE_SIGNER_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
}).passthrough();

function parseJsonObject(value: string, name: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
  return z.record(z.string(), z.string()).parse(parsed);
}

function parseJsonStringArray(value: string, name: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
  return z.array(z.string()).max(32).parse(parsed);
}

function parseChainRpcMap(value: string | undefined): Map<number, string> {
  if (!value) {
    throw new Error("PRIVACY_PROBE_CHAIN_RPC_MAP_JSON is required for a chain probe");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PRIVACY_PROBE_CHAIN_RPC_MAP_JSON must contain valid JSON");
  }
  const record = z.record(
    z.string().regex(/^[1-9][0-9]*$/),
    z.string().url(),
  ).parse(parsed);
  const result = new Map<number, string>();
  for (const [chainId, endpoint] of Object.entries(record)) {
    const numericChainId = Number(chainId);
    if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
      throw new Error("PRIVACY_PROBE_CHAIN_RPC_MAP_JSON contains an invalid chain ID");
    }
    result.set(numericChainId, endpoint);
  }
  if (!result.size) {
    throw new Error("PRIVACY_PROBE_CHAIN_RPC_MAP_JSON must contain at least one chain");
  }
  return result;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 1_048_576) {
    throw new Error("The probe job file must be a regular file of 1 MiB or less");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeNewAtomicFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const directoryMetadata = await stat(directory);
  if (!directoryMetadata.isDirectory()) {
    throw new Error("The probe output parent must be a directory");
  }
  const temporaryPath = resolve(
    directory,
    `.privacy-probe-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  const outputPath = process.argv[3];
  if (
    !jobPath
    || !outputPath
    || process.argv.length !== 4
    || !isAbsolute(jobPath)
    || !isAbsolute(outputPath)
  ) {
    throw new Error(
      "Usage: privacy:probe /absolute/job.json /absolute/new-result.json",
    );
  }
  const environment = probeEnvironmentSchema.parse(process.env);
  const rawJob = await readBoundedJson(jobPath);
  const chainJob = privacyChainProbeJobSchema.safeParse(rawJob);
  const resendJob = privacyResendProbeJobSchema.safeParse(rawJob);
  if (!chainJob.success && !resendJob.success) {
    throw new Error("The privacy probe job is invalid");
  }
  if (!chainJob.success && !environment.PRIVACY_PROBE_RESEND_API_KEY) {
    throw new Error("PRIVACY_PROBE_RESEND_API_KEY is required for a Resend probe");
  }
  const job = chainJob.success ? chainJob.data : resendJob.data!;
  const signer = createExecutablePrivacyProbeSigner({
    executable: environment.PRIVACY_PROBE_SIGNER_EXECUTABLE,
    args: parseJsonStringArray(
      environment.PRIVACY_PROBE_SIGNER_ARGS_JSON,
      "PRIVACY_PROBE_SIGNER_ARGS_JSON",
    ),
    environment: parseJsonObject(
      environment.PRIVACY_PROBE_SIGNER_ENV_JSON,
      "PRIVACY_PROBE_SIGNER_ENV_JSON",
    ),
    timeoutMs: environment.PRIVACY_PROBE_SIGNER_TIMEOUT_MS,
  });
  const client = new Client({
    connectionString: environment.PRIVACY_PROBE_DATABASE_URL,
    ssl: environment.PRIVACY_PROBE_DATABASE_SSL
      ? { rejectUnauthorized: true }
      : false,
    application_name: "fractal-privacy-probe",
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const chainReferences = chainJob.success
      ? await queryChainPrivacyRecordsForIdentity(client, job.identityId)
      : undefined;
    const resendReferences = resendJob.success && !chainJob.success
      ? await queryResendPrivacyDeliveryReferencesForIdentity(client, job.identityId)
      : undefined;
    const policyResult = await client.query<{ proposed_value: unknown }>(
      `SELECT version.proposed_value
         FROM fractal.platform_configuration_active_versions projection
         JOIN fractal.platform_configuration_versions version
           ON version.id = projection.active_version_id
          AND version.status = 'active'
        WHERE projection.configuration_key = $1
          AND version.id = $2
          AND version.version_number = $3
          AND projection.projection_version = $4
          AND version.value_sha256 = $5`,
      [
        job.policyBinding.configurationKey,
        job.policyBinding.versionId,
        job.policyBinding.versionNumber,
        job.policyBinding.projectionVersion,
        job.policyBinding.valueSha256,
      ],
    );
    const policy = policyResult.rows[0]?.proposed_value;
    if (!policy) {
      throw new Error("The exact active adapter policy is not available");
    }
    await client.query("COMMIT");
    const result = chainJob.success
      ? await runPrivacyChainProbe({
          job: chainJob.data,
          policy,
          references: chainReferences!,
          rpcEndpoints: parseChainRpcMap(environment.PRIVACY_PROBE_CHAIN_RPC_MAP_JSON),
          signer,
        })
      : await runPrivacyResendProbe({
          job: resendJob.data!,
          policy,
          references: resendReferences!,
          resendApiKey: environment.PRIVACY_PROBE_RESEND_API_KEY!,
          signer,
        });
    await writeNewAtomicFile(
      outputPath,
      `${JSON.stringify(result, null, 2)}\n`,
    );
    process.stdout.write("Privacy probe evidence created.\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown probe failure";
  process.stderr.write(`Privacy probe failed: ${message}\n`);
  process.exitCode = 1;
});
