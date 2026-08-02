import { describe, expect, it } from "vitest";
import { validateUboCoverage } from "../ubo-validation.js";

describe("UBO coverage validation", () => {
  it("accepts complete significant-owner disclosure", () => {
    expect(validateUboCoverage([
      { ownershipPct: 60, fullName: "Ada Okafor", nationality: "Nigerian", idDocumentRef: "passport-1" },
      { ownershipPct: 20 },
    ])).toEqual({ valid: true, totalPct: 80, errors: [] });
  });

  it("reports insufficient coverage and each required significant-owner field", () => {
    const result = validateUboCoverage([{ ownershipPct: 25, fullName: " ", nationality: "", idDocumentRef: "" }]);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("only 25%"), expect.stringContaining("missing a full name"), expect.stringContaining("missing nationality"), expect.stringContaining("missing an ID document"),
    ]));
  });

  it("does not require optional identity fields below the significant threshold", () => {
    expect(validateUboCoverage([{ ownershipPct: 24 }, { ownershipPct: 51 }]).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('UBO "unnamed" (51%) is missing nationality'),
    ]));
  });

  it("treats an absent ownership value as zero", () => {
    expect(validateUboCoverage([{ ownershipPct: undefined as unknown as number }]).totalPct).toBe(0);
  });
});
