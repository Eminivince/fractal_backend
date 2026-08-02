import { z } from "zod";

export const authLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

const selfServeRoles = ["issuer", "investor", "professional"] as const;
const professionalCategories = ["inspector", "valuer", "lawyer"] as const;
const legalAcceptance = z.object({
  documentKey: z.enum(["terms_global_public", "privacy_global_public"]),
  versionId: z.string().uuid(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const authRegisterSchema = z
  .object({
    email: z.string().email(),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/[0-9]/, "Password must include a number"),
    name: z.string().min(1, "Name is required").max(200),
    role: z.enum(selfServeRoles),
    professionalCategory: z.enum(professionalCategories).optional(),
    legalAcceptances: z.array(legalAcceptance).max(2),
  })
  .superRefine((payload, ctx) => {
    if (payload.role === "professional" && !payload.professionalCategory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Professional category is required for professional accounts",
        path: ["professionalCategory"],
      });
    }

    if (payload.role !== "professional" && payload.professionalCategory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Professional category can only be set when role is professional",
        path: ["professionalCategory"],
      });
    }
    if (process.env.NODE_ENV !== "development" && (
      payload.legalAcceptances.length !== 2
      || new Set(payload.legalAcceptances.map((item) => item.documentKey)).size !== 2
    )) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Current Terms and Privacy must each be accepted exactly once", path: ["legalAcceptances"] });
    }
  });

export const authSyncSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(selfServeRoles).optional(),
});

export type AuthLoginPayload = z.infer<typeof authLoginSchema>;
export type AuthRegisterPayload = z.infer<typeof authRegisterSchema>;
export type AuthSyncPayload = z.infer<typeof authSyncSchema>;
