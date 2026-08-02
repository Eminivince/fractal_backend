/**
 * Baseline migration: ensures critical compound indexes exist.
 * These indexes should already exist via Mongoose schema definitions,
 * but this migration serves as an auditable record.
 */

export const up = async (db) => {
  await db.collection("subscriptions").createIndex(
    { offeringId: 1, investorUserId: 1 },
    { background: true },
  );
  await db.collection("subscriptions").createIndex(
    { offeringId: 1, status: 1 },
    { background: true },
  );
  await db.collection("eventLogs").createIndex(
    { entityType: 1, entityId: 1, timestamp: -1 },
    { background: true },
  );
  await db.collection("webhookEvents").createIndex(
    { provider: 1, externalId: 1 },
    { unique: true, background: true },
  );
  await db.collection("webhookEvents").createIndex(
    { receivedAt: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60, background: true },
  );
};

export const down = async (db) => {
  await db.collection("webhookEvents").dropIndex("provider_1_externalId_1").catch(() => {});
  await db.collection("webhookEvents").dropIndex("receivedAt_1").catch(() => {});
};
