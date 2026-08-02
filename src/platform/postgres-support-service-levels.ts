import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

type DueObligation = {
  obligation_id: string;
  case_id: string;
  case_reference: string;
  event_type: "acknowledgement_breached" | "escalated" | "resolution_breached";
  due_at: Date;
};

function failureDetail(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown support service sweep failure").slice(0, 1_000);
}

async function dueObligations(now: Date, limit: number): Promise<DueObligation[]> {
  const result = await requirePostgres().query<DueObligation>(
    `WITH candidates AS (
       SELECT obligation.id AS obligation_id, obligation.case_id, support_case.reference AS case_reference,
              deadline.event_type, deadline.due_at
         FROM fractal.support_case_service_obligations obligation
         JOIN fractal.support_cases support_case ON support_case.id = obligation.case_id
         CROSS JOIN LATERAL (VALUES
           ('acknowledgement_breached'::text, obligation.acknowledgement_due_at),
           ('escalated'::text, obligation.escalation_due_at),
           ('resolution_breached'::text, obligation.resolution_due_at)
         ) deadline(event_type, due_at)
        WHERE deadline.due_at <= $1
          AND NOT EXISTS (
            SELECT 1 FROM fractal.support_case_service_events terminal
             WHERE terminal.obligation_id = obligation.id
               AND terminal.event_type = CASE deadline.event_type
                 WHEN 'acknowledgement_breached' THEN 'acknowledgement_met'
                 ELSE 'resolution_met'
               END
          )
          AND NOT EXISTS (
            SELECT 1 FROM fractal.support_case_service_events existing
             WHERE existing.obligation_id = obligation.id AND existing.event_type = deadline.event_type
          )
        ORDER BY deadline.due_at, obligation.id, deadline.event_type
        LIMIT $2
     ) SELECT * FROM candidates`,
    [now, Math.max(1, Math.min(limit, 500))],
  );
  return result.rows;
}

async function recordDeadlineEvent(candidate: DueObligation, now: Date): Promise<boolean> {
  return withPostgresTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fractal.support_case_service_events
         (id,obligation_id,event_type,actor_type,actor_identity_id,due_at,occurred_at,lateness_ms,evidence)
       VALUES ($1,$2,$3,'system',NULL,$4,$5,$6,$7)
       ON CONFLICT (obligation_id,event_type) DO NOTHING
       RETURNING id`,
      [randomUUID(), candidate.obligation_id, candidate.event_type, candidate.due_at, now,
        Math.max(0, now.getTime() - candidate.due_at.getTime()), { detector: "support_service_sweep_v1" }],
    );
    if (!inserted.rows[0]) return false;
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `support-case:${candidate.case_id}`,
      actorType: "system",
      action: `support.service.${candidate.event_type}`,
      entityType: "support_case_service_obligation",
      entityId: candidate.obligation_id,
      reason: "The governed support service deadline was reached without its terminal event.",
      payload: { caseReference: candidate.case_reference, dueAt: candidate.due_at.toISOString(), detectedAt: now.toISOString() },
    });
    await appendOutboxEvent(client, {
      aggregateType: "support_case_service_obligation",
      aggregateId: candidate.obligation_id,
      eventType: `support.service.${candidate.event_type}`,
      payload: { caseId: candidate.case_id, caseReference: candidate.case_reference, dueAt: candidate.due_at.toISOString(), auditEventId: audit.id },
    });
    return true;
  });
}

export async function sweepSupportCaseServiceDeadlines(input: { workerId: string; now?: Date; limit?: number }) {
  const startedAt = new Date();
  const now = input.now ?? startedAt;
  const counts = { acknowledgementBreaches: 0, escalations: 0, resolutionBreaches: 0 };
  try {
    const candidates = await dueObligations(now, input.limit ?? 100);
    for (const candidate of candidates) {
      if (!(await recordDeadlineEvent(candidate, now))) continue;
      if (candidate.event_type === "acknowledgement_breached") counts.acknowledgementBreaches += 1;
      else if (candidate.event_type === "escalated") counts.escalations += 1;
      else counts.resolutionBreaches += 1;
    }
    await requirePostgres().query(
      `INSERT INTO fractal.support_case_service_sweeps
         (id,worker_id,outcome,started_at,completed_at,acknowledgement_breaches,escalations,resolution_breaches)
       VALUES ($1,$2,'completed',$3,$4,$5,$6,$7)`,
      [randomUUID(), input.workerId, startedAt, new Date(), counts.acknowledgementBreaches, counts.escalations, counts.resolutionBreaches],
    );
    return counts;
  } catch (error) {
    await requirePostgres().query(
      `INSERT INTO fractal.support_case_service_sweeps
         (id,worker_id,outcome,started_at,completed_at,failure_code,failure_detail)
       VALUES ($1,$2,'failed',$3,$4,'support_service_sweep_failed',$5)`,
      [randomUUID(), input.workerId, startedAt, new Date(), failureDetail(error)],
    ).catch(() => undefined);
    throw error;
  }
}
