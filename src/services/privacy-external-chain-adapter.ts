import { z } from "zod";
import type { ChainPrivacyRecord } from "../platform/postgres-chain-privacy-references.js";
import { stableJsonStringify } from "../utils/idempotency.js";

export const CHAIN_PRIVACY_ADAPTER_KEY = "fractal.external.chain.public-records";
export const CHAIN_PRIVACY_ADAPTER_VERSION = "1.0.0";

export const CHAIN_PRIVACY_OUTPUT_FIELDS = [
  "balanceUnits",
  "blockHash",
  "blockNumber",
  "chainId",
  "operationType",
  "recordType",
  "tokenContractAddress",
  "transactionHash",
  "walletAddress",
] as const;

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const transactionHash = z.string().regex(/^0x[0-9a-f]{64}$/);
const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/);
const nonNegativeIntegerString = z.string().regex(/^(0|[1-9][0-9]*)$/);

const chainPrivacyRecordSchema = z.discriminatedUnion("recordType", [
  z.object({
    recordType: z.literal("wallet"),
    chainId: z.number().int().positive(),
    walletAddress: address,
  }).strict(),
  z.object({
    recordType: z.literal("allocation_transaction"),
    chainId: z.number().int().positive(),
    walletAddress: address,
    transactionHash,
    tokenContractAddress: address,
    operationType: z.enum(["whitelist", "mint"]),
  }).strict(),
  z.object({
    recordType: z.literal("ownership_snapshot"),
    chainId: z.number().int().positive(),
    walletAddress: address,
    tokenContractAddress: address,
    blockNumber: nonNegativeIntegerString,
    blockHash: transactionHash,
    balanceUnits: positiveIntegerString,
  }).strict(),
]);

export class ChainPrivacyAdapterError extends Error {}

export function collectPublicChainPrivacyRecords(input: {
  records: readonly ChainPrivacyRecord[];
  maximumRecords: number;
  maximumBytes: number;
}): ChainPrivacyRecord[] {
  if (
    !Number.isInteger(input.maximumRecords)
    || input.maximumRecords < 1
    || input.records.length > input.maximumRecords
  ) {
    throw new ChainPrivacyAdapterError("Public-chain record count exceeds the limit");
  }
  if (!Number.isInteger(input.maximumBytes) || input.maximumBytes < 1_024) {
    throw new ChainPrivacyAdapterError("Public-chain byte limit is invalid");
  }
  const records = input.records.map((record) => {
    const parsed = chainPrivacyRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new ChainPrivacyAdapterError("A public-chain record is invalid");
    }
    return parsed.data;
  });
  const canonical = records
    .map((record) => ({ key: stableJsonStringify(record), record }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(canonical.map((item) => item.key)).size !== canonical.length) {
    throw new ChainPrivacyAdapterError("Public-chain records must be unique");
  }
  const ordered = canonical.map((item) => item.record) as ChainPrivacyRecord[];
  if (Buffer.byteLength(stableJsonStringify(ordered), "utf8") > input.maximumBytes) {
    throw new ChainPrivacyAdapterError("Public-chain records exceed the byte limit");
  }
  return ordered;
}
