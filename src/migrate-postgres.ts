import { applyPostgresMigrations, postgresMigrationStatus, verifyPostgresSchema } from "./db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres } from "./db/postgres.js";

const statusOnly = process.argv.includes("--status");
const verifyOnly = process.argv.includes("--verify");

if (statusOnly && verifyOnly) {
  throw new Error("Choose either --status or --verify, not both");
}

try {
  await connectPostgres({ required: true });
  if (statusOnly) {
    console.table(await postgresMigrationStatus());
  } else if (verifyOnly) {
    const verification = await verifyPostgresSchema();
    console.log(
      `Postgres schema verified: ${verification.expectedTables.length} tables, ${verification.expectedIndexes.length} indexes, ${verification.expectedConstraints.length} named constraints, ${verification.expectedDefinitionCount} catalog definitions`,
    );
  } else {
    const executed = await applyPostgresMigrations();
    console.log(executed.length ? `Applied Postgres migrations: ${executed.join(", ")}` : "Postgres migrations are current");
  }
} finally {
  await disconnectPostgres();
}
