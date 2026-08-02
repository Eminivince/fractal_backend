import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ runFind: vi.fn(), runFindById: vi.fn(), issueFind: vi.fn(), issueFindById: vi.fn(), run: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ ReconciliationRunModel: { find: mocks.runFind, findById: mocks.runFindById }, ReconciliationIssueModel: { find: mocks.issueFind, findById: mocks.issueFindById } }));
vi.mock("../../../../services/reconciliation.js", () => ({ runReconciliation: mocks.run }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { reconciliationRoutes } from "../reconciliation.routes.js";

let role = "operator";
let app: ReturnType<typeof Fastify>;
const runId = "run-1";
const issueId = "issue-1";
function chain(value: unknown) { return { sort: vi.fn(() => ({ limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })), lean: vi.fn().mockResolvedValue(value) }; }
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "operator"; mocks.serialize.mockImplementation((value: unknown) => value); mocks.appendEvent.mockResolvedValue(undefined); mocks.run.mockResolvedValue({ runId, status: "ok" });
  mocks.runFind.mockReturnValue(chain([{ _id: runId, status: "ok" }])); mocks.issueFind.mockReturnValue(chain([{ _id: issueId, runId }])); mocks.runFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: runId }) });
  mocks.issueFindById.mockResolvedValue({ _id: issueId, runId, status: "open", save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ _id: issueId, status: "resolved" })) });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "operator-1", role }; });
  await app.register(reconciliationRoutes);
});
afterEach(async () => { await app.close(); });

describe("reconciliation routes", () => {
  it("runs reconciliation only for operational authority and records its evidence", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/reconciliation/run", payload: { source: "bank" } });
    expect(response.statusCode).toBe(200); expect(mocks.run).toHaveBeenCalledWith("bank");
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ role: "operator" }), expect.objectContaining({ entityId: runId, action: "ReconciliationRunTriggered" }));
    await expect(app.inject({ method: "POST", url: "/v1/reconciliation/run", payload: {} })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.run).toHaveBeenLastCalledWith("manual");
  });

  it("lists controlled runs and run-specific issues", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/reconciliation/runs?status=mismatch&limit=25" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.runFind).toHaveBeenCalledWith({ status: "mismatch" });
    await expect(app.inject({ method: "GET", url: `/v1/reconciliation/runs/${runId}/issues?status=open&limit=50` })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.issueFind).toHaveBeenCalledWith({ runId, status: "open" });
  });

  it("resolves a real issue and stores the operator reason", async () => {
    const response = await app.inject({ method: "POST", url: `/v1/reconciliation/issues/${issueId}/resolve`, payload: { note: "Provider settlement has now been matched." } });
    expect(response.statusCode).toBe(200);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "ReconciliationIssueResolved" }));
  });

  it("fails closed for non-operators, invalid input, missing runs, and missing issues", async () => {
    role = "investor";
    await expect(app.inject({ method: "POST", url: "/v1/reconciliation/run", payload: {} })).resolves.toMatchObject({ statusCode: 403 });
    await expect(app.inject({ method: "POST", url: `/v1/reconciliation/issues/${issueId}/resolve`, payload: { note: "This note has valid length." } })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator";
    await expect(app.inject({ method: "GET", url: "/v1/reconciliation/runs?limit=0" })).resolves.toMatchObject({ statusCode: 400 });
    mocks.runFindById.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    await expect(app.inject({ method: "GET", url: "/v1/reconciliation/runs/missing/issues" })).resolves.toMatchObject({ statusCode: 404 });
    mocks.issueFindById.mockResolvedValueOnce(null);
    await expect(app.inject({ method: "POST", url: "/v1/reconciliation/issues/missing/resolve", payload: { note: "This note has valid length." } })).resolves.toMatchObject({ statusCode: 404 });
  });
});
