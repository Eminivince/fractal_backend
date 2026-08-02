import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { booleanFromString } from "../utils/boolean.js";

// Package scripts run from apps/api while repository-level developer secrets
// commonly live at the workspace root. Load the package file first, then use
// the root file only for variables not already supplied by the package or OS.
const configDirectory = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(configDirectory, "../../.env") });
dotenv.config({ path: resolve(configDirectory, "../../../../.env") });

const emptyToUndefined = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim().length === 0)
      return undefined;
    return value;
  }, schema);

function isSecurePublicAppBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && url.username.length === 0
      && url.password.length === 0
      && url.search.length === 0
      && url.hash.length === 0
      && hostname !== "localhost"
      && !hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function isCloudflareR2Endpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).hostname.toLowerCase().endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  DATABASE_URL: emptyToUndefined(z.string().url().optional()),
  POSTGRES_POOL_SIZE: z.coerce.number().int().positive().max(100).default(20),
  POSTGRES_SSL: booleanFromString(false),
  // Local development may opt out while only non-Postgres endpoints are used.
  // Production requires this because authentication sessions are Postgres-backed.
  POSTGRES_REQUIRED: booleanFromString(false),
  ALLOWED_ORIGINS: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ACTIVE_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("primary"),
  JWT_KEY_RING_JSON: emptyToUndefined(z.string().min(2).optional()),
  APPLICATION_RELEASE_SHA256: emptyToUndefined(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  PRIVACY_CHAIN_ADAPTER_SHA256: emptyToUndefined(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  PRIVACY_RESEND_ADAPTER_SHA256: emptyToUndefined(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  PRIVACY_SUMSUB_ADAPTER_SHA256: emptyToUndefined(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  PRIVACY_RESEND_COLLECTION_API_KEY: emptyToUndefined(z.string().regex(/^re_[A-Za-z0-9_-]{8,}$/).optional()),
  SUMSUB_PRIVACY_APP_TOKEN: emptyToUndefined(z.string().min(8).max(512).optional()),
  SUMSUB_PRIVACY_SECRET_KEY: emptyToUndefined(z.string().min(16).max(512).optional()),
  PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON: emptyToUndefined(z.string().min(2).optional()),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  AUTH_STEP_UP_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  // MongoDB is retained only as an explicit migration authority outside
  // production. A production process must authenticate against the same
  // PostgreSQL identities that own its governed domains and MFA factors.
  AUTH_IDENTITY_AUTHORITY: z.enum(["mongo", "postgres"]).default("mongo"),
  MFA_TOTP_ENABLED: booleanFromString(false),
  MFA_TOTP_ENCRYPTION_KEY: emptyToUndefined(z.string().length(64).optional()),
  MFA_RECOVERY_CODE_PEPPER: emptyToUndefined(z.string().length(64).optional()),
  ANCHOR_WORKER_ENABLED: booleanFromString(false),
  ANCHOR_RPC_URL: emptyToUndefined(z.string().url().optional()),
  ANCHOR_CHAIN_ID: z.coerce.number().int().positive().default(11155111),
  ANCHOR_CONTRACT_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  ANCHOR_PRIVATE_KEY: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  ANCHOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  ANCHOR_CONFIRMATIONS: z.coerce.number().int().positive().default(1),
  RECONCILIATION_WORKER_ENABLED: booleanFromString(true),
  RECONCILIATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300000),
  RECONCILIATION_TOLERANCE: z.coerce.number().nonnegative().default(0.5),
  NOTIFICATION_EMAIL_ENABLED: booleanFromString(true),
  NOTIFICATION_EMAIL_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15000),
  NOTIFICATION_EMAIL_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  WORK_ORDER_SLA_ESCALATION_ENABLED: booleanFromString(true),
  WORK_ORDER_SLA_ESCALATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300000),
  WORK_ORDER_SLA_ESCALATION_BATCH_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(500)
    .default(100),
  EMAIL_FROM: emptyToUndefined(z.string().email().optional()),
  RESEND_API_KEY: emptyToUndefined(z.string().startsWith("re_").min(10).optional()),
  EMAIL_DELIVERY_SECRET_KEY: emptyToUndefined(z.string().min(32).optional()),
  SMTP_HOST: emptyToUndefined(z.string().min(2).optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromString(false),
  SMTP_USER: emptyToUndefined(z.string().min(1).optional()),
  SMTP_PASS: emptyToUndefined(z.string().min(1).optional()),
  SMTP_FROM: emptyToUndefined(z.string().email().optional()),
  FILE_STORAGE_PROVIDER: z.enum(["local", "s3", "cloudinary"]).default("local"),
  FILE_STORAGE_FALLBACK_TO_LOCAL: booleanFromString(true),
  FILE_STORAGE_DIR: z.string().default("storage"),
  // Uploaded documents must be scanned before they are persisted. Development
  // may leave this off for an isolated local loop; production may not.
  MALWARE_SCAN_REQUIRED: booleanFromString(false),
  MALWARE_SCAN_HOST: emptyToUndefined(z.string().min(1).optional()),
  MALWARE_SCAN_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
  MALWARE_SCAN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  CLOUDINARY_CLOUD_NAME: emptyToUndefined(z.string().min(2).optional()),
  CLOUDINARY_API_KEY: emptyToUndefined(z.string().min(5).optional()),
  CLOUDINARY_API_SECRET: emptyToUndefined(z.string().min(8).optional()),
  CLOUDINARY_UPLOAD_FOLDER: emptyToUndefined(z.string().min(1).optional()),
  S3_BUCKET: emptyToUndefined(z.string().min(3).optional()),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: emptyToUndefined(z.string().url().optional()),
  S3_ACCESS_KEY_ID: emptyToUndefined(z.string().min(3).optional()),
  S3_SECRET_ACCESS_KEY: emptyToUndefined(z.string().min(8).optional()),
  S3_SESSION_TOKEN: emptyToUndefined(z.string().min(8).optional()),
  S3_KMS_KEY_ID: emptyToUndefined(z.string().min(1).max(2048).optional()),
  S3_FORCE_PATH_STYLE: booleanFromString(false),
  S3_KEY_PREFIX: emptyToUndefined(z.string().optional()),
  // I-61: App base URL for generating invite links
  APP_BASE_URL: emptyToUndefined(z.string().url().optional()),
  PAYSTACK_SECRET_KEY: emptyToUndefined(z.string().min(8).optional()),
  PAYSTACK_WEBHOOK_SECRET: emptyToUndefined(z.string().min(8).optional()),
  PAYSTACK_ENABLED: booleanFromString(true),
  PAYSTACK_INBOX_ENABLED: booleanFromString(true),
  PAYSTACK_DVA_ENABLED: booleanFromString(false),
  PAYSTACK_DVA_PREFERRED_BANK: emptyToUndefined(z.string().min(2).optional()),
  PAYSTACK_TRANSFER_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(86400000),
  PAYSTACK_BALANCE_CHECK_ENABLED: booleanFromString(true),
  PAYSTACK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  SUMSUB_APP_TOKEN: emptyToUndefined(z.string().min(8).optional()),
  SUMSUB_SECRET_KEY: emptyToUndefined(z.string().min(8).optional()),
  SUMSUB_WEBHOOK_SECRET: emptyToUndefined(z.string().min(8).optional()),
  SUMSUB_LEVEL_NAME: z.string().default("basic-kyc-level"),
  SUMSUB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  SUMSUB_SDK_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  SUMSUB_ENABLED: booleanFromString(true),
  SUMSUB_INBOX_ENABLED: booleanFromString(true),
  // `env` supports controlled local/testnet work. `aws_kms` and `vault` are
  // reserved provider labels and intentionally fail closed for signing work
  // until a non-exporting EVM signer implementation is reviewed.
  KEY_MANAGEMENT_PROVIDER: z.enum(["env", "aws_kms", "vault"]).default("env"),
  // Blockchain / EVM
  POLYGON_RPC_URL: z.string().default("https://polygon-rpc.com"),
  POLYGON_AMOY_RPC_URL: z
    .string()
    .default("https://rpc-amoy.polygon.technology"),
  SEPOLIA_RPC_URL: z.string().url().default("https://ethereum-sepolia-rpc.publicnode.com"),
  FRACTAL_AGENT_PRIVATE_KEY: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  // Compatibility input for the existing contract-tooling .env. It is never
  // preferred over FRACTAL_AGENT_PRIVATE_KEY and is not documented for new API
  // deployments.
  PRIVATE_KEY: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  FRACTAL_AGENT_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  BLOCKCHAIN_WORKER_ENABLED: booleanFromString(false),
  // The Mongo-backed dispatcher predates the PostgreSQL maker-checker chain
  // operation workflow. Keep it off unless a controlled migration explicitly
  // authorizes legacy operations.
  LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED: booleanFromString(false),
  CHAIN_DEPLOYMENT_EXECUTOR_ENABLED: booleanFromString(false),
  CHAIN_DEPLOYMENT_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  CHAIN_DEPLOYMENT_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(1),
  ALLOCATION_CHAIN_EXECUTOR_ENABLED: booleanFromString(false),
  ALLOCATION_CHAIN_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  ALLOCATION_CHAIN_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(1),
  BLOCKCHAIN_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15000),
  BLOCKCHAIN_CONFIRMATIONS: z.coerce.number().int().positive().default(2),
  BLOCKCHAIN_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  CHAIN_ID: z.coerce.number().int().positive().default(80002),
  TOKEN_FACTORY_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  IDENTITY_REGISTRY_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  IDENTITY_FACTORY_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  CLAIM_ISSUER_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  AGENT_REGISTRY_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  DISTRIBUTION_AUDIT_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  USDT_ADDRESS: emptyToUndefined(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  ),
  // Privy (server-side)
  PRIVY_APP_ID: emptyToUndefined(z.string().min(8).optional()),
  PRIVY_APP_SECRET: emptyToUndefined(z.string().min(8).optional()),
  PRIVY_ENABLED: booleanFromString(false),
  // B1/B2/B5/B10: Redis
  REDIS_URL: emptyToUndefined(z.string().optional()),
  RATE_LIMIT_REDIS_ENABLED: booleanFromString(true),
  WORKER_LEASE_KEY: z.string().min(1).default("fractal:worker-runtime:lease"),
  WORKER_LEASE_TTL_MS: z.coerce.number().int().min(10_000).default(60_000),
  OUTBOX_DISPATCH_ENABLED: booleanFromString(true),
  OUTBOX_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  OUTBOX_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(300),
  OUTBOX_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).default(10),
  AUTH_EMAIL_DELIVERY_ENABLED: booleanFromString(true),
  AUTH_EMAIL_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  AUTH_EMAIL_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  AUTH_EMAIL_DELIVERY_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(300),
  AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).default(10),
  AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  AUTH_EMAIL_DELIVERY_MAX_PENDING_AGE_SECONDS: z.coerce.number().int().min(60).default(900),
  AUTH_EMAIL_DELIVERY_HEALTH_LOG_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  // One-shot administrator operations. Keep these unset in normal API/worker
  // runtimes and inject only into the independently authorised operations job.
  ADMIN_BOOTSTRAP_COHORT_JSON: emptyToUndefined(z.string().min(2).optional()),
  ADMIN_OPERATIONS_ACTOR_ID: emptyToUndefined(z.string().min(3).max(200).optional()),
  ADMIN_BREAK_GLASS_REQUEST_KEY: emptyToUndefined(z.string().min(32).optional()),
  ADMIN_BREAK_GLASS_APPROVAL_KEY: emptyToUndefined(z.string().min(32).optional()),
  ADMIN_RECOVERY_REQUEST_JSON: emptyToUndefined(z.string().min(2).optional()),
  INBOX_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  INBOX_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  INBOX_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(300),
  INBOX_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).default(10),
  INBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  STORAGE_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  STORAGE_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  STORAGE_CLEANUP_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(300),
  STORAGE_CLEANUP_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).default(10),
  STORAGE_CLEANUP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  PRIVACY_PACKAGE_WORKER_ENABLED: booleanFromString(true),
  PRIVACY_PACKAGE_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  PRIVACY_PACKAGE_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED: booleanFromString(false),
  PRIVACY_EXTERNAL_COLLECTION_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  PRIVACY_EXTERNAL_COLLECTION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  PAYMENT_INSTRUCTION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  PAYMENT_INSTRUCTION_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(300),
  PAYMENT_INSTRUCTION_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).default(10),
  PAYMENT_INSTRUCTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  IDENTITY_VERIFICATION_APPLICATION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  IDENTITY_VERIFICATION_APPLICATION_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(300),
  IDENTITY_VERIFICATION_APPLICATION_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).default(10),
  IDENTITY_VERIFICATION_APPLICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  PROFESSIONAL_PAYOUT_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  PROFESSIONAL_PAYOUT_DISPATCH_LEASE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(600),
  PROFESSIONAL_PAYOUT_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  PROFESSIONAL_PAYOUT_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  DISTRIBUTION_PAYOUT_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  DISTRIBUTION_PAYOUT_DISPATCH_LEASE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(600),
  DISTRIBUTION_PAYOUT_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  DISTRIBUTION_PAYOUT_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  PAYMENT_EXPIRY_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  PAYMENT_EXPIRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  PLATFORM_CONFIGURATION_ACTIVATION_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  PLATFORM_CONFIGURATION_ACTIVATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  PLATFORM_CONTENT_PUBLICATION_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  SUPPORT_SERVICE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  SUPPORT_SERVICE_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  PLATFORM_CONTENT_PUBLICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  // B14: MongoDB connection tuning
  MONGODB_POOL_SIZE: z.coerce.number().int().positive().default(20),
  MONGODB_READ_PREFERENCE: z.string().default("primary"),
  // B15: Slow query monitoring
  MONGODB_SLOW_QUERY_LOG: booleanFromString(false),
  MONGODB_SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(200),
  // B3: OpenTelemetry
  OTEL_ENABLED: booleanFromString(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: emptyToUndefined(z.string().optional()),
  OTEL_TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  // B9: Field-level encryption
  FIELD_ENCRYPTION_KEY: emptyToUndefined(z.string().length(64).optional()),
  FIELD_ENCRYPTION_ENABLED: booleanFromString(false),
  // Error tracking (Sentry). Disabled when DSN is unset.
  SENTRY_DSN: emptyToUndefined(z.string().url().optional()),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
}).superRefine((cfg, ctx) => {
  // Fail fast on missing real-integration credentials. There is no mock/demo mode:
  // dev and prod both require real sandbox/test credentials. `test` (vitest) is
  // exempt so pure unit tests do not need secrets.
  if (cfg.NODE_ENV === "test") return;

  const require = (key: keyof typeof cfg, hint: string) => {
    if (!cfg[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key as string],
        message: `${String(key)} is required (${hint}). No mock mode exists — set a real sandbox/test value.`,
      });
    }
  };

  if (cfg.NODE_ENV === "production" && !cfg.POSTGRES_REQUIRED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["POSTGRES_REQUIRED"],
      message: "POSTGRES_REQUIRED must be true in production because authentication sessions require PostgreSQL.",
    });
  }

  if (cfg.NODE_ENV === "production") {
    require("APPLICATION_RELEASE_SHA256", "SHA-256 identity for the exact deployed release");
    if (cfg.PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED) {
      require("PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON", "trusted Ed25519 public keys for external privacy attestations");
      if (
        !cfg.PRIVACY_CHAIN_ADAPTER_SHA256
        && !cfg.PRIVACY_RESEND_ADAPTER_SHA256
        && !cfg.PRIVACY_SUMSUB_ADAPTER_SHA256
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED"],
          message: "The external privacy worker requires at least one configured adapter artifact.",
        });
      }
      if (cfg.PRIVACY_RESEND_ADAPTER_SHA256) {
        require("PRIVACY_RESEND_COLLECTION_API_KEY", "separate read-only Resend key for subject-bound privacy collection");
      }
      if (cfg.PRIVACY_RESEND_COLLECTION_API_KEY) {
        require("PRIVACY_RESEND_ADAPTER_SHA256", "SHA-256 identity for the exact Resend privacy adapter artifact");
      }
      if (cfg.PRIVACY_SUMSUB_ADAPTER_SHA256) {
        require("SUMSUB_PRIVACY_APP_TOKEN", "separate read-only Sumsub app token for subject-bound privacy collection");
        require("SUMSUB_PRIVACY_SECRET_KEY", "separate read-only Sumsub secret key for subject-bound privacy collection");
      }
      if (cfg.SUMSUB_PRIVACY_APP_TOKEN || cfg.SUMSUB_PRIVACY_SECRET_KEY) {
        require("PRIVACY_SUMSUB_ADAPTER_SHA256", "SHA-256 identity for the exact Sumsub privacy adapter artifact");
        require("SUMSUB_PRIVACY_APP_TOKEN", "complete Sumsub privacy collection credentials");
        require("SUMSUB_PRIVACY_SECRET_KEY", "complete Sumsub privacy collection credentials");
      }
    }
    if (cfg.AUTH_IDENTITY_AUTHORITY !== "postgres") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_IDENTITY_AUTHORITY"],
        message: "AUTH_IDENTITY_AUTHORITY must be postgres in production; MongoDB identity authority is migration-only.",
      });
    }
    require("REDIS_URL", "Redis URL for distributed rate limits, worker coordination, and live delivery");
    if (!cfg.AUTH_EMAIL_DELIVERY_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_EMAIL_DELIVERY_ENABLED"],
        message: "AUTH_EMAIL_DELIVERY_ENABLED must be true in production so verification and password-reset messages are durably dispatched.",
      });
    }
    if (!cfg.NOTIFICATION_EMAIL_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NOTIFICATION_EMAIL_ENABLED"],
        message: "NOTIFICATION_EMAIL_ENABLED must be true in production so the authentication email dispatcher can use a configured transport.",
      });
    }
    require("EMAIL_FROM", "verified Resend sender for durable email delivery");
    require("RESEND_API_KEY", "Resend API key for durable email delivery");
    require("EMAIL_DELIVERY_SECRET_KEY", "stable secret derivation key for retry-safe email commands");
    if (cfg.SMTP_HOST || cfg.SMTP_USER || cfg.SMTP_PASS || cfg.SMTP_FROM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_HOST"],
        message: "SMTP fallback is not permitted in production. Remove SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM.",
      });
    }
    if (!isSecurePublicAppBaseUrl(cfg.APP_BASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_BASE_URL"],
        message: "APP_BASE_URL must be a public HTTPS origin or path prefix without credentials, query, or fragment in production so authentication and invitation links cannot resolve to localhost or an ambiguous URL.",
      });
    }
  }

  if (cfg.NODE_ENV === "production" && !cfg.MFA_TOTP_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MFA_TOTP_ENABLED"],
      message: "MFA_TOTP_ENABLED must be true in production before privileged financial or chain actions are enabled.",
    });
  }

  if (cfg.POSTGRES_REQUIRED) {
    require("DATABASE_URL", "PostgreSQL connection URL");
  }

  if (cfg.NODE_ENV === "production") {
    if (cfg.FILE_STORAGE_PROVIDER !== "s3") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FILE_STORAGE_PROVIDER"],
        message: "FILE_STORAGE_PROVIDER must be s3 in production. Use NODE_ENV=development for staging if you use Cloudinary. Local and public-media storage are not permitted for regulated private documents in production.",
      });
    }
    if (cfg.FILE_STORAGE_FALLBACK_TO_LOCAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FILE_STORAGE_FALLBACK_TO_LOCAL"],
        message: "FILE_STORAGE_FALLBACK_TO_LOCAL must be false in production.",
      });
    }
    require("S3_BUCKET", "private S3 document bucket");
    require("S3_ACCESS_KEY_ID", "S3 document-storage credential");
    require("S3_SECRET_ACCESS_KEY", "S3 document-storage credential");
    if (!cfg.S3_KMS_KEY_ID && !isCloudflareR2Endpoint(cfg.S3_ENDPOINT)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_KMS_KEY_ID"],
        message: "S3_KMS_KEY_ID is required for AWS S3 production storage. Leave it empty only when S3_ENDPOINT is a Cloudflare R2 endpoint, because R2 encrypts objects at rest with provider-managed AES-256.",
      });
    }
    if (!cfg.MALWARE_SCAN_REQUIRED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MALWARE_SCAN_REQUIRED"],
        message: "MALWARE_SCAN_REQUIRED must be true in production.",
      });
    }
    require("MALWARE_SCAN_HOST", "reachable malware scanner");
  }

  if (cfg.MFA_TOTP_ENABLED) {
    require("MFA_TOTP_ENCRYPTION_KEY", "64-character hex key for TOTP factor encryption");
    require("MFA_RECOVERY_CODE_PEPPER", "64-character hex pepper for one-time MFA recovery codes");
  }

  // Payments (Paystack) — only required when payments are enabled.
  if (cfg.PAYSTACK_ENABLED) {
    require("PAYSTACK_SECRET_KEY", "Paystack test secret key");
    require("PAYSTACK_WEBHOOK_SECRET", "Paystack webhook signing secret");
    if (cfg.PAYSTACK_INBOX_ENABLED) {
      require("DATABASE_URL", "PostgreSQL durable inbox for payment webhooks");
    }
    if (cfg.NODE_ENV === "production" && !cfg.PAYSTACK_INBOX_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PAYSTACK_INBOX_ENABLED"],
        message: "PAYSTACK_INBOX_ENABLED must be true in production; direct legacy provider effects are not permitted.",
      });
    }
  }
  // Embedded-wallet provisioning is an external custody/provider boundary. It
  // may only be enabled with a real configured provider; services never mint
  // fake addresses as a development fallback.
  if (cfg.PRIVY_ENABLED) {
    require("PRIVY_APP_ID", "Privy application ID");
    require("PRIVY_APP_SECRET", "Privy application secret");
  }
  // KYC/KYB (Sumsub) — only required when Sumsub is enabled.
  if (cfg.SUMSUB_ENABLED) {
    require("SUMSUB_APP_TOKEN", "Sumsub sandbox app token");
    require("SUMSUB_SECRET_KEY", "Sumsub sandbox secret key");
    require("SUMSUB_WEBHOOK_SECRET", "Sumsub webhook secret");
    if (cfg.SUMSUB_INBOX_ENABLED) {
      require("DATABASE_URL", "PostgreSQL durable inbox for Sumsub webhooks");
    }
    if (cfg.NODE_ENV === "production" && !cfg.SUMSUB_INBOX_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUMSUB_INBOX_ENABLED"],
        message: "SUMSUB_INBOX_ENABLED must be true in production; direct provider effects are not permitted.",
      });
    }
  }
  // On-chain operator wallet — only required when the blockchain worker is enabled.
  // (The on-chain layer is env-gated and optional; the app boots and serves
  // auth/payments/KYC without it.)
  const hasOperatorKey = Boolean(cfg.FRACTAL_AGENT_PRIVATE_KEY ?? cfg.PRIVATE_KEY);
  const hasOnchainSigningWork = Boolean(
    cfg.BLOCKCHAIN_WORKER_ENABLED ||
      cfg.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED ||
      cfg.ALLOCATION_CHAIN_EXECUTOR_ENABLED ||
      cfg.ANCHOR_WORKER_ENABLED,
  );
  // `aws_kms` and `vault` remain declared extension points, but the current
  // viem workers require a LocalAccount and neither adapter can safely return
  // an EVM signer yet. Do not let a production deployment look KMS-backed and
  // then fail (or fall back to an ambient private key) at the first write.
  if (hasOnchainSigningWork && cfg.KEY_MANAGEMENT_PROVIDER !== "env") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["KEY_MANAGEMENT_PROVIDER"],
      message:
        "On-chain execution requires the implemented env signer in this revision; AWS KMS/Vault EVM signer integration and custody validation are release gates.",
    });
  }
  // A process-environment private key is useful for controlled local/testnet
  // work, not for a live-value production signer. Production must stay
  // fail-closed until an independently reviewed external signer is integrated.
  if (cfg.NODE_ENV === "production" && hasOnchainSigningWork && cfg.KEY_MANAGEMENT_PROVIDER === "env") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["KEY_MANAGEMENT_PROVIDER"],
      message:
        "Production on-chain execution cannot use environment private keys; configure an independently reviewed external signer and custody control before enabling it.",
    });
  }
  if (cfg.BLOCKCHAIN_WORKER_ENABLED) {
    if (!hasOperatorKey) require("FRACTAL_AGENT_PRIVATE_KEY", "operator wallet private key for on-chain ops");
    require("TOKEN_FACTORY_ADDRESS", "canonical token factory deployment");
    require("IDENTITY_REGISTRY_ADDRESS", "canonical identity registry deployment");
    require("IDENTITY_FACTORY_ADDRESS", "canonical identity factory deployment");
    require("CLAIM_ISSUER_ADDRESS", "canonical claim issuer deployment");
    require("AGENT_REGISTRY_ADDRESS", "canonical agent registry deployment");
    require("DISTRIBUTION_AUDIT_ADDRESS", "canonical distribution-audit deployment");
    require("USDT_ADDRESS", "configured payout-token deployment");
  }
  if (cfg.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED) {
    require("DATABASE_URL", "PostgreSQL chain-operation authority");
    if (!hasOperatorKey) require("FRACTAL_AGENT_PRIVATE_KEY", "operator wallet private key for deployment execution");
    require("TOKEN_FACTORY_ADDRESS", "canonical token factory deployment");
  }
  if (cfg.ALLOCATION_CHAIN_EXECUTOR_ENABLED) {
    require("DATABASE_URL", "PostgreSQL allocation-chain authority");
    if (!hasOperatorKey) require("FRACTAL_AGENT_PRIVATE_KEY", "operator wallet private key for allocation execution");
    require("TOKEN_FACTORY_ADDRESS", "canonical token factory deployment");
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("\n[env] Invalid environment configuration:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  console.error(
    "\nSee .env.example for the full list of required variables. " +
      "There is no demo/mock mode — real sandbox credentials are required.\n",
  );
  throw new Error("Invalid environment configuration");
}


const operatorPrivateKey = parsed.data.FRACTAL_AGENT_PRIVATE_KEY ?? parsed.data.PRIVATE_KEY;
const derivedOperatorAddress = operatorPrivateKey
  ? privateKeyToAccount(operatorPrivateKey as `0x${string}`).address
  : undefined;

export const env = {
  ...parsed.data,
  FRACTAL_AGENT_PRIVATE_KEY: operatorPrivateKey,
  FRACTAL_AGENT_ADDRESS: parsed.data.FRACTAL_AGENT_ADDRESS ?? derivedOperatorAddress,
};
