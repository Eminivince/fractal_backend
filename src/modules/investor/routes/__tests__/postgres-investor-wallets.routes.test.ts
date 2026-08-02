import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), identity: vi.fn(), stepUp: vi.fn(), list: vi.fn(), create: vi.fn(), confirm: vi.fn() }));
const classes = vi.hoisted(() => ({
  IdentityUnavailableError: class extends Error {},
  StepUpRequiredError: class extends Error {},
  WalletLinkError: class extends Error {},
}));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../platform/postgres-identities.js", () => ({ requirePostgresIdentityForSubject: mocks.identity, PostgresIdentityUnavailableError: classes.IdentityUnavailableError }));
vi.mock("../../../../platform/auth-step-up.js", () => ({ requireFreshTotpStepUp: mocks.stepUp, StepUpRequiredError: classes.StepUpRequiredError }));
vi.mock("../../../../platform/postgres-investor-wallets.js", () => ({ listInvestorWallets: mocks.list, createInvestorWalletLinkChallenge: mocks.create, confirmInvestorWalletLinkChallenge: mocks.confirm, InvestorWalletLinkError: classes.WalletLinkError }));

import { postgresInvestorWalletRoutes } from "../postgres-investor-wallets.routes.js";

const address = "0x1111111111111111111111111111111111111111";
const signature = `0x${"a".repeat(130)}`;
let role = "investor";
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "investor";
  mocks.authorize.mockReturnValue(undefined);
  mocks.identity.mockResolvedValue("identity-1");
  mocks.list.mockResolvedValue([{ walletAddress: address, chainId: 1 }]);
  mocks.create.mockResolvedValue({ challengeId: "challenge-1", message: "Sign this message" });
  mocks.confirm.mockResolvedValue({ walletAddress: address, linked: true });
  mocks.stepUp.mockResolvedValue(undefined);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role, sessionId: "session-1" }; });
  await app.register(postgresInvestorWalletRoutes);
});

afterEach(async () => { await app.close(); });

describe("Postgres investor wallet routes", () => {
  it("lists only the authenticated investor's wallet links", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/investor/wallets" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ wallets: [{ walletAddress: address, chainId: 1 }] });
    expect(mocks.identity).toHaveBeenCalledWith("user-1");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "investor" }), "read", "investor_profile");
  });

  it("creates a typed wallet proof challenge only after address validation", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges", payload: { chainId: 1, walletAddress: address } });
    expect(response.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({ investorIdentityId: "identity-1", chainId: 1, walletAddress: address });
    const invalid = await app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges", payload: { chainId: 1, walletAddress: "not-a-wallet" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("requires a fresh step-up before it confirms a wallet signature", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges/confirm", payload: { challengeId: "f8d85a0a-52f0-4b4d-950f-2610d7b954da", signature } });
    expect(response.statusCode).toBe(200);
    expect(mocks.stepUp).toHaveBeenCalledWith({ sessionId: "session-1", identityId: "identity-1" });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ investorIdentityId: "identity-1", signature }));
  });

  it("maps migration, step-up, and wallet-proof failures to safe HTTP responses", async () => {
    mocks.identity.mockRejectedValueOnce(new classes.IdentityUnavailableError("Not migrated"));
    const migration = await app.inject({ method: "GET", url: "/v1/investor/wallets" });
    expect(migration.statusCode).toBe(409);
    expect(migration.json().message).toBe("Your account migration is not ready for wallet linking");

    mocks.stepUp.mockRejectedValueOnce(new classes.StepUpRequiredError("A fresh authenticator check is required"));
    const stepUp = await app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges/confirm", payload: { challengeId: "f8d85a0a-52f0-4b4d-950f-2610d7b954da", signature } });
    expect(stepUp.statusCode).toBe(403);

    mocks.confirm.mockRejectedValueOnce(new classes.WalletLinkError("Wallet proof is invalid"));
    const proof = await app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges/confirm", payload: { challengeId: "f8d85a0a-52f0-4b4d-950f-2610d7b954da", signature } });
    expect(proof.statusCode).toBe(422);
    expect(proof.json().message).toBe("Wallet proof is invalid");

    mocks.identity.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(app.inject({ method: "GET", url: "/v1/investor/wallets" })).resolves.toMatchObject({ statusCode: 500 });
    mocks.stepUp.mockRejectedValueOnce(new Error("Step-up store unavailable"));
    await expect(app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges/confirm", payload: { challengeId: "f8d85a0a-52f0-4b4d-950f-2610d7b954da", signature } })).resolves.toMatchObject({ statusCode: 500 });
    mocks.confirm.mockRejectedValueOnce(new Error("Wallet store unavailable"));
    await expect(app.inject({ method: "POST", url: "/v1/investor/wallet-link-challenges/confirm", payload: { challengeId: "f8d85a0a-52f0-4b4d-950f-2610d7b954da", signature } })).resolves.toMatchObject({ statusCode: 500 });
  });

  it("rejects a non-investor before wallet data is read", async () => {
    role = "operator";
    const response = await app.inject({ method: "GET", url: "/v1/investor/wallets" });
    expect(response.statusCode).toBe(403);
    expect(mocks.identity).not.toHaveBeenCalled();
  });
});
