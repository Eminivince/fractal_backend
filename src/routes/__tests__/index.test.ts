import { describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../index.js";

describe("API route registry", () => {
  it("registers every route module in its deterministic public order", async () => {
    const app = {
      register: vi.fn(async () => undefined),
    };

    await registerApiRoutes(app as any);

    const registrars = (app.register.mock.calls as unknown as Array<[Function]>).map(([registrar]) => registrar.name);
    expect(registrars).toHaveLength(52);
    expect(registrars.slice(0, 6)).toEqual([
      "authRoutes", "platformRoutes", "templateRoutes", "professionalRoutes", "postgresProfessionalWorkOrderRoutes", "businessRoutes",
    ]);
    expect(registrars).toEqual(expect.arrayContaining([
      "paystackWebhookRoutes", "sumsubWebhookRoutes", "paymentCheckoutRoutes", "postgresAdminPlatformContentRoutes", "postgresPrivacyRightsRoutes",
    ]));
    expect(registrars.slice(-4)).toEqual([
      "postgresAdminDataLifecycleRoutes", "postgresOrganizationAuthorityRoutes", "postgresSupportCaseRoutes", "postgresPrivacyRightsRoutes",
    ]);
  });
});
