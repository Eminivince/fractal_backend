import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import { toCsv } from "../csv.js";
import { decimalToString, toDecimal } from "../decimal.js";
import { paginate, paginatedResult, paginationSchema } from "../pagination.js";
import { serialize } from "../serialize.js";
import { assertInvestorScope, assertIssuerBusinessScope } from "../scope.js";

describe("CSV serialization", () => {
  it("uses discovered columns, CRLF rows, and RFC 4180 quoting", () => {
    expect(toCsv([
      { name: "Ada", note: "plain", empty: null },
      { name: "Bola, Ltd", note: 'said "hello"', createdAt: new Date("2026-01-02T03:04:05.000Z") },
    ])).toBe("name,note,empty,createdAt\r\nAda,plain,,\r\n\"Bola, Ltd\",\"said \"\"hello\"\"\",,2026-01-02T03:04:05.000Z");
  });

  it("uses supplied column order and serializes object cells", () => {
    expect(toCsv([{ ignored: "no", details: { amount: 4 } }], ["details", "missing"])).toBe('details,missing\r\n"{""amount"":4}",');
  });
});

describe("database value serialization", () => {
  it("preserves Decimal128 values and converts scalar values to Decimal128", () => {
    const decimal = mongoose.Types.Decimal128.fromString("12.50");
    expect(toDecimal(decimal)).toBe(decimal);
    expect(toDecimal(12.5).toString()).toBe("12.5");
    expect(decimalToString(decimal)).toBe("12.50");
    expect(decimalToString("12.50")).toBe("12.50");
  });

  it("recursively converts database values without changing primitive values", () => {
    const objectId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
    const value = {
      amount: mongoose.Types.Decimal128.fromString("250.00"),
      id: objectId,
      at: new Date("2026-01-02T03:04:05.000Z"),
      nested: [mongoose.Types.Decimal128.fromString("1"), { active: true }],
      nullValue: null,
    };

    expect(serialize(value)).toEqual({
      amount: "250.00",
      id: "507f1f77bcf86cd799439011",
      at: "2026-01-02T03:04:05.000Z",
      nested: ["1", { active: true }],
      nullValue: null,
    });
  });
});

describe("pagination", () => {
  it("parses bounded positive input and supplies defaults", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(paginationSchema.parse({ page: "2", limit: "100" })).toEqual({ page: 2, limit: 100 });
    expect(() => paginationSchema.parse({ page: 0, limit: 101 })).toThrow();
  });

  it("calculates offsets and page counts", () => {
    expect(paginate(3, 25)).toEqual({ skip: 50, limit: 25 });
    expect(paginatedResult(["a", "b"], 51, 3, 25)).toEqual({ data: ["a", "b"], total: 51, page: 3, limit: 25, pages: 3 });
  });
});

describe("tenant scope guards", () => {
  it("allows non-target roles and matching target records", () => {
    expect(() => assertIssuerBusinessScope({ role: "admin" } as any, "business-1")).not.toThrow();
    expect(() => assertIssuerBusinessScope({ role: "issuer", businessId: "business-1" } as any, "business-1")).not.toThrow();
    expect(() => assertInvestorScope({ role: "professional", userId: "user-1" } as any, "user-2")).not.toThrow();
    expect(() => assertInvestorScope({ role: "investor", userId: "user-1" } as any, "user-1")).not.toThrow();
  });

  it("rejects missing or foreign issuer and investor records", () => {
    expect(() => assertIssuerBusinessScope({ role: "issuer", businessId: "business-1" } as any, null)).toThrow(/Issuer out of business scope/);
    expect(() => assertIssuerBusinessScope({ role: "issuer", businessId: "business-1" } as any, "business-2")).toThrow(/Issuer out of business scope/);
    expect(() => assertInvestorScope({ role: "investor", userId: "user-1" } as any, "user-2")).toThrow(/Investor out of scope/);
  });
});
