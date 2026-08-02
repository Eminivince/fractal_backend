import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePostgres } from "../../../db/postgres.js";
import { requirePostgresIdentityForSubject, PostgresIdentityUnavailableError } from "../../../platform/postgres-identities.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import { assertProfessionalDeliverableEvidenceUploadAllowed, createProfessionalWorkOrder, decideProfessionalDeliverable, getIssuerProfessionalDeliverableEvidence, listAssignedProfessionalWorkOrderDeliverables, listAssignedProfessionalWorkOrders, listIssuerProfessionalWorkOrderDeliverables, listIssuerProfessionalWorkOrders, ProfessionalWorkOrderError, recordProfessionalDeliverableEvidence, respondToProfessionalWorkOrder, submitProfessionalDeliverable } from "../../../platform/postgres-professional-work-orders.js";
import { approveProfessionalFinanceApprovalPolicy, approveProfessionalInvoiceTaxTreatment, authorizeProfessionalPayout, authorizeProfessionalReplacementPayout, createProfessionalFinanceApprovalPolicy, createProfessionalInvoiceTaxTreatment, decideProfessionalFinanceExceptionResolution, decideProfessionalInvoice, executeProfessionalFinanceCreditNote, listIssuerProfessionalInvoices, listProfessionalFinanceApprovalPolicies, listProfessionalFinanceExceptions, listProfessionalInvoiceTaxTreatments, listProfessionalPayoutExceptions, listProfessionalPayouts, listProfessionalRecipientRecoveryCases, openProfessionalFinanceException, prepareProfessionalFinanceExceptionResolution, ProfessionalInvoiceError, recordProfessionalFinanceExceptionEvidence, submitProfessionalInvoice, verifyProfessionalPayoutProfile } from "../../../platform/postgres-professional-invoices.js";
import { persistProfessionalFinanceExceptionBinary, persistWorkOrderBinary, retrieveFile } from "../../../services/storage.js";
import { recordStoredDocument } from "../../../services/storage-metadata-guard.js";
import { requireOrganizationAccess, TenantAccessError } from "../../../platform/tenant-access.js";
import { HttpError } from "../../../utils/errors.js";
import { authorize } from "../../../utils/rbac.js";

