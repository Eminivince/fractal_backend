import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { ensureLedgerAccount, postJournalInTransaction, reverseJournal } from "./postgres-journal.js";
import { createPaystackTransferRecipient, resolvePaystackAccount } from "../services/paystack.js";

export class ProfessionalInvoiceError extends Error {}

export type ProfessionalPayoutProviderOutcome = "success" | "failed" | "reversed";

function bounded(value: string, field: string, min: number, max: number) { const result = value.trim(); if (result.length < min || result.length > max) throw new ProfessionalInvoiceError(`${field} must be between ${min} and ${max} characters`); return result; }
function percentageMinor(grossMinor: string, basisPoints: number) { return ((BigInt(grossMinor) * BigInt(basisPoints) + 5_000n) / 10_000n).toString(); }

const professionalAccountingAccounts = {
  serviceExpense: "EXPENSE.PROFESSIONAL_SERVICES",
  inputTax: "ASSET.PROFESSIONAL_INPUT_TAX",
  accountsPayable: "LIABILITY.PROFESSIONAL_ACCOUNTS_PAYABLE",
  withholdingPayable: "LIABILITY.PROFESSIONAL_WITHHOLDING_TAX",
  operatingCash: "ASSET.OPERATING_CASH",
} as const;

function professionalAccountCode(prefix: string, currency: string) { return `${prefix}.${currency}`; }

async function ensureProfessionalAccountingAccounts(client: PoolClient, organizationId: string, currency: string) {
  const accounts = [
    { organizationId, code: professionalAccountCode(professionalAccountingAccounts.serviceExpense, currency), name: `Professional services expense (${currency})`, accountType: "expense" as const, normalBalance: "debit" as const },
    { organizationId, code: professionalAccountCode(professionalAccountingAccounts.inputTax, currency), name: `Professional input tax (${currency})`, accountType: "asset" as const, normalBalance: "debit" as const },
    { organizationId, code: professionalAccountCode(professionalAccountingAccounts.accountsPayable, currency), name: `Professional accounts payable (${currency})`, accountType: "liability" as const, normalBalance: "credit" as const },
    { organizationId, code: professionalAccountCode(professionalAccountingAccounts.withholdingPayable, currency), name: `Professional withholding tax payable (${currency})`, accountType: "liability" as const, normalBalance: "credit" as const },
    { organizationId, code: professionalAccountCode(professionalAccountingAccounts.operatingCash, currency), name: `Operating cash (${currency})`, accountType: "asset" as const, normalBalance: "debit" as const },
  ];
  for (const account of accounts) await ensureLedgerAccount(client, account);
}

async function postProfessionalInvoiceAccrual(client: PoolClient, input: { organizationId: string; invoiceId: string; reference: string; currency: string; grossMinor: string; taxMinor: string; withholdingTaxMinor: string; netPayableMinor: string }) {
  const gross = BigInt(input.grossMinor); const tax = BigInt(input.taxMinor); const withholding = BigInt(input.withholdingTaxMinor); const netPayable = BigInt(input.netPayableMinor);
  if (gross <= 0n || netPayable <= 0n) throw new ProfessionalInvoiceError("Professional invoice must have a positive governed accrual before approval");
  await ensureProfessionalAccountingAccounts(client, input.organizationId, input.currency);
  return postJournalInTransaction(client, {
    scopeKey: `organization:${input.organizationId}`,
    organizationId: input.organizationId,
    idempotencyKey: `professional-invoice-accrual:${input.invoiceId}`,
    currency: input.currency,
    narrative: `Professional invoice accrual ${input.reference}`,
    externalRef: input.reference,
    metadata: { professionalInvoiceId: input.invoiceId, professionalInvoiceReference: input.reference, accountingEvent: "professional_invoice_accrual" },
    postings: [
      { accountCode: professionalAccountCode(professionalAccountingAccounts.serviceExpense, input.currency), direction: "debit", amountMinor: gross },
      ...(tax > 0n ? [{ accountCode: professionalAccountCode(professionalAccountingAccounts.inputTax, input.currency), direction: "debit" as const, amountMinor: tax }] : []),
      { accountCode: professionalAccountCode(professionalAccountingAccounts.accountsPayable, input.currency), direction: "credit", amountMinor: netPayable },
      ...(withholding > 0n ? [{ accountCode: professionalAccountCode(professionalAccountingAccounts.withholdingPayable, input.currency), direction: "credit" as const, amountMinor: withholding }] : []),
    ],
  });
}

async function postProfessionalPayoutSettlement(client: PoolClient, input: { organizationId: string; payoutInstructionId: string; reference: string; currency: string; amountMinor: string; occurredAt: Date }) {
  await ensureProfessionalAccountingAccounts(client, input.organizationId, input.currency);
  return postJournalInTransaction(client, {
    scopeKey: `organization:${input.organizationId}`,
    organizationId: input.organizationId,
    idempotencyKey: `professional-payout-settlement:${input.payoutInstructionId}`,
    currency: input.currency,
    narrative: `Professional payout settlement ${input.reference}`,
    externalRef: input.reference,
    effectiveAt: input.occurredAt,
    metadata: { professionalPayoutInstructionId: input.payoutInstructionId, professionalPayoutReference: input.reference, accountingEvent: "professional_payout_settlement" },
    postings: [
      { accountCode: professionalAccountCode(professionalAccountingAccounts.accountsPayable, input.currency), direction: "debit", amountMinor: BigInt(input.amountMinor) },
      { accountCode: professionalAccountCode(professionalAccountingAccounts.operatingCash, input.currency), direction: "credit", amountMinor: BigInt(input.amountMinor) },
    ],
  });
}

async function postProfessionalCreditNote(client: PoolClient, input: { organizationId: string; creditNoteId: string; invoiceId: string; reference: string; currency: string; grossMinor: number; taxMinor: number; withholdingTaxMinor: number; netCreditMinor: number }) {
  await ensureProfessionalAccountingAccounts(client, input.organizationId, input.currency);
  return postJournalInTransaction(client, {
    scopeKey: `organization:${input.organizationId}`,
    organizationId: input.organizationId,
    idempotencyKey: `professional-credit-note:${input.creditNoteId}`,
    currency: input.currency,
    narrative: `Professional invoice credit note ${input.reference}`,
    externalRef: input.reference,
    metadata: { professionalCreditNoteId: input.creditNoteId, professionalInvoiceId: input.invoiceId, professionalCreditNoteReference: input.reference, accountingEvent: "professional_invoice_credit_note" },
    postings: [
      { accountCode: professionalAccountCode(professionalAccountingAccounts.accountsPayable, input.currency), direction: "debit", amountMinor: input.netCreditMinor },
      ...(input.withholdingTaxMinor > 0 ? [{ accountCode: professionalAccountCode(professionalAccountingAccounts.withholdingPayable, input.currency), direction: "debit" as const, amountMinor: input.withholdingTaxMinor }] : []),
      { accountCode: professionalAccountCode(professionalAccountingAccounts.serviceExpense, input.currency), direction: "credit", amountMinor: input.grossMinor },
      ...(input.taxMinor > 0 ? [{ accountCode: professionalAccountCode(professionalAccountingAccounts.inputTax, input.currency), direction: "credit" as const, amountMinor: input.taxMinor }] : []),
    ],
  });
}

async function requireProfessionalFinanceApprovalPolicy(client: PoolClient, input: { issuerOrganizationId: string; resolutionType: "credit_note" | "replacement_payout"; currency: string; amountMinor: number }) {
  const policy = await client.query<{ id: string; maximum_amount_minor: string; currently_effective: boolean }>(`SELECT id, maximum_amount_minor,
      (effective_until IS NULL OR effective_until > now()) AS currently_effective
    FROM fractal.professional_finance_approval_policies
    WHERE issuer_organization_id = $1 AND resolution_type = $2 AND currency = $3 AND status = 'active'
      AND effective_from <= now()
    ORDER BY effective_from DESC, version DESC LIMIT 1 FOR SHARE`, [input.issuerOrganizationId, input.resolutionType, input.currency]);
  const active = policy.rows[0];
  // The newest effective policy is authoritative. Do not fall back to an older limit after it expires:
  // that would silently reactivate a superseded financial authority.
  if (!active || !active.currently_effective || BigInt(input.amountMinor) > BigInt(active.maximum_amount_minor)) throw new ProfessionalInvoiceError(`No active finance approval policy permits this ${input.resolutionType} amount`);
  return active.id;
}

