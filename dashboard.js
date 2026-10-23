/* ============================================
   ACE — DASHBOARD
   Pure JavaScript
   ============================================ */

const ACE_STUDY_SETS_KEY = "aceStudySets";
const ACE_LAST_EXTRACTION_KEY = "aceLastExtraction";
const ACE_DEFAULT_API_BASE_URL = "https://ace-study-app.onrender.com";

function getAceApiBaseUrl() {

  const configured =
    typeof window.ACE_API_BASE_URL === "string"
      ? window.ACE_API_BASE_URL.trim()
      : "";

  const base = configured || ACE_DEFAULT_API_BASE_URL;

  return base.replace(/\/+$/, "");

}

function formatApiErrorDetail(detail) {

  if (!detail) {
    return "Extraction request failed.";
  }

  if (typeof detail === "string") {
    return detail;
  }

  if (Array.isArray(detail)) {

    return detail
      .map(item => item.msg || item.message || JSON.stringify(item))
      .join(" ");

  }

  if (typeof detail === "object" && detail.message) {
    return String(detail.message);
  }

  return "Extraction request failed.";

}

function buildExtractedContentSnapshot(extraction) {

  const keyConcepts = extraction.keyConcepts || [];
  const definitions = extraction.definitions || [];
  const formulas = extraction.formulas || [];
  const keyTakeaways = extraction.keyTakeaways || [];
  const concepts = extraction.concepts || [];

  return {
    version: 2,
    key_concepts: keyConcepts,
    definitions,
    formulas,
    key_takeaways: keyTakeaways,
    concepts
  };

}

function mapApiExtractionPayload(payload, notes) {

  const keyConcepts = Array.isArray(payload.key_concepts)
    ? payload.key_concepts
    : [];
  const definitions = Array.isArray(payload.definitions)
    ? payload.definitions
    : [];
  const formulas = Array.isArray(payload.formulas)
    ? payload.formulas
    : [];
  const keyTakeaways = Array.isArray(payload.key_takeaways)
    ? payload.key_takeaways
    : [];
  const concepts = Array.isArray(payload.concepts)
    ? payload.concepts.filter(
        concept => typeof concept === "string" && concept.trim()
      )
    : [];

  const extraction = {
    title: payload.title || "Untitled study set",
    sourceText: payload.source_text || notes,
    subject: payload.subject || null,
    difficulty: payload.difficulty || null,
    keyConcepts,
    definitions,
    formulas,
    keyTakeaways,
    concepts
  };

  extraction.extractedContent = buildExtractedContentSnapshot(extraction);

  return extraction;

}

function wrapCheatsheetContent(payload) {

  const now = new Date().toISOString();

  return {
    version: 1,
    schema: "cheatsheet",
    ai_generated: true,
    generated_at: now,
    title: payload.title || "Study cheatsheet",
    subject: payload.subject || null,
    overview: payload.overview || "",
    key_concepts: Array.isArray(payload.key_concepts)
      ? payload.key_concepts
      : [],
    important_definitions: Array.isArray(payload.important_definitions)
      ? payload.important_definitions
      : [],
    formulas: Array.isArray(payload.formulas) ? payload.formulas : [],
    key_points: Array.isArray(payload.key_points) ? payload.key_points : [],
    examples: Array.isArray(payload.examples) ? payload.examples : [],
    quick_revision: Array.isArray(payload.quick_revision)
      ? payload.quick_revision
      : []
  };

}

function normalizeCheatsheetContent(content) {

  if (!content || typeof content !== "object") {
    return null;
  }

  if (content.schema === "cheatsheet" || content.ai_generated) {
    return content;
  }

  if (Array.isArray(content.bullets) || content.key_concepts) {
    return {
      version: 1,
      schema: "cheatsheet",
      ai_generated: false,
      title: content.title || "Legacy cheatsheet",
      subject: content.subject || null,
      overview: content.overview || "Condensed revision points from your study set.",
      key_concepts: Array.isArray(content.key_concepts)
        ? content.key_concepts.map(item => ({
            title: item.title || "Concept",
            definition: item.definition || item.explanation || "",
            explanation: item.explanation || item.definition || "",
            example: item.example || null
          }))
        : [],
      important_definitions: [],
      formulas: [],
      key_points: Array.isArray(content.bullets) ? content.bullets : [],
      examples: [],
      quick_revision: Array.isArray(content.bullets)
        ? content.bullets.slice(0, 12)
        : []
    };
  }

  return null;

}

function summarizeCheatsheetContent(content) {

  const normalized = normalizeCheatsheetContent(content);

  if (!normalized) {
    return "Revision cheatsheet.";
  }

  if (normalized.overview) {
    return normalized.overview;
  }

  const concepts = normalized.key_concepts || [];

  if (concepts.length && concepts[0].title) {
    return concepts[0].title;
  }

  const points = normalized.key_points || normalized.quick_revision || [];

  return points[0] || "Structured revision cheatsheet.";

}

function studySetNotesForCheatsheet(set) {

  if (!set) {
    return "";
  }

  const source = (set.sourceText || "").trim();

  if (source.length >= 10) {
    return source;
  }

  const lines = [];
  const content = set.extractedContent || {};

  (content.key_concepts || set.keyConcepts || []).forEach(concept => {

    if (!concept) {
      return;
    }

    lines.push(
      `${concept.title || "Concept"}: ${concept.explanation || concept.definition || ""}`
    );

    if (concept.example) {
      lines.push(`Example: ${concept.example}`);
    }

  });

  (content.definitions || set.definitions || []).forEach(def => {
    lines.push(`${def.term}: ${def.definition}`);
  });

  (content.formulas || set.formulas || []).forEach(formula => {
    lines.push(`${formula.formula}: ${formula.meaning || ""}`);
  });

  (content.key_takeaways || set.keyTakeaways || []).forEach(point => {
    lines.push(point);
  });

  return lines.join("\n").trim();

}

function studySetToExtraction(set) {

  const content = set.extractedContent || {};

  const extraction = {
    title: set.title,
    sourceText: set.sourceText || "",
    subject: set.subject || null,
    difficulty: set.difficulty || null,
    concepts: Array.isArray(set.concepts) ? [...set.concepts] : [],
    keyConcepts:
      set.keyConcepts ||
      content.key_concepts ||
      [],
    definitions:
      set.definitions ||
      content.definitions ||
      [],
    formulas:
      set.formulas ||
      content.formulas ||
      [],
    keyTakeaways:
      set.keyTakeaways ||
      content.key_takeaways ||
      []
  };

  extraction.extractedContent = buildExtractedContentSnapshot(extraction);

  return extraction;

}

function extractionHasContent(extraction) {

  if (!extraction) {
    return false;
  }

  return Boolean(
    (extraction.keyConcepts && extraction.keyConcepts.length) ||
      (extraction.definitions && extraction.definitions.length) ||
      (extraction.formulas && extraction.formulas.length) ||
      (extraction.keyTakeaways && extraction.keyTakeaways.length) ||
      (extraction.concepts && extraction.concepts.length)
  );

}

let extractionInFlight = false;
let extractionStepInterval = null;
let extractionSlowHintTimeout = null;

function clearExtractionProgressTimers() {

  if (extractionStepInterval) {
    clearInterval(extractionStepInterval);
    extractionStepInterval = null;
  }

  if (extractionSlowHintTimeout) {
    clearTimeout(extractionSlowHintTimeout);
    extractionSlowHintTimeout = null;
  }

}

function setExtractionProgressStep(stepIndex) {

  const panel = document.getElementById("extractionLoadingPanel");

  if (!panel) {
    return;
  }

  const steps = panel.querySelectorAll(".extraction-step");

  steps.forEach((step, index) => {
    step.classList.toggle("is-active", index === stepIndex);
  });

}

function hideExtractionErrorPanel() {

  const errorPanel = document.getElementById("extractionErrorPanel");

  errorPanel?.classList.add("ace-hidden");

}

function showExtractionErrorPanel(message) {

  const errorPanel = document.getElementById("extractionErrorPanel");
  const errorMessage = document.getElementById("extractionErrorMessage");

  if (errorMessage) {
    errorMessage.textContent =
      message || "Something went wrong. Please try again.";
  }

  errorPanel?.classList.remove("ace-hidden");

}

function setExtractUiLoading(isLoading) {

  const runExtractBtn = document.getElementById("runExtractBtn");

  if (!runExtractBtn) {
    return;
  }

  runExtractBtn.disabled = Boolean(isLoading);
  runExtractBtn.setAttribute("aria-busy", isLoading ? "true" : "false");

  if (isLoading) {
    runExtractBtn.dataset.aceOriginalLabel =
      runExtractBtn.getAttribute("aria-label") || "Run extraction";
    runExtractBtn.setAttribute("aria-label", "Extracting concepts…");
  } else if (runExtractBtn.dataset.aceOriginalLabel) {
    runExtractBtn.setAttribute(
      "aria-label",
      runExtractBtn.dataset.aceOriginalLabel
    );
  }

}

function setExtractLoadingUi(isLoading) {

  const panel = document.getElementById("extractionLoadingPanel");
  const composer = document.querySelector(".ace-extractor-card");
  const slowHint = document.getElementById("extractionSlowHint");
  const notesInput = document.getElementById("extractNotesInput");
  const titleInput = document.getElementById("extractTitleInput");
  const attachBtn = document.getElementById("extractAttachBtn");

  setExtractUiLoading(isLoading);

  if (isLoading) {

    hideExtractionErrorPanel();
    panel?.classList.remove("ace-hidden");
    panel?.setAttribute("aria-busy", "true");
    composer?.classList.add("is-extracting");

    notesInput?.setAttribute("disabled", "disabled");
    titleInput?.setAttribute("disabled", "disabled");
    attachBtn?.setAttribute("disabled", "disabled");

    setExtractionProgressStep(0);
    clearExtractionProgressTimers();

    extractionStepInterval = setInterval(() => {

      const steps =
        panel?.querySelectorAll(".extraction-step") || [];
      const currentIndex = [...steps].findIndex(step =>
        step.classList.contains("is-active")
      );
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + 1) % steps.length;

      setExtractionProgressStep(nextIndex);

    }, 2800);

    slowHint?.classList.add("ace-hidden");

    extractionSlowHintTimeout = setTimeout(() => {
      slowHint?.classList.remove("ace-hidden");
    }, 12000);

    return;

  }

  panel?.classList.add("ace-hidden");
  panel?.setAttribute("aria-busy", "false");
  composer?.classList.remove("is-extracting");
  clearExtractionProgressTimers();
  slowHint?.classList.add("ace-hidden");

  notesInput?.removeAttribute("disabled");
  titleInput?.removeAttribute("disabled");
  attachBtn?.removeAttribute("disabled");

}

