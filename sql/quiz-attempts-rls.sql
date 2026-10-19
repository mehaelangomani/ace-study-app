-- Ace: quiz_attempts RLS policies (run in Supabase SQL Editor)
-- Symptom: insert fails with code 42501 / "row-level security" in the app.
-- Does not weaken security: authenticated users may only access their own rows.

ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quiz_attempts_select_own ON public.quiz_attempts;
DROP POLICY IF EXISTS quiz_attempts_insert_own ON public.quiz_attempts;
DROP POLICY IF EXISTS quiz_attempts_update_own ON public.quiz_attempts;
DROP POLICY IF EXISTS quiz_attempts_delete_own ON public.quiz_attempts;

CREATE POLICY quiz_attempts_select_own
  ON public.quiz_attempts
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY quiz_attempts_insert_own
  ON public.quiz_attempts
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY quiz_attempts_update_own
  ON public.quiz_attempts
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY quiz_attempts_delete_own
  ON public.quiz_attempts
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quiz_attempts TO authenticated;
