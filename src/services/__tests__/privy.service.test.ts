import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ PRIVY_ENABLED: false, PRIVY_APP_ID: "app-id", PRIVY_APP_SECRET: "app-secret" }));
vi.mock("../../config/env.js", () => ({ env }));

async function loadPrivy() {
  vi.resetModules();
  return import("../privy.service.js");
}

beforeEach(() => {
  env.PRIVY_ENABLED = false;
  env.PRIVY_APP_ID = "app-id";
  env.PRIVY_APP_SECRET = "app-secret";
});
afterEach(() => vi.unstubAllGlobals());

describe("Privy wallet adapter", () => {
  it("does not provision or verify wallets while Privy is disabled", async () => {
    const privy = await loadPrivy();
    await expect(privy.createEmbeddedWallet("user-1")).rejects.toThrow("provisioning is disabled");
    await expect(privy.getUserWallets("user-1")).rejects.toThrow("provisioning is disabled");
    await expect(privy.verifyPrivyToken("token")).rejects.toThrow("Privy not enabled");
  });

  it("creates and lists embedded wallets with authenticated provider requests", async () => {
    env.PRIVY_ENABLED = true;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ id: "wallet-1", address: "0xabc" }) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ wallets: [{ id: "wallet-1", address: "0xabc" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const privy = await loadPrivy();

    await expect(privy.createEmbeddedWallet("user-1")).resolves.toEqual({ walletId: "wallet-1", address: "0xabc" });
    await expect(privy.getUserWallets("user-1")).resolves.toEqual([{ id: "wallet-1", address: "0xabc" }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://auth.privy.io/api/v1/wallets");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Basic YXBwLWlkOmFwcC1zZWNyZXQ=", "privy-app-id": "app-id" }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ chain_type: "ethereum", owner: { type: "user", user_id: "user-1" } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://auth.privy.io/api/v1/users/user-1/wallets");
  });

  it("verifies a token and exposes an optional embedded-wallet address", async () => {
    env.PRIVY_ENABLED = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ user_id: "user-1", wallet: { address: "0xabc" } }) }));
    const privy = await loadPrivy();
    await expect(privy.verifyPrivyToken("token-1")).resolves.toEqual({ userId: "user-1", walletAddress: "0xabc" });
  });

  it("returns clear provider and configuration errors", async () => {
    env.PRIVY_ENABLED = true;
    env.PRIVY_APP_ID = undefined as any;
    let privy = await loadPrivy();
    await expect(privy.createEmbeddedWallet("user-1")).rejects.toThrow("PRIVY_APP_ID and PRIVY_APP_SECRET");

    env.PRIVY_APP_ID = "app-id";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 422, text: vi.fn().mockResolvedValue("Invalid owner") })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 401 }));
    privy = await loadPrivy();
    await expect(privy.createEmbeddedWallet("user-1")).rejects.toThrow("422 Invalid owner");
    await expect(privy.getUserWallets("user-1")).rejects.toThrow("Failed to get Privy wallets: 500");
    await expect(privy.verifyPrivyToken("token-1")).rejects.toThrow("Privy token verification failed: 401");
  });
});