export async function createProfessionalFinanceApprovalPolicy(input: { issuerOrganizationId: string; preparedByIdentityId: string; resolutionType: "credit_note" | "replacement_payout" | "manual_settlement" | "recipient_deactivation_review"; currency: string; maximumAmountMinor: number; effectiveFrom: Date; effectiveUntil?: Date; policyReference: string }) {
  if (!Number.isSafeInteger(input.maximumAmountMinor) || input.maximumAmountMinor <= 0) throw new ProfessionalInvoiceError("maximumAmountMinor must be a positive safe integer");
  if (!(input.effectiveFrom instanceof Date) || Number.isNaN(input.effectiveFrom.valueOf()) || (input.effectiveUntil && (!(input.effectiveUntil instanceof Date) || input.effectiveUntil <= input.effectiveFrom))) throw new ProfessionalInvoiceError("Finance approval-policy effective dates are invalid");
  return withPostgresTransaction(async (client) => {
    const organization = await client.query("SELECT id FROM fractal.organizations WHERE id = $1 FOR UPDATE", [input.issuerOrganizationId]); if (!organization.rowCount) throw new ProfessionalInvoiceError("Issuer organization was not found");
    const next = await client.query<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM fractal.professional_finance_approval_policies WHERE issuer_organization_id = $1", [input.issuerOrganizationId]);
    const id = randomUUID(); const currency = bounded(input.currency.toUpperCase(), "currency", 3, 3);
    await client.query(`INSERT INTO fractal.professional_finance_approval_policies (id, issuer_organization_id, version, resolution_type, currency, maximum_amount_minor, effective_from, effective_until, policy_reference, status, prepared_by_identity_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`, [id, input.issuerOrganizationId, next.rows[0]!.version, input.resolutionType, currency, input.maximumAmountMinor, input.effectiveFrom, input.effectiveUntil ?? null, bounded(input.policyReference, "policyReference", 4, 1000), input.preparedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.issuerOrganizationId}`, organizationId: input.issuerOrganizationId, actorId: input.preparedByIdentityId, actorType: "user", action: "professional_finance_approval_policy.prepared", entityType: "professional_finance_approval_policy", entityId: id, payload: { resolutionType: input.resolutionType, currency, maximumAmountMinor: input.maximumAmountMinor, version: next.rows[0]!.version } });
    await appendOutboxEvent(client, { aggregateType: "professional_finance_approval_policy", aggregateId: id, eventType: "professional_finance_approval_policy.prepared", payload: { issuerOrganizationId: input.issuerOrganizationId, auditEventId: audit.id } });
    return { financeApprovalPolicyId: id, version: next.rows[0]!.version, status: "draft" as const };
  });
}

export async function approveProfessionalFinanceApprovalPolicy(input: { financeApprovalPolicyId: string; approvedByIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ issuer_organization_id: string; prepared_by_identity_id: string; status: string }>("SELECT issuer_organization_id, prepared_by_identity_id, status FROM fractal.professional_finance_approval_policies WHERE id = $1 FOR UPDATE", [input.financeApprovalPolicyId]);
    const policy = result.rows[0]; if (!policy || policy.status !== "draft") throw new ProfessionalInvoiceError("Finance approval policy is not awaiting approval");
    if (policy.prepared_by_identity_id === input.approvedByIdentityId) throw new ProfessionalInvoiceError("A different person must approve this finance approval policy");
    await client.query("UPDATE fractal.professional_finance_approval_policies SET status = 'active', approved_by_identity_id = $2, approved_at = now() WHERE id = $1", [input.financeApprovalPolicyId, input.approvedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${policy.issuer_organization_id}`, organizationId: policy.issuer_organization_id, actorId: input.approvedByIdentityId, actorType: "user", action: "professional_finance_approval_policy.activated", entityType: "professional_finance_approval_policy", entityId: input.financeApprovalPolicyId, payload: {} });
    await appendOutboxEvent(client, { aggregateType: "professional_finance_approval_policy", aggregateId: input.financeApprovalPolicyId, eventType: "professional_finance_approval_policy.activated", payload: { issuerOrganizationId: policy.issuer_organization_id, auditEventId: audit.id } });
    return { financeApprovalPolicyId: input.financeApprovalPolicyId, status: "active" as const };
  });
}

export async function listProfessionalFinanceApprovalPolicies(issuerOrganizationId: string) {
  const result = await requirePostgres().query<{ id: string; version: number; resolution_type: string; currency: string; maximum_amount_minor: string; effective_from: Date; effective_until: Date | null; policy_reference: string; status: string; prepared_by_identity_id: string; approved_by_identity_id: string | null; approved_at: Date | null }>("SELECT id, version, resolution_type, currency, maximum_amount_minor, effective_from, effective_until, policy_reference, status, prepared_by_identity_id, approved_by_identity_id, approved_at FROM fractal.professional_finance_approval_policies WHERE issuer_organization_id = $1 ORDER BY version DESC", [issuerOrganizationId]);
  return result.rows.map((row) => ({ id: row.id, version: row.version, resolutionType: row.resolution_type, currency: row.currency, maximumAmountMinor: row.maximum_amount_minor, effectiveFrom: row.effective_from.toISOString(), effectiveUntil: row.effective_until?.toISOString() ?? null, policyReference: row.policy_reference, status: row.status, preparedByIdentityId: row.prepared_by_identity_id, approvedByIdentityId: row.approved_by_identity_id, approvedAt: row.approved_at?.toISOString() ?? null }));
}

export async function createProfessionalInvoiceTaxTreatment(input: { issuerOrganizationId: string; preparedByIdentityId: string; jurisdictionCode: string; serviceClass: string; currency: string; indirectTaxRateBps: number; withholdingTaxRateBps: number; effectiveFrom: Date; effectiveUntil?: Date; legalSourceReference: string }) {
  if (!Number.isInteger(input.indirectTaxRateBps) || input.indirectTaxRateBps < 0 || input.indirectTaxRateBps > 10_000 || !Number.isInteger(input.withholdingTaxRateBps) || input.withholdingTaxRateBps < 0 || input.withholdingTaxRateBps > 10_000) throw new ProfessionalInvoiceError("Tax rates must be whole basis points between 0 and 10000");
  if (!(input.effectiveFrom instanceof Date) || Number.isNaN(input.effectiveFrom.valueOf()) || (input.effectiveUntil && (!(input.effectiveUntil instanceof Date) || input.effectiveUntil <= input.effectiveFrom))) throw new ProfessionalInvoiceError("Tax treatment effective dates are invalid");
  return withPostgresTransaction(async (client) => {
    const organization = await client.query("SELECT id FROM fractal.organizations WHERE id = $1 FOR UPDATE", [input.issuerOrganizationId]); if (!organization.rowCount) throw new ProfessionalInvoiceError("Issuer organization was not found");
    const next = await client.query<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM fractal.professional_invoice_tax_treatments WHERE issuer_organization_id = $1", [input.issuerOrganizationId]);
    const id = randomUUID();
    await client.query(`INSERT INTO fractal.professional_invoice_tax_treatments (id, issuer_organization_id, version, jurisdiction_code, service_class, currency, indirect_tax_rate_bps, withholding_tax_rate_bps, effective_from, effective_until, legal_source_reference, status, prepared_by_identity_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12)`, [id, input.issuerOrganizationId, next.rows[0]!.version, bounded(input.jurisdictionCode.toUpperCase(), "jurisdictionCode", 2, 16), bounded(input.serviceClass, "serviceClass", 2, 120), bounded(input.currency.toUpperCase(), "currency", 3, 3), input.indirectTaxRateBps, input.withholdingTaxRateBps, input.effectiveFrom, input.effectiveUntil ?? null, bounded(input.legalSourceReference, "legalSourceReference", 4, 1000), input.preparedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.issuerOrganizationId}`, organizationId: input.issuerOrganizationId, actorId: input.preparedByIdentityId, actorType: "user", action: "professional_invoice_tax_treatment.prepared", entityType: "professional_invoice_tax_treatment", entityId: id, payload: { currency: input.currency.toUpperCase(), jurisdictionCode: input.jurisdictionCode.toUpperCase(), serviceClass: input.serviceClass.trim(), version: next.rows[0]!.version } });
    await appendOutboxEvent(client, { aggregateType: "professional_invoice_tax_treatment", aggregateId: id, eventType: "professional_invoice_tax_treatment.prepared", payload: { issuerOrganizationId: input.issuerOrganizationId, auditEventId: audit.id } });
    return { taxTreatmentId: id, version: next.rows[0]!.version, status: "draft" as const };
  });
}

export async function approveProfessionalInvoiceTaxTreatment(input: { taxTreatmentId: string; approvedByIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ issuer_organization_id: string; prepared_by_identity_id: string; status: string }>("SELECT issuer_organization_id, prepared_by_identity_id, status FROM fractal.professional_invoice_tax_treatments WHERE id = $1 FOR UPDATE", [input.taxTreatmentId]);
    const treatment = result.rows[0]; if (!treatment || treatment.status !== "draft") throw new ProfessionalInvoiceError("Tax treatment is not awaiting approval");
    if (treatment.prepared_by_identity_id === input.approvedByIdentityId) throw new ProfessionalInvoiceError("A different person must approve this tax treatment");
    await client.query("UPDATE fractal.professional_invoice_tax_treatments SET status = 'active', approved_by_identity_id = $2, approved_at = now() WHERE id = $1", [input.taxTreatmentId, input.approvedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${treatment.issuer_organization_id}`, organizationId: treatment.issuer_organization_id, actorId: input.approvedByIdentityId, actorType: "user", action: "professional_invoice_tax_treatment.activated", entityType: "professional_invoice_tax_treatment", entityId: input.taxTreatmentId, payload: {} });
    await appendOutboxEvent(client, { aggregateType: "professional_invoice_tax_treatment", aggregateId: input.taxTreatmentId, eventType: "professional_invoice_tax_treatment.activated", payload: { issuerOrganizationId: treatment.issuer_organization_id, auditEventId: audit.id } });
    return { taxTreatmentId: input.taxTreatmentId, status: "active" as const };
  });
}

