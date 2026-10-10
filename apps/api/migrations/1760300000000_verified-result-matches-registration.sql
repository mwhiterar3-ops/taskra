-- Up Migration

-- Security remediation 2 (docs/15-SECURITY-AUDIT.md, N-2).
--
-- The pull-request number of a submission can be corrected until it is
-- verified (migration 1760100000000). The attestation service reads the
-- number, spends some time asking GitHub, and then records its result. A
-- correction that landed in between left a VERIFIED result, and an
-- attestation, for a number that was no longer the registered one.
--
-- A VERIFIED result may now only be inserted for the number that is
-- registered at that moment. Inserting it rewrites the submission row (to the
-- same values), which locks the row until the inserting transaction ends and
-- leaves a new row version behind:
--
--   correction first  -> this insert waits, then finds the new number, matches
--                        no row and is refused; nothing is recorded and the
--                        job is retried.
--   VERIFIED first    -> the correction waits, then finds the VERIFIED result
--                        and is refused by submission_correction_rules().
--
-- A row lock alone (SELECT ... FOR SHARE) is not enough for the second case.
-- A lock leaves no trace once released, and a correction made in a REPEATABLE
-- READ transaction that began before the VERIFIED result was committed does
-- not see that result either, so it went through. Against a rewritten row the
-- same correction fails with a serialization error instead.
--
-- SECURITY DEFINER because the attestation role has no UPDATE privilege on
-- submissions. The function takes no input beyond the row being inserted and
-- changes no value.

CREATE FUNCTION verified_result_matches_registration() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE submissions s SET pr_number = s.pr_number
   WHERE s.id = NEW.submission_id AND s.pr_number = NEW.pr_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the registered pull request changed while it was being verified'
      USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER verification_results_match_registration
  BEFORE INSERT ON verification_results
  FOR EACH ROW WHEN (NEW.status = 'VERIFIED')
  EXECUTE FUNCTION verified_result_matches_registration();

-- Down Migration

DROP TRIGGER verification_results_match_registration ON verification_results;
DROP FUNCTION verified_result_matches_registration();
