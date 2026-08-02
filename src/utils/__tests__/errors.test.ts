import { describe, expect, it } from "vitest";
import { HttpError, assert } from "../errors.js";

describe("HTTP errors", () => {
  it("preserves status, details, and a stable error code", () => {
    const details = { field: "email" };
    const error = new HttpError(422, "Invalid email", details, "invalid_input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "Error", message: "Invalid email", statusCode: 422, details, code: "invalid_input" });
  });

  it("does not throw when an assertion is true", () => {
    expect(() => assert(true, 400, "must not fail")).not.toThrow();
  });

  it("throws a typed HTTP error when an assertion is false", () => {
    try {
      assert(0, 403, "Forbidden", { action: "approve" });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ statusCode: 403, message: "Forbidden", details: { action: "approve" } });
    }
  });
});
