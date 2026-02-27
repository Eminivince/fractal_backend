import crypto from "crypto";
import { env } from "../config/env.js";

const PAYSTACK_BASE = "https://api.paystack.co";

function paystackHeaders(): Record<string, string> {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not configured");
  return {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function paystackPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: paystackHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { status: boolean; message: string; data: T };
  if (!json.status) throw new Error(`Paystack error: ${json.message}`);
  return json.data;
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
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "GET",
    headers: paystackHeaders(),
  });
  const json = (await res.json()) as { status: boolean; message: string; data: T };
  if (!json.status) throw new Error(`Paystack error: ${json.message}`);
  return json.data;
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
  return hash === signature;
}

export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}
