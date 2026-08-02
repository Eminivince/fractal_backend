/**
 * Cap table — authoritative holder positions per offering, derived from the
 * ownership ledger (allocation credits net of secondary-transfer debits/credits).
 * Issuer (own offerings), operator, and admin only. Supports CSV export.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LedgerEntryModel, OfferingModel, UserModel } from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { authorize } from "../../../utils/rbac.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { serialize } from "../../../utils/serialize.js";
import { toCsv } from "../../../utils/csv.js";
import { nairaToKobo } from "../../../utils/money.js";

export async function capTableRoutes(app: FastifyInstance) {
  app.get(
    "/v1/offerings/:id/cap-table",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "offering");
      // Investors cannot see the full cap table; issuers only their own offerings.
      if (request.authUser.role === "investor" || request.authUser.role === "professional") {
        throw new HttpError(403, "Cap table is available to the issuer, operators, and admins only");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const format = z.object({ format: z.enum(["json", "csv"]).default("json") }).parse(request.query).format;

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");
      assertIssuerBusinessScope(request.authUser, String((offering as any).businessId));

      // Net each holder's ownership position (in kobo for exactness) from the ledger.
      const rows = await LedgerEntryModel.find({
        ledgerType: "ownership",
        entityType: "offering",
        entityId: String(offering._id),
      })
        .select("accountRef direction amount")
        .lean();

      const positionsKobo = new Map<string, number>();
      for (const r of rows as Array<{ accountRef: string; direction: string; amount: unknown }>) {
        const m = /^investor:(.+)$/.exec(r.accountRef);
        if (!m) continue;
        const userId = m[1];
        const kobo = nairaToKobo(Number((r.amount as { toString(): string })?.toString() ?? "0"));
        positionsKobo.set(userId, (positionsKobo.get(userId) ?? 0) + (r.direction === "credit" ? kobo : -kobo));
      }

      const holderIds = [...positionsKobo.entries()].filter(([, k]) => k > 0).map(([id]) => id);
      const users = await UserModel.find({ _id: { $in: holderIds } }).select("name email").lean();
      const userById = new Map<string, any>(users.map((u: any) => [String(u._id), u]));

      const raiseAmount = Number((offering as any).terms?.raiseAmount?.toString?.() ?? (offering as any).terms?.raiseAmount ?? 0);
      const totalKobo = holderIds.reduce((sum, id) => sum + (positionsKobo.get(id) ?? 0), 0);

      const holders = holderIds
        .map((id) => {
          const units = (positionsKobo.get(id) ?? 0) / 100;
          const u = userById.get(id);
          return {
            investorUserId: id,
            name: u?.name ?? "—",
            email: u?.email ?? "—",
            units,
            pctOfRaise: raiseAmount > 0 ? Number(((units / raiseAmount) * 100).toFixed(4)) : null,
            pctOfHolders: totalKobo > 0 ? Number((((positionsKobo.get(id) ?? 0) / totalKobo) * 100).toFixed(4)) : null,
          };
        })
        .sort((a, b) => b.units - a.units);

      if (format === "csv") {
        const csv = toCsv(
          holders.map((h) => ({
            investorUserId: h.investorUserId,
            name: h.name,
            email: h.email,
            units: h.units,
            pctOfRaise: h.pctOfRaise ?? "",
            pctOfHolders: h.pctOfHolders ?? "",
          })),
          ["investorUserId", "name", "email", "units", "pctOfRaise", "pctOfHolders"],
        );
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="cap-table_${String(offering._id)}.csv"`)
          .send(csv);
      }

      return serialize({
        offeringId: String(offering._id),
        offeringName: (offering as any).name,
        generatedAt: new Date(),
        holderCount: holders.length,
        totalAllocated: totalKobo / 100,
        raiseAmount,
        holders,
      });
    },
  );
}
