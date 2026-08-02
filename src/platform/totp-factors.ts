import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;
const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 16;

export class TotpFactorError extends Error {}

export interface TotpFactorStatus {
  enrolled: boolean;
  confirmed: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpConfirmation {
  confirmedNow: boolean;
  recoveryCodes: string[] | null;
}

function encryptionKey(): Buffer {
  if (!env.MFA_TOTP_ENCRYPTION_KEY) throw new TotpFactorError("TOTP factor encryption is not configured");
  return Buffer.from(env.MFA_TOTP_ENCRYPTION_KEY, "hex");
}

function recoveryCodePepper(): Buffer {
  if (!env.MFA_RECOVERY_CODE_PEPPER) throw new TotpFactorError("MFA recovery codes are not configured");
  return Buffer.from(env.MFA_RECOVERY_CODE_PEPPER, "hex");
}

function encrypt(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

function decrypt(value: string): string {
  const [version, encoded] = value.split(":", 2);
  if (version !== "v1" || !encoded) throw new TotpFactorError("Unsupported encrypted TOTP factor");
  const data = Buffer.from(encoded, "base64url");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function base32Encode(input: Buffer): string {
  let bits = 0; let value = 0; let output = "";
  for (const byte of input) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits > 0 ? output + ALPHABET[(value << (5 - bits)) & 31] : output;
}

function base32Decode(input: string): Buffer {
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const character of input.replace(/\s|=/g, "").toUpperCase()) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new TotpFactorError("Invalid TOTP secret");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secret: string, counter: number): string {
  const counterBuffer = Buffer.alloc(8); counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 15;
  const value = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(value % 1_000_000).padStart(6, "0");
}

function counterAt(now: Date): number { return Math.floor(now.getTime() / 1_000 / PERIOD_SECONDS); }

function verifyCode(secret: string, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const counter of [counterAt(now) - 1, counterAt(now), counterAt(now) + 1]) {
    const expected = Buffer.from(generateTotpCode(secret, counter));
    const received = Buffer.from(code);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return counter;
  }
  return null;
}

function normalizeRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, "");
  if (normalized.length !== RECOVERY_CODE_LENGTH || !new RegExp(`^[${RECOVERY_CODE_ALPHABET}]+$`).test(normalized)) {
    throw new TotpFactorError("Invalid recovery code");
  }
  return normalized;
}

function recoveryCodeDigest(code: string): string {
  return createHmac("sha256", recoveryCodePepper())
    .update(`fractal.mfa.recovery-code.v1:${normalizeRecoveryCode(code)}`)
    .digest("hex");
}

function newRecoveryCode(): string {
  const characters = Array.from(randomBytes(RECOVERY_CODE_LENGTH), (byte) => RECOVERY_CODE_ALPHABET[byte & 31]!);
  return characters.join("").match(/.{1,4}/g)!.join("-");
}

async function replaceRecoveryCodes(client: PoolClient, identityId: string): Promise<string[]> {
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await client.query(
    `UPDATE fractal.totp_recovery_codes
        SET replaced_at = now()
      WHERE identity_id = $1 AND used_at IS NULL AND replaced_at IS NULL`,
    [identityId],
  );
  for (const recoveryCode of recoveryCodes) {
    await client.query(
      `INSERT INTO fractal.totp_recovery_codes (id, identity_id, code_digest)
       VALUES ($1, $2, $3)`,
      [randomUUID(), identityId, recoveryCodeDigest(recoveryCode)],
    );
  }
  return recoveryCodes;
}

interface LockedTotpFactor {
  secret_ciphertext: string;
  confirmed_at: Date | null;
  last_used_counter: string | null;
  disabled_at: Date | null;
}

