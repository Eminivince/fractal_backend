/**
 * Production index management.
 *
 * With autoIndex disabled in production, every index a hot collection needs must be
 * created explicitly here (migrations run before/independently of app boot, so they
 * don't block request handling). Index creation is idempotent — re-running is safe.
 */

export const up = async (db) => {
  const bg = { background: true };

  // ledgerEntries — financial source of truth
  await db.collection("ledgerEntries").createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true, ...bg });
  await db.collection("ledgerEntries").createIndex({ accountRef: 1, direction: 1 }, bg);
  await db.collection("ledgerEntries").createIndex({ entityType: 1, entityId: 1, createdAt: -1 }, bg);
  await db.collection("ledgerEntries").createIndex({ ledgerType: 1 }, bg);
  await db.collection("ledgerEntries").createIndex({ postedAt: 1 }, bg);

  // subscriptions
  await db.collection("subscriptions").createIndex({ offeringId: 1, investorUserId: 1 }, bg);
  await db.collection("subscriptions").createIndex({ offeringId: 1, status: 1 }, bg);
  await db.collection("subscriptions").createIndex({ investorUserId: 1, status: 1 }, bg);
  await db.collection("subscriptions").createIndex({ paystackReference: 1 }, { sparse: true, ...bg });

  // distributions + lines
  await db.collection("distributions").createIndex({ offeringId: 1, status: 1 }, bg);
  await db.collection("distribution_lines").createIndex({ distributionId: 1, investorUserId: 1 }, { unique: true, ...bg });
  await db.collection("distribution_lines").createIndex({ status: 1 }, bg);

  // payment intents + outbound transfers + DVAs
  await db.collection("paymentIntents").createIndex({ subscriptionId: 1, paystackReference: 1 }, bg);
  await db.collection("paymentIntents").createIndex({ paystackReference: 1 }, { sparse: true, ...bg });
  await db.collection("outboundTransfers").createIndex({ status: 1, createdAt: 1 }, bg);
  await db.collection("outboundTransfers").createIndex({ transferCode: 1 }, { sparse: true, ...bg });
  await db.collection("outboundTransfers").createIndex({ reference: 1 }, bg);

  // blockchain ops queue
  await db.collection("blockchainOps").createIndex({ status: 1, retryCount: 1, createdAt: 1 }, bg);
  await db.collection("blockchainOps").createIndex({ status: 1, nextRetryAt: 1 }, bg);
  await db.collection("blockchainOps").createIndex({ txHash: 1 }, { sparse: true, ...bg });

  // users — auth + token lookups
  await db.collection("users").createIndex({ email: 1 }, { unique: true, ...bg });
  await db.collection("users").createIndex({ passwordResetToken: 1 }, { sparse: true, ...bg });
  await db.collection("users").createIndex({ emailVerifyToken: 1 }, { sparse: true, ...bg });

  // event log (audit trail) + hash chain
  await db.collection("eventLogs").createIndex({ entityType: 1, entityId: 1, timestamp: -1 }, bg);
  await db.collection("eventLogs").createIndex({ action: 1, timestamp: -1 }, bg);
  await db.collection("eventLogs").createIndex({ hash: 1 }, { sparse: true, ...bg });

  // webhook idempotency + TTL
  await db.collection("webhookEvents").createIndex({ provider: 1, externalId: 1 }, { unique: true, ...bg });

  // investor profiles
  await db.collection("investorProfiles").createIndex({ userId: 1 }, bg);
  await db.collection("investorProfiles").createIndex({ sumsubApplicantId: 1 }, { sparse: true, ...bg });

  // developer API keys + outbound webhooks
  await db.collection("apiKeys").createIndex({ keyHash: 1 }, { unique: true, ...bg });
  await db.collection("apiKeys").createIndex({ businessId: 1 }, bg);
  await db.collection("issuerWebhooks").createIndex({ businessId: 1, active: 1 }, bg);

  // secondary-market transfers
  await db.collection("secondaryTransfers").createIndex({ offeringId: 1, status: 1 }, bg);
  await db.collection("secondaryTransfers").createIndex({ fromUserId: 1 }, bg);
  await db.collection("secondaryTransfers").createIndex({ toUserId: 1 }, bg);
};

export const down = async (db) => {
  // Index drops are intentionally conservative — only drop ones unique to this migration.
  const safeDrop = async (coll, name) => {
    await db.collection(coll).dropIndex(name).catch(() => {});
  };
  await safeDrop("users", "passwordResetToken_1");
  await safeDrop("users", "emailVerifyToken_1");
  await safeDrop("eventLogs", "hash_1");
  await safeDrop("blockchainOps", "status_1_nextRetryAt_1");
};
