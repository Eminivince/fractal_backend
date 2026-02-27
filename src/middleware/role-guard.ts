import type { AuthUser } from "../types.js";
import type { Role } from "../utils/constants.js";
import { HttpError } from "../utils/errors.js";

export function requireRole(user: AuthUser, ...allowedRoles: Role[]) {
  if (allowedRoles.includes(user.role)) return;
  throw new HttpError(
    403,
    `Role ${user.role} is not permitted. Required: ${allowedRoles.join(", ")}`,
  );
}
