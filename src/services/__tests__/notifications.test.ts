import { beforeEach, describe, expect, it, vi } from "vitest";

const userFind = vi.hoisted(() => vi.fn());
const applicationFindById = vi.hoisted(() => vi.fn());
const distributionFindById = vi.hoisted(() => vi.fn());
const milestoneFindById = vi.hoisted(() => vi.fn());
const notificationCreate = vi.hoisted(() => vi.fn());
const findOneAndUpdate = vi.hoisted(() => vi.fn());
const findByIdAndUpdate = vi.hoisted(() => vi.fn());
const offeringFindById = vi.hoisted(() => vi.fn());
const workOrderFindById = vi.hoisted(() => vi.fn());
const subscriptionFind = vi.hoisted(() => vi.fn());
const subscriptionFindById = vi.hoisted(() => vi.fn());
const taskFindById = vi.hoisted(() => vi.fn());
const trancheFindById = vi.hoisted(() => vi.fn());
const emitUserEvent = vi.hoisted(() => vi.fn());
const hasEmailTransport = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock("../../db/models.js", () => ({
  ApplicationModel: { findById: applicationFindById },
  DistributionModel: { findById: distributionFindById },
  MilestoneModel: { findById: milestoneFindById },
  NotificationModel: { create: notificationCreate, findOneAndUpdate, findByIdAndUpdate },
  OfferingModel: { findById: offeringFindById },
  ProfessionalWorkOrderModel: { findById: workOrderFindById },
  SubscriptionModel: { find: subscriptionFind, findById: subscriptionFindById },
  TaskModel: { findById: taskFindById },
  TrancheModel: { findById: trancheFindById },
  UserModel: { find: userFind },
}));
vi.mock("../event-bus.js", () => ({ emitUserEvent }));
vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../email.js", () => ({
  hasAnyEmailTransportConfigured: hasEmailTransport,
  sendEmailWithFallback: sendEmail,
}));

import { createNotificationsFromEvent, processPendingNotificationEmails } from "../notifications.js";

function query(value: unknown) {
  const result: any = Promise.resolve(value);
  result.session = vi.fn().mockReturnValue(result);
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockReturnValue(result) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(env).forEach((key) => delete env[key]);
  env.NOTIFICATION_EMAIL_ENABLED = true;
  env.NOTIFICATION_EMAIL_MAX_RETRIES = 2;
  hasEmailTransport.mockReturnValue(true);
});

