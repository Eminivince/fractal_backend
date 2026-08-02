/**
 * B9: Field-level encryption plugin using AES-256-GCM.
 * Encrypts specified fields on save, decrypts on find/init.
 * Gated behind FIELD_ENCRYPTION_ENABLED + FIELD_ENCRYPTION_KEY env vars.
 */

import crypto from "node:crypto";
import type { Schema } from "mongoose";
import { env } from "../../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const PREFIX = "enc:";

function getKey(): Buffer | null {
  if (!env.FIELD_ENCRYPTION_ENABLED || !env.FIELD_ENCRYPTION_KEY) return null;
  return Buffer.from(env.FIELD_ENCRYPTION_KEY, "hex");
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(ciphertext: string, key: Buffer): string {
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;
  const data = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Mongoose plugin that encrypts/decrypts specified top-level fields.
 * Usage: schema.plugin(fieldEncryptionPlugin, { fields: ["name", "email"] })
 */
export function fieldEncryptionPlugin(schema: Schema, opts: { fields: string[] }): void {
  const { fields } = opts;

  schema.pre("save", function () {
    const key = getKey();
    if (!key) return;
    for (const field of fields) {
      const value = this.get(field);
      if (typeof value === "string" && value.length > 0 && !isEncrypted(value)) {
        this.set(field, encrypt(value, key));
      }
    }
  });

  const decryptFields = (doc: any) => {
    const key = getKey();
    if (!key || !doc) return;
    for (const field of fields) {
      const value = doc[field] ?? doc.get?.(field);
      if (typeof value === "string" && isEncrypted(value)) {
        try {
          const decrypted = decrypt(value, key);
          if (doc.set) doc.set(field, decrypted);
          else doc[field] = decrypted;
        } catch {
          console.error(`[field-encryption] Failed to decrypt field "${field}"`);
        }
      }
    }
  };

  schema.post("init", decryptFields);
  schema.post("find", (docs: any[]) => {
    if (Array.isArray(docs)) docs.forEach(decryptFields);
  });
  schema.post("findOne", decryptFields);
}
