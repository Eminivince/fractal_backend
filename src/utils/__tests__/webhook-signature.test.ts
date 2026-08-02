import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { verifyHmacHexSignature } from "../webhook-signature.js";
import { processSumsubInboxEvent, sumsubWebhookRoutes, SumsubInboxPayloadError } from "../../modules/webhooks/routes/sumsub-webhook.routes.js";
import { paystackWebhookRoutes } from "../../modules/webhooks/routes/paystack-webhook.routes.js";
import { SUMSUB_SDK_ACCESS_TOKEN_PATH, sumsubSdkAccessTokenPayload } from "../../services/sumsub.js";
import { env } from "../../config/env.js";

describe("verifyHmacHexSignature", () => {
  const payload = '{"applicantId":"app-1"}';
  const secret = "sumsub-test-secret";

  it("accepts a valid configured HMAC", () => {
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyHmacHexSignature({ payload, signature, secret, algorithms: ["sha256", "sha512"] })).toBe(true);
  });

  it("rejects a wrong, malformed, or differently-sized signature", () => {
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyHmacHexSignature({ payload, signature: "00".repeat(32), secret, algorithms: ["sha256"] })).toBe(false);
    expect(verifyHmacHexSignature({ payload, signature: "not-hex", secret, algorithms: ["sha256"] })).toBe(false);
    expect(verifyHmacHexSignature({ payload, signature: "00", secret, algorithms: ["sha256"] })).toBe(false);
  });

  it("rejects malformed Sumsub inbox evidence before any profile effect", async () => {
    await expect(processSumsubInboxEvent({
      app: {} as any,
      payload: { type: "applicantReviewed" },
      externalEventId: "sumsub:malformed",
      rawBody: "{}",
      signature: "signature",
    })).rejects.toBeInstanceOf(SumsubInboxPayloadError);
  });

  it("uses Sumsub's current WebSDK access-token endpoint and bounded JSON payload", () => {
    expect(SUMSUB_SDK_ACCESS_TOKEN_PATH).toBe("/resources/accessTokens/sdk");
    expect(sumsubSdkAccessTokenPayload({
      externalUserId: "identity-123",
      levelName: "basic-kyc-level",
      ttlInSecs: 600,
    })).toEqual({ userId: "identity-123", levelName: "basic-kyc-level", ttlInSecs: 600 });
    expect(() => sumsubSdkAccessTokenPayload({ externalUserId: " ", levelName: "basic-kyc-level", ttlInSecs: 600 }))
      .toThrow("external user ID");
    expect(() => sumsubSdkAccessTokenPayload({ externalUserId: "identity-123", levelName: "basic-kyc-level", ttlInSecs: 3_601 }))
      .toThrow("TTL");
  });

  it("does not falsely acknowledge disabled provider webhooks in production", async () => {
    const original = {
      nodeEnv: env.NODE_ENV,
      sumsubEnabled: env.SUMSUB_ENABLED,
      paystackEnabled: env.PAYSTACK_ENABLED,
    };
    const sumsub = Fastify();
    const paystack = Fastify();
    try {
      env.NODE_ENV = "production";
      env.SUMSUB_ENABLED = false;
      env.PAYSTACK_ENABLED = false;
      await sumsubWebhookRoutes(sumsub);
      await paystackWebhookRoutes(paystack);
      await Promise.all([sumsub.ready(), paystack.ready()]);

      const [sumsubResponse, paystackResponse] = await Promise.all([
        sumsub.inject({ method: "POST", url: "/v1/webhooks/sumsub", payload: {} }),
        paystack.inject({ method: "POST", url: "/v1/webhooks/paystack", payload: {} }),
      ]);
      expect(sumsubResponse.statusCode).toBe(503);
      expect(sumsubResponse.json()).toEqual({ error: "Identity-verification webhook is not enabled" });
      expect(paystackResponse.statusCode).toBe(503);
      expect(paystackResponse.json()).toEqual({ error: "Payment webhook is not enabled" });
    } finally {
      env.NODE_ENV = original.nodeEnv;
      env.SUMSUB_ENABLED = original.sumsubEnabled;
      env.PAYSTACK_ENABLED = original.paystackEnabled;
      await Promise.all([sumsub.close(), paystack.close()]);
    }
  });
});