describe("event notification creation", () => {
  it("creates deduplicated notification rows and pushes real-time events", async () => {
    userFind.mockImplementation((filter: any) => {
      if (filter.role?.$in) {
        return query([
          { _id: "admin-1", email: "ADMIN@FRACTAL.TEST ", name: " Platform Admin " },
          { _id: "actor-1", email: "actor@fractal.test" },
        ]);
      }
      if (filter.role === "issuer") {
        return query([{ _id: "issuer-1", email: "issuer@fractal.test", name: "Issuer Owner" }]);
      }
      throw new Error(`Unexpected user filter: ${JSON.stringify(filter)}`);
    });

    await createNotificationsFromEvent(
      { userId: "actor-1", role: "issuer" } as any,
      { entityType: "business", entityId: "business-1", action: "KYBApproved", notes: "  Verification is complete.  ", diff: { status: "approved" } },
    );

    expect(notificationCreate).toHaveBeenCalledOnce();
    const rows = notificationCreate.mock.calls[0]?.[0];
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipientUserId: "admin-1", recipientEmail: "admin@fractal.test", title: "KYB Approved", message: "Verification is complete.", channels: { email: expect.objectContaining({ status: "pending" }) } }),
      expect.objectContaining({ recipientUserId: "issuer-1", metadata: { diff: { status: "approved" } } }),
    ]));
    expect(emitUserEvent).toHaveBeenCalledTimes(2);
    expect(emitUserEvent).not.toHaveBeenCalledWith("actor-1", expect.anything());
  });

  it("marks email delivery as skipped when no transport is configured", async () => {
    hasEmailTransport.mockReturnValue(false);
    userFind.mockImplementation((filter: any) => query(
      filter.role?.$in ? [{ _id: "admin-1", email: "admin@fractal.test" }] : [],
    ));

    await createNotificationsFromEvent(
      { userId: "actor-1", role: "issuer" } as any,
      { entityType: "user", entityId: "user-2", action: "password_reset" },
    );

    expect(notificationCreate.mock.calls[0]?.[0]?.[0]).toMatchObject({
      title: "Password reset",
      channels: { email: { status: "skipped", lastError: "Email transport not configured" } },
    });
  });

  it("does not create a row when the actor is the only recipient", async () => {
    userFind.mockImplementation(() => query([{ _id: "actor-1", email: "actor@fractal.test" }]));
    await createNotificationsFromEvent(
      { userId: "actor-1", role: "admin" } as any,
      { entityType: "user", entityId: "actor-1", action: "ProfileUpdated" },
    );
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it("handles object IDs, invalid recipient IDs, missing email, and generic events", async () => {
    userFind.mockImplementation(() => query([
      { _id: { toString: () => "admin-object-id" }, name: "No Email" },
      { _id: { toString: () => "[object Object]" }, email: "ignored@fractal.test" },
    ]));
    await createNotificationsFromEvent(
      { userId: "actor-1", role: "operator" } as any,
      { entityType: "anchor" as any, entityId: "anchor-1", action: "" },
    );
    expect(notificationCreate.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ recipientUserId: "admin-object-id", title: "Workflow update", channels: { email: expect.objectContaining({ lastError: "Recipient has no email" }) } }),
    ]);
  });

  it("notifies issuer and subscribed investors when an offering changes", async () => {
    offeringFindById.mockReturnValue(query({ businessId: "business-1" }));
    subscriptionFind.mockReturnValue(query([{ investorUserId: "investor-1" }, { investorUserId: "investor-1" }]));
    userFind.mockImplementation((filter: any) => {
      if (filter.role?.$in) return query([{ _id: "admin-1", email: "admin@fractal.test" }]);
      if (filter.role === "issuer") return query([{ _id: "issuer-1", email: "issuer@fractal.test" }]);
      if (filter._id?.$in) return query([{ _id: "investor-1", email: "investor@fractal.test" }]);
      throw new Error(`Unexpected user filter: ${JSON.stringify(filter)}`);
    });

    await createNotificationsFromEvent({ userId: "actor-1", role: "operator" } as any, {
      entityType: "offering", entityId: "offering-1", action: "OfferingOpened",
    });

    expect(notificationCreate.mock.calls[0]?.[0]).toHaveLength(3);
    expect(subscriptionFind).toHaveBeenCalledWith({ offeringId: "offering-1" });
  });

  it("resolves application, task, work-order, subscription, and lifecycle recipients", async () => {
    applicationFindById.mockReturnValue(query({ businessId: "business-1" }));
    taskFindById.mockReturnValue(query({ applicationId: "application-1" }));
    workOrderFindById.mockReturnValue(query({ businessId: "business-1", assigneeUserId: "professional-1", createdBy: "creator-1" }));
    subscriptionFindById.mockReturnValue(query({ offeringId: "offering-1", investorUserId: "investor-1" }));
    offeringFindById.mockReturnValue(query({ businessId: "business-1" }));
    distributionFindById.mockReturnValue(query({ offeringId: "offering-1" }));
    milestoneFindById.mockReturnValue(query({ offeringId: "offering-1" }));
    trancheFindById.mockReturnValue(query({ offeringId: "offering-1" }));
    subscriptionFind.mockReturnValue(query([{ investorUserId: "investor-1" }]));
    userFind.mockImplementation((filter: any) => {
      if (filter.role?.$in) return query([{ _id: "admin-1", email: "admin@fractal.test" }]);
      if (filter.role === "issuer") return query([{ _id: "issuer-1", email: "issuer@fractal.test" }]);
      if (filter._id?.$in) return query(filter._id.$in.map((id: string) => ({ _id: id, email: `${id}@fractal.test` })));
      throw new Error(`Unexpected user filter: ${JSON.stringify(filter)}`);
    });
    const actor = { userId: "actor-1", role: "operator" } as any;

    for (const [entityType, entityId] of [
      ["application", "application-1"],
      ["task", "task-1"],
      ["work_order", "work-order-1"],
      ["subscription", "subscription-1"],
      ["distribution", "distribution-1"],
      ["milestone", "milestone-1"],
      ["tranche", "tranche-1"],
    ]) {
      await createNotificationsFromEvent(actor, { entityType: entityType as any, entityId, action: "StatusChanged" });
    }

    expect(notificationCreate).toHaveBeenCalledTimes(7);
    expect(workOrderFindById).toHaveBeenCalledWith("work-order-1");
    expect(distributionFindById).toHaveBeenCalledWith("distribution-1");
  });
});

