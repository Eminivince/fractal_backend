import { describe, expect, it } from "vitest";
import type { ChainPrivacyRecord } from "../../platform/postgres-chain-privacy-references.js";
import {
  collectPublicChainPrivacyRecords,
} from "../privacy-external-chain-adapter.js";
import {
  resolvePrivacyExternalWorkerSourceKeys,
} from "../privacy-external-snapshot-worker.js";

const wallet = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";
const transaction = `0x${"3".repeat(64)}`;

function records(): ChainPrivacyRecord[] {
  return [{
    recordType: "allocation_transaction",
    chainId: 11155111,
    walletAddress: wallet,
    transactionHash: transaction,
    tokenContractAddress: contract,
    operationType: "mint",
  }, {
    recordType: "wallet",
    chainId: 11155111,
    walletAddress: wallet,
  }];
}

describe("public-chain external privacy adapter", () => {
  it("returns a deterministic safe projection and permits a proved empty result", () => {
    const collected = collectPublicChainPrivacyRecords({
      records: records(),
      maximumRecords: 10,
      maximumBytes: 4_096,
    });
    expect(collected.map((record) => record.recordType)).toEqual([
      "allocation_transaction",
      "wallet",
    ]);
    expect(collectPublicChainPrivacyRecords({
      records: [],
      maximumRecords: 10,
      maximumBytes: 1_024,
    })).toEqual([]);
    expect(JSON.stringify(collected)).not.toMatch(
      /privateKey|signature|rpc|worker|failureReason/,
    );
  });

  it("rejects duplicates, invalid public facts, and bound violations", () => {
    const duplicate = [records()[0]!, records()[0]!];
    expect(() => collectPublicChainPrivacyRecords({
      records: duplicate,
      maximumRecords: 10,
      maximumBytes: 4_096,
    })).toThrow("must be unique");
    expect(() => collectPublicChainPrivacyRecords({
      records: [{
        recordType: "wallet",
        chainId: 11155111,
        walletAddress: "0xINVALID",
      } as ChainPrivacyRecord],
      maximumRecords: 10,
      maximumBytes: 4_096,
    })).toThrow("invalid");
    expect(() => collectPublicChainPrivacyRecords({
      records: records(),
      maximumRecords: 1,
      maximumBytes: 4_096,
    })).toThrow("record count");
    expect(() => collectPublicChainPrivacyRecords({
      records: records(),
      maximumRecords: 10,
      maximumBytes: 1_024,
    })).not.toThrow();
  });

  it("lets a worker claim only fully configured adapter types", () => {
    expect(resolvePrivacyExternalWorkerSourceKeys({
      chainAdapterSha256: "a".repeat(64),
    })).toEqual(["external.chain.public_records"]);
    expect(resolvePrivacyExternalWorkerSourceKeys({
      resendAdapterSha256: "b".repeat(64),
    })).toEqual([]);
    expect(resolvePrivacyExternalWorkerSourceKeys({
      resendAdapterSha256: "b".repeat(64),
      resendCollectionApiKey: "re_read_only",
    })).toEqual(["external.resend.delivery"]);
    expect(resolvePrivacyExternalWorkerSourceKeys({
      chainAdapterSha256: "a".repeat(64),
      resendAdapterSha256: "b".repeat(64),
      resendCollectionApiKey: "re_read_only",
      sumsubAdapterSha256: "c".repeat(64),
      sumsubAppToken: "privacy-app-token",
      sumsubSecretKey: "privacy-secret-key",
    })).toEqual([
      "external.chain.public_records",
      "external.resend.delivery",
      "external.identity_verification.provider",
    ]);
    expect(resolvePrivacyExternalWorkerSourceKeys({
      sumsubAdapterSha256: "c".repeat(64),
      sumsubAppToken: "privacy-app-token",
    })).toEqual([]);
  });
});
