import { HttpError } from "./errors.js";
import type { AuthUser } from "../types.js";

export function assertIssuerBusinessScope(user: AuthUser, resourceBusinessId?: string | null) {
  if (user.role !== "issuer") return;
  if (!resourceBusinessId || String(resourceBusinessId) !== String(user.businessId)) {
    throw new HttpError(403, "Issuer out of business scope");
  }
}

export function assertInvestorScope(user: AuthUser, investorUserId: string) {
  if (user.role !== "investor") return;
  if (String(user.userId) !== String(investorUserId)) {
    throw new HttpError(403, "Investor out of scope");
  }
}
