import { requirePostgres } from "../db/postgres.js";

export type ResendPrivacyDeliveryReference = {
  providerMessageId: string;
  recipientEmail: string;
};

type Queryable = {
  query: <T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

/**
 * Resolve only durable Resend records that have an exact identity relation.
 * The query does not infer identity from a current email address.
 */
export async function queryResendPrivacyDeliveryReferencesForIdentity(
  queryable: Queryable,
  identityId: string,
): Promise<ResendPrivacyDeliveryReference[]> {
  const result = await queryable.query<{
    provider_message_id: string;
    recipient_email: string;
  }>(
    `SELECT provider_message_id, recipient_email
       FROM (
         SELECT delivery.provider_message_id, identity.email AS recipient_email
           FROM fractal.auth_email_deliveries delivery
           JOIN fractal.identities identity ON identity.id = delivery.identity_id
          WHERE delivery.identity_id = $1
            AND delivery.status = 'sent'
            AND delivery.provider = 'resend'
            AND delivery.provider_message_id IS NOT NULL
         UNION ALL
         SELECT delivery.provider_message_id, identity.email AS recipient_email
           FROM fractal.support_case_notification_deliveries delivery
           JOIN fractal.identities identity ON identity.id = delivery.recipient_identity_id
          WHERE delivery.recipient_identity_id = $1
            AND delivery.status = 'sent'
            AND delivery.provider = 'resend'
            AND delivery.provider_message_id IS NOT NULL
         UNION ALL
         SELECT invitation.delivery_provider_message_id AS provider_message_id,
                identity.email AS recipient_email
           FROM fractal.organization_invitations invitation
           JOIN fractal.identities identity
             ON identity.id = invitation.accepted_by_identity_id
          WHERE invitation.accepted_by_identity_id = $1
            AND invitation.delivery_provider = 'resend'
            AND invitation.delivery_provider_message_id IS NOT NULL
       ) exact_references
      ORDER BY provider_message_id`,
    [identityId],
  );
  return result.rows.map((row) => ({
    providerMessageId: row.provider_message_id,
    recipientEmail: row.recipient_email,
  }));
}

export async function listResendPrivacyDeliveryReferencesForIdentity(
  identityId: string,
): Promise<ResendPrivacyDeliveryReference[]> {
  return queryResendPrivacyDeliveryReferencesForIdentity(
    requirePostgres(),
    identityId,
  );
}
