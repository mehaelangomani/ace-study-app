-- Ace: generated_materials.material_type CHECK constraint
-- Run in Supabase SQL Editor.
--
-- Application source of truth: ace-db.js → MATERIAL_TYPES
--   cheatsheet    → "cheatsheet"
--   quiz          → "quiz"
--   flashcard     → "flashcard"   (singular — used by ace-flashcards.js saveFlashcardDeck)
--   formula_sheet → "formula_sheet"
--
-- Aliases normalized in app code only (not stored): flashcards → flashcard,
-- formula / formulas → formula_sheet
--
-- If your live CHECK currently allows only cheatsheet and quiz, Step 2 adds
-- flashcard and formula_sheet without deleting rows or changing RLS.

-- ---------------------------------------------------------------------------
-- Step 1 — Inspect (read-only; run first)
-- ---------------------------------------------------------------------------
SELECT
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE n.nspname = 'public'
  AND t.relname = 'generated_materials'
  AND c.conname = 'generated_materials_material_type_check';

SELECT DISTINCT material_type
FROM public.generated_materials
ORDER BY 1;

-- Rows that would block Step 2 (must be empty or fixed before ALTER)
SELECT id, material_type, title
FROM public.generated_materials
WHERE material_type NOT IN (
  'cheatsheet',
  'quiz',
  'flashcard',
  'formula_sheet',
  'formula',
  'formulas',
  'flashcards'
)
ORDER BY material_type, id;

-- ---------------------------------------------------------------------------
-- Step 2 — Apply (non-destructive data fixes + expanded CHECK)
--
-- Executes, in order:
--   1) UPDATE legacy alias rows (only rows that match; 0 rows updated is OK)
--   2) DROP CONSTRAINT IF EXISTS generated_materials_material_type_check
--   3) ADD CONSTRAINT allowing cheatsheet, quiz, flashcard, formula_sheet
-- ---------------------------------------------------------------------------

BEGIN;

UPDATE public.generated_materials
SET material_type = 'formula_sheet'
WHERE material_type IN ('formula', 'formulas');

UPDATE public.generated_materials
SET material_type = 'flashcard'
WHERE material_type = 'flashcards';

ALTER TABLE public.generated_materials
  DROP CONSTRAINT IF EXISTS generated_materials_material_type_check;

ALTER TABLE public.generated_materials
  ADD CONSTRAINT generated_materials_material_type_check
  CHECK (
    material_type IN (
      'cheatsheet',
      'quiz',
      'flashcard',
      'formula_sheet'
    )
  );

COMMIT;

-- ---------------------------------------------------------------------------
-- Step 3 — Verify (read-only)
-- ---------------------------------------------------------------------------
SELECT
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE n.nspname = 'public'
  AND t.relname = 'generated_materials'
  AND c.conname = 'generated_materials_material_type_check';
