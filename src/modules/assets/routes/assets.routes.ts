import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AssetModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { HttpError } from "../../../utils/errors.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { serialize } from "../../../utils/serialize.js";

export async function assetRoutes(app: FastifyInstance) {
  app.get(
    "/v1/assets",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");

      const query = z.object({ businessId: z.string().optional() }).parse(request.query);
      const filter: Record<string, unknown> = {};

      if (request.authUser.role === "issuer") {
        filter.businessId = request.authUser.businessId;
      } else if (query.businessId && ["admin", "operator"].includes(request.authUser.role)) {
        filter.businessId = query.businessId;
      }

      const rows = await AssetModel.find(filter).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/assets/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const asset = await AssetModel.findById(params.id).lean();
      if (!asset) throw new HttpError(404, "Asset not found");

      assertIssuerBusinessScope(request.authUser, asset.businessId ? String(asset.businessId) : undefined);
      return serialize(asset);
    },
  );
}
