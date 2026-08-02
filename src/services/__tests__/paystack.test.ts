import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBreaker = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  PAYSTACK_SECRET_KEY: "sk_test_secret",
  PAYSTACK_WEBHOOK_SECRET: "whsec_test_secret",
  PAYSTACK_REQUEST_TIMEOUT_MS: 500,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../circuit-breaker.js", () => ({ createBreaker }));

async function loadPaystack(options: { circuitOpen?: boolean } = {}) {
  vi.resetModules();
  createBreaker.mockImplementation((_name: string, fn: (...args: unknown[]) => unknown) =>
    options.circuitOpen
      ? { fire: vi.fn().mockRejectedValue(new Error("Circuit open")) }
      : { fire: vi.fn((...args: unknown[]) => fn(...args)) },
  );
  return import("../paystack.js");
}

function providerResponse(data: unknown, status = 200, message = "OK") {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue({ status: status < 300, message, data }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.PAYSTACK_SECRET_KEY = "sk_test_secret";
  env.PAYSTACK_WEBHOOK_SECRET = "whsec_test_secret";
  env.PAYSTACK_REQUEST_TIMEOUT_MS = 500;
});

afterEach(() => vi.unstubAllGlobals());

describe("Paystack write operations", () => {
  it("sends checkout, recipient, transfer, customer, DVA, and refund payloads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse({ authorization_url: "https://pay.test", access_code: "code", reference: "ref-1" }))
      .mockResolvedValueOnce(providerResponse({ recipient_code: "recipient-1" }))
      .mockResolvedValueOnce(providerResponse({ transfer_code: "transfer-1", status: "pending" }))
      .mockResolvedValueOnce(providerResponse({ customer_code: "customer-1", id: 1, email: "investor@fractal.test" }))
      .mockResolvedValueOnce(providerResponse({ bank: {}, account_name: "Investor", account_number: "0123456789", assigned: true, currency: "NGN", customer: {} }))
      .mockResolvedValueOnce(providerResponse({ transaction: 1, amount: 5000, currency: "NGN", status: "pending", id: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const paystack = await loadPaystack();

    await expect(paystack.initializePaystackTransaction({ email: "investor@fractal.test", amountKobo: 5000, reference: "ref-1", callbackUrl: "https://fractal.test/callback", metadata: { offering: "one" } })).resolves.toMatchObject({ reference: "ref-1" });
    await expect(paystack.createPaystackTransferRecipient({ name: "Fractal Ltd", accountNumber: "0123456789", bankCode: "058" })).resolves.toEqual({ recipient_code: "recipient-1" });
    await expect(paystack.initiatePaystackTransfer({ recipientCode: "recipient-1", amountKobo: 5000, reference: "transfer-ref", reason: "Distribution" })).resolves.toMatchObject({ transfer_code: "transfer-1" });
    await expect(paystack.createPaystackCustomer({ email: "investor@fractal.test", firstName: "Ada", lastName: "Owner", phone: "+2348000000000" })).resolves.toMatchObject({ customer_code: "customer-1" });
    await expect(paystack.createPaystackDedicatedVirtualAccount({ customerCode: "customer-1", preferredBank: "wema-bank" })).resolves.toMatchObject({ assigned: true });
    await expect(paystack.initiatePaystackRefund({ transactionReference: "ref-1", amountKobo: 5000, merchantNote: "Approved refund" })).resolves.toMatchObject({ id: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect(init).toMatchObject({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer sk_test_secret" }) });
    expect(JSON.parse(String(init.body))).toMatchObject({ amount: 5000, currency: "NGN", metadata: { offering: "one" } });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ customer: "customer-1", preferred_bank: "wema-bank" });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toMatchObject({ transaction: "ref-1", amount: 5000 });
  });

  it("omits optional DVA bank and refund amount fields", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse({ bank: {}, account_name: "Investor", account_number: "0123456789", assigned: true, currency: "NGN", customer: {} }))
      .mockResolvedValueOnce(providerResponse({ transaction: 1, amount: 0, currency: "NGN", status: "pending", id: 2 })));
    const paystack = await loadPaystack();
    await paystack.createPaystackDedicatedVirtualAccount({ customerCode: "customer-1" });
    await paystack.initiatePaystackRefund({ transactionReference: "ref-1", merchantNote: "Full refund" });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ customer: "customer-1" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ transaction: "ref-1", merchant_note: "Full refund" });
  });
});