export async function listProfessionalInvoiceTaxTreatments(issuerOrganizationId: string) {
  const result = await requirePostgres().query<{ id: string; version: number; jurisdiction_code: string; service_class: string; currency: string; indirect_tax_rate_bps: number; withholding_tax_rate_bps: number; effective_from: Date; effective_until: Date | null; legal_source_reference: string; status: string; prepared_by_identity_id: string; approved_by_identity_id: string | null; approved_at: Date | null }>("SELECT id, version, jurisdiction_code, service_class, currency, indirect_tax_rate_bps, withholding_tax_rate_bps, effective_from, effective_until, legal_source_reference, status, prepared_by_identity_id, approved_by_identity_id, approved_at FROM fractal.professional_invoice_tax_treatments WHERE issuer_organization_id = $1 ORDER BY version DESC", [issuerOrganizationId]);
  return result.rows.map((row) => ({ id: row.id, version: row.version, jurisdictionCode: row.jurisdiction_code, serviceClass: row.service_class, currency: row.currency, indirectTaxRateBps: row.indirect_tax_rate_bps, withholdingTaxRateBps: row.withholding_tax_rate_bps, effectiveFrom: row.effective_from.toISOString(), effectiveUntil: row.effective_until?.toISOString() ?? null, legalSourceReference: row.legal_source_reference, status: row.status, preparedByIdentityId: row.prepared_by_identity_id, approvedByIdentityId: row.approved_by_identity_id, approvedAt: row.approved_at?.toISOString() ?? null }));
}

export async function verifyProfessionalPayoutProfile(input: { firmOrganizationId: string; actorIdentityId: string; bankCode: string; accountNumber: string }) {
  const accountNumber = input.accountNumber.replace(/\s/g, ""); if (!/^\d{10}$/.test(accountNumber)) throw new ProfessionalInvoiceError("A 10-digit Nigerian bank account number is required");
  const access = await requirePostgres().query("SELECT 1 FROM fractal.professional_firm_memberships WHERE firm_organization_id = $1 AND identity_id = $2 AND status = 'active'", [input.firmOrganizationId, input.actorIdentityId]); if (!access.rowCount) throw new ProfessionalInvoiceError("You are not an active member of this professional firm");
  const resolved = await resolvePaystackAccount({ accountNumber, bankCode: bounded(input.bankCode, "bankCode", 2, 20) });
  const recipient = await createPaystackTransferRecipient({ name: resolved.account_name, accountNumber, bankCode: input.bankCode });
  try {
    return await withPostgresTransaction(async (client) => { const next = await client.query<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM fractal.professional_payout_profile_versions WHERE firm_organization_id = $1 FOR UPDATE", [input.firmOrganizationId]); const id = randomUUID(); await client.query("INSERT INTO fractal.professional_payout_profile_versions (id, firm_organization_id, version, rail, currency, account_holder_name, account_last4, provider_recipient_reference, status, verified_by_identity_id) VALUES ($1,$2,$3,'bank_transfer','NGN',$4,$5,$6,'verified',$7)", [id, input.firmOrganizationId, next.rows[0]!.version, resolved.account_name, accountNumber.slice(-4), recipient.recipient_code, input.actorIdentityId]); return { payoutProfileVersionId: id, accountHolderName: resolved.account_name, accountLast4: accountNumber.slice(-4) }; });
  } catch (error) {
    const existing = await requirePostgres().query<{ id: string }>("SELECT id FROM fractal.professional_payout_profile_versions WHERE provider_recipient_reference = $1", [recipient.recipient_code]).catch(() => null);
    if (!existing?.rowCount) {
      const reason = error instanceof Error ? error.message : String(error);
      await requirePostgres().query("INSERT INTO fractal.professional_payout_recipient_recovery_cases (id, firm_organization_id, provider, provider_recipient_reference, failure_reason) VALUES ($1,$2,'paystack',$3,$4) ON CONFLICT (provider_recipient_reference) DO NOTHING", [randomUUID(), input.firmOrganizationId, recipient.recipient_code, reason.slice(0, 2_000)]).catch(() => undefined);
    }
    throw error;
  }
}

export async function listIssuerProfessionalInvoices(issuerOrganizationId: string) {
  const result = await requirePostgres().query<{ id: string; reference: string; work_order_id: string; deliverable_version_id: string; currency: string; gross_minor: string; net_payable_minor: string; due_at: Date; status: string; submitted_at: Date; review_notes: string | null; payout_status: string | null; payout_reference: string | null; payout_failure_reason: string | null }>(`SELECT invoice.id, invoice.reference, invoice.work_order_id, invoice.deliverable_version_id, invoice.currency, invoice.gross_minor, invoice.net_payable_minor, invoice.due_at, invoice.status, invoice.submitted_at, invoice.review_notes, payout.status AS payout_status, payout.reference AS payout_reference, payout.failure_reason AS payout_failure_reason FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id LEFT JOIN fractal.professional_payout_instructions payout ON payout.invoice_id = invoice.id WHERE work_order.issuer_organization_id = $1 ORDER BY invoice.submitted_at DESC, invoice.id DESC`, [issuerOrganizationId]);
  return result.rows.map((row) => ({ id: row.id, reference: row.reference, workOrderId: row.work_order_id, deliverableVersionId: row.deliverable_version_id, currency: row.currency, grossMinor: row.gross_minor, netPayableMinor: row.net_payable_minor, dueAt: row.due_at.toISOString(), status: row.status, submittedAt: row.submitted_at.toISOString(), reviewNotes: row.review_notes, payoutStatus: row.payout_status, payoutReference: row.payout_reference, payoutFailureReason: row.payout_failure_reason }));
}

/** Professionals only see payout data for firms where they currently hold an active governed membership. */
export async function listProfessionalPayouts(identityId: string) {
  const result = await requirePostgres().query<{ invoice_id: string; invoice_reference: string; currency: string; net_payable_minor: string; invoice_status: string; payout_status: string; payout_reference: string; submitted_at: Date | null; confirmed_at: Date | null; failed_at: Date | null; failure_reason: string | null }>(
    `SELECT invoice.id AS invoice_id, invoice.reference AS invoice_reference, invoice.currency, invoice.net_payable_minor,
            invoice.status AS invoice_status, payout.status AS payout_status, payout.reference AS payout_reference,
            payout.submitted_at, payout.confirmed_at, payout.failed_at, payout.failure_reason
       FROM fractal.professional_payout_instructions payout
       JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id
       JOIN fractal.professional_firm_memberships membership
         ON membership.firm_organization_id = invoice.professional_firm_organization_id
      WHERE membership.identity_id = $1 AND membership.status = 'active'
      ORDER BY payout.authorized_at DESC, payout.id DESC`,
    [identityId],
  );
  return result.rows.map((row) => ({
    invoiceId: row.invoice_id,
    invoiceReference: row.invoice_reference,
    currency: row.currency,
    netPayableMinor: row.net_payable_minor,
    invoiceStatus: row.invoice_status,
    payoutStatus: row.payout_status,
    payoutReference: row.payout_reference,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    failureReason: row.failure_reason,
  }));
}

/** Deliberately limited to operations: provider diagnostics stay out of issuer and professional browsers. */
export async function listProfessionalPayoutExceptions() {
  const result = await requirePostgres().query<{ id: string; reference: string; status: string; currency: string; amount_minor: string; failure_reason: string | null; dispatch_started_at: Date | null; submitted_at: Date | null; failed_at: Date | null; invoice_id: string; invoice_reference: string; issuer_organization_id: string; legal_name: string }>(
    `SELECT payout.id, payout.reference, payout.status, payout.currency, payout.amount_minor,
            payout.failure_reason, payout.dispatch_started_at, payout.submitted_at, payout.failed_at,
            invoice.id AS invoice_id, invoice.reference AS invoice_reference,
            organization.id AS issuer_organization_id, organization.legal_name
       FROM fractal.professional_payout_instructions payout
       JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id
       JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id
       JOIN fractal.organizations organization ON organization.id = work_order.issuer_organization_id
      WHERE payout.status IN ('uncertain', 'failed', 'reversed')
      ORDER BY COALESCE(payout.failed_at, payout.dispatch_started_at, payout.submitted_at, payout.authorized_at), payout.id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    currency: row.currency,
    amountMinor: row.amount_minor,
    failureReason: row.failure_reason,
    dispatchStartedAt: row.dispatch_started_at?.toISOString() ?? null,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    invoiceId: row.invoice_id,
    invoiceReference: row.invoice_reference,
    issuerOrganizationId: row.issuer_organization_id,
    issuerLegalName: row.legal_name,
  }));
}

export async function listProfessionalRecipientRecoveryCases() {
  const result = await requirePostgres().query<{ id: string; firm_organization_id: string; provider: string; provider_recipient_reference: string; failure_reason: string; status: string; created_at: Date; legal_name: string }>(
    `SELECT recovery.id, recovery.firm_organization_id, recovery.provider, recovery.provider_recipient_reference,
            recovery.failure_reason, recovery.status, recovery.created_at, organization.legal_name
       FROM fractal.professional_payout_recipient_recovery_cases recovery
       JOIN fractal.organizations organization ON organization.id = recovery.firm_organization_id
      WHERE recovery.status = 'open'
      ORDER BY recovery.created_at, recovery.id`,
  );
  return result.rows.map((row) => ({ id: row.id, firmOrganizationId: row.firm_organization_id, firmLegalName: row.legal_name, provider: row.provider, providerRecipientReference: row.provider_recipient_reference, failureReason: row.failure_reason, status: row.status, createdAt: row.created_at.toISOString() }));
}

export async function openProfessionalFinanceException(input: { payoutInstructionId?: string; recipientRecoveryCaseId?: string; openedByIdentityId: string }) {
  if ((input.payoutInstructionId ? 1 : 0) + (input.recipientRecoveryCaseId ? 1 : 0) !== 1) throw new ProfessionalInvoiceError("A finance exception must reference exactly one payout or recipient recovery case");
  return withPostgresTransaction(async (client) => {
    let organizationId: string | undefined;
    if (input.payoutInstructionId) {
      const payout = await client.query<{ issuer_organization_id: string; status: string }>(`SELECT work_order.issuer_organization_id, payout.status
        FROM fractal.professional_payout_instructions payout JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id
        JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE payout.id = $1 FOR SHARE`, [input.payoutInstructionId]);
      if (!payout.rows[0] || !["uncertain", "failed", "reversed"].includes(payout.rows[0].status)) throw new ProfessionalInvoiceError("Only uncertain, failed, or reversed payouts may enter finance exception handling");
      organizationId = payout.rows[0].issuer_organization_id;
    } else {
      const recovery = await client.query<{ firm_organization_id: string; status: string }>("SELECT firm_organization_id, status FROM fractal.professional_payout_recipient_recovery_cases WHERE id = $1 FOR SHARE", [input.recipientRecoveryCaseId]);
      if (!recovery.rows[0] || recovery.rows[0].status !== "open") throw new ProfessionalInvoiceError("Recipient recovery case is not open");
      organizationId = recovery.rows[0].firm_organization_id;
    }
    const id = randomUUID();
    await client.query("INSERT INTO fractal.professional_finance_exception_cases (id, payout_instruction_id, recipient_recovery_case_id, issuer_organization_id, status, opened_by_identity_id) VALUES ($1,$2,$3,$4,'open',$5)", [id, input.payoutInstructionId ?? null, input.recipientRecoveryCaseId ?? null, organizationId, input.openedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${organizationId}`, organizationId, actorId: input.openedByIdentityId, actorType: "user", action: "professional_finance_exception.opened", entityType: "professional_finance_exception", entityId: id, payload: { payoutInstructionId: input.payoutInstructionId ?? null, recipientRecoveryCaseId: input.recipientRecoveryCaseId ?? null } });
    await appendOutboxEvent(client, { aggregateType: "professional_finance_exception", aggregateId: id, eventType: "professional_finance_exception.opened", payload: { organizationId, auditEventId: audit.id } });
    return { financeExceptionCaseId: id, organizationId };
  });
}

