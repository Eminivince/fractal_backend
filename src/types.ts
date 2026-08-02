import type { Types } from "mongoose";
import type { Role } from "./utils/constants.js";

export interface AuthUser {
  userId: string;
  role: Role;
  businessId?: string;
  sessionId?: string;
}

export type MaybeObjectId = string | Types.ObjectId;
