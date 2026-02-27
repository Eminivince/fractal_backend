import type { FastifyInstance } from "fastify";
import type { AuthUser } from "../../../types.js";
import { BusinessModel, UserModel } from "../../../db/models.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { persistBusinessBinary, retrieveFile } from "../../../services/storage.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { env } from "../../../config/env.js";
import { resolvePaystackAccount } from "../../../services/paystack.js";
import type { SuspensionReason } from "../../../utils/constants.js";
import type {
  BusinessDocumentUploadPayload,
  BusinessKybReviewPayload,
  BusinessRegistrationPayload,
  BusinessUpdatePayload,
  DirectorPayload,
  PayoutBankAccountPayload,
  ShareholderPayload,
  UboPayload,
} from "../schemas/businesses.schemas.js";

const REQUIRED_KYB_DOCUMENT_TYPES = [
  "certificate_of_incorporation",
  "tax_identification_document",
  "proof_of_registered_address",
  "director_id_document",
] as const;

function sanitizeFilenameSegment(name: string): string {
  return name.replace(/[^a-z0-9.\-_]+/gi, "-").toLowerCase();
}

function normalizeDocType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapInputBusinessType(
  type: "issuer" | "developer" | "spv",
): "property_owner" | "developer" | "spv_manager" {
  if (type === "developer") return "developer";
  if (type === "spv") return "spv_manager";
  return "property_owner";
}

function hasCompleteRegistrationProfile(business: any): boolean {
  const profile = business.registrationProfile as any;
  if (!profile) return false;
  if (!profile.legalName || !profile.registrationNumber) return false;
  if (!profile.contact?.email || !profile.contact?.phone) return false;
  if (!profile.address?.country || !profile.address?.state || !profile.address?.city)
    return false;
  if (!profile.address?.addressLine1) return false;
  if (
    !profile.representative?.fullName ||
    !profile.representative?.email ||
    !profile.representative?.phone
  ) {
    return false;
  }
  return true;
}

async function resolveIssuerBusinessId(authUser: AuthUser): Promise<string | null> {
  const authUserRecord = await UserModel.findById(authUser.userId)
    .select("businessId")
    .lean();
  const issuerBusinessId = authUserRecord?.businessId ?? authUser.businessId;
  return issuerBusinessId ? String(issuerBusinessId) : null;
}

