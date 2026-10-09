-- Up Migration

-- Taskra schema v1. Specification: docs/04-DATABASE-SPEC.md.
--
-- Nothing in this database is authoritative for money or task state. Every
-- column prefixed `chain_` and every row of `settlements` is a copy of what
-- was read from Solana, tagged with how final that read was.

-- --- Roles ------------------------------------------------------------------
-- Two group roles separate what request-handling code may write from what the
-- attestation service may write. Services run `SET ROLE` to one of them.

DO $$
BEGIN
  BEGIN
    CREATE ROLE taskra_api NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE taskra_attester NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  -- A non-superuser migration login needs membership to SET ROLE in
  -- single-credential (development) mode.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT taskra_api, taskra_attester TO %I', current_user);
  END IF;
END $$;

-- --- Shared domains ---------------------------------------------------------

CREATE DOMAIN solana_address AS text
  CHECK (VALUE ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
CREATE DOMAIN sha256_hex AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN git_sha AS text
  CHECK (VALUE ~ '^[0-9a-f]{40}$');
-- Token base units: a u64, never a float.
CREATE DOMAIN token_amount AS numeric(20, 0)
  CHECK (VALUE >= 0 AND VALUE <= 18446744073709551615);
CREATE DOMAIN tx_signature AS text
  CHECK (VALUE ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');

-- --- Identity ---------------------------------------------------------------

-- One wallet is one user (13-DECISIONS D19). A row exists once the wallet has
-- proved ownership by signing a login challenge.
CREATE TABLE wallets (
  address    solana_address PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_nonces (
  nonce       text PRIMARY KEY CHECK (nonce ~ '^[A-Za-z0-9_-]{43}$'),
  wallet      solana_address NOT NULL,
  -- The exact text the wallet must sign; built by the server, never by the client.
  message     text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX auth_nonces_expires_at_idx ON auth_nonces (expires_at);

CREATE TABLE sessions (
  -- SHA-256 of the session token. The token itself is never stored.
  token_hash sha256_hex PRIMARY KEY,
  wallet     solana_address NOT NULL REFERENCES wallets (address),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_wallet_idx ON sessions (wallet);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE github_oauth_states (
  state_hash  sha256_hex PRIMARY KEY,
  wallet      solana_address NOT NULL REFERENCES wallets (address),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX github_oauth_states_expires_at_idx ON github_oauth_states (expires_at);

-- One GitHub account per wallet and one wallet per GitHub account. The numeric
-- id is the identity; the login is display data and can change on GitHub.
CREATE TABLE github_accounts (
  wallet         solana_address PRIMARY KEY REFERENCES wallets (address),
  github_user_id bigint NOT NULL UNIQUE CHECK (github_user_id > 0),
  login          text NOT NULL CHECK (char_length(login) BETWEEN 1 AND 100),
  linked_at      timestamptz NOT NULL DEFAULT now()
);

-- --- Tasks ------------------------------------------------------------------

CREATE TABLE tasks (
  -- The task UUID; its 16 bytes are the on-chain task_id (13-DECISIONS §5.1).
  id                  uuid PRIMARY KEY,
  client_wallet       solana_address NOT NULL REFERENCES wallets (address),
  -- Task PDA derived from (client_wallet, id). Derived, never client-supplied.
  task_address        solana_address NOT NULL UNIQUE,

  -- Database-owned metadata, bound to the chain by terms_hash. Immutable.
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description         text NOT NULL CHECK (char_length(description) <= 10000),
  repo                text NOT NULL CHECK (repo ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'),
  acceptance_criteria text NOT NULL CHECK (char_length(acceptance_criteria) BETWEEN 1 AND 10000),
  work_duration       bigint NOT NULL CHECK (work_duration > 0),
  amount              token_amount NOT NULL CHECK (amount > 0),
  terms_hash          sha256_hex NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Cache of the on-chain Task account. NULL chain_state means DRAFT: no Task
  -- account had been observed at the last read. The chain always wins.
  chain_state         text CHECK (chain_state IN (
                        'OPEN', 'ACCEPTED', 'SUBMITTED', 'UNDER_REVIEW',
                        'DISPUTED', 'SETTLED', 'REFUNDED', 'CANCELLED')),
  chain_outcome       text,
  chain_developer     solana_address,
  -- Whether the on-chain terms_hash equals the hash of the metadata above.
  chain_terms_match   boolean,
  chain_slot          bigint,
  chain_commitment    text CHECK (chain_commitment IN ('confirmed', 'finalized')),
  chain_synced_at     timestamptz,
  CHECK ((chain_state IS NULL) = (chain_slot IS NULL)),
  CHECK ((chain_state IS NULL) = (chain_commitment IS NULL))
);
CREATE INDEX tasks_client_wallet_idx ON tasks (client_wallet);
CREATE INDEX tasks_chain_developer_idx ON tasks (chain_developer);
CREATE INDEX tasks_chain_state_created_idx ON tasks (chain_state, created_at DESC);

-- A transaction a wallet reported or the API found, keyed by signature so a
-- repeated report can never produce a second record.
CREATE TABLE onchain_transactions (
  signature     tx_signature PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES tasks (id),
  instruction   text NOT NULL,
  -- CONFIRMED  succeeded, not yet final; nothing financial may be derived from it.
  -- FINALIZED  succeeded and final.
  -- FAILED     the transaction executed and failed.
  -- DROPPED    was seen as confirmed, then disappeared (fork or expiry).
  status        text NOT NULL CHECK (status IN ('CONFIRMED', 'FINALIZED', 'FAILED', 'DROPPED')),
  slot          bigint NOT NULL,
  block_time    timestamptz,
  error_code    integer,
  error_name    text,
  reported_by   solana_address REFERENCES wallets (address),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onchain_transactions_task_idx ON onchain_transactions (task_id, first_seen_at);
CREATE INDEX onchain_transactions_pending_idx ON onchain_transactions (task_id)
  WHERE status = 'CONFIRMED';

-- The terminal outcome of a task as observed in a FINALIZED transaction.
-- At most one per task (primary key) and one per transaction (unique).
-- Amounts are the token movements read from that transaction, not computed.
CREATE TABLE settlements (
  task_id          uuid PRIMARY KEY REFERENCES tasks (id),
  signature        tx_signature NOT NULL UNIQUE REFERENCES onchain_transactions (signature),
  state            text NOT NULL CHECK (state IN ('SETTLED', 'REFUNDED', 'CANCELLED')),
  outcome          text NOT NULL,
  client_wallet    solana_address NOT NULL,
  developer_wallet solana_address,
  amount           token_amount NOT NULL,
  fee_amount       token_amount NOT NULL,
  developer_amount token_amount NOT NULL,
  client_amount    token_amount NOT NULL,
  disputed         boolean NOT NULL,
  accepted_at      timestamptz,
  closed_at        timestamptz NOT NULL,
  slot             bigint NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'SETTLED' OR developer_wallet IS NOT NULL),
  CHECK (state = 'SETTLED' OR (fee_amount = 0 AND developer_amount = 0))
);
CREATE INDEX settlements_developer_idx ON settlements (developer_wallet);
CREATE INDEX settlements_client_idx ON settlements (client_wallet);

-- The text behind the rejection_reason_hash on the Task account.
CREATE TABLE rejection_reasons (
  task_id       uuid PRIMARY KEY REFERENCES tasks (id),
  reason_hash   sha256_hex NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 5000),
  author_wallet solana_address NOT NULL REFERENCES wallets (address),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- --- Evidence and verification ----------------------------------------------

-- One row per on-chain submission (task, submission_nonce). pr_number is the
-- developer's claim; the verifier re-derives everything else from GitHub.
CREATE TABLE submissions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id          uuid NOT NULL REFERENCES tasks (id),
  submission_nonce bigint NOT NULL CHECK (submission_nonce > 0),
  evidence_hash    sha256_hex NOT NULL,
  pr_number        bigint NOT NULL CHECK (pr_number > 0),
  submitter_wallet solana_address NOT NULL REFERENCES wallets (address),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, submission_nonce)
);

-- Work queue for the attestation service: one job per submission.
CREATE TABLE verification_jobs (
  submission_id bigint PRIMARY KEY REFERENCES submissions (id),
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'DONE')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_jobs_due_idx ON verification_jobs (run_after) WHERE status <> 'DONE';

-- Append-only audit record of every verification run.
CREATE TABLE verification_results (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id            bigint NOT NULL REFERENCES submissions (id),
  status                   text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  -- [{ "rule": "R4", "passed": true | false | null, "reason": "..." }]; null = not evaluated.
  rules                    jsonb NOT NULL,
  ruleset_version          text NOT NULL,
  verifier_version         text NOT NULL,
  attester_pubkey          solana_address NOT NULL,
  repo                     text NOT NULL,
  pr_number                bigint NOT NULL,
  head_sha                 git_sha,
  merge_commit_sha         git_sha,
  pr_author_id             bigint,
  pr_author_login          text,
  merged_by_id             bigint,
  merged_by_login          text,
  merged_at                timestamptz,
  repo_created_at          timestamptz,
  recomputed_evidence_hash sha256_hex,
  onchain_evidence_hash    sha256_hex,
  onchain_submission_nonce bigint,
  onchain_slot             bigint,
  github_meta              jsonb NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- A VERIFIED result must carry the complete audit record.
  CHECK (status <> 'VERIFIED' OR (
    head_sha IS NOT NULL AND merge_commit_sha IS NOT NULL
    AND pr_author_id IS NOT NULL AND merged_by_id IS NOT NULL AND merged_at IS NOT NULL
    AND repo_created_at IS NOT NULL
    AND recomputed_evidence_hash IS NOT NULL
    AND recomputed_evidence_hash = onchain_evidence_hash
    AND onchain_submission_nonce IS NOT NULL))
);
CREATE INDEX verification_results_submission_idx ON verification_results (submission_id, id DESC);
CREATE UNIQUE INDEX verification_results_one_verified_idx ON verification_results (submission_id)
  WHERE status = 'VERIFIED';

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER verification_results_append_only
  BEFORE UPDATE OR DELETE ON verification_results
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- One record_attestation operation per submission: the primary key makes a
-- second one impossible, and the trigger below ties it to a VERIFIED result.
CREATE TABLE attestations (
  submission_id          bigint PRIMARY KEY REFERENCES submissions (id),
  verification_result_id bigint NOT NULL UNIQUE REFERENCES verification_results (id),
  task_id                uuid NOT NULL REFERENCES tasks (id),
  evidence_hash          sha256_hex NOT NULL,
  submission_nonce       bigint NOT NULL,
  attester_pubkey        solana_address NOT NULL,
  -- REQUESTED  recorded, nothing sent yet.
  -- SENT       a signed transaction was broadcast; `signature` is the latest one.
  -- FINALIZED  the attestation is on the Task account at finalized commitment.
  -- FAILED     it can no longer be recorded (see last_error).
  status                 text NOT NULL DEFAULT 'REQUESTED'
                           CHECK (status IN ('REQUESTED', 'SENT', 'FINALIZED', 'FAILED')),
  signature              tx_signature UNIQUE,
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('SENT', 'FINALIZED') OR signature IS NOT NULL)
);

CREATE FUNCTION attestation_requires_verified_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  result verification_results%ROWTYPE;
  submission submissions%ROWTYPE;
BEGIN
  SELECT * INTO result FROM verification_results WHERE id = NEW.verification_result_id;
  SELECT * INTO submission FROM submissions WHERE id = NEW.submission_id;
  IF result.status IS DISTINCT FROM 'VERIFIED'
     OR result.submission_id IS DISTINCT FROM NEW.submission_id
     OR result.onchain_evidence_hash IS DISTINCT FROM NEW.evidence_hash
     OR result.onchain_submission_nonce IS DISTINCT FROM NEW.submission_nonce
     OR submission.task_id IS DISTINCT FROM NEW.task_id
     OR submission.evidence_hash IS DISTINCT FROM NEW.evidence_hash
     OR submission.submission_nonce IS DISTINCT FROM NEW.submission_nonce THEN
    RAISE EXCEPTION 'an attestation requires a VERIFIED result for exactly this submission'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER attestations_require_verified_result
  BEFORE INSERT ON attestations
  FOR EACH ROW EXECUTE FUNCTION attestation_requires_verified_result();

CREATE FUNCTION attestation_identity_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.submission_id, NEW.verification_result_id, NEW.task_id, NEW.evidence_hash,
      NEW.submission_nonce, NEW.attester_pubkey)
     IS DISTINCT FROM
     (OLD.submission_id, OLD.verification_result_id, OLD.task_id, OLD.evidence_hash,
      OLD.submission_nonce, OLD.attester_pubkey) THEN
    RAISE EXCEPTION 'an attestation cannot be re-pointed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('FINALIZED', 'FAILED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'attestation status % is final', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER attestations_identity_is_immutable
  BEFORE UPDATE ON attestations
  FOR EACH ROW EXECUTE FUNCTION attestation_identity_is_immutable();

-- --- Reputation (off-chain aggregates) --------------------------------------
-- Plain views over finalized settlements, so they can never drift from them.

CREATE VIEW developer_reputation AS
SELECT
  developer_wallet AS wallet,
  count(*) FILTER (WHERE state = 'SETTLED')                       AS tasks_settled,
  count(*) FILTER (WHERE state = 'REFUNDED')                      AS tasks_refunded,
  count(*) FILTER (WHERE disputed)                                AS tasks_disputed,
  count(DISTINCT client_wallet) FILTER (WHERE state = 'SETTLED')  AS distinct_clients,
  coalesce(sum(developer_amount) FILTER (WHERE state = 'SETTLED'), 0)::numeric(30, 0)
                                                                  AS total_earned
FROM settlements
WHERE developer_wallet IS NOT NULL
GROUP BY developer_wallet;

CREATE VIEW client_reputation AS
SELECT
  client_wallet AS wallet,
  count(*) FILTER (WHERE state = 'SETTLED')                          AS tasks_settled,
  count(*) FILTER (WHERE state = 'REFUNDED')                         AS tasks_refunded,
  count(*) FILTER (WHERE state = 'CANCELLED')                        AS tasks_cancelled,
  count(*) FILTER (WHERE disputed)                                   AS tasks_disputed,
  count(DISTINCT developer_wallet) FILTER (WHERE state = 'SETTLED')  AS distinct_developers,
  coalesce(sum(amount) FILTER (WHERE state = 'SETTLED'), 0)::numeric(30, 0)
                                                                     AS total_paid
FROM settlements
GROUP BY client_wallet;

-- --- Privileges -------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Request-handling code: metadata, sessions, observations. It can read
-- verification results and attestations but can never write either.
GRANT SELECT, INSERT ON wallets TO taskra_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_nonces, sessions, github_oauth_states TO taskra_api;
GRANT SELECT, INSERT, UPDATE ON github_accounts TO taskra_api;
GRANT SELECT, INSERT ON tasks TO taskra_api;
GRANT UPDATE (chain_state, chain_outcome, chain_developer, chain_terms_match, chain_slot,
              chain_commitment, chain_synced_at) ON tasks TO taskra_api;
GRANT SELECT, INSERT, UPDATE ON onchain_transactions TO taskra_api;
GRANT SELECT, INSERT ON settlements, rejection_reasons, submissions TO taskra_api;
GRANT SELECT, INSERT, UPDATE ON verification_jobs TO taskra_api;
GRANT SELECT ON verification_results, attestations TO taskra_api;
GRANT SELECT ON developer_reputation, client_reputation TO taskra_api;

-- Attestation service: reads what it verifies, writes only its own records.
GRANT SELECT ON tasks, submissions, github_accounts TO taskra_attester;
GRANT SELECT, UPDATE ON verification_jobs TO taskra_attester;
GRANT SELECT, INSERT ON verification_results TO taskra_attester;
GRANT SELECT, INSERT, UPDATE ON attestations TO taskra_attester;

-- Down Migration

DROP VIEW client_reputation;
DROP VIEW developer_reputation;
DROP TABLE attestations;
DROP FUNCTION attestation_identity_is_immutable();
DROP FUNCTION attestation_requires_verified_result();
DROP TABLE verification_results;
DROP FUNCTION forbid_change();
DROP TABLE verification_jobs;
DROP TABLE submissions;
DROP TABLE rejection_reasons;
DROP TABLE settlements;
DROP TABLE onchain_transactions;
DROP TABLE tasks;
DROP TABLE github_accounts;
DROP TABLE github_oauth_states;
DROP TABLE sessions;
DROP TABLE auth_nonces;
DROP TABLE wallets;
DROP DOMAIN tx_signature;
DROP DOMAIN token_amount;
DROP DOMAIN git_sha;
DROP DOMAIN sha256_hex;
DROP DOMAIN solana_address;
