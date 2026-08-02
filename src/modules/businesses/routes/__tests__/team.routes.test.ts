import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  assertIssuerBusinessScope: vi.fn(),
  bcryptHash: vi.fn(),
  businessFindById: vi.fn(),
  inviteCreate: vi.fn(),
  inviteFind: vi.fn(),
  inviteFindOne: vi.fn(),
  inviteUpdateMany: vi.fn(),
  runInTransaction: vi.fn(),
  sendEmail: vi.fn(),
  serialize: vi.fn((value: unknown) => value),
  userCountDocuments: vi.fn(),
  userCreate: vi.fn(),
  userFind: vi.fn(),
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock("bcrypt", () => ({ hash: mocks.bcryptHash }));
vi.mock("../../../../db/models.js", () => ({
  BusinessInviteModel: {
    create: mocks.inviteCreate,
    find: mocks.inviteFind,
    findOne: mocks.inviteFindOne,
    updateMany: mocks.inviteUpdateMany,
  },
  BusinessModel: { findById: mocks.businessFindById },
  UserModel: {
    countDocuments: mocks.userCountDocuments,
    create: mocks.userCreate,
    find: mocks.userFind,
    findById: mocks.userFindById,
    findOne: mocks.userFindOne,
  },
}));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.assertIssuerBusinessScope }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.runInTransaction }));
vi.mock("../../../../services/email.js", () => ({ sendEmailWithFallback: mocks.sendEmail }));
vi.mock("../../../../config/env.js", () => ({ env: { APP_BASE_URL: "https://app.example.test" } }));

