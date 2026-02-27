import dotenv from "dotenv";
import bcrypt from "bcrypt";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { UserModel } from "./db/models.js";

dotenv.config();

const ADMIN_EMAIL = "admin@fractal.demo";
const ADMIN_NAME = "Platform Admin";

/** Default password when ADMIN_PASSWORD env is not set (dev only). */
const DEFAULT_DEV_PASSWORD = "AdminChangeMe!";

async function seedAdmin() {
  const rawPassword = process.env.ADMIN_PASSWORD ?? DEFAULT_DEV_PASSWORD;
  if (!process.env.ADMIN_PASSWORD) {
    console.warn(
      "Warning: ADMIN_PASSWORD not set. Using default dev password. Set ADMIN_PASSWORD in .env for production.",
    );
  }

  await connectMongo();

  const passwordHash = await bcrypt.hash(rawPassword, 10);

  const admin = await UserModel.findOneAndUpdate(
    { email: ADMIN_EMAIL },
    {
      $set: {
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        role: "admin",
        status: "active",
        passwordHash,
        updatedAt: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  console.log("Admin account ready:");
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Name:     ${admin.name}`);
  console.log(`  ID:       ${admin._id}`);
  if (process.env.ADMIN_PASSWORD) {
    console.log(`  Password: (from ADMIN_PASSWORD in .env)`);
  } else {
    console.log(`  Password: ${DEFAULT_DEV_PASSWORD}`);
    console.log("  → Set ADMIN_PASSWORD in .env to use your own password next time.");
  }

  await disconnectMongo();
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
