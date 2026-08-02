import type { FastifyInstance } from "fastify";
import { anchorRoutes } from "../modules/anchors/index.js";
import { chatRoutes } from "../modules/chat/index.js";
import { applicationRoutes } from "../modules/applications/index.js";
import { assetRoutes } from "../modules/assets/index.js";
import { authRoutes } from "../modules/auth/index.js";
import { businessRoutes } from "../modules/businesses/index.js";
import { disputeRoutes } from "../modules/disputes/index.js";
import { distributionRoutes, postgresDistributionPayoutRoutes, postgresDistributionRoutes, postgresDistributionTaxRoutes } from "../modules/distributions/index.js";
import { dossierRoutes } from "../modules/dossiers/index.js";
import { eventRoutes } from "../modules/events/index.js";
import { investorRoutes } from "../modules/investor/index.js";
import { milestoneRoutes } from "../modules/milestones/index.js";
import { notificationRoutes } from "../modules/notifications/index.js";
import { offeringRoutes, postgresOfferingGovernanceRoutes, postgresOfferingNoticeRoutes } from "../modules/offerings/index.js";
import { platformRoutes } from "../modules/platform/index.js";
import { postgresProfessionalWorkOrderRoutes, professionalRoutes } from "../modules/professionals/index.js";
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
import { investmentOfferingReadRoutes, paymentCheckoutRoutes, paymentUtilRoutes } from "../modules/payments/index.js";
import { complianceReportRoutes } from "../modules/compliance-reports/routes/compliance-reports.routes.js";
import { webhookAdminRoutes } from "../modules/webhooks/routes/webhook-admin.routes.js";
import { dataPrivacyRoutes } from "../modules/investor/routes/data-privacy.routes.js";
import { developerRoutes } from "../modules/developer/index.js";
import { secondaryTransferRoutes } from "../modules/secondary-transfers/index.js";
import { capTableRoutes } from "../modules/cap-table/index.js";
import { postgresInvestorWalletRoutes } from "../modules/investor/routes/postgres-investor-wallets.routes.js";
import { postgresAdminDataLifecycleRoutes, postgresAdminPlatformConfigurationRoutes, postgresAdminPlatformContentRoutes, postgresAdminProviderIncidentRoutes, postgresAdminReadRoutes } from "../modules/admin/index.js";
import { postgresOrganizationAuthorityRoutes } from "../modules/organizations/index.js";
import { postgresSupportCaseRoutes } from "../modules/support/index.js";
import { postgresPrivacyRightsRoutes } from "../modules/privacy/index.js";
const ROUTE_REGISTRARS = [
  authRoutes,
  platformRoutes,
  templateRoutes,
  professionalRoutes,
  postgresProfessionalWorkOrderRoutes,
  businessRoutes,
  assetRoutes,
  userRoutes,
  applicationRoutes,
  workOrderRoutes,
  dossierRoutes,
  offeringRoutes,
  postgresOfferingGovernanceRoutes,
  postgresOfferingNoticeRoutes,
  postgresDistributionRoutes,
  postgresDistributionPayoutRoutes,
  postgresDistributionTaxRoutes,
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
  paymentUtilRoutes,
  investmentOfferingReadRoutes,
  paymentCheckoutRoutes,
  complianceReportRoutes,
  dataPrivacyRoutes,
  webhookAdminRoutes,
  developerRoutes,
  secondaryTransferRoutes,
  capTableRoutes,
  postgresInvestorWalletRoutes,
  postgresAdminReadRoutes,
  postgresAdminProviderIncidentRoutes,
  postgresAdminPlatformConfigurationRoutes,
  postgresAdminPlatformContentRoutes,
  postgresAdminDataLifecycleRoutes,
  postgresOrganizationAuthorityRoutes,
  postgresSupportCaseRoutes,
  postgresPrivacyRightsRoutes,
] as const;

export async function registerApiRoutes(app: FastifyInstance) {
  for (const register of ROUTE_REGISTRARS) {
    await app.register(register);
  }
}
