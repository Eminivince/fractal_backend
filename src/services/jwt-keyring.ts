export interface JwtKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, string>;
}

export function createJwtKeyring(input: {
  primarySecret: string;
  activeKeyId: string;
  keyRingJson?: string;
}): JwtKeyring {
  const keys = new Map<string, string>([["primary", input.primarySecret]]);
  if (input.keyRingJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.keyRingJson);
    } catch {
      throw new Error("JWT_KEY_RING_JSON must be a JSON object of key IDs to secrets");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("JWT_KEY_RING_JSON must be a JSON object of key IDs to secrets");
    }
    for (const [keyId, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || keyId === "primary") {
        throw new Error("JWT key IDs must be non-primary alphanumeric, underscore, or hyphen identifiers");
      }
      if (typeof secret !== "string" || secret.length < 32) {
        throw new Error(`JWT verification key ${keyId} must be at least 32 characters`);
      }
      keys.set(keyId, secret);
    }
  }
  if (!keys.has(input.activeKeyId)) {
    throw new Error(`JWT_ACTIVE_KEY_ID ${input.activeKeyId} has no configured signing key`);
  }
  return { activeKeyId: input.activeKeyId, keys };
}

/**
 * Legacy tokens did not carry a key ID, so they only verify with the original
 * primary secret. New tokens always carry a kid and must map to a configured
 * key; an unknown kid is never tried against every key.
 */
export function resolveJwtVerificationKey(
  keyring: JwtKeyring,
  tokenOrHeader: unknown,
): string {
  const header = tokenOrHeader && typeof tokenOrHeader === "object" && "header" in tokenOrHeader
    ? (tokenOrHeader as { header?: { kid?: unknown } }).header
    : undefined;
  if (header?.kid === undefined) return keyring.keys.get("primary")!;
  if (typeof header.kid !== "string") throw new Error("JWT kid is invalid");
  const key = keyring.keys.get(header.kid);
  if (!key) throw new Error("JWT kid is not trusted");
  return key;
}
