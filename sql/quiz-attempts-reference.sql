-- Ace: quiz_attempts — reference schema (match your live Supabase table)
-- RLS: auth.uid() = user_id (see ace-rls-reference.sql)

-- ---------------------------------------------------------------------------
-- Layout A (compact — used by some Ace Supabase projects)
-- ---------------------------------------------------------------------------
--   id uuid primary key default gen_random_uuid()
--   user_id uuid not null references auth.users(id) on delete cascade
--   material_id uuid null references generated_materials(id) on delete set null
--   score integer not null default 0
--   total_questions integer not null default 0
--   answers jsonb not null default '{}'::jsonb
--   completed_at timestamptz not null default now()

-- ---------------------------------------------------------------------------
-- Layout B (extended — ace-db.js primary insert)
-- ---------------------------------------------------------------------------
--   generated_material_id uuid null references generated_materials(id)
--   study_set_id uuid null references study_sets(id)
--   score, max_score, accuracy, duration_seconds
--   settings jsonb, answers jsonb, review jsonb
--   created_at, updated_at

-- ace-db.js insertQuizAttempt tries Layout A (compact) first, then Layout B.
-- fetchQuizAttempts normalizes rows for the UI.
--
-- If inserts fail with 42501, run sql/quiz-attempts-rls.sql.
