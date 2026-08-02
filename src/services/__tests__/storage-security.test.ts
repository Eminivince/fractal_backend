import { describe, expect, it } from "vitest";
import { HttpError } from "../../utils/errors.js";
import {
  decodeDocumentBase64,
  persistSumsubPrivacyExportBinary,
  persistSupportAttachmentBinary,
  retrieveFile,
  validateDocumentBinaryType,
} from "../storage.js";

describe("document storage boundary", () => {
  it("accepts a structurally valid PDF payload", () => {
    const payload = Buffer.from("%PDF-1.7\nminimal test document", "utf8").toString("base64");
    const buffer = decodeDocumentBase64(payload);
    expect(() => validateDocumentBinaryType(buffer, "application/pdf")).not.toThrow();
  });

  it("rejects malformed base64 before it reaches a scanner or storage provider", () => {
    expect(() => decodeDocumentBase64("not valid base64!"))
      .toThrow(HttpError);
  });

  it("rejects a claimed document type that does not match the binary signature", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(() => validateDocumentBinaryType(jpeg, "application/pdf"))
      .toThrow(HttpError);
  });

  it("rejects local traversal keys before filesystem access", async () => {
    await expect(retrieveFile("local://../../.env"))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("never grants support-evidence scan attestation when the scanner is unavailable", async () => {
    const content = Buffer.from("%PDF-1.7\nminimal support evidence", "utf8");
    await expect(persistSupportAttachmentBinary({ caseId: "00000000-0000-4000-8000-000000000001", filename: "evidence.pdf", mimeType: "application/pdf", content }))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects a Sumsub export that is not a ZIP before storage", async () => {
    await expect(persistSumsubPrivacyExportBinary({
      exportId: "00000000-0000-4000-8000-000000000002",
      content: Buffer.from("%PDF-1.7\nnot a Sumsub ZIP", "utf8"),
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("never stages a valid Sumsub ZIP when malware scanning is unavailable", async () => {
    await expect(persistSumsubPrivacyExportBinary({
      exportId: "00000000-0000-4000-8000-000000000003",
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
    })).rejects.toMatchObject({ statusCode: 503 });
  });
});
