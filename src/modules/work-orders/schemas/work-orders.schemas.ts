import { z } from "zod";
import { riskFlagTaxonomy, stages, workOrderStatuses } from "../../../utils/constants.js";

export const taskIdParamsSchema = z.object({
  id: z.string(),
});

export const workOrderIdParamsSchema = z.object({
  id: z.string(),
});

export const assignTaskWorkOrderSchema = z.object({
  professionalId: z.string(),
  assigneeUserId: z.string(),
  instructions: z.string().trim().min(2).max(5000),
  dueAt: z.string().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

export const listWorkOrdersQuerySchema = z.object({
  status: z.enum(workOrderStatuses).optional(),
  applicationId: z.string().optional(),
  taskId: z.string().optional(),
  assigneeUserId: z.string().optional(),
  professionalId: z.string().optional(),
  dueBefore: z.string().optional(),
  category: z.enum(["legal", "valuation", "inspection", "trustee", "servicing"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// PR-03: COI declaration at acceptance
export const acceptWorkOrderSchema = z.object({
  coiDeclaredClear: z.boolean(),
  coiNotes: z.string().trim().max(2000).optional(),
});
export type AcceptWorkOrderPayload = z.infer<typeof acceptWorkOrderSchema>;

export const declineWorkOrderSchema = z.object({
  reason: z.string().trim().min(2).max(2000),
});

export const requestWorkOrderInfoSchema = z.object({
  title: z.string().trim().min(2).max(200),
  message: z.string().trim().min(2).max(2000),
  required: z.boolean().default(true),
  stageTag: z.enum(stages).optional(),
  dueAt: z.string().optional(),
});

export const submitWorkOrderOutcomeSchema = z.object({
  recommendation: z.enum(["approved", "declined", "needs_info"]),
  summary: z.string().trim().min(2).max(5000),
  // PR-18: Structured risk flag taxonomy
  riskFlags: z.array(z.enum(riskFlagTaxonomy)).max(10).optional(),
  riskFlagNotes: z.string().trim().max(2000).optional(),
  deliverables: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(120),
        filename: z.string().trim().min(1).max(300),
        mimeType: z.string().trim().min(2).max(150).optional(),
        storageKey: z.string().trim().min(2).max(1000).optional(),
        contentBase64: z.string().trim().min(8).optional(),
      }),
    )
    .max(50)
    .optional(),
});

// PR-09: Work order withdrawal schema
export const withdrawWorkOrderSchema = z.object({
  reason: z.string().trim().min(50, "Withdrawal reason must be at least 50 characters").max(5000),
});

export const reviewWorkOrderSchema = z.object({
  decision: z.enum(["accepted", "rejected", "needs_changes"]),
  notes: z.string().trim().min(2).max(5000),
});

export const escalateOverdueWorkOrdersSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export const scoreWorkOrderSchema = z.object({
  score: z.number().int().min(1).max(5),
  review: z.string().trim().min(2).max(2000).optional(),
});

export type AssignTaskWorkOrderPayload = z.infer<typeof assignTaskWorkOrderSchema>;
export type ListWorkOrdersQuery = z.infer<typeof listWorkOrdersQuerySchema>;
export type DeclineWorkOrderPayload = z.infer<typeof declineWorkOrderSchema>;
export type RequestWorkOrderInfoPayload = z.infer<typeof requestWorkOrderInfoSchema>;
export type SubmitWorkOrderOutcomePayload = z.infer<
  typeof submitWorkOrderOutcomeSchema
>;
export type ReviewWorkOrderPayload = z.infer<typeof reviewWorkOrderSchema>;
export type EscalateOverdueWorkOrdersPayload = z.infer<
  typeof escalateOverdueWorkOrdersSchema
>;
export type ScoreWorkOrderPayload = z.infer<typeof scoreWorkOrderSchema>;
export type WithdrawWorkOrderPayload = z.infer<typeof withdrawWorkOrderSchema>;

// PR-15: Dedicated deliverable upload (PR-40: file type and size enforcement)
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-outlook",
  "image/vnd.dwg",
] as const;

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_SIZE_BYTES * (4 / 3)) + 4; // base64 overhead

export const uploadDeliverableSchema = z.object({
  filename: z.string().trim().min(1).max(300).refine(
    (n) => !/\.(exe|bat|sh|cmd|ps1|js|py|rb|php|jar|zip|rar|tar|gz)$/i.test(n),
    "File type not allowed",
  ),
  contentBase64: z.string().trim().min(8).max(MAX_BASE64_LENGTH, "File exceeds 50MB limit"),
  mimeType: z.string().trim().max(150).optional(),
});
export type UploadDeliverablePayload = z.infer<typeof uploadDeliverableSchema>;

// PR-47: Bulk task assignment
export const bulkAssignTasksSchema = z.object({
  assignments: z.array(z.object({
    taskId: z.string(),
    professionalId: z.string(),
    assigneeUserId: z.string(),
    instructions: z.string().trim().min(2).max(5000),
    dueAt: z.string().optional(),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
  })).min(1).max(50),
});
export type BulkAssignTasksPayload = z.infer<typeof bulkAssignTasksSchema>;
