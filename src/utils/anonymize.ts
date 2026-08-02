/**
 * C12: GDPR data anonymization utility.
 * Replaces PII with hashed placeholders while retaining financial records
 * for regulatory retention requirements.
 */

import crypto from "node:crypto";
import type { ClientSession } from "mongoose";
import { UserModel, InvestorProfileModel } from "../db/models.js";

function hashPii(value: string): string {
  return `[REDACTED-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 8)}]`;
}

export async function anonymizeInvestor(userId: string, session?: ClientSession) {
  const user = await UserModel.findById(userId).session(session ?? null);
  if (!user) throw new Error(`User ${userId} not found`);

  const profile = await InvestorProfileModel.findOne({ userId }).session(session ?? null);

  // Anonymize user PII
  const originalEmail = user.email;
  user.email = hashPii(originalEmail);
  user.name = hashPii(user.name);
  user.passwordHash = undefined;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.status = "disabled";
  user.tokenInvalidatedAt = new Date();
  await user.save({ session });

  // Anonymize investor profile PII
  if (profile) {
    if (profile.bankAccount) {
      profile.bankAccount.accountNumber = hashPii(profile.bankAccount.accountNumber || "");
      profile.bankAccount.accountName = hashPii(profile.bankAccount.accountName || "");
      profile.bankAccount.recipientCode = undefined;
    }
    profile.kycStatus = "rejected";
    profile.sumsubApplicantId = undefined;
    profile.sumsubExternalUserId = undefined;
    profile.documents = [];
    profile.accreditationDocs = [];
    await profile.save({ session });
  }

  return { anonymizedUserId: userId, originalEmail: hashPii(originalEmail) };
}
