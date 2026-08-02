import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import { requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

const contentSchema = z.object({
  title: z.string().trim().min(3).max(120),
  eyebrow: z.string().trim().min(3).max(120),
  lead: z.string().trim().min(20).max(2_000),
  readingTime: z.string().trim().min(3).max(40).optional(),
  keyPoints: z.array(z.string().trim().min(10).max(1_000)).min(1).max(12),
  sections: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().trim().min(3).max(200),
    paragraphs: z.array(z.string().trim().min(10).max(8_000)).min(1).max(30),
    bullets: z.array(z.string().trim().min(5).max(2_000)).max(40).optional(),
  })).min(1).max(40),
}).strict().superRefine((content, context) => {
  const ids = new Set<string>();
  for (const [index, section] of content.sections.entries()) {
    if (ids.has(section.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "id"], message: "Section IDs must be unique." });
    ids.add(section.id);
  }
});

export type PlatformLegalContent = z.infer<typeof contentSchema>;
export type LegalAcceptanceReference = { documentKey: string; versionId: string; contentSha256: string };

export class PlatformContentError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input" | "invalid_state" | "stale_version" | "unavailable") {
    super(message); this.name = "PlatformContentError";
  }
}

interface DefinitionRow {
  document_key: string; slug: string; title: string; document_type: string; jurisdiction_code: string;
  audience: string; required_at_registration: boolean; status: "active" | "retired";
}
interface VersionRow {
  id: string; document_key: string; semantic_version: string; state_version: number;
  status: "validation_failed" | "pending" | "rejected" | "scheduled" | "published" | "superseded" | "failed";
  content_sha256: string; validation_output: Record<string, unknown>; change_summary: string; reacceptance_required: boolean;
  proposed_by_identity_id: string; proposer_legal_name: string; proposer_email: string;
  reviewed_by_identity_id: string | null; reviewer_legal_name: string | null; reviewer_email: string | null;
  decision_reason: string | null; effective_at: Date; proposed_at: Date; reviewed_at: Date | null;
  published_at: Date | null; superseded_at: Date | null; supersedes_version_id: string | null;
  failure_code: string | null; failure_detail: string | null;
}
interface VersionContentRow extends VersionRow { content: PlatformLegalContent; content_bytes: Buffer }

const versionSelect = `SELECT version.*, proposer.legal_name AS proposer_legal_name, proposer.email AS proposer_email,
  reviewer.legal_name AS reviewer_legal_name, reviewer.email AS reviewer_email
  FROM fractal.platform_content_versions version
  JOIN fractal.identities proposer ON proposer.id = version.proposed_by_identity_id
  LEFT JOIN fractal.identities reviewer ON reviewer.id = version.reviewed_by_identity_id`;

function identity(id: string, legalName: string, email: string) { return { id, legalName, email }; }
function mapVersion(row: VersionRow) {
  return {
    id: row.id, documentKey: row.document_key, semanticVersion: row.semantic_version, stateVersion: row.state_version,
    status: row.status, contentSha256: row.content_sha256, validationOutput: row.validation_output,
    changeSummary: row.change_summary, reacceptanceRequired: row.reacceptance_required,
    proposedBy: identity(row.proposed_by_identity_id, row.proposer_legal_name, row.proposer_email),
    reviewedBy: row.reviewed_by_identity_id && row.reviewer_legal_name && row.reviewer_email
      ? identity(row.reviewed_by_identity_id, row.reviewer_legal_name, row.reviewer_email) : null,
    decisionReason: row.decision_reason, effectiveAt: row.effective_at.toISOString(), proposedAt: row.proposed_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null, publishedAt: row.published_at?.toISOString() ?? null,
    supersededAt: row.superseded_at?.toISOString() ?? null, supersedesVersionId: row.supersedes_version_id,
    failureCode: row.failure_code, failureDetail: row.failure_detail,
  };
}

function boundedReason(value: string, label: string) {
  const result = value.trim();
  if (result.length < 10 || result.length > 2_000) throw new PlatformContentError(`${label} must contain 10 to 2000 characters.`, "invalid_input");
  return result;
}

