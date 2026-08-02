import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../utils/errors.js";
import { listPaystackBanks, resolvePaystackAccount } from "../../../services/paystack.js";

export async function paymentUtilRoutes(app: FastifyInstance) {
  // Bank list — cached, minimal auth
  app.get(
    "/v1/banks",
    { preHandler: [app.authenticate] },
    async () => {
      if (!env.PAYSTACK_ENABLED) throw new HttpError(422, "Payment provider not configured");

      const banks = await listPaystackBanks();
      return banks
        .filter((b) => b.active)
        .map((b) => ({ name: b.name, code: b.code, type: b.type }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  );

  // Resolve bank account — returns account name for confirmation
  app.post(
    "/v1/bank-account/resolve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!env.PAYSTACK_ENABLED) throw new HttpError(422, "Payment provider not configured");

      const payload = z
        .object({
          accountNumber: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"),
          bankCode: z.string().min(1),
        })
        .parse(request.body);

      const resolution = await resolvePaystackAccount({
        accountNumber: payload.accountNumber,
        bankCode: payload.bankCode,
      });

      return {
        accountNumber: resolution.account_number,
        accountName: resolution.account_name,
        bankCode: payload.bankCode,
      };
    },
  );
}
