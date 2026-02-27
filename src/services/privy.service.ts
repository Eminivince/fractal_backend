/**
 * privy.service.ts
 * Server-side Privy integration for embedded wallet provisioning.
 * Uses Privy's REST API directly (no separate SDK dependency needed).
 *
 * Called when:
 * 1. Investor's KYC is approved (Sumsub GREEN) → provision-wallet
 * 2. Admin manually triggers wallet provisioning
 */
import { env } from "../config/env.js";

interface PrivyWalletCreateResponse {
  id: string;
  address: string;
  chain_type: string;
  wallet_client_type: string;
  policy_ids?: string[];
  hd_wallet_index?: number;
  created_at: number;
}

interface PrivyUserWalletsResponse {
  wallets: PrivyWalletCreateResponse[];
}

const PRIVY_API_BASE = "https://auth.privy.io/api/v1";

function getPrivyHeaders(): HeadersInit {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET must be configured");
  }
  const credentials = Buffer.from(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`).toString("base64");
  return {
    "Authorization": `Basic ${credentials}`,
    "Content-Type": "application/json",
    "privy-app-id": env.PRIVY_APP_ID,
  };
}

/**
 * Create a server-managed embedded wallet for an investor.
 * Returns the wallet address.
 */
export async function createEmbeddedWallet(privyUserId: string): Promise<{
  walletId: string;
  address: string;
}> {
  if (!env.PRIVY_ENABLED) {
    // Return a mock address for development
    const mockAddress = `0x${"0".repeat(38)}${privyUserId.slice(-2)}` as `0x${string}`;
    return { walletId: `mock-${privyUserId}`, address: mockAddress };
  }

  const response = await fetch(`${PRIVY_API_BASE}/wallets`, {
    method: "POST",
    headers: getPrivyHeaders(),
    body: JSON.stringify({
      chain_type: "ethereum",
      owner: {
        type: "user",
        user_id: privyUserId,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Privy wallet creation failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as PrivyWalletCreateResponse;
  return { walletId: data.id, address: data.address };
}

/**
 * Get all wallets for a Privy user.
 */
export async function getUserWallets(privyUserId: string): Promise<PrivyWalletCreateResponse[]> {
  if (!env.PRIVY_ENABLED) return [];

  const response = await fetch(`${PRIVY_API_BASE}/users/${privyUserId}/wallets`, {
    headers: getPrivyHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to get Privy wallets: ${response.status}`);
  }

  const data = (await response.json()) as PrivyUserWalletsResponse;
  return data.wallets;
}

/**
 * Verify a Privy JWT token (server-side auth verification).
 */
export async function verifyPrivyToken(authToken: string): Promise<{
  userId: string;
  walletAddress?: string;
}> {
  if (!env.PRIVY_ENABLED) {
    throw new Error("Privy not enabled");
  }

  const response = await fetch(`${PRIVY_API_BASE}/sessions/verify`, {
    method: "POST",
    headers: getPrivyHeaders(),
    body: JSON.stringify({ token: authToken }),
  });

  if (!response.ok) {
    throw new Error(`Privy token verification failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    user_id: string;
    wallet?: { address: string };
  };

  return {
    userId: data.user_id,
    walletAddress: data.wallet?.address,
  };
}
