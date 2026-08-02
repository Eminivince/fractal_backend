import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a hex-encoded HMAC without leaking a prefix match through comparison
 * timing. Providers may rotate webhook algorithms, so callers can accept a
 * deliberate, finite set of algorithms while sharing the same secret.
 */
export function verifyHmacHexSignature(params: {
  payload: string;
  signature: string;
  secret: string;
  algorithms: readonly string[];
}): boolean {
  const normalizedSignature = params.signature.trim();
  if (!/^[a-fA-F0-9]+$/.test(normalizedSignature) || normalizedSignature.length % 2 !== 0) {
    return false;
  }

  const actual = Buffer.from(normalizedSignature, "hex");
  return params.algorithms.some((algorithm) => {
    const expected = createHmac(algorithm, params.secret).update(params.payload).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}
