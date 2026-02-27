import mongoose from "mongoose";
import { env } from "../config/env.js";

let connected = false;

export async function connectMongo() {
  if (connected) return;
  await mongoose.connect(env.MONGODB_URI, {
    dbName: "fractal",
  });
  connected = true;
}

export async function disconnectMongo() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