async function requireDefinition(client: PoolClient, key: string, lock = false): Promise<DefinitionRow> {
  const result = await client.query<DefinitionRow>(`SELECT document_key, slug, title, document_type, jurisdiction_code, audience, required_at_registration, status
    FROM fractal.platform_content_definitions WHERE document_key = $1${lock ? " FOR UPDATE" : ""}`, [key]);
  const definition = result.rows[0];
  if (!definition) throw new PlatformContentError("Legal document definition not found.", "not_found");
  if (definition.status !== "active") throw new PlatformContentError("This legal document definition is retired.", "invalid_state");
  return definition;
}

async function readVersion(client: PoolClient, id: string, lock = false): Promise<VersionContentRow> {
  const result = await client.query<VersionContentRow>(`${versionSelect} WHERE version.id = $1${lock ? " FOR UPDATE OF version" : ""}`, [id]);
  const row = result.rows[0];
  if (!row) throw new PlatformContentError("Legal document version not found.", "not_found");
  return row;
}

async function projection(client: PoolClient, key: string, lock = false) {
  const result = await client.query<{ published_version_id: string; projection_version: number }>(
    `SELECT published_version_id, projection_version FROM fractal.platform_content_publications WHERE document_key = $1${lock ? " FOR UPDATE" : ""}`, [key]);
  return result.rows[0] ?? null;
}

async function event(client: PoolClient, input: { versionId: string; eventType: string; fromStatus: string | null; toStatus: string; actorType: "user" | "system"; actorIdentityId?: string; reason: string; evidence: Record<string, unknown> }) {
  await client.query(`INSERT INTO fractal.platform_content_events
    (id, content_version_id, sequence, event_type, from_status, to_status, actor_type, actor_identity_id, reason, evidence)
    SELECT $1,$2,COALESCE(max(sequence),0)+1,$3,$4,$5,$6,$7,$8,$9 FROM fractal.platform_content_events WHERE content_version_id=$2`,
  [randomUUID(), input.versionId, input.eventType, input.fromStatus, input.toStatus, input.actorType, input.actorIdentityId ?? null, input.reason, input.evidence]);
}

export async function listPlatformContent(input: { actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "platform_content_manage");
    const definitions = await client.query<DefinitionRow & { projection_version: number | null; published_version_id: string | null }>(
      `SELECT definition.*, publication.projection_version, publication.published_version_id
       FROM fractal.platform_content_definitions definition LEFT JOIN fractal.platform_content_publications publication USING (document_key)
       ORDER BY definition.required_at_registration DESC, definition.document_key`);
    const versions = await client.query<VersionRow>(`${versionSelect} ORDER BY version.proposed_at DESC LIMIT 500`);
    const mapped = versions.rows.map(mapVersion);
    return { definitions: definitions.rows.map((row) => ({
      key: row.document_key, slug: row.slug, title: row.title, documentType: row.document_type,
      jurisdictionCode: row.jurisdiction_code, audience: row.audience, requiredAtRegistration: row.required_at_registration,
      status: row.status, projectionVersion: row.projection_version, publishedVersionId: row.published_version_id,
      versions: mapped.filter((version) => version.documentKey === row.document_key),
    })) };
  });
}

export async function getPlatformContentVersion(input: { actorIdentityId: string; versionId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "platform_content_manage");
    const row = await readVersion(client, input.versionId);
    const events = await client.query<{ id: string; sequence: number; event_type: string; from_status: string | null; to_status: string; actor_type: string; actor_identity_id: string | null; actor_legal_name: string | null; reason: string; evidence: Record<string, unknown>; occurred_at: Date }>(
      `SELECT event.*, actor.legal_name AS actor_legal_name FROM fractal.platform_content_events event
       LEFT JOIN fractal.identities actor ON actor.id=event.actor_identity_id WHERE event.content_version_id=$1 ORDER BY event.sequence`, [row.id]);
    return { version: { ...mapVersion(row), content: row.content }, events: events.rows.map((entry) => ({
      id: entry.id, sequence: entry.sequence, eventType: entry.event_type, fromStatus: entry.from_status, toStatus: entry.to_status,
      actorType: entry.actor_type, actor: entry.actor_identity_id ? { id: entry.actor_identity_id, legalName: entry.actor_legal_name } : null,
      reason: entry.reason, evidence: entry.evidence, occurredAt: entry.occurred_at.toISOString(),
    })) };
  });
}