export async function listBusinessesForUser(
  authUser: AuthUser,
  query: { name?: string; page?: number; limit?: number } = {},
) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const skip = (page - 1) * limit;

  if (authUser.role === "issuer") {
    const issuerBusinessId = await resolveIssuerBusinessId(authUser);
    if (!issuerBusinessId) return { data: [], total: 0, page, limit, pages: 0 };
    const filter: Record<string, unknown> = { _id: issuerBusinessId };
    if (query.name) filter.name = { $regex: query.name, $options: "i" };
    const [data, total] = await Promise.all([
      BusinessModel.find(filter).skip(skip).limit(limit).lean(),
      BusinessModel.countDocuments(filter),
    ]);
    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }

  const filter: Record<string, unknown> = {};
  if (query.name) filter.name = { $regex: query.name, $options: "i" };
  const [data, total] = await Promise.all([
    BusinessModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    BusinessModel.countDocuments(filter),
  ]);
  return { data, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getIssuerBusiness(authUser: AuthUser) {
  const issuerBusinessId = await resolveIssuerBusinessId(authUser);
  if (!issuerBusinessId) throw new HttpError(404, "Business not found");

  const business = await BusinessModel.findById(issuerBusinessId).lean();
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

export async function registerIssuerBusiness(
  app: FastifyInstance,
  authUser: AuthUser,
  payload: BusinessRegistrationPayload,
) {
  const user = await UserModel.findById(authUser.userId);
  if (!user) throw new HttpError(404, "User not found");

  let business = user.businessId
    ? await BusinessModel.findById(user.businessId)
    : null;

  if (!business && authUser.businessId) {
    business = await BusinessModel.findById(authUser.businessId);
  }

  const mappedType = mapInputBusinessType(payload.businessType);
  const parsedIncorporationDate =
    payload.incorporationDate && payload.incorporationDate.trim().length > 0
      ? new Date(payload.incorporationDate)
      : undefined;

  if (!business) {
    business = await BusinessModel.create({
      name: payload.legalName,
      type: mappedType,
      kybStatus: "draft",
      status: "active",
      registrationProfile: {
        legalName: payload.legalName,
        tradingName: payload.tradingName,
        registrationNumber: payload.registrationNumber,
        taxId: payload.taxId,
        incorporationDate: parsedIncorporationDate,
        website: payload.website,
        summary: payload.summary,
        contact: {
          email: payload.contactEmail,
          phone: payload.contactPhone,
        },
        address: {
          country: payload.address.country,
          state: payload.address.state,
          city: payload.address.city,
          addressLine1: payload.address.addressLine1,
          addressLine2: payload.address.addressLine2,
          postalCode: payload.address.postalCode,
        },
        representative: {
          fullName: payload.representative.fullName,
          title: payload.representative.title,
          email: payload.representative.email,
          phone: payload.representative.phone,
          idNumber: payload.representative.idNumber,
        },
      },
      documents: [],
    });
  } else {
    assertIssuerBusinessScope(authUser, String(business._id));
    business.name = payload.legalName;
    business.type = mappedType;
    business.registrationProfile = {
      legalName: payload.legalName,
      tradingName: payload.tradingName,
      registrationNumber: payload.registrationNumber,
      taxId: payload.taxId,
      incorporationDate: parsedIncorporationDate,
      website: payload.website,
      summary: payload.summary,
      contact: {
        email: payload.contactEmail,
        phone: payload.contactPhone,
      },
      address: {
        country: payload.address.country,
        state: payload.address.state,
        city: payload.address.city,
        addressLine1: payload.address.addressLine1,
        addressLine2: payload.address.addressLine2,
        postalCode: payload.address.postalCode,
      },
      representative: {
        fullName: payload.representative.fullName,
        title: payload.representative.title,
        email: payload.representative.email,
        phone: payload.representative.phone,
        idNumber: payload.representative.idNumber,
      },
    } as any;

    if (business.kybStatus === "rejected") {
      business.kybStatus = "draft";
      business.kybReviewNotes = undefined;
      business.registrationRejectedAt = undefined;
      business.registrationReviewedAt = undefined;
      business.kybReviewedBy = undefined;
    }

    await business.save();
  }

  if (!user.businessId || String(user.businessId) !== String(business._id)) {
    user.businessId = business._id as any;
    (user as any).businessRole = "owner";
    await user.save();
  } else if (!(user as any).businessRole) {
    (user as any).businessRole = "owner";
    await user.save();
  }

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "Issuer business registration saved",
  });

  const token = await app.jwt.sign({
    userId: user._id.toString(),
    role: user.role,
    businessId: String(business._id),
  });

  return {
    token,
    business: business.toObject(),
    user: user.toObject(),
  };
}

