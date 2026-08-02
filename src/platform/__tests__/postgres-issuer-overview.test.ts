import { beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => postgres }));

import { getIssuerOverview } from "../postgres-issuer-overview.js";

function row(overrides: Record<string, unknown> = {}) {
  return { id: "organization-1", legal_name: "Issuer One", role: "owner", verification_status: "verified", verification_updated_at: new Date("2026-07-01T00:00:00.000Z"), verification_expires_at: new Date("2030-07-01T00:00:00.000Z"), active_members: "2", pending_invitations: "1", submitted_applications: "3", approved_applications: "4", rejected_applications: "5", unresolved_diligence_items: "6", submitted_publication_requests: "7", published_offerings: "8", paused_offerings: "9", closed_offerings: "10", ...overrides };
}
beforeEach(() => postgres.query.mockReset());

describe("issuer overview", () => {
  it("maps tenant-scoped aggregates and calculates summary and action counts", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [row()] });
    const result = await getIssuerOverview("issuer-1");
    expect(result).toMatchObject({ summary: { organizationCount: 1, actionRequiredCount: 6, submittedApplications: 3, publishedOfferings: 8 }, organizations: [{ id: "organization-1", verification: { status: "verified" }, team: { activeMembers: 2, pendingInvitations: 1 }, applications: { unresolvedDiligenceItems: 6 }, offerings: { published: 8 } }] });
    expect(postgres.query).toHaveBeenCalledWith(expect.stringContaining("accessible_organizations"), ["issuer-1"]);
  });

  it("marks an expired verification as action-required even when stored status is verified", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [row({ verification_expires_at: new Date("2020-01-01T00:00:00.000Z"), unresolved_diligence_items: "0" })] });
    await expect(getIssuerOverview("issuer-1")).resolves.toMatchObject({ summary: { actionRequiredCount: 1 }, organizations: [{ verification: { status: "expired" }, actionRequiredCount: 1 }] });
  });

  it("fails closed if a database aggregate cannot be represented safely", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [row({ active_members: "-1" })] });
    await expect(getIssuerOverview("issuer-1")).rejects.toThrow("outside the safe integer range");
  });
});