const date = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const createSchema = z.object({ professionalFirmOrganizationId: z.string().uuid(), assetApplicationRequestId: z.string().uuid(), assignedFirmMembershipId: z.string().uuid(), reference: z.string().trim().min(1).max(200), title: z.string().trim().min(2).max(240), scope: z.string().trim().min(20).max(5000), exclusions: z.string().trim().min(2).max(5000), confidentiality: z.enum(["restricted", "confidential"]), responseDueAt: date, deliveryDueAt: date, feeMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[a-zA-Z]{3}$/) });
const responseSchema = z.object({ response: z.enum(["clarification_requested", "accept", "decline", "conflict"]), reason: z.string().trim().min(2).max(2000).optional() });
const evidenceSchema = z.object({ filename: z.string().trim().min(1).max(240), mimeType: z.literal("application/pdf"), contentBase64: z.string().min(1) });
const submitDeliverableSchema = z.object({ title: z.string().trim().min(2).max(240), submissionSummary: z.string().trim().min(2).max(5000), evidenceDocumentIds: z.array(z.string().uuid()).min(1) });
const deliverableDecisionSchema = z.object({ decision: z.enum(["accepted", "revision_requested", "rejected"]), notes: z.string().trim().min(2).max(2000) });
const invoiceSubmissionSchema = z.object({ deliverableVersionId: z.string().uuid(), reference: z.string().trim().min(3).max(120), dueAt: date });
const invoiceDecisionSchema = z.object({ approve: z.boolean(), reason: z.string().trim().min(1).max(2000).optional() });
const payoutProfileSchema = z.object({ bankCode: z.string().trim().min(2).max(20), accountNumber: z.string().trim().regex(/^\d{10}$/) });
const taxTreatmentSchema = z.object({ jurisdictionCode: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,12})?$/), serviceClass: z.string().trim().min(2).max(120), currency: z.string().trim().regex(/^[A-Za-z]{3}$/), indirectTaxRateBps: z.number().int().min(0).max(10_000), withholdingTaxRateBps: z.number().int().min(0).max(10_000), effectiveFrom: date, effectiveUntil: date.optional(), legalSourceReference: z.string().trim().min(4).max(1000) });
const financeExceptionOpenSchema = z.object({ payoutInstructionId: z.string().uuid().optional(), recipientRecoveryCaseId: z.string().uuid().optional() }).refine((value) => Number(Boolean(value.payoutInstructionId)) + Number(Boolean(value.recipientRecoveryCaseId)) === 1, "Provide exactly one finance exception source");
const financeEvidenceSchema = z.object({ evidenceType: z.enum(["provider_verification", "provider_webhook", "bank_confirmation", "account_ownership", "customer_communication", "accounting_entry", "other"]), filename: z.string().trim().min(1).max(240), mimeType: z.string().trim().min(3).max(120), contentBase64: z.string().min(1) });
const creditNoteSchema = z.object({ reference: z.string().trim().min(3).max(120), grossMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), taxMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), withholdingTaxMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), netCreditMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const replacementPayoutSchema = z.object({ payoutProfileVersionId: z.string().uuid(), amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const financeApprovalPolicySchema = z.object({ resolutionType: z.enum(["credit_note", "replacement_payout", "manual_settlement", "recipient_deactivation_review"]), currency: z.string().trim().regex(/^[A-Za-z]{3}$/), maximumAmountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), effectiveFrom: date, effectiveUntil: date.optional(), policyReference: z.string().trim().min(4).max(1000) });
const financeResolutionSchema = z.discriminatedUnion("resolutionType", [z.object({ resolutionType: z.literal("credit_note"), resolutionReason: z.string().trim().min(8).max(2000), creditNote: creditNoteSchema }), z.object({ resolutionType: z.literal("replacement_payout"), resolutionReason: z.string().trim().min(8).max(2000), replacementPayout: replacementPayoutSchema }), z.object({ resolutionType: z.enum(["provider_settlement_confirmed", "manual_settlement", "recipient_deactivation_review"]), resolutionReason: z.string().trim().min(8).max(2000) })]);
const financeDecisionSchema = z.object({ approve: z.boolean() });

function requireGovernanceActor(request: FastifyRequest) { if (!["issuer", "operator", "admin"].includes(request.authUser.role)) throw new HttpError(403, "Issuer, operator, or admin role required"); }
async function identity(request: FastifyRequest) { if (request.routeOptions.url?.startsWith("/v1/governance/")) requireGovernanceActor(request); try { return await requirePostgresIdentityForSubject(request.authUser.userId); } catch (error) { if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Your account migration is not ready for the governed workflow"); throw error; } }
async function requireHighRiskStepUp(request: FastifyRequest, identityId: string) { try { await requireFreshTotpStepUp({ sessionId: request.authUser.sessionId, identityId }); } catch (error) { if (error instanceof StepUpRequiredError) throw new HttpError(403, error.message); throw error; } }
async function issuerScope(identityId: string, organizationId: string) { try { await requireOrganizationAccess({ identityId, organizationId, allowedRoles: ["owner", "administrator", "compliance_reviewer"] }); } catch (error) { if (error instanceof TenantAccessError) throw new HttpError(403, "You do not have the required organization role"); throw error; } }
function professional<T>(operation: () => Promise<T>) { return operation().catch((error) => { if (error instanceof ProfessionalWorkOrderError) throw new HttpError(422, error.message); throw error; }); }
function invoice<T>(operation: () => Promise<T>) { return operation().catch((error) => { if (error instanceof ProfessionalInvoiceError) throw new HttpError(422, error.message); throw error; }); }
function requireProfessionalActor(request: FastifyRequest) { if (request.authUser.role !== "professional") throw new HttpError(403, "Professional role required"); }

/** New PostgreSQL-authoritative mandate routes; legacy Mongo work orders stay isolated. */
export async function postgresProfessionalWorkOrderRoutes(app: FastifyInstance) {
  app.get("/v1/control/professional-payout-exceptions", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    return { exceptions: await listProfessionalPayoutExceptions() };
  });
  app.get("/v1/control/professional-payout-recipient-recovery-cases", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    return { cases: await listProfessionalRecipientRecoveryCases() };
  });
  app.get("/v1/control/professional-finance-exceptions", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    return { cases: await listProfessionalFinanceExceptions() };
  });
  app.post("/v1/control/professional-finance-exceptions", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    const payload = financeExceptionOpenSchema.parse(request.body); const identityId = await identity(request); return invoice(() => openProfessionalFinanceException({ ...payload, openedByIdentityId: identityId }));
  });
  app.post("/v1/control/professional-finance-exceptions/:financeExceptionCaseId/evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    const financeExceptionCaseId = (request.params as { financeExceptionCaseId: string }).financeExceptionCaseId; const payload = financeEvidenceSchema.parse(request.body); const identityId = await identity(request);
    const stored = await persistProfessionalFinanceExceptionBinary({ financeExceptionCaseId, ...payload });
    return recordStoredDocument({ storageKey: stored.storageKey, source: "professional-finance-evidence", logger: request.log, record: () => invoice(() => recordProfessionalFinanceExceptionEvidence({ financeExceptionCaseId, uploadedByIdentityId: identityId, evidenceType: payload.evidenceType, storageKey: stored.storageKey, filename: payload.filename, mimeType: payload.mimeType, contentSha256: stored.sha256 })) });
  });
  app.post("/v1/control/professional-finance-exceptions/:financeExceptionCaseId/resolution", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    const financeExceptionCaseId = (request.params as { financeExceptionCaseId: string }).financeExceptionCaseId; const payload = financeResolutionSchema.parse(request.body); const identityId = await identity(request); return invoice(() => prepareProfessionalFinanceExceptionResolution({ financeExceptionCaseId, preparedByIdentityId: identityId, resolutionType: payload.resolutionType, resolutionReason: payload.resolutionReason, resolutionPayload: payload.resolutionType === "credit_note" ? { creditNote: payload.creditNote } : payload.resolutionType === "replacement_payout" ? { replacementPayout: payload.replacementPayout } : undefined }));
  });
  app.post("/v1/control/professional-finance-exceptions/:financeExceptionCaseId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    const financeExceptionCaseId = (request.params as { financeExceptionCaseId: string }).financeExceptionCaseId; const payload = financeDecisionSchema.parse(request.body); const identityId = await identity(request); await requireHighRiskStepUp(request, identityId); return invoice(() => decideProfessionalFinanceExceptionResolution({ financeExceptionCaseId, reviewedByIdentityId: identityId, approve: payload.approve }));
  });
  app.post("/v1/control/professional-finance-exceptions/:financeExceptionCaseId/execute-credit-note", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    const financeExceptionCaseId = (request.params as { financeExceptionCaseId: string }).financeExceptionCaseId; const identityId = await identity(request); await requireHighRiskStepUp(request, identityId); return invoice(() => executeProfessionalFinanceCreditNote({ financeExceptionCaseId, executedByIdentityId: identityId }));
  });
  app.post("/v1/control/professional-finance-exceptions/:financeExceptionCaseId/authorize-replacement-payout", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or admin role required");
    const financeExceptionCaseId = (request.params as { financeExceptionCaseId: string }).financeExceptionCaseId; const identityId = await identity(request); await requireHighRiskStepUp(request, identityId); return invoice(() => authorizeProfessionalReplacementPayout({ financeExceptionCaseId, authorizedByIdentityId: identityId }));
  });
  app.get("/v1/governance/organizations/:organizationId/professional-invoice-tax-treatments", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; await issuerScope(await identity(request), organizationId); return { taxTreatments: await listProfessionalInvoiceTaxTreatments(organizationId) };
  });
  app.get("/v1/governance/organizations/:organizationId/professional-finance-approval-policies", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; await issuerScope(await identity(request), organizationId); return { policies: await listProfessionalFinanceApprovalPolicies(organizationId) };
  });
  app.post("/v1/governance/organizations/:organizationId/professional-finance-approval-policies", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; const identityId = await identity(request); await issuerScope(identityId, organizationId); const payload = financeApprovalPolicySchema.parse(request.body); return invoice(() => createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: organizationId, preparedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/governance/professional-finance-approval-policies/:financeApprovalPolicyId/approve", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const financeApprovalPolicyId = (request.params as { financeApprovalPolicyId: string }).financeApprovalPolicyId; const identityId = await identity(request); const scope = await requirePostgres().query<{ issuer_organization_id: string }>("SELECT issuer_organization_id FROM fractal.professional_finance_approval_policies WHERE id = $1", [financeApprovalPolicyId]); if (!scope.rows[0]) throw new HttpError(404, "Finance approval policy not found"); await issuerScope(identityId, scope.rows[0].issuer_organization_id); await requireHighRiskStepUp(request, identityId); return invoice(() => approveProfessionalFinanceApprovalPolicy({ financeApprovalPolicyId, approvedByIdentityId: identityId }));
  });
  app.post("/v1/governance/organizations/:organizationId/professional-invoice-tax-treatments", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; const identityId = await identity(request); await issuerScope(identityId, organizationId); const payload = taxTreatmentSchema.parse(request.body); return invoice(() => createProfessionalInvoiceTaxTreatment({ issuerOrganizationId: organizationId, preparedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/governance/professional-invoice-tax-treatments/:taxTreatmentId/approve", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const taxTreatmentId = (request.params as { taxTreatmentId: string }).taxTreatmentId; const identityId = await identity(request); const scope = await requirePostgres().query<{ issuer_organization_id: string }>("SELECT issuer_organization_id FROM fractal.professional_invoice_tax_treatments WHERE id = $1", [taxTreatmentId]); if (!scope.rows[0]) throw new HttpError(404, "Tax treatment not found"); await issuerScope(identityId, scope.rows[0].issuer_organization_id); await requireHighRiskStepUp(request, identityId); return invoice(() => approveProfessionalInvoiceTaxTreatment({ taxTreatmentId, approvedByIdentityId: identityId }));
  });
  app.get("/v1/governance/organizations/:organizationId/professional-work-orders", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; await issuerScope(await identity(request), organizationId); return { workOrders: await listIssuerProfessionalWorkOrders(organizationId) };
  });
  app.post("/v1/governance/organizations/:organizationId/professional-work-orders", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "create", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; const identityId = await identity(request); await issuerScope(identityId, organizationId); const payload = createSchema.parse(request.body); return professional(() => createProfessionalWorkOrder({ issuerOrganizationId: organizationId, invitedByIdentityId: identityId, ...payload }));
  });
  app.get("/v1/professional/work-orders", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "read", "work_order"); return { workOrders: await listAssignedProfessionalWorkOrders(await identity(request)) };
  });
  app.get("/v1/professional/payments", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "read", "work_order"); return { payments: await listProfessionalPayouts(await identity(request)) };
  });
  app.get("/v1/professional/work-orders/:workOrderId/deliverables", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "read", "work_order"); const workOrderId = (request.params as { workOrderId: string }).workOrderId; return professional(async () => ({ deliverables: await listAssignedProfessionalWorkOrderDeliverables(workOrderId, await identity(request)) }));
  });
  app.get("/v1/governance/organizations/:organizationId/professional-work-orders/:workOrderId/deliverables", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "work_order"); const { organizationId, workOrderId } = request.params as { organizationId: string; workOrderId: string }; await issuerScope(await identity(request), organizationId); return professional(async () => ({ deliverables: await listIssuerProfessionalWorkOrderDeliverables({ issuerOrganizationId: organizationId, workOrderId }) }));
  });
  app.get("/v1/governance/organizations/:organizationId/professional-deliverable-evidence/:evidenceDocumentId/download", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    authorize(request.authUser, "read", "work_order"); const { organizationId, evidenceDocumentId } = request.params as { organizationId: string; evidenceDocumentId: string }; await issuerScope(await identity(request), organizationId); const evidence = await professional(() => getIssuerProfessionalDeliverableEvidence({ issuerOrganizationId: organizationId, evidenceDocumentId })); const file = await retrieveFile(evidence.storageKey); if (file.redirectUrl) throw new HttpError(409, "This evidence storage provider cannot be integrity-validated for governed download"); if (createHash("sha256").update(file.buffer).digest("hex") !== evidence.contentSha256) throw new HttpError(409, "Professional deliverable evidence failed integrity validation"); reply.header("Content-Type", evidence.mimeType); reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(evidence.filename)}`); reply.header("X-Content-Type-Options", "nosniff"); return reply.send(file.buffer);
  });
  app.post("/v1/professional/work-orders/:workOrderId/response", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "update", "work_order"); const workOrderId = (request.params as { workOrderId: string }).workOrderId; const payload = responseSchema.parse(request.body); const identityId = await identity(request); return professional(() => respondToProfessionalWorkOrder({ workOrderId, actorIdentityId: identityId, ...payload }));
  });
  app.post("/v1/professional/work-orders/:workOrderId/deliverable-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "submit", "work_order"); const workOrderId = (request.params as { workOrderId: string }).workOrderId; const payload = evidenceSchema.parse(request.body); const identityId = await identity(request); await professional(() => assertProfessionalDeliverableEvidenceUploadAllowed({ workOrderId, identityId })); const stored = await persistWorkOrderBinary({ workOrderId, ...payload }); return recordStoredDocument({ storageKey: stored.storageKey, source: "professional-deliverable-evidence", logger: request.log, record: () => professional(() => recordProfessionalDeliverableEvidence({ workOrderId, uploadedByIdentityId: identityId, filename: payload.filename, mimeType: payload.mimeType, storageKey: stored.storageKey, contentSha256: stored.sha256, bytes: stored.bytes })) });
  });
  app.post("/v1/professional/work-orders/:workOrderId/deliverables", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "submit", "work_order"); const workOrderId = (request.params as { workOrderId: string }).workOrderId; const identityId = await identity(request); const payload = submitDeliverableSchema.parse(request.body); return professional(() => submitProfessionalDeliverable({ workOrderId, submittedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/professional/work-orders/:workOrderId/invoices", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "submit", "work_order"); const workOrderId = (request.params as { workOrderId: string }).workOrderId; const identityId = await identity(request); const payload = invoiceSubmissionSchema.parse(request.body); return invoice(() => submitProfessionalInvoice({ workOrderId, submittedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/professional/firms/:firmOrganizationId/payout-profile", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    requireProfessionalActor(request); authorize(request.authUser, "update", "work_order"); const firmOrganizationId = (request.params as { firmOrganizationId: string }).firmOrganizationId; const payload = payoutProfileSchema.parse(request.body); const identityId = await identity(request); await requireHighRiskStepUp(request, identityId); return invoice(() => verifyProfessionalPayoutProfile({ firmOrganizationId, actorIdentityId: identityId, ...payload }));
  });
  app.get("/v1/governance/organizations/:organizationId/professional-invoices", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "work_order"); const organizationId = (request.params as { organizationId: string }).organizationId; await issuerScope(await identity(request), organizationId); return { invoices: await listIssuerProfessionalInvoices(organizationId) };
  });
  app.post("/v1/governance/professional-deliverables/:deliverableVersionId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const deliverableVersionId = (request.params as { deliverableVersionId: string }).deliverableVersionId; const identityId = await identity(request); const issuer = await requirePostgres().query<{ issuer_organization_id: string }>("SELECT work_order.issuer_organization_id FROM fractal.professional_deliverable_versions deliverable JOIN fractal.professional_work_orders work_order ON work_order.id = deliverable.work_order_id WHERE deliverable.id = $1", [deliverableVersionId]); if (!issuer.rows[0]) throw new HttpError(404, "Professional deliverable not found"); await issuerScope(identityId, issuer.rows[0].issuer_organization_id); await requireHighRiskStepUp(request, identityId); const payload = deliverableDecisionSchema.parse(request.body); return professional(() => decideProfessionalDeliverable({ deliverableVersionId, reviewedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/governance/professional-invoices/:invoiceId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const invoiceId = (request.params as { invoiceId: string }).invoiceId; const identityId = await identity(request); const issuer = await requirePostgres().query<{ issuer_organization_id: string }>("SELECT work_order.issuer_organization_id FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE invoice.id = $1", [invoiceId]); if (!issuer.rows[0]) throw new HttpError(404, "Professional invoice not found"); await issuerScope(identityId, issuer.rows[0].issuer_organization_id); await requireHighRiskStepUp(request, identityId); const payload = invoiceDecisionSchema.parse(request.body); return invoice(() => decideProfessionalInvoice({ invoiceId, decidedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/governance/professional-invoices/:invoiceId/payout-instruction", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "review", "work_order"); const invoiceId = (request.params as { invoiceId: string }).invoiceId; const identityId = await identity(request); const issuer = await requirePostgres().query<{ issuer_organization_id: string }>("SELECT work_order.issuer_organization_id FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE invoice.id = $1", [invoiceId]); if (!issuer.rows[0]) throw new HttpError(404, "Professional invoice not found"); await issuerScope(identityId, issuer.rows[0].issuer_organization_id); await requireHighRiskStepUp(request, identityId); return invoice(() => authorizeProfessionalPayout({ invoiceId, authorizedByIdentityId: identityId }));
  });
}