export async function proposePlatformContentVersion(input: { actorIdentityId: string; documentKey: string; semanticVersion: string; content: unknown; reacceptanceRequired: boolean; expectedProjectionVersion: number | null; effectiveAt: Date; changeSummary: string; commandKey: string }) {
  const changeSummary = boundedReason(input.changeSummary, "Change summary");
  if (!/^\d+\.\d+\.\d+$/.test(input.semanticVersion)) throw new PlatformContentError("Semantic version must use major.minor.patch.", "invalid_input");
  const result = await runPostgresIdempotentCommand<{ version: ReturnType<typeof mapVersion> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `platform-content:${input.actorIdentityId}`, route: `POST:/v1/admin/platform-content/${input.documentKey}/versions`,
    commandKey: input.commandKey, payload: { ...input, actorIdentityId: undefined, commandKey: undefined, effectiveAt: input.effectiveAt.toISOString(), changeSummary },
    expiresAt: new Date(Date.now() + 86_400_000), execute: async (client) => {
      await requireAdministratorCapability(client, input.actorIdentityId, "platform_content_manage");
      await requireDefinition(client, input.documentKey, true);
      const current = await projection(client, input.documentKey, true);
      if ((current?.projection_version ?? null) !== input.expectedProjectionVersion) throw new PlatformContentError("Published legal document projection changed; reload before proposing.", "stale_version");
      if (Number.isNaN(input.effectiveAt.getTime()) || input.effectiveAt < new Date(Date.now() - 300_000) || input.effectiveAt > new Date(Date.now() + 366 * 86_400_000)) throw new PlatformContentError("Effective time is outside the permitted boundary.", "invalid_input");
      const parsed = contentSchema.safeParse(input.content);
      let content: unknown = parsed.success ? parsed.data : { invalidSubmission: input.content ?? null };
      let bytes: Buffer;
      try { bytes = Buffer.from(stableJsonStringify(content), "utf8"); } catch { bytes = Buffer.from("{}", "utf8"); }
      const errors = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".") || "content"}: ${issue.message}`);
      if (bytes.length > 524_288) {
        const submittedSha256 = createHash("sha256").update(bytes).digest("hex");
        const submittedBytes = bytes.length;
        errors.push("Canonical content exceeds 512 KiB.");
        content = { rejectedSubmission: { reason: "canonical_content_too_large", submittedSha256, submittedBytes } };
        bytes = Buffer.from(stableJsonStringify(content), "utf8");
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      const status = errors.length ? "validation_failed" : "pending";
      const id = randomUUID();
      await client.query(`INSERT INTO fractal.platform_content_versions
        (id,document_key,semantic_version,state_version,status,content,content_bytes,content_sha256,validation_output,change_summary,reacceptance_required,proposed_by_identity_id,effective_at,supersedes_version_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, input.documentKey, input.semanticVersion, errors.length ? 2 : 1, status, content, bytes, hash,
        { valid: !errors.length, errors, checkedAt: new Date().toISOString() }, changeSummary, input.reacceptanceRequired,
        input.actorIdentityId, input.effectiveAt, current?.published_version_id ?? null]);
      await event(client, { versionId: id, eventType: "proposed", fromStatus: null, toStatus: "pending", actorType: "user", actorIdentityId: input.actorIdentityId, reason: changeSummary, evidence: { contentSha256: hash, semanticVersion: input.semanticVersion, expectedProjectionVersion: input.expectedProjectionVersion } });
      if (errors.length) await event(client, { versionId: id, eventType: "validation_failed", fromStatus: "pending", toStatus: "validation_failed", actorType: "user", actorIdentityId: input.actorIdentityId, reason: "The immutable legal-content proposal failed structural validation.", evidence: { errors } });
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `platform-content:${input.documentKey}`, actorId: input.actorIdentityId, actorType: "user", action: errors.length ? "platform.content.validation_failed" : "platform.content.proposed", entityType: "platform_content_version", entityId: id, reason: changeSummary, payload: { semanticVersion: input.semanticVersion, contentSha256: hash, status, reacceptanceRequired: input.reacceptanceRequired } });
      await appendOutboxEvent(client, { aggregateType: "platform_content_version", aggregateId: id, eventType: errors.length ? "platform.content.validation_failed" : "platform.content.proposed", payload: { documentKey: input.documentKey, semanticVersion: input.semanticVersion, contentSha256: hash, auditEventId: audit.id } });
      return { status: 201, body: { version: mapVersion(await readVersion(client, id)) } };
    },
  });
  return { version: result.body.version, replayed: result.replayed };
}

