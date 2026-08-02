import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  FIELD_ENCRYPTION_ENABLED: false,
  FIELD_ENCRYPTION_KEY: undefined as string | undefined,
}));

vi.mock("../../../config/env.js", () => ({ env }));

import { fieldEncryptionPlugin } from "../field-encryption.js";

type Hook = (...args: any[]) => void;

function installPlugin() {
  const pre = vi.fn();
  const post = vi.fn();
  fieldEncryptionPlugin({ pre, post } as any, { fields: ["email", "notes"] });
  const preSave = pre.mock.calls.find(([name]) => name === "save")?.[1] as Hook;
  const postInit = post.mock.calls.find(([name]) => name === "init")?.[1] as Hook;
  const postFind = post.mock.calls.find(([name]) => name === "find")?.[1] as Hook;
  const postFindOne = post.mock.calls.find(([name]) => name === "findOne")?.[1] as Hook;
  return { pre, post, preSave, postInit, postFind, postFindOne };
}

function document(values: Record<string, unknown>, useSet = true) {
  const state = { ...values };
  return {
    state,
    get: vi.fn((field: string) => state[field]),
    ...(useSet ? { set: vi.fn((field: string, value: unknown) => { state[field] = value; }) } : {}),
  };
}

beforeEach(() => {
  env.FIELD_ENCRYPTION_ENABLED = false;
  env.FIELD_ENCRYPTION_KEY = undefined;
});

describe("field encryption plugin", () => {
  it("registers save and query hooks and leaves fields unchanged when encryption is unavailable", () => {
    const hooks = installPlugin();
    const doc = document({ email: "investor@example.com", notes: "private" });

    hooks.preSave.call(doc);
    hooks.postInit(doc);
    hooks.postFind(undefined);
    hooks.postFindOne(null);

    expect(hooks.pre).toHaveBeenCalledWith("save", expect.any(Function));
    expect(hooks.post).toHaveBeenCalledWith("init", expect.any(Function));
    expect(hooks.post).toHaveBeenCalledWith("find", expect.any(Function));
    expect(hooks.post).toHaveBeenCalledWith("findOne", expect.any(Function));
    expect(doc.state).toEqual({ email: "investor@example.com", notes: "private" });
  });

  it("encrypts non-empty text once and decrypts it through init and find hooks", () => {
    env.FIELD_ENCRYPTION_ENABLED = true;
    env.FIELD_ENCRYPTION_KEY = "1".repeat(64);
    const hooks = installPlugin();
    const doc = document({ email: "investor@example.com", notes: "", other: 10 });

    hooks.preSave.call(doc);
    const encryptedEmail = doc.state.email as string;
    hooks.preSave.call(doc);

    expect(encryptedEmail).toMatch(/^enc:/);
    expect(doc.state.email).toBe(encryptedEmail);
    expect(doc.state.notes).toBe("");

    hooks.postInit(doc);
    expect(doc.state.email).toBe("investor@example.com");
    expect(doc.set).toHaveBeenCalledWith("email", "investor@example.com");

    hooks.preSave.call(doc);
    const queryDoc = { email: doc.state.email, notes: "plain" } as Record<string, unknown>;
    hooks.postFind([queryDoc]);
    hooks.postFindOne(queryDoc);
    hooks.postFind({ not: "an array" });

    expect(queryDoc.email).toBe("investor@example.com");
    expect(queryDoc.notes).toBe("plain");
  });

  it("does not decrypt when the feature is enabled without a key", () => {
    env.FIELD_ENCRYPTION_ENABLED = true;
    const hooks = installPlugin();
    const doc = document({ email: "enc:ZW5jcnlwdGVk" }, false);

    hooks.postInit(doc);

    expect(doc.state.email).toBe("enc:ZW5jcnlwdGVk");
  });

  it("reports invalid ciphertext and continues with other fields", () => {
    env.FIELD_ENCRYPTION_ENABLED = true;
    env.FIELD_ENCRYPTION_KEY = "2".repeat(64);
    const hooks = installPlugin();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const doc = document({ email: "enc:not-valid", notes: "clear text" }, false);

    hooks.postInit(doc);

    expect(error).toHaveBeenCalledWith('[field-encryption] Failed to decrypt field "email"');
    expect(doc.state).toEqual({ email: "enc:not-valid", notes: "clear text" });
  });
});
