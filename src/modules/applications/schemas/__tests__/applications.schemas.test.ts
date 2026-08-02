import { describe, expect, it } from "vitest";
import {
  applicationIdParamsSchema,
  closeReviewRoundSchema,
  createAndSubmitApplicationSchema,
  createApplicationSchema,
  createReviewRoundSchema,
  decisionPayloadSchema,
  listApplicationsQuerySchema,
  listReviewItemsQuerySchema,
  requestServiceSchema,
  respondReviewItemSchema,
  reviewItemIdParamsSchema,
  reviewRoundIdParamsSchema,
  taskIdParamsSchema,
  taskStatusSchema,
  verifyReviewItemSchema,
  withdrawApplicationSchema,
} from "../applications.schemas.js";

describe("application schemas", () => {
  it("parses application creation and submission payloads", () => {
    const application = createApplicationSchema.parse({
      templateCode: "A",
      asset: { name: "Lagos Warehouse", state: "Lagos", city: "Ikeja", summary: "Income-producing warehouse", legalTitle: { titleType: "certificate_of_occupancy" }, valuation: { amount: 1000000 } },
      checklistState: [{ key: "title", label: "Title document", stage: "Intake" }],
      milestones: [{ name: "Close", percent: 100, targetDate: "2026-12-31" }],
    });
    const submitted = createAndSubmitApplicationSchema.parse({ templateCode: "B", dossierDocuments: [], requestedServices: [] });
    expect(application.asset?.country).toBe("Nigeria");
    expect(application.checklistState?.[0]).toMatchObject({ required: true, status: "missing" });
    expect(submitted).toMatchObject({ templateCode: "B", dossierDocuments: [], requestedServices: [] });
  });

  it("parses route parameters, list filters, and workflow payloads", () => {
    expect(applicationIdParamsSchema.parse({ id: "application-1" })).toEqual({ id: "application-1" });
    expect(taskIdParamsSchema.parse({ id: "task-1" })).toEqual({ id: "task-1" });
    expect(reviewRoundIdParamsSchema.parse({ id: "round-1" })).toEqual({ id: "round-1" });
    expect(reviewItemIdParamsSchema.parse({ id: "item-1" })).toEqual({ id: "item-1" });
    expect(listApplicationsQuerySchema.parse({ page: "2", limit: "10", status: "submitted", templateCode: "A", stage: "Diligence" })).toEqual({ page: 2, limit: 10, status: "submitted", templateCode: "A", stage: "Diligence" });
    expect(listReviewItemsQuerySchema.parse({ roundId: "round-1", status: "responded" })).toEqual({ roundId: "round-1", status: "responded" });
    expect(requestServiceSchema.parse({ professionalId: "professional-1" })).toEqual({ professionalId: "professional-1", stage: "Diligence" });
    expect(taskStatusSchema.parse({ status: "in_progress" })).toEqual({ status: "in_progress" });
    expect(withdrawApplicationSchema.parse({ reason: "Asset sale cancelled" })).toEqual({ reason: "Asset sale cancelled" });
    expect(decisionPayloadSchema.parse({ reasonCode: "RISK", notes: "Material risk is not mitigated." })).toEqual({ reasonCode: "RISK", notes: "Material risk is not mitigated." });
  });

  it("parses review-round and review-item payloads and rejects unsafe values", () => {
    expect(createReviewRoundSchema.parse({ stageTag: "Diligence", summary: "Please resolve valuation evidence.", dueAt: "2026-08-01", items: [{ itemType: "document", itemKey: "valuation", title: "Valuation report", requestMessage: "Upload the signed report." }] })).toMatchObject({ items: [expect.objectContaining({ required: true })] });
    expect(respondReviewItemSchema.parse({ responseMessage: "The signed report is uploaded.", responseMeta: { documentId: "document-1" } })).toMatchObject({ responseMeta: { documentId: "document-1" } });
    expect(verifyReviewItemSchema.parse({ status: "verified", reviewNotes: "Evidence is complete." })).toEqual({ status: "verified", reviewNotes: "Evidence is complete." });
    expect(closeReviewRoundSchema.parse({ notes: "All review items are complete." })).toEqual({ notes: "All review items are complete." });
    expect(createApplicationSchema.safeParse({ templateCode: "C" }).success).toBe(false);
    expect(createReviewRoundSchema.safeParse({ items: [] }).success).toBe(false);
    expect(taskStatusSchema.safeParse({ status: "unknown" }).success).toBe(false);
  });
});
