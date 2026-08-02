import type { PostgresMigration } from "./types.js";

/** Link capacity reservations to the exact payment commitment that consumes them. */
export const reservationCommitmentLinkMigration: PostgresMigration = {
  version: "014-reservation-commitment-link",
  sql: `
    ALTER TABLE fractal.investment_reservations
      ADD CONSTRAINT investment_reservations_commitment_id_fkey
      FOREIGN KEY (commitment_id) REFERENCES fractal.investment_commitments(id);
  `,
};
