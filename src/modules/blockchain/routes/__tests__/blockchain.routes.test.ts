import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), blockchainFind: vi.fn(), blockchainFindById: vi.fn(), createWallet: vi.fn(), enqueue: vi.fn(), getBalance: vi.fn(), getTransferable: vi.fn(), investorFindById: vi.fn(), investorUpdate: vi.fn(), isVerified: vi.fn(), offeringFindById: vi.fn(), subscriptionFind: vi.fn(), env: { CHAIN_ID: 8453 },
}));

vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../db/models/index.js", () => ({
  BlockchainOpModel: { find: mocks.blockchainFind, findById: mocks.blockchainFindById },
  OfferingModel: { findById: mocks.offeringFindById },
  SubscriptionModel: { find: mocks.subscriptionFind },
  InvestorProfileModel: { findById: mocks.investorFindById, findByIdAndUpdate: mocks.investorUpdate },
}));
vi.mock("../../../../workers/blockchain.worker.js", () => ({ enqueueBlockchainOp: mocks.enqueue }));
vi.mock("../../../../services/blockchain.service.js", () => ({ isWalletVerified: mocks.isVerified, getTokenBalance: mocks.getBalance, getTransferableBalance: mocks.getTransferable }));
vi.mock("../../../../services/privy.service.js", () => ({ createEmbeddedWallet: mocks.createWallet }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));

import { blockchainRoutes } from "../blockchain.routes.js";

let app: ReturnType<typeof Fastify>;
const wallet = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });

beforeEach(async () => {
  for (const mock of Object.values(mocks)) if (typeof (mock as any).mockReset === "function") (mock as any).mockReset();
  mocks.authorize.mockReturnValue(undefined);
  mocks.enqueue.mockResolvedValue(undefined);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.addHook("onRequest", async (request: FastifyRequest) => { (request as any).user = { userId: "admin-1", role: "admin" }; });
  await app.register(blockchainRoutes);
  await app.ready();
});

afterEach(async () => { await app.close(); });

describe("blockchain routes", () => {
  it("lists operations, reads an operation, and retires the legacy deploy route", async () => {
    mocks.blockchainFind.mockReturnValueOnce({ sort: vi.fn(() => ({ limit: vi.fn(() => lean([{ _id: "op-1" }])) })) });
    const listed = await app.inject({ method: "GET", url: "/blockchain/ops" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ ops: [{ _id: "op-1" }] });
    mocks.blockchainFindById.mockReturnValueOnce(lean({ _id: "op-1", opType: "mint" }));
    await expect(app.inject({ method: "GET", url: "/blockchain/ops/op-1" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/blockchain/deploy-token" })).resolves.toMatchObject({ statusCode: 410 });
  });

  it("queues mint and payout operations for a deployed token", async () => {
    mocks.offeringFindById.mockResolvedValueOnce({ terms: { minTicket: 100 }, tokenDeployment: { contractAddress: contract, status: "deployed", lockupDays: 30 } });
    mocks.subscriptionFind.mockReturnValueOnce(lean([{ _id: "subscription-1", walletAddress: wallet, amount: 5000 }]));
    const mint = await app.inject({ method: "POST", url: "/blockchain/trigger-mint", payload: { offeringId: "offering-1", tokenId: 2 } });
    expect(mint.statusCode).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ opType: "mint", payload: expect.objectContaining({ tokenId: 2, lockupDays: 30 }) }));

    mocks.offeringFindById.mockResolvedValueOnce({ tokenDeployment: { contractAddress: contract, status: "deployed" } });
    const payout = await app.inject({ method: "POST", url: "/blockchain/batch-payout", payload: { offeringId: "offering-1", distributionId: "distribution-1", recipients: [wallet], netAmountsUsdt: ["2500000"] } });
    expect(payout.statusCode).toBe(200);
    expect(payout.json()).toEqual({ message: "Batch payout queued", recipientCount: 1 });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ opType: "batch_payout", entityId: "distribution-1" }));
  });

  it("returns token balances and queues investor whitelisting", async () => {
    mocks.getBalance.mockResolvedValueOnce(1234n);
    mocks.getTransferable.mockResolvedValueOnce(1000n);
    await expect(app.inject({ method: "GET", url: `/blockchain/balance/${contract}/${wallet}?tokenId=2` })).resolves.toMatchObject({ statusCode: 200, json: expect.any(Function) });
    const transferable = await app.inject({ method: "GET", url: `/blockchain/transferable-balance/${contract}/${wallet}/2` });
    expect(transferable.json()).toMatchObject({ tokenId: "2", transferableBalance: "1000" });
    const whitelisted = await app.inject({ method: "POST", url: "/blockchain/whitelist-investor", payload: { contractAddress: contract, walletAddress: wallet } });
    expect(whitelisted.statusCode).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ opType: "whitelist_investor" }));
  });

  it("provisions an embedded wallet and queues a KYC claim", async () => {
    mocks.investorFindById.mockResolvedValueOnce({ _id: { toString: () => "profile-1" } });
    mocks.createWallet.mockResolvedValueOnce({ walletId: "privy-wallet-1", address: wallet });
    const provisioned = await app.inject({ method: "POST", url: "/blockchain/provision-wallet", payload: { investorProfileId: "profile-1" } });
    expect(provisioned.statusCode).toBe(200);
    expect(mocks.investorUpdate).toHaveBeenCalledWith("profile-1", expect.objectContaining({ primaryWalletAddress: wallet }));

    mocks.investorFindById.mockResolvedValueOnce({ primaryWalletAddress: wallet, onchainIdentity: { identityContractAddress: contract } });
    const claim = await app.inject({ method: "POST", url: "/blockchain/issue-kyc-claim", payload: { investorProfileId: "profile-1", countryCode: 566 } });
    expect(claim.statusCode).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ opType: "issue_kyc_claim" }));
  });

  it("rejects duplicate wallet provisioning and incomplete KYC identities", async () => {
    mocks.investorFindById.mockResolvedValueOnce({ primaryWalletAddress: wallet });
    await expect(app.inject({ method: "POST", url: "/blockchain/provision-wallet", payload: { investorProfileId: "profile-1" } })).resolves.toMatchObject({ statusCode: 409 });
    mocks.investorFindById.mockResolvedValueOnce({ primaryWalletAddress: undefined });
    await expect(app.inject({ method: "POST", url: "/blockchain/issue-kyc-claim", payload: { investorProfileId: "profile-1" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.investorFindById.mockResolvedValueOnce({ primaryWalletAddress: wallet, onchainIdentity: {} });
    await expect(app.inject({ method: "POST", url: "/blockchain/issue-kyc-claim", payload: { investorProfileId: "profile-1" } })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("reports wallet verification and token-funding guidance", async () => {
    mocks.isVerified.mockResolvedValueOnce(true);
    const verified = await app.inject({ method: "GET", url: `/blockchain/wallet-verified/${wallet}` });
    expect(verified.json()).toEqual({ address: wallet, verified: true });
    const guidance = await app.inject({ method: "POST", url: "/blockchain/fund-distributor" });
    expect(guidance.json()).toMatchObject({ chainId: 8453, message: expect.stringContaining("token contract") });
  });
});
