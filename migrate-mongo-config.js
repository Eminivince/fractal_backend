/**
 * B8: migrate-mongo configuration.
 * Run migrations with: pnpm migrate:up / pnpm migrate:down / pnpm migrate:status
 */

import dotenv from "dotenv";
dotenv.config();

const mongodbUrl = process.env.MONGODB_URI || "mongodb://localhost:27017/fractal";
const databaseName = decodeURIComponent(new URL(mongodbUrl).pathname).replace(/^\//, "");
if (!databaseName) {
  throw new Error("MONGODB_URI must include an explicit database name");
}

export default {
  mongodb: {
    url: mongodbUrl,
    databaseName,
  },
  migrationsDir: "migrations",
  changelogCollectionName: "changelog",
  migrationFileExtension: ".js",
  useFileHash: false,
  moduleSystem: "esm",
};