function updateExtractBanners(fromAi) {

  const homeBanner = document.getElementById("homeExtractBanner");

  if (homeBanner) {

    homeBanner.textContent = fromAi
      ? "AI extraction is connected. Your last run used the Ace API."
      : "Paste your notes below, then run Extract. Concepts are generated by the Ace API.";

  }

}

function getAuthSession() {

  if (window.AceAuth && typeof window.AceAuth.getProfile === "function") {
    return window.AceAuth.getProfile();
  }

  return null;

}


async function clearAuthSession() {

  if (window.AceAuth && typeof window.AceAuth.signOut === "function") {
    await window.AceAuth.signOut();
    return;
  }

  if (typeof window.clearAuthSession === "function") {
    await window.clearAuthSession();
  }

}


let aceToastHideTimer;


function showToast(message) {

  const toastEl = document.getElementById("toast");

  if (!toastEl) {
    return;
  }

  toastEl.textContent = message;

  toastEl.classList.add("show");

  clearTimeout(aceToastHideTimer);

  aceToastHideTimer = setTimeout(() => {

    toastEl.classList.remove("show");

  }, 2800);

}

window.showToast = showToast;


document.addEventListener("DOMContentLoaded", async () => {

  const hasSession =
    window.AceAuth &&
    typeof window.AceAuth.requireDashboardSession === "function" &&
    await window.AceAuth.requireDashboardSession();

  if (!hasSession) {
    return;
  }

  window.AceAuth.listenAuthChanges(() => {

    if (typeof window.refreshAceProfileUI === "function") {
      window.refreshAceProfileUI();
    }

  });

  const navItems = document.querySelectorAll(".nav-item[data-page]");
  const pages = document.querySelectorAll(".page");

  const extractNotesInput =
    document.getElementById("extractNotesInput");
  const extractTitleInput =
    document.getElementById("extractTitleInput");
  const runExtractBtn =
    document.getElementById("runExtractBtn");
  const extractAttachBtn =
    document.getElementById("extractAttachBtn");
  const saveStudySetBtn =
    document.getElementById("saveStudySetBtn");
  const backToExtractorBtn =
    document.getElementById("backToExtractorBtn");

  let currentExtraction = null;
  let cheatsheetViewState = {
    row: null,
    draft: null,
    quickRevision: false,
    studySetId: null,
    isDirty: false
  };
  let cheatsheetGenerateInFlight = false;

  const cheatsheetStudySetSelect =
    document.getElementById("cheatsheetStudySetSelect");
  const generateCheatsheetBtn =
    document.getElementById("generateCheatsheetBtn");
  const cheatsheetGoExtractBtn =
    document.getElementById("cheatsheetGoExtractBtn");
  const cheatsheetLoading =
    document.getElementById("cheatsheetLoading");
  const cheatsheetGeneratorBanner =
    document.getElementById("cheatsheetGeneratorBanner");
  const cheatsheetReader =
    document.getElementById("cheatsheetReader");
  const cheatsheetViewTitle =
    document.getElementById("cheatsheetViewTitle");
  const cheatsheetViewMeta =
    document.getElementById("cheatsheetViewMeta");
  const cheatsheetSaveBtn =
    document.getElementById("cheatsheetSaveBtn");
  const cheatsheetQuickRevBtn =
    document.getElementById("cheatsheetQuickRevBtn");
  const cheatsheetBackBtn =
    document.getElementById("cheatsheetBackBtn");


  /* --------------------------------------------
     STUDY SET STORAGE
     -------------------------------------------- */

  function getStudySets() {

    if (
      window.AceDB &&
      typeof window.AceDB.getCachedStudySets === "function"
    ) {
      return window.AceDB.getCachedStudySets();
    }

    try {

      const raw =
        localStorage.getItem(ACE_STUDY_SETS_KEY);

      const parsed = raw ? JSON.parse(raw) : [];

      return Array.isArray(parsed) ? parsed : [];

    } catch {

      return [];

    }

  }


  function setStudySets(sets, options = {}) {

    if (
      window.AceDB &&
      typeof window.AceDB.setCachedStudySets === "function"
    ) {
      window.AceDB.setCachedStudySets(sets);
    }

    if (options.persistLocal || !getAuthSession()?.id) {

      localStorage.setItem(
        ACE_STUDY_SETS_KEY,
        JSON.stringify(sets)
      );

    }

    renderStudySetViews();
    renderGeneratedMaterialViews();

  }


  async function hydrateAceDataFromSupabase() {

    const profile = getAuthSession();

    if (
      !profile?.id ||
      !window.AceDB ||
      typeof window.AceDB.loadAll !== "function"
    ) {

      if (
        window.AceDB &&
        typeof window.AceDB.mergeMaterialsCache === "function" &&
        typeof window.AceDB.readLocalMaterials === "function"
      ) {
        window.AceDB.mergeMaterialsCache(
          window.AceDB.readLocalMaterials()
        );
      }

      return;
    }

    const loaded = await window.AceDB.loadAll(profile.id);

    if (loaded.error) {

      const message =
        (window.AceDB?.formatDbError
          ? window.AceDB.formatDbError(loaded.error).message
          : loaded.error.message) ||
        "Could not load your library from Supabase.";

      showToast(message + " Showing local copies if available.");

      window.AceDB.setCachedStudySets(
        window.AceDB.readLocalStudySets()
      );

      return;

    }

    if (loaded.migration?.migrated > 0) {

      showToast(
        `Synced ${loaded.migration.migrated} local study set(s) to your account.`
      );

    }

  }


  function formatRelativeDate(iso) {

    const date = new Date(iso);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;

    return date.toLocaleDateString();

  }


  function parseNotesToConcepts(text) {

    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const concepts = [];

    lines.forEach(line => {

      const cleaned = line
        .replace(/^[-*•\d.)]+\s*/, "")
        .trim();

      if (cleaned.length >= 3) {
        concepts.push(cleaned);
      }

    });

    if (!concepts.length && text.trim()) {

      text
        .split(/(?<=[.!?])\s+/)
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length >= 8)
        .slice(0, 12)
        .forEach(chunk => concepts.push(chunk));

    }

    return concepts.slice(0, 24);

  }


  function renderStudySetViews() {

    const sets = getStudySets();
    const libraryGrid =
      document.getElementById("libraryGrid");
    const libraryEmpty =
      document.getElementById("libraryEmptyState");
    const usageCount =
      document.getElementById("usageStudySetCount");

    if (usageCount) {
      usageCount.textContent = String(sets.length);
    }

    if (libraryGrid) {

      const searchValue =
        (document.getElementById("librarySearch")?.value || "")
          .trim()
          .toLowerCase();

      const sortValue =
        document.getElementById("librarySort")?.value || "newest";

      libraryGrid
        .querySelectorAll(".library-card")
        .forEach(card => card.remove());

      let filtered = sets.filter(set => {

        if (!searchValue) return true;

        return (
          set.title.toLowerCase().includes(searchValue) ||
          set.concepts.some(concept =>
            concept.toLowerCase().includes(searchValue)
          )
        );

      });

      filtered.sort((a, b) => {

        if (sortValue === "title") {
          return a.title.localeCompare(b.title);
        }

        const aTime = new Date(a.createdAt);
        const bTime = new Date(b.createdAt);

        return sortValue === "oldest"
          ? aTime - bTime
          : bTime - aTime;

      });

      if (!filtered.length) {

        if (libraryEmpty) {
          libraryEmpty.classList.remove("ace-hidden");
        }

      } else {

        if (libraryEmpty) {
          libraryEmpty.classList.add("ace-hidden");
        }

        filtered.forEach(set => {

          libraryGrid.appendChild(
            createStudySetCard(set, { library: true })
          );

        });

      }

    }

  }


  function summarizeMaterialPreview(row) {

    const content = row.content || {};
    const type = row.material_type;

    if (type === "cheatsheet") {
      return summarizeCheatsheetContent(content);
    }

    if (type === "quiz") {

      if (content.schema === "ai_quiz_v1") {
        const count =
          content.question_count ||
          (content.questions || []).length;
        return count
          ? `${count} AI question(s)`
          : "AI practice quiz.";
      }

      const questions = content.questions || [];

      return questions.length
        ? `${questions.length} question(s)`
        : "Practice quiz.";

    }

    if (type === "flashcard") {

      if (content.schema === "ai_flashcard_v1") {
        const count = content.card_count || (content.cards || []).length;
        return count ? `${count} AI flashcard(s)` : "AI flashcard deck.";
      }

      const cards = content.cards || [];

      return cards.length
        ? `${cards.length} card(s)`
        : "Flashcard deck.";

    }

    if (type === "formula_sheet") {

      if (content.schema === "ai_formula_sheet_v1") {
        const count =
          content.formula_count ||
          (content.categories || []).reduce(function (sum, cat) {
            return sum + (cat.formulas || []).length;
          }, 0);
        return count
          ? `${count} AI formula(s)`
          : "AI formula sheet.";
      }

      const items = content.items || [];

      if (!items.length) {
        return "Formula collection from your study set.";
      }

      const first = items[0];

      if (typeof first === "string") {
        return first;
      }

      return first.formula || first.meaning || "Formula sheet.";

    }

    return "Saved material.";

  }


  function setCheatsheetGeneratorBanner(message, isError) {

    if (!cheatsheetGeneratorBanner) {
      return;
    }

    if (!message) {
      cheatsheetGeneratorBanner.textContent = "";
      cheatsheetGeneratorBanner.classList.add("ace-hidden");
      return;
    }

    cheatsheetGeneratorBanner.textContent = message;
    cheatsheetGeneratorBanner.classList.remove("ace-hidden");

    if (isError) {
      cheatsheetGeneratorBanner.classList.add("is-error");
    } else {
      cheatsheetGeneratorBanner.classList.remove("is-error");
    }

  }


  function setCheatsheetLoading(active) {

    cheatsheetLoading?.classList.toggle("ace-hidden", !active);
    generateCheatsheetBtn?.toggleAttribute("disabled", active);

    if (generateCheatsheetBtn) {
      generateCheatsheetBtn.textContent = active
        ? "Generating…"
        : "Generate cheatsheet";
    }

  }


  function populateCheatsheetStudySetSelect() {

    if (!cheatsheetStudySetSelect) {
      return;
    }

    const sets = getStudySets();
    const previous = cheatsheetStudySetSelect.value;

    cheatsheetStudySetSelect.innerHTML =
      '<option value="">Select a saved study set…</option>';

    sets.forEach(set => {

      const option = document.createElement("option");
      option.value = set.id;
      option.textContent = set.title || "Untitled study set";
      cheatsheetStudySetSelect.appendChild(option);

    });

    if (previous && sets.some(set => set.id === previous)) {
      cheatsheetStudySetSelect.value = previous;
    } else if (
      currentExtraction &&
      sets.some(set => set.title === currentExtraction.title)
    ) {
      const match = sets.find(set => set.title === currentExtraction.title);
      if (match) {
        cheatsheetStudySetSelect.value = match.id;
      }
    }

  }


  function getCheatsheetContentFromState() {

    if (cheatsheetViewState.draft) {
      return normalizeCheatsheetContent(cheatsheetViewState.draft);
    }

    if (cheatsheetViewState.row?.content) {
      return normalizeCheatsheetContent(cheatsheetViewState.row.content);
    }

    return null;

  }


  function updateCheatsheetViewChrome() {

    const content = getCheatsheetContentFromState();
    const row = cheatsheetViewState.row;

    if (cheatsheetViewTitle) {
      cheatsheetViewTitle.textContent =
        row?.title || content?.title || "Untitled cheatsheet";
    }

    if (cheatsheetViewMeta) {

      const parts = [];

      if (content?.subject) {
        parts.push(content.subject);
      }

      if (cheatsheetViewState.quickRevision) {
        parts.push("Quick revision mode");
      } else if (row?.created_at) {
        parts.push(`Saved ${formatRelativeDate(row.created_at)}`);
      } else if (cheatsheetViewState.isDirty) {
        parts.push("Unsaved draft");
      }

      cheatsheetViewMeta.textContent = parts.join(" · ");

    }

    cheatsheetSaveBtn?.classList.toggle(
      "ace-hidden",
      Boolean(row?.id && !cheatsheetViewState.isDirty)
    );

    if (cheatsheetQuickRevBtn) {
      cheatsheetQuickRevBtn.textContent = cheatsheetViewState.quickRevision
        ? "Full cheatsheet"
        : "Quick revision";
    }

  }


  function renderCheatsheetReader() {

    if (!cheatsheetReader) {
      return;
    }

    const content = getCheatsheetContentFromState();

    cheatsheetReader.innerHTML = "";

    if (!content) {
      cheatsheetReader.innerHTML =
        '<div class="extract-section-empty">No cheatsheet content to display.</div>';
      updateCheatsheetViewChrome();
      return;
    }

    updateCheatsheetViewChrome();

    if (cheatsheetViewState.quickRevision) {

      const section = document.createElement("section");
      section.className = "cheatsheet-section cheatsheet-quick-revision";

      const bullets = [
        ...(content.quick_revision || []),
        ...(content.key_points || []).slice(0, 6)
      ];

      const defLines = (content.important_definitions || [])
        .slice(0, 8)
        .map(def => `${def.term}: ${def.definition}`);

      const formulaLines = (content.formulas || []).map(
        formula => `${formula.name}: ${formula.expression}`
      );

      const allPoints = [...bullets, ...defLines, ...formulaLines].filter(
        Boolean
      );

      section.innerHTML = `
        <div class="cheatsheet-section-head">
          <h4>Quick revision</h4>
          <span class="cheatsheet-section-count">${allPoints.length} items</span>
        </div>
      `;

      const list = document.createElement("ul");
      list.className = "cheatsheet-point-list";

      if (!allPoints.length) {
        list.innerHTML =
          '<li>No quick revision bullets yet. Switch to the full cheatsheet.</li>';
      } else {
        allPoints.forEach(point => {
          const li = document.createElement("li");
          li.textContent = point;
          list.appendChild(li);
        });
      }

      section.appendChild(list);
      cheatsheetReader.appendChild(section);

      return;

    }

    const overview = document.createElement("section");
    overview.className = "cheatsheet-overview-card";
    overview.innerHTML = `
      <h3>${escapeHtml(content.title || "Study cheatsheet")}</h3>
      ${content.subject
        ? `<span class="cheatsheet-subject">${escapeHtml(content.subject)}</span>`
        : ""}
      <p>${escapeHtml(content.overview || "")}</p>
    `;
    cheatsheetReader.appendChild(overview);

    function appendSection(title, count, body) {

      const section = document.createElement("section");
      section.className = "cheatsheet-section";
      section.innerHTML = `
        <div class="cheatsheet-section-head">
          <h4>${escapeHtml(title)}</h4>
          <span class="cheatsheet-section-count">${count}</span>
        </div>
      `;
      section.appendChild(body);
      cheatsheetReader.appendChild(section);

    }

    if (content.key_concepts?.length) {

      const body = document.createElement("div");

      content.key_concepts.forEach(concept => {

        const card = document.createElement("article");
        card.className = "cheatsheet-concept-card";
        card.innerHTML = `
          <h5>${escapeHtml(concept.title || "Concept")}</h5>
          <span class="cheatsheet-label">Definition</span>
          <p>${escapeHtml(concept.definition || "")}</p>
          <span class="cheatsheet-label">Explanation</span>
          <p>${escapeHtml(concept.explanation || "")}</p>
          ${concept.example
            ? `<span class="cheatsheet-label">Example</span><p>${escapeHtml(concept.example)}</p>`
            : ""}
        `;
        body.appendChild(card);

      });

      appendSection(
        "Key concepts",
        `${content.key_concepts.length}`,
        body
      );

    }

    if (content.important_definitions?.length) {

      const body = document.createElement("div");

      content.important_definitions.forEach(def => {

        const card = document.createElement("article");
        card.className = "cheatsheet-def-card";
        card.innerHTML = `
          <h5>${escapeHtml(def.term || "Term")}</h5>
          <p>${escapeHtml(def.definition || "")}</p>
        `;
        body.appendChild(card);

      });

      appendSection(
        "Important definitions",
        `${content.important_definitions.length}`,
        body
      );

    }

    if (content.formulas?.length) {

      const body = document.createElement("div");
      body.className = "cheatsheet-formula-grid";

      content.formulas.forEach(formula => {

        const card = document.createElement("article");
        card.className = "cheatsheet-formula-card";

        const variables = Array.isArray(formula.variables)
          ? formula.variables
          : [];

        card.innerHTML = `
          <h5>${escapeHtml(formula.name || "Formula")}</h5>
          <div class="cheatsheet-formula-expression">${escapeHtml(formula.expression || "")}</div>
        `;

        if (variables.length) {

          const list = document.createElement("ul");
          list.className = "cheatsheet-var-list";

          variables.forEach(variable => {

            const li = document.createElement("li");
            li.innerHTML = `<code>${escapeHtml(variable.symbol || "")}</code> — ${escapeHtml(variable.meaning || "")}`;
            list.appendChild(li);

          });

          card.appendChild(list);

        }

        if (formula.example) {
          const example = document.createElement("p");
          example.innerHTML = `<span class="cheatsheet-label">Example</span> ${escapeHtml(formula.example)}`;
          card.appendChild(example);
        }

        body.appendChild(card);

      });

      appendSection("Formula sheet", `${content.formulas.length}`, body);

    }

    if (content.key_points?.length) {

      const list = document.createElement("ul");
      list.className = "cheatsheet-point-list";

      content.key_points.forEach(point => {

        const li = document.createElement("li");
        li.textContent = point;
        list.appendChild(li);

      });

      appendSection("Key points", `${content.key_points.length}`, list);

    }

    if (content.examples?.length) {

      const body = document.createElement("div");

      content.examples.forEach(example => {

        const card = document.createElement("article");
        card.className = "cheatsheet-example-card";
        card.innerHTML = `
          <h5>${escapeHtml(example.title || "Example")}</h5>
          <p>${escapeHtml(example.explanation || "")}</p>
        `;
        body.appendChild(card);

      });

      appendSection("Examples", `${content.examples.length}`, body);

    }

    if (content.quick_revision?.length) {

      const list = document.createElement("ul");
      list.className = "cheatsheet-point-list";

      content.quick_revision.forEach(point => {

        const li = document.createElement("li");
        li.textContent = point;
        list.appendChild(li);

      });

      appendSection(
        "Quick revision",
        `${content.quick_revision.length}`,
        list
      );

    }

  }


  function openCheatsheetView(options = {}) {

    cheatsheetViewState = {
      row: options.row || null,
      draft: options.draft || null,
      quickRevision: Boolean(options.quickRevision),
      studySetId: options.studySetId || options.row?.study_set_id || null,
      isDirty: Boolean(options.isDirty)
    };

    renderCheatsheetReader();
    showPage("cheatsheet-view");

  }


  async function saveCheatsheetFromView() {

    const content = getCheatsheetContentFromState();

    if (!content) {
      showToast("Nothing to save.");
      return;
    }

    const profile = getAuthSession();
    const studySetId =
      cheatsheetViewState.studySetId ||
      cheatsheetViewState.row?.study_set_id ||
      null;

    if (
      !window.AceDB ||
      typeof window.AceDB.insertGeneratedMaterial !== "function"
    ) {
      showToast("Database helpers are unavailable.");
      return;
    }

    if (cheatsheetViewState.row?.id && cheatsheetViewState.isDirty) {

      const updateResult = await window.AceDB.updateGeneratedMaterial(
        profile?.id,
        cheatsheetViewState.row.id,
        {
          title: cheatsheetViewState.row.title,
          content
        }
      );

      if (updateResult.error) {
        showToast(
          window.AceDB.formatDbError(updateResult.error).message ||
            "Could not update cheatsheet."
        );
        return;
      }

      cheatsheetViewState.row = updateResult.data;
      cheatsheetViewState.draft = null;
      cheatsheetViewState.isDirty = false;

      renderGeneratedMaterialViews();
      renderCheatsheetReader();
      showToast("Cheatsheet updated.");
      return;

    }

    if (cheatsheetViewState.row?.id && !cheatsheetViewState.isDirty) {
      showToast("This cheatsheet is already saved.");
      return;
    }

    const title =
      cheatsheetViewState.row?.title ||
      `${content.title || "Study set"} — Cheatsheet`;

    const insertResult = await window.AceDB.insertGeneratedMaterial(
      profile?.id,
      {
        study_set_id: studySetId,
        material_type: window.AceDB.MATERIAL_TYPES.cheatsheet,
        title,
        content
      }
    );

    if (insertResult.error) {
      showToast(
        window.AceDB.formatDbError(insertResult.error).message ||
          "Could not save cheatsheet."
      );
      return;
    }

    cheatsheetViewState.row = insertResult.data;
    cheatsheetViewState.draft = null;
    cheatsheetViewState.isDirty = false;

    renderGeneratedMaterialViews();
    renderCheatsheetReader();
    showToast("Cheatsheet saved to your library.");

  }


  async function deleteCheatsheetRow(row) {

    if (!row?.id) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${row.title || "this cheatsheet"}"? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    const profile = getAuthSession();

    if (
      !window.AceDB ||
      typeof window.AceDB.deleteGeneratedMaterial !== "function"
    ) {
      showToast("Database helpers are unavailable.");
      return;
    }

    const result = await window.AceDB.deleteGeneratedMaterial(
      profile?.id,
      row.id
    );

    if (result.error) {
      showToast(
        window.AceDB.formatDbError(result.error).message ||
          "Could not delete cheatsheet."
      );
      return;
    }

    if (cheatsheetViewState.row?.id === row.id) {
      cheatsheetViewState = {
        row: null,
        draft: null,
        quickRevision: false,
        studySetId: null,
        isDirty: false
      };
      showPage("cheatsheets");
    }

    renderGeneratedMaterialViews();
    showToast("Cheatsheet deleted.");

  }


  async function renameCheatsheetRow(row) {

    const currentTitle = row?.title || "Cheatsheet";
    const nextTitle = window.prompt("Rename cheatsheet", currentTitle);

    if (!nextTitle || nextTitle.trim() === currentTitle) {
      return;
    }

    const profile = getAuthSession();
    const trimmed = nextTitle.trim();

    if (
      !window.AceDB ||
      typeof window.AceDB.updateGeneratedMaterial !== "function"
    ) {
      showToast("Database helpers are unavailable.");
      return;
    }

    if (!row?.id) {

      cheatsheetViewState.row = Object.assign({}, row || {}, {
        title: trimmed
      });
      cheatsheetViewState.isDirty = true;
      updateCheatsheetViewChrome();
      renderCheatsheetReader();
      return;

    }

    const result = await window.AceDB.updateGeneratedMaterial(
      profile?.id,
      row.id,
      { title: trimmed }
    );

    if (result.error) {
      showToast(
        window.AceDB.formatDbError(result.error).message ||
          "Could not rename cheatsheet."
      );
      return;
    }

    if (cheatsheetViewState.row?.id === row.id) {
      cheatsheetViewState.row = result.data;
      renderCheatsheetReader();
    }

    renderGeneratedMaterialViews();
    showToast("Cheatsheet renamed.");

  }


  function renderCheatsheetsGrid() {

    const grid = document.getElementById("cheatsheetsGrid");
    const empty = document.getElementById("cheatsheetsEmptyState");

    if (!grid || !window.AceDB) {
      return;
    }

    const rows = window.AceDB.getMaterialsByType(
      window.AceDB.MATERIAL_TYPES.cheatsheet
    );

    grid
      .querySelectorAll(".library-card")
      .forEach(card => card.remove());

    if (!rows.length) {
      grid.classList.add("ace-hidden");
      empty?.classList.remove("ace-hidden");
      return;
    }

    empty?.classList.add("ace-hidden");
    grid.classList.remove("ace-hidden");

    rows.forEach(row => {

      const article = document.createElement("article");
      article.className = "recent-card library-card";

      article.innerHTML = `
        <div class="recent-type">CHEATSHEET</div>
        <h3>${escapeHtml(row.title || "Untitled")}</h3>
        <p>${escapeHtml(summarizeMaterialPreview(row))}</p>
        <div class="recent-footer">
          <span>${formatRelativeDate(row.created_at)}</span>
          <span>${row.study_set_id ? "Linked study set" : "Saved"}</span>
        </div>
        <div class="cheatsheet-card-actions">
          <button class="detail-button" type="button" data-action="open">Open</button>
          <button class="detail-button" type="button" data-action="quick">Quick revision</button>
          <button class="detail-button" type="button" data-action="rename">Rename</button>
          <button class="library-delete" type="button" data-action="delete">Delete</button>
        </div>
      `;

      article.querySelector('[data-action="open"]')?.addEventListener(
        "click",
        event => {
          event.stopPropagation();
          openCheatsheetView({ row });
        }
      );

      article.querySelector('[data-action="quick"]')?.addEventListener(
        "click",
        event => {
          event.stopPropagation();
          openCheatsheetView({ row, quickRevision: true });
        }
      );

      article.querySelector('[data-action="rename"]')?.addEventListener(
        "click",
        event => {
          event.stopPropagation();
          renameCheatsheetRow(row);
        }
      );

      article.querySelector('[data-action="delete"]')?.addEventListener(
        "click",
        event => {
          event.stopPropagation();
          deleteCheatsheetRow(row);
        }
      );

      article.addEventListener("click", () => {
        openCheatsheetView({ row });
      });

      grid.appendChild(article);

    });

  }


  async function generateCheatsheetFromSelection() {

    if (cheatsheetGenerateInFlight) {
      return;
    }

    const setId = cheatsheetStudySetSelect?.value;
    const sets = getStudySets();
    let studySet = sets.find(set => set.id === setId);

    if (!studySet && currentExtraction?.sourceText) {
      studySet = {
        id: null,
        title: currentExtraction.title,
        subject: currentExtraction.subject,
        sourceText: currentExtraction.sourceText,
        keyConcepts: currentExtraction.keyConcepts,
        definitions: currentExtraction.definitions,
        formulas: currentExtraction.formulas,
        keyTakeaways: currentExtraction.keyTakeaways,
        extractedContent: currentExtraction.extractedContent
      };
    }

    if (!studySet) {
      setCheatsheetGeneratorBanner(
        "Select a saved study set or extract notes first.",
        true
      );
      return;
    }

    const notes = studySetNotesForCheatsheet(studySet);

    if (notes.length < 10) {
      setCheatsheetGeneratorBanner(
        "This study set does not have enough note content. Add source notes or re-extract.",
        true
      );
      return;
    }

    const profile = getAuthSession();

    if (!profile?.id) {
      showToast("Sign in to generate AI cheatsheets.");
      return;
    }

    if (!window.aceSupabase) {
      showToast("Supabase is not available. Refresh and sign in again.");
      return;
    }

    const sessionResult = await window.aceSupabase.auth.getSession();
    const accessToken = sessionResult?.data?.session?.access_token;

    if (!accessToken) {
      showToast("Your session expired. Please sign in again.");
      return;
    }

    cheatsheetGenerateInFlight = true;
    setCheatsheetGeneratorBanner("");
    setCheatsheetLoading(true);

    try {

      const response = await fetch(
        `${getAceApiBaseUrl()}/api/generate-cheatsheet`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            notes,
            title: studySet.title,
            subject: studySet.subject
          })
        }
      );

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = formatApiErrorDetail(payload.detail);
        throw new Error(message);
      }

      const wrapped = wrapCheatsheetContent(payload);
      const draftTitle = `${studySet.title || wrapped.title} — Cheatsheet`;

      openCheatsheetView({
        draft: wrapped,
        studySetId: studySet.id || null,
        isDirty: true,
        row: {
          title: draftTitle,
          study_set_id: studySet.id || null
        }
      });

      showToast("Cheatsheet generated. Review and save when ready.");

    } catch (error) {

      const message =
        error instanceof Error
          ? error.message
          : "Cheatsheet generation failed.";

      setCheatsheetGeneratorBanner(message, true);
      showToast(message);

    } finally {

      cheatsheetGenerateInFlight = false;
      setCheatsheetLoading(false);

    }

  }


  function renderGeneratedMaterialViews() {

    if (
      !window.AceDB ||
      typeof window.AceDB.getMaterialsByType !== "function"
    ) {
      return;
    }

    renderCheatsheetsGrid();
    populateCheatsheetStudySetSelect();

    if (window.AceQuiz && typeof window.AceQuiz.renderQuizzesGrid === "function") {
      window.AceQuiz.renderQuizzesGrid();
    }

    if (
      window.AceFlashcards &&
      typeof window.AceFlashcards.renderFlashcardsGrid === "function"
    ) {
      window.AceFlashcards.renderFlashcardsGrid();
      window.AceFlashcards.renderFlashcardActivity?.();
    }

    if (
      window.AceFormulaSheets &&
      typeof window.AceFormulaSheets.renderFormulaSheetsGrid === "function"
    ) {
      window.AceFormulaSheets.renderFormulaSheetsGrid();
    }

  }


  function createStudySetCard(set, options = {}) {

    const article = document.createElement("article");

    article.className = options.library
      ? "recent-card library-card"
      : "recent-card";

    article.innerHTML = `
      <div class="recent-type">STUDY SET</div>
      <h3>${escapeHtml(set.title)}</h3>
      <p>${escapeHtml(
        set.concepts[0] ||
          "Saved study content."
      )}</p>
      <div class="recent-footer">
        <span>${formatRelativeDate(set.createdAt)}</span>
        <span>${set.concepts.length} concepts</span>
      </div>
    `;

    if (options.library) {

      const deleteBtn = document.createElement("button");

      deleteBtn.type = "button";
      deleteBtn.className = "library-delete";
      deleteBtn.textContent = "Delete";
      deleteBtn.setAttribute(
        "aria-label",
        `Delete ${set.title}`
      );

      deleteBtn.addEventListener("click", async event => {

        event.stopPropagation();

        const profile = getAuthSession();

        if (
          profile?.id &&
          window.AceDB &&
          typeof window.AceDB.deleteStudySet === "function" &&
          set.remote
        ) {

          const result = await window.AceDB.deleteStudySet(
            profile.id,
            set.id
          );

          if (result.error) {

            showToast(
              result.error.message ||
                "Could not delete study set from cloud."
            );

            return;

          }

          await window.AceDB.refreshMaterialsCache(profile.id);

        }

        const next = getStudySets().filter(
          item => item.id !== set.id
        );

        setStudySets(next);

        showToast("Study set removed from library.");

      });

      article.appendChild(deleteBtn);

    }

    article.addEventListener("click", () => {

      currentExtraction = studySetToExtraction(set);

      renderResults(currentExtraction, { fromAi: true });
      showPage("results");

    });

    return article;

  }


  function escapeHtml(value) {

    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  }


  function renderSectionEmpty(message) {

    const empty = document.createElement("div");

    empty.className = "extract-section-empty";
    empty.textContent = message;

    return empty;

  }

  function renderResults(extraction, options = {}) {

    const banner = document.getElementById("resultsBanner");
    const meta = document.getElementById("resultsMeta");
    const titleEl = document.getElementById("resultsTitle");
    const summaryEl = document.getElementById("resultsSummary");
    const sectionsEl = document.getElementById("resultsSections");
    const actions = document.getElementById("resultsActions");

    if (!extractionHasContent(extraction)) {

      if (banner) {
        banner.textContent =
          "Run an extraction to see study material here.";
        banner.classList.remove("ace-hidden");
      }

      meta?.classList.add("ace-hidden");
      actions?.classList.add("ace-hidden");
      sectionsEl?.classList.add("ace-hidden");

      if (sectionsEl) {
        sectionsEl.innerHTML = "";
      }

      return;

    }

    if (banner) {

      banner.textContent = options.fromAi
        ? "AI study material ready. Review each section, then save to your library."
        : "Review your study material, then save to your library.";

      banner.classList.remove("ace-hidden");

    }

    meta?.classList.remove("ace-hidden");
    actions?.classList.remove("ace-hidden");
    sectionsEl?.classList.remove("ace-hidden");

    if (titleEl) {
      titleEl.textContent = extraction.title;
    }

    const keyConcepts = extraction.keyConcepts || [];
    const definitions = extraction.definitions || [];
    const formulas = extraction.formulas || [];
    const keyTakeaways = extraction.keyTakeaways || [];

    if (summaryEl) {

      const parts = [];

      if (keyConcepts.length) {
        parts.push(`${keyConcepts.length} key concepts`);
      }

      if (definitions.length) {
        parts.push(`${definitions.length} definitions`);
      }

      if (formulas.length) {
        parts.push(`${formulas.length} formulas`);
      }

      if (keyTakeaways.length) {
        parts.push(`${keyTakeaways.length} takeaways`);
      }

      summaryEl.textContent = parts.length
        ? parts.join(" · ")
        : `${extraction.concepts.length} items ready to save.`;

    }

    if (!sectionsEl) {
      return;
    }

    sectionsEl.innerHTML = "";

    function appendSection(title, count, bodyNode) {

      const section = document.createElement("section");

      section.className = "extract-section";

      const head = document.createElement("div");

      head.className = "extract-section-head";
      head.innerHTML = `
        <h4>${escapeHtml(title)}</h4>
        <span class="extract-section-count">${count} item${count === 1 ? "" : "s"}</span>
      `;

      section.appendChild(head);
      section.appendChild(bodyNode);
      sectionsEl.appendChild(section);

    }

    const keyConceptsBody = document.createElement("div");

    if (keyConcepts.length) {

      keyConceptsBody.className = "extract-card-grid";

      keyConcepts.forEach(concept => {

        const card = document.createElement("article");

        card.className = "extract-card";
        card.innerHTML = `
          <h5>${escapeHtml(concept.title || "Concept")}</h5>
          <p>${escapeHtml(concept.explanation || "")}</p>
          ${concept.example
            ? `<span class="extract-card-label">Example</span><p>${escapeHtml(concept.example)}</p>`
            : ""}
        `;

        keyConceptsBody.appendChild(card);

      });

    } else {

      keyConceptsBody.appendChild(
        renderSectionEmpty("No key concepts were extracted for this set.")
      );

    }

    appendSection("Key concepts", keyConcepts.length, keyConceptsBody);

    const definitionsBody = document.createElement("div");

    if (definitions.length) {

      definitionsBody.className = "extract-card-grid";

      definitions.forEach(def => {

        const card = document.createElement("article");

        card.className = "extract-card";
        card.innerHTML = `
          <h5>${escapeHtml(def.term || "Term")}</h5>
          <p>${escapeHtml(def.definition || "")}</p>
        `;

        definitionsBody.appendChild(card);

      });

    } else {

      definitionsBody.appendChild(
        renderSectionEmpty("No definitions were found in your notes.")
      );

    }

    appendSection("Definitions", definitions.length, definitionsBody);

    const formulasBody = document.createElement("div");

    if (formulas.length) {

      formulasBody.className = "extract-formula-grid";

      formulas.forEach(formula => {

        const card = document.createElement("article");

        card.className = "extract-formula-card";
        card.innerHTML = `
          <div class="extract-formula-expression">${escapeHtml(formula.formula || "")}</div>
          <p>${escapeHtml(formula.meaning || "")}</p>
          ${formula.variables
            ? `<p><strong>Variables:</strong> ${escapeHtml(formula.variables)}</p>`
            : ""}
          ${formula.example
            ? `<p><strong>Example:</strong> ${escapeHtml(formula.example)}</p>`
            : ""}
        `;

        formulasBody.appendChild(card);

      });

    } else {

      formulasBody.appendChild(
        renderSectionEmpty("No formulas were found in your notes.")
      );

    }

    appendSection("Formula sheet", formulas.length, formulasBody);

    const takeawaysBody = document.createElement("div");

    if (keyTakeaways.length) {

      const list = document.createElement("ul");

      list.className = "takeaway-list";

      keyTakeaways.forEach(point => {

        const item = document.createElement("li");

        item.className = "takeaway-item";
        item.textContent = point;

        list.appendChild(item);

      });

      takeawaysBody.appendChild(list);

    } else {

      takeawaysBody.appendChild(
        renderSectionEmpty("No key takeaways were generated for this set.")
      );

    }

    appendSection("Key takeaways", keyTakeaways.length, takeawaysBody);

  }


  async function runExtraction() {

    if (extractionInFlight) {
      return;
    }

    const notes =
      extractNotesInput?.value.trim() || "";

    if (!notes) {

      showToast("Paste study notes to extract content.");
      extractNotesInput?.focus();

      return;

    }

    if (notes.length < 10) {

      showToast("Add a bit more detail to your notes before extracting.");

      return;

    }

    const title =
      extractTitleInput?.value.trim() ||
      null;

    extractionInFlight = true;
    setExtractLoadingUi(true);

    let extractionErrorMessage = null;

    try {

      if (
        !window.aceSupabase ||
        !window.aceSupabase.auth ||
        typeof window.aceSupabase.auth.getSession !== "function"
      ) {

        extractionErrorMessage =
          "Supabase is not available. Refresh the page and sign in again.";

        return;

      }

      const sessionResult =
        await window.aceSupabase.auth.getSession();

      if (sessionResult.error) {

        extractionErrorMessage =
          sessionResult.error.message ||
          "Could not read your session. Sign in again.";

        return;

      }

      const accessToken =
        sessionResult.data?.session?.access_token;

      if (!accessToken) {

        extractionErrorMessage =
          "Your session expired. Please sign in again.";

        return;

      }

      const response = await fetch(
        `${getAceApiBaseUrl()}/api/extract`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            title,
            notes,
            subject: null,
            difficulty: null
          })
        }
      );

      let payload = null;

      try {
        payload = await response.json();
      } catch {

        payload = null;

      }

      if (!response.ok) {

        extractionErrorMessage = formatApiErrorDetail(payload?.detail);

        return;

      }

      currentExtraction = mapApiExtractionPayload(payload, notes);

      if (!extractionHasContent(currentExtraction)) {

        extractionErrorMessage =
          "The API returned no study material. Try again with clearer notes.";

        return;

      }

      sessionStorage.setItem(
        ACE_LAST_EXTRACTION_KEY,
        JSON.stringify(currentExtraction)
      );

      hideExtractionErrorPanel();
      updateExtractBanners(true);
      renderResults(currentExtraction, { fromAi: true });
      showPage("results");

    } catch (error) {

      const offline =
        error && error.message === "Failed to fetch";

      extractionErrorMessage = offline
        ? `Cannot reach the Ace API at ${getAceApiBaseUrl()}. ` +
          `Confirm the backend is on port 8081 and CORS allows ${window.location.origin}.`
        : (error && error.message) ||
            "Extraction failed. Please try again.";

    } finally {

      extractionInFlight = false;
      setExtractLoadingUi(false);

      if (extractionErrorMessage) {
        showExtractionErrorPanel(extractionErrorMessage);
        showToast(extractionErrorMessage);
      }

    }

  }


  async function saveCurrentStudySet() {

    if (!extractionHasContent(currentExtraction)) {

      showToast("Nothing to save yet — run an extraction first.");

      return;

    }

    const profile = getAuthSession();
    const sets = getStudySets();

    const payload = {
      title: currentExtraction.title,
      concepts: [...(currentExtraction.concepts || [])],
      sourceText: currentExtraction.sourceText,
      subject: currentExtraction.subject || null,
      difficulty: currentExtraction.difficulty || null,
      keyConcepts: currentExtraction.keyConcepts || [],
      definitions: currentExtraction.definitions || [],
      formulas: currentExtraction.formulas || [],
      keyTakeaways: currentExtraction.keyTakeaways || [],
      extractedContent:
        currentExtraction.extractedContent ||
        buildExtractedContentSnapshot(currentExtraction),
      createdAt: new Date().toISOString()
    };

    const existingRemote = sets.find(
      set =>
        set.remote &&
        set.title === payload.title &&
        set.id &&
        String(set.id).indexOf("set_") !== 0
    );

    if (
      existingRemote &&
      profile?.id &&
      window.AceDB &&
      typeof window.AceDB.retryGeneratedMaterialsSync === "function"
    ) {

      const syncResult = await window.AceDB.retryGeneratedMaterialsSync(
        profile.id,
        existingRemote.id,
        payload
      );

      if (syncResult.error) {

        const syncMessage =
          window.AceDB?.formatUserFacingMaterialsSyncError
            ? window.AceDB.formatUserFacingMaterialsSyncError(syncResult.error)
            : "Some study materials could not be synced.";

        showToast(syncMessage);
        return;

      }

      if (!syncResult.skipped) {
        renderGeneratedMaterialViews();
      }

      showToast("Study set already saved!");
      return;

    }

    if (
      profile?.id &&
      window.AceDB &&
      typeof window.AceDB.insertStudySet === "function"
    ) {

      const result = await window.AceDB.insertStudySet(
        profile.id,
        payload
      );

      if (result.error && !result.data) {

        const saveMessage =
          window.AceDB?.formatDbError
            ? window.AceDB.formatDbError(result.error).message
            : result.error.message;

        showToast(saveMessage || "Could not save study set to Supabase.");

        return;

      }

      const existingIndex = sets.findIndex(
        set => set.id === result.data.id
      );

      if (existingIndex >= 0) {
        sets[existingIndex] = result.data;
      } else {
        sets.unshift(result.data);
      }

      setStudySets(sets);

      if (result.partial) {

        showToast(
          result.userMessage ||
            "Study set saved! Some materials could not be synced."
        );

        return;

      }

      renderGeneratedMaterialViews();

      if (result.alreadyExists) {
        showToast("Study set already saved!");
        return;
      }

      showToast("Study set saved!");

      return;

    }

    sets.unshift({
      id: `set_${Date.now()}`,
      ...payload
    });

    setStudySets(sets, { persistLocal: true });

    showToast("Study set saved to your library.");

  }


  /* --------------------------------------------
     PAGE NAVIGATION
     -------------------------------------------- */

  function showPage(pageName) {

    pages.forEach(page => {
      page.classList.remove("active-page");
    });

    const target = document.getElementById(pageName);

    if (target) {
      target.classList.add("active-page");
    }

    navItems.forEach(item => {

      item.classList.toggle(
        "active",
        item.dataset.page === pageName
      );

    });

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });

    if (pageName === "library") {
      renderStudySetViews();
    }

    if (pageName === "cheatsheets") {
      populateCheatsheetStudySetSelect();
      renderCheatsheetsGrid();
    }

    if (pageName === "quizzes") {
      window.AceQuiz?.populateQuizStudySetSelect?.();
      window.AceQuiz?.renderQuizzesGrid?.();
      window.AceQuiz?.renderQuizAttempts?.();
    }

    if (pageName === "flashcards") {
      window.AceFlashcards?.populateFlashcardStudySetSelect?.();
      window.AceFlashcards?.renderFlashcardsGrid?.();
      window.AceFlashcards?.renderFlashcardActivity?.();
    }

    if (pageName === "formula-sheets") {
      window.AceFormulaSheets?.populateFormulaStudySetSelect?.();
      window.AceFormulaSheets?.renderFormulaSheetsGrid?.();
    }

    if (
      pageName === "cheatsheets" ||
      pageName === "quizzes" ||
      pageName === "flashcards" ||
      pageName === "formula-sheets"
    ) {
      renderGeneratedMaterialViews();
    }

  }

  window.showPage = showPage;

  window.openStudySetResults = function (linked) {

    currentExtraction = studySetToExtraction(linked);
    renderResults(currentExtraction, { fromAi: true });
    showPage("results");

  };

  window.renderQuizAttempts = function () {

    if (window.AceQuiz && typeof window.AceQuiz.renderQuizAttempts === "function") {
      window.AceQuiz.renderQuizAttempts();
    }

  };


  navItems.forEach(item => {

    item.addEventListener("click", () => {

      showPage(item.dataset.page);

    });

  });


  function focusHomeExtractor() {

    setTimeout(() => {
      extractNotesInput?.focus();
    }, 350);

  }


  runExtractBtn?.addEventListener("click", runExtraction);

  document
    .getElementById("extractionRetryBtn")
    ?.addEventListener("click", () => {

      hideExtractionErrorPanel();
      runExtraction();

    });

  extractNotesInput?.addEventListener("keydown", event => {

    if (extractionInFlight) {
      return;
    }

    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey)
    ) {

      event.preventDefault();
      runExtraction();

    }

  });


  saveStudySetBtn?.addEventListener("click", saveCurrentStudySet);

  generateCheatsheetBtn?.addEventListener(
    "click",
    generateCheatsheetFromSelection
  );

  cheatsheetGoExtractBtn?.addEventListener("click", () => {
    showPage("home");
    focusHomeExtractor();
  });

  cheatsheetBackBtn?.addEventListener("click", () => {
    showPage("cheatsheets");
  });

  cheatsheetSaveBtn?.addEventListener("click", saveCheatsheetFromView);

  cheatsheetQuickRevBtn?.addEventListener("click", () => {
    cheatsheetViewState.quickRevision = !cheatsheetViewState.quickRevision;
    renderCheatsheetReader();
  });

  document
    .getElementById("cheatsheetStudySetBtn")
    ?.addEventListener("click", () => {

      const setId =
        cheatsheetViewState.studySetId ||
        cheatsheetViewState.row?.study_set_id;

      if (!setId) {
        showToast("No linked study set for this cheatsheet.");
        return;
      }

      const linked = getStudySets().find(set => set.id === setId);

      if (!linked) {
        showToast("Study set not found in your library.");
        return;
      }

      currentExtraction = studySetToExtraction(linked);
      renderResults(currentExtraction, { fromAi: true });
      showPage("results");

    });

  document
    .getElementById("cheatsheetRenameBtn")
    ?.addEventListener("click", () => {

      const row = cheatsheetViewState.row || {
        title: getCheatsheetContentFromState()?.title
      };

      renameCheatsheetRow(row);

    });

  document
    .getElementById("cheatsheetDeleteBtn")
    ?.addEventListener("click", () => {

      if (cheatsheetViewState.row?.id) {
        deleteCheatsheetRow(cheatsheetViewState.row);
        return;
      }

      cheatsheetViewState = {
        row: null,
        draft: null,
        quickRevision: false,
        studySetId: null,
        isDirty: false
      };

      showPage("cheatsheets");
      showToast("Draft discarded.");

    });

  backToExtractorBtn?.addEventListener("click", () => {

    if (currentExtraction?.sourceText && extractNotesInput) {
      extractNotesInput.value = currentExtraction.sourceText;
    }

    if (currentExtraction?.title && extractTitleInput) {
      extractTitleInput.value = currentExtraction.title;
    }

    showPage("home");
    focusHomeExtractor();

  });


  extractAttachBtn?.addEventListener("click", () => {

    const input = document.createElement("input");

    input.type = "file";
    input.accept = ".txt,text/plain";

    input.addEventListener("change", () => {

      const file = input.files?.[0];

      if (!file) return;

      const reader = new FileReader();

      reader.onload = () => {

        if (extractNotesInput) {
          extractNotesInput.value = String(reader.result || "");
        }

        if (!extractTitleInput?.value.trim()) {

          const baseName = file.name.replace(/\.[^.]+$/, "");

          if (extractTitleInput) {
            extractTitleInput.value = baseName;
          }

        }

        showToast(`${file.name} loaded.`);

      };

      reader.readAsText(file);

    });

    input.click();

  });


  const librarySearch =
    document.getElementById("librarySearch");
  const librarySort =
    document.getElementById("librarySort");

  librarySearch?.addEventListener("input", renderStudySetViews);
  librarySort?.addEventListener("change", renderStudySetViews);


  /* --------------------------------------------
     SEARCH
     -------------------------------------------- */

  const searchBtn =
    document.getElementById("searchBtn");

  searchBtn?.addEventListener("click", () => {

    showPage("library");
    librarySearch?.focus();

  });


  /* --------------------------------------------
     NOTIFICATIONS
     -------------------------------------------- */

  const notificationBtn =
    document.getElementById("notificationBtn");

  notificationBtn?.addEventListener("click", () => {

    showToast("You're all caught up.");

  });


  /* --------------------------------------------
     UPGRADE
     -------------------------------------------- */

  const upgradeProBtn =
    document.getElementById("upgradeProBtn");

  upgradeProBtn?.addEventListener("click", () => {

    window.location.href = "pricing.html";

  });

  const upgradeBtn =
    document.getElementById("upgradeBtn");

  upgradeBtn?.addEventListener("click", () => {

    window.location.href = "pricing.html";

  });


  /* --------------------------------------------
     VIEW ALL
     -------------------------------------------- */

  /* --------------------------------------------
     PROFILE MENU
     -------------------------------------------- */

  const profileMenuBtn =
    document.getElementById("profileMenuBtn");
  const profileMenu =
    document.getElementById("profileMenu");
  const profileMenuSettings =
    document.getElementById("profileMenuSettings");
  const profileMenuSignIn =
    document.getElementById("profileMenuSignIn");
  const profileMenuLogout =
    document.getElementById("profileMenuLogout");

  function initialsFromName(name) {

    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!parts.length) {
      return "?";
    }

    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    return (
      parts[0][0] + parts[parts.length - 1][0]
    ).toUpperCase();

  }


  function updateProfileDisplays() {

    const session = getAuthSession();
    const isSignedIn = Boolean(session);

    const sidebarName =
      document.getElementById("sidebarProfileName");
    const sidebarSub =
      document.getElementById("sidebarProfileSub");
    const sidebarAvatar =
      document.getElementById("sidebarProfileAvatar");
    const menuName =
      document.getElementById("profileMenuName");
    const menuEmail =
      document.getElementById("profileMenuEmail");
    const settingsName =
      document.getElementById("settingsProfileName");
    const settingsEmail =
      document.getElementById("settingsProfileEmail");
    const settingsAvatar =
      document.getElementById("settingsProfileAvatar");

    if (isSignedIn) {

      const displayName =
        session.name || session.email.split("@")[0];

      sidebarName.textContent = displayName;
      sidebarSub.textContent = "Study workspace";
      sidebarAvatar.textContent =
        initialsFromName(displayName);
      menuName.textContent = displayName;
      menuEmail.textContent = session.email;
      settingsName.textContent = displayName;
      settingsEmail.textContent = session.email;
      settingsAvatar.textContent =
        initialsFromName(displayName);

      profileMenuSignIn?.classList.add("ace-hidden");
      profileMenuLogout?.classList.remove("ace-hidden");

    } else {

      sidebarName.textContent = "Guest";
      sidebarSub.textContent = "Not signed in";
      sidebarAvatar.textContent = "?";
      menuName.textContent = "Guest";
      menuEmail.textContent = "Not signed in";
      settingsName.textContent = "—";
      settingsEmail.textContent =
        "Sign in to connect an account.";
      settingsAvatar.textContent = "?";

      profileMenuSignIn?.classList.remove("ace-hidden");
      profileMenuLogout?.classList.add("ace-hidden");

    }

  }


  function closeProfileMenu() {

    profileMenu?.classList.add("ace-hidden");
    profileMenuBtn?.setAttribute("aria-expanded", "false");

  }


  function openProfileMenu() {

    profileMenu?.classList.remove("ace-hidden");
    profileMenuBtn?.setAttribute("aria-expanded", "true");
    profileMenuSettings?.focus();

  }


  profileMenuBtn?.addEventListener("click", event => {

    event.stopPropagation();

    const isOpen =
      profileMenuBtn.getAttribute("aria-expanded") === "true";

    if (isOpen) {
      closeProfileMenu();
    } else {
      openProfileMenu();
    }

  });


  profileMenuSettings?.addEventListener("click", () => {

    closeProfileMenu();

    document.querySelectorAll(".page").forEach(page => {
      page.classList.remove("active-page");
    });

    document.querySelectorAll(".nav-item").forEach(item => {
      item.classList.remove("active");
    });

    document
      .getElementById("settings")
      ?.classList.add("active-page");

  });


  profileMenuLogout?.addEventListener("click", async () => {

    closeProfileMenu();
    await clearAuthSession();
    window.location.href = "login.html";

  });


  document.addEventListener("click", event => {

    if (
      !profileMenu ||
      profileMenu.classList.contains("ace-hidden")
    ) {
      return;
    }

    const target = event.target;

    if (
      profileMenu.contains(target) ||
      profileMenuBtn?.contains(target)
    ) {
      return;
    }

    closeProfileMenu();

  });


  document.addEventListener("keydown", event => {

    if (event.key === "Escape") {
      closeProfileMenu();
    }

  });


  updateProfileDisplays();
  window.refreshAceProfileUI = updateProfileDisplays;


  /* --------------------------------------------
     BUTTON MICRO-INTERACTION
     -------------------------------------------- */

  document
    .querySelectorAll("button")
    .forEach(button => {

      button.addEventListener(
        "mousedown",
        () => {

          button.style.transform =
            "scale(.97)";

        }
      );

      button.addEventListener(
        "mouseup",
        () => {

          button.style.transform = "";

        }
      );

      button.addEventListener(
        "mouseleave",
        () => {

          button.style.transform = "";

        }
      );

    });


  /* --------------------------------------------
     FLOATING MOUSE PARALLAX
     -------------------------------------------- */

  const floatingCards =
    document.querySelectorAll(
      ".action-card, .recent-card"
    );

  document.addEventListener(
    "mousemove",
    event => {

      if (window.innerWidth < 900) return;

      const x =
        (event.clientX / window.innerWidth - .5);

      const y =
        (event.clientY / window.innerHeight - .5);

      floatingCards.forEach((card, index) => {

        const strength =
          (index % 3 + 1) * 1.2;

        card.style.setProperty(
          "--mx",
          `${x * strength}px`
        );

        card.style.setProperty(
          "--my",
          `${y * strength}px`
        );

      });

    }
  );


  /* --------------------------------------------
     INITIAL STATE
     -------------------------------------------- */

  try {

    const saved = sessionStorage.getItem(ACE_LAST_EXTRACTION_KEY);

    if (saved) {
      currentExtraction = JSON.parse(saved);
    }

  } catch {

    currentExtraction = null;

  }

  await hydrateAceDataFromSupabase();

  window.AceQuiz?.init?.();
  window.AceFlashcards?.init?.();
  window.AceFormulaSheets?.init?.();

  renderStudySetViews();
  renderGeneratedMaterialViews();
  window.AceQuiz?.renderQuizAttempts?.();
  renderResults(currentExtraction);
  showPage("home");

});