export async function recordProfessionalFinanceExceptionEvidence(input: { financeExceptionCaseId: string; uploadedByIdentityId: string; evidenceType: "provider_verification" | "provider_webhook" | "bank_confirmation" | "account_ownership" | "customer_communication" | "accounting_entry" | "other"; storageKey: string; filename: string; mimeType: string; contentSha256: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.contentSha256)) throw new ProfessionalInvoiceError("Finance exception evidence hash is invalid");
  return withPostgresTransaction(async (client) => {
    const caseResult = await client.query<{ issuer_organization_id: string; status: string }>("SELECT issuer_organization_id, status FROM fractal.professional_finance_exception_cases WHERE id = $1 FOR UPDATE", [input.financeExceptionCaseId]);
    const exceptionCase = caseResult.rows[0]; if (!exceptionCase || !["open", "evidence_submitted"].includes(exceptionCase.status)) throw new ProfessionalInvoiceError("Finance exception is not accepting evidence");
    const evidenceId = randomUUID();
    await client.query("INSERT INTO fractal.professional_finance_exception_evidence (id, case_id, evidence_type, content_sha256, storage_key, filename, mime_type, uploaded_by_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [evidenceId, input.financeExceptionCaseId, input.evidenceType, input.contentSha256, bounded(input.storageKey, "storageKey", 1, 1000), bounded(input.filename, "filename", 1, 240), bounded(input.mimeType, "mimeType", 3, 120), input.uploadedByIdentityId]);
    if (exceptionCase.status === "open") await client.query("UPDATE fractal.professional_finance_exception_cases SET status = 'evidence_submitted' WHERE id = $1", [input.financeExceptionCaseId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${exceptionCase.issuer_organization_id}`, organizationId: exceptionCase.issuer_organization_id, actorId: input.uploadedByIdentityId, actorType: "user", action: "professional_finance_exception.evidence_recorded", entityType: "professional_finance_exception_evidence", entityId: evidenceId, payload: { financeExceptionCaseId: input.financeExceptionCaseId, evidenceType: input.evidenceType, contentSha256: input.contentSha256 } });
    await appendOutboxEvent(client, { aggregateType: "professional_finance_exception", aggregateId: input.financeExceptionCaseId, eventType: "professional_finance_exception.evidence_recorded", payload: { organizationId: exceptionCase.issuer_organization_id, auditEventId: audit.id } });
    return { evidenceId };
  });
}

type CreditNoteResolution = { reference: string; grossMinor: number; taxMinor: number; withholdingTaxMinor: number; netCreditMinor: number };
type ReplacementPayoutResolution = { payoutProfileVersionId: string; amountMinor: number };
type FinanceResolutionPayload = { creditNote?: CreditNoteResolution; replacementPayout?: ReplacementPayoutResolution };

export async function prepareProfessionalFinanceExceptionResolution(input: { financeExceptionCaseId: string; preparedByIdentityId: string; resolutionType: "provider_settlement_confirmed" | "credit_note" | "replacement_payout" | "manual_settlement" | "recipient_deactivation_review"; resolutionReason: string; resolutionPayload?: FinanceResolutionPayload }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ issuer_organization_id: string; status: string; payout_instruction_id: string | null }>("SELECT issuer_organization_id, status, payout_instruction_id FROM fractal.professional_finance_exception_cases WHERE id = $1 FOR UPDATE", [input.financeExceptionCaseId]);
    const exceptionCase = result.rows[0]; if (!exceptionCase || exceptionCase.status !== "evidence_submitted") throw new ProfessionalInvoiceError("Finance exception is not ready for a resolution proposal");
    const evidence = await client.query("SELECT 1 FROM fractal.professional_finance_exception_evidence WHERE case_id = $1 LIMIT 1", [input.financeExceptionCaseId]); if (!evidence.rowCount) throw new ProfessionalInvoiceError("Finance exception requires evidence before resolution");
    const reason = bounded(input.resolutionReason, "resolutionReason", 8, 2000);
    const payload = input.resolutionPayload ?? {};
    if (input.resolutionType === "credit_note") {
      const credit = payload.creditNote; if (!credit || !exceptionCase.payout_instruction_id) throw new ProfessionalInvoiceError("A payout-linked credit-note proposal is required");
      const values = [credit.grossMinor, credit.taxMinor, credit.withholdingTaxMinor, credit.netCreditMinor]; if (!values.every((value) => Number.isSafeInteger(value) && value >= 0) || credit.grossMinor <= 0 || credit.netCreditMinor <= 0 || credit.netCreditMinor !== credit.grossMinor + credit.taxMinor - credit.withholdingTaxMinor) throw new ProfessionalInvoiceError("Credit-note amounts are invalid");
      const invoice = await client.query<{ gross_minor: string; tax_minor: string; withholding_tax_minor: string; net_payable_minor: string; payout_status: string }>(`SELECT invoice.gross_minor, invoice.tax_minor, invoice.withholding_tax_minor, invoice.net_payable_minor, payout.status AS payout_status
        FROM fractal.professional_payout_instructions payout JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id WHERE payout.id = $1 FOR SHARE`, [exceptionCase.payout_instruction_id]);
      const source = invoice.rows[0]; if (!source || !["failed", "reversed"].includes(source.payout_status)) throw new ProfessionalInvoiceError("A credit note requires a provider-confirmed failed or reversed payout");
      if (BigInt(credit.grossMinor) > BigInt(source.gross_minor) || BigInt(credit.taxMinor) > BigInt(source.tax_minor) || BigInt(credit.withholdingTaxMinor) > BigInt(source.withholding_tax_minor) || BigInt(credit.netCreditMinor) > BigInt(source.net_payable_minor)) throw new ProfessionalInvoiceError("Credit note exceeds the governed invoice amounts");
      payload.creditNote = { reference: bounded(credit.reference, "creditNote.reference", 3, 120), grossMinor: credit.grossMinor, taxMinor: credit.taxMinor, withholdingTaxMinor: credit.withholdingTaxMinor, netCreditMinor: credit.netCreditMinor };
    } else if (input.resolutionType === "replacement_payout") {
      const replacement = payload.replacementPayout; if (!replacement || !exceptionCase.payout_instruction_id || !Number.isSafeInteger(replacement.amountMinor) || replacement.amountMinor <= 0) throw new ProfessionalInvoiceError("A valid replacement-payout profile and amount are required");
      const source = await client.query<{ firm_organization_id: string; amount_minor: string; payout_status: string }>(`SELECT invoice.professional_firm_organization_id AS firm_organization_id, payout.amount_minor, payout.status AS payout_status
        FROM fractal.professional_payout_instructions payout JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id WHERE payout.id = $1 FOR SHARE`, [exceptionCase.payout_instruction_id]);
      const payout = source.rows[0]; if (!payout || !["failed", "reversed"].includes(payout.payout_status)) throw new ProfessionalInvoiceError("A replacement payout requires a provider-confirmed failed or reversed payout");
      if (BigInt(replacement.amountMinor) > BigInt(payout.amount_minor)) throw new ProfessionalInvoiceError("Replacement payout exceeds the original governed payout");
      const profile = await client.query<{ id: string }>(`SELECT profile.id FROM fractal.professional_payout_profile_versions profile
        WHERE profile.id = $1 AND profile.firm_organization_id = $2 AND profile.status = 'verified'
          AND NOT EXISTS (SELECT 1 FROM fractal.professional_payout_profile_versions newer WHERE newer.firm_organization_id = profile.firm_organization_id AND newer.version > profile.version AND newer.status = 'verified') FOR SHARE`, [replacement.payoutProfileVersionId, payout.firm_organization_id]);
      if (!profile.rowCount) throw new ProfessionalInvoiceError("Replacement payout requires the firm's current verified payout profile");
      payload.replacementPayout = { payoutProfileVersionId: replacement.payoutProfileVersionId, amountMinor: replacement.amountMinor };
    } else if (payload.creditNote || payload.replacementPayout) throw new ProfessionalInvoiceError("Resolution details do not match the proposed resolution type");
    await client.query("UPDATE fractal.professional_finance_exception_cases SET status = 'decision_pending', resolution_type = $2, resolution_reason = $3, resolution_payload = $4, prepared_by_identity_id = $5, prepared_at = now() WHERE id = $1", [input.financeExceptionCaseId, input.resolutionType, reason, payload, input.preparedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${exceptionCase.issuer_organization_id}`, organizationId: exceptionCase.issuer_organization_id, actorId: input.preparedByIdentityId, actorType: "user", action: "professional_finance_exception.prepared", entityType: "professional_finance_exception", entityId: input.financeExceptionCaseId, reason, payload: { resolutionType: input.resolutionType, resolutionPayload: payload } });
    await appendOutboxEvent(client, { aggregateType: "professional_finance_exception", aggregateId: input.financeExceptionCaseId, eventType: "professional_finance_exception.prepared", payload: { organizationId: exceptionCase.issuer_organization_id, auditEventId: audit.id } });
    return { financeExceptionCaseId: input.financeExceptionCaseId, status: "decision_pending" as const };
  });
}

