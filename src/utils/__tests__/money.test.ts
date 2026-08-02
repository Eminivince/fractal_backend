import { describe, it, expect } from "vitest";
import { nairaToKobo, koboToNaira, sumNaira } from "../money.js";

describe("money helpers — integer-kobo exactness", () => {
  it("converts naira to integer kobo, rounding to nearest kobo", () => {
    expect(nairaToKobo(100)).toBe(10_000);
    expect(nairaToKobo(0.01)).toBe(1);
    expect(nairaToKobo(1234.56)).toBe(123_456);
    // Round half away from rounding errors
    expect(nairaToKobo(0.1 + 0.2)).toBe(30);
  });

  it("round-trips kobo <-> naira", () => {
    expect(koboToNaira(10_000)).toBe(100);
    expect(koboToNaira(1)).toBe(0.01);
  });

  it("sums values exactly without binary float drift", () => {
    // 0.1 + 0.2 !== 0.3 in float; sumNaira must be exact.
    expect(sumNaira([0.1, 0.2])).toBe(0.3);
    // Summing 100 entries of 0.01 must equal 1.00 exactly.
    expect(sumNaira(Array.from({ length: 100 }, () => 0.01))).toBe(1);
  });

  it("accepts string and Decimal128-like inputs", () => {
    expect(sumNaira(["100.00", "0.50", { toString: () => "0.25" }])).toBe(100.75);
  });

  it("rejects genuine fractions below one kobo instead of silently rounding them", () => {
    expect(() => nairaToKobo("1.001")).toThrow(/fraction|Invalid/);
    expect(() => nairaToKobo(1.005)).toThrow(/fraction/);
  });
});