describe("Paystack read operations and security", () => {
  it("resolves accounts, reads transactions, caches banks, reads balance, and reads transfers", async () => {
    const banks = [{ name: "GTBank", code: "058", longcode: "058", active: true, country: "Nigeria", currency: "NGN", type: "nuban" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse({ account_number: "0123456789", account_name: "Fractal Issuer" }))
      .mockResolvedValueOnce(providerResponse({ reference: "ref/a", status: "success", amount: 5000, currency: "NGN", channel: "bank", paid_at: "2026-01-01", metadata: {} }))
      .mockResolvedValueOnce(providerResponse(banks))
      .mockResolvedValueOnce(providerResponse([{ currency: "USD", balance: 1 }, { currency: "NGN", balance: 7000 }]))
      .mockResolvedValueOnce(providerResponse({ transfer_code: "transfer-1", reference: "ref/a", status: "success", amount: 5000, currency: "NGN", reason: "test", recipient: {}, failures: null, updatedAt: "2026-01-01" }))
      .mockResolvedValueOnce(providerResponse({ transfer_code: "transfer-2", reference: "ref/a", status: "success", amount: 5000, currency: "NGN", reason: "test", recipient: {}, failures: null, updatedAt: "2026-01-01" }));
    vi.stubGlobal("fetch", fetchMock);
    const paystack = await loadPaystack();

    await expect(paystack.resolvePaystackAccount({ accountNumber: "0123456789", bankCode: "058" })).resolves.toMatchObject({ account_name: "Fractal Issuer" });
    await expect(paystack.verifyPaystackTransaction("ref/a")).resolves.toMatchObject({ status: "success" });
    await expect(paystack.listPaystackBanks()).resolves.toEqual(banks);
    await expect(paystack.listPaystackBanks()).resolves.toEqual(banks);
    await expect(paystack.getAvailableBalanceKobo()).resolves.toBe(7000);
    await expect(paystack.fetchPaystackTransfer("transfer/one")).resolves.toMatchObject({ transfer_code: "transfer-1" });
    await expect(paystack.verifyPaystackTransfer("ref/a")).resolves.toMatchObject({ transfer_code: "transfer-2" });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/bank/resolve?account_number=0123456789&bank_code=058");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/transaction/verify/ref%2Fa");
    expect(fetchMock.mock.calls[4]?.[0]).toContain("/transfer/transfer%2Fone");
    expect(fetchMock.mock.calls[5]?.[0]).toContain("/transfer/verify/ref%2Fa");
  });

  it("verifies webhook signatures without accepting a missing or mismatched secret", async () => {
    const paystack = await loadPaystack();
    const body = '{"event":"charge.success"}';
    const signature = crypto.createHmac("sha512", "whsec_test_secret").update(body).digest("hex");
    expect(paystack.verifyPaystackWebhookSignature(body, signature)).toBe(true);
    expect(paystack.verifyPaystackWebhookSignature(body, "bad")).toBe(false);
    env.PAYSTACK_WEBHOOK_SECRET = undefined as any;
    env.PAYSTACK_SECRET_KEY = undefined as any;
    expect(paystack.verifyPaystackWebhookSignature(body, signature)).toBe(false);
    expect(paystack.nairaToKobo(12.345)).toBe(1235);
  });
});

describe("Paystack provider failures", () => {
  it("returns typed provider errors for provider responses, timeouts, and missing secrets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(undefined, 503, "Service unavailable")));
    let paystack = await loadPaystack();
    await expect(paystack.checkPaystackBalance()).rejects.toMatchObject({ name: "PaystackRequestError", retryable: true, status: 503 });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    paystack = await loadPaystack();
    await expect(paystack.checkPaystackBalance()).rejects.toMatchObject({ message: "Paystack request timed out", retryable: true });

    env.PAYSTACK_SECRET_KEY = undefined as any;
    paystack = await loadPaystack();
    await expect(paystack.checkPaystackBalance()).rejects.toMatchObject({ message: "Paystack request failed", retryable: true });
  });

  it("preserves a non-retryable POST rejection and normalizes an open circuit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse(undefined, 400, "Invalid transaction request")));
    let paystack = await loadPaystack();
    await expect(paystack.initializePaystackTransaction({ email: "investor@fractal.test", amountKobo: 5_000, reference: "bad-reference" })).rejects.toMatchObject({
      message: "Paystack error: Invalid transaction request", retryable: false, status: 400,
    });

    paystack = await loadPaystack({ circuitOpen: true });
    await expect(paystack.initializePaystackTransaction({ email: "investor@fractal.test", amountKobo: 5_000, reference: "circuit-open" })).rejects.toMatchObject({
      message: "Paystack request is temporarily unavailable", retryable: true,
    });
  });

});
