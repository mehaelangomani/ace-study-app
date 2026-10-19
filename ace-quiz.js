/* Ace — AI Quiz feature */

const ACE_QUIZ_PROGRESS_KEY = "aceQuizProgress";

(function (global) {
  "use strict";

  var quizGenerateInFlight = false;
  var quizSession = null;
  var quizTimerInterval = null;
  var quizSubmitInFlight = false;
  var lastGradeResult = null;

  function escapeHtml(value) {
    if (global.escapeHtml) {
      return global.escapeHtml(value);
    }
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getApiBase() {
    if (typeof global.getAceApiBaseUrl === "function") {
      return global.getAceApiBaseUrl();
    }
    return "http://127.0.0.1:8081";
  }

  function formatApiError(detail) {
    if (typeof global.formatApiErrorDetail === "function") {
      return global.formatApiErrorDetail(detail);
    }
    return "Request failed.";
  }

  function getProfile() {
    if (global.AceAuth && typeof global.AceAuth.getProfile === "function") {
      return global.AceAuth.getProfile();
    }
    return null;
  }

  function getStudySets() {
    if (global.AceDB && typeof global.AceDB.getCachedStudySets === "function") {
      return global.AceDB.getCachedStudySets();
    }
    return [];
  }

  function studySetNotes(set) {
    if (typeof global.studySetNotesForCheatsheet === "function") {
      return global.studySetNotesForCheatsheet(set);
    }
    return (set && set.sourceText) || "";
  }

  function setQuizBanner(message, isError) {
    var banner = document.getElementById("quizGeneratorBanner");
    if (!banner) {
      return;
    }
    if (!message) {
      banner.classList.add("ace-hidden");
      banner.textContent = "";
      return;
    }
    banner.textContent = message;
    banner.classList.remove("ace-hidden");
    banner.classList.toggle("is-error", Boolean(isError));
  }

  function setQuizLoading(active) {
    var panel = document.getElementById("quizLoadingPanel");
    var btn = document.getElementById("generateQuizBtn");
    var card = document.querySelector(".quiz-generator-card");

    panel?.classList.toggle("ace-hidden", !active);
    panel?.setAttribute("aria-busy", active ? "true" : "false");
    card?.classList.toggle("is-extracting", active);
    btn?.toggleAttribute("disabled", active);
    if (btn) {
      btn.textContent = active ? "Generating…" : "Generate Quiz";
    }
  }

  function populateQuizStudySetSelect() {
    var select = document.getElementById("quizStudySetSelect");
    if (!select) {
      return;
    }
    var sets = getStudySets();
    var previous = select.value;
    select.innerHTML = '<option value="">Select a saved study set…</option>';
    sets.forEach(function (set) {
      var option = document.createElement("option");
      option.value = set.id;
      option.textContent = set.title || "Untitled study set";
      select.appendChild(option);
    });
    if (previous && sets.some(function (s) { return s.id === previous; })) {
      select.value = previous;
    }
  }

  function readQuizSettings() {
    var count = parseInt(
      document.getElementById("quizQuestionCount")?.value || "10",
      10
    );
    var difficulty =
      document.getElementById("quizDifficulty")?.value || "mixed";
    var types = [];
    document
      .querySelectorAll('input[name="quizType"]:checked')
      .forEach(function (input) {
        types.push(input.value);
      });
    var timed = Boolean(document.getElementById("quizTimedMode")?.checked);
    var timerMinutes = parseInt(
      document.getElementById("quizTimerMinutes")?.value || "15",
      10
    );
    var immediateFeedback = Boolean(
      document.getElementById("quizImmediateFeedback")?.checked
    );

    return {
      question_count: count,
      difficulty: difficulty,
      question_types: types.length ? types : ["multiple_choice", "true_false"],
      timed: timed,
      timer_minutes: Math.max(1, Math.min(180, timerMinutes || 15)),
      immediate_feedback: immediateFeedback
    };
  }

  function persistQuizProgress() {
    if (!quizSession) {
      return;
    }
    try {
      var snapshot = {
        title: quizSession.title,
        questions: quizSession.questions,
        settings: quizSession.settings,
        answers: quizSession.answers,
        flags: quizSession.flags,
        index: quizSession.index,
        materialId: quizSession.materialId,
        studySetId: quizSession.studySetId,
        startedAt: quizSession.startedAt,
        gradingToken: quizSession.gradingToken
      };
      sessionStorage.setItem(ACE_QUIZ_PROGRESS_KEY, JSON.stringify(snapshot));
    } catch (error) {
      /* ignore */
    }
  }

  function clearQuizProgress() {
    sessionStorage.removeItem(ACE_QUIZ_PROGRESS_KEY);
  }

  async function getAccessToken() {
    if (!global.aceSupabase?.auth?.getSession) {
      return null;
    }
    var sessionResult = await global.aceSupabase.auth.getSession();
    return sessionResult?.data?.session?.access_token || null;
  }

  async function generateQuizFromUi() {
    if (quizGenerateInFlight) {
      return;
    }

    var select = document.getElementById("quizStudySetSelect");
    var setId = select?.value;
    var sets = getStudySets();
    var studySet = sets.find(function (s) { return s.id === setId; });

    if (!studySet) {
      setQuizBanner("Select a saved study set to generate a quiz.", true);
      return;
    }

    var notes = studySetNotes(studySet);
    if (notes.length < 10) {
      setQuizBanner(
        "This study set does not have enough content. Add notes or re-extract.",
        true
      );
      return;
    }

    var profile = getProfile();
    if (!profile?.id) {
      global.showToast?.("Sign in to generate quizzes.");
      return;
    }

    var token = await getAccessToken();
    if (!token) {
      global.showToast?.("Your session expired. Please sign in again.");
      return;
    }

    var settings = readQuizSettings();
    quizGenerateInFlight = true;
    setQuizBanner("");
    setQuizLoading(true);

    try {
      var response = await fetch(getApiBase() + "/api/generate-quiz", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          notes: notes,
          title: studySet.title,
          question_count: settings.question_count,
          difficulty: settings.difficulty,
          question_types: settings.question_types
        })
      });

      var payload = await response.json().catch(function () {
        return {};
      });

      if (!response.ok) {
        throw new Error(formatApiError(payload.detail));
      }

      var expectedCount = settings.question_count;
      var receivedCount = Array.isArray(payload.questions)
        ? payload.questions.length
        : 0;
      if (
        payload.question_count !== expectedCount ||
        receivedCount !== expectedCount
      ) {
        throw new Error(
          "Quiz generation returned " +
            receivedCount +
            " of " +
            expectedCount +
            " requested questions. Try again or choose fewer questions."
        );
      }

      var materialContent = {
        schema: "ai_quiz_v1",
        version: 1,
        title: payload.title,
        settings: Object.assign({}, settings, payload.settings_echo || {}),
        questions: payload.questions,
        grading_token: payload.grading_token,
        question_count: payload.question_count
      };

      var savedMaterial = null;

      if (
        global.AceDB &&
        typeof global.AceDB.insertGeneratedMaterial === "function"
      ) {
        var insertResult = await global.AceDB.insertGeneratedMaterial(
          profile.id,
          {
            study_set_id: studySet.id,
            material_type: global.AceDB.MATERIAL_TYPES.quiz,
            title: (payload.title || studySet.title) + " — Quiz",
            content: materialContent
          }
        );

        if (!insertResult.error) {
          savedMaterial = insertResult.data;
        } else if (global.AceDB.formatUserFacingSaveError) {
          global.showToast?.(
            global.AceDB.formatUserFacingSaveError(insertResult.error, "Quiz")
          );
        }
      }

      startQuizSession({
        title: payload.title,
        questions: payload.questions,
        gradingToken: payload.grading_token,
        settings: materialContent.settings,
        materialId: savedMaterial?.id || null,
        studySetId: studySet.id
      });

      global.renderGeneratedMaterialViews?.();
      global.showToast?.("Quiz ready. Good luck!");

    } catch (error) {
      var message =
        error instanceof Error ? error.message : "Quiz generation failed.";
      setQuizBanner(message, true);
      global.showToast?.(message);
    } finally {
      quizGenerateInFlight = false;
      setQuizLoading(false);
    }
  }

  function startQuizSession(options) {
    quizSession = {
      title: options.title || "Practice quiz",
      questions: options.questions || [],
      gradingToken: options.gradingToken,
      settings: options.settings || {},
      answers: {},
      flags: {},
      index: 0,
      materialId: options.materialId || null,
      studySetId: options.studySetId || null,
      startedAt: Date.now(),
      immediateFeedback: {},
      submitted: false,
      submissionId:
        "quiz_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
      attemptSaved: false
    };

    clearQuizTimer();
    if (quizSession.settings.timed) {
      quizSession.endsAt =
        Date.now() + quizSession.settings.timer_minutes * 60 * 1000;
      startQuizTimer();
    }

    persistQuizProgress();
    renderQuizTakeView();
    global.showPage?.("quiz-take");
  }

  function clearQuizTimer() {
    if (quizTimerInterval) {
      clearInterval(quizTimerInterval);
      quizTimerInterval = null;
    }
  }

  function startQuizTimer() {
    var display = document.getElementById("quizTimerDisplay");
    display?.classList.remove("ace-hidden");

    quizTimerInterval = setInterval(function () {
      if (!quizSession?.endsAt) {
        return;
      }
      var remaining = quizSession.endsAt - Date.now();
      if (remaining <= 0) {
        clearQuizTimer();
        submitQuizAttempt(true);
        return;
      }
      var minutes = Math.floor(remaining / 60000);
      var seconds = Math.floor((remaining % 60000) / 1000);
      if (display) {
        display.textContent =
          "Time left: " +
          String(minutes).padStart(2, "0") +
          ":" +
          String(seconds).padStart(2, "0");
      }
    }, 1000);
  }

  function renderQuizTakeView() {
    if (!quizSession) {
      return;
    }

    var titleEl = document.getElementById("quizTakeTitle");
    var metaEl = document.getElementById("quizTakeMeta");
    var total = quizSession.questions.length;
    var current = quizSession.index + 1;

    if (titleEl) {
      titleEl.textContent = quizSession.title;
    }
    if (metaEl) {
      metaEl.textContent =
        "Question " + current + " of " + total;
    }

    var fill = document.getElementById("quizProgressFill");
    if (fill) {
      fill.style.width = Math.round((current / total) * 100) + "%";
    }

    renderQuizNavPills();
    renderCurrentQuestion();
  }

  function renderQuizNavPills() {
    var container = document.getElementById("quizNavPills");
    if (!container || !quizSession) {
      return;
    }
    container.innerHTML = "";
    quizSession.questions.forEach(function (question, index) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiz-pill";
      btn.textContent = String(index + 1);
      if (index === quizSession.index) {
        btn.classList.add("is-current");
      }
      if (quizSession.answers[question.id] != null &&
          quizSession.answers[question.id] !== "" &&
          !(Array.isArray(quizSession.answers[question.id]) &&
            !quizSession.answers[question.id].length)) {
        btn.classList.add("is-answered");
      }
      if (quizSession.flags[question.id]) {
        btn.classList.add("is-flagged");
      }
      btn.addEventListener("click", function () {
        quizSession.index = index;
        renderQuizTakeView();
      });
      container.appendChild(btn);
    });
  }

  function renderCurrentQuestion() {
    var card = document.getElementById("quizQuestionCard");
    if (!card || !quizSession) {
      return;
    }

    var question = quizSession.questions[quizSession.index];
    if (!question) {
      return;
    }

    var typeLabel = question.type.replace(/_/g, " ");
    var html =
      '<div class="quiz-question-head">' +
      '<span class="quiz-question-type">' +
      escapeHtml(typeLabel) +
      "</span>" +
      '<span class="quiz-question-difficulty">' +
      escapeHtml(question.difficulty || "") +
      "</span>" +
      "</div>" +
      "<h3>" +
      escapeHtml(question.prompt) +
      "</h3>";

    var answer = quizSession.answers[question.id];
    var feedback = quizSession.immediateFeedback[question.id];

    if (question.type === "multiple_choice" || question.type === "true_false") {
      html += '<div class="quiz-options">';
      (question.options || []).forEach(function (opt) {
        var checked = answer === opt.id ? " checked" : "";
        html +=
          '<label class="quiz-option">' +
          '<input type="radio" name="quizAnswer" value="' +
          escapeHtml(opt.id) +
          '"' +
          checked +
          "> " +
          escapeHtml(opt.text) +
          "</label>";
      });
      html += "</div>";
    } else if (question.type === "multiple_select") {
      html += '<div class="quiz-options">';
      var selected = Array.isArray(answer) ? answer : [];
      (question.options || []).forEach(function (opt) {
        var checked = selected.indexOf(opt.id) >= 0 ? " checked" : "";
        html +=
          '<label class="quiz-option">' +
          '<input type="checkbox" name="quizAnswerMulti" value="' +
          escapeHtml(opt.id) +
          '"' +
          checked +
          "> " +
          escapeHtml(opt.text) +
          "</label>";
      });
      html += "</div>";
    } else if (question.type === "fill_blank") {
      html +=
        '<input class="quiz-fill-input" type="text" id="quizFillInput" value="' +
        escapeHtml(answer || "") +
        '" placeholder="Type your answer">';
    }

    if (feedback) {
      html +=
        '<div class="quiz-feedback ' +
        (feedback.correct ? "is-correct" : "is-incorrect") +
        '">' +
        escapeHtml(feedback.explanation || "") +
        "</div>";
    }

    card.innerHTML = html;
    bindQuestionInputs(question);
  }

  function bindQuestionInputs(question) {
    var radios = document.querySelectorAll('input[name="quizAnswer"]');
    radios.forEach(function (input) {
      input.addEventListener("change", function () {
        quizSession.answers[question.id] = input.value;
        persistQuizProgress();
        maybeImmediateFeedback(question.id);
        renderQuizNavPills();
      });
    });

    var checks = document.querySelectorAll('input[name="quizAnswerMulti"]');
    checks.forEach(function (input) {
      input.addEventListener("change", function () {
        var selected = [];
        checks.forEach(function (box) {
          if (box.checked) {
            selected.push(box.value);
          }
        });
        quizSession.answers[question.id] = selected;
        persistQuizProgress();
        renderQuizNavPills();
      });
    });

    var fill = document.getElementById("quizFillInput");
    if (fill) {
      fill.addEventListener("input", function () {
        quizSession.answers[question.id] = fill.value;
        persistQuizProgress();
        renderQuizNavPills();
      });
      fill.addEventListener("blur", function () {
        maybeImmediateFeedback(question.id);
      });
    }
  }

  async function maybeImmediateFeedback(questionId) {
    if (!quizSession?.settings?.immediate_feedback) {
      return;
    }
    if (quizSession.immediateFeedback[questionId]) {
      return;
    }

    var token = await getAccessToken();
    if (!token || !quizSession.gradingToken) {
      return;
    }

    try {
      var response = await fetch(getApiBase() + "/api/quiz/check-answer", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          grading_token: quizSession.gradingToken,
          question_id: questionId,
          answer: quizSession.answers[questionId]
        })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        return;
      }
      quizSession.immediateFeedback[questionId] = payload;
      renderCurrentQuestion();
    } catch (error) {
      /* ignore */
    }
  }

  function setQuizAttemptSaveBanner(message, isError) {
    var banner = document.getElementById("quizAttemptSaveBanner");
    var retryBtn = document.getElementById("quizRetrySaveAttemptBtn");
    if (!banner) {
      return;
    }
    if (!message) {
      banner.classList.add("ace-hidden");
      banner.textContent = "";
      retryBtn?.classList.add("ace-hidden");
      return;
    }
    banner.textContent = message;
    banner.classList.remove("ace-hidden");
    banner.classList.toggle("is-error", Boolean(isError));
    retryBtn?.classList.toggle("ace-hidden", !isError);
  }

  function quizMaterialIdIsPersistable(materialId) {
    if (
      global.AceDB &&
      typeof global.AceDB.sanitizeQuizMaterialId === "function"
    ) {
      return Boolean(global.AceDB.sanitizeQuizMaterialId(materialId));
    }
    return Boolean(materialId);
  }

  async function ensureQuizMaterialSaved(profile, context) {
    if (!profile?.id || !global.AceDB) {
      return null;
    }

    var materialId = context.materialId;
    if (quizMaterialIdIsPersistable(materialId)) {
      return global.AceDB.sanitizeQuizMaterialId(materialId);
    }

    var studySetId = context.studySetId;
    var title = context.title || "Practice quiz";
    var questions = context.questions || [];
    var settings = context.settings || {};
    var gradingToken = context.gradingToken;

    if (!gradingToken || !questions.length) {
      return null;
    }

    var insertResult = await global.AceDB.insertGeneratedMaterial(profile.id, {
      study_set_id: studySetId,
      material_type: global.AceDB.MATERIAL_TYPES.quiz,
      title: title + " — Quiz",
      content: {
        schema: "ai_quiz_v1",
        version: 1,
        title: title,
        settings: settings,
        questions: questions,
        grading_token: gradingToken,
        question_count: questions.length
      }
    });

    if (!insertResult.error && insertResult.data) {
      var savedId = insertResult.data.id;
      if (quizSession) {
        quizSession.materialId = savedId;
      }
      if (lastGradeResult) {
        lastGradeResult.materialId = savedId;
        if (lastGradeResult.pendingAttempt) {
          lastGradeResult.pendingAttempt.generated_material_id = savedId;
        }
      }
      global.renderGeneratedMaterialViews?.();
      return global.AceDB.sanitizeQuizMaterialId(savedId);
    }

    return null;
  }

  function formatQuizAttemptSaveMessage(saveOutcome) {
    if (saveOutcome.sessionMissing) {
      return global.AceDB.formatUserFacingQuizAttemptSaveError(null, true);
    }
    if (global.AceDB?.formatUserFacingQuizAttemptSaveError) {
      return global.AceDB.formatUserFacingQuizAttemptSaveError(
        saveOutcome.error,
        false
      );
    }
    return "Your result is ready, but saving the attempt failed. Retry saving.";
  }

  async function persistQuizAttemptToSupabase(profile, gradePayload, durationSeconds) {
    if (!profile?.id || !global.AceDB) {
      return { ok: true, skipped: true };
    }

    if (lastGradeResult?.attemptRecordId) {
      return { ok: true, skipped: true };
    }

    var context = {
      materialId: quizSession?.materialId || lastGradeResult?.materialId,
      studySetId: quizSession?.studySetId || lastGradeResult?.studySetId,
      title: quizSession?.title || lastGradeResult?.title,
      questions: quizSession?.questions || lastGradeResult?.questions,
      settings: quizSession?.settings || lastGradeResult?.settings,
      gradingToken:
        quizSession?.gradingToken || lastGradeResult?.gradingToken
    };

    var linkedMaterialId = await ensureQuizMaterialSaved(profile, context);

    var pending = lastGradeResult?.pendingAttempt;
    if (pending) {
      pending.generated_material_id = linkedMaterialId;
    }

    var insertResult = await global.AceDB.insertQuizAttempt(profile.id, {
      generated_material_id: linkedMaterialId,
      study_set_id: context.studySetId,
      score: gradePayload.score,
      max_score: gradePayload.max_score,
      accuracy: gradePayload.accuracy,
      duration_seconds: durationSeconds,
      settings: context.settings,
      answers: quizSession?.answers || pending?.answers || {},
      review: gradePayload,
      submission_id:
        quizSession?.submissionId || lastGradeResult?.submissionId || pending?.submission_id
    });

    if (insertResult.error) {
      return {
        ok: false,
        error: insertResult.error,
        sessionMissing: Boolean(insertResult.sessionMissing)
      };
    }

    if (quizSession) {
      quizSession.attemptSaved = true;
    }

    if (lastGradeResult) {
      lastGradeResult.attemptRecordId = insertResult.data?.id || true;
      lastGradeResult.attemptSaveError = null;
    }

    return {
      ok: true,
      data: insertResult.data,
      alreadySaved: Boolean(insertResult.alreadySaved)
    };
  }

  async function retrySaveQuizAttempt() {
    if (!lastGradeResult || lastGradeResult.attemptRecordId) {
      setQuizAttemptSaveBanner("");
      return;
    }

    var profile = getProfile();
    if (!profile?.id) {
      global.showToast?.("Sign in to save your attempt.");
      return;
    }

    var pending = lastGradeResult.pendingAttempt;
    if (!pending) {
      global.showToast?.("Nothing to save.");
      return;
    }

    var linkedMaterialId = await ensureQuizMaterialSaved(profile, {
      materialId: lastGradeResult.materialId,
      studySetId: lastGradeResult.studySetId,
      title: lastGradeResult.title,
      questions: lastGradeResult.questions,
      settings: lastGradeResult.settings,
      gradingToken: lastGradeResult.gradingToken
    });

    pending.generated_material_id = linkedMaterialId;

    var insertResult = await global.AceDB.insertQuizAttempt(profile.id, pending);

    if (insertResult.error) {
      var message = formatQuizAttemptSaveMessage({
        error: insertResult.error,
        sessionMissing: insertResult.sessionMissing
      });
      lastGradeResult.attemptSaveError = insertResult.error;
      setQuizAttemptSaveBanner(message, true);
      global.showToast?.(message);
      return;
    }

    lastGradeResult.attemptRecordId = insertResult.data?.id || true;
    lastGradeResult.attemptSaveError = null;
    setQuizAttemptSaveBanner("Quiz attempt saved!", false);
    global.showToast?.(
      insertResult.alreadySaved ? "Quiz attempt already saved!" : "Quiz attempt saved!"
    );
    global.renderQuizAttempts?.();
  }

  async function submitQuizAttempt(autoSubmit) {
    if (!quizSession || quizSubmitInFlight || quizSession.submitted) {
      return;
    }

    if (!autoSubmit) {
      var unanswered = quizSession.questions.filter(function (q) {
        var answer = quizSession.answers[q.id];
        return (
          answer == null ||
          answer === "" ||
          (Array.isArray(answer) && !answer.length)
        );
      }).length;
      if (unanswered > 0) {
        var proceed = window.confirm(
          unanswered +
            " question(s) are unanswered. Submit anyway?"
        );
        if (!proceed) {
          return;
        }
      }
    }

    quizSubmitInFlight = true;
    quizSession.submitted = true;
    clearQuizTimer();

    var token = await getAccessToken();
    if (!token) {
      global.showToast?.("Sign in to submit your quiz.");
      quizSubmitInFlight = false;
      quizSession.submitted = false;
      return;
    }

    try {
      var response = await fetch(getApiBase() + "/api/quiz/grade", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          grading_token: quizSession.gradingToken,
          answers: quizSession.answers
        })
      });

      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(formatApiError(payload.detail));
      }

      var durationSeconds = Math.round(
        (Date.now() - quizSession.startedAt) / 1000
      );

      var profile = getProfile();

      lastGradeResult = {
        grade: payload,
        title: quizSession.title,
        questions: quizSession.questions,
        settings: quizSession.settings,
        gradingToken: quizSession.gradingToken,
        durationSeconds: durationSeconds,
        studySetId: quizSession.studySetId,
        materialId: quizSession.materialId,
        submissionId: quizSession.submissionId,
        attemptRecordId: null,
        attemptSaveError: null,
        pendingAttempt: {
          generated_material_id: quizSession.materialId,
          study_set_id: quizSession.studySetId,
          score: payload.score,
          max_score: payload.max_score,
          accuracy: payload.accuracy,
          duration_seconds: durationSeconds,
          settings: quizSession.settings,
          answers: quizSession.answers,
          review: payload,
          submission_id: quizSession.submissionId
        }
      };

      if (profile?.id && typeof global.AceDB?.insertQuizAttempt === "function") {
        var saveOutcome = await persistQuizAttemptToSupabase(
          profile,
          payload,
          durationSeconds
        );

        if (!saveOutcome.ok && !saveOutcome.skipped) {
          lastGradeResult.attemptSaveError = saveOutcome.error;
          var attemptMessage = formatQuizAttemptSaveMessage(saveOutcome);
          setQuizAttemptSaveBanner(attemptMessage, true);
        } else if (saveOutcome.ok && !saveOutcome.skipped) {
          setQuizAttemptSaveBanner("Quiz attempt saved!", false);
          global.showToast?.(
            saveOutcome.alreadySaved
              ? "Quiz attempt already saved!"
              : "Quiz attempt saved!"
          );
        }
      }

      clearQuizProgress();
      quizSession = null;
      renderQuizResults(lastGradeResult);
      global.renderQuizAttempts?.();
      global.showPage?.("quiz-results");

    } catch (error) {
      var message =
        error instanceof Error ? error.message : "Could not grade quiz.";
      global.showToast?.(message);
      quizSession.submitted = false;
    } finally {
      quizSubmitInFlight = false;
    }
  }

  function renderQuizResults(result) {
    var summary = document.getElementById("quizResultsSummary");
    var review = document.getElementById("quizResultsReview");
    if (!summary || !review || !result) {
      return;
    }

    var grade = result.grade;
    var incorrect = (grade.results || []).filter(function (r) {
      return !r.correct && !r.unanswered;
    }).length;
    var unanswered = (grade.results || []).filter(function (r) {
      return r.unanswered;
    }).length;

    summary.innerHTML =
      "<h3>" +
      escapeHtml(result.title) +
      "</h3>" +
      '<p class="quiz-score-line"><strong>' +
      grade.score +
      "</strong> / " +
      grade.max_score +
      " · " +
      grade.accuracy +
      "% accuracy</p>" +
      "<p>" +
      incorrect +
      " incorrect · " +
      unanswered +
      " unanswered · " +
      result.durationSeconds +
      "s</p>";

    if (grade.weak_concepts && grade.weak_concepts.length) {
      summary.innerHTML +=
        "<p><strong>Review:</strong> " +
        escapeHtml(grade.weak_concepts.join(", ")) +
        "</p>";
    }

    review.innerHTML = "";
    (grade.results || []).forEach(function (item, index) {
      var question = result.questions.find(function (q) {
        return q.id === item.question_id;
      });
      var card = document.createElement("article");
      card.className =
        "cheatsheet-section quiz-review-card" +
        (item.correct ? " is-correct" : item.unanswered ? " is-unanswered" : " is-incorrect");
      card.dataset.questionId = item.question_id;
      card.innerHTML =
        "<h4>Q" +
        (index + 1) +
        ": " +
        escapeHtml(question?.prompt || item.question_id) +
        "</h4>" +
        "<p><strong>Your answer:</strong> " +
        escapeHtml(JSON.stringify(item.user_answer)) +
        "</p>" +
        "<p><strong>Explanation:</strong> " +
        escapeHtml(item.explanation || "") +
        "</p>";
      review.appendChild(card);
    });
  }

  function openQuizFromMaterial(row) {
    var content = row.content || {};
    if (content.schema !== "ai_quiz_v1" || !content.grading_token) {
      global.showToast?.("This quiz uses a legacy format. Generate a new AI quiz.");
      return;
    }
    startQuizSession({
      title: content.title || row.title,
      questions: content.questions || [],
      gradingToken: content.grading_token,
      settings: content.settings || {},
      materialId: row.id,
      studySetId: row.study_set_id
    });
  }

  function renderQuizzesGrid() {
    var grid = document.getElementById("quizzesGrid");
    var empty = document.getElementById("quizzesEmptyState");
    if (!grid || !global.AceDB) {
      return;
    }

    var rows = global.AceDB.getMaterialsByType(global.AceDB.MATERIAL_TYPES.quiz)
      .filter(function (row) {
        return row.content && row.content.schema === "ai_quiz_v1";
      });

    grid.querySelectorAll(".library-card").forEach(function (c) {
      c.remove();
    });

    if (!rows.length) {
      grid.classList.add("ace-hidden");
      empty?.classList.remove("ace-hidden");
      return;
    }

    empty?.classList.add("ace-hidden");
    grid.classList.remove("ace-hidden");

    rows.forEach(function (row) {
      var article = document.createElement("article");
      article.className = "recent-card library-card";
      var count =
        row.content?.question_count ||
        (row.content?.questions || []).length ||
        0;
      article.innerHTML =
        '<div class="recent-type">QUIZ</div>' +
        "<h3>" +
        escapeHtml(row.title || "Quiz") +
        "</h3>" +
        "<p>" +
        count +
        " question(s)</p>" +
        '<div class="cheatsheet-card-actions">' +
        '<button class="detail-button" type="button" data-action="start">Start</button>' +
        "</div>";
      article.querySelector('[data-action="start"]')?.addEventListener(
        "click",
        function (event) {
          event.stopPropagation();
          openQuizFromMaterial(row);
        }
      );
      article.addEventListener("click", function () {
        openQuizFromMaterial(row);
      });
      grid.appendChild(article);
    });
  }

  async function renderQuizAttempts() {
    var grid = document.getElementById("quizAttemptsGrid");
    var empty = document.getElementById("quizAttemptsEmptyState");
    if (!grid) {
      return;
    }

    var profile = getProfile();
    var attempts = [];

    var fetchError = null;

    if (
      profile?.id &&
      global.AceDB &&
      typeof global.AceDB.fetchQuizAttempts === "function"
    ) {
      var result = await global.AceDB.fetchQuizAttempts(profile.id);
      attempts = result.data || [];
      fetchError = result.error;
    }

    grid.innerHTML = "";
    grid.querySelectorAll(".library-card").forEach(function (c) {
      c.remove();
    });

    if (fetchError) {
      grid.classList.add("ace-hidden");
      empty?.classList.remove("ace-hidden");
      if (empty) {
        var emptyText = empty.querySelector("p");
        if (emptyText) {
          emptyText.textContent =
            "Could not load quiz attempts. Sign in and refresh.";
        }
      }
      return;
    }

    if (!attempts.length) {
      grid.classList.add("ace-hidden");
      empty?.classList.remove("ace-hidden");
      if (empty) {
        var defaultText = empty.querySelector("p");
        if (defaultText) {
          defaultText.textContent =
            "Complete a quiz to see your scores here.";
        }
      }
      return;
    }

    empty?.classList.add("ace-hidden");
    grid.classList.remove("ace-hidden");

    attempts.slice(0, 12).forEach(function (attempt) {
      var article = document.createElement("article");
      article.className = "recent-card library-card";
      var score = attempt.score != null ? attempt.score : "?";
      var max =
        attempt.max_score != null ? attempt.max_score : "?";
      var accuracyLabel =
        attempt.accuracy != null ? attempt.accuracy + "% accuracy" : "Completed";
      article.innerHTML =
        '<div class="recent-type">ATTEMPT</div>' +
        "<h3>" +
        escapeHtml(String(score)) +
        " / " +
        escapeHtml(String(max)) +
        "</h3>" +
        "<p>" +
        escapeHtml(String(accuracyLabel)) +
        "</p>";
      grid.appendChild(article);
    });
  }

  function bindQuizUi() {
    document
      .getElementById("generateQuizBtn")
      ?.addEventListener("click", generateQuizFromUi);

    document.getElementById("quizGoExtractBtn")?.addEventListener(
      "click",
      function () {
        global.showPage?.("home");
      }
    );

    document.getElementById("quizRetryBtn")?.addEventListener("click", function () {
      if (lastGradeResult?.materialId) {
        var rows = global.AceDB.getMaterialsByType(
          global.AceDB.MATERIAL_TYPES.quiz
        );
        var row = rows.find(function (r) {
          return r.id === lastGradeResult.materialId;
        });
        if (row) {
          openQuizFromMaterial(row);
          return;
        }
      }
      global.showPage?.("quizzes");
    });

    document
      .getElementById("quizReviewIncorrectBtn")
      ?.addEventListener("click", function () {
        document
          .querySelectorAll(".quiz-review-card.is-incorrect")
          .forEach(function (card) {
            card.scrollIntoView({ behavior: "smooth", block: "start" });
          });
      });

    document
      .getElementById("quizGenerateAnotherBtn")
      ?.addEventListener("click", function () {
        global.showPage?.("quizzes");
      });

    document
      .getElementById("quizResultsBackBtn")
      ?.addEventListener("click", function () {
        global.showPage?.("quizzes");
      });

    document.getElementById("quizTakeBackBtn")?.addEventListener(
      "click",
      function () {
        if (
          quizSession &&
          !window.confirm("Exit the quiz? Your progress is saved in this tab.")
        ) {
          return;
        }
        global.showPage?.("quizzes");
      }
    );

    document.getElementById("quizPrevBtn")?.addEventListener("click", function () {
      if (!quizSession || quizSession.index <= 0) {
        return;
      }
      quizSession.index -= 1;
      renderQuizTakeView();
    });

    document.getElementById("quizNextBtn")?.addEventListener("click", function () {
      if (!quizSession) {
        return;
      }
      if (quizSession.index < quizSession.questions.length - 1) {
        quizSession.index += 1;
        renderQuizTakeView();
      }
    });

    document.getElementById("quizFlagBtn")?.addEventListener("click", function () {
      if (!quizSession) {
        return;
      }
      var q = quizSession.questions[quizSession.index];
      if (!q) {
        return;
      }
      quizSession.flags[q.id] = !quizSession.flags[q.id];
      persistQuizProgress();
      renderQuizNavPills();
    });

    document.getElementById("quizSubmitBtn")?.addEventListener("click", function () {
      submitQuizAttempt(false);
    });

    document
      .getElementById("quizRetrySaveAttemptBtn")
      ?.addEventListener("click", retrySaveQuizAttempt);

    document.getElementById("quizOpenStudySetBtn")?.addEventListener(
      "click",
      function () {
        var setId = lastGradeResult?.studySetId;
        if (!setId) {
          global.showToast?.("No linked study set.");
          return;
        }
        var linked = getStudySets().find(function (s) {
          return s.id === setId;
        });
        if (!linked) {
          global.showToast?.("Study set not found.");
          return;
        }
        if (typeof global.openStudySetResults === "function") {
          global.openStudySetResults(linked);
        }
      }
    );
  }

  function init() {
    bindQuizUi();
    populateQuizStudySetSelect();
  }

  global.AceQuiz = {
    init: init,
    populateQuizStudySetSelect: populateQuizStudySetSelect,
    renderQuizzesGrid: renderQuizzesGrid,
    renderQuizAttempts: renderQuizAttempts,
    generateQuizFromUi: generateQuizFromUi
  };

})(window);
