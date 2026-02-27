import type { FastifyInstance } from "fastify";
import { ProfessionalModel, UserModel } from "../../../db/models.js";
import type { AuthUser } from "../../../types.js";
import { appendEvent } from "../../../utils/audit.js";
import { toDecimal } from "../../../utils/decimal.js";
import { HttpError } from "../../../utils/errors.js";
import type {
  CreateProfessionalPayload,
  ProfessionalListQuery,
  ProfessionalOnboardingReviewPayload,
  ProfessionalRegisterPayload,
  ProfessionalStatusUpdatePayload,
  UpdateProfessionalPayload,
} from "../schemas/professionals.schemas.js";

function toObject<T>(doc: T): T {
  if (doc && typeof doc === "object" && "toObject" in (doc as any)) {
    return (doc as any).toObject();
  }
  return doc;
}

function parseOptionalDate(value?: string): Date | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `Invalid date: ${value}`);
  }
  return parsed;
}

function defaultServiceCategory(
  category: "inspector" | "valuer" | "lawyer" | "trustee" | "servicer",
): "inspection" | "valuation" | "legal" | "trustee" | "servicing" {
  if (category === "inspector") return "inspection";
  if (category === "valuer") return "valuation";
  if (category === "lawyer") return "legal";
  if (category === "trustee") return "trustee";
  return "servicing";
}

// PR-30: Known regulatory bodies per category
const KNOWN_LICENSE_ISSUERS: Record<string, string[]> = {
  lawyer: ["nba", "scuml"],
  valuer: ["niesv"],
  inspector: ["corbon", "coren"],
  trustee: ["sec nigeria", "cbn"],
  servicer: ["cbn", "sec nigeria"],
};

function ensureProfessionalProfileComplete(profile: any): void {
  if (!profile.name || String(profile.name).trim().length < 2) {
    throw new HttpError(422, "Professional name is required");
  }
  if (!profile.category) {
    throw new HttpError(422, "Professional category is required");
  }
  if (!profile.contactEmail || String(profile.contactEmail).trim().length < 3) {
    throw new HttpError(422, "Contact email is required");
  }
  if (!Array.isArray(profile.regions) || profile.regions.length === 0) {
    throw new HttpError(422, "At least one region is required");
  }
  if (!profile.pricing?.model || profile.pricing?.amount == null) {
    throw new HttpError(422, "Pricing model and amount are required");
  }
  if (!Number.isFinite(Number(profile.slaDays)) || Number(profile.slaDays) <= 0) {
    throw new HttpError(422, "SLA days must be greater than zero");
  }
  // PR-30: Validate license issuer against known bodies for the category
  const knownIssuers = KNOWN_LICENSE_ISSUERS[profile.category];
  if (knownIssuers && profile.licenseMeta?.issuer) {
    const issuerLower = String(profile.licenseMeta.issuer).toLowerCase().trim();
    if (!knownIssuers.some((known) => issuerLower.includes(known))) {
      throw new HttpError(
        422,
        `License issuer for ${profile.category} professionals must be one of: ${(KNOWN_LICENSE_ISSUERS[profile.category] ?? []).join(", ").toUpperCase()}`,
      );
    }
  }
}

function applyProfessionalPayload(target: any, payload: ProfessionalRegisterPayload) {
  target.category = payload.category;
  target.name = payload.name;
  target.organizationType = payload.organizationType ?? "firm";
  target.contactEmail = payload.contactEmail?.toLowerCase();
  target.contactPhone = payload.contactPhone;
  target.website = payload.website;
  target.regions = payload.regions;
  target.jurisdictions = payload.jurisdictions ?? [];
  target.serviceCategories =
    payload.serviceCategories && payload.serviceCategories.length > 0
      ? payload.serviceCategories
      : [defaultServiceCategory(payload.category)];
  target.slaDays = payload.slaDays;
  target.pricing = {
    model: payload.pricing.model,
    amount: toDecimal(payload.pricing.amount),
  };
  target.licenseMeta = payload.licenseMeta
    ? {
        licenseNumber: payload.licenseMeta.licenseNumber,
        issuer: payload.licenseMeta.issuer,
        expiresAt: parseOptionalDate(payload.licenseMeta.expiresAt),
      }
    : undefined;
  target.complianceNotes = payload.complianceNotes;
}

export async function listProfessionals(query: ProfessionalListQuery) {
  const filter: Record<string, unknown> = {};
  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status;
  if (query.onboardingStatus) filter.onboardingStatus = query.onboardingStatus;
  if (query.serviceCategory) {
    filter.serviceCategories = { $in: [query.serviceCategory] };
  }

  return ProfessionalModel.find(filter).sort({ createdAt: -1 }).lean();
}

export async function createProfessional(
  authUser: AuthUser,
  payload: CreateProfessionalPayload,
) {
  const created = await ProfessionalModel.create({
    category: payload.category,
    name: payload.name,
    organizationType: payload.organizationType ?? "firm",
    contactEmail: payload.contactEmail?.toLowerCase(),
    contactPhone: payload.contactPhone,
    website: payload.website,
    regions: payload.regions,
    jurisdictions: payload.jurisdictions ?? [],
    serviceCategories:
      payload.serviceCategories && payload.serviceCategories.length > 0
        ? payload.serviceCategories
        : [defaultServiceCategory(payload.category)],
    slaDays: payload.slaDays,
    pricing: {
      model: payload.pricing.model,
      amount: toDecimal(payload.pricing.amount),
    },
    licenseMeta: payload.licenseMeta
      ? {
          licenseNumber: payload.licenseMeta.licenseNumber,
          issuer: payload.licenseMeta.issuer,
          expiresAt: parseOptionalDate(payload.licenseMeta.expiresAt),
        }
      : undefined,
    complianceNotes: payload.complianceNotes,
    status: payload.status ?? "active",
    onboardingStatus: payload.onboardingStatus ?? "approved",
    reviewedBy: authUser.userId,
    reviewedAt: new Date(),
  });

  await appendEvent(authUser, {
    entityType: "platform_config",
    entityId: String(created._id),
    action: "Professional profile created",
    notes: created.name,
  });

  return toObject(created);
}

