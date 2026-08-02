import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import type { AuthUser } from "../types.js";
import { HttpError } from "../utils/errors.js";
import { UserModel } from "../db/models.js";
import { AuthSessionError, revokeAuthSession, validateAuthSession } from "../platform/auth-sessions.js";
import { createJwtKeyring, resolveJwtVerificationKey } from "../services/jwt-keyring.js";
import { getPostgresAuthIdentityById } from "../platform/postgres-identities.js";

export const AUTH_ACCESS_COOKIE_NAME = "fractal_access";
export const AUTH_REFRESH_COOKIE_NAME = "fractal_refresh";

async function authPlugin(app: any) {
  const keyring = createJwtKeyring({
    primarySecret: env.JWT_SECRET,
    activeKeyId: env.JWT_ACTIVE_KEY_ID,
    keyRingJson: env.JWT_KEY_RING_JSON,
  });
  await app.register(jwt, {
    // The plugin's global signer remains synchronous for the many legacy
    // signed links. Session issuance supplies a keyed signer explicitly.
    secret: env.JWT_SECRET,
  });

  await app.register(cookie);

  app.decorate("authenticate", async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
    try {
      // 1.3: Read token from httpOnly cookie first, fall back to Authorization header
      const cookieToken = (request.cookies as Record<string, string | undefined>)?.[AUTH_ACCESS_COOKIE_NAME];
      const authHeader = request.headers.authorization;
      const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const token = cookieToken || headerToken;

      if (!token) {
        throw new HttpError(401, "Unauthorized");
      }

      const decoded = app.jwt.decode(token, { complete: true });
      const payload = app.jwt.verify(token, {
        key: resolveJwtVerificationKey(keyring, decoded),
      }) as AuthUser & { iat?: number; exp?: number; sid?: string };

      if (payload.sid) {
        try {
          await validateAuthSession(payload.sid, payload.userId);
        } catch (sessionError) {
          if (sessionError instanceof AuthSessionError) {
            throw new HttpError(401, "Session expired. Please sign in again.");
          }
          throw sessionError;
        }
      }

      // Check if user's tokens have been invalidated (e.g. business suspension)
      if (payload.userId) {
        if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
          const identity = await getPostgresAuthIdentityById(payload.userId);
          if (!identity) throw new HttpError(401, "Session expired. Please sign in again.");
          if (identity.status === "disabled") throw new HttpError(403, "Account disabled");
          // A role carried by an old access token cannot survive a role change.
          // This is deliberately an equality check, not a fallback to the JWT.
          if (identity.role !== payload.role) throw new HttpError(401, "Session expired. Please sign in again.");
          if (identity.credentialInvalidatedAt) {
            const issuedAt = payload.iat ?? 0;
            if (issuedAt < Math.floor(identity.credentialInvalidatedAt.getTime() / 1000)) {
              throw new HttpError(401, "Session expired. Please log in again.");
            }
          }
          const verificationOnlyRoute =
            request.url.startsWith("/v1/auth/resend-verification") || request.url.startsWith("/v1/auth/logout");
          if (!identity.emailVerifiedAt && !verificationOnlyRoute) {
            throw new HttpError(403, "Verify your email address before accessing the platform");
          }
        } else {
          const user = await UserModel.findById(payload.userId).select("tokenInvalidatedAt status emailVerified").lean();
          if (!user) {
            throw new HttpError(401, "Session expired. Please sign in again.");
          }
          if (user?.status === "disabled") {
            throw new HttpError(403, "Account disabled");
          }
          if (user?.tokenInvalidatedAt) {
            const issuedAt = payload.iat ?? 0;
            if (issuedAt < Math.floor(new Date(user.tokenInvalidatedAt).getTime() / 1000)) {
              throw new HttpError(401, "Session expired. Please log in again.");
            }
          }
          const verificationOnlyRoute =
            request.url.startsWith("/v1/auth/resend-verification") || request.url.startsWith("/v1/auth/logout");
          if (!user?.emailVerified && !verificationOnlyRoute) {
            throw new HttpError(403, "Verify your email address before accessing the platform");
          }
        }
      }

      request.authUser = {
        userId: payload.userId,
        role: payload.role,
        businessId: payload.businessId,
        sessionId: payload.sid,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, "Unauthorized");
    }
  });
}

/** Helper to set the auth cookie on a reply */
export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string) {
  const isProduction = env.NODE_ENV === "production";
  reply.setCookie(AUTH_ACCESS_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(AUTH_REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/v1/auth",
    maxAge: env.AUTH_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
}

/** Helper to clear the auth cookie */
export function clearAuthCookie(reply: FastifyReply) {
  const isProduction = env.NODE_ENV === "production";
  reply.clearCookie(AUTH_ACCESS_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  });
  reply.clearCookie(AUTH_REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/v1/auth",
  });
}

export async function revokeCurrentAuthSession(request: FastifyRequest): Promise<void> {
  if (request.authUser.sessionId) {
    await revokeAuthSession(request.authUser.sessionId, request.authUser.userId, "logout");
  }
}

export default fp(authPlugin);