export async function decidePlatformContentVersion(input: { actorIdentityId: string; versionId: string; action: "approve" | "reject"; expectedStateVersion: number; decisionReason: string; commandKey: string }) {
  const decisionReason = boundedReason(input.decisionReason, "Decision reason");
  const result = await runPostgresIdempotentCommand<{ version: ReturnType<typeof mapVersion> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `platform-content:${input.actorIdentityId}`, route: `POST:/v1/admin/platform-content/versions/${input.versionId}/decision`, commandKey: input.commandKey,
    payload: { versionId: input.versionId, action: input.action, expectedStateVersion: input.expectedStateVersion, decisionReason }, expiresAt: new Date(Date.now() + 86_400_000),
    execute: async (client) => {
      await requireAdministratorCapability(client, input.actorIdentityId, "platform_content_manage");
      const version = await readVersion(client, input.versionId, true);
      if (version.status !== "pending") throw new PlatformContentError("Only a pending legal document can be reviewed.", "invalid_state");
      if (version.state_version !== input.expectedStateVersion) throw new PlatformContentError("Legal document state changed before this decision.", "stale_version");
      if (version.proposed_by_identity_id === input.actorIdentityId) throw new PlatformContentError("The proposer cannot review their own legal document.", "forbidden");
      const current = await projection(client, version.document_key, true);
      if ((current?.published_version_id ?? null) !== version.supersedes_version_id) throw new PlatformContentError("The published legal document changed after proposal.", "stale_version");
      const status = input.action === "approve" ? "scheduled" : "rejected";
      await client.query(`UPDATE fractal.platform_content_versions SET status=$2,state_version=state_version+1,reviewed_by_identity_id=$3,decision_reason=$4,reviewed_at=now() WHERE id=$1`, [version.id, status, input.actorIdentityId, decisionReason]);
      await event(client, { versionId: version.id, eventType: input.action === "approve" ? "approved" : "rejected", fromStatus: "pending", toStatus: status, actorType: "user", actorIdentityId: input.actorIdentityId, reason: decisionReason, evidence: { effectiveAt: version.effective_at.toISOString(), semanticVersion: version.semantic_version } });
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `platform-content:${version.document_key}`, actorId: input.actorIdentityId, actorType: "user", action: `platform.content.${input.action === "approve" ? "approved" : "rejected"}`, entityType: "platform_content_version", entityId: version.id, reason: decisionReason, payload: { semanticVersion: version.semantic_version, contentSha256: version.content_sha256 } });
      await appendOutboxEvent(client, { aggregateType: "platform_content_version", aggregateId: version.id, eventType: `platform.content.${input.action === "approve" ? "approved" : "rejected"}`, payload: { documentKey: version.document_key, semanticVersion: version.semantic_version, auditEventId: audit.id } });
      return { status: 200, body: { version: mapVersion(await readVersion(client, version.id)) } };
    },
  });
  return { version: result.body.version, replayed: result.replayed };
}

