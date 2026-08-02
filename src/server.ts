import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { connectPostgres, disconnectPostgres } from "./db/postgres.js";
import { connectRedis, disconnectRedis } from "./db/redis.js";
import { closeAllQueues } from "./services/queue.js";

async function start() {
  await connectMongo();
  await connectRedis();
  await connectPostgres();
  const app = await buildApp();

  const close = async (signal: string) => {
    app.log.info(`Shutting down (${signal})`);
    await closeAllQueues();
    await app.close();
    await disconnectRedis();
    await disconnectPostgres();
    await disconnectMongo();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void close("SIGINT");
  });

  process.on("SIGTERM", () => {
    void close("SIGTERM");
  });

  await app.listen({
    port: env.PORT,
    host: "0.0.0.0",
  });

  app.log.info(`API listening on ${env.PORT}`);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
