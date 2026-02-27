import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { clearAuthCookie, setAuthCookie } from "../../../plugins/auth.js";
import { serialize } from "../../../utils/serialize.js";
import {
  authLoginSchema,
  authRegisterSchema,
  authSyncSchema,
} from "../schemas/auth.schemas.js";
import {
  authenticateByPassword,
  getAuthUserById,
  issueAuthToken,
  registerAuthUser,
  syncAuthUser,
} from "../services/auth.service.js";

export function createAuthController(app: FastifyInstance) {
  return {
    login: async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = authLoginSchema.parse(request.body);
      const user = await authenticateByPassword(payload);
      const token = await issueAuthToken(app, user);
      setAuthCookie(reply, token);

      return {
        token,
        user: serialize(user),
      };
    },

    register: async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = authRegisterSchema.parse(request.body);
      const user = await registerAuthUser(payload);
      const token = await issueAuthToken(app, user);
      setAuthCookie(reply, token);

      return {
        token,
        user: serialize(user),
      };
    },

    sync: async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = authSyncSchema.parse(request.body);
      const user = await syncAuthUser(payload);
      const token = await issueAuthToken(app, user);
      setAuthCookie(reply, token);

      return {
        token,
        user: serialize(user),
      };
    },

    logout: async (_request: FastifyRequest, reply: FastifyReply) => {
      clearAuthCookie(reply);
      return { ok: true };
    },

    me: async (request: FastifyRequest) => {
      const user = await getAuthUserById(request.authUser.userId);
      return serialize(user);
    },
  };
}