/** Creates a new controlled payout request. Dispatch is intentionally a later, separately enabled capability. */
export async function authorizeProfessionalReplacementPayout(input: { financeExceptionCaseId: string; authorizedByIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ issuer_organization_id: string; status: string; resolution_type: string | null; payout_instruction_id: string | null; resolution_payload: FinanceResolutionPayload; prepared_by_identity_id: string | null; reviewed_by_identity_id: string | null }>("SELECT issuer_organization_id, status, resolution_type, payout_instruction_id, resolution_payload, prepared_by_identity_id, reviewed_by_identity_id FROM fractal.professional_finance_exception_cases WHERE id = $1 FOR UPDATE", [input.financeExceptionCaseId]);
    const exceptionCase = result.rows[0]; if (!exceptionCase) throw new ProfessionalInvoiceError("Finance exception was not found");
    if (exceptionCase.status === "executed") {
      const existing = await client.query<{ id: string; reference: string }>("SELECT id, reference FROM fractal.professional_replacement_payout_requests WHERE finance_exception_case_id = $1", [input.financeExceptionCaseId]);
      if (existing.rows[0]) return { replacementPayoutRequestId: existing.rows[0].id, reference: existing.rows[0].reference, replayed: true };
    }
    if (exceptionCase.status !== "approved" || exceptionCase.resolution_type !== "replacement_payout" || !exceptionCase.payout_instruction_id || !exceptionCase.prepared_by_identity_id || !exceptionCase.reviewed_by_identity_id) throw new ProfessionalInvoiceError("Finance exception is not an approved replacement-payout resolution");
    if ([exceptionCase.prepared_by_identity_id, exceptionCase.reviewed_by_identity_id].includes(input.authorizedByIdentityId)) throw new ProfessionalInvoiceError("A third person must authorize an approved replacement payout");
    const replacement = exceptionCase.resolution_payload?.replacementPayout; if (!replacement) throw new ProfessionalInvoiceError("Approved replacement-payout details are missing");
    const source = await client.query<{ currency: string; amount_minor: string; status: string; accrual_journal_id: string | null }>(`SELECT payout.currency, payout.amount_minor, payout.status, invoice.accrual_journal_id
      FROM fractal.professional_payout_instructions payout JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id
      WHERE payout.id = $1 FOR SHARE`, [exceptionCase.payout_instruction_id]);
    const original = source.rows[0]; if (!original || !["failed", "reversed"].includes(original.status)) throw new ProfessionalInvoiceError("A replacement payout requires a provider-confirmed failed or reversed payout");
    if (!original.accrual_journal_id) throw new ProfessionalInvoiceError("Replacement payout cannot proceed without the original governed accounting accrual");
    if (BigInt(replacement.amountMinor) > BigInt(original.amount_minor)) throw new ProfessionalInvoiceError("Replacement payout exceeds the original governed payout");
    const approvalPolicyId = await requireProfessionalFinanceApprovalPolicy(client, { issuerOrganizationId: exceptionCase.issuer_organization_id, resolutionType: "replacement_payout", currency: original.currency, amountMinor: replacement.amountMinor });
    const profile = await client.query<{ provider_recipient_reference: string }>("SELECT provider_recipient_reference FROM fractal.professional_payout_profile_versions WHERE id = $1 FOR SHARE", [replacement.payoutProfileVersionId]);
    const providerRecipientReference = profile.rows[0]?.provider_recipient_reference; if (!providerRecipientReference) throw new ProfessionalInvoiceError("Replacement payout profile is unavailable");
    const replacementPayoutRequestId = randomUUID(); const reference = `pro_replacement_${replacementPayoutRequestId}`;
    await client.query(`INSERT INTO fractal.professional_replacement_payout_requests (id, finance_exception_case_id, original_payout_instruction_id, payout_profile_version_id, provider, provider_recipient_reference, reference, currency, amount_minor, status, authorized_by_identity_id)
      VALUES ($1,$2,$3,$4,'paystack',$5,$6,$7,$8,'authorized',$9)`, [replacementPayoutRequestId, input.financeExceptionCaseId, exceptionCase.payout_instruction_id, replacement.payoutProfileVersionId, providerRecipientReference, reference, original.currency, replacement.amountMinor, input.authorizedByIdentityId]);
    await client.query("UPDATE fractal.professional_finance_exception_cases SET status = 'executed', executed_by_identity_id = $2, executed_at = now() WHERE id = $1", [input.financeExceptionCaseId, input.authorizedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${exceptionCase.issuer_organization_id}`, organizationId: exceptionCase.issuer_organization_id, actorId: input.authorizedByIdentityId, actorType: "user", action: "professional_replacement_payout.authorized", entityType: "professional_replacement_payout_request", entityId: replacementPayoutRequestId, payload: { financeExceptionCaseId: input.financeExceptionCaseId, originalPayoutInstructionId: exceptionCase.payout_instruction_id, reference, amountMinor: replacement.amountMinor, currency: original.currency, approvalPolicyId } });
    await appendOutboxEvent(client, { aggregateType: "professional_replacement_payout_request", aggregateId: replacementPayoutRequestId, eventType: "professional_replacement_payout.authorized", payload: { organizationId: exceptionCase.issuer_organization_id, financeExceptionCaseId: input.financeExceptionCaseId, auditEventId: audit.id } });
    return { replacementPayoutRequestId, reference, replayed: false };
  });
}

/** Issues a correction document only after an evidence-backed independent approval; it never changes the original invoice or transfers funds. */
export async function executeProfessionalFinanceCreditNote(input: { financeExceptionCaseId: string; executedByIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string; issuer_organization_id: string; status: string; resolution_type: string | null; resolution_reason: string | null; resolution_payload: FinanceResolutionPayload; payout_instruction_id: string | null; prepared_by_identity_id: string | null; reviewed_by_identity_id: string | null }>("SELECT id, issuer_organization_id, status, resolution_type, resolution_reason, resolution_payload, payout_instruction_id, prepared_by_identity_id, reviewed_by_identity_id FROM fractal.professional_finance_exception_cases WHERE id = $1 FOR UPDATE", [input.financeExceptionCaseId]);
    const exceptionCase = result.rows[0]; if (!exceptionCase) throw new ProfessionalInvoiceError("Finance exception was not found");
    if (exceptionCase.status === "executed") {
      const existing = await client.query<{ id: string; reference: string }>("SELECT id, reference FROM fractal.professional_invoice_credit_notes WHERE finance_exception_case_id = $1", [input.financeExceptionCaseId]);
      if (existing.rows[0]) return { creditNoteId: existing.rows[0].id, reference: existing.rows[0].reference, replayed: true };
    }
    if (exceptionCase.status !== "approved" || exceptionCase.resolution_type !== "credit_note" || !exceptionCase.payout_instruction_id || !exceptionCase.resolution_reason || !exceptionCase.prepared_by_identity_id || !exceptionCase.reviewed_by_identity_id) throw new ProfessionalInvoiceError("Finance exception is not an approved credit-note resolution");
    if ([exceptionCase.prepared_by_identity_id, exceptionCase.reviewed_by_identity_id].includes(input.executedByIdentityId)) throw new ProfessionalInvoiceError("A third person must issue an approved credit note");
    const credit = exceptionCase.resolution_payload?.creditNote; if (!credit) throw new ProfessionalInvoiceError("Approved credit-note amounts are missing");
    const source = await client.query<{ invoice_id: string; currency: string; gross_minor: string; tax_minor: string; withholding_tax_minor: string; net_payable_minor: string; payout_status: string; accrual_journal_id: string | null }>(`SELECT invoice.id AS invoice_id, invoice.currency, invoice.gross_minor, invoice.tax_minor, invoice.withholding_tax_minor, invoice.net_payable_minor, invoice.accrual_journal_id, payout.status AS payout_status
      FROM fractal.professional_payout_instructions payout JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id WHERE payout.id = $1 FOR SHARE`, [exceptionCase.payout_instruction_id]);
    const invoice = source.rows[0]; if (!invoice || !["failed", "reversed"].includes(invoice.payout_status)) throw new ProfessionalInvoiceError("A credit note requires a provider-confirmed failed or reversed payout");
    if (!invoice.accrual_journal_id) throw new ProfessionalInvoiceError("Credit note cannot proceed without the original governed accounting accrual");
    if (BigInt(credit.grossMinor) > BigInt(invoice.gross_minor) || BigInt(credit.taxMinor) > BigInt(invoice.tax_minor) || BigInt(credit.withholdingTaxMinor) > BigInt(invoice.withholding_tax_minor) || BigInt(credit.netCreditMinor) > BigInt(invoice.net_payable_minor)) throw new ProfessionalInvoiceError("Credit note exceeds its governed invoice amounts");
    const approvalPolicyId = await requireProfessionalFinanceApprovalPolicy(client, { issuerOrganizationId: exceptionCase.issuer_organization_id, resolutionType: "credit_note", currency: invoice.currency, amountMinor: credit.netCreditMinor });
    const creditNoteId = randomUUID();
    const journal = await postProfessionalCreditNote(client, { organizationId: exceptionCase.issuer_organization_id, creditNoteId, invoiceId: invoice.invoice_id, reference: credit.reference, currency: invoice.currency, grossMinor: credit.grossMinor, taxMinor: credit.taxMinor, withholdingTaxMinor: credit.withholdingTaxMinor, netCreditMinor: credit.netCreditMinor });
    await client.query(`INSERT INTO fractal.professional_invoice_credit_notes (id, finance_exception_case_id, invoice_id, reference, currency, gross_minor, tax_minor, withholding_tax_minor, net_credit_minor, reason, issued_by_identity_id, journal_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [creditNoteId, input.financeExceptionCaseId, invoice.invoice_id, credit.reference, invoice.currency, credit.grossMinor, credit.taxMinor, credit.withholdingTaxMinor, credit.netCreditMinor, exceptionCase.resolution_reason, input.executedByIdentityId, journal.journalId]);
    await client.query("UPDATE fractal.professional_finance_exception_cases SET status = 'executed', executed_by_identity_id = $2, executed_at = now() WHERE id = $1", [input.financeExceptionCaseId, input.executedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${exceptionCase.issuer_organization_id}`, organizationId: exceptionCase.issuer_organization_id, actorId: input.executedByIdentityId, actorType: "user", action: "professional_invoice_credit_note.issued", entityType: "professional_invoice_credit_note", entityId: creditNoteId, reason: exceptionCase.resolution_reason, payload: { financeExceptionCaseId: input.financeExceptionCaseId, invoiceId: invoice.invoice_id, reference: credit.reference, netCreditMinor: credit.netCreditMinor, currency: invoice.currency, approvalPolicyId, journalId: journal.journalId } });
    await appendOutboxEvent(client, { aggregateType: "professional_invoice_credit_note", aggregateId: creditNoteId, eventType: "professional_invoice_credit_note.issued", payload: { organizationId: exceptionCase.issuer_organization_id, financeExceptionCaseId: input.financeExceptionCaseId, invoiceId: invoice.invoice_id, auditEventId: audit.id } });
    return { creditNoteId, reference: credit.reference, journalId: journal.journalId, replayed: false };
  });
}

export async function decideProfessionalFinanceExceptionResolution(input: { financeExceptionCaseId: string; reviewedByIdentityId: string; approve: boolean }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ issuer_organization_id: string; status: string; prepared_by_identity_id: string }>("SELECT issuer_organization_id, status, prepared_by_identity_id FROM fractal.professional_finance_exception_cases WHERE id = $1 FOR UPDATE", [input.financeExceptionCaseId]);
    const exceptionCase = result.rows[0]; if (!exceptionCase || exceptionCase.status !== "decision_pending") throw new ProfessionalInvoiceError("Finance exception is not awaiting an independent decision");
    if (exceptionCase.prepared_by_identity_id === input.reviewedByIdentityId) throw new ProfessionalInvoiceError("A different person must approve or reject this finance exception");
    const status = input.approve ? "approved" : "rejected";
    await client.query("UPDATE fractal.professional_finance_exception_cases SET status = $2, reviewed_by_identity_id = $3, reviewed_at = now() WHERE id = $1", [input.financeExceptionCaseId, status, input.reviewedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${exceptionCase.issuer_organization_id}`, organizationId: exceptionCase.issuer_organization_id, actorId: input.reviewedByIdentityId, actorType: "user", action: `professional_finance_exception.${status}`, entityType: "professional_finance_exception", entityId: input.financeExceptionCaseId, payload: {} });
    await appendOutboxEvent(client, { aggregateType: "professional_finance_exception", aggregateId: input.financeExceptionCaseId, eventType: `professional_finance_exception.${status}`, payload: { organizationId: exceptionCase.issuer_organization_id, auditEventId: audit.id } });
    return { financeExceptionCaseId: input.financeExceptionCaseId, status };
  });
}

