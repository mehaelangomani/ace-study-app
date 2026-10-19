/* Ace — AI Flashcards & active recall */

const ACE_FLASHCARD_SESSION_KEY = "aceFlashcardSession";
const ACE_FLASHCARD_ACTIVITY_KEY = "aceFlashcardActivity";

(function (global) {
  "use strict";

  var flashcardGenerateInFlight = false;
  var flashcardSaveInFlight = false;
  var studySession = null;
  var lastCompleteSnapshot = null;
  var activeDeckDraft = null;

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

  function progressStorageKey(materialId) {
    var userId = getProfile()?.id || "local";
    return "ace_flashcard_progress_v1_" + userId + "_" + (materialId || "draft");
  }

  function readDeckProgress(materialId) {
    try {
      var raw = localStorage.getItem(progressStorageKey(materialId));
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeDeckProgress(materialId, data) {
    try {
      localStorage.setItem(
        progressStorageKey(materialId),
        JSON.stringify(data)
      );
    } catch (error) {
      /* ignore quota */
    }
  }

  function readActivityLog() {
    var userId = getProfile()?.id || "local";
    try {
      var raw = localStorage.getItem(ACE_FLASHCARD_ACTIVITY_KEY + "_" + userId);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function appendActivityEntry(entry) {
    var userId = getProfile()?.id || "local";
    var list = readActivityLog();
    list.unshift(entry);
    list = list.slice(0, 16);
    try {
      localStorage.setItem(
        ACE_FLASHCARD_ACTIVITY_KEY + "_" + userId,
        JSON.stringify(list)
      );
    } catch (error) {
      /* ignore */
    }
  }

  function setFlashcardBanner(message, isError) {
    var banner = document.getElementById("flashcardGeneratorBanner");
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

    var retryBtn = document.getElementById("flashcardRetryBtn");
    if (retryBtn) {
      retryBtn.classList.toggle("ace-hidden", !isError || !message);
    }
  }

  function setFlashcardLoading(active) {
    var panel = document.getElementById("flashcardLoadingPanel");
    var btn = document.getElementById("generateFlashcardsBtn");
    var card = document.querySelector(".flashcard-generator-card");

    panel?.classList.toggle("ace-hidden", !active);
    panel?.setAttribute("aria-busy", active ? "true" : "false");
    card?.classList.toggle("is-extracting", active);
    btn?.toggleAttribute("disabled", active);
    if (btn) {
      btn.textContent = active ? "Generating…" : "Generate Flashcards";
    }
  }

  function populateFlashcardStudySetSelect() {
    var select = document.getElementById("flashcardStudySetSelect");
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

  function readFlashcardSettings() {
    var count = parseInt(
      document.getElementById("flashcardCount")?.value || "10",
      10
    );
    var difficulty =
      document.getElementById("flashcardDifficulty")?.value || "mixed";
    var types = [];
    document
      .querySelectorAll('input[name="flashcardType"]:checked')
      .forEach(function (input) {
        types.push(input.value);
      });
    var shuffle = Boolean(document.getElementById("flashcardShuffle")?.checked);

    return {
      card_count: count,
      difficulty: difficulty,
      card_types: types.length
        ? types
        : ["definition", "concept", "question_answer"],
      shuffle: shuffle
    };
  }

  function shuffleArray(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  async function getAccessToken() {
    if (!global.aceSupabase?.auth?.getSession) {
      return null;
    }
    var sessionResult = await global.aceSupabase.auth.getSession();
    return sessionResult?.data?.session?.access_token || null;
  }

  function buildDeckFingerprint(studySetId, cards, settings) {
    var first = cards[0] ? cards[0].front : "";
    var last = cards[cards.length - 1] ? cards[cards.length - 1].front : "";
    return [
      studySetId || "draft",
      settings.card_count || cards.length,
      cards.length,
      first.slice(0, 40),
      last.slice(0, 40)
    ].join("|");
  }

  function buildMaterialContent(payload, settings, fingerprint) {
    return {
      schema: "ai_flashcard_v1",
      version: 1,
      title: payload.title,
      settings: Object.assign({}, settings, payload.settings_echo || {}),
      cards: payload.cards,
      card_count: payload.card_count,
      deck_fingerprint: fingerprint
    };
  }

  function updateSaveDeckUi() {
    var materialId =
      studySession?.materialId ||
      activeDeckDraft?.materialId ||
      lastCompleteSnapshot?.materialId ||
      null;
    var statusStudy = document.getElementById("flashcardSaveStatus");
    var statusComplete = document.getElementById("flashcardSaveStatusComplete");
    var saveStudyBtn = document.getElementById("flashcardSaveDeckBtn");
    var saveCompleteBtn = document.getElementById("flashcardSaveDeckCompleteBtn");
    var label = materialId ? "Saved to your library" : "Not saved yet — use Save Deck";

    if (statusStudy) {
      statusStudy.textContent = label;
    }
    if (statusComplete) {
      statusComplete.textContent = label;
    }
    if (saveStudyBtn) {
      saveStudyBtn.textContent = materialId ? "Deck saved" : "Save Deck";
      saveStudyBtn.toggleAttribute("disabled", Boolean(materialId));
    }
    if (saveCompleteBtn) {
      saveCompleteBtn.textContent = materialId ? "Deck saved" : "Save Deck";
      saveCompleteBtn.toggleAttribute("disabled", Boolean(materialId));
    }
  }

  async function saveDeckExplicitly() {
    if (flashcardSaveInFlight) {
      return;
    }

    var profile = getProfile();
    if (!profile?.id) {
      global.showToast?.("Sign in to save decks.");
      return;
    }

    var draft = activeDeckDraft;
    if (!draft && studySession) {
      draft = {
        studySet: { id: studySession.studySetId, title: studySession.title },
        materialContent: {
          schema: "ai_flashcard_v1",
          version: 1,
          title: studySession.title,
          settings: studySession.settings,
          cards: studySession.cards,
          card_count: studySession.cards.length,
          deck_fingerprint: studySession.deckFingerprint
        },
        title: studySession.title,
        materialId: studySession.materialId
      };
    }

    if (!draft || !draft.materialContent?.cards?.length) {
      global.showToast?.("Generate a deck before saving.");
      return;
    }

    if (
      draft.materialId ||
      studySession?.materialId ||
      lastCompleteSnapshot?.materialId
    ) {
      global.showToast?.("Deck already saved!");
      updateSaveDeckUi();
      return;
    }

    if (
      !global.AceDB ||
      typeof global.AceDB.saveFlashcardDeck !== "function"
    ) {
      global.showToast?.("Database helpers are unavailable.");
      return;
    }

    flashcardSaveInFlight = true;

    try {
      var saveResult = await global.AceDB.saveFlashcardDeck(profile.id, {
        study_set_id: draft.studySet.id,
        material_type: global.AceDB.MATERIAL_TYPES.flashcard,
        title: (draft.title || draft.studySet.title) + " — Flashcards",
        content: draft.materialContent,
        existing_material_id: draft.materialId || null
      });

      if (saveResult.error) {
        var message = global.AceDB.formatUserFacingSaveError
          ? global.AceDB.formatUserFacingSaveError(saveResult.error, "Deck")
          : "Deck could not be saved. Please try again.";
        global.showToast?.(message);
        return;
      }

      if (saveResult.alreadySaved) {
        global.showToast?.("Deck already saved!");
      } else {
        global.showToast?.("Deck saved!");
      }

      var savedId = saveResult.data?.id || null;

      if (savedId) {
        draft.materialId = savedId;
        activeDeckDraft = draft;

        if (studySession) {
          studySession.materialId = savedId;
          persistStudySession();
        }

        if (lastCompleteSnapshot) {
          lastCompleteSnapshot.materialId = savedId;
        }
      }

      if (typeof global.AceDB.refreshMaterialsCache === "function") {
        await global.AceDB.refreshMaterialsCache(profile.id);
      }

      global.renderGeneratedMaterialViews?.();
      renderFlashcardsGrid();
      updateSaveDeckUi();
    } finally {
      flashcardSaveInFlight = false;
    }
  }

  async function generateFlashcardsFromUi() {
    if (flashcardGenerateInFlight) {
      return;
    }

    var select = document.getElementById("flashcardStudySetSelect");
    var setId = select?.value;
    var studySet = getStudySets().find(function (s) { return s.id === setId; });

    if (!studySet) {
      setFlashcardBanner("Select a saved study set to generate flashcards.", true);
      return;
    }

    var notes = studySetNotes(studySet);
    if (notes.length < 10) {
      setFlashcardBanner(
        "This study set does not have enough content. Add notes or re-extract.",
        true
      );
      return;
    }

    var profile = getProfile();
    if (!profile?.id) {
      global.showToast?.("Sign in to generate flashcards.");
      return;
    }

    var token = await getAccessToken();
    if (!token) {
      global.showToast?.("Your session expired. Please sign in again.");
      return;
    }

    var settings = readFlashcardSettings();
    flashcardGenerateInFlight = true;
    setFlashcardBanner("");
    setFlashcardLoading(true);
    activeDeckDraft = null;

    try {
      var response = await fetch(getApiBase() + "/api/generate-flashcards", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          notes: notes,
          title: studySet.title,
          study_set_id: studySet.id,
          card_count: settings.card_count,
          difficulty: settings.difficulty,
          card_types: settings.card_types,
          shuffle: settings.shuffle
        })
      });

      var payload = await response.json().catch(function () {
        return {};
      });

      if (!response.ok) {
        throw new Error(formatApiError(payload.detail));
      }

      var expected = settings.card_count;
      var received = Array.isArray(payload.cards) ? payload.cards.length : 0;
      if (payload.card_count !== expected || received !== expected) {
        throw new Error(
          "Flashcard generation returned " +
            received +
            " of " +
            expected +
            " requested cards. Try again or choose fewer cards."
        );
      }

      var fingerprint = buildDeckFingerprint(
        studySet.id,
        payload.cards,
        settings
      );
      var materialContent = buildMaterialContent(payload, settings, fingerprint);

      activeDeckDraft = {
        studySet: studySet,
        materialContent: materialContent,
        title: payload.title,
        materialId: null
      };

      startStudySession({
        title: payload.title,
        cards: payload.cards,
        settings: materialContent.settings,
        materialId: null,
        studySetId: studySet.id,
        reviewMode: false,
        deckFingerprint: fingerprint
      });

      global.showToast?.("Flashcards ready. Save your deck when you're happy with it.");
      updateSaveDeckUi();
    } catch (error) {
      var message =
        error instanceof Error ? error.message : "Flashcard generation failed.";
      setFlashcardBanner(message, true);
      global.showToast?.(message);
    } finally {
      flashcardGenerateInFlight = false;
      setFlashcardLoading(false);
    }
  }

  function persistStudySession() {
    if (!studySession) {
      return;
    }
    try {
      sessionStorage.setItem(
        ACE_FLASHCARD_SESSION_KEY,
        JSON.stringify({
          title: studySession.title,
          cards: studySession.cards,
          order: studySession.order,
          settings: studySession.settings,
          index: studySession.index,
          flipped: studySession.flipped,
          ratings: studySession.ratings,
          materialId: studySession.materialId,
          studySetId: studySession.studySetId,
          reviewMode: studySession.reviewMode
        })
      );
    } catch (error) {
      /* ignore */
    }

    if (studySession.materialId) {
      writeDeckProgress(studySession.materialId, {
        ratings: studySession.ratings,
        lastIndex: studySession.index,
        updatedAt: Date.now()
      });
    }
  }

  function startStudySession(options) {
    var cards = options.cards || [];
    var settings = options.settings || {};
    var order = cards.map(function (c, i) { return i; });

    if (settings.shuffle && !options.reviewMode) {
      order = shuffleArray(order);
    }

    if (options.reviewMode && options.reviewIndices) {
      order = options.reviewIndices.slice();
    }

    studySession = {
      title: options.title || "Flashcard deck",
      cards: cards,
      order: order,
      settings: settings,
      index: 0,
      flipped: false,
      ratings: options.ratings || {},
      materialId: options.materialId || null,
      studySetId: options.studySetId || null,
      reviewMode: Boolean(options.reviewMode),
      deckFingerprint: options.deckFingerprint || null
    };

    persistStudySession();
    renderFlashcardStudyView();
    updateSaveDeckUi();
    global.showPage?.("flashcard-study");
  }

  function currentCard() {
    if (!studySession) {
      return null;
    }
    var pos = studySession.order[studySession.index];
    return studySession.cards[pos] || null;
  }

  function countRatings() {
    var stats = { knew: 0, almost: 0, unknown: 0, reviewed: 0 };
    if (!studySession) {
      return stats;
    }
    Object.keys(studySession.ratings).forEach(function (id) {
      var rating = studySession.ratings[id];
      if (rating === "knew") {
        stats.knew += 1;
      } else if (rating === "almost") {
        stats.almost += 1;
      } else if (rating === "unknown") {
        stats.unknown += 1;
      }
      stats.reviewed += 1;
    });
    return stats;
  }

  function setFlipped(flipped) {
    if (!studySession) {
      return;
    }
    studySession.flipped = flipped;
    var inner = document.getElementById("flashcardInner");
    var flipper = document.getElementById("flashcardFlipper");
    inner?.classList.toggle("is-flipped", flipped);
    flipper?.setAttribute("aria-pressed", flipped ? "true" : "false");

    var ratingRow = document.getElementById("flashcardRatingRow");
    ratingRow?.classList.toggle("ace-hidden", !flipped);

    var hint = document.getElementById("flashcardFlipHint");
    if (hint) {
      hint.textContent = flipped
        ? "Rate your recall below"
        : "Click or press Space to flip";
    }
  }

  function renderFlashcardStudyView() {
    if (!studySession) {
      return;
    }

    var total = studySession.order.length;
    var current = studySession.index + 1;
    var card = currentCard();

    var titleEl = document.getElementById("flashcardStudyTitle");
    var metaEl = document.getElementById("flashcardStudyMeta");
    if (titleEl) {
      titleEl.textContent = studySession.title;
    }
    if (metaEl) {
      metaEl.textContent = studySession.reviewMode
        ? "Reviewing difficult cards"
        : "Active recall session";
    }

    var counter = document.getElementById("flashcardCounter");
    if (counter) {
      counter.textContent = "Card " + current + " of " + total;
    }

    var fill = document.getElementById("flashcardProgressFill");
    if (fill) {
      fill.style.width = total ? String((current / total) * 100) + "%" : "0%";
    }

    var frontEl = document.getElementById("flashcardFront");
    var backEl = document.getElementById("flashcardBack");

    if (card && frontEl && backEl) {
      frontEl.innerHTML =
        '<div class="flashcard-type">' +
        escapeHtml(card.type.replace(/_/g, " ")) +
        "</div>" +
        '<div class="flashcard-text">' +
        escapeHtml(card.front) +
        "</div>";

      var backHtml =
        '<div class="flashcard-text">' + escapeHtml(card.back) + "</div>";
      if (card.explanation) {
        backHtml +=
          '<p class="flashcard-explanation">' +
          escapeHtml(card.explanation) +
          "</p>";
      }
      backEl.innerHTML = backHtml;
    }

    setFlipped(false);

    document.getElementById("flashcardPrevBtn")?.toggleAttribute(
      "disabled",
      studySession.index <= 0
    );
    document.getElementById("flashcardNextBtn")?.toggleAttribute(
      "disabled",
      studySession.index >= total - 1
    );
  }

  function rateCurrentCard(rating) {
    var card = currentCard();
    if (!card || !studySession) {
      return;
    }
    studySession.ratings[card.id] = rating;
    persistStudySession();

    if (studySession.index < studySession.order.length - 1) {
      studySession.index += 1;
      renderFlashcardStudyView();
      return;
    }

    finishStudySession();
  }

  function finishStudySession() {
    if (!studySession) {
      return;
    }

    var stats = countRatings();
    var total = studySession.order.length;

    lastCompleteSnapshot = {
      title: studySession.title,
      materialId: studySession.materialId,
      studySetId: studySession.studySetId,
      cards: studySession.cards,
      order: studySession.order,
      settings: studySession.settings,
      ratings: Object.assign({}, studySession.ratings),
      stats: stats,
      total: total,
      reviewMode: studySession.reviewMode
    };

    appendActivityEntry({
      title: studySession.title,
      materialId: studySession.materialId,
      at: Date.now(),
      knew: stats.knew,
      almost: stats.almost,
      unknown: stats.unknown,
      total: total
    });

    sessionStorage.removeItem(ACE_FLASHCARD_SESSION_KEY);
    studySession = null;

    renderCompleteView(lastCompleteSnapshot);
    renderFlashcardActivity();
    updateSaveDeckUi();
    global.showPage?.("flashcard-complete");
  }

  function renderCompleteView(snapshot) {
    var summary = document.getElementById("flashcardCompleteSummary");
    if (!summary || !snapshot) {
      return;
    }

    var stats = snapshot.stats;
    summary.innerHTML =
      "<h3>Session complete</h3>" +
      '<p class="quiz-score-line">' +
      escapeHtml(snapshot.title) +
      "</p>" +
      '<ul class="flashcard-summary-list">' +
      "<li><strong>" +
      snapshot.total +
      "</strong> cards in deck</li>" +
      "<li><strong>" +
      stats.reviewed +
      "</strong> cards reviewed</li>" +
      "<li><strong>" +
      stats.knew +
      "</strong> Knew It</li>" +
      "<li><strong>" +
      stats.almost +
      "</strong> Almost</li>" +
      "<li><strong>" +
      stats.unknown +
      "</strong> Didn't Know</li>" +
      "</ul>";
  }

  function difficultCardIndices(snapshot) {
    var indices = [];
    if (!snapshot) {
      return indices;
    }
    snapshot.cards.forEach(function (card, index) {
      var rating = snapshot.ratings[card.id];
      if (rating === "unknown" || rating === "almost") {
        indices.push(index);
      }
    });
    return indices;
  }

  function openDeckFromMaterial(row) {
    var content = row.content || {};
    if (content.schema !== "ai_flashcard_v1" || !content.cards?.length) {
      global.showToast?.(
        "This deck uses a legacy format. Generate a new AI flashcard deck."
      );
      return;
    }

    var progress = readDeckProgress(row.id);

    activeDeckDraft = {
      studySet: { id: row.study_set_id, title: row.title },
      materialContent: content,
      title: content.title || row.title,
      materialId: row.id
    };

    startStudySession({
      title: content.title || row.title,
      cards: content.cards,
      settings: content.settings || { shuffle: true },
      materialId: row.id,
      studySetId: row.study_set_id,
      ratings: progress?.ratings || {},
      reviewMode: false,
      deckFingerprint: content.deck_fingerprint || null
    });
  }

  function renderFlashcardsGrid() {
    var grid = document.getElementById("flashcardsGrid");
    var empty = document.getElementById("flashcardsEmptyState");
    if (!grid || !global.AceDB) {
      return;
    }

    var rows = global.AceDB.getMaterialsByType(
      global.AceDB.MATERIAL_TYPES.flashcard
    ).filter(function (row) {
      return row.content && row.content.schema === "ai_flashcard_v1";
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
        row.content?.card_count || (row.content?.cards || []).length || 0;
      article.innerHTML =
        '<div class="recent-type">FLASHCARDS</div>' +
        "<h3>" +
        escapeHtml(row.title || "Deck") +
        "</h3>" +
        "<p>" +
        count +
        " card(s)</p>" +
        '<div class="cheatsheet-card-actions">' +
        '<button class="detail-button" type="button" data-action="study">Study</button>' +
        "</div>";
      article.querySelector('[data-action="study"]')?.addEventListener(
        "click",
        function (event) {
          event.stopPropagation();
          openDeckFromMaterial(row);
        }
      );
      article.addEventListener("click", function () {
        openDeckFromMaterial(row);
      });
      grid.appendChild(article);
    });
  }

  function renderFlashcardActivity() {
    var grid = document.getElementById("flashcardActivityGrid");
    var empty = document.getElementById("flashcardActivityEmptyState");
    if (!grid) {
      return;
    }

    var entries = readActivityLog();
    grid.innerHTML = "";

    if (!entries.length) {
      grid.classList.add("ace-hidden");
      empty?.classList.remove("ace-hidden");
      return;
    }

    empty?.classList.add("ace-hidden");
    grid.classList.remove("ace-hidden");

    entries.slice(0, 12).forEach(function (entry) {
      var article = document.createElement("article");
      article.className = "recent-card library-card";
      article.innerHTML =
        '<div class="recent-type">SESSION</div>' +
        "<h3>" +
        escapeHtml(entry.title || "Deck") +
        "</h3>" +
        "<p>" +
        escapeHtml(String(entry.knew || 0)) +
        " knew · " +
        escapeHtml(String(entry.almost || 0)) +
        " almost · " +
        escapeHtml(String(entry.unknown || 0)) +
        " didn't know</p>";
      grid.appendChild(article);
    });
  }

  function bindFlashcardUi() {
    document
      .getElementById("generateFlashcardsBtn")
      ?.addEventListener("click", generateFlashcardsFromUi);

    document
      .getElementById("flashcardRetryBtn")
      ?.addEventListener("click", generateFlashcardsFromUi);

    document
      .getElementById("flashcardSaveDeckBtn")
      ?.addEventListener("click", saveDeckExplicitly);

    document
      .getElementById("flashcardSaveDeckCompleteBtn")
      ?.addEventListener("click", saveDeckExplicitly);

    document.getElementById("flashcardGoExtractBtn")?.addEventListener(
      "click",
      function () {
        global.showPage?.("home");
      }
    );

    document.getElementById("flashcardFlipper")?.addEventListener(
      "click",
      function () {
        if (!studySession) {
          return;
        }
        studySession.flipped = !studySession.flipped;
        setFlipped(studySession.flipped);
        persistStudySession();
      }
    );

    document.querySelectorAll(".flashcard-rate-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        rateCurrentCard(btn.getAttribute("data-rating"));
      });
    });

    document.getElementById("flashcardPrevBtn")?.addEventListener(
      "click",
      function () {
        if (!studySession || studySession.index <= 0) {
          return;
        }
        studySession.index -= 1;
        renderFlashcardStudyView();
        persistStudySession();
      }
    );

    document.getElementById("flashcardNextBtn")?.addEventListener(
      "click",
      function () {
        if (!studySession) {
          return;
        }
        if (studySession.index < studySession.order.length - 1) {
          studySession.index += 1;
          renderFlashcardStudyView();
          persistStudySession();
        } else if (studySession.flipped) {
          finishStudySession();
        }
      }
    );

    document.getElementById("flashcardShuffleBtn")?.addEventListener(
      "click",
      function () {
        if (!studySession) {
          return;
        }
        studySession.order = shuffleArray(
          studySession.cards.map(function (_, i) { return i; })
        );
        studySession.index = 0;
        renderFlashcardStudyView();
        persistStudySession();
        global.showToast?.("Deck shuffled.");
      }
    );

    document.getElementById("flashcardStudyBackBtn")?.addEventListener(
      "click",
      function () {
        if (
          studySession &&
          !window.confirm("Exit this study session? Progress is saved.")
        ) {
          return;
        }
        studySession = null;
        sessionStorage.removeItem(ACE_FLASHCARD_SESSION_KEY);
        global.showPage?.("flashcards");
      }
    );

    document.getElementById("flashcardCompleteBackBtn")?.addEventListener(
      "click",
      function () {
        global.showPage?.("flashcards");
      }
    );

    document.getElementById("flashcardReturnBtn")?.addEventListener(
      "click",
      function () {
        global.showPage?.("flashcards");
      }
    );

    document.getElementById("flashcardRestartBtn")?.addEventListener(
      "click",
      function () {
        if (!lastCompleteSnapshot) {
          global.showPage?.("flashcards");
          return;
        }
        startStudySession({
          title: lastCompleteSnapshot.title,
          cards: lastCompleteSnapshot.cards,
          settings: lastCompleteSnapshot.settings,
          materialId: lastCompleteSnapshot.materialId,
          studySetId: lastCompleteSnapshot.studySetId,
          reviewMode: false
        });
      }
    );

    document.getElementById("flashcardReviewDifficultBtn")?.addEventListener(
      "click",
      function () {
        if (!lastCompleteSnapshot) {
          return;
        }
        var indices = difficultCardIndices(lastCompleteSnapshot);
        if (!indices.length) {
          global.showToast?.("No difficult cards marked in this session.");
          return;
        }
        startStudySession({
          title: lastCompleteSnapshot.title + " — Review",
          cards: lastCompleteSnapshot.cards,
          settings: Object.assign({}, lastCompleteSnapshot.settings, {
            shuffle: false
          }),
          materialId: lastCompleteSnapshot.materialId,
          studySetId: lastCompleteSnapshot.studySetId,
          reviewMode: true,
          reviewIndices: indices
        });
      }
    );

    document.addEventListener("keydown", function (event) {
      if (!studySession) {
        return;
      }
      var page = document.getElementById("flashcard-study");
      if (!page || !page.classList.contains("active")) {
        return;
      }

      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        studySession.flipped = !studySession.flipped;
        setFlipped(studySession.flipped);
        persistStudySession();
      } else if (event.key === "ArrowLeft") {
        if (studySession.index > 0) {
          studySession.index -= 1;
          renderFlashcardStudyView();
          persistStudySession();
        }
      } else if (event.key === "ArrowRight") {
        if (studySession.index < studySession.order.length - 1) {
          studySession.index += 1;
          renderFlashcardStudyView();
          persistStudySession();
        }
      }
    });
  }

  function init() {
    bindFlashcardUi();
    populateFlashcardStudySetSelect();
    renderFlashcardActivity();
  }

  global.AceFlashcards = {
    init: init,
    populateFlashcardStudySetSelect: populateFlashcardStudySetSelect,
    renderFlashcardsGrid: renderFlashcardsGrid,
    renderFlashcardActivity: renderFlashcardActivity,
    generateFlashcardsFromUi: generateFlashcardsFromUi,
    saveDeckExplicitly: saveDeckExplicitly,
    openDeckFromMaterial: openDeckFromMaterial
  };
})(window);