export async function submitIssuerBusinessKyb(authUser: AuthUser) {
  const user = await UserModel.findById(authUser.userId).select("businessId role");
  if (!user?.businessId) {
    throw new HttpError(422, "Business profile is required before KYB submission");
  }

  const business = await BusinessModel.findById(user.businessId);
  if (!business) throw new HttpError(404, "Business not found");

  if (!hasCompleteRegistrationProfile(business)) {
    throw new HttpError(
      422,
      "Complete business registration details before KYB submission",
    );
  }

  // I-01: Require at least one UBO declaration
  const ubos = (business as any).ubos ?? [];
  if (ubos.length === 0) {
    throw new HttpError(
      422,
      "At least one Ultimate Beneficial Owner (UBO) must be declared before KYB submission (CAMA 2020 requirement)",
    );
  }

  // I-02: Require at least two directors (or one for sole trader)
  const directors = (business as any).directors ?? [];
  if (directors.length === 0) {
    throw new HttpError(
      422,
      "At least one director must be declared before KYB submission",
    );
  }

  // 2.9: Validate shareholder ownership totals and entity UBO chains
  const shareholders = (business as any).shareholders ?? [];
  const totalOwnership = shareholders.reduce(
    (sum: number, s: any) => sum + (s.ownershipPct ?? 0),
    0,
  );
  if (totalOwnership > 100) {
    throw new HttpError(
      422,
      `Total shareholder ownership exceeds 100% (${totalOwnership}%). Please correct before KYB submission.`,
    );
  }
  const incompleteEntityShareholders = shareholders.filter(
    (s: any) => s.isEntity && s.entityUboChainRequired && ubos.filter((u: any) => u.controlBasis === "shares").length === 0,
  );
  if (incompleteEntityShareholders.length > 0) {
    const names = incompleteEntityShareholders.map((s: any) => s.name).join(", ");
    throw new HttpError(
      422,
      `Entity shareholders with required UBO chains are incomplete: ${names}. Add at least one UBO entry before KYB submission.`,
    );
  }

  const uploadedTypeSet = new Set(
    (business.documents ?? [])
      .map((doc: any) => normalizeDocType(String(doc?.type ?? "")))
      .filter((value: string) => value.length > 0),
  );
  const missingDocTypes = REQUIRED_KYB_DOCUMENT_TYPES.filter(
    (requiredType) => !uploadedTypeSet.has(requiredType),
  );
  if (missingDocTypes.length) {
    throw new HttpError(
      422,
      `Missing required KYB documents: ${missingDocTypes.join(", ")}`,
    );
  }

  business.kybStatus = "submitted";
  business.registrationSubmittedAt = new Date();
  business.registrationReviewedAt = undefined;
  business.registrationApprovedAt = undefined;
  business.registrationRejectedAt = undefined;
  business.kybReviewedBy = undefined;
  business.kybReviewNotes = undefined;
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "Business KYB submitted",
  });

  return business.toObject();
}

export async function listBusinessDocuments(authUser: AuthUser, businessId: string) {
  const business = await BusinessModel.findById(businessId).lean();
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));
  return business.documents ?? [];
}

export async function uploadBusinessDocument(
  authUser: AuthUser,
  businessId: string,
  payload: BusinessDocumentUploadPayload,
) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  let storageKey =
    payload.storageKey ??
    `manual://businesses/${business._id.toString()}/${Date.now()}-${sanitizeFilenameSegment(payload.filename)}`;

  if (payload.contentBase64) {
    const persisted = await persistBusinessBinary({
      businessId: String(business._id),
      filename: payload.filename,
      contentBase64: payload.contentBase64,
      mimeType: payload.mimeType,
    });
    storageKey = persisted.storageKey;
  }

  business.documents.push({
    type: payload.type,
    filename: payload.filename,
    mimeType: payload.mimeType,
    storageKey,
    uploadedBy: authUser.userId as any,
    uploadedAt: new Date(),
  } as any);

  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "Business KYB document uploaded",
    notes: `${payload.type}: ${payload.filename}`,
  });

  const createdDocument = business.documents[business.documents.length - 1];
  return createdDocument?.toObject ? createdDocument.toObject() : createdDocument;
}

// A-14: Minimum required doc types for KYB approval gate
const MIN_KYB_APPROVAL_DOCS = [
  "certificate_of_incorporation",
  "director_id_document",
] as const;

function checkKybDocCompleteness(business: any): { complete: boolean; missing: string[] } {
  const uploadedTypes = new Set(
    (business.documents ?? [])
      .map((doc: any) => normalizeDocType(String(doc?.type ?? "")))
      .filter((t: string) => t.length > 0),
  );
  const missing = MIN_KYB_APPROVAL_DOCS.filter((t) => !uploadedTypes.has(t));
  return { complete: missing.length === 0, missing };
}

