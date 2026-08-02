import { describe, expect, it, vi } from "vitest";
import {
  collectResendPrivacyRecords,
  ResendPrivacyAdapterError,
} from "../privacy-external-resend-adapter.js";

function resendResponse(input: {
  id: string;
  to?: string[];
  extra?: Record<string, unknown>;
}): Response {
  return new Response(JSON.stringify({
    id: input.id,
    to: input.to ?? ["subject@example.test"],
    created_at: "2026-07-26T08:00:00.000Z",
    last_event: "delivered",
    from: "Fractal <secure@example.test>",
    subject: "Secret subject",
    html: "<p>Secret body</p>",
    text: "Secret body",
    ...input.extra,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Resend external privacy adapter", () => {
  it("retrieves exact records and returns only the safe projection", async () => {
    const fetchImplementation = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const id = decodeURIComponent(String(request).split("/").at(-1)!);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: "Bearer re_test_key",
        },
      });
      return resendResponse({ id });
    });
    const records = await collectResendPrivacyRecords({
      apiKey: "re_test_key",
      references: [
        { providerMessageId: "message-b", recipientEmail: "subject@example.test" },
        { providerMessageId: "message-a", recipientEmail: "SUBJECT@example.test" },
      ],
      timeoutMs: 1_000,
      maximumRecords: 2,
      maximumBytes: 4_096,
      fetchImplementation,
    });
    expect(records).toEqual([
      {
        createdAt: "2026-07-26T08:00:00.000Z",
        lastEvent: "delivered",
      },
      {
        createdAt: "2026-07-26T08:00:00.000Z",
        lastEvent: "delivered",
      },
    ]);
    expect(JSON.stringify(records)).not.toMatch(
      /message-a|message-b|subject@example|Secret|secure@example|html|text/,
    );
  });

  it("fails closed when the provider recipient does not match", async () => {
    await expect(collectResendPrivacyRecords({
      apiKey: "re_test_key",
      references: [{ providerMessageId: "message-private", recipientEmail: "subject@example.test" }],
      timeoutMs: 1_000,
      maximumRecords: 1,
      maximumBytes: 4_096,
      fetchImplementation: async () => resendResponse({
        id: "message-private",
        to: ["other@example.test"],
      }),
    })).rejects.toThrow("exact delivery reference");
  });

  it("rejects duplicate references and an excessive record count before network access", async () => {
    const fetchImplementation = vi.fn();
    const duplicate = [
      { providerMessageId: "message-a", recipientEmail: "subject@example.test" },
      { providerMessageId: "message-a", recipientEmail: "subject@example.test" },
    ];
    await expect(collectResendPrivacyRecords({
      apiKey: "re_test_key",
      references: duplicate,
      timeoutMs: 1_000,
      maximumRecords: 2,
      maximumBytes: 4_096,
      fetchImplementation,
    })).rejects.toThrow("must be unique");
    await expect(collectResendPrivacyRecords({
      apiKey: "re_test_key",
      references: duplicate,
      timeoutMs: 1_000,
      maximumRecords: 1,
      maximumBytes: 4_096,
      fetchImplementation,
    })).rejects.toThrow("record count");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects non-JSON, invalid JSON, provider errors, and oversized bodies", async () => {
    const common = {
      apiKey: "re_test_key",
      references: [{ providerMessageId: "message-a", recipientEmail: "subject@example.test" }],
      timeoutMs: 1_000,
      maximumRecords: 1,
      maximumBytes: 1_024,
    } as const;
    await expect(collectResendPrivacyRecords({
      ...common,
      fetchImplementation: async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    })).rejects.toThrow("non-JSON");
    await expect(collectResendPrivacyRecords({
      ...common,
      fetchImplementation: async () => new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })).rejects.toThrow("invalid JSON");
    await expect(collectResendPrivacyRecords({
      ...common,
      fetchImplementation: async () => new Response(
        JSON.stringify({ error: "provider secret diagnostic" }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    })).rejects.toThrow("did not return");
    const oversized = resendResponse({
      id: "message-a",
      extra: { html: "x".repeat(2_000) },
    });
    await expect(collectResendPrivacyRecords({
      ...common,
      fetchImplementation: async () => oversized,
    })).rejects.toThrow("byte limit");
    await expect(collectResendPrivacyRecords({
      ...common,
      references: [
        { providerMessageId: "message-a", recipientEmail: "subject@example.test" },
        { providerMessageId: "message-b", recipientEmail: "subject@example.test" },
      ],
      maximumRecords: 2,
      fetchImplementation: async (request) => resendResponse({
        id: decodeURIComponent(String(request).split("/").at(-1)!),
        extra: { html: "x".repeat(450) },
      }),
    })).rejects.toThrow("byte limit");
  });

  it("uses one time limit and does not expose provider diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const fetchImplementation = (
        request: string | URL | Request,
        init?: RequestInit,
      ) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(resendResponse({
            id: decodeURIComponent(String(request).split("/").at(-1)!),
          }));
        }, 300);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("provider diagnostic must remain private"));
        });
      });
      const collection = collectResendPrivacyRecords({
        apiKey: "re_test_key",
        references: [
          { providerMessageId: "message-a", recipientEmail: "subject@example.test" },
          { providerMessageId: "message-b", recipientEmail: "subject@example.test" },
        ],
        timeoutMs: 500,
        maximumRecords: 2,
        maximumBytes: 4_096,
        fetchImplementation,
      });
      const assertion = expect(collection).rejects.toEqual(
        new ResendPrivacyAdapterError("Resend request exceeded the time limit"),
      );
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
