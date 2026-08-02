import { env } from "./config/env.js";
import { postgresMigrationStatus } from "./db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres } from "./db/postgres.js";
import {
  AdministratorOperationsError,
  administratorOperationsKeyFingerprint,
  approveAdministratorRecoveryRequest,
  bootstrapAdministratorCohort,
  createAdministratorRecoveryRequest,
  readAdministratorOperationsStatus,
  type AdministratorBootstrapMember,
} from "./platform/postgres-administrator-operations.js";

const cliArguments = process.argv.slice(2).filter((argument) => argument !== "--");

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new AdministratorOperationsError(`${name} is required for this one-shot operation.`, "invalid_input");
  return value;
}

function parseJson<T>(value: string | undefined, name: string): T {
  try {
    return JSON.parse(requireValue(value, name)) as T;
  } catch (error) {
    if (error instanceof AdministratorOperationsError) throw error;
    throw new AdministratorOperationsError(`${name} must contain valid JSON.`, "invalid_input");
  }
}

function flagValue(name: string): string | undefined {
  const index = cliArguments.indexOf(name);
  if (index < 0) return undefined;
  const value = cliArguments[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function assertCurrentSchema(): Promise<void> {
  const pending = (await postgresMigrationStatus()).filter((migration) => migration.state === "pending");
  if (pending.length) {
    throw new AdministratorOperationsError(
      `PostgreSQL migrations must be applied before administrator operations; pending count: ${pending.length}.`,
      "conflict",
    );
  }
}

async function run(): Promise<void> {
  const command = cliArguments[0];
  await connectPostgres({ required: true });
  await assertCurrentSchema();

  if (command === "status") {
    console.log(JSON.stringify(await readAdministratorOperationsStatus(), null, 2));
    return;
  }

  const actor = requireValue(env.ADMIN_OPERATIONS_ACTOR_ID, "ADMIN_OPERATIONS_ACTOR_ID");
  if (command === "bootstrap") {
    if (!cliArguments.includes("--confirm-initial-administrator-bootstrap")) {
      throw new AdministratorOperationsError(
        "Bootstrap requires --confirm-initial-administrator-bootstrap because it is permanently sealed after success.",
        "invalid_input",
      );
    }
    const members = parseJson<AdministratorBootstrapMember[]>(
      env.ADMIN_BOOTSTRAP_COHORT_JSON,
      "ADMIN_BOOTSTRAP_COHORT_JSON",
    );
    if (!Array.isArray(members)) {
      throw new AdministratorOperationsError("ADMIN_BOOTSTRAP_COHORT_JSON must be a JSON array.", "invalid_input");
    }
    const result = await bootstrapAdministratorCohort({ members, initiatedBy: actor });
    console.log(JSON.stringify({
      operation: "administrator_bootstrap_sealed",
      cohortId: result.cohortId,
      cohortSize: result.cohortSize,
      sealedAt: result.sealedAt,
      activationDeliveryCount: result.identityIds.length,
    }, null, 2));
    return;
  }

  if (command === "request-recovery") {
    const request = parseJson<{ targetEmail?: string; incidentReference?: string; reason?: string }>(
      env.ADMIN_RECOVERY_REQUEST_JSON,
      "ADMIN_RECOVERY_REQUEST_JSON",
    );
    const result = await createAdministratorRecoveryRequest({
      targetEmail: requireValue(request.targetEmail, "ADMIN_RECOVERY_REQUEST_JSON.targetEmail"),
      incidentReference: requireValue(request.incidentReference, "ADMIN_RECOVERY_REQUEST_JSON.incidentReference"),
      reason: requireValue(request.reason, "ADMIN_RECOVERY_REQUEST_JSON.reason"),
      requestedBy: actor,
      requesterKeyFingerprint: administratorOperationsKeyFingerprint(
        requireValue(env.ADMIN_BREAK_GLASS_REQUEST_KEY, "ADMIN_BREAK_GLASS_REQUEST_KEY"),
      ),
    });
    console.log(JSON.stringify({
      operation: "administrator_recovery_requested",
      requestId: result.id,
      status: result.status,
      requestedAt: result.requestedAt,
      expiresAt: result.expiresAt,
    }, null, 2));
    return;
  }

  if (command === "approve-recovery") {
    const result = await approveAdministratorRecoveryRequest({
      requestId: requireValue(flagValue("--request-id"), "--request-id"),
      approvedBy: actor,
      approverKeyFingerprint: administratorOperationsKeyFingerprint(
        requireValue(env.ADMIN_BREAK_GLASS_APPROVAL_KEY, "ADMIN_BREAK_GLASS_APPROVAL_KEY"),
      ),
    });
    console.log(JSON.stringify({
      operation: "administrator_recovery_applied",
      requestId: result.request.id,
      status: result.request.status,
      appliedAt: result.request.appliedAt,
      revokedSessionCount: result.revokedSessionCount,
      activationQueued: true,
    }, null, 2));
    return;
  }

  throw new AdministratorOperationsError(
    "Choose one command: status, bootstrap, request-recovery, or approve-recovery.",
    "invalid_input",
  );
}

try {
  await run();
} catch (error) {
  if (error instanceof AdministratorOperationsError) {
    console.error(`[administrator-operations:${error.code}] ${error.message}`);
  } else {
    console.error(`[administrator-operations:unexpected] ${error instanceof Error ? error.message : "Operation failed"}`);
  }
  process.exitCode = 1;
} finally {
  await disconnectPostgres();
}
