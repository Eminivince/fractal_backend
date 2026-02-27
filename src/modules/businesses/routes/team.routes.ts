import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { BusinessInviteModel, BusinessModel, UserModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import { HttpError } from "../../../utils/errors.js";
import { appendEvent } from "../../../utils/audit.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { runInTransaction } from "../../../utils/tx.js";
import { sendEmailWithFallback } from "../../../services/email.js";
import { env } from "../../../config/env.js";

const INVITE_TTL_DAYS = 7;

function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function businessTeamRoutes(app: FastifyInstance) {
  // List team members for a business
  app.get(
    "/v1/businesses/:id/members",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = z.object({ id: z.string() }).parse(request.params);

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, params.id);
      }

      const business = await BusinessModel.findById(params.id).lean();
      if (!business) throw new HttpError(404, "Business not found");

      const members = await UserModel.find({
        businessId: params.id,
        status: "active",
        role: "issuer",
      })
        .select("_id name email businessRole createdAt")
        .lean();

      return serialize(members);
    },
  );

  // Create an invite for a new team member
  app.post(
    "/v1/businesses/:id/invites",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          email: z.string().email(),
          // I-62: Expanded team roles
          role: z.enum(["owner", "member", "finance", "legal", "viewer"]).default("member"),
        })
        .parse(request.body);

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, params.id);

        const inviter = await UserModel.findById(request.authUser.userId).lean() as any;
        if (!inviter || inviter.businessRole !== "owner") {
          throw new HttpError(403, "Only business owners can invite team members");
        }
      }

      const business = await BusinessModel.findById(params.id).lean();
      if (!business) throw new HttpError(404, "Business not found");

      // Check if the email already belongs to a member of this business
      const existingMember = await UserModel.findOne({
        email: payload.email.toLowerCase(),
        businessId: params.id,
      }).lean();
      if (existingMember) {
        throw new HttpError(422, "This email address is already a member of your business");
      }

      // Cancel any existing pending invite for this email+business
      await BusinessInviteModel.updateMany(
        { businessId: params.id, email: payload.email.toLowerCase(), status: "pending" },
        { $set: { status: "cancelled" } },
      );

      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
      const [invite] = await BusinessInviteModel.create([
        {
          businessId: params.id,
          email: payload.email.toLowerCase(),
          role: payload.role,
          invitedBy: request.authUser.userId,
          token: generateInviteToken(),
          status: "pending",
          expiresAt,
        },
      ]);

      await appendEvent(
        request.authUser,
        {
          entityType: "business",
          entityId: params.id,
          action: "TeamInviteSent",
          notes: `email:${payload.email} role:${payload.role}`,
        },
      );

      // I-61: Send invite email to the invitee
      const appBaseUrl = env.APP_BASE_URL ?? "http://localhost:3000";
      const acceptUrl = `${appBaseUrl}/issuer/team/accept?token=${(invite as any).token}`;
      await sendEmailWithFallback({
        to: payload.email,
        subject: `You've been invited to join ${(business as any).name} on Fractal`,
        text: [
          `Hi,`,
          ``,
          `${(business as any).name} has invited you to join their team on Fractal as a ${payload.role}.`,
          ``,
          `Accept your invitation by clicking the link below:`,
          `${acceptUrl}`,
          ``,
          `This invite expires in ${INVITE_TTL_DAYS} days.`,
          ``,
          `If you did not expect this invitation, you can ignore this email.`,
          ``,
          `— The Fractal Team`,
        ].join("\n"),
        html: `
          <p>Hi,</p>
          <p><strong>${(business as any).name}</strong> has invited you to join their team on Fractal as a <strong>${payload.role}</strong>.</p>
          <p><a href="${acceptUrl}" style="background:#0070f3;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Accept Invitation</a></p>
          <p>Or copy this link: <code>${acceptUrl}</code></p>
          <p>This invite expires in ${INVITE_TTL_DAYS} days. If you did not expect this invitation, you can ignore this email.</p>
          <p>— The Fractal Team</p>
        `.trim(),
      }).catch(() => {
        // Email delivery failure is non-fatal — invite is still valid
      });

      return serialize(invite.toObject());
    },
  );

  // List pending invites for a business
  app.get(
    "/v1/businesses/:id/invites",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = z.object({ id: z.string() }).parse(request.params);

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, params.id);
      }

      const invites = await BusinessInviteModel.find({
        businessId: params.id,
        status: "pending",
      })
        .sort({ createdAt: -1 })
        .lean();

      return serialize(invites);
    },
  );

  // Cancel a pending invite
  app.delete(
    "/v1/businesses/:id/invites/:inviteId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = z.object({ id: z.string(), inviteId: z.string() }).parse(request.params);

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, params.id);
      }

      const invite = await BusinessInviteModel.findOne({
        _id: params.inviteId,
        businessId: params.id,
      });
      if (!invite) throw new HttpError(404, "Invite not found");
      if (invite.status !== "pending") {
        throw new HttpError(422, "Only pending invites can be cancelled");
      }

      invite.status = "cancelled";
      await invite.save();

      return { success: true };
    },
  );

  // Accept an invite (public route — no existing auth required)
  app.post(
    "/v1/businesses/invites/:token/accept",
    async (request: FastifyRequest) => {
      const params = z.object({ token: z.string() }).parse(request.params);
      const payload = z
        .object({
          name: z.string().min(1),
          password: z.string().min(8),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const invite = await BusinessInviteModel.findOne({ token: params.token }).session(session);
        if (!invite) throw new HttpError(404, "Invite not found or already used");
        if (invite.status !== "pending") {
          throw new HttpError(422, "This invite has already been used or cancelled");
        }
        if (new Date() > invite.expiresAt) {
          invite.status = "expired";
          await invite.save({ session });
          throw new HttpError(422, "This invite has expired");
        }

        const business = await BusinessModel.findById(invite.businessId).session(session).lean();
        if (!business) throw new HttpError(404, "Business not found");

        // Check if a user with this email already exists
        let user = await UserModel.findOne({ email: invite.email }).session(session);
        if (user) {
          // Link existing user to this business
          if (user.businessId && String(user.businessId) !== String(invite.businessId)) {
            throw new HttpError(422, "This email is already associated with a different business");
          }
          user.businessId = invite.businessId;
          user.businessRole = invite.role;
          user.role = "issuer";
          await user.save({ session });
        } else {
          const bcrypt = await import("bcrypt");
          const passwordHash = await bcrypt.hash(payload.password, 12);
          const [created] = await UserModel.create(
            [
              {
                email: invite.email,
                name: payload.name,
                role: "issuer",
                businessId: invite.businessId,
                businessRole: invite.role,
                status: "active",
                passwordHash,
              },
            ],
            { session },
          );
          user = created;
        }

        invite.status = "accepted";
        invite.acceptedAt = new Date();
        invite.acceptedByUserId = user._id;
        await invite.save({ session });

        const inviterAuthUser = {
          userId: String(invite.invitedBy),
          role: "issuer" as const,
          businessId: String(invite.businessId),
        };
        await appendEvent(
          inviterAuthUser,
          {
            entityType: "business",
            entityId: String(invite.businessId),
            action: "TeamInviteAccepted",
            notes: `email:${invite.email} role:${invite.role}`,
          },
          session,
        );

        return {
          message: "Invite accepted. You can now log in.",
          email: invite.email,
          businessId: String(invite.businessId),
          businessName: (business as any).name,
        };
      });
    },
  );

  // Remove a team member from a business
  app.delete(
    "/v1/businesses/:id/members/:userId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = z.object({ id: z.string(), userId: z.string() }).parse(request.params);

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, params.id);
        const remover = await UserModel.findById(request.authUser.userId).lean() as any;
        if (!remover || remover.businessRole !== "owner") {
          throw new HttpError(403, "Only business owners can remove team members");
        }
      }

      if (params.userId === request.authUser.userId) {
        throw new HttpError(422, "You cannot remove yourself from the business");
      }

      const member = await UserModel.findOne({
        _id: params.userId,
        businessId: params.id,
        role: "issuer",
      });
      if (!member) throw new HttpError(404, "Member not found in this business");

      if ((member as any).businessRole === "owner") {
        const ownerCount = await UserModel.countDocuments({
          businessId: params.id,
          role: "issuer",
          businessRole: "owner",
          status: "active",
        });
        if (ownerCount <= 1) {
          throw new HttpError(422, "Cannot remove the only owner of a business");
        }
      }

      (member as any).businessId = undefined;
      (member as any).businessRole = undefined;
      await member.save();

      await appendEvent(
        request.authUser,
        {
          entityType: "business",
          entityId: params.id,
          action: "TeamMemberRemoved",
          notes: `userId:${params.userId}`,
        },
      );

      return { success: true };
    },
  );
}
