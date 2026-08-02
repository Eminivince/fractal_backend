import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiVersionPlugin } from "../api-version.js";

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  app = Fastify();
  await apiVersionPlugin(app);
  app.get("/version", async (request: FastifyRequest) => ({ version: (request as any).apiVersion }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("API version plugin", () => {
  it("uses version one when a client does not send a version header", async () => {
    const response = await app.inject({ method: "GET", url: "/version" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1 });
  });

  it("uses a positive numeric Accept-Version header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/version",
      headers: { "accept-version": "2" },
    });

    expect(response.json()).toEqual({ version: 2 });
  });

  it("ignores invalid and zero headers, and uses the first repeated header", async () => {
    const invalid = await app.inject({ method: "GET", url: "/version", headers: { "accept-version": "zero" } });
    const zero = await app.inject({ method: "GET", url: "/version", headers: { "accept-version": "0" } });
    const repeated = await app.inject({ method: "GET", url: "/version", headers: { "accept-version": ["3", "4"] } });

    expect(invalid.json()).toEqual({ version: 1 });
    expect(zero.json()).toEqual({ version: 1 });
    expect(repeated.json()).toEqual({ version: 3 });
  });
});
