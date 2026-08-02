import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (operation: (client: { query: typeof query }) => Promise<unknown>) => operation({ query })));
const audit = vi.hoisted(() => vi.fn(async () => ({ id: "audit-1" })));
const outbox = vi.hoisted(() => vi.fn(async () => undefined));
const verifyMessage = vi.hoisted(() => vi.fn());

vi.mock("viem", () => ({ verifyMessage }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query }), withPostgresTransaction: transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: outbox }));

import { InvestorWalletLinkError, confirmInvestorWalletLinkChallenge, createInvestorWalletLinkChallenge, listInvestorWallets } from "../postgres-investor-wallets.js";

const walletAddress = `0x${"a".repeat(40)}`;
const signature = `0x${"b".repeat(130)}`;
const future = () => new Date(Date.now() + 10 * 60 * 1_000);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function challenge(input: { id?: string; identityId?: string; expiresAt?: Date; status?: "issued" | "consumed" | "expired"; messageHash?: string } = {}) {
  const id = input.id ?? "challenge-1"; const identityId = input.identityId ?? "investor-1"; const expiresAt = input.expiresAt ?? future();
  const message = ["Fractal wallet ownership verification", `Identity: ${identityId}`, "Chain ID: 1", `Wallet: ${walletAddress}`, `Challenge: ${id}`, `Expires at: ${expiresAt.toISOString()}`].join("\n");
  return { id, investor_identity_id: identityId, chain_id: 1, wallet_address: walletAddress, message_hash: input.messageHash ?? digest(message), expires_at: expiresAt, status: input.status ?? "issued", consumed_at: null } as any;
}

beforeEach(() => { query.mockReset(); transaction.mockClear(); audit.mockClear(); outbox.mockClear(); verifyMessage.mockReset(); });

describe("PostgreSQL investor wallets", () => {
  it("creates a canonical ownership challenge and records its controlled events", async () => {
    const expiresAt = new Date("2027-01-01T00:00:00.000Z");
    await expect(createInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", chainId: 1, walletAddress: walletAddress.toUpperCase(), expiresAt })).resolves.toEqual(expect.objectContaining({ challengeId: expect.any(String), chainId: 1, walletAddress, expiresAt: expiresAt.toISOString(), message: expect.stringContaining(`Wallet: ${walletAddress}`) }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO fractal.investor_wallet_link_challenges"), [expect.any(String), "investor-1", 1, walletAddress, expect.any(String), expiresAt]);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "investor.wallet_link.challenge_issued" }));
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "investor.wallet_link.challenge_issued" }));
    await expect(createInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", chainId: 0, walletAddress })).rejects.toBeInstanceOf(InvestorWalletLinkError);
    await expect(createInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", chainId: 1, walletAddress: "not-a-wallet" })).rejects.toThrow("EVM address");
    await expect(createInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", chainId: 1, walletAddress, expiresAt: new Date(0) })).rejects.toThrow("future");
  });

  it("confirms a valid signed ownership challenge and consumes it", async () => {
    query.mockResolvedValueOnce({ rows: [challenge()] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    verifyMessage.mockResolvedValueOnce(true);
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).resolves.toEqual(expect.objectContaining({ walletId: expect.any(String), chainId: 1, walletAddress, verifiedAt: expect.any(String) }));
    expect(verifyMessage).toHaveBeenCalledWith(expect.objectContaining({ address: walletAddress, signature }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO fractal.investor_wallets"), expect.arrayContaining(["investor-1", 1, walletAddress, "challenge-1"]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'consumed'"), ["challenge-1"]);
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "investor.wallet_link.confirmed" }));
  });

  it("fails closed for malformed, missing, used, expired, and tampered challenges", async () => {
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature: "bad" })).rejects.toThrow("65-byte");
    query.mockResolvedValueOnce({ rows: [] });
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "missing", signature })).rejects.toThrow("not found");
    query.mockResolvedValueOnce({ rows: [challenge({ status: "consumed" })] });
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).rejects.toThrow("already been used");
    query.mockResolvedValueOnce({ rows: [challenge({ expiresAt: new Date(0) })] }).mockResolvedValueOnce({ rows: [] });
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).rejects.toThrow("expired");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'expired'"), ["challenge-1"]);
    query.mockResolvedValueOnce({ rows: [challenge({ messageHash: "tampered" })] });
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).rejects.toThrow("integrity check");
  });

  it("rejects invalid signatures and wallet links that are already controlled", async () => {
    query.mockResolvedValueOnce({ rows: [challenge()] }); verifyMessage.mockResolvedValueOnce(false);
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).rejects.toThrow("does not prove");
    query.mockResolvedValueOnce({ rows: [challenge()] }); verifyMessage.mockRejectedValueOnce(new Error("provider error"));
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).rejects.toThrow("does not prove");
    for (const linked of [{ id: "wallet-1", investor_identity_id: "other", status: "active" }, { id: "wallet-1", investor_identity_id: "investor-1", status: "active" }, { id: "wallet-1", investor_identity_id: "investor-1", status: "revoked" }]) {
      query.mockResolvedValueOnce({ rows: [challenge()] }).mockResolvedValueOnce({ rows: [linked] }); verifyMessage.mockResolvedValueOnce(true);
      await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: "investor-1", challengeId: "challenge-1", signature })).rejects.toThrow(linked.status === "revoked" ? "controlled recovery" : "already linked");
    }
  });

  it("lists linked wallets without exposing signature or challenge material", async () => {
    const verifiedAt = new Date("2026-07-01T00:00:00.000Z");
    query.mockResolvedValueOnce({ rows: [{ id: "wallet-1", chain_id: 1, wallet_address: walletAddress, status: "active", verified_at: verifiedAt, revoked_at: null }] });
    await expect(listInvestorWallets("investor-1")).resolves.toEqual([{ id: "wallet-1", chainId: 1, walletAddress, status: "active", verifiedAt: verifiedAt.toISOString(), revokedAt: null }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE investor_identity_id = $1"), ["investor-1"]);
  });
});
