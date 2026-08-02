import { describe, expect, it, vi } from "vitest";
import { lockDataLifecycleAuthority } from "../postgres-data-lifecycle-lock.js";

describe("data lifecycle authority lock", () => {
  it("holds the configured transaction advisory lock before a lifecycle operation", async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined) } as any;
    await lockDataLifecycleAuthority(client);
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock($1)", [4_182_901_519]);
  });
});
