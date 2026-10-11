-- Up Migration

-- Security remediation 4 (docs/15-SECURITY-AUDIT.md, R-1).
--
-- A task can be settled without ever being verified: the client may approve a
-- submission that was never attested, and the authority may resolve a dispute
-- for the developer. Every settled task was nevertheless listed as "verified
-- work", so a verified-work record could be produced with no evidence at all.
--
-- A settlement now records whether the task's final submission carried a valid
-- attestation, read from the finalized Task account, and only those count as
-- verified. Rows written before this migration are not known to have been
-- attested and are recorded as not attested.

ALTER TABLE settlements ADD COLUMN attested boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW developer_reputation AS
SELECT
  developer_wallet AS wallet,
  count(*) FILTER (WHERE state = 'SETTLED')                       AS tasks_settled,
  count(*) FILTER (WHERE state = 'REFUNDED')                      AS tasks_refunded,
  count(*) FILTER (WHERE disputed)                                AS tasks_disputed,
  count(DISTINCT client_wallet) FILTER (WHERE state = 'SETTLED')  AS distinct_clients,
  coalesce(sum(developer_amount) FILTER (WHERE state = 'SETTLED'), 0)::numeric(30, 0)
                                                                  AS total_earned,
  count(*) FILTER (WHERE state = 'SETTLED' AND attested)          AS tasks_verified
FROM settlements
WHERE developer_wallet IS NOT NULL
GROUP BY developer_wallet;

-- Down Migration

DROP VIEW developer_reputation;
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
GRANT SELECT ON developer_reputation TO taskra_api;
ALTER TABLE settlements DROP COLUMN attested;