export async function listProfessionalFinanceExceptions() {
  const result = await requirePostgres().query<{ id: string; payout_instruction_id: string | null; recipient_recovery_case_id: string | null; issuer_organization_id: string; status: string; resolution_type: string | null; resolution_reason: string | null; opened_at: Date; prepared_at: Date | null; reviewed_at: Date | null; legal_name: string }>(`SELECT exception.id, exception.payout_instruction_id, exception.recipient_recovery_case_id, exception.issuer_organization_id, exception.status, exception.resolution_type, exception.resolution_reason, exception.opened_at, exception.prepared_at, exception.reviewed_at, organization.legal_name
    FROM fractal.professional_finance_exception_cases exception JOIN fractal.organizations organization ON organization.id = exception.issuer_organization_id ORDER BY exception.opened_at, exception.id`);
  return result.rows.map((row) => ({ id: row.id, payoutInstructionId: row.payout_instruction_id, recipientRecoveryCaseId: row.recipient_recovery_case_id, organizationId: row.issuer_organization_id, organizationLegalName: row.legal_name, status: row.status, resolutionType: row.resolution_type, resolutionReason: row.resolution_reason, openedAt: row.opened_at.toISOString(), preparedAt: row.prepared_at?.toISOString() ?? null, reviewedAt: row.reviewed_at?.toISOString() ?? null }));
}

