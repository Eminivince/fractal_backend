import type { FastifyInstance } from "fastify";
import { anchorRoutes } from "../modules/anchors/index.js";
import { chatRoutes } from "../modules/chat/index.js";
import { applicationRoutes } from "../modules/applications/index.js";
import { assetRoutes } from "../modules/assets/index.js";
import { authRoutes } from "../modules/auth/index.js";
import { businessRoutes } from "../modules/businesses/index.js";
import { disputeRoutes } from "../modules/disputes/index.js";
import { distributionRoutes } from "../modules/distributions/index.js";
import { dossierRoutes } from "../modules/dossiers/index.js";
import { eventRoutes } from "../modules/events/index.js";
import { investorRoutes } from "../modules/investor/index.js";
import { milestoneRoutes } from "../modules/milestones/index.js";
import { notificationRoutes } from "../modules/notifications/index.js";
import { offeringRoutes } from "../modules/offerings/index.js";
import { platformRoutes } from "../modules/platform/index.js";
import { professionalRoutes } from "../modules/professionals/index.js";
import { reconciliationRoutes } from "../modules/reconciliation/index.js";
import { subscriptionRoutes } from "../modules/subscriptions/index.js";
import { systemRoutes } from "../modules/system/index.js";
import { templateRoutes } from "../modules/templates/index.js";
import { userRoutes } from "../modules/users/index.js";
import { workOrderRoutes } from "../modules/work-orders/index.js";
import { paystackWebhookRoutes, sumsubWebhookRoutes } from "../modules/webhooks/index.js";
import { blockchainRoutes } from "../modules/blockchain/index.js";
import { suitabilityRoutes } from "../modules/investor/routes/suitability.routes.js";
import { applicationReviewRoutes } from "../modules/applications/routes/review.routes.js";
import { offeringDocumentRoutes } from "../modules/offerings/routes/offering-documents.routes.js";
const ROUTE_REGISTRARS = [
  authRoutes,
  platformRoutes,
  templateRoutes,
  professionalRoutes,
  businessRoutes,
  assetRoutes,
  userRoutes,
  applicationRoutes,
  workOrderRoutes,
  dossierRoutes,
  offeringRoutes,
  investorRoutes,
  subscriptionRoutes,
  distributionRoutes,
  milestoneRoutes,
  eventRoutes,
  anchorRoutes,
  reconciliationRoutes,
  notificationRoutes,
  disputeRoutes,
  systemRoutes,
  paystackWebhookRoutes,
  sumsubWebhookRoutes,
  chatRoutes,
  blockchainRoutes,
  suitabilityRoutes,
  applicationReviewRoutes,
  offeringDocumentRoutes,
] as const;

export async function registerApiRoutes(app: FastifyInstance) {
  for (const register of ROUTE_REGISTRARS) {
    await app.register(register);
  }
}