/* =========================================
   SETTINGS SUB-PAGE NAVIGATION
   ========================================= */

document.querySelectorAll(".settings-link").forEach(card => {

  card.addEventListener("click", () => {

    const targetId = card.dataset.settingsPage;

    document.querySelectorAll(".page").forEach(page => {
      page.classList.remove("active-page");
    });

    document.querySelectorAll(".nav-item").forEach(item => {
      item.classList.remove("active");
    });

    const targetPage =
      document.getElementById(targetId);

    if (targetPage) {
      targetPage.classList.add("active-page");
    }

  });

});


/* -----------------------------------------
   BACK TO SETTINGS
   ----------------------------------------- */

document
  .querySelectorAll("[data-back-settings]")
  .forEach(button => {

    button.addEventListener("click", () => {

      document.querySelectorAll(".page").forEach(page => {
        page.classList.remove("active-page");
      });

      document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.remove("active");
      });

      const settingsPage =
        document.getElementById("settings");

      if (settingsPage) {
        settingsPage.classList.add("active-page");
      }

    });

  });


/* =========================================
   APPEARANCE SETTINGS
   ========================================= */

const darkThemeToggle =
  document.getElementById("darkThemeToggle");

const glassToggle =
  document.getElementById("glassToggle");

const motionToggle =
  document.getElementById("motionToggle");


