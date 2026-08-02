import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), idempotent: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
import { decideOrganizationOwnershipTransfer, expireOrganizationOwnershipTransfers, OrganizationOwnershipTransferError, proposeOrganizationOwnershipTransfer } from "../postgres-organization-ownership.js";

function transactionWithResponse(response: { rows?: unknown[]; rowCount?: number }) { const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
function idempotentWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.idempotent.mockImplementationOnce((options: { execute: (client: { query: typeof query }) => unknown }) => options.execute({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.idempotent.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("organization ownership transfers", () => {
  it("rejects short transfer reasons and invalid expiry windows", async () => {
    await expect(proposeOrganizationOwnershipTransfer({ organizationId: "org-1", requestedByIdentityId: "owner-1", targetMembershipId: "member-1", reason: "short", expiresAt: new Date(Date.now() + 2 * 60 * 60_000) })).rejects.toBeInstanceOf(OrganizationOwnershipTransferError);
    await expect(proposeOrganizationOwnershipTransfer({ organizationId: "org-1", requestedByIdentityId: "owner-1", targetMembershipId: "member-1", reason: "Transfer control to a separately authorized owner.", expiresAt: new Date(Date.now() + 1_000) })).rejects.toThrow("between one hour and 30 days");
    await expect(proposeOrganizationOwnershipTransfer({ organizationId: "org-1", requestedByIdentityId: "owner-1", targetMembershipId: "member-1", reason: "Transfer control to a separately authorized owner.", expiresAt: new Date(Date.now() + 31 * 86_400_000) })).rejects.toThrow("between one hour and 30 days");
  });

  it("rejects short transfer decisions before it runs the command", async () => {
    await expect(decideOrganizationOwnershipTransfer({ transferId: "transfer-1", organizationId: "org-1", actorIdentityId: "owner-1", action: "cancel", reason: "bad" })).rejects.toThrow("between 5 and 2000");
    expect(mocks.idempotent).not.toHaveBeenCalled();
  });

  it("configures immutable idempotent commands with the correct organization scope", async () => {
    mocks.idempotent.mockResolvedValue({ body: { transferId: "transfer-1", status: "pending" }, replayed: false });
    await expect(proposeOrganizationOwnershipTransfer({ organizationId: "org-1", requestedByIdentityId: "owner-1", targetMembershipId: "member-1", reason: "Transfer control to a separately authorized owner.", expiresAt: new Date(Date.now() + 2 * 60 * 60_000), commandKey: "command-1" })).resolves.toEqual({ body: { transferId: "transfer-1", status: "pending" }, replayed: false });
    expect(mocks.idempotent).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "organization:org-1", route: "organization.ownership-transfer.propose", commandKey: "command-1" }));
  });

  it("returns zero when no ownership transfer has expired", async () => {
    const query = transactionWithResponse({ rows: [], rowCount: 0 });
    await expect(expireOrganizationOwnershipTransfers("org-1")).resolves.toBe(0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'expired'"), ["org-1", "The ownership transfer acceptance window expired"]);
  });

  it("creates an ownership proposal only from an active owner to an active different member", async () => {
    const query = idempotentWithResponses(
      { rows: [], rowCount: 0 },
      { rows: [{ id: "membership-owner", role: "owner", status: "active" }] },
      { rows: [{ identity_id: "successor-1", role: "administrator", status: "active" }] },
      { rowCount: 1 },
    );
    await expect(proposeOrganizationOwnershipTransfer({ organizationId: "org-1", requestedByIdentityId: "owner-1", targetMembershipId: "membership-successor", reason: "Transfer control to the independently authorized successor.", expiresAt: new Date(Date.now() + 2 * 60 * 60_000) })).resolves.toMatchObject({ status: 201, body: { status: "pending" } });
    expect(query.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(["org-1", "membership-owner", "membership-successor", "owner-1"]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "organization.ownership_transfer.proposed" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "organization.ownership_transfer.proposed" }));
  });

  it("accepts a current transfer only through the nominated successor", async () => {
    const transfer = { id: "transfer-1", organization_id: "org-1", source_membership_id: "membership-owner", target_membership_id: "membership-successor", source_identity_id: "owner-1", target_identity_id: "successor-1", source_name: "Owner", target_name: "Successor", reason: "Transfer control to successor.", status: "pending", expires_at: new Date(Date.now() + 60 * 60_000), decided_at: null, decision_reason: null, created_at: new Date() };
    const query = idempotentWithResponses({ rows: [transfer] }, { rowCount: 1 }, { rowCount: 1 }, { rows: [{ id: "transfer-1" }], rowCount: 1 });
    await expect(decideOrganizationOwnershipTransfer({ transferId: "transfer-1", organizationId: "org-1", actorIdentityId: "successor-1", action: "accept", reason: "I accept the governed organization ownership transfer." })).resolves.toEqual({ status: 200, body: { transferId: "transfer-1", status: "accepted" } });
    expect(query.mock.calls[1]?.[1]).toEqual(["membership-successor"]);
    expect(query.mock.calls[2]?.[1]).toEqual(["membership-owner"]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "organization.ownership_transfer.accepted" }));
  });
});
