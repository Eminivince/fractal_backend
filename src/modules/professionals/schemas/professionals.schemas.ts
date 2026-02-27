import { z } from "zod";

export const professionalIdParamsSchema = z.object({
  id: z.string(),
});

export const professionalCategorySchema = z.enum([
  "inspector",
  "valuer",
  "lawyer",
  "trustee",
  "servicer",
]);

export const professionalServiceCategorySchema = z.enum([
  "legal",
  "valuation",
  "inspection",
  "trustee",
  "servicing",
]);

export const professionalStatusSchema = z.enum(["active", "disabled"]);

export const professionalOnboardingStatusSchema = z.enum([
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
]);

const professionalPricingSchema = z.object({
  model: z.enum(["flat", "pct"]),
  amount: z.number().nonnegative(),
});

const optionalTrimmedString = () =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().optional(),
  );

const optionalEmailSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().email().optional(),
);

const optionalWebsiteSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  },
  z.string().url().optional(),
);

const professionalLicenseMetaSchema = z
  .object({
    licenseNumber: optionalTrimmedString().pipe(z.string().max(120).optional()),
    issuer: optionalTrimmedString().pipe(z.string().max(120).optional()),
    expiresAt: z.string().optional(),
  })
  .optional();

const professionalBaseSchema = z.object({
  category: professionalCategorySchema,
  name: z.string().min(2),
  organizationType: z.enum(["individual", "firm"]).optional(),
  contactEmail: optionalEmailSchema,
  contactPhone: optionalTrimmedString().pipe(
    z.string().min(7).max(40).optional(),
  ),
  website: optionalWebsiteSchema,
  regions: z.array(z.string().min(1)).min(1),
  jurisdictions: z.array(z.string().min(1)).optional(),
  serviceCategories: z.array(professionalServiceCategorySchema).optional(),
  slaDays: z.number().int().positive(),
  pricing: professionalPricingSchema,
  licenseMeta: professionalLicenseMetaSchema,
  complianceNotes: z.string().max(2000).optional(),
});

export const createProfessionalSchema = professionalBaseSchema.extend({
  status: professionalStatusSchema.optional(),
  onboardingStatus: professionalOnboardingStatusSchema.optional(),
});

export const updateProfessionalSchema = professionalBaseSchema.extend({
  status: professionalStatusSchema.optional(),
  onboardingStatus: professionalOnboardingStatusSchema.optional(),
});

export const professionalListQuerySchema = z.object({
  category: professionalCategorySchema.optional(),
  status: professionalStatusSchema.optional(),
  onboardingStatus: professionalOnboardingStatusSchema.optional(),
  serviceCategory: professionalServiceCategorySchema.optional(),
});

export const professionalStatusUpdateSchema = z.object({
  status: professionalStatusSchema,
});

export const professionalRegisterSchema = professionalBaseSchema.extend({
  onboardingStatus: z
    .enum(["draft", "submitted", "in_review", "approved", "rejected"])
    .optional(),
});

export const professionalOnboardingReviewSchema = z.object({
  status: z.enum(["in_review", "approved", "rejected"]),
  notes: z.string().max(2000).optional(),
});

export type CreateProfessionalPayload = z.infer<typeof createProfessionalSchema>;
export type UpdateProfessionalPayload = z.infer<typeof updateProfessionalSchema>;
export type ProfessionalListQuery = z.infer<typeof professionalListQuerySchema>;
export type ProfessionalStatusUpdatePayload = z.infer<
  typeof professionalStatusUpdateSchema
>;
export type ProfessionalRegisterPayload = z.infer<
  typeof professionalRegisterSchema
>;
export type ProfessionalOnboardingReviewPayload = z.infer<
  typeof professionalOnboardingReviewSchema
>;
