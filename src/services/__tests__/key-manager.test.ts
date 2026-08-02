import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock("../../config/env.js", () => ({ env }));

async function loadKeyManager() {
  vi.resetModules();
  return import("../key-manager.js");
}

beforeEach(() => {
  Object.keys(env).forEach((key) => delete env[key]);
});

describe("key manager", () => {
  it("reads configured environment keys", async () => {
    env.KEY_MANAGEMENT_PROVIDER = "env";
    env.FRACTAL_AGENT_PRIVATE_KEY = "0xagent";
    env.ANCHOR_PRIVATE_KEY = "0xanchor";
    const { keyManager } = await loadKeyManager();
    await expect(keyManager.getPrivateKey("fractal_agent")).resolves.toBe("0xagent");
    await expect(keyManager.getPrivateKey("anchor")).resolves.toBe("0xanchor");
  });

  it("does not continue when an environment key is missing", async () => {
    const { keyManager } = await loadKeyManager();
    await expect(keyManager.getPrivateKey("fractal_agent")).rejects.toThrow("not configured");
  });

  it("blocks unimplemented external signing providers", async () => {
    env.KEY_MANAGEMENT_PROVIDER = "aws_kms";
    let module = await loadKeyManager();
    await expect(module.keyManager.getPrivateKey("anchor")).rejects.toThrow("AWS KMS EVM signer is not implemented");

    env.KEY_MANAGEMENT_PROVIDER = "vault";
    module = await loadKeyManager();
    await expect(module.keyManager.getPrivateKey("anchor")).rejects.toThrow("Vault EVM signer is not implemented");
  });

  it("rejects unknown key management providers", async () => {
    env.KEY_MANAGEMENT_PROVIDER = "unreviewed_provider";
    await expect(loadKeyManager()).rejects.toThrow("Unknown KEY_MANAGEMENT_PROVIDER");
  });
});
