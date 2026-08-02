import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.hoisted(() => vi.fn());
const updateOne = vi.hoisted(() => vi.fn());

vi.mock("../../db/models.js", () => ({ IssuerWebhookModel: { find, updateOne } }));

import { dispatchIssuerWebhook } from "../issuer-webhooks.js";

const event = { type: "offering.published", businessId: "business-1", data: { offeringId: "offering-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  updateOne.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issuer webhooks", () => {
  it("does nothing when the issuer has no active webhooks", async () => {
    find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    await expect(dispatchIssuerWebhook(event)).resolves.toBeUndefined();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("delivers only subscribed events and records a successful delivery", async () => {
    find.mockReturnValue({ lean: vi.fn().mockResolvedValue([
      { _id: "hook-1", url: "https://issuer.test/webhook", secret: "test-secret", events: ["offering.published"] },
      { _id: "hook-2", url: "https://issuer.test/other", secret: "test-secret", events: ["subscription.paid"] },
    ]) });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await dispatchIssuerWebhook(event);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://issuer.test/webhook", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Fractal-Event": "offering.published", "X-Fractal-Signature": expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(updateOne).toHaveBeenCalledWith({ _id: "hook-1" }, expect.objectContaining({ $set: expect.objectContaining({ lastDeliveryStatus: "204", failureCount: 0 }) }));
  });

  it("supports wildcard events and records non-success responses", async () => {
    find.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: "hook-1", url: "https://issuer.test/webhook", secret: "test-secret", events: ["*"] }]) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await dispatchIssuerWebhook(event);

    expect(updateOne).toHaveBeenCalledWith({ _id: "hook-1" }, expect.objectContaining({
      $set: expect.objectContaining({ lastDeliveryStatus: "503" }),
      $inc: { failureCount: 1 },
    }));
  });

  it("records request errors and contains outer lookup failures", async () => {
    find.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue([{ _id: "hook-1", url: "https://issuer.test/webhook", secret: "test-secret", events: ["*"] }]) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unavailable")));
    await dispatchIssuerWebhook(event);
    expect(updateOne).toHaveBeenCalledWith({ _id: "hook-1" }, expect.objectContaining({
      $set: expect.objectContaining({ lastDeliveryStatus: "error" }),
      $inc: { failureCount: 1 },
    }));

    find.mockReturnValueOnce({ lean: vi.fn().mockRejectedValue(new Error("Database unavailable")) });
    await expect(dispatchIssuerWebhook(event)).resolves.toBeUndefined();
  });
});
