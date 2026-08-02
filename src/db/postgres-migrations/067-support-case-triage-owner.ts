import type { PostgresMigration } from "./types.js";

/** Allows the triage event to establish the first capable support-case owner. */
export const supportCaseTriageOwnerMigration: PostgresMigration = {
  version: "067-support-case-triage-owner",
  sql: `
    ALTER TABLE fractal.support_case_events
      DROP CONSTRAINT IF EXISTS support_case_event_shape;
    ALTER TABLE fractal.support_case_events
      ADD CONSTRAINT support_case_event_shape CHECK (
        (event_type = 'opened' AND sequence = 1 AND from_status IS NULL AND to_status = 'new'
          AND from_assignee_identity_id IS NULL AND assignee_identity_id IS NULL AND visibility = 'requester')
        OR (event_type IN ('requester_message', 'staff_message', 'staff_note') AND sequence > 1 AND from_status = to_status
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id
          AND ((event_type IN ('requester_message', 'staff_message') AND visibility = 'requester') OR event_type = 'staff_note'))
        OR (event_type = 'assigned' AND sequence > 1 AND from_status = to_status AND to_status <> 'closed'
          AND from_assignee_identity_id IS DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'internal')
        OR (event_type = 'triaged' AND sequence > 1 AND from_status = 'new' AND to_status = 'triaged'
          AND from_assignee_identity_id IS NULL AND assignee_identity_id IS NOT NULL AND visibility = 'internal')
        OR (event_type = 'status_changed' AND sequence > 1
          AND ((from_status = 'triaged' AND to_status IN ('in_progress', 'waiting_requester'))
            OR (from_status = 'in_progress' AND to_status = 'waiting_requester')
            OR (from_status = 'waiting_requester' AND to_status = 'in_progress'))
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL)
        OR (event_type = 'resolved' AND sequence > 1 AND from_status IN ('triaged', 'in_progress', 'waiting_requester') AND to_status = 'resolved'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'requester')
        OR (event_type = 'closed' AND sequence > 1 AND from_status = 'resolved' AND to_status = 'closed'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND visibility = 'requester')
        OR (event_type = 'reopened' AND sequence > 1 AND from_status IN ('resolved', 'closed') AND to_status = 'in_progress'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'requester')
      );
  `,
};
