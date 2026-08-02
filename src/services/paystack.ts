import crypto from "crypto";
import { env } from "../config/env.js";
import { createBreaker } from "./circuit-breaker.js";

const PAYSTACK_BASE = "https://api.paystack.co";

export class PaystackRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "PaystackRequestError";
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function paystackHeaders(): Record<string, string> {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not configured");
  return {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function _paystackPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PAYSTACK_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      method: "POST",
      headers: paystackHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
    if (!res.ok || !json?.status || json.data === undefined) {
      throw new PaystackRequestError(
        `Paystack error: ${json?.message ?? `HTTP ${res.status}`}`,
        retryableStatus(res.status),
        res.status,
      );
    }
    return json.data;
  } catch (error) {
    if (error instanceof PaystackRequestError) throw error;
    const message = error instanceof Error && error.name === "AbortError" ? "Paystack request timed out" : "Paystack request failed";
    throw new PaystackRequestError(message, true);
  } finally {
    clearTimeout(timeout);
  }
}

const paystackBreaker = createBreaker("paystack", _paystackPost, { timeout: env.PAYSTACK_REQUEST_TIMEOUT_MS + 1_000 });

async function paystackPost<T>(path: string, body: unknown): Promise<T> {
  try {
    return (await paystackBreaker.fire(path, body)) as T;
  } catch (error) {
    // Circuit-breaker open/timeout errors do not originate in the adapter, but
    // callers must still receive the same typed provider-unavailable outcome.
    if (error instanceof PaystackRequestError) throw error;
    throw new PaystackRequestError("Paystack request is temporarily unavailable", true);
  }
}

