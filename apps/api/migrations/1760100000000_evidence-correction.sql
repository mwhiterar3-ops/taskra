-- Up Migration

-- Security remediation 1 (docs/15-SECURITY-AUDIT.md, L-02).
--
-- A registration that names the wrong pull request can never verify: the
-- on-chain evidence hash commits to the repository, the pull-request number
-- and the head commit. Until now it could not be corrected either, so a
-- mistake (or a hijacked session) left the developer unverifiable once the work
-- deadline had passed. The pull-request number may now be corrected, and only
-- that, and only while nothing has been verified for the submission.

CREATE FUNCTION submission_correction_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.task_id, NEW.submission_nonce, NEW.evidence_hash, NEW.submitter_wallet,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.task_id, OLD.submission_nonce, OLD.evidence_hash, OLD.submitter_wallet,
      OLD.created_at) THEN
    RAISE EXCEPTION 'only the pull-request number of a submission can be corrected'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.pr_number IS DISTINCT FROM OLD.pr_number AND (
       EXISTS (SELECT 1 FROM attestations a WHERE a.submission_id = OLD.id)
       OR EXISTS (SELECT 1 FROM verification_results r
                   WHERE r.submission_id = OLD.id AND r.status = 'VERIFIED')) THEN
    RAISE EXCEPTION 'a verified submission cannot be pointed at another pull request'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER submissions_correction_rules
  BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION submission_correction_rules();

-- Every verification run already records the pull-request number it examined
-- (verification_results.pr_number, append-only), so a correction leaves the
-- history of what was checked intact.
GRANT UPDATE (pr_number) ON submissions TO taskra_api;

-- Down Migration

REVOKE UPDATE (pr_number) ON submissions FROM taskra_api;
DROP TRIGGER submissions_correction_rules ON submissions;
DROP FUNCTION submission_correction_rules();
