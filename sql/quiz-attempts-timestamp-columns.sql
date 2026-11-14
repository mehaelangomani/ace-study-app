-- Ace: quiz_attempts timestamp columns (optional — run in Supabase SQL Editor)
--
-- Your deployed table likely matches Layout A (compact):
--   material_id, score, total_questions, answers, completed_at
--
-- The Ace app orders attempts by completed_at when present. You do NOT need
-- this migration for the app to work after the ace-db.js fix.
--
-- Run this only if you want an explicit created_at column (reports, BI, or
-- Layout B extended schema). Safe and idempotent.

-- ---------------------------------------------------------------------------
-- Step 1 — Inspect current columns (read-only)
-- ---------------------------------------------------------------------------
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'quiz_attempts'
ORDER BY ordinal_position;

-- ---------------------------------------------------------------------------
-- Step 2 — Optional add created_at (does not remove completed_at)
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.quiz_attempts
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE public.quiz_attempts
SET created_at = COALESCE(created_at, completed_at, now())
WHERE created_at IS NULL;

ALTER TABLE public.quiz_attempts
  ALTER COLUMN created_at SET DEFAULT now();

COMMIT;

-- ---------------------------------------------------------------------------
-- Step 3 — Verify (read-only)
-- ---------------------------------------------------------------------------
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'quiz_attempts'
  AND column_name IN ('completed_at', 'created_at')
ORDER BY column_name;