async function verifyLockedTotpFactor(
  client: PoolClient,
  identityId: string,
  code: string,
  now: Date,
  requireConfirmed = false,
): Promise<LockedTotpFactor> {
  const result = await client.query<LockedTotpFactor>(
    "SELECT secret_ciphertext, confirmed_at, last_used_counter, disabled_at FROM fractal.totp_factors WHERE identity_id = $1 FOR UPDATE",
    [identityId],
  );
  const factor = result.rows[0];
  if (!factor || factor.disabled_at) throw new TotpFactorError("TOTP factor is unavailable");
  if (requireConfirmed && !factor.confirmed_at) throw new TotpFactorError("TOTP factor is not confirmed");
  const usedCounter = verifyCode(decrypt(factor.secret_ciphertext), code, now);
  if (usedCounter === null) throw new TotpFactorError("Invalid authentication code");
  if (factor.last_used_counter !== null && usedCounter <= Number(factor.last_used_counter)) {
    throw new TotpFactorError("Authentication code was already used");
  }
  await client.query(
    "UPDATE fractal.totp_factors SET last_used_counter = $2, updated_at = now() WHERE identity_id = $1",
    [identityId, usedCounter],
  );
  return factor;
}

export async function enrollTotpFactor(identityId: string): Promise<{ secret: string; otpauthUri: string }> {
  const secret = base32Encode(randomBytes(20));
  await withPostgresTransaction(async (client) => {
    const existing = await client.query<{ confirmed_at: Date | null; disabled_at: Date | null }>(
      "SELECT confirmed_at, disabled_at FROM fractal.totp_factors WHERE identity_id = $1 FOR UPDATE",
      [identityId],
    );
    if (existing.rows[0]?.confirmed_at && !existing.rows[0].disabled_at) {
      throw new TotpFactorError("An active TOTP factor already exists; use the approved recovery process instead of replacing it.");
    }
    await client.query(
      `INSERT INTO fractal.totp_factors (id, identity_id, secret_ciphertext)
       VALUES ($1, $2, $3)
       ON CONFLICT (identity_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, confirmed_at = NULL, last_used_counter = NULL, disabled_at = NULL, updated_at = now()`,
      [randomUUID(), identityId, encrypt(secret)],
    );
  });
  return { secret, otpauthUri: `otpauth://totp/Fractal:${identityId}?secret=${secret}&issuer=Fractal&algorithm=SHA1&digits=6&period=30` };
}

export async function getTotpFactorStatus(identityId: string): Promise<TotpFactorStatus> {
  const result = await withPostgresTransaction((client) => client.query<{ confirmed_at: Date | null; disabled_at: Date | null; recovery_codes_remaining: string }>(
    `SELECT factor.confirmed_at, factor.disabled_at,
       (SELECT count(*) FROM fractal.totp_recovery_codes recovery_code
         WHERE recovery_code.identity_id = factor.identity_id
           AND recovery_code.used_at IS NULL AND recovery_code.replaced_at IS NULL) AS recovery_codes_remaining
       FROM fractal.totp_factors factor WHERE factor.identity_id = $1`,
    [identityId],
  ));
  const factor = result.rows[0];
  return {
    enrolled: Boolean(factor && !factor.disabled_at),
    confirmed: Boolean(factor?.confirmed_at && !factor.disabled_at),
    recoveryCodesRemaining: Number(factor?.recovery_codes_remaining ?? 0),
  };
}

export async function confirmOrVerifyTotpFactor(identityId: string, code: string, now = new Date()): Promise<TotpConfirmation> {
  return withPostgresTransaction(async (client) => {
    const factor = await verifyLockedTotpFactor(client, identityId, code, now);
    const confirmedNow = !factor.confirmed_at;
    const recoveryCodes = confirmedNow ? await replaceRecoveryCodes(client, identityId) : null;
    await client.query(
      "UPDATE fractal.totp_factors SET confirmed_at = COALESCE(confirmed_at, now()), updated_at = now() WHERE identity_id = $1",
      [identityId],
    );
    if (confirmedNow) {
      await appendPostgresAuditEvent(client, {
        scopeKey: `identity:${identityId}`,
        actorId: identityId,
        actorType: "user",
        action: "auth.totp.confirmed",
        entityType: "totp_factor",
        entityId: identityId,
        payload: { recoveryCodeCount: recoveryCodes!.length },
      });
    }
    return { confirmedNow, recoveryCodes };
  });
}

