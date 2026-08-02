import { beforeEach, describe, expect, it, vi } from "vitest";

const { findOne, create } = vi.hoisted(() => ({ findOne: vi.fn(), create: vi.fn() }));

vi.mock("../../db/models.js", () => ({
  IdempotencyKeyModel: { findOne, create },
}));

import { hashPayload, readCommandId, runIdempotentCommand, stableJsonStringify } from "../idempotency.js";

function query(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) };
}

beforeEach(() => {
  findOne.mockReset();
  create.mockReset();
});

describe("idempotency payload identity", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(stableJsonStringify({ z: 1, a: { y: 2, b: 3 }, list: [{ b: 2, a: 1 }, 9] }))
      .toBe('{"a":{"b":3,"y":2},"list":[{"a":1,"b":2},9],"z":1}');
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload([1, 2])).not.toBe(hashPayload([2, 1]));
  });

  it("reads only nonblank command IDs", () => {
    expect(readCommandId({})).toBeUndefined();
    expect(readCommandId({ "x-command-id": "  command-1  " })).toBe("command-1");
    expect(readCommandId({ "x-command-id": ["first", "second"] })).toBe("first");
    expect(readCommandId({ "x-command-id": "   " })).toBeUndefined();
  });
});

describe("runIdempotentCommand", () => {
  const base = { userId: "user-1", route: "/v1/test", payload: { b: 2, a: 1 } };

  it("executes directly when the caller did not supply a command ID", async () => {
    const execute = vi.fn().mockResolvedValue({ created: true });
    await expect(runIdempotentCommand({ ...base, execute })).resolves.toEqual({ created: true });
    expect(findOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the exact stored response for a matching replay", async () => {
    const requestHash = hashPayload(base.payload);
    findOne.mockReturnValueOnce(query({ requestHash, responseBody: { created: true } }));
    const execute = vi.fn();

    await expect(runIdempotentCommand({ ...base, commandId: "command-1", execute })).resolves.toEqual({ created: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a command ID that has a different payload", async () => {
    findOne.mockReturnValueOnce(query({ requestHash: "different", responseBody: {} }));
    await expect(runIdempotentCommand({ ...base, commandId: "command-1", execute: vi.fn() }))
      .rejects.toMatchObject({ statusCode: 409, message: "Command ID already used with a different payload" });
  });

  it("records a new command after it executes", async () => {
    findOne.mockReturnValueOnce(query(null));
    create.mockResolvedValue({});
    const execute = vi.fn().mockResolvedValue({ requestId: "request-1" });

    await expect(runIdempotentCommand({ ...base, commandId: "command-1", execute })).resolves.toEqual({ requestId: "request-1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      key: "command-1",
      userId: "user-1",
      route: "/v1/test",
      requestHash: hashPayload(base.payload),
      responseBody: { requestId: "request-1" },
    }));
  });

  it("uses a matching raced record and fails closed for missing or conflicting raced records", async () => {
    const requestHash = hashPayload(base.payload);
    findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query({ requestHash, responseBody: { requestId: "raced" } }));
    create.mockRejectedValueOnce(new Error("duplicate"));
    await expect(runIdempotentCommand({ ...base, commandId: "command-1", execute: vi.fn().mockResolvedValue({ requestId: "original" }) })).resolves.toEqual({ requestId: "raced" });

    findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(null));
    create.mockRejectedValueOnce(new Error("duplicate"));
    await expect(runIdempotentCommand({ ...base, commandId: "command-2", execute: vi.fn().mockResolvedValue({}) }))
      .rejects.toMatchObject({ statusCode: 500, message: "Unable to persist idempotency record" });

    findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query({ requestHash: "other", responseBody: {} }));
    create.mockRejectedValueOnce(new Error("duplicate"));
    await expect(runIdempotentCommand({ ...base, commandId: "command-3", execute: vi.fn().mockResolvedValue({}) }))
      .rejects.toMatchObject({ statusCode: 409, message: "Command ID already used with a different payload" });
  });
});
