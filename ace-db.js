/**
 * Ace — Supabase data layer (uses window.aceSupabase only)
 *
 * study_sets: id, user_id, title, subject, source_text, difficulty,
 *             extracted_content (jsonb), created_at, updated_at
 *
 * generated_materials: id, user_id, study_set_id, title, material_type,
 *                      content, created_at, updated_at
 */

(function (global) {
  "use strict";

  var ACE_STUDY_SETS_KEY = "aceStudySets";
  var ACE_LOCAL_MATERIALS_KEY = "aceLocalMaterials";
  var ACE_MIGRATED_PREFIX = "aceStudySetsMigrated_";

  var STUDY_SET_COLUMNS =
    "id, user_id, title, subject, source_text, difficulty, " +
    "extracted_content, created_at, updated_at";

  var GENERATED_MATERIAL_COLUMNS =
    "id, user_id, study_set_id, title, material_type, content, " +
    "created_at, updated_at";

  /**
   * Canonical material_type values stored in generated_materials.
   * Must match sql/generated-materials-material-type-constraint.sql
   */
  var MATERIAL_TYPES = {
    cheatsheet: "cheatsheet",
    quiz: "quiz",
    flashcard: "flashcard",
    formula_sheet: "formula_sheet"
  };

  var MATERIAL_TYPE_DB_ALIASES = {
    formula: MATERIAL_TYPES.formula_sheet,
    formulas: MATERIAL_TYPES.formula_sheet,
    flashcards: MATERIAL_TYPES.flashcard
  };

  var studySetsCache = null;
  var materialsCache = null;

  function client() {
    return global.aceSupabase || null;
  }

  function formatDbError(error) {

    if (!error) {
      return { message: "Unknown database error.", code: null, raw: null };
    }

    if (typeof error === "string") {
      return { message: error, code: null, raw: error };
    }

    var message =
      error.message ||
      error.details ||
      error.hint ||
      "Database request failed.";

    return {
      message: error.code ? "[" + error.code + "] " + message : message,
      code: error.code || null,
      raw: error
    };

  }

  function readLocalStudySets() {

    try {

      var raw = global.localStorage.getItem(ACE_STUDY_SETS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];

    } catch (error) {

      return [];

    }

  }

  function conceptsFromExtractedContent(content) {

    if (!content) {
      return [];
    }

    if (Array.isArray(content)) {
      return content;
    }

    if (Array.isArray(content.concepts) && content.concepts.length) {
      return content.concepts;
    }

    var derived = [];
    var seen = {};

    function pushUnique(value) {

      if (!value || typeof value !== "string") {
        return;
      }

      var trimmed = value.trim();

      if (trimmed.length < 2) {
        return;
      }

      var key = trimmed.toLowerCase();

      if (seen[key]) {
        return;
      }

      seen[key] = true;
      derived.push(trimmed);

    }

    (content.key_concepts || []).forEach(function (item) {
      if (item && item.title) {
        pushUnique(item.title);
      }
    });

    (content.definitions || []).forEach(function (item) {
      if (item && item.term) {
        pushUnique(item.term);
      }
    });

    (content.formulas || []).forEach(function (item) {
      if (item && item.formula) {
        pushUnique(item.formula);
      }
    });

    (content.key_takeaways || []).forEach(pushUnique);

    return derived;

  }

  function buildExtractedContent(set) {

    var payload = { version: 2 };

    if (
      set &&
      set.extractedContent &&
      typeof set.extractedContent === "object" &&
      !Array.isArray(set.extractedContent)
    ) {
      payload = Object.assign(payload, set.extractedContent);
    }

    if (Array.isArray(set.keyConcepts)) {
      payload.key_concepts = set.keyConcepts;
    }

    if (Array.isArray(set.definitions)) {
      payload.definitions = set.definitions;
    }

    if (Array.isArray(set.formulas)) {
      payload.formulas = set.formulas;
    }

    if (Array.isArray(set.keyTakeaways)) {
      payload.key_takeaways = set.keyTakeaways;
    }

    payload.key_concepts = payload.key_concepts || [];
    payload.definitions = payload.definitions || [];
    payload.formulas = payload.formulas || [];
    payload.key_takeaways = payload.key_takeaways || [];

    payload.concepts = Array.isArray(set.concepts) && set.concepts.length
      ? set.concepts.slice()
      : conceptsFromExtractedContent(payload);

    return payload;

  }

  function canonicalMaterialType(value) {

    if (!value || typeof value !== "string") {
      return value;
    }

    var trimmed = value.trim();

    if (MATERIAL_TYPE_DB_ALIASES[trimmed]) {
      return MATERIAL_TYPE_DB_ALIASES[trimmed];
    }

    return trimmed;

  }

  function materialTypeAllowedInDatabase(value) {

    var canonical = canonicalMaterialType(value);

    return (
      canonical === MATERIAL_TYPES.cheatsheet ||
      canonical === MATERIAL_TYPES.quiz ||
      canonical === MATERIAL_TYPES.flashcard ||
      canonical === MATERIAL_TYPES.formula_sheet
    );

  }

  function normalizeMaterialRow(row) {

    if (!row) {
      return row;
    }

    if (!row.material_type && row.type) {
      row.material_type = row.type;
    }

    if (row.material_type) {
      row.material_type = canonicalMaterialType(row.material_type);
    }

    if (!row.content && (row.payload || row.data)) {
      row.content = row.payload || row.data;
    }

    return row;

  }

  function rowToStudySet(row) {

    var content = row.extracted_content;
    var concepts = conceptsFromExtractedContent(content);

    var sourceText = "";

    if (row.source_text != null && row.source_text !== "") {
      sourceText = row.source_text;
    } else if (content && typeof content === "object" && content.sourceText) {
      sourceText = content.sourceText;
    }

    return {
      id: row.id,
      title: row.title || "Untitled study set",
      subject: row.subject || null,
      difficulty: row.difficulty || null,
      concepts: concepts,
      sourceText: sourceText,
      extractedContent:
        content && typeof content === "object" && !Array.isArray(content)
          ? content
          : { concepts: concepts },
      keyConcepts: Array.isArray(content.key_concepts)
        ? content.key_concepts
        : [],
      definitions: Array.isArray(content.definitions)
        ? content.definitions
        : [],
      formulas: Array.isArray(content.formulas) ? content.formulas : [],
      keyTakeaways: Array.isArray(content.key_takeaways)
        ? content.key_takeaways
        : [],
      createdAt: row.created_at || new Date().toISOString(),
      updatedAt: row.updated_at || row.created_at || null,
      remote: true
    };

  }

  function studySetToRow(userId, set) {

    var sourceText = set.sourceText != null ? String(set.sourceText) : "";

    return {
      id:
        set.id && String(set.id).indexOf("set_") !== 0
          ? set.id
          : undefined,
      user_id: userId,
      title: set.title || "Untitled study set",
      subject: set.subject || null,
      source_text: sourceText,
      difficulty: set.difficulty || null,
      extracted_content: buildExtractedContent(set),
      updated_at: new Date().toISOString()
    };

  }

  function buildMaterialsFromStudySet(userId, studySetId, studySet) {

    var baseTitle = (studySet && studySet.title) || "Study set";
    var content =
      (studySet && studySet.extractedContent) ||
      buildExtractedContent(studySet || {});
    var now = new Date().toISOString();
    var takeaways = content.key_takeaways || [];
    var definitions = content.definitions || [];
    var formulas = content.formulas || [];
    var keyConcepts = content.key_concepts || [];
    var flatConcepts = content.concepts || conceptsFromExtractedContent(content);

    var quizQuestions = definitions.map(function (def, index) {
      return {
        id: "d" + index,
        prompt: "Define: " + def.term,
        answer: def.definition
      };
    });

    if (!quizQuestions.length) {
      quizQuestions = keyConcepts.map(function (concept, index) {
        return {
          id: "k" + index,
          prompt: "Explain: " + concept.title,
          answer: concept.explanation
        };
      });
    }

    var flashcards = definitions.map(function (def, index) {
      return {
        id: "f" + index,
        front: def.term,
        back: def.definition
      };
    });

    if (!flashcards.length) {
      flashcards = keyConcepts.map(function (concept, index) {
        return {
          id: "f" + index,
          front: concept.title,
          back: concept.explanation
        };
      });
    }

    return [
      {
        user_id: userId,
        study_set_id: studySetId,
        material_type: MATERIAL_TYPES.quiz,
        title: baseTitle + " — Quiz",
        content: {
          questions: quizQuestions
        },
        created_at: now,
        updated_at: now
      },
      {
        user_id: userId,
        study_set_id: studySetId,
        material_type: MATERIAL_TYPES.flashcard,
        title: baseTitle + " — Flashcards",
        content: {
          cards: flashcards
        },
        created_at: now,
        updated_at: now
      },
      {
        user_id: userId,
        study_set_id: studySetId,
        material_type: MATERIAL_TYPES.formula_sheet,
        title: baseTitle + " — Formulas",
        content: {
          items: formulas
        },
        created_at: now,
        updated_at: now
      }
    ];

  }

  function formatUserFacingMaterialsSyncError(error) {

    var formatted = formatDbError(error);
    var message = formatted.message || "";
    var lowered = message.toLowerCase();

    if (
      formatted.code === "23514" ||
      lowered.indexOf("check constraint") >= 0 ||
      lowered.indexOf("material_type") >= 0
    ) {
      return (
        "Study set saved! Some materials could not be synced. " +
        "Run sql/generated-materials-material-type-constraint.sql in Supabase."
      );
    }

    return "Study set saved! Some materials could not be synced.";

  }

  function formatUserFacingSaveError(error, contextLabel) {

    var label = contextLabel || "Item";
    var formatted = formatDbError(error);
    var lowered = (formatted.message || "").toLowerCase();

    if (formatted.code === "23514" || lowered.indexOf("material_type") >= 0) {
      return (
        label +
        " could not be saved. Material type is not allowed in the database. " +
        "Apply sql/generated-materials-material-type-constraint.sql in Supabase."
      );
    }

    if (formatted.code === "23503" || lowered.indexOf("foreign key") >= 0) {
      return (
        label +
        " could not be saved. Link the study set to your library first, then try again."
      );
    }

    if (formatted.code === "42501" || lowered.indexOf("row-level security") >= 0) {
      return (
        label +
        " could not be saved. Database permissions blocked the write. " +
        "Apply sql/quiz-attempts-rls.sql in Supabase (RLS insert policy)."
      );
    }

    return label + " could not be saved. Please try again.";

  }

  function formatUserFacingQuizAttemptSaveError(error, sessionMissing) {

    if (sessionMissing) {
      return "Your session expired. Sign in again, then use Retry saving attempt.";
    }

    var formatted = formatDbError(error);
    var lowered = (formatted.message || "").toLowerCase();
    var code = formatted.code || "";

    if (code === "PGRST301" || lowered.indexOf("jwt") >= 0) {
      return "Your session expired. Sign in again, then use Retry saving attempt.";
    }

    if (code === "42501" || lowered.indexOf("row-level security") >= 0) {
      return (
        "Quiz attempt could not be saved. Database permissions blocked the insert. " +
        "Run sql/quiz-attempts-rls.sql in the Supabase SQL Editor."
      );
    }

    if (code === "23503" || lowered.indexOf("foreign key") >= 0) {
      return (
        "Quiz attempt could not be saved. The linked quiz record was not found. " +
        "Save the quiz to your library, then retry."
      );
    }

    if (code === "23502" || lowered.indexOf("not-null") >= 0) {
      return (
        "Quiz attempt could not be saved. A required field is missing " +
        "(often material_id). Save the quiz first, then retry."
      );
    }

    if (
      code === "PGRST204" ||
      (lowered.indexOf("column") >= 0 && lowered.indexOf("does not exist") >= 0)
    ) {
      return (
        "Quiz attempt could not be saved. The quiz_attempts table schema does not " +
        "match the app. See sql/quiz-attempts-reference.sql."
      );
    }

    if (code === "22P02" || lowered.indexOf("invalid input syntax for type uuid") >= 0) {
      return (
        "Quiz attempt could not be saved. The quiz link ID was invalid. " +
        "Retry after saving the quiz to your library."
      );
    }

    return (
      "Your result is ready, but saving the attempt failed. Retry saving."
    );

  }

  function isUuid(value) {

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || "")
    );

  }

  function sanitizeQuizMaterialId(materialId) {

    return isUuid(materialId) ? materialId : null;

  }

  async function getSupabaseSessionUserId() {

    var supabase = client();

    if (!supabase || !supabase.auth || typeof supabase.auth.getSession !== "function") {
      return null;
    }

    var result = await supabase.auth.getSession();

    if (result.error || !result.data || !result.data.session) {
      return null;
    }

    return result.data.session.user?.id || null;

  }

  function quizAttemptAnswersContainSubmissionId(answers, submissionId) {

    if (!submissionId || !answers || typeof answers !== "object") {
      return false;
    }

    return answers._ace_submission_id === submissionId;

  }

  async function findQuizAttemptBySubmissionId(userId, submissionId) {

    if (!userId || !submissionId) {
      return null;
    }

    var listed = await fetchQuizAttempts(userId);
    var rows = listed.data || [];

    for (var i = 0; i < rows.length; i++) {
      if (quizAttemptAnswersContainSubmissionId(rows[i].answers, submissionId)) {
        return rows[i];
      }
    }

    return null;

  }

  function isPostgrestMissingColumnError(error) {

    if (!error) {
      return false;
    }

    var formatted = formatDbError(error);
    var lowered = (formatted.message || "").toLowerCase();

    return (
      formatted.code === "PGRST204" ||
      (lowered.indexOf("column") >= 0 && lowered.indexOf("does not exist") >= 0) ||
      lowered.indexOf("could not find") >= 0
    );

  }

  function normalizeQuizAttemptRow(row) {

    if (!row) {
      return row;
    }

    var payload = row.payload && typeof row.payload === "object" ? row.payload : {};

    return {
      id: row.id,
      user_id: row.user_id,
      generated_material_id:
        row.generated_material_id ||
        row.material_id ||
        payload.generated_material_id ||
        null,
      study_set_id: row.study_set_id || payload.study_set_id || null,
      score: row.score != null ? row.score : payload.score,
      max_score:
        row.max_score != null
          ? row.max_score
          : row.total_questions != null
            ? row.total_questions
            : payload.max_score,
      accuracy:
        row.accuracy != null
          ? row.accuracy
          : payload.accuracy != null
            ? payload.accuracy
            : null,
      duration_seconds: row.duration_seconds || payload.duration_seconds || null,
      settings: row.settings || payload.settings || {},
      answers: row.answers || payload.answers || {},
      review: row.review || payload.review || {},
      created_at: row.created_at || row.completed_at || null
    };

  }

  async function findFlashcardDeckByFingerprint(userId, fingerprint) {

    if (!userId || !fingerprint) {
      return null;
    }

    var cached = (materialsCache || readLocalMaterials()).find(function (row) {
      return (
        canonicalMaterialType(row.material_type) === MATERIAL_TYPES.flashcard &&
        row.content &&
        row.content.deck_fingerprint === fingerprint
      );
    });

    if (cached) {
      return normalizeMaterialRow(cached);
    }

    var supabase = client();

    if (!supabase) {
      return null;
    }

    var result = await supabase
      .from("generated_materials")
      .select(GENERATED_MATERIAL_COLUMNS)
      .eq("user_id", userId)
      .eq("material_type", MATERIAL_TYPES.flashcard)
      .eq("content->>deck_fingerprint", fingerprint)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (result.error || !result.data) {
      return null;
    }

    var normalized = normalizeMaterialRow(result.data);
    upsertMaterialInCache(normalized);
    return normalized;

  }

  async function fetchStudySets(userId) {

    var supabase = client();

    if (!supabase || !userId) {
      return { data: readLocalStudySets(), error: null, source: "local" };
    }

    var result = await supabase
      .from("study_sets")
      .select(STUDY_SET_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (result.error) {
      return {
        data: null,
        error: formatDbError(result.error),
        source: "remote"
      };
    }

    return {
      data: (result.data || []).map(rowToStudySet),
      error: null,
      source: "remote"
    };

  }

  async function findRemoteStudySetByTitle(userId, title) {

    var supabase = client();
    var normalizedTitle = (title || "Untitled study set").trim();

    if (!supabase || !userId || !normalizedTitle) {
      return { data: null, error: null };
    }

    var result = await supabase
      .from("study_sets")
      .select(STUDY_SET_COLUMNS)
      .eq("user_id", userId)
      .eq("title", normalizedTitle)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (result.error) {
      return { data: null, error: formatDbError(result.error) };
    }

    if (!result.data) {
      return { data: null, error: null };
    }

    return { data: rowToStudySet(result.data), error: null };

  }

  async function insertStudySet(userId, set) {

    var supabase = client();

    if (!supabase || !userId) {
      return {
        data: null,
        error: formatDbError({ message: "Not signed in." })
      };
    }

    var existingResult = await findRemoteStudySetByTitle(userId, set.title);

    if (existingResult.error) {
      return { data: null, error: existingResult.error };
    }

    var saved = existingResult.data;
    var alreadyExists = Boolean(saved);

    if (!saved) {

      var row = studySetToRow(userId, set);

      var result = await supabase
        .from("study_sets")
        .insert(row)
        .select(STUDY_SET_COLUMNS)
        .single();

      if (result.error) {
        return { data: null, error: formatDbError(result.error) };
      }

      saved = rowToStudySet(result.data);

    }

    var materialsResult = await insertGeneratedMaterialsForStudySet(
      userId,
      saved.id,
      set
    );

    if (materialsResult.error) {
      return {
        data: saved,
        error: null,
        partial: true,
        alreadyExists: alreadyExists,
        materialsError: materialsResult.error,
        userMessage: formatUserFacingMaterialsSyncError(materialsResult.error)
      };
    }

    await refreshMaterialsCache(userId);

    return {
      data: saved,
      error: null,
      alreadyExists: alreadyExists,
      materials: materialsResult.data || [],
      materialsSkipped: Boolean(materialsResult.skipped)
    };

  }

  async function deleteStudySet(userId, setId) {

    var supabase = client();

    if (!supabase || !userId) {
      return { error: formatDbError({ message: "Not signed in." }) };
    }

    if (!setId) {
      return { error: formatDbError({ message: "Missing study set id." }) };
    }

    var materialsDelete = await supabase
      .from("generated_materials")
      .delete()
      .eq("study_set_id", setId)
      .eq("user_id", userId);

    if (materialsDelete.error) {
      return { error: formatDbError(materialsDelete.error) };
    }

    var setDelete = await supabase
      .from("study_sets")
      .delete()
      .eq("id", setId)
      .eq("user_id", userId);

    if (setDelete.error) {
      return { error: formatDbError(setDelete.error) };
    }

    return { error: null };

  }

  async function countGeneratedMaterialsForStudySet(userId, studySetId) {

    var supabase = client();

    if (!supabase || !userId || !studySetId) {
      return { count: 0, error: formatDbError({ message: "Cannot read materials." }) };
    }

    var result = await supabase
      .from("generated_materials")
      .select("id", { count: "exact", head: true })
      .eq("study_set_id", studySetId)
      .eq("user_id", userId);

    if (result.error) {
      return { count: 0, error: formatDbError(result.error) };
    }

    return { count: result.count || 0, error: null };

  }

  async function insertGeneratedMaterialsForStudySet(
    userId,
    studySetId,
    studySet
  ) {

    var supabase = client();

    if (!supabase || !userId || !studySetId) {
      return {
        data: null,
        error: formatDbError({ message: "Cannot sync materials." })
      };
    }

    var existing = await countGeneratedMaterialsForStudySet(
      userId,
      studySetId
    );

    if (existing.error) {
      return { data: null, error: existing.error };
    }

    if (existing.count > 0) {
      return { data: [], error: null, skipped: true };
    }

    var rows = buildMaterialsFromStudySet(userId, studySetId, studySet);

    if (!rows.length) {
      return {
        data: null,
        error: formatDbError({ message: "No generated materials to insert." })
      };
    }

    for (var i = 0; i < rows.length; i++) {

      var rowType = rows[i].material_type;

      if (!materialTypeAllowedInDatabase(rowType)) {
        return {
          data: null,
          error: formatDbError({
            message:
              "Unsupported material type for database: " + String(rowType)
          })
        };
      }

      rows[i].material_type = canonicalMaterialType(rowType);

    }

    var insertResult = await supabase
      .from("generated_materials")
      .insert(rows)
      .select(GENERATED_MATERIAL_COLUMNS);

    if (insertResult.error) {
      return { data: null, error: formatDbError(insertResult.error) };
    }

    return { data: insertResult.data || [], error: null };

  }

  async function retryGeneratedMaterialsSync(userId, studySetId, studySet) {

    var existing = await countGeneratedMaterialsForStudySet(
      userId,
      studySetId
    );

    if (existing.error) {
      return { data: null, error: existing.error, skipped: false };
    }

    if (existing.count > 0) {
      await refreshMaterialsCache(userId);
      return {
        data: [],
        error: null,
        skipped: true,
        message: "Generated materials are already saved for this study set."
      };
    }

    var insertResult = await insertGeneratedMaterialsForStudySet(
      userId,
      studySetId,
      studySet
    );

    if (insertResult.error) {
      return {
        data: null,
        error: insertResult.error,
        skipped: false
      };
    }

    await refreshMaterialsCache(userId);

    return {
      data: insertResult.data,
      error: null,
      skipped: false
    };

  }

  async function refreshMaterialsCache(userId) {

    var materialsResult = await fetchGeneratedMaterials(userId);

    if (!materialsResult.error) {
      materialsCache = (materialsResult.data || []).map(
        normalizeMaterialRow
      );
    }

    return materialsCache;

  }

  async function fetchGeneratedMaterials(userId) {

    var supabase = client();

    if (!supabase || !userId) {
      return { data: [], error: null };
    }

    var result = await supabase
      .from("generated_materials")
      .select(GENERATED_MATERIAL_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (result.error) {
      return { data: [], error: formatDbError(result.error) };
    }

    return result;

  }

  async function migrateLocalStudySets(userId) {

    if (!userId) {
      return { migrated: 0, error: null };
    }

    var flagKey = ACE_MIGRATED_PREFIX + userId;

    if (global.localStorage.getItem(flagKey) === "1") {
      return { migrated: 0, error: null, skipped: true };
    }

    var localSets = readLocalStudySets();

    if (!localSets.length) {
      global.localStorage.setItem(flagKey, "1");
      return { migrated: 0, error: null };
    }

    var supabase = client();

    if (!supabase) {
      return {
        migrated: 0,
        error: formatDbError({ message: "Supabase unavailable." })
      };
    }

    var migrated = 0;
    var hadError = false;
    var lastError = null;

    for (var i = 0; i < localSets.length; i++) {

      var localSet = localSets[i];
      var result = await insertStudySet(userId, localSet);

      if (!result.error || (result.data && result.warning)) {
        migrated += 1;
      }

      if (result.error) {
        hadError = true;
        lastError = result.error;
      }

    }

    if (!hadError) {
      global.localStorage.setItem(flagKey, "1");
    }

    return {
      migrated: migrated,
      error: hadError ? lastError : null
    };

  }

  async function loadAll(userId) {

    var migration = await migrateLocalStudySets(userId);

    var setsResult = await fetchStudySets(userId);

    if (setsResult.error) {
      return {
        studySets: readLocalStudySets(),
        materials: [],
        error: setsResult.error,
        migration: migration
      };
    }

    studySetsCache = setsResult.data || [];

    var materialsResult = await fetchGeneratedMaterials(userId);

    if (!materialsResult.error) {
      mergeMaterialsCache(materialsResult.data || []);
    } else {
      materialsCache = [];
    }

    return {
      studySets: studySetsCache,
      materials: materialsCache,
      error: materialsResult.error || migration.error || null,
      migration: migration
    };

  }

  function getCachedStudySets() {

    if (studySetsCache) {
      return studySetsCache;
    }

    return readLocalStudySets();

  }

  function setCachedStudySets(sets) {
    studySetsCache = sets;
  }

  function readLocalMaterials() {

    try {

      var raw = global.localStorage.getItem(ACE_LOCAL_MATERIALS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(normalizeMaterialRow) : [];

    } catch (error) {

      return [];

    }

  }

  function writeLocalMaterials(rows) {

    try {
      global.localStorage.setItem(
        ACE_LOCAL_MATERIALS_KEY,
        JSON.stringify(rows || [])
      );
    } catch (error) {
      /* ignore quota errors */
    }

  }

  function mergeMaterialsCache(rows) {

    materialsCache = (rows || []).map(normalizeMaterialRow);
    return materialsCache;

  }

  function getMaterialsByType(materialType) {

    var rows = materialsCache;

    if (!rows) {
      rows = readLocalMaterials();
    }

    return rows.filter(function (row) {
      return canonicalMaterialType(row.material_type) === materialType;
    });

  }

  function upsertMaterialInCache(row) {

    if (!row) {
      return;
    }

    var list = materialsCache ? materialsCache.slice() : readLocalMaterials();

    var index = list.findIndex(function (entry) {
      return entry.id === row.id;
    });

    if (index >= 0) {
      list[index] = normalizeMaterialRow(row);
    } else {
      list.unshift(normalizeMaterialRow(row));
    }

    materialsCache = list;

  }

  function removeMaterialFromCache(materialId) {

    if (!materialId) {
      return;
    }

    var list = materialsCache ? materialsCache.slice() : readLocalMaterials();

    materialsCache = list.filter(function (entry) {
      return entry.id !== materialId;
    });

  }

  async function insertGeneratedMaterial(userId, payload) {

    var supabase = client();
    var now = new Date().toISOString();
    var materialType = canonicalMaterialType(payload.material_type);

    if (!materialTypeAllowedInDatabase(materialType)) {
      return {
        data: null,
        error: formatDbError({
          message: "Unsupported material type for database."
        })
      };
    }

    var row = {
      user_id: userId || null,
      study_set_id: payload.study_set_id || null,
      title: payload.title || "Untitled",
      material_type: materialType,
      content: payload.content || {},
      updated_at: now
    };

    if (!supabase || !userId) {

      row.id = "mat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      row.created_at = now;

      var local = readLocalMaterials();
      local.unshift(row);
      writeLocalMaterials(local);
      upsertMaterialInCache(row);

      return { data: row, error: null, source: "local" };

    }

    var result = await supabase
      .from("generated_materials")
      .insert(row)
      .select(GENERATED_MATERIAL_COLUMNS)
      .single();

    if (result.error) {
      return { data: null, error: formatDbError(result.error), source: "remote" };
    }

    var saved = normalizeMaterialRow(result.data);
    upsertMaterialInCache(saved);

    return { data: saved, error: null, source: "remote" };

  }

  async function findFormulaSheetByFingerprint(userId, fingerprint) {

    if (!userId || !fingerprint) {
      return null;
    }

    var cached = (materialsCache || readLocalMaterials()).find(function (row) {
      return (
        canonicalMaterialType(row.material_type) === MATERIAL_TYPES.formula_sheet &&
        row.content &&
        row.content.sheet_fingerprint === fingerprint
      );
    });

    if (cached) {
      return normalizeMaterialRow(cached);
    }

    var supabase = client();

    if (!supabase) {
      return null;
    }

    var result = await supabase
      .from("generated_materials")
      .select(GENERATED_MATERIAL_COLUMNS)
      .eq("user_id", userId)
      .eq("material_type", MATERIAL_TYPES.formula_sheet)
      .eq("content->>sheet_fingerprint", fingerprint)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (result.error || !result.data) {
      return null;
    }

    var normalized = normalizeMaterialRow(result.data);
    upsertMaterialInCache(normalized);
    return normalized;

  }

  async function saveFormulaSheet(userId, payload) {

    var content = payload.content || {};
    var fingerprint = content.sheet_fingerprint;

    if (payload.existing_material_id) {
      var existingById = (materialsCache || []).find(function (row) {
        return row.id === payload.existing_material_id;
      });

      if (existingById) {
        return {
          data: normalizeMaterialRow(existingById),
          error: null,
          alreadySaved: true,
          source: "cache"
        };
      }
    }

    if (fingerprint) {
      var existing = await findFormulaSheetByFingerprint(userId, fingerprint);

      if (existing) {
        return {
          data: existing,
          error: null,
          alreadySaved: true,
          source: "remote"
        };
      }
    }

    var insertResult = await insertGeneratedMaterial(userId, payload);

    if (insertResult.error) {
      return {
        data: null,
        error: insertResult.error,
        alreadySaved: false,
        source: insertResult.source || "remote"
      };
    }

    return {
      data: insertResult.data,
      error: null,
      alreadySaved: false,
      source: insertResult.source || "remote"
    };

  }

  async function saveFlashcardDeck(userId, payload) {

    var content = payload.content || {};
    var fingerprint = content.deck_fingerprint;

    if (payload.existing_material_id) {
      var existingById = (materialsCache || []).find(function (row) {
        return row.id === payload.existing_material_id;
      });

      if (existingById) {
        return {
          data: normalizeMaterialRow(existingById),
          error: null,
          alreadySaved: true,
          source: "cache"
        };
      }
    }

    if (fingerprint) {
      var existing = await findFlashcardDeckByFingerprint(userId, fingerprint);

      if (existing) {
        return {
          data: existing,
          error: null,
          alreadySaved: true,
          source: "remote"
        };
      }
    }

    var insertResult = await insertGeneratedMaterial(userId, payload);

    if (insertResult.error) {
      return {
        data: null,
        error: insertResult.error,
        alreadySaved: false,
        source: insertResult.source || "remote"
      };
    }

    return {
      data: insertResult.data,
      error: null,
      alreadySaved: false,
      source: insertResult.source || "remote"
    };

  }

  async function updateGeneratedMaterial(userId, materialId, updates) {

    if (!materialId) {
      return { data: null, error: formatDbError({ message: "Missing material id." }) };
    }

    var supabase = client();
    var patch = Object.assign({}, updates || {}, {
      updated_at: new Date().toISOString()
    });

    if (!supabase || !userId) {

      var local = readLocalMaterials();
      var index = local.findIndex(function (entry) {
        return entry.id === materialId;
      });

      if (index < 0) {
        return {
          data: null,
          error: formatDbError({ message: "Cheatsheet not found." })
        };
      }

      local[index] = normalizeMaterialRow(
        Object.assign({}, local[index], patch)
      );
      writeLocalMaterials(local);
      upsertMaterialInCache(local[index]);

      return { data: local[index], error: null, source: "local" };

    }

    var result = await supabase
      .from("generated_materials")
      .update(patch)
      .eq("id", materialId)
      .eq("user_id", userId)
      .select(GENERATED_MATERIAL_COLUMNS)
      .single();

    if (result.error) {
      return { data: null, error: formatDbError(result.error), source: "remote" };
    }

    var saved = normalizeMaterialRow(result.data);
    upsertMaterialInCache(saved);

    return { data: saved, error: null, source: "remote" };

  }

  async function deleteGeneratedMaterial(userId, materialId) {

    if (!materialId) {
      return { error: formatDbError({ message: "Missing material id." }) };
    }

    var supabase = client();

    if (!supabase || !userId) {

      var local = readLocalMaterials().filter(function (entry) {
        return entry.id !== materialId;
      });

      writeLocalMaterials(local);
      mergeMaterialsCache(local);

      return { error: null, source: "local" };

    }

    var result = await supabase
      .from("generated_materials")
      .delete()
      .eq("id", materialId)
      .eq("user_id", userId);

    if (result.error) {
      return { error: formatDbError(result.error), source: "remote" };
    }

    removeMaterialFromCache(materialId);

    return { error: null, source: "remote" };

  }

  async function insertQuizAttempt(userId, attempt) {

    var supabase = client();

    if (!supabase) {
      return {
        data: null,
        error: formatDbError({ message: "Supabase client unavailable." }),
        sessionMissing: true
      };
    }

    var sessionUserId = await getSupabaseSessionUserId();

    if (!sessionUserId) {
      return {
        data: null,
        error: formatDbError({ message: "No active Supabase session." }),
        sessionMissing: true
      };
    }

    var ownerId = sessionUserId;

    if (attempt.submission_id) {
      var existing = await findQuizAttemptBySubmissionId(
        ownerId,
        attempt.submission_id
      );

      if (existing) {
        return {
          data: existing,
          error: null,
          alreadySaved: true
        };
      }
    }

    var now = new Date().toISOString();
    var rawMaterialId =
      attempt.generated_material_id || attempt.material_id || null;
    var materialId = sanitizeQuizMaterialId(rawMaterialId);
    var score = attempt.score != null ? attempt.score : 0;
    var maxScore =
      attempt.max_score != null
        ? attempt.max_score
        : attempt.total_questions != null
          ? attempt.total_questions
          : 0;

    var answersPayload = Object.assign({}, attempt.answers || {});

    if (attempt.submission_id) {
      answersPayload._ace_submission_id = attempt.submission_id;
    }

    if (attempt.review && typeof attempt.review === "object") {
      answersPayload._ace_review = attempt.review;
    }

    var compactRow = {
      user_id: ownerId,
      material_id: materialId,
      score: score,
      total_questions: maxScore,
      answers: answersPayload,
      completed_at: now
    };

    var compactResult = await supabase
      .from("quiz_attempts")
      .insert(compactRow)
      .select("*")
      .single();

    if (!compactResult.error) {
      return {
        data: normalizeQuizAttemptRow(compactResult.data),
        error: null
      };
    }

    if (!isPostgrestMissingColumnError(compactResult.error)) {
      return { data: null, error: formatDbError(compactResult.error) };
    }

    var extendedRow = {
      user_id: ownerId,
      generated_material_id: materialId,
      study_set_id: attempt.study_set_id || null,
      score: score,
      max_score: maxScore,
      accuracy: attempt.accuracy != null ? attempt.accuracy : 0,
      duration_seconds: attempt.duration_seconds || null,
      settings: attempt.settings || {},
      answers: answersPayload,
      review: attempt.review || {},
      created_at: now,
      updated_at: now
    };

    var extendedResult = await supabase
      .from("quiz_attempts")
      .insert(extendedRow)
      .select("*")
      .single();

    if (!extendedResult.error) {
      return {
        data: normalizeQuizAttemptRow(extendedResult.data),
        error: null
      };
    }

    if (!isPostgrestMissingColumnError(extendedResult.error)) {
      return { data: null, error: formatDbError(extendedResult.error) };
    }

    return {
      data: null,
      error: formatDbError(extendedResult.error || compactResult.error)
    };

  }

  async function fetchQuizAttempts(userId) {

    var supabase = client();

    if (!supabase || !userId) {
      return { data: [], error: null };
    }

    var result = await supabase
      .from("quiz_attempts")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (result.error) {
      return { data: [], error: formatDbError(result.error) };
    }

    return {
      data: (result.data || []).map(normalizeQuizAttemptRow),
      error: null
    };

  }

  async function fetchSubscription(userId) {

    var supabase = client();

    if (!supabase || !userId) {
      return { data: null, error: null };
    }

    var result = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (result.error) {
      return { data: null, error: formatDbError(result.error) };
    }

    return result;

  }

  global.AceDB = {
    MATERIAL_TYPES: MATERIAL_TYPES,
    canonicalMaterialType: canonicalMaterialType,
    materialTypeAllowedInDatabase: materialTypeAllowedInDatabase,
    formatUserFacingMaterialsSyncError: formatUserFacingMaterialsSyncError,
    formatUserFacingSaveError: formatUserFacingSaveError,
    formatUserFacingQuizAttemptSaveError: formatUserFacingQuizAttemptSaveError,
    formatDbError: formatDbError,
    normalizeQuizAttemptRow: normalizeQuizAttemptRow,
    getSupabaseSessionUserId: getSupabaseSessionUserId,
    sanitizeQuizMaterialId: sanitizeQuizMaterialId,
    findQuizAttemptBySubmissionId: findQuizAttemptBySubmissionId,
    loadAll: loadAll,
    getCachedStudySets: getCachedStudySets,
    setCachedStudySets: setCachedStudySets,
    insertStudySet: insertStudySet,
    retryGeneratedMaterialsSync: retryGeneratedMaterialsSync,
    deleteStudySet: deleteStudySet,
    fetchStudySets: fetchStudySets,
    getMaterialsByType: getMaterialsByType,
    insertGeneratedMaterial: insertGeneratedMaterial,
    saveFlashcardDeck: saveFlashcardDeck,
    saveFormulaSheet: saveFormulaSheet,
    findFormulaSheetByFingerprint: findFormulaSheetByFingerprint,
    findFlashcardDeckByFingerprint: findFlashcardDeckByFingerprint,
    updateGeneratedMaterial: updateGeneratedMaterial,
    deleteGeneratedMaterial: deleteGeneratedMaterial,
    readLocalMaterials: readLocalMaterials,
    mergeMaterialsCache: mergeMaterialsCache,
    insertQuizAttempt: insertQuizAttempt,
    fetchQuizAttempts: fetchQuizAttempts,
    fetchSubscription: fetchSubscription,
    readLocalStudySets: readLocalStudySets,
    refreshMaterialsCache: refreshMaterialsCache
  };

})(window);
