import { z } from "zod";
import { stages } from "../../../utils/constants.js";

export const intakeStageSchema = z.enum([
  "Intake",
  "Diligence",
  "Structuring",
  "Compliance",
]);

export const createAssetSchema = z.object({
  name: z.string().min(2),
  country: z.string().default("Nigeria"),
  state: z.string().min(2),
  city: z.string().min(2),
  addressLine: z.string().optional(),
  summary: z.string().min(2),
  // I-11: Legal title structure
  legalTitle: z
    .object({
      titleType: z
        .enum([
          "certificate_of_occupancy",
          "governors_consent",
          "deed_of_assignment",
          "statutory_right_of_occupancy",
          "survey_plan",
          "letter_of_allocation",
          "other",
        ])
        .optional(),
      titleHolder: z.string().optional(),
      titleHolderRelationship: z.enum(["issuer", "spv", "third_party"]).optional(),
      hasEncumbrances: z.boolean().default(false),
      encumbranceDetails: z.string().optional(),
      landUse: z
        .enum(["residential", "commercial", "industrial", "mixed_use", "agricultural", "other"])
        .optional(),
      titleDocumentRef: z.string().optional(),
    })
    .optional(),
  // I-12: Valuation
  valuation: z
    .object({
      amount: z.number().positive().optional(),
      currency: z.string().default("NGN"),
      valuationDate: z.string().optional(),
      validUntil: z.string().optional(),
      valuedBy: z.string().optional(),
      reportDocumentRef: z.string().optional(),
      methodology: z
        .enum(["comparable_sales", "income_capitalization", "cost_approach", "other"])
        .optional(),
    })
    .optional(),
});

export const createApplicationSchema = z.object({
  templateCode: z.enum(["A", "B"]),
  assetId: z.string().optional(),
  asset: createAssetSchema.optional(),
  checklistState: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        stage: intakeStageSchema,
        required: z.boolean().default(true),
        status: z.enum(["missing", "provided", "verified"]).default("missing"),
      }),
    )
    .optional(),
  milestones: z
    .array(
      z.object({
        name: z.string(),
        percent: z.number().positive(),
        targetDate: z.string(),
      }),
    )
    .optional(),
});

export const createAndSubmitApplicationSchema = createApplicationSchema.extend({
  dossierDocuments: z
    .array(
      z.object({
        type: z.string().min(2),
        filename: z.string().min(2),
        storageKey: z.string().optional(),
        contentBase64: z.string().min(8).optional(),
        mimeType: z.string().optional(),
        stageTag: z.enum(stages).default("Intake"),
      }),
    )
    .default([]),
  requestedServices: z
    .array(
      z.object({
        professionalId: z.string(),
        stage: z.enum(["Diligence", "Structuring"]).default("Diligence"),
      }),
    )
    .default([]),
});

export const applicationIdParamsSchema = z.object({ id: z.string() });
export const taskIdParamsSchema = z.object({ id: z.string() });
export const reviewRoundIdParamsSchema = z.object({ id: z.string() });
export const reviewItemIdParamsSchema = z.object({ id: z.string() });

export const listApplicationsQuerySchema = z.object({
  status: z
    .enum([
      "draft",
      "submitted",
      "in_review",
      "needs_info",
      "approved",
      "rejected",
      "withdrawn",
    ])
    .optional(),
  templateCode: z.enum(["A", "B"]).optional(),
  stage: z.enum(stages).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const requestServiceSchema = z.object({
  professionalId: z.string(),
  stage: z.enum(["Diligence", "Structuring"]).default("Diligence"),
});

export const taskStatusSchema = z.object({
  status: z.enum(["open", "in_progress", "completed", "rejected"]),
});

export const withdrawApplicationSchema = z.object({
  reason: z.string().min(3).optional(),
});

export const decisionPayloadSchema = z.object({
  reasonCode: z.string().trim().min(2).max(80).optional(),
  notes: z.string().trim().min(2).max(2000).optional(),
});

export const reviewItemTypeSchema = z.enum([
  "checklist",
  "document",
  "task",
  "field",
  "milestone",
  "other",
]);

export const createReviewRoundSchema = z.object({
  stageTag: z.enum(stages).optional(),
  summary: z.string().trim().min(2).max(400).optional(),
  dueAt: z.string().optional(),
  items: z
    .array(
      z.object({
        itemType: reviewItemTypeSchema,
        itemKey: z.string().trim().min(1).max(120),
        title: z.string().trim().min(2).max(200),
        stageTag: z.enum(stages).optional(),
        required: z.boolean().default(true),
        requestMessage: z.string().trim().min(2).max(2000),
      }),
    )
    .min(1),
});

export const listReviewItemsQuerySchema = z.object({
  roundId: z.string().optional(),
  status: z.enum(["open", "responded", "verified", "rejected"]).optional(),
});

export const respondReviewItemSchema = z.object({
  responseMessage: z.string().trim().min(2).max(2000),
  responseMeta: z.record(z.string(), z.unknown()).optional(),
});

export const verifyReviewItemSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  reviewNotes: z.string().trim().min(2).max(2000).optional(),
});

export const closeReviewRoundSchema = z.object({
  notes: z.string().trim().min(2).max(1000).optional(),
});

export type CreateApplicationPayload = z.infer<typeof createApplicationSchema>;
export type CreateAndSubmitApplicationPayload = z.infer<
  typeof createAndSubmitApplicationSchema
>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
export type RequestServicePayload = z.infer<typeof requestServiceSchema>;
export type TaskStatusPayload = z.infer<typeof taskStatusSchema>;
export type WithdrawApplicationPayload = z.infer<typeof withdrawApplicationSchema>;
export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;
export type CreateReviewRoundPayload = z.infer<typeof createReviewRoundSchema>;
export type ListReviewItemsQuery = z.infer<typeof listReviewItemsQuerySchema>;
export type RespondReviewItemPayload = z.infer<typeof respondReviewItemSchema>;
export type VerifyReviewItemPayload = z.infer<typeof verifyReviewItemSchema>;
