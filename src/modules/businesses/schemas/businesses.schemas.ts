import { z } from "zod";

export const businessIdParamsSchema = z.object({
  id: z.string(),
});

export const businessDocumentUploadSchema = z.object({
  type: z.string().min(2),
  filename: z.string().min(2),
  storageKey: z.string().optional(),
  contentBase64: z.string().min(8).optional(),
  mimeType: z.string().optional(),
});

export const businessRegistrationSchema = z.object({
  legalName: z.string().min(2),
  tradingName: z.string().optional(),
  businessType: z.enum(["issuer", "developer", "spv"]),
  registrationNumber: z.string().min(2),
  taxId: z.string().optional(),
  incorporationDate: z.string().optional(),
  website: z.string().url().optional(),
  summary: z.string().min(10),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(7),
  address: z.object({
    country: z.string().min(2),
    state: z.string().min(2),
    city: z.string().min(2),
    addressLine1: z.string().min(3),
    addressLine2: z.string().optional(),
    postalCode: z.string().optional(),
  }),
  representative: z.object({
    fullName: z.string().min(2),
    title: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(7),
    idNumber: z.string().optional(),
  }),
});

export const businessKybReviewSchema = z.object({
  status: z.enum(["in_review", "approved", "rejected"]),
  notes: z.string().max(1000).optional(),
});

export const payoutBankAccountSchema = z.object({
  bankName: z.string().min(2),
  // I-07: Paystack bank code for account resolution (e.g. "058" for GTBank)
  bankCode: z.string().min(2).optional(),
  accountNumber: z.string().min(5),
  accountName: z.string().min(2),
  routingCode: z.string().optional(),
  currency: z.string().optional(),
});

export type PayoutBankAccountPayload = z.infer<typeof payoutBankAccountSchema>;

// I-01: UBO schema
export const uboSchema = z.object({
  fullName: z.string().min(2),
  dateOfBirth: z.string().optional(),
  nationality: z.string().optional(),
  address: z.string().optional(),
  ownershipPct: z.number().min(0).max(100),
  controlBasis: z
    .enum(["shares", "voting_rights", "appointment_power", "significant_influence", "other"])
    .default("shares"),
  isPep: z.boolean().default(false),
  idDocumentRef: z.string().optional(),
});

// I-02: Director schema
export const directorSchema = z.object({
  fullName: z.string().min(2),
  title: z.string().optional(),
  nationality: z.string().optional(),
  isPep: z.boolean().default(false),
  idDocumentRef: z.string().optional(),
});

// I-03: Shareholder schema
export const shareholderSchema = z.object({
  name: z.string().min(2),
  ownershipPct: z.number().min(0).max(100),
  isEntity: z.boolean().default(false),
  entityUboChainRequired: z.boolean().default(false),
});

export type UboPayload = z.infer<typeof uboSchema>;
export type DirectorPayload = z.infer<typeof directorSchema>;
export type ShareholderPayload = z.infer<typeof shareholderSchema>;

// A-77: Full update schema (admin/operator) — includes governance fields
export const businessUpdateSchema = z
  .object({
    name: z.string().min(2).optional(),
    riskTier: z.enum(["low", "medium", "high"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.riskTier !== undefined ||
      input.status !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

// A-77: Issuer-safe update schema — only non-governance fields
export const businessIssuerUpdateSchema = z
  .object({
    name: z.string().min(2).optional(),
    summary: z.string().min(10).optional(),
    website: z.string().url().optional(),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().min(7).optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.summary !== undefined ||
      input.website !== undefined ||
      input.contactEmail !== undefined ||
      input.contactPhone !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

// A-77: Governance-only fields (admin/operator) — riskTier, status
export const businessGovernanceUpdateSchema = z
  .object({
    riskTier: z.enum(["low", "medium", "high"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(
    (input) => input.riskTier !== undefined || input.status !== undefined,
    { message: "At least one governance field must be provided" },
  );

export type BusinessDocumentUploadPayload = z.infer<
  typeof businessDocumentUploadSchema
>;
export type BusinessRegistrationPayload = z.infer<
  typeof businessRegistrationSchema
>;
export type BusinessKybReviewPayload = z.infer<
  typeof businessKybReviewSchema
>;
export type BusinessUpdatePayload = z.infer<typeof businessUpdateSchema>;
export type BusinessIssuerUpdatePayload = z.infer<typeof businessIssuerUpdateSchema>;
export type BusinessGovernanceUpdatePayload = z.infer<typeof businessGovernanceUpdateSchema>;