export async function reviewBusinessKybStatus(
  authUser: AuthUser,
  businessId: string,
  payload: BusinessKybReviewPayload,
) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");

  // A-14: Enforce document completeness gate before approval
  if (payload.status === "approved") {
    const { complete, missing } = checkKybDocCompleteness(business);
    if (!complete) {
      throw new HttpError(
        422,
        `Cannot approve KYB: missing required documents: ${missing.join(", ")}`,
      );
    }
  }

  business.kybStatus = payload.status;
  business.registrationReviewedAt = new Date();
  business.kybReviewedBy = authUser.userId as any;
  business.kybReviewNotes = payload.notes?.trim() || undefined;

  if (payload.status === "approved") {
    business.registrationApprovedAt = new Date();
    business.registrationRejectedAt = undefined;
  } else if (payload.status === "rejected") {
    business.registrationRejectedAt = new Date();
    business.registrationApprovedAt = undefined;
  } else {
    business.registrationApprovedAt = undefined;
    business.registrationRejectedAt = undefined;
  }

  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "Business KYB status updated",
    notes: `${payload.status}${payload.notes ? `: ${payload.notes}` : ""}`,
  });

  if (payload.status === "approved" || payload.status === "rejected") {
    await createNotificationsFromEvent(authUser, {
      entityType: "business",
      entityId: String(business._id),
      action: payload.status === "approved" ? "KYBApproved" : "KYBRejected",
      notes:
        payload.status === "approved"
          ? "Your business verification (KYB) has been approved."
          : `Your business verification (KYB) was not approved. ${payload.notes ?? "Please resubmit with the required documents."}`,
    });
  }

  return business.toObject();
}

export async function updateBusinessProfile(
  authUser: AuthUser,
  businessId: string,
  payload: BusinessUpdatePayload,
) {
  const existing = await BusinessModel.findById(businessId).lean();
  if (!existing) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(existing._id));

  // Guard: governance fields (riskTier, status) are admin-only
  if (authUser.role !== "admin") {
    if ((payload as any).riskTier !== undefined) {
      throw new HttpError(403, "Only admins can change riskTier");
    }
    if ((payload as any).status !== undefined) {
      throw new HttpError(403, "Only admins can change business status");
    }
  }

  const updated = await BusinessModel.findByIdAndUpdate(businessId, payload, {
    new: true,
  }).lean();

  if (!updated) throw new HttpError(404, "Business not found");

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(updated._id),
    action: "Business profile updated",
  });

  return updated;
}

export async function updatePayoutBankAccount(
  authUser: AuthUser,
  businessId: string,
  payload: PayoutBankAccountPayload,
) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  // I-07: Validate account via Paystack resolve API when enabled and bankCode is provided
  let resolvedAccountName: string | undefined;
  if (env.PAYSTACK_ENABLED && payload.bankCode) {
    try {
      const resolved = await resolvePaystackAccount({
        accountNumber: payload.accountNumber,
        bankCode: payload.bankCode,
      });
      resolvedAccountName = resolved.account_name;

      // Name-match check: warn if resolved name doesn't roughly match declared name
      const declaredNorm = payload.accountName.toLowerCase().replace(/\s+/g, " ").trim();
      const resolvedNorm = resolved.account_name.toLowerCase().replace(/\s+/g, " ").trim();
      if (!resolvedNorm.includes(declaredNorm.split(" ")[0])) {
        throw new HttpError(
          422,
          `Bank account name mismatch: declared "${payload.accountName}" but Paystack resolved "${resolved.account_name}". ` +
            "Ensure the account is registered under the company's legal name.",
        );
      }
    } catch (err: any) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, `Bank account validation failed: ${err.message}`);
    }
  }

  business.payoutBankAccount = {
    bankName: payload.bankName,
    bankCode: payload.bankCode,
    accountNumber: payload.accountNumber,
    // Use the Paystack-resolved name if available (more reliable)
    accountName: resolvedAccountName ?? payload.accountName,
    routingCode: payload.routingCode,
    currency: payload.currency ?? "NGN",
    paystackVerified: Boolean(resolvedAccountName),
    updatedAt: new Date(),
  } as any;

  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "PayoutBankAccountUpdated",
    notes: `bank:${payload.bankName} verified:${Boolean(resolvedAccountName)}`,
  });

  return business.toObject();
}