export async function submitProfessionalInvoice(input: { workOrderId: string; deliverableVersionId: string; submittedByIdentityId: string; reference: string; dueAt: Date }) {
  const invoiceId = randomUUID(); const reference = bounded(input.reference, "reference", 3, 120);
  if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.valueOf()) || input.dueAt <= new Date()) throw new ProfessionalInvoiceError("dueAt must be in the future");
  return withPostgresTransaction(async (client) => {
    const workOrder = await client.query<{ id: string; issuer_organization_id: string; professional_firm_organization_id: string; currency: string; fee_minor: string; reference: string }>(
      `SELECT work_order.id, work_order.issuer_organization_id, work_order.professional_firm_organization_id, work_order.currency, work_order.fee_minor, work_order.reference
         FROM fractal.professional_work_orders work_order JOIN fractal.professional_work_order_assignments assignment ON assignment.work_order_id = work_order.id AND assignment.revoked_at IS NULL
         JOIN fractal.professional_firm_memberships membership ON membership.id = assignment.firm_membership_id
        WHERE work_order.id = $1 AND membership.identity_id = $2 AND membership.status = 'active' FOR UPDATE OF work_order`, [input.workOrderId, input.submittedByIdentityId]);
    const order = workOrder.rows[0]; if (!order) throw new ProfessionalInvoiceError("You are not assigned to this professional work order");
    const payout = await client.query<{ id: string }>("SELECT id FROM fractal.professional_payout_profile_versions WHERE firm_organization_id = $1 AND status = 'verified' ORDER BY version DESC LIMIT 1 FOR SHARE", [order.professional_firm_organization_id]);
    const payoutProfileVersionId = payout.rows[0]?.id; if (!payoutProfileVersionId) throw new ProfessionalInvoiceError("A verified payout profile is required before submitting an invoice");
    const tax = await client.query<{ id: string; indirect_tax_rate_bps: number; withholding_tax_rate_bps: number }>(`SELECT id, indirect_tax_rate_bps, withholding_tax_rate_bps
      FROM fractal.professional_invoice_tax_treatments
      WHERE issuer_organization_id = $1 AND currency = $2 AND status = 'active' AND effective_from <= now()
        AND (effective_until IS NULL OR effective_until > now()) ORDER BY effective_from DESC, version DESC LIMIT 1 FOR SHARE`, [order.issuer_organization_id, order.currency]);
    const treatment = tax.rows[0]; if (!treatment) throw new ProfessionalInvoiceError("An active finance-approved tax treatment is required before submitting an invoice");
    const taxMinor = percentageMinor(order.fee_minor, treatment.indirect_tax_rate_bps); const withholdingTaxMinor = percentageMinor(order.fee_minor, treatment.withholding_tax_rate_bps); const netPayableMinor = (BigInt(order.fee_minor) + BigInt(taxMinor) - BigInt(withholdingTaxMinor)).toString();
    await client.query(`INSERT INTO fractal.professional_invoices (id, reference, work_order_id, deliverable_version_id, professional_firm_organization_id, payout_profile_version_id, tax_treatment_id, currency, gross_minor, tax_minor, withholding_tax_minor, net_payable_minor, due_at, status, submitted_by_identity_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14)`, [invoiceId, reference, order.id, input.deliverableVersionId, order.professional_firm_organization_id, payoutProfileVersionId, treatment.id, order.currency, order.fee_minor, taxMinor, withholdingTaxMinor, netPayableMinor, input.dueAt, input.submittedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${order.issuer_organization_id}`, organizationId: order.issuer_organization_id, actorId: input.submittedByIdentityId, actorType: "user", action: "professional_invoice.submitted", entityType: "professional_invoice", entityId: invoiceId, payload: { workOrderId: order.id, workOrderReference: order.reference, deliverableVersionId: input.deliverableVersionId, reference, grossMinor: order.fee_minor, taxMinor, withholdingTaxMinor, netPayableMinor, currency: order.currency, payoutProfileVersionId, taxTreatmentId: treatment.id } });
    await appendOutboxEvent(client, { aggregateType: "professional_invoice", aggregateId: invoiceId, eventType: "professional_invoice.submitted", payload: { issuerOrganizationId: order.issuer_organization_id, workOrderId: order.id, auditEventId: audit.id } });
    return { invoiceId };
  });
}

export async function decideProfessionalInvoice(input: { invoiceId: string; decidedByIdentityId: string; approve: boolean; reason?: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string; reference: string; work_order_id: string; submitted_by_identity_id: string; issuer_organization_id: string; currency: string; gross_minor: string; tax_minor: string; withholding_tax_minor: string; net_payable_minor: string }>(`SELECT invoice.id, invoice.reference, invoice.work_order_id, invoice.submitted_by_identity_id, work_order.issuer_organization_id, invoice.currency, invoice.gross_minor, invoice.tax_minor, invoice.withholding_tax_minor, invoice.net_payable_minor FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE invoice.id = $1 AND invoice.status = 'submitted' FOR UPDATE OF invoice`, [input.invoiceId]);
    const invoice = result.rows[0]; if (!invoice) throw new ProfessionalInvoiceError("Invoice is not awaiting review"); if (invoice.submitted_by_identity_id === input.decidedByIdentityId) throw new ProfessionalInvoiceError("A different person must review this invoice");
    const reason = input.reason?.trim(); if (!input.approve && !reason) throw new ProfessionalInvoiceError("A rejection reason is required"); const status = input.approve ? "approved" : "rejected";
    const accrual = input.approve ? await postProfessionalInvoiceAccrual(client, { organizationId: invoice.issuer_organization_id, invoiceId: invoice.id, reference: invoice.reference, currency: invoice.currency, grossMinor: invoice.gross_minor, taxMinor: invoice.tax_minor, withholdingTaxMinor: invoice.withholding_tax_minor, netPayableMinor: invoice.net_payable_minor }) : undefined;
    await client.query("UPDATE fractal.professional_invoices SET status = $2, reviewed_by_identity_id = $3, reviewed_at = now(), review_notes = $4, accrual_journal_id = $5 WHERE id = $1", [invoice.id, status, input.decidedByIdentityId, reason ?? null, accrual?.journalId ?? null]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${invoice.issuer_organization_id}`, organizationId: invoice.issuer_organization_id, actorId: input.decidedByIdentityId, actorType: "user", action: `professional_invoice.${status}`, entityType: "professional_invoice", entityId: invoice.id, reason: reason ?? undefined, payload: { workOrderId: invoice.work_order_id, accrualJournalId: accrual?.journalId ?? null } });
    await appendOutboxEvent(client, { aggregateType: "professional_invoice", aggregateId: invoice.id, eventType: `professional_invoice.${status}`, payload: { issuerOrganizationId: invoice.issuer_organization_id, workOrderId: invoice.work_order_id, auditEventId: audit.id } });
    return { invoiceId: invoice.id, status, accrualJournalId: accrual?.journalId };
  });
}