/* -----------------------------------------
   DARK / LIGHT THEME
   ----------------------------------------- */

if (darkThemeToggle) {

  darkThemeToggle.addEventListener("change", () => {

    document.body.classList.toggle(
      "light-dashboard",
      !darkThemeToggle.checked
    );

  });

}


/* -----------------------------------------
   GLASS EFFECT
   ----------------------------------------- */

if (glassToggle) {

  glassToggle.addEventListener("change", () => {

    document.body.classList.toggle(
      "no-glass",
      !glassToggle.checked
    );

  });

}


/* -----------------------------------------
   MOTION EFFECTS
   ----------------------------------------- */

if (motionToggle) {

  motionToggle.addEventListener("change", () => {

    document.body.classList.toggle(
      "no-motion",
      !motionToggle.checked
    );

  });

}

// ===============================
// EDIT PROFILE - WORKING VERSION
// ===============================

document.addEventListener("DOMContentLoaded", function () {

  const editProfileBtn = document.getElementById("editProfileBtn");

  if (!editProfileBtn) {
    console.error("Edit Profile button not found.");
    return;
  }

  editProfileBtn.addEventListener("click", function () {

    const session = getAuthSession();
    const defaultName = session?.name || "";
    const defaultEmail = session?.email || "";
    const defaultAbout =
      localStorage.getItem("aceProfileAbout") || "";

    // Remove existing modal if any
    const oldModal = document.getElementById("editProfileModal");
    if (oldModal) oldModal.remove();

    const modal = document.createElement("div");

    modal.id = "editProfileModal";

    modal.innerHTML = `
      <div style="
        position:fixed;
        inset:0;
        z-index:99999;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:20px;
        background:rgba(0,0,0,.65);
        backdrop-filter:blur(12px);
      ">

        <div style="
          width:100%;
          max-width:480px;
          background:#181b24;
          color:#f3f4f6;
          border:1px solid rgba(255,255,255,.12);
          border-radius:20px;
          padding:28px;
          box-shadow:0 30px 80px rgba(0,0,0,.45);
        ">

          <div style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            margin-bottom:24px;
          ">

            <h2 style="
              margin:0;
              font-size:22px;
              color:#fff;
            ">
              Edit Profile
            </h2>

            <button
              id="closeEditProfileModal"
              type="button"
              style="
                width:34px;
                height:34px;
                border:0;
                border-radius:10px;
                background:rgba(255,255,255,.08);
                color:#fff;
                font-size:22px;
                cursor:pointer;
              "
            >
              ×
            </button>

          </div>

          <div style="margin-bottom:18px;">
            <label style="
              display:block;
              margin-bottom:7px;
              font-size:13px;
              font-weight:600;
              color:#c7cad4;
            ">
              Full Name
            </label>

            <input
              id="editProfileName"
              type="text"
              value="${defaultName.replace(/"/g, "&quot;")}"
              style="
                width:100%;
                padding:12px 14px;
                border-radius:10px;
                border:1px solid rgba(255,255,255,.12);
                background:#0f1117;
                color:#fff;
                outline:none;
                box-sizing:border-box;
              "
            >
          </div>

          <div style="margin-bottom:18px;">
            <label style="
              display:block;
              margin-bottom:7px;
              font-size:13px;
              font-weight:600;
              color:#c7cad4;
            ">
              Email Address
            </label>

            <input
              id="editProfileEmail"
              type="email"
              value="${defaultEmail.replace(/"/g, "&quot;")}"
              style="
                width:100%;
                padding:12px 14px;
                border-radius:10px;
                border:1px solid rgba(255,255,255,.12);
                background:#0f1117;
                color:#fff;
                outline:none;
                box-sizing:border-box;
              "
            >
          </div>

          <div style="margin-bottom:24px;">
            <label style="
              display:block;
              margin-bottom:7px;
              font-size:13px;
              font-weight:600;
              color:#c7cad4;
            ">
              About
            </label>

            <textarea
              id="editProfileAbout"
              rows="4"
              placeholder="Tell us about yourself..."
              style="
                width:100%;
                padding:12px 14px;
                border-radius:10px;
                border:1px solid rgba(255,255,255,.12);
                background:#0f1117;
                color:#fff;
                outline:none;
                resize:vertical;
                box-sizing:border-box;
              "
            >${defaultAbout.replace(/</g, "&lt;")}</textarea>
          </div>

          <div style="
            display:flex;
            justify-content:flex-end;
            gap:10px;
          ">

            <button
              id="cancelEditProfile"
              type="button"
              style="
                padding:11px 18px;
                border-radius:10px;
                border:1px solid rgba(255,255,255,.12);
                background:rgba(255,255,255,.06);
                color:#fff;
                cursor:pointer;
              "
            >
              Cancel
            </button>

            <button
              id="saveEditProfile"
              type="button"
              style="
                padding:11px 20px;
                border-radius:10px;
                border:0;
                background:linear-gradient(135deg,#26384d,#4a6d8c);
                color:#fff;
                font-weight:600;
                cursor:pointer;
              "
            >
              Save Changes
            </button>

          </div>

        </div>

      </div>
    `;

    document.body.appendChild(modal);

    // Close button
    document
      .getElementById("closeEditProfileModal")
      .addEventListener("click", function () {
        modal.remove();
      });

    // Cancel button
    document
      .getElementById("cancelEditProfile")
      .addEventListener("click", function () {
        modal.remove();
      });

    // Save button
    document
      .getElementById("saveEditProfile")
      .addEventListener("click", async function () {

        const name =
          document.getElementById("editProfileName").value.trim();

        const email =
          document.getElementById("editProfileEmail").value.trim();

        const about =
          document.getElementById("editProfileAbout").value.trim();

        if (!name || !email) {
          alert("Please enter your name and email.");
          return;
        }

        if (
          window.AceAuth &&
          typeof window.AceAuth.updateProfile === "function"
        ) {

          const result = await window.AceAuth.updateProfile({
            name,
            email,
            about
          });

          if (result.error) {
            alert(window.AceAuth.formatAuthError(result.error));
            return;
          }

        } else {

          localStorage.setItem("aceProfileAbout", about);

        }

        if (typeof window.refreshAceProfileUI === "function") {
          window.refreshAceProfileUI();
        }

        alert("Profile updated successfully!");

        modal.remove();
      });

  });

});

