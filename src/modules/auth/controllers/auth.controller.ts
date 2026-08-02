import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { clearAuthCookie, revokeCurrentAuthSession, setAuthCookies } from "../../../plugins/auth.js";
import {
  AuthSessionError,
  createAuthSession,
  listAuthSessions,
  revokeAuthSessionForSubject,
  rotateAuthSession,
} from "../../../platform/auth-sessions.js";
import { listSecurityEvents } from "../../../services/security-event-projection.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";
import {
  authLoginSchema,
  authRegisterSchema,
  authSyncSchema,
} from "../schemas/auth.schemas.js";
import {
  authenticateByPassword,
  getAuthUserById,
  registerAuthUser,
  syncAuthUser,
} from "../services/auth.service.js";

export function createAuthController(app: FastifyInstance) {
  return {
    login: async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = authLoginSchema.parse(request.body);
      const user = await authenticateByPassword(payload);
      const session = await createAuthSession(app, toSessionSubject(user), requestMetadata(request));
      setAuthCookies(reply, session.accessToken, session.refreshToken);

      return {
        token: session.accessToken,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
        user: serialize(user),
      };
    },

    register: async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = authRegisterSchema.parse(request.body);
      const user = await registerAuthUser(payload, requestMetadata(request));
      const session = await createAuthSession(app, toSessionSubject(user), requestMetadata(request));
      setAuthCookies(reply, session.accessToken, session.refreshToken);

      return {
        token: session.accessToken,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
        user: serialize(user),
      };
    },

    sync: async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = authSyncSchema.parse(request.body);
      const user = await syncAuthUser(payload);
      const session = await createAuthSession(app, toSessionSubject(user), requestMetadata(request));
      setAuthCookies(reply, session.accessToken, session.refreshToken);

      return {
        token: session.accessToken,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
        user: serialize(user),
      };
    },

    refresh: async (request: FastifyRequest, reply: FastifyReply) => {
      const refreshToken = request.cookies?.fractal_refresh;
      if (!refreshToken) throw new HttpError(401, "Refresh session is missing");
      let session;
      try {
        session = await rotateAuthSession(app, refreshToken, requestMetadata(request));
      } catch (error) {
        if (error instanceof AuthSessionError) {
          clearAuthCookie(reply);
          throw new HttpError(401, "Refresh session is invalid or expired. Please sign in again.");
        }
        throw error;
      }
      setAuthCookies(reply, session.accessToken, session.refreshToken);
      return {
        token: session.accessToken,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      };
    },

    logout: async (request: FastifyRequest, reply: FastifyReply) => {
      await revokeCurrentAuthSession(request);
      clearAuthCookie(reply);
      return { ok: true };
    },

    me: async (request: FastifyRequest) => {
      const user = await getAuthUserById(request.authUser.userId);
      return serialize(user);
    },

    sessions: async (request: FastifyRequest) => {
      const sessions = await listAuthSessions(request.authUser.userId, request.authUser.sessionId);
      return sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        current: session.current,
      }));
    },

    revokeSession: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = authSessionIdSchema.parse(request.params);
      const revoked = await revokeAuthSessionForSubject(params.id, request.authUser.userId, "user_revoked");
      if (!revoked) throw new HttpError(404, "Active session not found");
      if (params.id === request.authUser.sessionId) clearAuthCookie(reply);
      return { ok: true };
    },

    securityEvents: async (request: FastifyRequest) => {
      const events = await listSecurityEvents(request.authUser.userId);
      return events.map((event) => ({
        id: event.id,
        type: event.event_type,
        sessionId: event.session_id,
        createdAt: event.created_at.toISOString(),
        readAt: event.read_at?.toISOString() ?? null,
      }));
    },
  };
}

function toSessionSubject(user: { _id: { toString: () => string } | string; role: string; businessId?: { toString: () => string } | string }) {
  return {
    userId: typeof user._id === "string" ? user._id : user._id.toString(),
    role: user.role as import("../../../utils/constants.js").Role,
    businessId: typeof user.businessId === "string" ? user.businessId : user.businessId?.toString(),
  };
}

function requestMetadata(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers["user-agent"],
  };
}

const authSessionIdSchema = z.object({ id: z.string().uuid() });
