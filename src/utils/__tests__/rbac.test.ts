// A-81: Seed unit tests for the RBAC utility
import { describe, it, expect } from "vitest";
import { authorize } from "../rbac.js";
import { HttpError } from "../errors.js";
import type { AuthUser } from "../../types.js";

function makeUser(role: AuthUser["role"]): AuthUser {
  return { userId: "test-user", role };
}

describe("authorize()", () => {
  it("allows admin to read any resource", () => {
    const user = makeUser("admin");
    expect(() => authorize(user, "read", "business")).not.toThrow();
    expect(() => authorize(user, "read", "distribution")).not.toThrow();
    expect(() => authorize(user, "read", "user")).not.toThrow();
  });

  it("allows operator to approve distributions", () => {
    const user = makeUser("operator");
    expect(() => authorize(user, "approve", "distribution")).not.toThrow();
  });

  it("blocks investor from approving distributions", () => {
    const user = makeUser("investor");
    expect(() => authorize(user, "approve", "distribution")).toThrow(HttpError);
  });

  it("allows issuer to create applications", () => {
    const user = makeUser("issuer");
    expect(() => authorize(user, "create", "application")).not.toThrow();
  });

  it("blocks professional from creating offerings", () => {
    const user = makeUser("professional");
    expect(() => authorize(user, "create", "offering")).toThrow(HttpError);
  });

  it("throws HttpError with 403 status code on denial", () => {
    const user = makeUser("investor");
    try {
      authorize(user, "create", "business");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(403);
    }
  });

  it("allows admin to execute reconciliation", () => {
    const user = makeUser("admin");
    expect(() => authorize(user, "execute", "reconciliation")).not.toThrow();
  });

  it("blocks issuer from executing reconciliation", () => {
    const user = makeUser("issuer");
    expect(() => authorize(user, "execute", "reconciliation")).toThrow(HttpError);
  });

  it("allows professional to submit work orders", () => {
    const user = makeUser("professional");
    expect(() => authorize(user, "submit", "work_order")).not.toThrow();
  });

  it("allows admin to update platform config", () => {
    const user = makeUser("admin");
    expect(() => authorize(user, "update", "platform")).not.toThrow();
  });

  it("blocks operator from updating platform config", () => {
    const user = makeUser("operator");
    expect(() => authorize(user, "update", "platform")).toThrow(HttpError);
  });
});
