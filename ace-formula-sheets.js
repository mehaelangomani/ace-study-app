/* Ace — AI Formula Sheets */

(function (global) {
  "use strict";

  var formulaGenerateInFlight = false;
  var formulaSaveInFlight = false;
  var activeSheet = null;
  var gridSearchTerm = "";

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

  async function getAccessToken() {
    if (!global.aceSupabase?.auth?.getSession) {
      return null;
    }
    var sessionResult = await global.aceSupabase.auth.getSession();
    return sessionResult?.data?.session?.access_token || null;
  }

  function buildSheetFingerprint(studySetId, payload) {
    var firstExpr = "";
    var cats = payload.categories || [];
    if (cats[0]?.formulas?.[0]) {
      firstExpr = cats[0].formulas[0].expression || "";
    }
    return [
      studySetId || "draft",
      payload.formula_count || 0,
      payload.title || "",
      firstExpr.slice(0, 48)
    ].join("|");
  }

  function buildMaterialContent(payload, fingerprint) {
    return {
      schema: "ai_formula_sheet_v1",
      version: 1,
      title: payload.title,
      subject: payload.subject,
      overview: payload.overview,
      categories: payload.categories,
      quick_reference: payload.quick_reference,
      formula_count: payload.formula_count,
      sheet_fingerprint: fingerprint
    };
  }

  function setFormulaBanner(message, isError) {
    var banner = document.getElementById("formulaGeneratorBanner");
    var retry = document.getElementById("formulaRetryBtn");
    if (!banner) {
      return;
    }
    if (!message) {
      banner.classList.add("ace-hidden");
      banner.textContent = "";
      retry?.classList.add("ace-hidden");
      return;
    }
    banner.textContent = message;
    banner.classList.remove("ace-hidden");
    banner.classList.toggle("is-error", Boolean(isError));
    retry?.classList.toggle("ace-hidden", !isError);
  }

  function setFormulaLoading(active) {
    var panel = document.getElementById("formulaLoadingPanel");
    var btn = document.getElementById("generateFormulaSheetBtn");
    var card = document.querySelector(".formula-generator-card");
    panel?.classList.toggle("ace-hidden", !active);
    panel?.setAttribute("aria-busy", active ? "true" : "false");
    card?.classList.toggle("is-extracting", active);
    btn?.toggleAttribute("disabled", active);
    if (btn) {
      btn.textContent = active ? "Generating…" : "Generate Formula Sheet";
    }
  }

  function populateFormulaStudySetSelect() {
    var select = document.getElementById("formulaStudySetSelect");
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

  function renderMath(element, expression) {
    if (!element) {
      return;
    }
    var text = String(expression || "");
    element.textContent = text;
    if (global.katex && text.indexOf("\\") >= 0) {
      try {
        global.katex.render(text, element, {
          throwOnError: false,
          displayMode: true
        });
      } catch (error) {
        element.textContent = text;
      }
    }
  }

  function copyText(text, toastMessage) {
    var value = String(text || "");
    if (!value) {
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        global.showToast?.(toastMessage || "Copied!");
      });
      return;
    }
    global.showToast?.("Copy is not supported in this browser.");
  }

  function countFormulasInContent(content) {
    if (!content) {
      return 0;
    }
    if (content.formula_count) {
      return content.formula_count;
    }
    var total = 0;
    (content.categories || []).forEach(function (cat) {
      total += (cat.formulas || []).length;
    });
    return total;
  }

  function updateSaveSheetUi() {
    var status = document.getElementById("formulaSaveStatus");
    var btn = document.getElementById("formulaSaveSheetBtn");
    var saved = Boolean(activeSheet?.materialId);
    if (status) {
      status.textContent = saved
        ? "Saved to your library"
        : "Not saved yet — use Save Formula Sheet";
    }
    if (btn) {
      btn.textContent = saved ? "Formula sheet saved" : "Save Formula Sheet";
      btn.toggleAttribute("disabled", saved);
    }
  }

  async function saveSheetExplicitly() {
    if (formulaSaveInFlight || !activeSheet) {
      return;
    }
    var profile = getProfile();
    if (!profile?.id) {
      global.showToast?.("Sign in to save formula sheets.");
      return;
    }
    if (activeSheet.materialId) {
      global.showToast?.("Formula sheet already saved!");
      updateSaveSheetUi();
      return;
    }
    if (!global.AceDB?.saveFormulaSheet) {
      global.showToast?.("Database helpers are unavailable.");
      return;
    }

    formulaSaveInFlight = true;
    try {
      var studySet = activeSheet.studySet || {};
      var saveResult = await global.AceDB.saveFormulaSheet(profile.id, {
        study_set_id: studySet.id || activeSheet.studySetId,
        material_type: global.AceDB.MATERIAL_TYPES.formula_sheet,
        title: (activeSheet.title || studySet.title || "Formula sheet") + " — Formulas",
        content: activeSheet.content,
        existing_material_id: activeSheet.materialId
      });

      if (saveResult.error) {
        var message = global.AceDB.formatUserFacingSaveError
          ? global.AceDB.formatUserFacingSaveError(saveResult.error, "Formula sheet")
          : "Formula sheet could not be saved.";
        global.showToast?.(message);
        return;
      }

      global.showToast?.(
        saveResult.alreadySaved ? "Formula sheet already saved!" : "Formula sheet saved!"
      );
      activeSheet.materialId = saveResult.data?.id || null;
      await global.AceDB.refreshMaterialsCache?.(profile.id);
      global.renderGeneratedMaterialViews?.();
      renderFormulaSheetsGrid();
      updateSaveSheetUi();
    } finally {
      formulaSaveInFlight = false;
    }
  }

  async function deleteSavedSheet() {
    if (!activeSheet?.materialId) {
      global.showToast?.("Nothing to delete — save the sheet first.");
      return;
    }
    if (!window.confirm("Delete this formula sheet from your library?")) {
      return;
    }
    var profile = getProfile();
    if (!profile?.id || !global.AceDB?.deleteGeneratedMaterial) {
      return;
    }
    var result = await global.AceDB.deleteGeneratedMaterial(
      profile.id,
      activeSheet.materialId
    );
    if (result.error) {
      global.showToast?.("Could not delete formula sheet.");
      return;
    }
    global.showToast?.("Formula sheet deleted.");
    activeSheet.materialId = null;
    await global.AceDB.refreshMaterialsCache?.(profile.id);
    renderFormulaSheetsGrid();
    updateSaveSheetUi();
  }

  function formulaMatchesSearch(formula, term) {
    if (!term) {
      return true;
    }
    var haystack = [
      formula.name,
      formula.expression,
      formula.description,
      formula.source_concept,
      formula.conditions
    ]
      .concat((formula.variables || []).map(function (v) {
        return v.symbol + " " + v.meaning;
      }))
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(term) >= 0;
  }

  function renderFormulaReader() {
    if (!activeSheet) {
      return;
    }

    var content = activeSheet.content;
    var searchInput = document.getElementById("formulaViewSearch");
    var categorySelect = document.getElementById("formulaCategoryFilter");
    var term = (searchInput?.value || "").trim().toLowerCase();
    var categoryFilter = categorySelect?.value || "";

    var titleEl = document.getElementById("formulaViewTitle");
    if (titleEl) {
      titleEl.textContent = content.title || activeSheet.title || "Formula sheet";
    }
    var meta = document.getElementById("formulaViewMeta");
    if (meta) {
      var parts = [];
      if (content.subject) {
        parts.push(content.subject);
      }
      parts.push(countFormulasInContent(content) + " formula(s)");
      if (activeSheet.studySetTitle) {
        parts.push("From: " + activeSheet.studySetTitle);
      }
      meta.textContent = parts.join(" · ");
    }

    var overviewCard = document.getElementById("formulaOverviewCard");
    if (overviewCard) {
      if (content.overview) {
        overviewCard.classList.remove("ace-hidden");
        overviewCard.innerHTML =
          "<h3>Overview</h3><p>" + escapeHtml(content.overview) + "</p>";
      } else {
        overviewCard.classList.add("ace-hidden");
      }
    }

    var quickRef = document.getElementById("formulaQuickRef");
    if (quickRef) {
      var items = content.quick_reference || [];
      if (items.length) {
        quickRef.classList.remove("ace-hidden");
        quickRef.innerHTML = "<h3>Quick reference</h3>";
        var list = document.createElement("ul");
        list.className = "formula-quick-list";
        items.forEach(function (item) {
          var li = document.createElement("li");
          li.innerHTML =
            "<strong>" +
            escapeHtml(item.name) +
            "</strong> — <span class=\"formula-math-inline\"></span>";
          if (item.usage) {
            li.innerHTML += "<br><span class=\"formula-quick-usage\">" +
              escapeHtml(item.usage) +
              "</span>";
          }
          list.appendChild(li);
          renderMath(li.querySelector(".formula-math-inline"), item.expression);
        });
        quickRef.appendChild(list);
      } else {
        quickRef.classList.add("ace-hidden");
        quickRef.innerHTML = "";
      }
    }

    if (categorySelect && categorySelect.options.length <= 1) {
      categorySelect.innerHTML = '<option value="">All categories</option>';
      (content.categories || []).forEach(function (cat) {
        var opt = document.createElement("option");
        opt.value = cat.name;
        opt.textContent = cat.name;
        categorySelect.appendChild(opt);
      });
    }

    var reader = document.getElementById("formulaSheetReader");
    if (!reader) {
      return;
    }
    reader.innerHTML = "";

    (content.categories || []).forEach(function (category) {
      if (categoryFilter && category.name !== categoryFilter) {
        return;
      }

      var visible = (category.formulas || []).filter(function (formula) {
        return formulaMatchesSearch(formula, term);
      });

      if (!visible.length) {
        return;
      }

      var section = document.createElement("section");
      section.className = "formula-category-section composer-card";
      section.innerHTML =
        "<h3>" + escapeHtml(category.name) + "</h3>";

      visible.forEach(function (formula) {
        var card = document.createElement("article");
        card.className = "formula-item-card";
        card.dataset.formulaId = formula.id;

        card.innerHTML =
          '<div class="formula-item-head">' +
          "<h4>" +
          escapeHtml(formula.name) +
          "</h4>" +
          '<div class="formula-item-actions">' +
          '<button type="button" class="detail-button" data-action="copy-expr">Copy formula</button>' +
          '<button type="button" class="detail-button" data-action="copy-full">Copy with explanation</button>' +
          '<button type="button" class="detail-button" data-action="toggle">Details</button>' +
          "</div></div>" +
          '<div class="cheatsheet-formula-expression formula-math-block"></div>' +
          '<p class="formula-description">' +
          escapeHtml(formula.description) +
          "</p>" +
          '<div class="formula-details ace-hidden"></div>';

        renderMath(
          card.querySelector(".formula-math-block"),
          formula.expression
        );

        var details = card.querySelector(".formula-details");
        var detailsHtml = "";

        if (formula.variables?.length) {
          detailsHtml += "<h5>Variables</h5><ul>";
          formula.variables.forEach(function (variable) {
            detailsHtml +=
              "<li><strong>" +
              escapeHtml(variable.symbol) +
              "</strong> — " +
              escapeHtml(variable.meaning) +
              (variable.unit
                ? " (" + escapeHtml(variable.unit) + ")"
                : "") +
              "</li>";
          });
          detailsHtml += "</ul>";
        }

        if (formula.conditions) {
          detailsHtml +=
            "<h5>Conditions</h5><p>" +
            escapeHtml(formula.conditions) +
            "</p>";
        }

        if (formula.example) {
          detailsHtml += "<h5>Example</h5>";
          if (formula.example.problem) {
            detailsHtml +=
              "<p>" + escapeHtml(formula.example.problem) + "</p>";
          }
          if (formula.example.steps?.length) {
            detailsHtml += "<ol>";
            formula.example.steps.forEach(function (step) {
              detailsHtml += "<li>" + escapeHtml(step) + "</li>";
            });
            detailsHtml += "</ol>";
          }
          if (formula.example.answer) {
            detailsHtml +=
              "<p><strong>Answer:</strong> " +
              escapeHtml(formula.example.answer) +
              "</p>";
          }
        }

        if (formula.source_concept) {
          detailsHtml +=
            '<p class="formula-source"><span class="cheatsheet-label">Source</span> ' +
            escapeHtml(formula.source_concept) +
            "</p>";
        }

        details.innerHTML = detailsHtml;

        card.querySelector('[data-action="copy-expr"]')?.addEventListener(
          "click",
          function () {
            copyText(formula.expression, "Formula copied!");
          }
        );

        card.querySelector('[data-action="copy-full"]')?.addEventListener(
          "click",
          function () {
            var block =
              formula.name +
              "\n" +
              formula.expression +
              "\n\n" +
              formula.description;
            copyText(block, "Formula and explanation copied!");
          }
        );

        card.querySelector('[data-action="toggle"]')?.addEventListener(
          "click",
          function (event) {
            var btn = event.currentTarget;
            details.classList.toggle("ace-hidden");
            btn.textContent = details.classList.contains("ace-hidden")
              ? "Details"
              : "Hide details";
          }
        );

        section.appendChild(card);
      });

      reader.appendChild(section);
    });

    if (!reader.children.length) {
      reader.innerHTML =
        '<div class="empty-card"><p>No formulas match your search.</p></div>';
    }

    updateSaveSheetUi();
  }

  function openFormulaSheetView(options) {
    activeSheet = {
      title: options.title,
      content: options.content,
      materialId: options.materialId || null,
      studySetId: options.studySetId || null,
      studySetTitle: options.studySetTitle || "",
      studySet: options.studySet || null
    };

    var categorySelect = document.getElementById("formulaCategoryFilter");
    if (categorySelect) {
      categorySelect.innerHTML = '<option value="">All categories</option>';
    }

    var search = document.getElementById("formulaViewSearch");
    if (search) {
      search.value = "";
    }

    renderFormulaReader();
    global.showPage?.("formula-sheet-view");
  }

  function openFormulaFromMaterial(row) {
    var content = row.content || {};
    if (content.schema !== "ai_formula_sheet_v1") {
      global.showToast?.(
        "This formula sheet uses a legacy format. Generate a new AI sheet."
      );
      return;
    }
    var sets = getStudySets();
    var linked = sets.find(function (s) {
      return s.id === row.study_set_id;
    });
    openFormulaSheetView({
      title: row.title,
      content: content,
      materialId: row.id,
      studySetId: row.study_set_id,
      studySetTitle: linked?.title || "",
      studySet: linked || null
    });
  }

  async function generateFormulaSheetFromUi() {
    if (formulaGenerateInFlight) {
      return;
    }

    var select = document.getElementById("formulaStudySetSelect");
    var setId = select?.value;
    var studySet = getStudySets().find(function (s) {
      return s.id === setId;
    });

    if (!studySet) {
      setFormulaBanner("Select a saved study set to generate a formula sheet.", true);
      return;
    }

    var notes = studySetNotes(studySet);
    if (notes.length < 10) {
      setFormulaBanner(
        "This study set does not have enough content. Add notes or re-extract.",
        true
      );
      return;
    }

    var profile = getProfile();
    if (!profile?.id) {
      global.showToast?.("Sign in to generate formula sheets.");
      return;
    }

    var token = await getAccessToken();
    if (!token) {
      global.showToast?.("Your session expired. Please sign in again.");
      return;
    }

    formulaGenerateInFlight = true;
    setFormulaBanner("");
    setFormulaLoading(true);

    try {
      var response = await fetch(getApiBase() + "/api/generate-formula-sheet", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          notes: notes,
          title: studySet.title,
          subject: studySet.subject,
          study_set_id: studySet.id
        })
      });

      var payload = await response.json().catch(function () {
        return {};
      });

      if (!response.ok) {
        throw new Error(formatApiError(payload.detail));
      }

      var fingerprint = buildSheetFingerprint(studySet.id, payload);
      var materialContent = buildMaterialContent(payload, fingerprint);

      openFormulaSheetView({
        title: payload.title,
        content: materialContent,
        materialId: null,
        studySetId: studySet.id,
        studySetTitle: studySet.title,
        studySet: studySet
      });

      global.showToast?.("Formula sheet ready. Save when you're happy with it.");
    } catch (error) {
      var message =
        error instanceof Error
          ? error.message
          : "Formula sheet generation failed.";
      setFormulaBanner(message, true);
      global.showToast?.(message);
    } finally {
      formulaGenerateInFlight = false;
      setFormulaLoading(false);
    }
  }

  function rowMatchesGridSearch(row, term) {
    if (!term) {
      return true;
    }
    var content = row.content || {};
    var haystack = (
      (row.title || "") +
      " " +
      (content.title || "") +
      " " +
      (content.subject || "") +
      " " +
      JSON.stringify(content.categories || [])
    ).toLowerCase();
    return haystack.indexOf(term) >= 0;
  }

  function renderFormulaSheetsGrid() {
    var grid = document.getElementById("formulaSheetsGrid");
    var empty = document.getElementById("formulaSheetsEmptyState");
    if (!grid || !global.AceDB) {
      return;
    }

    var term = gridSearchTerm.trim().toLowerCase();
    var rows = global.AceDB.getMaterialsByType(
      global.AceDB.MATERIAL_TYPES.formula_sheet
    ).filter(function (row) {
      if (row.content?.schema === "ai_formula_sheet_v1") {
        return rowMatchesGridSearch(row, term);
      }
      return false;
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
      var count = countFormulasInContent(row.content);
      article.innerHTML =
        '<div class="recent-type">FORMULAS</div>' +
        "<h3>" +
        escapeHtml(row.title || "Formula sheet") +
        "</h3>" +
        "<p>" +
        count +
        " formula(s)</p>" +
        '<div class="cheatsheet-card-actions">' +
        '<button class="detail-button" type="button" data-action="open">Open</button>' +
        "</div>";
      article.querySelector('[data-action="open"]')?.addEventListener(
        "click",
        function (event) {
          event.stopPropagation();
          openFormulaFromMaterial(row);
        }
      );
      article.addEventListener("click", function () {
        openFormulaFromMaterial(row);
      });
      grid.appendChild(article);
    });
  }

  function bindFormulaUi() {
    document
      .getElementById("generateFormulaSheetBtn")
      ?.addEventListener("click", generateFormulaSheetFromUi);
    document
      .getElementById("formulaRetryBtn")
      ?.addEventListener("click", generateFormulaSheetFromUi);
    document.getElementById("formulaGoExtractBtn")?.addEventListener(
      "click",
      function () {
        global.showPage?.("home");
      }
    );
    document
      .getElementById("formulaSaveSheetBtn")
      ?.addEventListener("click", saveSheetExplicitly);
    document
      .getElementById("formulaDeleteSheetBtn")
      ?.addEventListener("click", deleteSavedSheet);
    document.getElementById("formulaSheetBackBtn")?.addEventListener(
      "click",
      function () {
        global.showPage?.("formula-sheets");
      }
    );
    document.getElementById("formulaOpenStudySetBtn")?.addEventListener(
      "click",
      function () {
        if (!activeSheet?.studySet && activeSheet?.studySetId) {
          var linked = getStudySets().find(function (s) {
            return s.id === activeSheet.studySetId;
          });
          if (linked && global.openStudySetResults) {
            global.openStudySetResults(linked);
            return;
          }
        }
        if (activeSheet?.studySet && global.openStudySetResults) {
          global.openStudySetResults(activeSheet.studySet);
        }
      }
    );
    document.getElementById("formulaViewSearch")?.addEventListener(
      "input",
      renderFormulaReader
    );
    document.getElementById("formulaCategoryFilter")?.addEventListener(
      "change",
      renderFormulaReader
    );
    document.getElementById("formulaSheetsSearch")?.addEventListener(
      "input",
      function (event) {
        gridSearchTerm = event.target?.value || "";
        renderFormulaSheetsGrid();
      }
    );
  }

  function init() {
    bindFormulaUi();
    populateFormulaStudySetSelect();
  }

  global.AceFormulaSheets = {
    init: init,
    populateFormulaStudySetSelect: populateFormulaStudySetSelect,
    renderFormulaSheetsGrid: renderFormulaSheetsGrid,
    generateFormulaSheetFromUi: generateFormulaSheetFromUi,
    openFormulaFromMaterial: openFormulaFromMaterial
  };
})(window);
