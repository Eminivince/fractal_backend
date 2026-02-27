import { HttpError } from "./errors.js";
import type { AuthUser } from "../types.js";
import type { AdminSubRole, Role } from "./constants.js";

// A-07: Extend AuthUser with optional subRole for admin granularity
declare module "../types.js" {
  interface AuthUser {
    subRole?: AdminSubRole;
  }
}

export type ResourceKind =
  | "user"
  | "platform"
  | "template"
  | "professional"
  | "work_order"
  | "business"
  | "application"
  | "task"
  | "dossier"
  | "offering"
  | "investor_profile"
  | "subscription"
  | "distribution"
  | "milestone"
  | "tranche"
  | "dispute"
  | "event"
  | "notification"
  | "anchor"
  | "ledger"
  | "reconciliation";

export type Action = "create" | "read" | "update" | "review" | "approve" | "execute" | "submit";

const rolePolicies: Record<Role, Record<ResourceKind, Action[]>> = {
  admin: {
    user: ["create", "read", "update", "approve"],
    platform: ["read", "update"],
    template: ["read", "update"],
    professional: ["create", "read", "update"],
    work_order: ["create", "read", "update", "review", "approve", "submit"],
    business: ["read", "update"],
    application: ["create", "read", "update", "review", "approve", "submit"],
    task: ["read", "update", "review"],
    dossier: ["read", "update"],
    offering: ["create", "read", "update", "review", "approve", "submit", "execute"],
    investor_profile: ["read", "update", "approve"],
    subscription: ["read", "update", "approve", "execute"],
    distribution: ["create", "read", "update", "approve", "execute", "submit"],
    milestone: ["create", "read", "update", "review", "approve"],
    tranche: ["read", "update", "execute"],
    dispute: ["create", "read", "update", "review"],
    event: ["read"],
    notification: ["read", "update"],
    anchor: ["read", "execute"],
    ledger: ["read"],
    reconciliation: ["read", "execute"],
  },
  operator: {
    user: ["read", "update"],
    platform: ["read"],
    template: ["read"],
    professional: ["read"],
    work_order: ["create", "read", "update", "review", "approve", "submit"],
    business: ["read"],
    application: ["read", "review", "approve", "update"],
    task: ["read", "update", "review"],
    dossier: ["read", "update"],
    offering: ["read", "review", "approve", "update", "execute"],
    investor_profile: ["read", "approve", "update"],
    subscription: ["read", "update", "approve", "execute"],
    distribution: ["read", "approve", "execute", "update"],
    milestone: ["read", "review", "approve", "update"],
    tranche: ["read", "execute", "update"],
    dispute: ["create", "read", "update", "review"],
    event: ["read"],
    notification: ["read", "update"],
    anchor: ["read", "execute"],
    ledger: ["read"],
    reconciliation: ["read", "execute"],
  },
  issuer: {
    user: [],
    platform: ["read"],
    template: ["read"],
    professional: ["read"],
    work_order: ["read"],
    business: ["read", "update"],
    application: ["create", "read", "update", "submit"],
    task: ["read"],
    dossier: ["read", "update"],
    offering: ["create", "read", "update", "submit"],
    investor_profile: [],
    subscription: ["read"],
    distribution: ["create", "read", "update", "submit"],
    milestone: ["create", "read", "update", "submit"],
    tranche: ["read"],
    dispute: ["create", "read"],
    event: ["read"],
    notification: ["read", "update"],
    anchor: ["read"],
    ledger: ["read"],
    reconciliation: [],
  },
  investor: {
    user: [],
    platform: ["read"],
    template: ["read"],
    professional: [],
    work_order: [],
    business: [],
    application: [],
    task: [],
    dossier: [],
    offering: ["read"],
    investor_profile: ["read", "update", "submit"],
    subscription: ["create", "read", "update", "submit"],
    distribution: ["read"],
    milestone: ["read"],
    tranche: ["read"],
    dispute: ["create", "read"],
    event: ["read"],
    notification: ["read", "update"],
    anchor: ["read"],
    ledger: ["read"],
    reconciliation: [],
  },
  professional: {
    user: [],
    platform: ["read"],
    template: ["read"],
    professional: ["read", "update"],
    work_order: ["read", "update", "submit"],
    business: [],
    application: [],
    task: ["read"],
    dossier: ["read"],
    offering: [],
    investor_profile: [],
    subscription: [],
    distribution: [],
    milestone: [],
    tranche: [],
    dispute: [],
    event: ["read"],
    notification: ["read", "update"],
    anchor: [],
    ledger: [],
    reconciliation: [],
  },
};

export function authorize(user: AuthUser, action: Action, resource: ResourceKind) {
  const allowed = rolePolicies[user.role]?.[resource] ?? [];
  if (!allowed.includes(action)) {
    throw new HttpError(403, `Role ${user.role} is not allowed to ${action} ${resource}`);
  }
}

// A-08: Helper to require one of several roles (used in route preHandlers)
export function requireRole(...roles: Role[]) {
  return async (request: { authUser: AuthUser }) => {
    if (!roles.includes(request.authUser.role)) {
      throw new HttpError(
        403,
        `This endpoint requires one of: ${roles.join(", ")}. Your role: ${request.authUser.role}`,
      );
    }
  };
}
