import { createHash, randomUUID } from "node:crypto";
import { verifyMessage } from "viem";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class InvestorWalletLinkError extends Error {}

type ChallengeRow = {
  id: string; investor_identity_id: string; chain_id: number; wallet_address: string; message_hash: string;
  expires_at: Date; status: "issued" | "consumed" | "expired"; consumed_at: Date | null;
};

function address(value: string): `0x${string}` {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new InvestorWalletLinkError("walletAddress must be an EVM address");
  return normalized as `0x${string}`;
}

function chainId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvestorWalletLinkError("chainId must be a positive safe integer");
  return value;
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function message(input: { identityId: string; chainId: number; walletAddress: string; challengeId: string; expiresAt: Date }) {
  return [
    "Fractal wallet ownership verification", `Identity: ${input.identityId}`, `Chain ID: ${input.chainId}`,
    `Wallet: ${input.walletAddress}`, `Challenge: ${input.challengeId}`, `Expires at: ${input.expiresAt.toISOString()}`,
  ].join("\n");
}

export async function createInvestorWalletLinkChallenge(input: { investorIdentityId: string; chainId: number; walletAddress: string; expiresAt?: Date }) {
  const normalizedAddress = address(input.walletAddress);
  const normalizedChainId = chainId(input.chainId);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 10 * 60 * 1_000);
  if (expiresAt <= new Date()) throw new InvestorWalletLinkError("Wallet link challenge expiry must be in the future");
  const challengeId = randomUUID();
  const signatureMessage = message({ identityId: input.investorIdentityId, chainId: normalizedChainId, walletAddress: normalizedAddress, challengeId, expiresAt });
  await withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO fractal.investor_wallet_link_challenges
         (id, investor_identity_id, chain_id, wallet_address, message_hash, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued')`,
      [challengeId, input.investorIdentityId, normalizedChainId, normalizedAddress, hash(signatureMessage), expiresAt],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${input.investorIdentityId}`, actorId: input.investorIdentityId, actorType: "user",
      action: "investor.wallet_link.challenge_issued", entityType: "investor_wallet_link_challenge", entityId: challengeId,
      payload: { chainId: normalizedChainId, walletAddress: normalizedAddress, expiresAt: expiresAt.toISOString() },
    });
    await appendOutboxEvent(client, { aggregateType: "investor_wallet_link_challenge", aggregateId: challengeId, eventType: "investor.wallet_link.challenge_issued", payload: { investorIdentityId: input.investorIdentityId, auditEventId: audit.id } });
  });
  return { challengeId, chainId: normalizedChainId, walletAddress: normalizedAddress, message: signatureMessage, expiresAt: expiresAt.toISOString() };
}

export async function confirmInvestorWalletLinkChallenge(input: { investorIdentityId: string; challengeId: string; signature: string }) {
  if (!/^0x[a-fA-F0-9]{130}$/.test(input.signature)) throw new InvestorWalletLinkError("signature must be a 65-byte EVM signature");
  return withPostgresTransaction(async (client) => {
    const result = await client.query<ChallengeRow>("SELECT * FROM fractal.investor_wallet_link_challenges WHERE id = $1 FOR UPDATE", [input.challengeId]);
    const challenge = result.rows[0];
    if (!challenge || challenge.investor_identity_id !== input.investorIdentityId) throw new InvestorWalletLinkError("Wallet link challenge not found");
    if (challenge.status !== "issued") throw new InvestorWalletLinkError("Wallet link challenge has already been used");
    if (challenge.expires_at <= new Date()) {
      await client.query("UPDATE fractal.investor_wallet_link_challenges SET status = 'expired', consumed_at = now() WHERE id = $1", [challenge.id]);
      throw new InvestorWalletLinkError("Wallet link challenge has expired");
    }
    const signatureMessage = message({ identityId: challenge.investor_identity_id, chainId: challenge.chain_id, walletAddress: challenge.wallet_address, challengeId: challenge.id, expiresAt: challenge.expires_at });
    if (hash(signatureMessage) !== challenge.message_hash) throw new Error("Wallet link challenge integrity check failed");
    let valid = false;
    try {
      valid = await verifyMessage({ address: challenge.wallet_address as `0x${string}`, message: signatureMessage, signature: input.signature as `0x${string}` });
    } catch {
      valid = false;
    }
    if (!valid) throw new InvestorWalletLinkError("Signature does not prove ownership of this wallet");
    const existing = await client.query<{ id: string; investor_identity_id: string; status: string }>(
      "SELECT id, investor_identity_id, status FROM fractal.investor_wallets WHERE chain_id = $1 AND wallet_address = $2 FOR UPDATE",
      [challenge.chain_id, challenge.wallet_address],
    );
    const linked = existing.rows[0];
    if (linked?.status === "active" && linked.investor_identity_id !== input.investorIdentityId) throw new InvestorWalletLinkError("Wallet is already linked to another investor");
    if (linked?.status === "active") throw new InvestorWalletLinkError("Wallet is already linked to this investor");
    if (linked?.status === "revoked") throw new InvestorWalletLinkError("Wallet was previously revoked and requires a controlled recovery procedure");
    const walletId = randomUUID();
    await client.query(
      `INSERT INTO fractal.investor_wallets
         (id, investor_identity_id, chain_id, wallet_address, link_challenge_id, signature_hash, status, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', now())`,
      [walletId, input.investorIdentityId, challenge.chain_id, challenge.wallet_address, challenge.id, hash(input.signature.toLowerCase())],
    );
    await client.query("UPDATE fractal.investor_wallet_link_challenges SET status = 'consumed', consumed_at = now() WHERE id = $1", [challenge.id]);
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${input.investorIdentityId}`, actorId: input.investorIdentityId, actorType: "user",
      action: "investor.wallet_link.confirmed", entityType: "investor_wallet", entityId: walletId,
      payload: { challengeId: challenge.id, chainId: challenge.chain_id, walletAddress: challenge.wallet_address },
    });
    await appendOutboxEvent(client, { aggregateType: "investor_wallet", aggregateId: walletId, eventType: "investor.wallet_link.confirmed", payload: { investorIdentityId: input.investorIdentityId, auditEventId: audit.id } });
    return { walletId, chainId: challenge.chain_id, walletAddress: challenge.wallet_address, verifiedAt: new Date().toISOString() };
  });
}

export async function listInvestorWallets(investorIdentityId: string) {
  const result = await requirePostgres().query<{ id: string; chain_id: number; wallet_address: string; status: string; verified_at: Date; revoked_at: Date | null }>(
    "SELECT id, chain_id, wallet_address, status, verified_at, revoked_at FROM fractal.investor_wallets WHERE investor_identity_id = $1 ORDER BY verified_at DESC, id DESC",
    [investorIdentityId],
  );
  return result.rows.map((row) => ({ id: row.id, chainId: row.chain_id, walletAddress: row.wallet_address, status: row.status, verifiedAt: row.verified_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null }));
}