// =====================================================
// PRIVACY & SECURITY ACTIONS
// =====================================================

document.addEventListener("DOMContentLoaded", function () {

  // -------------------------------
  // MANAGE DATA CONTROLS
  // -------------------------------

  const manageDataBtn =
    document.getElementById("manageDataBtn");

  if (manageDataBtn) {

    manageDataBtn.addEventListener("click", function () {

      const modal = document.createElement("div");

      modal.className = "settings-action-modal";

      modal.innerHTML = `
        <div class="settings-action-backdrop">

          <div class="settings-action-card">

            <button
              class="settings-action-close"
              type="button"
            >
              ×
            </button>

            <div class="settings-action-eyebrow">
              PRIVACY & SECURITY
            </div>

            <h2>Data Controls</h2>

            <p>
              Control how your conversations and workspace
              data are handled.
            </p>

            <div class="settings-option">
              <div>
                <strong>Conversation history</strong>
                <span>
                  Keep conversations available in your workspace.
                </span>
              </div>

              <label class="action-switch">
                <input type="checkbox" checked>
                <span></span>
              </label>
            </div>

            <div class="settings-option">
              <div>
                <strong>Improve AI responses</strong>
                <span>
                  Allow anonymized usage data to improve the experience.
                </span>
              </div>

              <label class="action-switch">
                <input type="checkbox" checked>
                <span></span>
              </label>
            </div>

            <div class="settings-option">
              <div>
                <strong>Personalized suggestions</strong>
                <span>
                  Use workspace activity to improve recommendations.
                </span>
              </div>

              <label class="action-switch">
                <input type="checkbox" checked>
                <span></span>
              </label>
            </div>

            <button
              class="settings-action-save"
              type="button"
            >
              Save Preferences
            </button>

          </div>

        </div>
      `;

      document.body.appendChild(modal);

      requestAnimationFrame(() => {
        modal.classList.add("visible");
      });

      const closeModal = () => {
        modal.classList.remove("visible");

        setTimeout(() => {
          modal.remove();
        }, 250);
      };

      modal
        .querySelector(".settings-action-close")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".settings-action-backdrop")
        .addEventListener("click", function (event) {

          if (event.target === this) {
            closeModal();
          }

        });

      modal
        .querySelector(".settings-action-save")
        .addEventListener("click", function () {

          closeModal();

          if (typeof showToast === "function") {
            showToast(
              "Data preferences updated successfully.",
              "success"
            );
          } else {
            alert("Data preferences updated successfully.");
          }

        });

    });

  }


  // -------------------------------
  // VIEW ACTIVE SESSIONS
  // -------------------------------

  const viewSessionsBtn =
    document.getElementById("viewSessionsBtn");

  if (viewSessionsBtn) {

    viewSessionsBtn.addEventListener("click", function () {

      const modal = document.createElement("div");

      modal.className = "settings-action-modal";

      modal.innerHTML = `
        <div class="settings-action-backdrop">

          <div class="settings-action-card">

            <button
              class="settings-action-close"
              type="button"
            >
              ×
            </button>

            <div class="settings-action-eyebrow">
              SECURITY
            </div>

            <h2>Active Sessions</h2>

            <p>
              Review devices currently signed into your account.
            </p>

            <div class="session-item">

              <div class="session-icon">
                ◉
              </div>

              <div class="session-info">
                <strong>Current browser</strong>
                <span>
                  Windows · Chrome · Current session
                </span>
              </div>

              <span class="session-current">
                Active
              </span>

            </div>

            <div class="session-item">

              <div class="session-icon">
                ◌
              </div>

              <div class="session-info">
                <strong>Desktop session</strong>
                <span>
                  Windows · Recently active
                </span>
              </div>

              <button
                class="session-revoke"
                type="button"
              >
                Revoke
              </button>

            </div>

            <button
              class="settings-action-save"
              type="button"
            >
              Done
            </button>

          </div>

        </div>
      `;

      document.body.appendChild(modal);

      requestAnimationFrame(() => {
        modal.classList.add("visible");
      });

      const closeModal = () => {
        modal.classList.remove("visible");

        setTimeout(() => {
          modal.remove();
        }, 250);
      };

      modal
        .querySelector(".settings-action-close")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".settings-action-save")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".settings-action-backdrop")
        .addEventListener("click", function (event) {

          if (event.target === this) {
            closeModal();
          }

        });

      const revokeBtn =
        modal.querySelector(".session-revoke");

      if (revokeBtn) {

        revokeBtn.addEventListener("click", function () {

          const session =
            revokeBtn.closest(".session-item");

          session.style.opacity = "0";
          session.style.transform = "translateX(20px)";

          setTimeout(() => {
            session.remove();
          }, 250);

          if (typeof showToast === "function") {
            showToast(
              "Session revoked.",
              "success"
            );
          }

        });

      }

    });

  }


  // -------------------------------
  // DELETE ACCOUNT
  // -------------------------------

  const deleteAccountBtn =
    document.getElementById("deleteAccountBtn");

  if (deleteAccountBtn) {

    deleteAccountBtn.addEventListener("click", function () {

      const modal = document.createElement("div");

      modal.className = "settings-action-modal";

      modal.innerHTML = `
        <div class="settings-action-backdrop">

          <div class="settings-action-card delete-card">

            <button
              class="settings-action-close"
              type="button"
            >
              ×
            </button>

            <div class="delete-warning">
              !
            </div>

            <div class="settings-action-eyebrow danger-text">
              DANGER ZONE
            </div>

            <h2>Delete your account?</h2>

            <p>
              This action will permanently remove your
              Ace account and workspace data.
            </p>

            <div class="delete-warning-box">
              <strong>This cannot be undone.</strong>
              <span>
                Your conversations, files and workspace
                information will be removed.
              </span>
            </div>

            <div class="delete-actions">

              <button
                class="delete-cancel"
                type="button"
              >
                Keep Account
              </button>

              <button
                class="delete-confirm"
                type="button"
              >
                Delete Account
              </button>

            </div>

          </div>

        </div>
      `;

      document.body.appendChild(modal);

      requestAnimationFrame(() => {
        modal.classList.add("visible");
      });

      const closeModal = () => {
        modal.classList.remove("visible");

        setTimeout(() => {
          modal.remove();
        }, 250);
      };

      modal
        .querySelector(".settings-action-close")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".delete-cancel")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".settings-action-backdrop")
        .addEventListener("click", function (event) {

          if (event.target === this) {
            closeModal();
          }

        });

      modal
        .querySelector(".delete-confirm")
        .addEventListener("click", function () {

          closeModal();

          if (typeof showToast === "function") {
            showToast(
              "Account deletion request submitted.",
              "success"
            );
          } else {
            alert("Account deletion request submitted.");
          }

        });

    });

  }

});

