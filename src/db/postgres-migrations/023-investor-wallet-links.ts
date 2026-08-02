import type { PostgresMigration } from "./types.js";

/** Signed, identity-bound wallets are a prerequisite for any controlled mint. */
export const investorWalletLinksMigration: PostgresMigration = {
  version: "023-investor-wallet-links",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.investor_wallet_link_challenges (
      id UUID PRIMARY KEY,
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      chain_id INTEGER NOT NULL CHECK (chain_id > 0),
      wallet_address CHAR(42) NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
      message_hash CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('issued', 'consumed', 'expired')),
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'issued' AND consumed_at IS NULL) OR (status IN ('consumed', 'expired') AND consumed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS investor_wallet_link_challenges_pending_idx
      ON fractal.investor_wallet_link_challenges (investor_identity_id, expires_at, id)
      WHERE status = 'issued';

    CREATE TABLE IF NOT EXISTS fractal.investor_wallets (
      id UUID PRIMARY KEY,
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      chain_id INTEGER NOT NULL CHECK (chain_id > 0),
      wallet_address CHAR(42) NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
      link_challenge_id UUID NOT NULL UNIQUE REFERENCES fractal.investor_wallet_link_challenges(id),
      signature_hash CHAR(64) NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      verified_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
      UNIQUE (investor_identity_id, chain_id, wallet_address)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS investor_wallets_active_address_idx
      ON fractal.investor_wallets (chain_id, wallet_address) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS investor_wallets_investor_idx
      ON fractal.investor_wallets (investor_identity_id, chain_id, status, verified_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.enforce_investor_wallet_challenge_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.investor_wallet_link_challenges are not deletable'; END IF;
      IF NEW.id <> OLD.id OR NEW.investor_identity_id <> OLD.investor_identity_id OR NEW.chain_id <> OLD.chain_id
         OR NEW.wallet_address <> OLD.wallet_address OR NEW.message_hash <> OLD.message_hash OR NEW.expires_at <> OLD.expires_at
         OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'fractal.investor_wallet_link_challenge facts are immutable'; END IF;
      IF OLD.status <> 'issued' OR NEW.status NOT IN ('consumed', 'expired') THEN
        RAISE EXCEPTION 'invalid investor wallet link challenge transition';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS investor_wallet_link_challenge_guard ON fractal.investor_wallet_link_challenges;
    CREATE TRIGGER investor_wallet_link_challenge_guard
      BEFORE UPDATE OR DELETE ON fractal.investor_wallet_link_challenges
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_investor_wallet_challenge_transition();

    CREATE OR REPLACE FUNCTION fractal.enforce_investor_wallet_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.investor_wallets are not deletable'; END IF;
      IF NEW.id <> OLD.id OR NEW.investor_identity_id <> OLD.investor_identity_id OR NEW.chain_id <> OLD.chain_id
         OR NEW.wallet_address <> OLD.wallet_address OR NEW.link_challenge_id <> OLD.link_challenge_id
         OR NEW.signature_hash <> OLD.signature_hash OR NEW.verified_at <> OLD.verified_at OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'fractal.investor_wallet facts are immutable';
      END IF;
      IF OLD.status <> 'active' OR NEW.status <> 'revoked' THEN RAISE EXCEPTION 'invalid investor wallet transition'; END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS investor_wallet_guard ON fractal.investor_wallets;
    CREATE TRIGGER investor_wallet_guard
      BEFORE UPDATE OR DELETE ON fractal.investor_wallets
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_investor_wallet_transition();
  `,
};
