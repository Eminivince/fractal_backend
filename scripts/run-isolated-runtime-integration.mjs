import { spawnSync } from "node:child_process";

function requiredUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return new URL(value);
}

function databaseName(url) {
  return decodeURIComponent(url.pathname).replace(/^\//, "");
}

function requireIsolated(url, name) {
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName(url))) {
    throw new Error(`${name} must use a database name that contains test or ci.`);
  }
}

const postgres = process.env.TEST_DATABASE_URL
  ? new URL(process.env.TEST_DATABASE_URL)
  : requiredUrl("DATABASE_URL");
const mongo = process.env.TEST_MONGODB_URI
  ? new URL(process.env.TEST_MONGODB_URI)
  : requiredUrl("MONGODB_URI");
const redis = process.env.TEST_REDIS_URL
  ? new URL(process.env.TEST_REDIS_URL)
  : requiredUrl("REDIS_URL");

if (!process.env.TEST_DATABASE_URL) postgres.pathname = "/fractal_platform_test";
if (!process.env.TEST_MONGODB_URI) mongo.pathname = "/fractal_test";
if (!process.env.TEST_REDIS_URL) redis.pathname = "/1";

requireIsolated(postgres, "TEST_DATABASE_URL");
requireIsolated(mongo, "TEST_MONGODB_URI");

const child = spawnSync(
  "pnpm",
  ["test:integration"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: postgres.toString(),
      MONGODB_URI: mongo.toString(),
      REDIS_URL: redis.toString(),
    },
  },
);

process.exit(child.status ?? 1);
