import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    exclude: ["node_modules", "dist", "src/**/*.postgres.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    env: {
      // Exercise registration consent and other production-only safeguards.
      NODE_ENV: "test",
      // Keep this suite independent of a developer's local migration state.
      // The dedicated PostgreSQL suite verifies the production cutover mode.
      AUTH_IDENTITY_AUTHORITY: "mongo",
      MFA_TOTP_ENABLED: "true",
      MFA_TOTP_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      MFA_RECOVERY_CODE_PEPPER: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    },
  },
});
