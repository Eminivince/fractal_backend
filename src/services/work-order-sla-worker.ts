import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { UserModel } from "../db/models.js";

interface LoggerLike {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface WorkOrderSlaWorkerHandle {
  stop: () => void;
  triggerNow: () => Promise<void>;
}

interface EscalationResponse {
  escalatedCount?: number;
}

async function resolveSchedulerActorUser() {
  const operator = await UserModel.findOne({
    role: "operator",
    status: "active",
  })
    .select("_id role businessId")
    .lean();
  if (operator) return operator;

  return UserModel.findOne({
    role: "admin",
    status: "active",
  })
    .select("_id role businessId")
    .lean();
}

export function startWorkOrderSlaWorker(
  app: FastifyInstance,
  log: LoggerLike,
): WorkOrderSlaWorkerHandle {
  if (!env.WORK_ORDER_SLA_ESCALATION_ENABLED) {
    log.info(
      "Work-order SLA worker disabled (WORK_ORDER_SLA_ESCALATION_ENABLED=false)",
    );
    return {
      stop: () => undefined,
      triggerNow: async () => undefined,
    };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const actor = await resolveSchedulerActorUser();
      if (!actor?._id || !actor.role) {
        log.warn(
          "Work-order SLA worker skipped: no active operator/admin user found",
        );
        return;
      }

      const token = (app as any).jwt.sign({
        userId: String(actor._id),
        role: actor.role,
        businessId: actor.businessId ? String(actor.businessId) : undefined,
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/work-orders/escalate-overdue",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          limit: env.WORK_ORDER_SLA_ESCALATION_BATCH_LIMIT,
        },
      });

      if (response.statusCode >= 400) {
        log.error(
          `Work-order SLA worker failed: status=${response.statusCode} body=${response.body.slice(0, 500)}`,
        );
        return;
      }

      let payload: EscalationResponse = {};
      try {
        payload = JSON.parse(response.body) as EscalationResponse;
      } catch {
        payload = {};
      }

      const escalated = Number(payload.escalatedCount ?? 0);
      if (escalated > 0) {
        log.warn(`Work-order SLA worker escalated overdue work-orders=${escalated}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown SLA worker error";
      log.error(`Work-order SLA worker error: ${message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, env.WORK_ORDER_SLA_ESCALATION_INTERVAL_MS);

  log.info(
    `Work-order SLA worker started (interval=${env.WORK_ORDER_SLA_ESCALATION_INTERVAL_MS}ms, limit=${env.WORK_ORDER_SLA_ESCALATION_BATCH_LIMIT})`,
  );

  return {
    stop: () => clearInterval(timer),
    triggerNow: tick,
  };
}
