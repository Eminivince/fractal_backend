import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  vi.doMock("dotenv", () => ({ default: { config: vi.fn() } }));
  process.env = { ...ORIGINAL_ENV, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  return import("../env.js");
}

function productionBaseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    MONGODB_URI: "mongodb://mongo.example.test:27017/fractal",
    DATABASE_URL: "postgresql://fractal:fractal@postgres.example.test:5432/fractal",
    POSTGRES_REQUIRED: "true",
    ALLOWED_ORIGINS: "https://fractal.example.test",
    APP_BASE_URL: "https://fractal.example.test",
    JWT_SECRET: "a".repeat(32),
    APPLICATION_RELEASE_SHA256: "b".repeat(64),
    AUTH_IDENTITY_AUTHORITY: "postgres",
    REDIS_URL: "redis://redis.example.test:6379/0",
    AUTH_EMAIL_DELIVERY_ENABLED: "true",
    NOTIFICATION_EMAIL_ENABLED: "true",
    EMAIL_FROM: "notifications@example.test",
    RESEND_API_KEY: "re_test_key_123456",
    EMAIL_DELIVERY_SECRET_KEY: "c".repeat(32),
    MFA_TOTP_ENABLED: "true",
    MFA_TOTP_ENCRYPTION_KEY: "d".repeat(64),
    MFA_RECOVERY_CODE_PEPPER: "e".repeat(64),
    FILE_STORAGE_PROVIDER: "s3",
    FILE_STORAGE_FALLBACK_TO_LOCAL: "false",
    MALWARE_SCAN_REQUIRED: "true",
    MALWARE_SCAN_HOST: "clamav.example.test",
    S3_BUCKET: "fractal-private",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
    PAYSTACK_ENABLED: "false",
    SUMSUB_ENABLED: "false",
    PRIVY_ENABLED: "false",
    BLOCKCHAIN_WORKER_ENABLED: "false",
    CHAIN_DEPLOYMENT_EXECUTOR_ENABLED: "false",
    ALLOCATION_CHAIN_EXECUTOR_ENABLED: "false",
    ANCHOR_WORKER_ENABLED: "false",
    ...overrides,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("environment validation", () => {
  it("accepts Cloudflare R2 production storage without an AWS KMS key ID", async () => {
    const module = await loadEnv(productionBaseEnv({
      S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      S3_FORCE_PATH_STYLE: "true",
      S3_KMS_KEY_ID: undefined,
    }));
    expect(module.env.S3_ENDPOINT).toBe("https://account-id.r2.cloudflarestorage.com");
    expect(module.env.S3_KMS_KEY_ID).toBeUndefined();
  });

  it("accepts the temporary production launch exception with malware scanning disabled", async () => {
    const module = await loadEnv(productionBaseEnv({
      S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      S3_FORCE_PATH_STYLE: "true",
      S3_KMS_KEY_ID: undefined,
      MALWARE_SCAN_REQUIRED: "false",
      MALWARE_SCAN_HOST: undefined,
    }));
    expect(module.env.MALWARE_SCAN_REQUIRED).toBe(false);
    expect(module.env.MALWARE_SCAN_HOST).toBeUndefined();
  });

  it("requires a malware scanner host when production malware scanning is enabled", async () => {
    await expect(loadEnv(productionBaseEnv({
      S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      S3_FORCE_PATH_STYLE: "true",
      S3_KMS_KEY_ID: undefined,
      MALWARE_SCAN_REQUIRED: "true",
      MALWARE_SCAN_HOST: undefined,
    }))).rejects.toThrow("Invalid environment configuration");
  });

  it("requires an AWS KMS key ID for production AWS S3 storage", async () => {
    await expect(loadEnv(productionBaseEnv({
      S3_ENDPOINT: undefined,
      S3_REGION: "eu-west-2",
      S3_KMS_KEY_ID: undefined,
    }))).rejects.toThrow("Invalid environment configuration");
  });
});