export async function authorizeProfessionalPayout(input: { invoiceId: string; authorizedByIdentityId: string }) {
  const payoutInstructionId = randomUUID();
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string; work_order_id: string; issuer_organization_id: string; payout_profile_version_id: string; currency: string; net_payable_minor: string; status: string; reviewed_by_identity_id: string | null; accrual_journal_id: string | null }>(`SELECT invoice.id, invoice.work_order_id, work_order.issuer_organization_id, invoice.payout_profile_version_id, invoice.currency, invoice.net_payable_minor, invoice.status, invoice.reviewed_by_identity_id, invoice.accrual_journal_id FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE invoice.id = $1 FOR UPDATE OF invoice`, [input.invoiceId]);
    const invoice = result.rows[0]; if (!invoice || invoice.status !== "approved") throw new ProfessionalInvoiceError("Only an approved invoice can receive a payout instruction");
    if (!invoice.reviewed_by_identity_id || invoice.reviewed_by_identity_id === input.authorizedByIdentityId) throw new ProfessionalInvoiceError("A different person must authorize this payout");
    if (!invoice.accrual_journal_id) throw new ProfessionalInvoiceError("Approved invoice is missing its immutable accounting accrual");
    const profile = await client.query<{ provider_recipient_reference: string }>("SELECT provider_recipient_reference FROM fractal.professional_payout_profile_versions WHERE id = $1 FOR SHARE", [invoice.payout_profile_version_id]); const recipient = profile.rows[0]?.provider_recipient_reference; if (!recipient) throw new ProfessionalInvoiceError("Invoice payout profile is unavailable");
    const reference = `pro_payout_${payoutInstructionId}`;
    await client.query("INSERT INTO fractal.professional_payout_instructions (id, invoice_id, provider, provider_recipient_reference, reference, currency, amount_minor, status, authorized_by_identity_id) VALUES ($1,$2,'paystack',$3,$4,$5,$6,'authorized',$7)", [payoutInstructionId, invoice.id, recipient, reference, invoice.currency, invoice.net_payable_minor, input.authorizedByIdentityId]);
    await client.query("UPDATE fractal.professional_invoices SET status = 'payment_instructed' WHERE id = $1", [invoice.id]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${invoice.issuer_organization_id}`, organizationId: invoice.issuer_organization_id, actorId: input.authorizedByIdentityId, actorType: "user", action: "professional_payout.authorized", entityType: "professional_payout_instruction", entityId: payoutInstructionId, payload: { invoiceId: invoice.id, workOrderId: invoice.work_order_id, reference, currency: invoice.currency, amountMinor: invoice.net_payable_minor } });
    await appendOutboxEvent(client, { aggregateType: "professional_payout_instruction", aggregateId: payoutInstructionId, eventType: "professional_payout.authorized", payload: { invoiceId: invoice.id, issuerOrganizationId: invoice.issuer_organization_id, auditEventId: audit.id } });
    return { payoutInstructionId, reference };
  });
}

/** This is the only bridge from a signed provider event or verification into governed payout state. */
export async function recordProfessionalPayoutProviderOutcome(input: {
  outcome: ProfessionalPayoutProviderOutcome;
  reference: string;
  transferCode?: string;
  amountMinor?: number;
  currency?: string;
  reason?: string;
  occurredAt?: Date;
  source: "webhook" | "verification";
}): Promise<{ handled: boolean; payoutInstructionId?: string; status?: string }> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string; invoice_id: string; issuer_organization_id: string; instruction_status: string; reference: string; provider_transfer_code: string | null; amount_minor: string; currency: string; settlement_journal_id: string | null; reversal_journal_id: string | null; invoice_accrual_journal_id: string | null }>(
      `SELECT payout.id, payout.invoice_id, work_order.issuer_organization_id, payout.status AS instruction_status,
              payout.reference, payout.provider_transfer_code, payout.amount_minor, payout.currency, payout.settlement_journal_id, payout.reversal_journal_id, invoice.accrual_journal_id AS invoice_accrual_journal_id
         FROM fractal.professional_payout_instructions payout
         JOIN fractal.professional_invoices invoice ON invoice.id = payout.invoice_id
         JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id
        WHERE payout.provider = 'paystack'
          AND (payout.reference = $1 OR ($2::text IS NOT NULL AND payout.provider_transfer_code = $2))
        FOR UPDATE OF payout, invoice`,
      [input.reference, input.transferCode ?? null],
    );
    const payout = result.rows[0];
    if (!payout) return { handled: false };
    if (input.transferCode && payout.provider_transfer_code && input.transferCode !== payout.provider_transfer_code) throw new ProfessionalInvoiceError("Provider transfer code does not match the governed instruction");
    if (input.amountMinor !== undefined && (!Number.isSafeInteger(input.amountMinor) || String(input.amountMinor) !== payout.amount_minor)) throw new ProfessionalInvoiceError("Provider payout amount does not match the governed instruction");
    if (input.currency !== undefined && input.currency.toUpperCase() !== payout.currency) throw new ProfessionalInvoiceError("Provider payout currency does not match the governed instruction");

    const unexpectedBeforeDispatch = payout.instruction_status === "authorized";
    const targetStatus = unexpectedBeforeDispatch ? "uncertain" : input.outcome === "success" ? "confirmed" : input.outcome;
    if (payout.instruction_status === targetStatus
      || (payout.instruction_status === "reversed" && targetStatus !== "reversed")
      || (payout.instruction_status === "failed" && targetStatus !== "failed")
      || (payout.instruction_status === "confirmed" && targetStatus === "failed")) return { handled: true, payoutInstructionId: payout.id, status: payout.instruction_status };
    const occurredAt = input.occurredAt ?? new Date();
    const failureReason = (unexpectedBeforeDispatch
      ? `Provider reported ${input.outcome} before the controlled dispatch record was created`
      : input.reason?.trim() || (input.outcome === "reversed" ? "Transfer reversed by payment provider" : "Transfer failed at payment provider")).slice(0, 2_000);

    if (targetStatus === "confirmed") {
      if (!payout.invoice_accrual_journal_id) throw new ProfessionalInvoiceError("Professional payout cannot settle without the original governed accounting accrual");
      const settlement = payout.settlement_journal_id
        ? { journalId: payout.settlement_journal_id, replayed: true }
        : await postProfessionalPayoutSettlement(client, { organizationId: payout.issuer_organization_id, payoutInstructionId: payout.id, reference: payout.reference, currency: payout.currency, amountMinor: payout.amount_minor, occurredAt });
      const updated = await client.query(
        `UPDATE fractal.professional_payout_instructions
            SET status = 'confirmed', provider_transfer_code = COALESCE(provider_transfer_code, $2),
                submitted_at = COALESCE(submitted_at, $3), confirmed_at = $3,
                failed_at = NULL, failure_reason = NULL, settlement_journal_id = $4
          WHERE id = $1 AND status IN ('dispatching', 'submitted', 'uncertain')`,
        [payout.id, input.transferCode ?? null, occurredAt, settlement.journalId],
      );
      if (!updated.rowCount) return { handled: true, payoutInstructionId: payout.id, status: payout.instruction_status };
      await client.query("UPDATE fractal.professional_invoices SET status = 'paid' WHERE id = $1 AND status = 'payment_instructed'", [payout.invoice_id]);
    } else {
      if (targetStatus === "reversed" && payout.instruction_status === "confirmed" && !payout.settlement_journal_id) throw new ProfessionalInvoiceError("Confirmed payout is missing its immutable settlement journal");
      const reversal = targetStatus === "reversed" && payout.instruction_status === "confirmed"
        ? await reverseJournal({ scopeKey: `organization:${payout.issuer_organization_id}`, organizationId: payout.issuer_organization_id, idempotencyKey: `professional-payout-reversal:${payout.id}`, originalJournalId: payout.settlement_journal_id!, narrative: `Professional payout reversal ${payout.reference}`, externalRef: payout.reference, effectiveAt: occurredAt, metadata: { professionalPayoutInstructionId: payout.id, professionalPayoutReference: payout.reference, accountingEvent: "professional_payout_reversal" } })
        : undefined;
      const updated = await client.query(
        `UPDATE fractal.professional_payout_instructions
            SET status = $2, provider_transfer_code = COALESCE(provider_transfer_code, $3),
                failed_at = $4, failure_reason = $5, reversal_journal_id = $6
          WHERE id = $1 AND status IN ('authorized', 'dispatching', 'submitted', 'uncertain', 'confirmed')`,
        [payout.id, targetStatus, input.transferCode ?? null, occurredAt, failureReason, reversal?.journalId ?? null],
      );
      if (!updated.rowCount) return { handled: true, payoutInstructionId: payout.id, status: payout.instruction_status };
      if (targetStatus !== "uncertain") await client.query("UPDATE fractal.professional_invoices SET status = 'payment_failed' WHERE id = $1 AND status = 'payment_instructed'", [payout.invoice_id]);
      if (targetStatus === "reversed") await client.query("UPDATE fractal.professional_invoices SET status = 'payment_reversed' WHERE id = $1 AND status = 'paid'", [payout.invoice_id]);
    }

    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${payout.issuer_organization_id}`,
      organizationId: payout.issuer_organization_id,
      actorType: "provider",
      action: `professional_payout.${targetStatus}`,
      entityType: "professional_payout_instruction",
      entityId: payout.id,
      reason: targetStatus === "confirmed" ? undefined : failureReason,
      payload: { invoiceId: payout.invoice_id, reference: payout.reference, transferCode: input.transferCode ?? null, source: input.source },
      occurredAt,
    });
    await appendOutboxEvent(client, { aggregateType: "professional_payout_instruction", aggregateId: payout.id, eventType: `professional_payout.${targetStatus}`, payload: { invoiceId: payout.invoice_id, issuerOrganizationId: payout.issuer_organization_id, auditEventId: audit.id } });
    return { handled: true, payoutInstructionId: payout.id, status: targetStatus };
  });
}
