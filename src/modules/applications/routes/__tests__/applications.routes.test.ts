import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  createAndSubmit: vi.fn(), create: vi.fn(), list: vi.fn(), getById: vi.fn(), listTasks: vi.fn(), submit: vi.fn(), requestService: vi.fn(), updateTaskStatus: vi.fn(), startReview: vi.fn(), needsInfo: vi.fn(), resubmit: vi.fn(), approve: vi.fn(), reject: vi.fn(), withdraw: vi.fn(), listReviewItems: vi.fn(), respondReviewItem: vi.fn(), verifyReviewItem: vi.fn(), closeReviewRound: vi.fn(),
}));
vi.mock("../../controllers/applications.controller.js", () => ({ createApplicationController: () => handlers }));

import { applicationRoutes } from "../applications.routes.js";

describe("application route registration", () => {
  it("registers each application action behind authentication in safe literal-first order", async () => {
    const registered: Array<{ method: string; path: string; options: { preHandler: unknown[] }; handler: unknown }> = [];
    const app = {
      authenticate: vi.fn(),
      post: (path: string, options: { preHandler: unknown[] }, handler: unknown) => { registered.push({ method: "POST", path, options, handler }); },
      get: (path: string, options: { preHandler: unknown[] }, handler: unknown) => { registered.push({ method: "GET", path, options, handler }); },
      patch: (path: string, options: { preHandler: unknown[] }, handler: unknown) => { registered.push({ method: "PATCH", path, options, handler }); },
    };
    await applicationRoutes(app as never);
    expect(registered).toHaveLength(18);
    expect(registered.slice(0, 3).map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/applications/create-and-submit",
      "POST /v1/applications",
      "GET /v1/applications",
    ]);
    expect(registered.every((route) => route.options.preHandler[0] === app.authenticate)).toBe(true);
    expect(registered).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "PATCH", path: "/v1/tasks/:id/status", handler: handlers.updateTaskStatus }),
      expect.objectContaining({ method: "POST", path: "/v1/applications/:id/approve", handler: handlers.approve }),
      expect.objectContaining({ method: "POST", path: "/v1/review-items/:id/verify", handler: handlers.verifyReviewItem }),
      expect.objectContaining({ method: "POST", path: "/v1/review-rounds/:id/close", handler: handlers.closeReviewRound }),
    ]));
  });
});
