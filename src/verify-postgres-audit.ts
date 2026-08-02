import { connectPostgres, disconnectPostgres } from "./db/postgres.js";
import { verifyAllPostgresAuditScopes, verifyPostgresAuditScope } from "./platform/postgres-audit-verification.js";

try {
  await connectPostgres({ required: true });
  const scope = process.env.AUDIT_SCOPE_KEY?.trim();
  const result = scope ? await verifyPostgresAuditScope(scope) : await verifyAllPostgresAuditScopes();
  console.log(`PostgreSQL audit verification passed: ${JSON.stringify(result)}`);
} finally {
  await disconnectPostgres();
}
