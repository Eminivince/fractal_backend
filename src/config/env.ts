import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const emptyToUndefined = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim().length === 0)
      return undefined;
    return value;
  }, schema);

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  ALLOWED_ORIGINS: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("8h"),
  ANCHOR_WORKER_ENABLED: z.coerce.boolean().default(false),
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
  RECONCILIATION_WORKER_ENABLED: z.coerce.boolean().default(true),
  RECONCILIATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300000),
  RECONCILIATION_TOLERANCE: z.coerce.number().nonnegative().default(0.5),
  NOTIFICATION_EMAIL_ENABLED: z.coerce.boolean().default(true),
  NOTIFICATION_EMAIL_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15000),
  NOTIFICATION_EMAIL_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  WORK_ORDER_SLA_ESCALATION_ENABLED: z.coerce.boolean().default(true),
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
  SENDGRID_API_KEY: emptyToUndefined(z.string().min(8).optional()),
  SMTP_HOST: emptyToUndefined(z.string().min(2).optional()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: emptyToUndefined(z.string().min(1).optional()),
  SMTP_PASS: emptyToUndefined(z.string().min(1).optional()),
  SMTP_FROM: emptyToUndefined(z.string().email().optional()),
  FILE_STORAGE_PROVIDER: z.enum(["local", "s3", "cloudinary"]).default("local"),
  FILE_STORAGE_FALLBACK_TO_LOCAL: z.coerce.boolean().default(true),
  FILE_STORAGE_DIR: z.string().default("storage"),
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
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_KEY_PREFIX: emptyToUndefined(z.string().optional()),
  // I-61: App base URL for generating invite links
  APP_BASE_URL: emptyToUndefined(z.string().url().optional()),
  PAYSTACK_SECRET_KEY: emptyToUndefined(z.string().min(8).optional()),
  PAYSTACK_WEBHOOK_SECRET: emptyToUndefined(z.string().min(8).optional()),
  PAYSTACK_ENABLED: z.coerce.boolean().default(false),
  SUMSUB_APP_TOKEN: emptyToUndefined(z.string().min(8).optional()),
  SUMSUB_SECRET_KEY: emptyToUndefined(z.string().min(8).optional()),
  SUMSUB_WEBHOOK_SECRET: z.string().min(8),
  SUMSUB_LEVEL_NAME: z.string().default("basic-kyc-level"),
  SUMSUB_ENABLED: z.coerce.boolean().default(false),
  // Key management provider: "env" (default), "aws_kms", or "vault"
  KEY_MANAGEMENT_PROVIDER: z.enum(["env", "aws_kms", "vault"]).default("env"),
  // Blockchain / Polygon
  POLYGON_RPC_URL: z.string().default("https://polygon-rpc.com"),
  POLYGON_AMOY_RPC_URL: z
    .string()
    .default("https://rpc-amoy.polygon.technology"),
  FRACTAL_AGENT_PRIVATE_KEY: emptyToUndefined(
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
  BLOCKCHAIN_WORKER_ENABLED: z.coerce.boolean().default(false),
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
  PRIVY_ENABLED: z.coerce.boolean().default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

console.log(parsed.data);

export const env = parsed.data;
