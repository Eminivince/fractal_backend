import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import type { AuthUser } from "../types.js";
import { HttpError } from "../utils/errors.js";
import { UserModel } from "../db/models.js";

export const AUTH_COOKIE_NAME = "fractal_token";

async function authPlugin(app: any) {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  await app.register(cookie);

  app.decorate("authenticate", async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
    try {
      // 1.3: Read token from httpOnly cookie first, fall back to Authorization header
      const cookieToken = (request.cookies as Record<string, string | undefined>)?.[AUTH_COOKIE_NAME];
      const authHeader = request.headers.authorization;
      const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const token = cookieToken || headerToken;

      if (!token) {
        throw new HttpError(401, "Unauthorized");
      }

      const payload = app.jwt.verify(token) as AuthUser & { iat?: number; exp?: number; tokenInvalidatedAt?: number };

      // Check if user's tokens have been invalidated (e.g. business suspension)
      if (payload.userId) {
        const user = await UserModel.findById(payload.userId).select("tokenInvalidatedAt status").lean();
        if (user?.status === "disabled") {
          throw new HttpError(403, "Account disabled");
        }
        if (user?.tokenInvalidatedAt) {
          const issuedAt = payload.iat ?? 0;
          if (issuedAt < Math.floor(new Date(user.tokenInvalidatedAt).getTime() / 1000)) {
            throw new HttpError(401, "Session expired. Please log in again.");
          }
        }
      }

      request.authUser = {
        userId: payload.userId,
        role: payload.role,
        businessId: payload.businessId,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, "Unauthorized");
    }
  });
}

/** Helper to set the auth cookie on a reply */
export function setAuthCookie(reply: FastifyReply, token: string) {
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60, // 8 hours
  });
}

/** Helper to clear the auth cookie */
export function clearAuthCookie(reply: FastifyReply) {
  reply.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
}

export default fp(authPlugin);
