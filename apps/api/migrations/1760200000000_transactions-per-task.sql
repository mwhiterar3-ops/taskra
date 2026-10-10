-- Up Migration

-- Security remediation 2 (docs/15-SECURITY-AUDIT.md, N-1).
--
-- A Solana transaction can carry Taskra instructions for several tasks, and
-- whoever sends it decides that. Keyed by signature alone, a transaction could
-- be recorded for one task only, and at most one settlement could name it, so
-- the second task settled by the same transaction could never be recorded.
-- A transaction is now recorded once per task it concerns, and a settlement
-- names the record of its own task.

ALTER TABLE settlements DROP CONSTRAINT settlements_signature_fkey;
ALTER TABLE settlements DROP CONSTRAINT settlements_signature_key;
ALTER TABLE onchain_transactions DROP CONSTRAINT onchain_transactions_pkey;
ALTER TABLE onchain_transactions ADD PRIMARY KEY (signature, task_id);
ALTER TABLE settlements
  ADD CONSTRAINT settlements_transaction_fkey
  FOREIGN KEY (signature, task_id) REFERENCES onchain_transactions (signature, task_id);

-- Down Migration

ALTER TABLE settlements DROP CONSTRAINT settlements_transaction_fkey;
ALTER TABLE onchain_transactions DROP CONSTRAINT onchain_transactions_pkey;
ALTER TABLE onchain_transactions ADD PRIMARY KEY (signature);
ALTER TABLE settlements ADD CONSTRAINT settlements_signature_key UNIQUE (signature);
ALTER TABLE settlements
  ADD CONSTRAINT settlements_signature_fkey
  FOREIGN KEY (signature) REFERENCES onchain_transactions (signature);
