import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { createJwtKeyring, resolveJwtVerificationKey } from "../jwt-keyring.js";

const primary = "p".repeat(32);
const rotated = "r".repeat(32);

describe("JWT key ring", () => {
  it("uses the active key for signing and selects a specific kid for verification", () => {
    const keyring = createJwtKeyring({
      primarySecret: primary,
      activeKeyId: "2026_q3",
      keyRingJson: JSON.stringify({ "2026_q3": rotated }),
    });
    expect(keyring.activeKeyId).toBe("2026_q3");
    expect(resolveJwtVerificationKey(keyring, { header: { kid: "2026_q3" } })).toBe(rotated);
  });

  it("keeps no-kid legacy tokens on the original primary secret", () => {
    const keyring = createJwtKeyring({ primarySecret: primary, activeKeyId: "primary" });
    expect(resolveJwtVerificationKey(keyring, { header: {} })).toBe(primary);
    expect(resolveJwtVerificationKey(keyring, null)).toBe(primary);
  });

  it("rejects unknown key IDs and invalid configuration", () => {
    const keyring = createJwtKeyring({ primarySecret: primary, activeKeyId: "primary" });
    expect(() => resolveJwtVerificationKey(keyring, { header: { kid: "unknown" } })).toThrow("not trusted");
    expect(() => resolveJwtVerificationKey(keyring, { header: { kid: 42 } })).toThrow("kid is invalid");
    expect(() => createJwtKeyring({ primarySecret: primary, activeKeyId: "missing" })).toThrow("no configured signing key");
    expect(() => createJwtKeyring({ primarySecret: primary, activeKeyId: "primary", keyRingJson: "not JSON" })).toThrow("JSON object");
    expect(() => createJwtKeyring({ primarySecret: primary, activeKeyId: "primary", keyRingJson: "[]" })).toThrow("JSON object");
    expect(() => createJwtKeyring({ primarySecret: primary, activeKeyId: "primary", keyRingJson: JSON.stringify({ primary: rotated }) })).toThrow("non-primary");
    expect(() => createJwtKeyring({ primarySecret: primary, activeKeyId: "primary", keyRingJson: JSON.stringify({ rotated: "too-short" }) })).toThrow("at least 32 characters");
  });

  it("verifies a token signed by the rotated active key", async () => {
    const app = Fastify();
    await app.register(jwt, { secret: primary });
    const keyring = createJwtKeyring({
      primarySecret: primary,
      activeKeyId: "2026_q3",
      keyRingJson: JSON.stringify({ "2026_q3": rotated }),
    });
    const token = app.jwt.sign(
      { userId: "user-1" },
      { key: rotated, header: { alg: "HS256", kid: "2026_q3" } },
    );
    const decoded = app.jwt.decode(token, { complete: true });
    expect(app.jwt.verify(token, { key: resolveJwtVerificationKey(keyring, decoded) })).toMatchObject({ userId: "user-1" });
    await app.close();
  });
});
