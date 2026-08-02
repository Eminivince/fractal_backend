# Fractal API

The current MongoDB API is a domain prototype and migration source. New transactional work is built on PostgreSQL under the `fractal` schema, following [ADR-0001](../../docs-and-mds/architecture/ADR-0001-authoritative-data-store.md).

## Local runtime

Run `pnpm run dev` from the workspace root.

It starts local MongoDB, PostgreSQL, and Redis containers when they are not running. It then starts the web app, API, and worker.

On macOS, the command starts Docker Desktop when it is stopped.

It uses the connection URLs in `apps/api/.env`. Use local URLs without MongoDB or Redis credentials. The command does not apply database migrations.

The HTTP API and background workers are distinct processes:

```sh
pnpm --filter @fractal/api dev
pnpm --filter @fractal/api worker
```

Workers require Redis and take a renewable singleton lease before starting legacy polling work. Do not run more than one worker runtime until the job has a dedicated durable scheduling and idempotency design.

## Transactional email (Resend)

Resend is the primary transactional-email provider. Set these **runtime-only** variables in `apps/api/.env` or your deployment secret store; never commit the API key:

```sh
RESEND_API_KEY=re_...
EMAIL_FROM=notifications@your-verified-domain.example
NOTIFICATION_EMAIL_ENABLED=true
AUTH_EMAIL_DELIVERY_ENABLED=true
```

`EMAIL_FROM` must be a sender address on a domain verified in Resend. Authentication emails are written to the PostgreSQL delivery queue and sent by the worker, so run both the HTTP API and `pnpm --filter @fractal/api worker`. The system integrations endpoint reports whether the provider is configured, but it does not claim a delivery succeeded. SMTP remains an optional fallback only.

## On-chain testnet integration

The checked-in Sepolia addresses in `packages/contracts/deployments/ethereum-sepolia.json` are a historical 2026-07-18 test-only record and do not match the current contract ABI or bytecode. Do not copy them into a current-source environment. A fresh, commit-bound candidate must be deployed and verified first:

```sh
cd packages/contracts
# FRACTAL_RELEASE_COMMIT, FRACTAL_RELEASE_MANIFEST_SHA256, and
# FRACTAL_RELEASE_MANIFEST_PATH must already be exported from the clean
# release-manifest preparation step.
FRACTAL_DEPLOYMENT_MANIFEST=deployments/ethereum-sepolia-current-candidate.json \
  forge script script/VerifyCurrentTestnet.s.sol:VerifyCurrentTestnet --rpc-url sepolia
```

Set `BLOCKCHAIN_WORKER_ENABLED=true` only for controlled testnet work after setting `CHAIN_ID=11155111`, the operator key/address, and **every** address in that manifest: token factory, identity registry/factory, claim issuer, agent registry, distribution audit, and payout token. The API rejects partial configuration. The current payout asset is mock fUSD, and this environment must never be mistaken for a production issuance or custody configuration. Production rejects every on-chain/anchor worker with an environment private key; the `aws_kms` and `vault` labels are not implemented EVM signers and are also rejected for signing work. `LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED` remains false: the Mongo-backed queue cannot deploy new tokens. New deployment requests must originate from the PostgreSQL maker-checker chain-deployment workflow. `CHAIN_DEPLOYMENT_EXECUTOR_ENABLED` is separately disabled by default; when explicitly enabled for testnet, the worker claims an approved PostgreSQL operation, persists the hash before receipt polling, and reconciles the TokenFactory record before confirming the operation.

Configuration is loaded from `apps/api/.env` and then the workspace-root `.env` as a fallback; operating-system environment variables always take precedence. The existing contract-tooling `PRIVATE_KEY` is accepted only as a compatibility fallback and its address is derived locally; new API deployments should use `FRACTAL_AGENT_PRIVATE_KEY` and `FRACTAL_AGENT_ADDRESS`. Do not copy secret values into `.env.example`.

For the explicitly labeled, no-funds Sepolia executor exercise, use `testnet:chain-executor:sepolia` only with a fresh verified current-source candidate, `CHAIN_DEPLOYMENT_EXECUTOR_ENABLED=true`, and `TESTNET_CHAIN_EXECUTION_CONFIRMATION=I_UNDERSTAND_TESTNET_ISSUANCE`. It creates a testnet-only PostgreSQL offering and token; it does not mint tokens or move payout assets. Record the resulting public transaction and token address in that candidate’s evidence, not in the historical manifest.

