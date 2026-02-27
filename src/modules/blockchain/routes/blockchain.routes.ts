/**
 * blockchain.routes.ts
 * Admin-only API endpoints for blockchain operations.
 * All routes require admin role.
 *
 * ERC-7518 migration: Updated for ERC-1155 token with built-in compliance.
 * New routes: batch-payout, whitelist-investor, transferable-balance.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorize } from "../../../utils/rbac.js";
import { HttpError } from "../../../utils/errors.js";
import {
  BlockchainOpModel,
  OfferingModel,
  SubscriptionModel,
  InvestorProfileModel,
} from "../../../db/models/index.js";
import { enqueueBlockchainOp } from "../../../workers/blockchain.worker.js";
import {
  isWalletVerified,
  getTokenBalance,
  getTransferableBalance,
} from "../../../services/blockchain.service.js";
import { createEmbeddedWallet } from "../../../services/privy.service.js";
import { env } from "../../../config/env.js";
import type { AuthUser } from "../../../types.js";

export async function blockchainRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ── GET /blockchain/ops — list all blockchain operations ────────────────────
  fastify.get("/blockchain/ops", async (request, reply) => {
    authorize(request.user as AuthUser, "read", "platform");

    const ops = await BlockchainOpModel.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return reply.send({ ops });
  });

  // ── GET /blockchain/ops/:id — get a specific op ─────────────────────────────
  fastify.get("/blockchain/ops/:id", async (request, reply) => {
    authorize(request.user as AuthUser, "read", "platform");
    const { id } = request.params as { id: string };
    const op = await BlockchainOpModel.findById(id).lean();
    if (!op) throw new HttpError(404, "Blockchain op not found");
    return reply.send({ op });
  });

  // ── POST /blockchain/deploy-token — manually trigger token deployment ───────
  fastify.post("/blockchain/deploy-token", async (request, reply) => {
    authorize(request.user as AuthUser, "execute", "offering");

    const schema = z.object({
      offeringId: z.string().min(1),
      tokenName: z.string().min(2).optional(),
      tokenSymbol: z.string().min(2).max(12).optional(),
      maxBalancePerHolder: z.number().int().nonnegative().optional(),
      retailCap: z.number().int().nonnegative().optional(),
    });

    const body = schema.parse(request.body);
    const offering = await OfferingModel.findById(body.offeringId);
    if (!offering) throw new HttpError(404, "Offering not found");

    if (
      (offering as { tokenDeployment?: { status?: string } }).tokenDeployment
        ?.status === "deployed"
    ) {
      throw new HttpError(409, "Token already deployed for this offering");
    }

    await enqueueBlockchainOp({
      opType: "deploy_token",
      entityType: "offering",
      entityId: body.offeringId,
      payload: {
        tokenName: body.tokenName ?? `Fractal ${offering.name}`,
        tokenSymbol:
          body.tokenSymbol ??
          `FRAC-${offering._id.toString().slice(-4).toUpperCase()}`,
        maxBalancePerHolder: body.maxBalancePerHolder,
        retailCap: body.retailCap,
      },
    });

    // Update offering to show pending status
    await OfferingModel.findByIdAndUpdate(body.offeringId, {
      tokenDeployment: {
        status: "pending_deploy",
        contractAddress: "",
        chainId: env.CHAIN_ID,
        deployTxHash: "",
        deployedAt: "",
        tokenSymbol:
          body.tokenSymbol ??
          `FRAC-${offering._id.toString().slice(-4).toUpperCase()}`,
        defaultPartitionId: 1,
        totalSupplyIssued: 0,
      },
    });

    return reply.send({
      message: "Token deployment queued",
      offeringId: body.offeringId,
    });
  });

  // ── POST /blockchain/trigger-mint — batch mint for an offering ──────────────
  fastify.post("/blockchain/trigger-mint", async (request, reply) => {
    authorize(request.user as AuthUser, "execute", "subscription");

    const schema = z.object({
      offeringId: z.string().min(1),
      tokenId: z.number().int().positive().default(1),
      lockupDays: z.number().int().nonnegative().optional(),
    });
    const body = schema.parse(request.body);

    const offering = await OfferingModel.findById(body.offeringId);
    if (!offering) throw new HttpError(404, "Offering not found");

    const td = (
      offering as {
        tokenDeployment?: {
          contractAddress?: string;
          status?: string;
          lockupDays?: number;
        };
      }
    ).tokenDeployment;
    if (!td?.contractAddress || td.status !== "deployed") {
      throw new HttpError(400, "Token contract not deployed for this offering");
    }

    const subs = await SubscriptionModel.find({
      offeringId: body.offeringId,
      status: "allocation_confirmed",
      walletAddress: { $exists: true, $ne: null },
      "tokenMint.txHash": { $exists: false },
    }).lean();

    if (subs.length === 0) {
      return reply.send({ message: "No subscriptions pending mint", count: 0 });
    }

    const minTicket =
      (offering.terms as { minTicket?: number })?.minTicket ?? 1;
    const entries = subs.map(
      (sub: { _id: unknown; walletAddress?: string; amount?: unknown }) => ({
        subscriptionId: String(sub._id),
        wallet: (sub.walletAddress ??
          "0x0000000000000000000000000000000000000000") as `0x${string}`,
        tokenAmount: Math.floor(
          parseFloat(String(sub.amount ?? 0)) / minTicket,
        ),
      }),
    );

    const lockupDays = body.lockupDays ?? td.lockupDays ?? 0;

    await enqueueBlockchainOp({
      opType: "mint",
      entityType: "offering",
      entityId: body.offeringId,
      payload: {
        contractAddress: td.contractAddress,
        entries,
        tokenId: body.tokenId,
        lockupDays,
      },
    });

    return reply.send({ message: "Mint queued", count: subs.length });
  });

  // ── GET /blockchain/balance/:contractAddress/:wallet ─────────────────────────
  fastify.get(
    "/blockchain/balance/:contractAddress/:wallet",
    async (request, reply) => {
      authorize(request.user as AuthUser, "read", "subscription");
      const { contractAddress, wallet } = request.params as {
        contractAddress: string;
        wallet: string;
      };
      const tokenId = BigInt(
        (request.query as { tokenId?: string })?.tokenId ?? "1",
      );
      const balance = await getTokenBalance(
        contractAddress as `0x${string}`,
        wallet as `0x${string}`,
        tokenId,
      );
      return reply.send({
        contractAddress,
        wallet,
        tokenId: tokenId.toString(),
        balance: balance.toString(),
      });
    },
  );

  // ── GET /blockchain/transferable-balance/:contractAddress/:wallet/:tokenId ──
  fastify.get(
    "/blockchain/transferable-balance/:contractAddress/:wallet/:tokenId",
    async (request, reply) => {
      authorize(request.user as AuthUser, "read", "subscription");
      const { contractAddress, wallet, tokenId } = request.params as {
        contractAddress: string;
        wallet: string;
        tokenId: string;
      };
      const balance = await getTransferableBalance(
        contractAddress as `0x${string}`,
        wallet as `0x${string}`,
        BigInt(tokenId),
      );
      return reply.send({
        contractAddress,
        wallet,
        tokenId,
        transferableBalance: balance.toString(),
      });
    },
  );

  // ── POST /blockchain/batch-payout — trigger USDT payout from token contract ─
  fastify.post("/blockchain/batch-payout", async (request, reply) => {
    authorize(request.user as AuthUser, "execute", "distribution");

    const schema = z.object({
      offeringId: z.string().min(1),
      distributionId: z.string().min(1).optional(),
      recipients: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).min(1),
      netAmountsUsdt: z.array(z.string()).min(1), // string bigints in USDT base units
    });

    const body = schema.parse(request.body);
    if (body.recipients.length !== body.netAmountsUsdt.length) {
      throw new HttpError(
        400,
        "recipients and netAmountsUsdt must have same length",
      );
    }

    const offering = await OfferingModel.findById(body.offeringId);
    if (!offering) throw new HttpError(404, "Offering not found");

    const td = (
      offering as {
        tokenDeployment?: { contractAddress?: string; status?: string };
      }
    ).tokenDeployment;
    if (!td?.contractAddress || td.status !== "deployed") {
      throw new HttpError(400, "Token contract not deployed for this offering");
    }

    await enqueueBlockchainOp({
      opType: "batch_payout",
      entityType: "distribution",
      entityId: body.distributionId ?? body.offeringId,
      payload: {
        contractAddress: td.contractAddress,
        recipients: body.recipients,
        netAmounts: body.netAmountsUsdt,
        distributionEntityId: body.distributionId,
      },
    });

    return reply.send({
      message: "Batch payout queued",
      recipientCount: body.recipients.length,
    });
  });

  // ── POST /blockchain/whitelist-investor — whitelist on token contract ────────
  fastify.post("/blockchain/whitelist-investor", async (request, reply) => {
    authorize(request.user as AuthUser, "execute", "investor_profile");

    const schema = z.object({
      contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    });

    const body = schema.parse(request.body);

    await enqueueBlockchainOp({
      opType: "whitelist_investor",
      entityType: "investor_profile",
      entityId: body.walletAddress,
      payload: {
        contractAddress: body.contractAddress,
        walletAddress: body.walletAddress,
      },
    });

    return reply.send({ message: "Whitelist operation queued" });
  });

  // ── POST /blockchain/provision-wallet — provision embedded wallet for investor
  fastify.post("/blockchain/provision-wallet", async (request, reply) => {
    authorize(request.user as AuthUser, "update", "investor_profile");

    const schema = z.object({
      investorProfileId: z.string().min(1),
      privyUserId: z.string().min(1).optional(),
    });

    const body = schema.parse(request.body);
    const profile = await InvestorProfileModel.findById(body.investorProfileId);
    if (!profile) throw new HttpError(404, "Investor profile not found");
    if ((profile as { primaryWalletAddress?: string }).primaryWalletAddress) {
      throw new HttpError(409, "Wallet already provisioned for this investor");
    }

    const privyUserId = body.privyUserId ?? profile._id.toString();
    const { walletId, address } = await createEmbeddedWallet(privyUserId);

    await InvestorProfileModel.findByIdAndUpdate(body.investorProfileId, {
      primaryWalletAddress: address,
      $push: {
        wallets: {
          address,
          type: "embedded",
          provider: "privy",
          privyWalletId: walletId,
          isPrimary: true,
        },
      },
    });

    return reply.send({ walletId, address });
  });

  // ── POST /blockchain/issue-kyc-claim — issue KYC claim for investor ─────────
  fastify.post("/blockchain/issue-kyc-claim", async (request, reply) => {
    authorize(request.user as AuthUser, "approve", "investor_profile");

    const schema = z.object({
      investorProfileId: z.string().min(1),
      countryCode: z.number().int().nonnegative().default(566),
    });

    const body = schema.parse(request.body);
    const profile = await InvestorProfileModel.findById(body.investorProfileId);
    if (!profile) throw new HttpError(404, "Investor profile not found");

    const p = profile as {
      primaryWalletAddress?: string;
      onchainIdentity?: { identityContractAddress?: string };
    };
    if (!p.primaryWalletAddress) {
      throw new HttpError(400, "Investor does not have a provisioned wallet");
    }
    if (!p.onchainIdentity?.identityContractAddress) {
      throw new HttpError(
        400,
        "Investor does not have an on-chain identity contract",
      );
    }

    await enqueueBlockchainOp({
      opType: "issue_kyc_claim",
      entityType: "investor_profile",
      entityId: body.investorProfileId,
      payload: {
        walletAddress: p.primaryWalletAddress,
        identityContractAddress: p.onchainIdentity.identityContractAddress,
        countryCode: body.countryCode,
      },
    });

    return reply.send({ message: "KYC claim issuance queued" });
  });

  // ── GET /blockchain/wallet-verified/:address ────────────────────────────────
  fastify.get(
    "/blockchain/wallet-verified/:address",
    async (request, reply) => {
      authorize(request.user as AuthUser, "read", "investor_profile");
      const { address } = request.params as { address: string };
      const verified = await isWalletVerified(address as `0x${string}`);
      return reply.send({ address, verified });
    },
  );

  // ── POST /blockchain/fund-distributor — info endpoint ───────────────────────
  fastify.post("/blockchain/fund-distributor", async (request, reply) => {
    authorize(request.user as AuthUser, "read", "platform");
    return reply.send({
      message:
        "USDT payouts are now handled by each token contract. Fund the token contract directly with USDT before triggering batch payouts.",
      chainId: env.CHAIN_ID,
    });
  });
}