export async function updateProfessional(
  authUser: AuthUser,
  professionalId: string,
  payload: UpdateProfessionalPayload,
) {
  const professional = await ProfessionalModel.findById(professionalId);
  if (!professional) throw new HttpError(404, "Professional not found");

  applyProfessionalPayload(professional, payload);
  if (payload.status) professional.status = payload.status;
  if (payload.onboardingStatus) professional.onboardingStatus = payload.onboardingStatus;
  await professional.save();

  await appendEvent(authUser, {
    entityType: "platform_config",
    entityId: String(professional._id),
    action: "Professional profile updated",
  });

  return toObject(professional);
}

export async function updateProfessionalStatus(
  authUser: AuthUser,
  professionalId: string,
  payload: ProfessionalStatusUpdatePayload,
) {
  const professional = await ProfessionalModel.findByIdAndUpdate(
    professionalId,
    { status: payload.status },
    { new: true },
  );
  if (!professional) throw new HttpError(404, "Professional not found");

  await appendEvent(authUser, {
    entityType: "platform_config",
    entityId: String(professional._id),
    action: "Professional status changed",
    notes: payload.status,
  });

  return toObject(professional);
}

export async function registerProfessionalProfile(
  app: FastifyInstance,
  authUser: AuthUser,
  payload: ProfessionalRegisterPayload,
) {
  if (authUser.role !== "professional") {
    throw new HttpError(403, "Professional role required");
  }

  const user = await UserModel.findById(authUser.userId);
  if (!user) throw new HttpError(404, "User not found");
  if (user.role !== "professional") {
    throw new HttpError(403, "Only professional users can register profile");
  }

  let professional = user.professionalId
    ? await ProfessionalModel.findById(user.professionalId)
    : null;
  if (!professional) {
    professional = new ProfessionalModel({
      category: payload.category,
      name: payload.name,
      regions: payload.regions,
      serviceCategories: [defaultServiceCategory(payload.category)],
      slaDays: payload.slaDays,
      pricing: {
        model: payload.pricing.model,
        amount: toDecimal(payload.pricing.amount),
      },
      status: "active",
      onboardingStatus: "draft",
    });
  }

  applyProfessionalPayload(professional, payload);
  professional.onboardingStatus = "draft";
  professional.reviewedBy = undefined;
  professional.reviewedAt = undefined;
  await professional.save();

  user.professionalId = professional._id as any;
  if (!user.professionalMembershipRole) {
    user.professionalMembershipRole = "owner";
  }
  await user.save();

  await appendEvent(authUser, {
    entityType: "platform_config",
    entityId: String(professional._id),
    action: "Professional onboarding profile saved",
  });

  const token = await app.jwt.sign({
    userId: user._id.toString(),
    role: user.role,
    professionalId: String(professional._id),
  });

  return {
    token,
    professional: toObject(professional),
    user: toObject(user),
  };
}

export async function submitProfessionalOnboarding(authUser: AuthUser) {
  if (authUser.role !== "professional") {
    throw new HttpError(403, "Professional role required");
  }

  const user = await UserModel.findById(authUser.userId)
    .select("_id role professionalId")
    .lean();
  if (!user) throw new HttpError(404, "User not found");
  if (!user.professionalId) {
    throw new HttpError(422, "Register professional profile before onboarding submission");
  }

  const professional = await ProfessionalModel.findById(user.professionalId);
  if (!professional) throw new HttpError(404, "Professional profile not found");

  if (professional.onboardingStatus === "approved") {
    throw new HttpError(409, "Professional onboarding already approved");
  }
  if (
    professional.onboardingStatus === "submitted" ||
    professional.onboardingStatus === "in_review"
  ) {
    throw new HttpError(409, "Professional onboarding is already under review");
  }

  ensureProfessionalProfileComplete(professional);

  professional.onboardingStatus = "submitted";
  professional.reviewedBy = undefined;
  professional.reviewedAt = undefined;
  await professional.save();

  await appendEvent(authUser, {
    entityType: "platform_config",
    entityId: String(professional._id),
    action: "Professional onboarding submitted",
  });

  return toObject(professional);
}

export async function reviewProfessionalOnboarding(
  authUser: AuthUser,
  professionalId: string,
  payload: ProfessionalOnboardingReviewPayload,
) {
  const professional = await ProfessionalModel.findById(professionalId);
  if (!professional) throw new HttpError(404, "Professional not found");

  professional.onboardingStatus = payload.status;
  professional.reviewedBy = authUser.userId as any;
  professional.reviewedAt = new Date();
  professional.complianceNotes = payload.notes?.trim() || undefined;

  if (payload.status === "approved") {
    professional.status = "active";
  } else if (payload.status === "rejected") {
    professional.status = "disabled";
  }

  await professional.save();

  await appendEvent(authUser, {
    entityType: "platform_config",
    entityId: String(professional._id),
    action: "Professional onboarding reviewed",
    notes: payload.status,
  });

  return toObject(professional);
}
