import { defineConfig } from "vitest/config";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("POSTGRES_TEST_DATABASE_URL is required for PostgreSQL integration tests");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname).replace(/^\//, "");
if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
  throw new Error(`Refusing to run PostgreSQL integration tests against non-test database "${databaseName}"; set POSTGRES_TEST_DATABASE_URL`);
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.postgres.integration.test.ts"],
    exclude: ["node_modules", "dist"],
    // Full migration replay and shadow-schema verification can exceed 30
    // seconds on a constrained CI runner. Keep the checks active.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      DATABASE_URL: databaseUrl,
      MFA_TOTP_ENABLED: "true",
      MFA_TOTP_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      MFA_RECOVERY_CODE_PEPPER: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      // The suite explicitly switches to native Postgres identities where it
      // tests that cutover. Keep the legacy-session fixtures independent of a
      // developer's local runtime authority.
      AUTH_IDENTITY_AUTHORITY: "mongo",
    },
  },
});
