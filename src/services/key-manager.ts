/**
 * key-manager.ts
 * Abstraction layer for private key management.
 *
 * Default provider reads keys from environment variables (current behavior).
 * Set KEY_MANAGEMENT_PROVIDER to "aws_kms" or "vault" for production-grade
 * key management — those integrations are stubbed here as extension points.
 */
import { env } from "../config/env.js";

export type KeyName = "fractal_agent" | "anchor";

export interface KeyProvider {
  getPrivateKey(keyName: KeyName): Promise<`0x${string}`>;
}

// ── Env provider (default, reads from process.env) ──────────────────────────

class EnvKeyProvider implements KeyProvider {
  private readonly keyMap: Record<KeyName, string | undefined> = {
    fractal_agent: env.FRACTAL_AGENT_PRIVATE_KEY,
    anchor: env.ANCHOR_PRIVATE_KEY,
  };

  async getPrivateKey(keyName: KeyName): Promise<`0x${string}`> {
    const value = this.keyMap[keyName];
    if (!value) {
      throw new Error(
        `Private key "${keyName}" not configured. Set the corresponding environment variable.`,
      );
    }
    return value as `0x${string}`;
  }
}

// ── AWS KMS provider stub ───────────────────────────────────────────────────

class AwsKmsKeyProvider implements KeyProvider {
  async getPrivateKey(_keyName: KeyName): Promise<`0x${string}`> {
    // Integration point: use @aws-sdk/client-kms to retrieve or sign with KMS keys.
    // KMS key IDs should be mapped from keyName via env vars (e.g. KMS_FRACTAL_AGENT_KEY_ID).
    throw new Error(
      "AWS KMS provider not implemented. Install @aws-sdk/client-kms and configure KMS key IDs.",
    );
  }
}

// ── HashiCorp Vault provider stub ───────────────────────────────────────────

class VaultKeyProvider implements KeyProvider {
  async getPrivateKey(_keyName: KeyName): Promise<`0x${string}`> {
    // Integration point: use node-vault or HTTP API to read secrets from Vault.
    // Vault address and token should come from env vars (VAULT_ADDR, VAULT_TOKEN).
    throw new Error(
      "Vault provider not implemented. Install node-vault and configure VAULT_ADDR/VAULT_TOKEN.",
    );
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

function createKeyProvider(): KeyProvider {
  const provider = env.KEY_MANAGEMENT_PROVIDER ?? "env";
  switch (provider) {
    case "env":
      return new EnvKeyProvider();
    case "aws_kms":
      return new AwsKmsKeyProvider();
    case "vault":
      return new VaultKeyProvider();
    default:
      throw new Error(`Unknown KEY_MANAGEMENT_PROVIDER: ${provider}`);
  }
}

/** Singleton key manager instance */
export const keyManager = createKeyProvider();
