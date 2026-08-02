import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { listAllocationChainOperations, materializeAllocationChainOperations, releaseMintOperation } from "../postgres-allocation-chain-operations.js";

const operation = (overrides: Record<string, unknown> = {}) => ({ id: "whitelist-1", allocation_request_id: "allocation-1", organization_id: "organization-1", offering_id: "offering-1", chain_id: 8453, token_contract_address: "0xtoken", wallet_address: "0xwallet", token_amount: "100", operation_type: "whitelist", status: "confirmed", transaction_hash: "0xtx", submitted_at: new Date("2026-07-29T09:00:00.000Z"), confirmed_at: new Date("2026-07-29T10:00:00.000Z"), failure_reason: null, requires_manual_reconciliation: false, created_at: new Date("2026-07-29T08:00:00.000Z"), updated_at: new Date("2026-07-29T10:00:00.000Z"), ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("allocation chain operations", () => {
  it("materializes only whitelist operations for approved allocations with confirmed matching deployments", async () => {
    const allocation = { allocation_id: "allocation-1", organization_id: "organization-1", offering_id: "offering-1", chain_id: 8453, wallet_address: "0xwallet", token_amount: "100", token_contract_address: "0xtoken" };
    transactionWithResponses({ rows: [allocation], rowCount: 1 }, {});
    await expect(materializeAllocationChainOperations(10)).resolves.toBe(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "investment.allocation.whitelist_approved" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "investment.allocation.whitelist_approved" }));
    transactionWithResponses({ rows: [], rowCount: 0 });
    await expect(materializeAllocationChainOperations()).resolves.toBe(0);
  });

  it("releases one mint only after a confirmed whitelist and reuses an existing mint", async () => {
    transactionWithResponses({ rows: [operation()] }, { rows: [] }, {});
    await expect(releaseMintOperation({ whitelistOperationId: "whitelist-1" })).resolves.toEqual(expect.any(String));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "investment.allocation.mint_approved" }));
    transactionWithResponses({ rows: [operation()] }, { rows: [{ id: "mint-existing" }] });
    await expect(releaseMintOperation({ whitelistOperationId: "whitelist-1" })).resolves.toBe("mint-existing");
  });

  it("does not release a mint before whitelist confirmation", async () => {
    transactionWithResponses({ rows: [operation({ status: "submitted" })] });
    await expect(releaseMintOperation({ whitelistOperationId: "whitelist-1" })).rejects.toThrow("confirmed whitelist");
  });

  it("maps allocation operations and exposes reconciliation status", async () => {
    mocks.postgres.query.mockResolvedValueOnce({ rows: [operation({ requires_manual_reconciliation: true })] });
    await expect(listAllocationChainOperations({ organizationId: "organization-1", allocationRequestId: "allocation-1" })).resolves.toEqual([expect.objectContaining({ id: "whitelist-1", tokenAmount: "100", requiresManualReconciliation: true, confirmedAt: "2026-07-29T10:00:00.000Z" })]);
  });
});