export async function retrieveBusinessDocument(
  authUser: AuthUser,
  businessId: string,
  documentId: string,
) {
  const business = await BusinessModel.findById(businessId).lean();
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  const doc = (business.documents ?? []).find((d: any) => String(d._id) === documentId);
  if (!doc) throw new HttpError(404, "Document not found");
  if (!doc.storageKey) throw new HttpError(404, "Document file was not persisted");

  return { doc, ...(await retrieveFile(doc.storageKey)) };
}

export async function listBusinessUsers(authUser: AuthUser, businessId: string) {
  const business = await BusinessModel.findById(businessId).lean();
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));
  return UserModel.find({ businessId }).lean();
}

// I-01: UBO management
export async function addUbo(authUser: AuthUser, businessId: string, payload: UboPayload) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  const entry = {
    fullName: payload.fullName,
    dateOfBirth: payload.dateOfBirth ? new Date(payload.dateOfBirth) : undefined,
    nationality: payload.nationality,
    address: payload.address,
    ownershipPct: payload.ownershipPct,
    controlBasis: payload.controlBasis ?? "shares",
    isPep: payload.isPep ?? false,
    idDocumentRef: payload.idDocumentRef,
    addedAt: new Date(),
  };
  (business as any).ubos = (business as any).ubos ?? [];
  (business as any).ubos.push(entry);
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "UBOAdded",
    notes: payload.fullName,
  });

  const ubos = (business as any).ubos;
  const last = ubos[ubos.length - 1];
  return {
    _id: last._id,
    fullName: last.fullName,
    dateOfBirth: last.dateOfBirth,
    nationality: last.nationality,
    address: last.address,
    ownershipPct: last.ownershipPct,
    controlBasis: last.controlBasis,
    isPep: last.isPep,
    idDocumentRef: last.idDocumentRef,
    addedAt: last.addedAt,
  };
}

export async function removeUbo(authUser: AuthUser, businessId: string, uboId: string) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  const ubos = (business as any).ubos ?? [];
  const idx = ubos.findIndex((u: any) => String(u._id) === uboId);
  if (idx === -1) throw new HttpError(404, "UBO not found");
  ubos.splice(idx, 1);
  (business as any).ubos = ubos;
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "UBORemoved",
    notes: uboId,
  });

  return { ok: true };
}

// I-02: Director management
export async function addDirector(authUser: AuthUser, businessId: string, payload: DirectorPayload) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  const entry = {
    fullName: payload.fullName,
    title: payload.title,
    nationality: payload.nationality,
    isPep: payload.isPep ?? false,
    idDocumentRef: payload.idDocumentRef,
    addedAt: new Date(),
  };
  (business as any).directors = (business as any).directors ?? [];
  (business as any).directors.push(entry);
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "DirectorAdded",
    notes: payload.fullName,
  });

  const directors = (business as any).directors;
  const last = directors[directors.length - 1];
  return {
    _id: last._id,
    fullName: last.fullName,
    title: last.title,
    nationality: last.nationality,
    isPep: last.isPep,
    idDocumentRef: last.idDocumentRef,
    addedAt: last.addedAt,
  };
}

export async function removeDirector(authUser: AuthUser, businessId: string, directorId: string) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  const directors = (business as any).directors ?? [];
  const idx = directors.findIndex((d: any) => String(d._id) === directorId);
  if (idx === -1) throw new HttpError(404, "Director not found");
  directors.splice(idx, 1);
  (business as any).directors = directors;
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "DirectorRemoved",
    notes: directorId,
  });

  return { ok: true };
}