async function publishVersion(client: PoolClient, id: string, now: Date) {
  const version = await readVersion(client, id, true);
  if (version.status !== "scheduled") return "already_terminal" as const;
  const current = await projection(client, version.document_key, true);
  if ((current?.published_version_id ?? null) !== version.supersedes_version_id) {
    const detail = "The published legal document changed after approval; publication was refused.";
    await client.query("UPDATE fractal.platform_content_versions SET status='failed',state_version=state_version+1,failure_code='stale_publication',failure_detail=$2 WHERE id=$1", [version.id, detail]);
    await event(client, { versionId: version.id, eventType: "publication_failed", fromStatus: "scheduled", toStatus: "failed", actorType: "system", reason: detail, evidence: { expectedPublishedVersionId: version.supersedes_version_id, actualPublishedVersionId: current?.published_version_id ?? null } });
    return "failed" as const;
  }
  if (current) {
    await client.query("UPDATE fractal.platform_content_versions SET status='superseded',state_version=state_version+1,superseded_at=$2 WHERE id=$1", [current.published_version_id, now]);
    await event(client, { versionId: current.published_version_id, eventType: "superseded", fromStatus: "published", toStatus: "superseded", actorType: "system", reason: `Superseded by approved ${version.semantic_version}.`, evidence: { successorVersionId: version.id } });
  }
  await client.query("UPDATE fractal.platform_content_versions SET status='published',state_version=state_version+1,published_at=$2 WHERE id=$1", [version.id, now]);
  const projectionVersion = (current?.projection_version ?? 0) + 1;
  await client.query(`INSERT INTO fractal.platform_content_publications (document_key,published_version_id,projection_version,bound_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (document_key) DO UPDATE SET published_version_id=EXCLUDED.published_version_id,projection_version=EXCLUDED.projection_version,bound_at=EXCLUDED.bound_at`, [version.document_key, version.id, projectionVersion, now]);
  await event(client, { versionId: version.id, eventType: "published", fromStatus: "scheduled", toStatus: "published", actorType: "system", reason: "Approved legal content reached its effective publication time.", evidence: { projectionVersion, contentSha256: version.content_sha256 } });
  const audit = await appendPostgresAuditEvent(client, { scopeKey: `platform-content:${version.document_key}`, actorType: "system", action: "platform.content.published", entityType: "platform_content_version", entityId: version.id, reason: "Approved legal content reached its effective publication time.", payload: { semanticVersion: version.semantic_version, contentSha256: version.content_sha256, projectionVersion, reacceptanceRequired: version.reacceptance_required } });
  await appendOutboxEvent(client, { aggregateType: "platform_content_version", aggregateId: version.id, eventType: "platform.content.published", payload: { documentKey: version.document_key, semanticVersion: version.semantic_version, projectionVersion, reacceptanceRequired: version.reacceptance_required, auditEventId: audit.id } });
  return "published" as const;
}

export async function publishDuePlatformContent(now = new Date(), limit = 25) {
  const due = await requirePostgres().query<{ id: string }>("SELECT id FROM fractal.platform_content_versions WHERE status='scheduled' AND effective_at <= $1 ORDER BY effective_at,document_key LIMIT $2", [now, Math.max(1, Math.min(100, limit))]);
  const result = { published: 0, failed: 0, alreadyTerminal: 0 };
  for (const row of due.rows) {
    const outcome = await withPostgresTransaction((client) => publishVersion(client, row.id, now));
    if (outcome === "published") result.published++; else if (outcome === "failed") result.failed++; else result.alreadyTerminal++;
  }
  return result;
}

const publicSelect = `SELECT definition.document_key,definition.slug,definition.title,definition.document_type,definition.jurisdiction_code,definition.audience,
  definition.required_at_registration,publication.projection_version,version.id AS version_id,version.semantic_version,version.content,
  version.content_bytes,version.content_sha256,version.effective_at,version.published_at,version.reacceptance_required
  FROM fractal.platform_content_definitions definition JOIN fractal.platform_content_publications publication USING(document_key)
  JOIN fractal.platform_content_versions version ON version.id=publication.published_version_id
  WHERE definition.status='active' AND version.status='published' AND version.effective_at <= now()`;