describe("pending notification email delivery", () => {
  it("sends, skips, retries, and fails notifications as needed", async () => {
    const claims = [
      { _id: "missing-email", recipientEmail: "", channels: { email: { attempts: 1 } } },
      { _id: "sent", recipientEmail: "recipient@fractal.test", title: "Alert", message: "Use <care>", entityType: "business", entityId: "business-1", channels: { email: { attempts: 1 } } },
      { _id: "failed", recipientEmail: "recipient@fractal.test", title: "Alert", message: "Delivery failed", entityType: "business", entityId: "business-1", channels: { email: { attempts: 2 } } },
      { _id: "retry", recipientEmail: "recipient@fractal.test", title: "Alert", message: "Retry this", entityType: "business", entityId: "business-1", channels: { email: { attempts: 1 } } },
    ];
    for (const claim of claims) {
      findOneAndUpdate.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(claim) });
    }
    findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    sendEmail
      .mockResolvedValueOnce({ status: "sent", provider: "resend", providerMessageId: "msg-1" })
      .mockResolvedValueOnce({ status: "failed", error: "provider rejected request" })
      .mockResolvedValueOnce({ status: "failed", error: "temporary provider error" });

    await expect(processPendingNotificationEmails(10)).resolves.toEqual({ attempted: 4, sent: 1, failed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: "fractal-notification-sent",
      html: expect.stringContaining("&lt;care&gt;"),
    });
    const updatePayloads = findByIdAndUpdate.mock.calls.map((call) => call[1]);
    expect(updatePayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ $set: expect.objectContaining({ "channels.email.status": "skipped" }) }),
      expect.objectContaining({ $set: expect.objectContaining({ "channels.email.status": "sent" }) }),
      expect.objectContaining({ $set: expect.objectContaining({ "channels.email.status": "failed" }) }),
      expect.objectContaining({ $set: expect.objectContaining({ "channels.email.status": "pending" }) }),
    ]));
  });

  it("stops cleanly when no claim is available", async () => {
    findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    await expect(processPendingNotificationEmails()).resolves.toEqual({ attempted: 0, sent: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("marks a provider-skipped delivery as skipped", async () => {
    findOneAndUpdate
      .mockReturnValueOnce({ lean: vi.fn().mockResolvedValue({ _id: "skipped", recipientEmail: "recipient@fractal.test", channels: { email: { attempts: 1 } } }) })
      .mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    sendEmail.mockResolvedValue({ status: "skipped", error: "Provider is disabled" });

    await expect(processPendingNotificationEmails()).resolves.toEqual({ attempted: 1, sent: 0, failed: 0 });
    expect(findByIdAndUpdate).toHaveBeenCalledWith("skipped", expect.objectContaining({
      $set: expect.objectContaining({ "channels.email.status": "skipped", "channels.email.lastError": "Provider is disabled" }),
    }));
  });
});
