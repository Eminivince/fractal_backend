/**
 * key-manager.ts
 * Abstraction layer for private key management.
 *
 * Default provider reads keys from environment variables (current behavior).
 * AWS KMS and Vault are explicitly unsupported extension points in this
 * revision. The environment schema refuses every on-chain worker in production
 * until a reviewed external EVM signer is integrated; it must never quietly
 * fall back from one provider to another.
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

// ── External-provider extension points ──────────────────────────────────────

class AwsKmsKeyProvider implements KeyProvider {
  async getPrivateKey(_keyName: KeyName): Promise<`0x${string}`> {
    // An asymmetric KMS key must sign EVM digests without exporting a private
    // key. That requires a LocalAccount-compatible signer, DER-signature
    // normalization/recovery, public-key/address validation, IAM policy, and
    // integration tests. Returning a private key here would defeat KMS.
    throw new Error(
      "AWS KMS EVM signer is not implemented; on-chain execution is deliberately blocked for this provider.",
    );
  }
}

// ── HashiCorp Vault provider stub ───────────────────────────────────────────

class VaultKeyProvider implements KeyProvider {
  async getPrivateKey(_keyName: KeyName): Promise<`0x${string}`> {
    // Vault must expose a reviewed EVM signing operation rather than return a
    // raw private key to the application process.
    throw new Error(
      "Vault EVM signer is not implemented; on-chain execution is deliberately blocked for this provider.",
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
