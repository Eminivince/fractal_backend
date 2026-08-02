import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import {
  confirmInvestorWalletLinkChallenge,
  createInvestorWalletLinkChallenge,
  InvestorWalletLinkError,
  listInvestorWallets,
} from "../postgres-investor-wallets.js";

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
let investorId = "";
let createdIdentityIds: string[] = [];

async function insertIdentity(id: string, label: string) {
  const emailLocal = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  await postgresQuery("INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, $3, 'active')", [id, `${emailLocal}-${id}@example.test`, label]);
  createdIdentityIds.push(id);
}

describe("PostgreSQL investor wallets", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
    await postgresQuery("TRUNCATE fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.investor_wallets, fractal.investor_wallet_link_challenges");
  });
  beforeEach(async () => {
    createdIdentityIds = [];
    investorId = randomUUID();
    await insertIdentity(investorId, "Wallet investor");
  });
  afterEach(async () => {
    await postgresQuery("TRUNCATE fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.investor_wallets, fractal.investor_wallet_link_challenges");
    if (createdIdentityIds.length) await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [createdIdentityIds]);
  });
  afterAll(async () => { await disconnectPostgres(); });

  it("requires a wallet signature before binding an active investor wallet", async () => {
    const challenge = await createInvestorWalletLinkChallenge({ investorIdentityId: investorId, chainId: 11155111, walletAddress: account.address });
    const signature = await account.signMessage({ message: challenge.message });
    const linked = await confirmInvestorWalletLinkChallenge({ investorIdentityId: investorId, challengeId: challenge.challengeId, signature });
    expect(linked).toMatchObject({ chainId: 11155111, walletAddress: account.address.toLowerCase() });
    expect(await listInvestorWallets(investorId)).toMatchObject([{ walletAddress: account.address.toLowerCase(), status: "active" }]);
    expect((await postgresQuery<{ status: string }>("SELECT status FROM fractal.investor_wallet_link_challenges WHERE id = $1", [challenge.challengeId])).rows[0]?.status).toBe("consumed");
  });

  it("rejects a mismatched signature and prevents another identity from claiming an active wallet", async () => {
    const challenge = await createInvestorWalletLinkChallenge({ investorIdentityId: investorId, chainId: 11155111, walletAddress: account.address });
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: investorId, challengeId: challenge.challengeId, signature: `0x${"00".repeat(65)}` }))
      .rejects.toBeInstanceOf(InvestorWalletLinkError);
    const signature = await account.signMessage({ message: challenge.message });
    await confirmInvestorWalletLinkChallenge({ investorIdentityId: investorId, challengeId: challenge.challengeId, signature });
    const otherIdentityId = randomUUID();
    await insertIdentity(otherIdentityId, "Other wallet investor");
    const collision = await createInvestorWalletLinkChallenge({ investorIdentityId: otherIdentityId, chainId: 11155111, walletAddress: account.address });
    const collisionSignature = await account.signMessage({ message: collision.message });
    await expect(confirmInvestorWalletLinkChallenge({ investorIdentityId: otherIdentityId, challengeId: collision.challengeId, signature: collisionSignature }))
      .rejects.toThrow(/already linked to another investor/);
  });
});
