import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ SENTRY_DSN: undefined as string | undefined }));

vi.mock("@sentry/node", () => ({ captureException: capture }));
vi.mock("../../config/env.js", () => ({ env }));

import { captureException } from "../sentry.js";

beforeEach(() => {
  vi.clearAllMocks();
  env.SENTRY_DSN = undefined;
});

describe("Sentry wrapper", () => {
  it("does nothing when Sentry is not configured", () => {
    captureException(new Error("test"));
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures errors when Sentry is configured", () => {
    env.SENTRY_DSN = "https://key@sentry.test/1";
    const error = new Error("test");
    captureException(error);
    expect(capture).toHaveBeenCalledWith(error);
  });
});