// =====================================================
// FILES & STORAGE ACTIONS
// =====================================================

document.addEventListener("DOMContentLoaded", function () {

  // ===================================================
  // VIEW UPLOADED FILES
  // ===================================================

  const viewFilesBtn =
    document.getElementById("viewFilesBtn");

  if (viewFilesBtn) {

    viewFilesBtn.addEventListener("click", function () {

      const modal = document.createElement("div");

      modal.className = "storage-action-modal";

      modal.innerHTML = `
        <div class="storage-action-backdrop">

          <div class="storage-action-card">

            <button
              type="button"
              class="storage-action-close"
            >
              ×
            </button>

            <div class="storage-eyebrow">
              FILES & STORAGE
            </div>

            <h2>Uploaded files.</h2>

            <p class="storage-description">
              View and manage documents and assets in your workspace.
            </p>

            <div class="storage-summary">
              <div>
                <strong>0 files</strong>
                <span>Cloud storage not connected</span>
              </div>

              <div class="storage-summary-bar">
                <span style="width: 0%"></span>
              </div>
            </div>

            <div class="uploaded-file-list storage-empty-list">
              <p>No uploaded files yet. Attach .txt notes during extraction on this device.</p>
            </div>

            <button
              type="button"
              class="storage-done-btn"
            >
              Done
            </button>

          </div>

        </div>
      `;

      document.body.appendChild(modal);

      requestAnimationFrame(() => {
        modal.classList.add("visible");
      });

      const closeModal = () => {

        modal.classList.remove("visible");

        setTimeout(() => {
          modal.remove();
        }, 280);

      };

      modal
        .querySelector(".storage-action-close")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".storage-done-btn")
        .addEventListener("click", closeModal);

      modal
        .querySelector(".storage-action-backdrop")
        .addEventListener("click", function (event) {

          if (event.target === this) {
            closeModal();
          }

        });

    });

  }


  // ===================================================
  // MANAGE FILE PREFERENCES
  // ===================================================

  const manageFilePreferencesBtn =
    document.getElementById("manageFilePreferencesBtn");

  if (manageFilePreferencesBtn) {

    manageFilePreferencesBtn.addEventListener(
      "click",
      function () {

        const modal = document.createElement("div");

        modal.className = "storage-action-modal";

        modal.innerHTML = `
          <div class="storage-action-backdrop">

            <div class="storage-action-card">

              <button
                type="button"
                class="storage-action-close"
              >
                ×
              </button>

              <div class="storage-eyebrow">
                FILES & STORAGE
              </div>

              <h2>File preferences.</h2>

              <p class="storage-description">
                Control how files are uploaded, stored and handled
                inside your workspace.
              </p>

              <div class="file-preference">

                <div>
                  <strong>Automatic file organization</strong>

                  <span>
                    Organize uploaded files by project automatically.
                  </span>
                </div>

                <label class="storage-switch">
                  <input
                    type="checkbox"
                    checked
                  >
                  <span></span>
                </label>

              </div>

              <div class="file-preference">

                <div>
                  <strong>Keep recent uploads</strong>

                  <span>
                    Keep recently uploaded files available for quick access.
                  </span>
                </div>

                <label class="storage-switch">
                  <input
                    type="checkbox"
                    checked
                  >
                  <span></span>
                </label>

              </div>

              <div class="file-preference">

                <div>
                  <strong>Compress large files</strong>

                  <span>
                    Automatically optimize large uploads to save storage.
                  </span>
                </div>

                <label class="storage-switch">
                  <input
                    type="checkbox"
                  >
                  <span></span>
                </label>

              </div>

              <button
                type="button"
                class="storage-save-btn"
              >
                Save Preferences
              </button>

            </div>

          </div>
        `;

        document.body.appendChild(modal);

        requestAnimationFrame(() => {
          modal.classList.add("visible");
        });

        const closeModal = () => {

          modal.classList.remove("visible");

          setTimeout(() => {
            modal.remove();
          }, 280);

        };

        modal
          .querySelector(".storage-action-close")
          .addEventListener("click", closeModal);

        modal
          .querySelector(".storage-action-backdrop")
          .addEventListener("click", function (event) {

            if (event.target === this) {
              closeModal();
            }

          });

        modal
          .querySelector(".storage-save-btn")
          .addEventListener("click", function () {

            closeModal();

            if (typeof showToast === "function") {

              showToast(
                "File preferences saved.",
                "success"
              );

            } else {

              alert("File preferences saved.");

            }

          });

      }
    );

  }

});