export interface PaystackCheckout {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export async function initializePaystackTransaction(opts: {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackCheckout> {
  return paystackPost<PaystackCheckout>("/transaction/initialize", {
    email: opts.email,
    amount: opts.amountKobo,
    reference: opts.reference,
    callback_url: opts.callbackUrl,
    metadata: opts.metadata ?? {},
    currency: "NGN",
  });
}

export interface PaystackTransferRecipient {
  recipient_code: string;
}

export async function createPaystackTransferRecipient(opts: {
  name: string;
  accountNumber: string;
  bankCode: string;
}): Promise<PaystackTransferRecipient> {
  return paystackPost<PaystackTransferRecipient>("/transferrecipient", {
    type: "nuban",
    name: opts.name,
    account_number: opts.accountNumber,
    bank_code: opts.bankCode,
    currency: "NGN",
  });
}

export interface PaystackTransfer {
  transfer_code: string;
  status: string;
}

export async function initiatePaystackTransfer(opts: {
  recipientCode: string;
  amountKobo: number;
  reference: string;
  reason: string;
}): Promise<PaystackTransfer> {
  return paystackPost<PaystackTransfer>("/transfer", {
    source: "balance",
    recipient: opts.recipientCode,
    amount: opts.amountKobo,
    reference: opts.reference,
    reason: opts.reason,
  });
}

// I-07: Resolve bank account via Paystack — validate account number and return real account name
export interface PaystackAccountResolution {
  account_number: string;
  account_name: string;
  bank_id?: number;
}

async function paystackGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PAYSTACK_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      method: "GET",
      headers: paystackHeaders(),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
    if (!res.ok || !json?.status || json.data === undefined) {
      throw new PaystackRequestError(
        `Paystack error: ${json?.message ?? `HTTP ${res.status}`}`,
        retryableStatus(res.status),
        res.status,
      );
    }
    return json.data;
  } catch (error) {
    if (error instanceof PaystackRequestError) throw error;
    const message = error instanceof Error && error.name === "AbortError" ? "Paystack request timed out" : "Paystack request failed";
    throw new PaystackRequestError(message, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolvePaystackAccount(opts: {
  accountNumber: string;
  bankCode: string;
}): Promise<PaystackAccountResolution> {
  const params = new URLSearchParams({
    account_number: opts.accountNumber,
    bank_code: opts.bankCode,
  });
  return paystackGet<PaystackAccountResolution>(`/bank/resolve?${params.toString()}`);
}

export function verifyPaystackWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = env.PAYSTACK_WEBHOOK_SECRET ?? env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;
  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const hashBuf = Buffer.from(hash, "utf8");
  const sigBuf = Buffer.from(signature, "utf8");
  if (hashBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, sigBuf);
}

export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

// --- Phase 2: Money rail additions ---

/** Verify a transaction directly with Paystack (belt-and-suspenders after webhook). */
export interface PaystackTransactionVerification {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  channel: string;
  paid_at: string;
  metadata: Record<string, unknown>;
}

export async function verifyPaystackTransaction(
  reference: string,
): Promise<PaystackTransactionVerification> {
  return paystackGet<PaystackTransactionVerification>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
}

/** Create a Paystack customer (required before DVA creation). */
export interface PaystackCustomer {
  customer_code: string;
  id: number;
  email: string;
}

export async function createPaystackCustomer(opts: {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}): Promise<PaystackCustomer> {
  return paystackPost<PaystackCustomer>("/customer", {
    email: opts.email,
    first_name: opts.firstName,
    last_name: opts.lastName,
    phone: opts.phone,
  });
}

/** Create a Dedicated Virtual Account (NUBAN) for an investor. */
export interface PaystackDVAResult {
  bank: { name: string; id: number; slug: string };
  account_name: string;
  account_number: string;
  assigned: boolean;
  currency: string;
  customer: { customer_code: string };
}

export async function createPaystackDedicatedVirtualAccount(opts: {
  customerCode: string;
  preferredBank?: string;
}): Promise<PaystackDVAResult> {
  return paystackPost<PaystackDVAResult>("/dedicated_account", {
    customer: opts.customerCode,
    ...(opts.preferredBank ? { preferred_bank: opts.preferredBank } : {}),
  });
}

/** List Nigerian banks — cached in-memory for 24 hours. */
export interface PaystackBank {
  name: string;
  code: string;
  longcode: string;
  active: boolean;
  country: string;
  currency: string;
  type: string;
}

let bankCache: { data: PaystackBank[]; expiresAt: number } | null = null;
const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function listPaystackBanks(): Promise<PaystackBank[]> {
  if (bankCache && Date.now() < bankCache.expiresAt) {
    return bankCache.data;
  }
  const banks = await paystackGet<PaystackBank[]>("/bank?country=nigeria&currency=NGN&perPage=200");
  bankCache = { data: banks, expiresAt: Date.now() + BANK_CACHE_TTL_MS };
  return banks;
}

/** Check Paystack balance (pre-flight before bulk payouts). */
export interface PaystackBalance {
  currency: string;
  balance: number;
}

export async function checkPaystackBalance(): Promise<PaystackBalance[]> {
  return paystackGet<PaystackBalance[]>("/balance");
}

/**
 * Get the available NGN balance in kobo.
 *
 * Provider unavailability is intentionally propagated. Treating it as a zero
 * balance would invent financial data and could cause an unsafe payout or
 * reconciliation decision.
 */
export async function getAvailableBalanceKobo(): Promise<number> {
  const balances = await checkPaystackBalance();
  const ngn = balances.find((b) => b.currency === "NGN");
  return ngn?.balance ?? 0;
}

/** Initiate a refund via Paystack. */
export interface PaystackRefundResult {
  transaction: number;
  amount: number;
  currency: string;
  status: string;
  id: number;
}

export async function initiatePaystackRefund(opts: {
  transactionReference: string;
  amountKobo?: number;
  merchantNote: string;
}): Promise<PaystackRefundResult> {
  return paystackPost<PaystackRefundResult>("/refund", {
    transaction: opts.transactionReference,
    ...(opts.amountKobo ? { amount: opts.amountKobo } : {}),
    merchant_note: opts.merchantNote,
  });
}

/** Fetch a single transfer by its transfer_code (for sweep worker). */
export interface PaystackTransferDetails {
  transfer_code: string;
  reference: string;
  status: string;
  amount: number;
  currency: string;
  reason: string;
  recipient: { recipient_code: string };
  failures: unknown;
  updatedAt: string;
}

export async function fetchPaystackTransfer(
  transferCode: string,
): Promise<PaystackTransferDetails> {
  return paystackGet<PaystackTransferDetails>(
    `/transfer/${encodeURIComponent(transferCode)}`,
  );
}

/** Verify a transfer by its merchant reference when initiation or a webhook outcome was ambiguous. */
export async function verifyPaystackTransfer(reference: string): Promise<PaystackTransferDetails> {
  return paystackGet<PaystackTransferDetails>(
    `/transfer/verify/${encodeURIComponent(reference)}`,
  );
}