## PostgreSQL platform kernel

Set `DATABASE_URL` to a dedicated development database and `POSTGRES_TEST_DATABASE_URL` to a separate disposable database (its name must include `test` or `ci`), then run:

```sh
pnpm --filter @fractal/api db:postgres:migrate
pnpm --filter @fractal/api db:postgres:status
pnpm --filter @fractal/api db:postgres:migrate -- --verify
POSTGRES_TEST_DATABASE_URL=postgresql:///fractal_platform_test pnpm --filter @fractal/api test:postgres
```

The migrations establish the first shared primitives: idempotency records, signed-provider inbox records, transactional outbox events, and an append-only audit chain. Do not edit an applied migration; create the next numbered migration instead.

### Initial administrator bootstrap and break-glass recovery

Administrator bootstrap and recovery are deliberately unavailable over HTTP. Run them as short-lived, access-logged operations jobs against a schema that is already fully migrated. The command refuses to apply migrations itself and never prints member email addresses, legal names, authorization keys, password links, or bearer tokens.

Initial bootstrap is permitted exactly once and creates a cohort of three to five administrators. It refuses to run if the immutable bootstrap seal exists **or if any current or historical administrator role assignment exists**. Every cohort member is created without a password or verified email and receives an `administrator_activation` delivery through the normal PostgreSQL-leased email worker. Each member must control their mailbox, create a password, sign in, and enroll MFA independently.

Inject these variables only into the bootstrap job, remove them immediately afterward, and retain the non-secret JSON output with the deployment evidence:

```sh
ADMIN_OPERATIONS_ACTOR_ID=approved-bootstrap-operator \
ADMIN_BOOTSTRAP_COHORT_JSON='[{"email":"...","legalName":"..."},{"email":"...","legalName":"..."},{"email":"...","legalName":"..."}]' \
pnpm --filter @fractal/api admin:operations -- bootstrap --confirm-initial-administrator-bootstrap
```

Break-glass recovery is restricted to an identity with historical administrator authority. The request lasts 30 minutes. The approver must use a different operator identifier and a different independently controlled authorization key. Approval restores exactly the administrator role, invalidates password and email verification, revokes native and mapped legacy sessions, removes step-up grants, destroys the active TOTP secret and recovery codes, cancels pending ordinary access changes, terminates older authentication deliveries, and queues a fresh one-time administrator activation. Recovery never preserves an existing credential.

Request job:

```sh
ADMIN_OPERATIONS_ACTOR_ID=approved-request-operator \
ADMIN_BREAK_GLASS_REQUEST_KEY='<independently supplied secret of at least 32 bytes>' \
ADMIN_RECOVERY_REQUEST_JSON='{"targetEmail":"...","incidentReference":"INC-...","reason":"..."}' \
pnpm --filter @fractal/api admin:operations -- request-recovery
```

Approval job, executed by the independent approver before expiry:

```sh
ADMIN_OPERATIONS_ACTOR_ID=approved-approval-operator \
ADMIN_BREAK_GLASS_APPROVAL_KEY='<different independently supplied secret of at least 32 bytes>' \
pnpm --filter @fractal/api admin:operations -- approve-recovery --request-id '<request UUID>'
```

Read aggregate-only ceremony state with `pnpm --filter @fractal/api admin:operations -- status`. Before closing the incident, verify that the activation delivery was accepted by the configured provider, the recovered administrator enrolled a new authenticator, all prior sessions remain revoked, the incident/audit records are preserved, and the one-shot job no longer has any bootstrap/recovery variables mounted. A database operator must not bypass these commands with direct role or credential updates; doing so produces an unsupported state without the required audit, outbox, session, MFA, and email effects.

`pnpm db:identity:backfill` is an explicit, idempotent migration aid—not a live synchronization path. It requires `IDENTITY_BACKFILL_CONFIRM=COPY_MONGO_IDENTITIES` and imports password hashes only. The controlled bridge uses `AUTH_IDENTITY_AUTHORITY=mongo`; the native mode uses `AUTH_IDENTITY_AUTHORITY=postgres` and owns registration, credentials, email verification, reset tokens, request authorization, and sessions in PostgreSQL. Production rejects the bridge mode. Follow the freeze/reconciliation/rollback steps in [the identity cutover runbook](../../docs-and-mds/IDENTITY_CUTOVER_RUNBOOK.md) before changing the authority in a deployed environment.