export async function verifyConfirmedTotpFactor(identityId: string, code: string, now = new Date()): Promise<void> {
  await withPostgresTransaction(async (client) => {
    await verifyLockedTotpFactor(client, identityId, code, now, true);
  });
}

export async function regenerateTotpRecoveryCodes(identityId: string, code: string, now = new Date()): Promise<string[]> {
  return withPostgresTransaction(async (client) => {
    await verifyLockedTotpFactor(client, identityId, code, now, true);
    const recoveryCodes = await replaceRecoveryCodes(client, identityId);
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${identityId}`,
      actorId: identityId,
      actorType: "user",
      action: "auth.totp.recovery_codes.regenerated",
      entityType: "totp_factor",
      entityId: identityId,
      payload: { recoveryCodeCount: recoveryCodes.length },
    });
    return recoveryCodes;
  });
}

export async function recoverTotpFactor(input: {
  identityId: string;
  sessionId: string;
  code: string;
}): Promise<{ secret: string; otpauthUri: string }> {
  const digest = recoveryCodeDigest(input.code);
  const secret = base32Encode(randomBytes(20));
  await withPostgresTransaction(async (client) => {
    const session = await client.query<{ subject_id: string }>(
      `SELECT subject_id FROM fractal.auth_sessions
        WHERE id = $1 AND identity_id = $2 AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [input.sessionId, input.identityId],
    );
    const subjectId = session.rows[0]?.subject_id;
    if (!subjectId) throw new TotpFactorError("The current session is not eligible for MFA recovery");

    const factor = await client.query<{ confirmed_at: Date | null; disabled_at: Date | null }>(
      "SELECT confirmed_at, disabled_at FROM fractal.totp_factors WHERE identity_id = $1 FOR UPDATE",
      [input.identityId],
    );
    if (!factor.rows[0]?.confirmed_at || factor.rows[0].disabled_at) {
      throw new TotpFactorError("An active authenticator factor is required for recovery");
    }

    const recoveryCode = await client.query<{ id: string }>(
      `SELECT id FROM fractal.totp_recovery_codes
        WHERE identity_id = $1 AND code_digest = $2 AND used_at IS NULL AND replaced_at IS NULL
        FOR UPDATE`,
      [input.identityId, digest],
    );
    const recoveryCodeId = recoveryCode.rows[0]?.id;
    if (!recoveryCodeId) throw new TotpFactorError("Recovery code is invalid or has already been used");

    await client.query("UPDATE fractal.totp_recovery_codes SET used_at = now() WHERE id = $1", [recoveryCodeId]);
    await client.query(
      `UPDATE fractal.totp_recovery_codes SET replaced_at = now()
        WHERE identity_id = $1 AND id <> $2 AND used_at IS NULL AND replaced_at IS NULL`,
      [input.identityId, recoveryCodeId],
    );
    await client.query(
      `UPDATE fractal.totp_factors
          SET secret_ciphertext = $2, confirmed_at = NULL, last_used_counter = NULL, disabled_at = NULL, updated_at = now()
        WHERE identity_id = $1`,
      [input.identityId, encrypt(secret)],
    );
    await client.query("DELETE FROM fractal.auth_step_up_grants WHERE identity_id = $1", [input.identityId]);
    await client.query(
      `UPDATE fractal.auth_sessions
          SET revoked_at = now(), revoked_reason = 'mfa_recovery'
        WHERE subject_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [subjectId, input.sessionId],
    );
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${input.identityId}`,
      actorId: input.identityId,
      actorType: "user",
      action: "auth.totp.recovered",
      entityType: "totp_factor",
      entityId: input.identityId,
      payload: { sessionId: input.sessionId, otherSessionsRevoked: true, priorStepUpRevoked: true },
    });
  });
  return { secret, otpauthUri: `otpauth://totp/Fractal:${input.identityId}?secret=${secret}&issuer=Fractal&algorithm=SHA1&digits=6&period=30` };
}
