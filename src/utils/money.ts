/**
 * Money helpers — all financial arithmetic should be done in integer minor units
 * (kobo) to avoid binary floating-point drift. Naira values stored as Decimal128
 * are converted to integer kobo before any addition/subtraction.
 */

export type NairaValue = number | string | { toString(): string };

function rawNairaValue(naira: NairaValue): string {
  if (typeof naira !== "number") return typeof naira === "string" ? naira : naira.toString();
  if (!Number.isFinite(naira)) throw new Error("Invalid NGN number");

  const direct = String(naira);
  if (/^-?\d+(?:\.\d{1,2})?$/.test(direct)) return direct;

  // Callers in legacy code may have already evaluated a decimal expression
  // such as 0.1 + 0.2. Accept only a tiny IEEE-754 representation tail; a
  // genuine fraction below one kobo remains invalid rather than being rounded
  // into a financial record.
  const roundedKobo = Math.round(naira * 100);
  if (!Number.isSafeInteger(roundedKobo)) throw new Error(`NGN amount exceeds safe kobo range: ${direct}`);
  const normalized = roundedKobo / 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(naira)) * 8;
  if (Math.abs(naira - normalized) <= tolerance) return normalized.toFixed(2);
  throw new Error(`NGN amount has a fraction below one kobo: ${direct}`);
}

/**
 * Convert a decimal naira amount to integer kobo without first passing a
 * Decimal128 string through binary floating point. Amounts with fractions below
 * one kobo are rejected rather than silently rounded into an accounting entry.
 */
export function nairaToKobo(naira: NairaValue): number {
  const raw = rawNairaValue(naira);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid NGN amount for kobo conversion: ${raw}`);
  }
  const [, sign, whole, fraction = ""] = match;
  const kobo = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const signed = sign === "-" ? -kobo : kobo;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`NGN amount exceeds safe kobo range: ${raw}`);
  }
  return Number(signed);
}

/** Convert integer kobo back to a naira number. */
export function koboToNaira(kobo: number): number {
  return kobo / 100;
}

/** Sum a list of naira values exactly by accumulating in integer kobo. Returns naira. */
export function sumNaira(values: NairaValue[]): number {
  let kobo = 0;
  for (const v of values) {
    kobo += nairaToKobo(v);
  }
  return kobo / 100;
}
