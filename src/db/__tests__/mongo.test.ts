import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mongoose: { connect: vi.fn(), disconnect: vi.fn() },
  registerSlowQueryPlugin: vi.fn(),
  env: {
    MONGODB_URI: "mongodb://localhost:27017/fractal",
    MONGODB_POOL_SIZE: 12,
    MONGODB_SLOW_QUERY_LOG: false,
    NODE_ENV: "test",
  },
}));

vi.mock("mongoose", () => ({ default: mocks.mongoose }));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../plugins/slow-query.js", () => ({
  registerSlowQueryPlugin: mocks.registerSlowQueryPlugin,
}));

import { connectMongo, disconnectMongo } from "../mongo.js";

beforeEach(async () => {
  await disconnectMongo();
  mocks.mongoose.connect.mockReset().mockResolvedValue(undefined);
  mocks.mongoose.disconnect.mockReset().mockResolvedValue(undefined);
  mocks.registerSlowQueryPlugin.mockReset();
  Object.assign(mocks.env, {
    MONGODB_URI: "mongodb://localhost:27017/fractal",
    MONGODB_POOL_SIZE: 12,
    MONGODB_SLOW_QUERY_LOG: false,
    NODE_ENV: "test",
  });
});

afterEach(async () => {
  await disconnectMongo();
  vi.restoreAllMocks();
});

describe("MongoDB connection lifecycle", () => {
  it("connects with bounded pool settings and enables indexes outside production", async () => {
    mocks.env.MONGODB_SLOW_QUERY_LOG = true;

    await connectMongo();

    expect(mocks.mongoose.connect).toHaveBeenCalledWith(
      "mongodb://localhost:27017/fractal",
      {
        maxPoolSize: 12,
        minPoolSize: 5,
        maxIdleTimeMS: 30_000,
        socketTimeoutMS: 45_000,
        serverSelectionTimeoutMS: 10_000,
        autoIndex: true,
      },
    );
    expect(mocks.registerSlowQueryPlugin).toHaveBeenCalledOnce();
  });

  it("does not connect twice while the database is already connected", async () => {
    await connectMongo();
    await connectMongo();

    expect(mocks.mongoose.connect).toHaveBeenCalledOnce();
  });

  it("disables automatic index builds in production and skips optional slow-query logging", async () => {
    mocks.env.NODE_ENV = "production";
    mocks.env.MONGODB_POOL_SIZE = 3;

    await connectMongo();

    expect(mocks.mongoose.connect).toHaveBeenCalledWith(
      "mongodb://localhost:27017/fractal",
      expect.objectContaining({ minPoolSize: 3, autoIndex: false }),
    );
    expect(mocks.registerSlowQueryPlugin).not.toHaveBeenCalled();
  });

  it("only disconnects after a successful connection and permits a new connection", async () => {
    await disconnectMongo();
    expect(mocks.mongoose.disconnect).not.toHaveBeenCalled();

    await connectMongo();
    await disconnectMongo();
    await connectMongo();

    expect(mocks.mongoose.disconnect).toHaveBeenCalledOnce();
    expect(mocks.mongoose.connect).toHaveBeenCalledTimes(2);
  });
});