interface PublicRow extends DefinitionRow { projection_version: number; version_id: string; semantic_version: string; content: PlatformLegalContent; content_bytes: Buffer; content_sha256: string; effective_at: Date; published_at: Date; reacceptance_required: boolean }
function mapPublic(row: PublicRow) { return { documentKey: row.document_key, slug: row.slug, title: row.title, documentType: row.document_type, jurisdictionCode: row.jurisdiction_code, audience: row.audience, requiredAtRegistration: row.required_at_registration, projectionVersion: row.projection_version, versionId: row.version_id, semanticVersion: row.semantic_version, contentSha256: row.content_sha256, effectiveAt: row.effective_at.toISOString(), publishedAt: row.published_at.toISOString(), reacceptanceRequired: row.reacceptance_required, content: row.content }; }

export async function listPublishedLegalDocuments() {
  const rows = await requirePostgres().query<PublicRow>(`${publicSelect} ORDER BY definition.required_at_registration DESC,definition.slug`);
  const required = await requirePostgres().query<{ count: string }>("SELECT count(*)::text AS count FROM fractal.platform_content_definitions WHERE status='active' AND required_at_registration");
  const availableRequired = rows.rows.filter((row) => row.required_at_registration).length;
  return { documents: rows.rows.map((row) => { const { content: _content, ...metadata } = mapPublic(row); return metadata; }), registrationDocumentsAvailable: availableRequired === Number(required.rows[0]?.count ?? 0) };
}

export async function readPublishedLegalDocument(slug: string) {
  const result = await requirePostgres().query<PublicRow>(`${publicSelect} AND definition.slug=$1`, [slug]);
  const row = result.rows[0];
  if (!row) throw new PlatformContentError("No approved legal document is currently published for this route.", "unavailable");
  return mapPublic(row);
}

export async function listPublishedLegalDocumentHistory(slug: string) {
  const result = await requirePostgres().query<PublicRow>(
    `SELECT definition.document_key,definition.slug,definition.title,definition.document_type,definition.jurisdiction_code,definition.audience,
            definition.required_at_registration,(published_event.evidence ->> 'projectionVersion')::integer AS projection_version,
            version.id AS version_id,version.semantic_version,version.content,version.content_bytes,version.content_sha256,
            version.effective_at,version.published_at,version.reacceptance_required
       FROM fractal.platform_content_definitions definition
       JOIN fractal.platform_content_versions version USING(document_key)
       JOIN fractal.platform_content_events published_event ON published_event.content_version_id=version.id AND published_event.event_type='published'
      WHERE definition.status='active' AND definition.slug=$1
        AND version.status IN ('published','superseded') AND version.published_at IS NOT NULL
      ORDER BY version.published_at DESC,version.id DESC`,
    [slug],
  );
  if (result.rows.length === 0) throw new PlatformContentError("No published legal-document history exists for this route.", "unavailable");
  return { documents: result.rows.map((row) => { const { content: _content, ...metadata } = mapPublic(row); return metadata; }) };
}

