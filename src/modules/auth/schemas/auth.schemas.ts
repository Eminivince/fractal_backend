import { z } from "zod";

export const authLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

const selfServeRoles = ["issuer", "investor", "professional"] as const;
const professionalCategories = ["inspector", "valuer", "lawyer"] as const;

export const authRegisterSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8, "Password must be at least 8 characters"),
    name: z.string().min(1, "Name is required").max(200),
    role: z.enum(selfServeRoles),
    professionalCategory: z.enum(professionalCategories).optional(),
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
  });

export const authSyncSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(selfServeRoles).optional(),
});

export type AuthLoginPayload = z.infer<typeof authLoginSchema>;
export type AuthRegisterPayload = z.infer<typeof authRegisterSchema>;
export type AuthSyncPayload = z.infer<typeof authSyncSchema>;