// I-03: Shareholder management
export async function addShareholder(authUser: AuthUser, businessId: string, payload: ShareholderPayload) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  // 2.9: Validate total ownership percentage does not exceed 100%
  const existingShareholders = (business as any).shareholders ?? [];
  const existingTotal = existingShareholders.reduce(
    (sum: number, s: any) => sum + (s.ownershipPct ?? 0),
    0,
  );
  if (existingTotal + (payload.ownershipPct ?? 0) > 100) {
    throw new HttpError(
      422,
      `Total shareholder ownership cannot exceed 100% (currently ${existingTotal}%, adding ${payload.ownershipPct}%)`,
    );
  }

  const entry = {
    name: payload.name,
    ownershipPct: payload.ownershipPct,
    isEntity: payload.isEntity ?? false,
    entityUboChainRequired: payload.entityUboChainRequired ?? false,
    addedAt: new Date(),
  };
  (business as any).shareholders = existingShareholders;
  (business as any).shareholders.push(entry);
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "ShareholderAdded",
    notes: payload.name,
  });

  const shareholders = (business as any).shareholders;
  return shareholders[shareholders.length - 1];
}

export async function removeShareholder(authUser: AuthUser, businessId: string, shareholderId: string) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  assertIssuerBusinessScope(authUser, String(business._id));

  const shareholders = (business as any).shareholders ?? [];
  const idx = shareholders.findIndex((s: any) => String(s._id) === shareholderId);
  if (idx === -1) throw new HttpError(404, "Shareholder not found");
  shareholders.splice(idx, 1);
  (business as any).shareholders = shareholders;
  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "ShareholderRemoved",
    notes: shareholderId,
  });

  return { ok: true };
}

// A-19: Formal suspension workflow for businesses
// 2.8: Enhanced with cascade — disables all business users and invalidates their sessions
export async function suspendBusiness(
  authUser: AuthUser,
  businessId: string,
  payload: { reason: SuspensionReason; notes?: string },
) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");

  (business as any).status = "disabled";
  (business as any).suspendedAt = new Date();
  (business as any).suspendedBy = authUser.userId;
  (business as any).suspensionReason = payload.reason;
  (business as any).suspensionNotes = payload.notes?.trim() || undefined;

  await business.save();

  // 2.8: Cascade — disable all users belonging to this business and invalidate their JWTs
  const businessUsers = await UserModel.find({ businessId: business._id });
  const tokenInvalidatedAt = new Date();
  for (const u of businessUsers) {
    u.status = "disabled";
    u.tokenInvalidatedAt = tokenInvalidatedAt;
    await u.save();

    await createNotificationsFromEvent(authUser, {
      entityType: "user",
      entityId: String(u._id),
      action: "AccountDisabled",
      notes: `Your account has been disabled because business "${(business as any).registrationProfile?.legalName ?? businessId}" was suspended. Reason: ${payload.reason}.`,
    });
  }

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "BusinessSuspended",
    notes: `reason:${payload.reason}${payload.notes ? ` — ${payload.notes}` : ""} (${businessUsers.length} users disabled)`,
  });

  await createNotificationsFromEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "BusinessSuspended",
    notes: `Your business account has been suspended. Reason: ${payload.reason}. ${payload.notes ?? ""}`.trim(),
  });

  return business.toObject();
}

// A-19: Unsuspend / reinstate business
export async function unsuspendBusiness(authUser: AuthUser, businessId: string) {
  const business = await BusinessModel.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found");

  (business as any).status = "active";
  (business as any).suspendedAt = undefined;
  (business as any).suspendedBy = undefined;
  (business as any).suspensionReason = undefined;
  (business as any).suspensionNotes = undefined;

  await business.save();

  await appendEvent(authUser, {
    entityType: "business",
    entityId: String(business._id),
    action: "BusinessUnsuspended",
  });

  return business.toObject();
}