`pnpm db:identity:verify` is the read-only reconciliation gate. It emits a non-PII JSON report for every legacy identity's normalized email, legal name, status, credential-hash equality, email-verification state, credential-invalidation timestamp, exactly-one global role, and active-session binding. It intentionally excludes native PostgreSQL identities from the legacy snapshot comparison. A zero-mismatch report is necessary evidence for a cutover; it is not an authorization to make one.

Run `pnpm db:identity:verify` after each controlled import. It compares source and destination counts for identities, credential-hash presence, verified emails, and global role assignments without printing personal data.

New PostgreSQL tenant-owned domains must use the organization scope boundary in `src/platform/tenant-access.ts`; see `docs-and-mds/architecture/ADR-0004-tenant-isolation-boundary.md`. Do not add optional organization filters or global-role bypasses.

The PostgreSQL organization-invitation service keeps tokens HMAC-hashed and accepts an invitation into a membership atomically. It is deliberately not exposed by the legacy MongoDB API until identity authority has been cut over; doing so earlier would create two authorities for the same membership fact.

`POSTGRES_REQUIRED=false` keeps Postgres optional only for local work on legacy MongoDB routes. Production must set it to `true`; the API refuses to start otherwise because authentication sessions are PostgreSQL-backed.

`REDIS_URL` is also required in production. It backs distributed rate limits, the worker lease, and cross-instance live delivery. Live notification/chat pushes are best-effort hints only; their persisted records remain authoritative and are re-fetched after reconnecting.

Paystack adapter failures are normalized at the API boundary: `PAYMENT_PROVIDER_REJECTED` means the provider rejected request details (`422`), while `PAYMENT_PROVIDER_UNAVAILABLE` means no payment action completed and the caller should retry later (`503`). Provider diagnostic text is never returned to browsers.

The production worker does not start legacy MongoDB polling automations. PostgreSQL-backed jobs remain independently configured; no retired legacy authority is allowed to mutate production state behind the API capability boundary.

Identity sessions use a 15-minute access token and a rotating, browser-bound refresh token stored only as an HMAC in PostgreSQL. Refresh-token reuse revokes the entire session family. Password resets use the same 12-character / uppercase / numeric policy as registration and revoke every active server-side session before the new password is stored. New accounts are limited to email verification and logout until their six-digit verification code is redeemed.

Access-token signing supports key rotation. Leave `JWT_ACTIVE_KEY_ID=primary` for the existing secret, or configure a new active ID and its secret in `JWT_KEY_RING_JSON`; retain old key IDs only until all 15-minute access tokens signed by them have expired. Tokens without a `kid` are legacy tokens and verify only against `JWT_SECRET`.

The PostgreSQL identity target includes encrypted, replay-protected TOTP factors. Set `MFA_TOTP_ENABLED=true` only with separate 64-character hexadecimal `MFA_TOTP_ENCRYPTION_KEY` and `MFA_RECOVERY_CODE_PEPPER` values and only once identity authority has been cut over; factor enrollment is not exposed through the legacy MongoDB auth flow. Confirmation returns one-time recovery codes once. A recovery code can only replace the authenticator on the current server-backed session, revokes other sessions and prior step-up grants, and still requires confirmation of the new authenticator before a sensitive action can proceed.

Verified users can inspect `GET /v1/auth/sessions`, revoke only their own session through `POST /v1/auth/sessions/:id/revoke`, and read worker-projected security activity through `GET /v1/auth/security-events`. Session changes commit an immutable audit event and a transactional outbox event together; the worker idempotently projects the latter into the security-notification read model. MFA and step-up authorization remain required before privileged production operations.

## Checks

```sh
pnpm --filter @fractal/api lint
pnpm --filter @fractal/api test
pnpm --filter @fractal/api test:integration
pnpm --filter @fractal/api test:postgres
pnpm --filter @fractal/api check:openapi-contract
```

The integration suite needs MongoDB and Redis. The PostgreSQL suite needs `POSTGRES_TEST_DATABASE_URL`; CI provisions this separate disposable database.
# fractal_backend
