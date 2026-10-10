-- Up Migration

-- Security remediation 3 (docs/15-SECURITY-AUDIT.md, N-3).
--
-- A settlement record divides the task's own amount and nothing else: fee plus
-- developer share for a SETTLED task, the whole amount back to the client
-- otherwise. The reconciler computes it that way; this makes any other
-- division impossible to store, so a future defect of the N-3 kind (a swept
-- deposit counted as earnings) fails at the insert and is not recorded.
--
-- It does not make a record true. Whoever holds the API's database role can
-- still insert a settlement that adds up for a task that was never settled
-- (L-09).

ALTER TABLE settlements
  ADD CONSTRAINT settlements_amounts_add_up CHECK (
    (state = 'SETTLED' AND client_amount = 0 AND fee_amount + developer_amount = amount)
    OR (state <> 'SETTLED' AND client_amount = amount)
  );

-- Down Migration

ALTER TABLE settlements DROP CONSTRAINT settlements_amounts_add_up;