export async function readPublishedLegalDocumentBytes(slug: string, versionId: string) {
  const result = await requirePostgres().query<Pick<PublicRow, "slug" | "semantic_version" | "content_bytes" | "content_sha256">>(
    `SELECT definition.slug,version.semantic_version,version.content_bytes,version.content_sha256
       FROM fractal.platform_content_definitions definition
       JOIN fractal.platform_content_versions version USING(document_key)
      WHERE definition.status='active' AND definition.slug=$1 AND version.id=$2
        AND version.status IN ('published','superseded') AND version.published_at IS NOT NULL`,
    [slug, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new PlatformContentError("Published legal document evidence not found.", "not_found");
  return { bytes: row.content_bytes, filename: `${row.slug}-${row.semantic_version}.json`, contentSha256: row.content_sha256 };
}

function requestHash(value: string | undefined) { return value ? createHash("sha256").update(value).digest("hex") : null; }

export async function recordLegalAcceptancesInTransaction(client: PoolClient, input: { identityId: string; references: LegalAcceptanceReference[]; context: "registration" | "reacceptance"; affirmativeAction: "checkbox" | "review_and_accept"; ip?: string; userAgent?: string }) {
  const required = await client.query<PublicRow>(`${publicSelect} AND definition.required_at_registration ORDER BY definition.document_key`);
  const requiredCount = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM fractal.platform_content_definitions WHERE status='active' AND required_at_registration");
  if (required.rows.length !== Number(requiredCount.rows[0]?.count ?? 0)) throw new PlatformContentError("Registration legal documents are not currently available. No account or consent record was created.", "unavailable");
  const accepted = input.context === "reacceptance"
    ? await client.query<{ content_version_id: string }>("SELECT content_version_id FROM fractal.legal_document_acceptances WHERE identity_id=$1", [input.identityId])
    : { rows: [] as Array<{ content_version_id: string }> };
  const acceptedIds = new Set(accepted.rows.map((row) => row.content_version_id));
  const targets = input.context === "registration"
    ? required.rows
    : required.rows.filter((row) => row.reacceptance_required && !acceptedIds.has(row.version_id));
  const unique = new Map(input.references.map((reference) => [reference.documentKey, reference]));
  if (unique.size !== targets.length || input.references.length !== targets.length) throw new PlatformContentError("Accept the exact current Terms and Privacy versions before continuing.", "invalid_input");
  for (const document of targets) {
    const reference = unique.get(document.document_key);
    if (!reference || reference.versionId !== document.version_id || reference.contentSha256 !== document.content_sha256) throw new PlatformContentError("A required legal document changed before acceptance. Review the current version and try again.", "stale_version");
    await client.query(`INSERT INTO fractal.legal_document_acceptances
      (id,identity_id,content_version_id,document_key,semantic_version,content_sha256,acceptance_context,affirmative_action,ip_hash,user_agent_hash,evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (identity_id,content_version_id) DO NOTHING`,
    [randomUUID(), input.identityId, document.version_id, document.document_key, document.semantic_version, document.content_sha256,
      input.context, input.affirmativeAction, requestHash(input.ip), requestHash(input.userAgent),
      { projectionVersion: document.projection_version, slug: document.slug, acceptedContentSha256: document.content_sha256 }]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `identity:${input.identityId}`, actorId: input.identityId, actorType: "user", action: "legal_document.accepted", entityType: "platform_content_version", entityId: document.version_id, payload: { documentKey: document.document_key, semanticVersion: document.semantic_version, contentSha256: document.content_sha256, context: input.context, affirmativeAction: input.affirmativeAction } });
    await appendOutboxEvent(client, { aggregateType: "identity", aggregateId: input.identityId, eventType: "legal_document.accepted", payload: { documentKey: document.document_key, contentVersionId: document.version_id, contentSha256: document.content_sha256, auditEventId: audit.id } });
  }
}

export async function getLegalConsentStatus(identityId: string) {
  const current = await requirePostgres().query<PublicRow & { accepted_at: Date | null }>(
    `SELECT published.*, acceptance.accepted_at
       FROM (${publicSelect} AND definition.required_at_registration) published
       LEFT JOIN fractal.legal_document_acceptances acceptance
         ON acceptance.identity_id=$1 AND acceptance.content_version_id=published.version_id
      ORDER BY published.document_key`, [identityId]);
  const requiredCount = await requirePostgres().query<{ count: string }>("SELECT count(*)::text AS count FROM fractal.platform_content_definitions WHERE status='active' AND required_at_registration");
  const available = current.rows.length === Number(requiredCount.rows[0]?.count ?? 0);
  return { available, required: current.rows.filter((row) => !row.accepted_at && row.reacceptance_required).map((row) => ({ ...mapPublic(row), content: undefined })), accepted: current.rows.filter((row) => row.accepted_at).map((row) => ({ documentKey: row.document_key, versionId: row.version_id, contentSha256: row.content_sha256, acceptedAt: row.accepted_at!.toISOString() })) };
}

export async function recordLegalReacceptance(input: { identityId: string; references: LegalAcceptanceReference[]; ip?: string; userAgent?: string }) {
  return withPostgresTransaction(async (client) => recordLegalAcceptancesInTransaction(client, { ...input, context: "reacceptance", affirmativeAction: "review_and_accept" }));
}