import { businessTeamRoutes } from "../team.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "admin";
const session = { id: "session-1" };

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "admin";
  mocks.authorize.mockReturnValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.appendEvent.mockResolvedValue(undefined);
  mocks.sendEmail.mockResolvedValue(undefined);
  mocks.runInTransaction.mockImplementation(async (callback: (activeSession: unknown) => unknown) => callback(session));
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) =>
    reply.status(error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }),
  );
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    request.authUser = { userId: "issuer-1", role, businessId: "business-1" };
  });
  await app.register(businessTeamRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("business team routes", () => {
  it("lists business members within an issuer business scope", async () => {
    role = "issuer";
    mocks.businessFindById.mockReturnValueOnce(lean({ _id: "business-1" }));
    const members = [{ _id: "member-1", name: "Ada Member", businessRole: "member" }];
    mocks.userFind.mockReturnValueOnce({ select: vi.fn().mockReturnValue(lean(members)) });

    const response = await app.inject({ method: "GET", url: "/v1/businesses/business-1/members" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(members);
    expect(mocks.assertIssuerBusinessScope).toHaveBeenCalledWith(expect.objectContaining({ role: "issuer" }), "business-1");
    expect(mocks.userFind).toHaveBeenCalledWith({ businessId: "business-1", status: "active", role: "issuer" });
  });

  it("creates an issuer invite, records an event, and sends the invite email", async () => {
    role = "issuer";
    mocks.userFindById.mockReturnValueOnce(lean({ businessRole: "owner" }));
    mocks.businessFindById.mockReturnValueOnce(lean({ _id: "business-1", name: "Fractal Assets" }));
    mocks.userFindOne.mockReturnValueOnce(lean(null));
    const invite = { _id: "invite-1", token: "invite-token", toObject: () => ({ _id: "invite-1", email: "new@example.test" }) };
    mocks.inviteCreate.mockResolvedValueOnce([invite]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/businesses/business-1/invites",
      payload: { email: "New@Example.test", role: "finance" },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith(
      { businessId: "business-1", email: "new@example.test", status: "pending" },
      { $set: { status: "cancelled" } },
    );
    expect(mocks.inviteCreate).toHaveBeenCalledWith([expect.objectContaining({ businessId: "business-1", email: "new@example.test", role: "finance", invitedBy: "issuer-1", status: "pending" })]);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ role: "issuer" }), expect.objectContaining({ action: "TeamInviteSent", entityId: "business-1" }));
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "New@Example.test", subject: expect.stringContaining("Fractal Assets"), text: expect.stringContaining("invite-token") }));
  });

  it("requires an issuer owner to create an invite", async () => {
    role = "issuer";
    mocks.userFindById.mockReturnValueOnce(lean({ businessRole: "member" }));

    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/invites", payload: { email: "new@example.test" } })).resolves.toMatchObject({ statusCode: 403 });
    expect(mocks.businessFindById).not.toHaveBeenCalled();
  });

  it("does not invite an email that is already a business member", async () => {
    mocks.businessFindById.mockReturnValueOnce(lean({ _id: "business-1", name: "Fractal Assets" }));
    mocks.userFindOne.mockReturnValueOnce(lean({ _id: "member-1" }));

    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/invites", payload: { email: "member@example.test" } })).resolves.toMatchObject({ statusCode: 422 });
    expect(mocks.inviteCreate).not.toHaveBeenCalled();
  });

  it("lists and cancels pending business invites", async () => {
    const invitations = [{ _id: "invite-1", email: "member@example.test" }];
    mocks.inviteFind.mockReturnValueOnce({ sort: vi.fn().mockReturnValue(lean(invitations)) });
    const listed = await app.inject({ method: "GET", url: "/v1/businesses/business-1/invites" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(invitations);

    const invite = { status: "pending", save: vi.fn().mockResolvedValue(undefined) };
    mocks.inviteFindOne.mockResolvedValueOnce(invite);
    const cancelled = await app.inject({ method: "DELETE", url: "/v1/businesses/business-1/invites/invite-1" });
    expect(cancelled.statusCode).toBe(200);
    expect(invite.status).toBe("cancelled");
    expect(invite.save).toHaveBeenCalledOnce();
  });

  it("scopes the pending invite list for an issuer", async () => {
    role = "issuer";
    mocks.inviteFind.mockReturnValueOnce({ sort: vi.fn().mockReturnValue(lean([])) });

    await expect(app.inject({ method: "GET", url: "/v1/businesses/business-1/invites" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.assertIssuerBusinessScope).toHaveBeenCalledWith(expect.objectContaining({ role: "issuer" }), "business-1");
  });

  it("accepts an invite for an existing user", async () => {
    const invite = {
      _id: "invite-1", status: "pending", expiresAt: new Date(Date.now() + 60_000), businessId: "business-1", invitedBy: "issuer-1", email: "member@example.test", role: "legal",
      save: vi.fn().mockResolvedValue(undefined),
    };
    const existingUser = { _id: "user-2", save: vi.fn().mockResolvedValue(undefined) };
    mocks.inviteFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(invite) });
    mocks.businessFindById.mockReturnValueOnce({ session: vi.fn().mockReturnValue(lean({ name: "Fractal Assets" })) });
    mocks.userFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(existingUser) });

    const response = await app.inject({ method: "POST", url: "/v1/businesses/invites/invite-token/accept", payload: { name: "Ada Member", password: "safe-password" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "Invite accepted. You can now log in.", email: "member@example.test", businessId: "business-1", businessName: "Fractal Assets" });
    expect(existingUser).toMatchObject({ businessId: "business-1", businessRole: "legal", role: "issuer" });
    expect(existingUser.save).toHaveBeenCalledWith({ session });
    expect(invite).toMatchObject({ status: "accepted", acceptedByUserId: "user-2" });
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "issuer-1" }), expect.objectContaining({ action: "TeamInviteAccepted" }), session);
  });

  it("creates a new issuer user when the invitee has no account", async () => {
    const invite = { status: "pending", expiresAt: new Date(Date.now() + 60_000), businessId: "business-1", invitedBy: "issuer-1", email: "new@example.test", role: "member", save: vi.fn().mockResolvedValue(undefined) };
    mocks.inviteFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(invite) });
    mocks.businessFindById.mockReturnValueOnce({ session: vi.fn().mockReturnValue(lean({ name: "Fractal Assets" })) });
    mocks.userFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(null) });
    mocks.bcryptHash.mockResolvedValueOnce("hashed-password");
    mocks.userCreate.mockResolvedValueOnce([{ _id: "user-3" }]);

    const response = await app.inject({ method: "POST", url: "/v1/businesses/invites/invite-token/accept", payload: { name: "New Member", password: "safe-password" } });

    expect(response.statusCode).toBe(200);
    expect(mocks.bcryptHash).toHaveBeenCalledWith("safe-password", 12);
    expect(mocks.userCreate).toHaveBeenCalledWith([expect.objectContaining({ email: "new@example.test", name: "New Member", role: "issuer", businessId: "business-1", passwordHash: "hashed-password" })], { session });
  });

  it("rejects invalid or unusable invites", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/businesses/invites/invite-token/accept", payload: { name: "", password: "short" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.inviteFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(null) });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/invites/missing/accept", payload: { name: "Ada", password: "safe-password" } })).resolves.toMatchObject({ statusCode: 404 });
    const expired = { status: "pending", expiresAt: new Date(Date.now() - 60_000), save: vi.fn().mockResolvedValue(undefined) };
    mocks.inviteFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(expired) });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/invites/expired/accept", payload: { name: "Ada", password: "safe-password" } })).resolves.toMatchObject({ statusCode: 422 });
    expect(expired).toMatchObject({ status: "expired" });
  });

  it("rejects an invite when its email belongs to another business", async () => {
    const invite = { status: "pending", expiresAt: new Date(Date.now() + 60_000), businessId: "business-1", invitedBy: "issuer-1", email: "member@example.test", role: "member", save: vi.fn() };
    mocks.inviteFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(invite) });
    mocks.businessFindById.mockReturnValueOnce({ session: vi.fn().mockReturnValue(lean({ name: "Fractal Assets" })) });
    mocks.userFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue({ _id: "user-2", businessId: "business-2" }) });

    await expect(app.inject({ method: "POST", url: "/v1/businesses/invites/invite-token/accept", payload: { name: "Ada", password: "safe-password" } })).resolves.toMatchObject({ statusCode: 422 });
    expect(invite.save).not.toHaveBeenCalled();
  });

  it("rejects an invite that is no longer pending", async () => {
    const invite = { status: "cancelled", expiresAt: new Date(Date.now() + 60_000) };
    mocks.inviteFindOne.mockReturnValueOnce({ session: vi.fn().mockResolvedValue(invite) });

    await expect(app.inject({ method: "POST", url: "/v1/businesses/invites/cancelled/accept", payload: { name: "Ada", password: "safe-password" } })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("scopes issuer invite cancellation and rejects a non-pending invite", async () => {
    role = "issuer";
    mocks.inviteFindOne.mockResolvedValueOnce({ status: "accepted", save: vi.fn() });

    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/invites/invite-1" })).resolves.toMatchObject({ statusCode: 422 });
    expect(mocks.assertIssuerBusinessScope).toHaveBeenCalledWith(expect.objectContaining({ role: "issuer" }), "business-1");
  });

  it("removes a business member and records the action", async () => {
    const member = { businessRole: "member", save: vi.fn().mockResolvedValue(undefined) };
    mocks.userFindOne.mockResolvedValueOnce(member);
    const response = await app.inject({ method: "DELETE", url: "/v1/businesses/business-1/members/member-1" });
    expect(response.statusCode).toBe(200);
    expect(member).toMatchObject({ businessId: undefined, businessRole: undefined });
    expect(member.save).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "issuer-1" }), expect.objectContaining({ action: "TeamMemberRemoved", notes: "userId:member-1" }));
  });

  it("prevents self-removal and removal of the only owner", async () => {
    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/members/issuer-1" })).resolves.toMatchObject({ statusCode: 422 });
    const owner = { businessRole: "owner", save: vi.fn() };
    mocks.userFindOne.mockResolvedValueOnce(owner);
    mocks.userCountDocuments.mockResolvedValueOnce(1);
    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/members/owner-2" })).resolves.toMatchObject({ statusCode: 422 });
    expect(owner.save).not.toHaveBeenCalled();
  });

  it("requires an issuer owner before that issuer can remove a team member", async () => {
    role = "issuer";
    mocks.userFindById.mockReturnValueOnce(lean({ businessRole: "owner" }));
    const member = { businessRole: "member", save: vi.fn().mockResolvedValue(undefined) };
    mocks.userFindOne.mockResolvedValueOnce(member);

    const response = await app.inject({ method: "DELETE", url: "/v1/businesses/business-1/members/member-1" });

    expect(response.statusCode).toBe(200);
    expect(mocks.assertIssuerBusinessScope).toHaveBeenCalledWith(expect.objectContaining({ role: "issuer" }), "business-1");
    expect(member.save).toHaveBeenCalledOnce();
  });

  it("rejects member removal by a non-owner issuer", async () => {
    role = "issuer";
    mocks.userFindById.mockReturnValueOnce(lean({ businessRole: "member" }));

    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/members/member-1" })).resolves.toMatchObject({ statusCode: 403 });
    expect(mocks.userFindOne).not.toHaveBeenCalled();
  });
});
