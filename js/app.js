/* Family Cookbook — a static, flip-page recipe book.
 *
 * Data flow:
 *   data/recipes.json  ──fetch──▶  recipes (in memory)  ──▶ book pages
 *   Edits are kept in localStorage until they are exported (Download JSON)
 *   or committed back to data/recipes.json through the GitHub contents API.
 *
 * Translations:
 *   Any recipe text may be a plain string (same in every language) or an
 *   object with one value per language: { "en": "Pizza", "sr": "Pica" }.
 *   Steps and tags are arrays, or { "en": [...], "sr": [...] }.
 *   Missing translations fall back to the other language.
 */
(() => {
  "use strict";

  const LANGS = ["en", "sr"];
  const DATA_URL = "data/recipes.json";
  const STORE_KEY = "cookbook.recipes.v1";
  const LANG_KEY = "cookbook.lang";
  const GH_KEY = "cookbook.github.v1";
  const GH_TOKEN_KEY = "cookbook.github.token";
  const MAX_TIME = 240;
  const DIFFICULTIES = ["Easy", "Medium", "Hard"];
  const TEXT_FIELDS = ["title", "description", "preparation", "category", "cuisine"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    lang: "en",
    recipes: [],
    fileSnapshot: "[]", // JSON of recipes.json as last loaded / committed
    pages: [],
    index: 0, // left page index in spread mode, page index in single mode
    single: false,
    flipping: false,
    editingId: null,
    draft: null, // recipe being edited, with every text expanded to { en, sr }
    formLang: "en",
    filters: {
      search: "",
      ingredients: new Set(),
      ingredientMode: "all",
      preparation: new Set(),
      category: new Set(),
      cuisine: new Set(),
      difficulty: new Set(),
      maxTime: MAX_TIME,
    },
    ingredientQuery: "",
  };

  // ---------- Small helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const slugify = (s) => norm(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "dj").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";
  const totalTime = (r) => (Number(r.prepTime) || 0) + (Number(r.cookTime) || 0);
  const store = {
    get(key, area = localStorage) { try { return area.getItem(key); } catch { return null; } },
    set(key, val, area = localStorage) { try { area.setItem(key, val); } catch { /* storage unavailable */ } },
    del(key, area = localStorage) { try { area.removeItem(key); } catch { /* storage unavailable */ } },
  };

  // ---------- i18n ----------
  /** Interface string for the current language, with {placeholders} and plurals. */
  function t(key, vars = {}) {
    let s = window.I18N[state.lang]?.[key] ?? window.I18N.en[key] ?? key;
    if (typeof s === "object") {
      const cat = new Intl.PluralRules(state.lang).select(Number(vars.n) || 0);
      s = s[cat] ?? s.other;
    }
    return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  }

  const isLoc = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  /** Recipe value in a language, falling back to the other language. */
  function tr(v, lang = state.lang) {
    if (!isLoc(v)) return v ?? "";
    if (v[lang] != null) return v[lang];
    const other = LANGS.find((l) => v[l] != null);
    return other ? v[other] : "";
  }

  /** Every language's text of a value, flattened (for search and emptiness checks). */
  const allText = (v) => (isLoc(v) ? Object.values(v).flat() : Array.isArray(v) ? v.flatMap(allText) : [v]).map((x) => String(x ?? "")).filter((x) => x.trim());

  const missing = (v, lang) => isLoc(v) && v[lang] == null;

  function fmtTime(m) {
    m = Number(m) || 0;
    if (m < 60) return t("time.min", { m });
    const h = Math.floor(m / 60), r = m % 60;
    return r ? t("time.hm", { h, m: r }) : t("time.h", { h });
  }

  function applyStaticText() {
    document.documentElement.lang = state.lang;
    document.title = t("app.title");
    $$("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $$("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
    $$("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
    $$("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $$(".lang-switch button").forEach((b) => {
      const on = b.dataset.lang === state.lang;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });
  }

  function initialLang() {
    const fromUrl = new URLSearchParams(location.search).get("lang");
    if (LANGS.includes(fromUrl)) return fromUrl;
    const saved = store.get(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
    return (navigator.languages || [navigator.language]).some((l) => /^(sr|hr|bs|cnr|sh)\b/i.test(l || "")) ? "sr" : "en";
  }

  function setLang(lang) {
    if (lang === state.lang || !LANGS.includes(lang)) return;
    const from = state.lang;
    // Carry selected filter values over to their translation.
    const f = state.filters;
    const convert = (set, values) => {
      const map = new Map(values.map((v) => [norm(tr(v, from)), norm(tr(v, lang))]));
      return new Set([...set].map((k) => map.get(k) ?? k));
    };
    f.ingredients = convert(f.ingredients, state.recipes.flatMap((r) => r.ingredients.map((i) => i.name)));
    f.preparation = convert(f.preparation, state.recipes.map((r) => r.preparation));
    f.category = convert(f.category, state.recipes.map((r) => r.category));
    f.cuisine = convert(f.cuisine, state.recipes.map((r) => r.cuisine));

    const current = state.pages[state.index]?.recipe?.id;
    state.lang = lang;
    store.set(LANG_KEY, lang);
    const url = new URL(location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", lang);
      history.replaceState(null, "", url);
    }
    applyStaticText();
    updateSyncStatus();
    rebuild({ keepIndex: true });
    if (current) {
      const i = pageOfRecipe(current);
      if (i !== -1) {
        state.index = normalizeIndex(i);
        renderStatic();
      }
    }
  }

  let toastTimer;
  function toast(msg, ms = 2800) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- Data ----------
  /** Clean a text value: trimmed string, or { lang: string } without empty entries. */
  function cleanText(v) {
    if (isLoc(v)) {
      const o = {};
      for (const l of LANGS) if (v[l] != null && String(v[l]).trim()) o[l] = String(v[l]).trim();
      return Object.keys(o).length ? o : "";
    }
    return String(v ?? "").trim();
  }

  /** Clean a list value: array of strings, or { lang: [strings] }. */
  function cleanList(v, splitStrings = false) {
    const list = (a) => (Array.isArray(a) ? a : splitStrings ? String(a ?? "").split(",") : a == null ? [] : [a]).map((s) => String(s).trim()).filter(Boolean);
    if (isLoc(v)) {
      const o = {};
      for (const l of LANGS) if (v[l] != null && list(v[l]).length) o[l] = list(v[l]);
      return Object.keys(o).length ? o : [];
    }
    return list(v);
  }

  function normalizeRecipe(r, taken = new Set()) {
    const title = cleanText(r.title);
    const out = {
      id: String(r.id || "").trim() || slugify(tr(title, "en")),
      title: allText(title).length ? title : "Untitled",
      emoji: String(r.emoji || "🍽️").trim(),
      description: cleanText(r.description),
      category: cleanText(r.category),
      preparation: cleanText(r.preparation),
      cuisine: cleanText(r.cuisine),
      difficulty: DIFFICULTIES.includes(r.difficulty) ? r.difficulty : "Easy",
      prepTime: Math.max(0, parseInt(r.prepTime, 10) || 0),
      cookTime: Math.max(0, parseInt(r.cookTime, 10) || 0),
      servings: Math.max(1, parseInt(r.servings, 10) || 1),
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients : [])
        .map((i) => (typeof i === "string" ? { amount: "", name: i.trim() } : { amount: cleanText(i.amount), name: cleanText(i.name) }))
        .filter((i) => allText(i.name).length),
      steps: cleanList(r.steps),
      tags: cleanList(r.tags, true),
    };
    if (r.image) out.image = String(r.image).trim();
    if (r.notes && allText(cleanText(r.notes)).length) out.notes = cleanText(r.notes);
    let id = out.id, n = 2;
    while (taken.has(id)) id = `${out.id}-${n++}`;
    out.id = id;
    taken.add(id);
    return out;
  }

  function normalizeAll(list) {
    if (!Array.isArray(list)) throw new Error(t("err.notArray"));
    const taken = new Set();
    return list.map((r) => normalizeRecipe(r, taken));
  }

  const serialize = (list) => JSON.stringify(list, null, 2) + "\n";

  async function loadData() {
    let fileRecipes = [];
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      fileRecipes = normalizeAll(await res.json());
    } catch (err) {
      console.error(err);
      toast(t("toast.loadFailed", { url: DATA_URL, e: err.message }), 5000);
    }
    state.fileSnapshot = JSON.stringify(fileRecipes);

    const saved = store.get(STORE_KEY);
    if (saved) {
      try {
        state.recipes = normalizeAll(JSON.parse(saved));
        if (JSON.stringify(state.recipes) === state.fileSnapshot) store.del(STORE_KEY);
      } catch {
        store.del(STORE_KEY);
        state.recipes = fileRecipes;
      }
    } else {
      state.recipes = fileRecipes;
    }
  }

  function persist() {
    store.set(STORE_KEY, JSON.stringify(state.recipes));
    updateSyncStatus();
  }

  function isDirty() {
    return JSON.stringify(state.recipes) !== state.fileSnapshot;
  }

  function updateSyncStatus() {
    const dirty = isDirty();
    $("#syncDot").classList.toggle("dirty", dirty);
    $("#syncDot").title = t(dirty ? "sync.dotDirty" : "sync.dotClean");
    $("#syncStatus").textContent = t(dirty ? "sync.dirty" : "sync.clean");
  }

  // ---------- Filtering ----------
  function activeFilterCount() {
    const f = state.filters;
    return f.ingredients.size + f.preparation.size + f.category.size + f.cuisine.size + f.difficulty.size + (f.maxTime < MAX_TIME ? 1 : 0);
  }

  function matches(r) {
    const f = state.filters;
    if (f.search) {
      // Search every language, so "brašno" and "flour" both work.
      const hay = norm([r.title, r.description, r.category, r.preparation, r.cuisine, r.tags, r.ingredients.map((i) => i.name)].flatMap(allText).join(" "));
      if (!f.search.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (f.ingredients.size) {
      const names = new Set(r.ingredients.map((i) => norm(tr(i.name))));
      const sel = [...f.ingredients];
      const ok = f.ingredientMode === "all" ? sel.every((n) => names.has(n)) : sel.some((n) => names.has(n));
      if (!ok) return false;
    }
    if (f.preparation.size && !f.preparation.has(norm(tr(r.preparation)))) return false;
    if (f.category.size && !f.category.has(norm(tr(r.category)))) return false;
    if (f.cuisine.size && !f.cuisine.has(norm(tr(r.cuisine)))) return false;
    if (f.difficulty.size && !f.difficulty.has(norm(r.difficulty))) return false;
    if (f.maxTime < MAX_TIME && totalTime(r) > f.maxTime) return false;
    return true;
  }

  const filteredRecipes = () =>
    state.recipes.filter(matches).sort((a, b) => tr(a.title).localeCompare(tr(b.title), state.lang));

  /** Distinct values: getEntries(recipe) returns [[key, label], ...]. */
  function facet(getEntries) {
    const map = new Map();
    for (const r of state.recipes) {
      for (const [key, label] of getEntries(r)) {
        if (!key) continue;
        const e = map.get(key) || { key, label, count: 0 };
        e.count++;
        map.set(key, e);
      }
    }
    return [...map.values()];
  }
  const textEntry = (v) => {
    const label = String(tr(v)).trim();
    return [norm(label), label];
  };

  function chipHTML(group, { key, label, count }, selected) {
    return `<button type="button" class="chip" data-group="${group}" data-key="${esc(key)}" aria-pressed="${selected.has(key)}">${esc(label)}<span class="n">${count}</span></button>`;
  }

  function renderFilters() {
    const f = state.filters;
    const byLabel = (a, b) => a.label.localeCompare(b.label, state.lang);
    const facets = {
      ingredients: facet((r) => r.ingredients.map((i) => textEntry(i.name))).sort((a, b) => b.count - a.count || byLabel(a, b)),
      preparation: facet((r) => [textEntry(r.preparation)]).sort(byLabel),
      category: facet((r) => [textEntry(r.category)]).sort(byLabel),
      cuisine: facet((r) => [textEntry(r.cuisine)]).sort(byLabel),
      difficulty: facet((r) => [[norm(r.difficulty), t(`difficulty.${r.difficulty}`)]]).sort((a, b) => DIFFICULTIES.findIndex((d) => norm(d) === a.key) - DIFFICULTIES.findIndex((d) => norm(d) === b.key)),
    };

    // Drop selections whose value no longer exists (e.g. after a delete).
    for (const [group, items] of Object.entries(facets)) {
      const keys = new Set(items.map((i) => i.key));
      for (const k of [...f[group]]) if (!keys.has(k)) f[group].delete(k);
    }

    const q = norm(state.ingredientQuery);
    const ing = facets.ingredients.filter((i) => f.ingredients.has(i.key) || !q || i.key.includes(q));
    // Selected ingredients first so they stay visible.
    ing.sort((a, b) => f.ingredients.has(b.key) - f.ingredients.has(a.key));
    $("#ingredientChips").innerHTML = ing.map((i) => chipHTML("ingredients", i, f.ingredients)).join("") || `<span class="muted">${esc(t("f.noIngredient", { q: state.ingredientQuery }))}</span>`;
    $("#preparationChips").innerHTML = facets.preparation.map((i) => chipHTML("preparation", i, f.preparation)).join("");
    $("#categoryChips").innerHTML = facets.category.map((i) => chipHTML("category", i, f.category)).join("");
    $("#cuisineChips").innerHTML = facets.cuisine.map((i) => chipHTML("cuisine", i, f.cuisine)).join("");
    $("#difficultyChips").innerHTML = facets.difficulty.map((i) => chipHTML("difficulty", i, f.difficulty)).join("");

    $$("#ingredientMode button").forEach((b) => {
      const on = b.dataset.mode === f.ingredientMode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });
    $("#maxTime").value = f.maxTime;
    $("#maxTimeLabel").textContent = f.maxTime >= MAX_TIME ? t("f.timeAny") : `≤ ${fmtTime(f.maxTime)}`;

    const count = activeFilterCount();
    $("#filterCount").hidden = count === 0;
    $("#filterCount").textContent = count;
    const shown = state.recipes.filter(matches).length;
    $("#resultCount").textContent = t("f.showing", { n: shown, total: state.recipes.length });
  }

  /** Suggestions for the recipe form, in the language being written. */
  function fillDatalists(lang) {
    const D = window.I18N_DEFAULTS;
    const fill = (id, values) => {
      const all = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, lang));
      $(id).innerHTML = all.map((v) => `<option value="${esc(v)}"></option>`).join("");
    };
    fill("#dl-preparation", [...state.recipes.map((r) => tr(r.preparation, lang)), ...D.preparation[lang]]);
    fill("#dl-category", [...state.recipes.map((r) => tr(r.category, lang)), ...D.category[lang]]);
    fill("#dl-cuisine", state.recipes.map((r) => tr(r.cuisine, lang)));
    fill("#dl-ingredients", state.recipes.flatMap((r) => r.ingredients.map((i) => tr(i.name, lang))));
  }

  // ---------- Book pages ----------
  function buildPages() {
    const list = filteredRecipes();
    const pages = [{ type: "title", shown: list.length }];
    const perToc = state.single ? 10 : 11;
    const tocCount = Math.max(1, Math.ceil(list.length / perToc));
    const front = 1 + tocCount;
    const start = front + (front % 2); // recipes always start on a left (even) page
    for (let p = 0; p < tocCount; p++) {
      pages.push({
        type: "toc",
        part: p,
        parts: tocCount,
        items: list.slice(p * perToc, (p + 1) * perToc).map((r, i) => ({ r, page: start + (p * perToc + i) * 2 })),
      });
    }
    if (pages.length % 2) pages.push({ type: "notes" });
    for (const r of list) {
      pages.push({ type: "recipe-a", recipe: r });
      pages.push({ type: "recipe-b", recipe: r });
    }
    pages.push({ type: "notes" }, { type: "end" });
    return pages;
  }

  function highlightIngredient(name) {
    return state.filters.ingredients.has(norm(name)) ? `<mark>${esc(name)}</mark>` : esc(name);
  }

  function isPartlyUntranslated(r) {
    return [r.title, r.description, r.steps, ...r.ingredients.map((i) => i.name)].some((v) => missing(v, state.lang));
  }

  function renderPageContent(p) {
    switch (p.type) {
      case "title": {
        const total = state.recipes.length;
        return `
          <div class="title-page">
            <div class="big-emoji">🍳</div>
            <h1>${t("book.title")}</h1>
            <div class="subtitle">${esc(t("book.subtitle"))}</div>
            <div class="ornament">❦ ❦ ❦</div>
            <div class="count">${esc(t("book.count", { n: total }))}${p.shown !== total ? `<br>${esc(t("book.matching", { n: p.shown }))}` : ""}</div>
          </div>`;
      }
      case "toc": {
        if (!p.items.length) {
          return `
            <div class="toc">
              <h2>${esc(t("toc.title"))}</h2>
              <div class="empty-state">
                <div class="big-emoji">🧺</div>
                <p>${esc(t(state.recipes.length ? "toc.noMatch" : "toc.empty"))}</p>
                ${state.recipes.length ? `<button class="ink-btn" data-clear>${esc(t("toc.clear"))}</button>` : `<button class="ink-btn" data-new>${esc(t("toc.first"))}</button>`}
              </div>
            </div>`;
        }
        return `
          <div class="toc">
            <h2>${esc(t("toc.title"))}</h2>
            <div class="toc-sub">${esc(p.parts > 1 ? t("toc.part", { a: p.part + 1, b: p.parts }) : t("toc.sub"))}</div>
            <ol>
              ${p.items.map(({ r, page }) => `
                <li><button class="toc-item" data-goto="${page}" title="${esc(tr(r.title))}">
                  <span class="toc-emoji">${esc(r.emoji)}</span>
                  <span class="toc-title">${esc(tr(r.title))}</span>
                  <span class="toc-dots"></span>
                  <span class="toc-meta">${esc(tr(r.preparation))}</span>
                  <span class="toc-page">${page + 1}</span>
                </button></li>`).join("")}
            </ol>
          </div>`;
      }
      case "recipe-a": {
        const r = p.recipe;
        const art = r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : esc(r.emoji);
        const desc = tr(r.description);
        return `
          <div class="recipe-head">
            <div class="recipe-art">${art}</div>
            <h2>${esc(tr(r.title))}</h2>
          </div>
          ${isPartlyUntranslated(r) ? `<p class="untranslated">🌐 ${esc(t("r.fallback"))}</p>` : ""}
          ${desc ? `<p class="recipe-desc">${esc(desc)}</p>` : ""}
          <div class="tags-row">
            ${[["prep", r.preparation], ["", r.category], ["", r.cuisine]].filter(([, v]) => tr(v)).map(([cls, v]) => `<span class="tag ${cls}">${esc(tr(v))}</span>`).join("")}
          </div>
          <div class="stats">
            <div><b>${fmtTime(r.prepTime)}</b><span>${esc(t("r.prep"))}</span></div>
            <div><b>${fmtTime(r.cookTime)}</b><span>${esc(t("r.cook"))}</span></div>
            <div><b>${r.servings}</b><span>${esc(t("r.serves"))}</span></div>
            <div><b>${esc(t(`difficulty.${r.difficulty}`))}</b><span>${esc(t("r.level"))}</span></div>
          </div>
          <h3 class="section-title">${esc(t("f.ingredients"))}</h3>
          <ul class="ingredients">
            ${r.ingredients.map((i) => {
              const amt = tr(i.amount);
              return `<li><label><input type="checkbox"><span>${amt ? `<span class="amt">${esc(amt)}</span> ` : ""}${highlightIngredient(tr(i.name))}</span></label></li>`;
            }).join("")}
          </ul>`;
      }
      case "recipe-b": {
        const r = p.recipe;
        const steps = tr(r.steps);
        const tags = tr(r.tags);
        return `
          <h3 class="section-title">${esc(t("r.method"))}</h3>
          ${steps.length ? `<ol class="steps">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<p class="muted">${esc(t("r.noSteps"))}</p>`}
          ${tr(r.notes) ? `<div class="note-card">${esc(tr(r.notes))}</div>` : ""}
          ${tags.length ? `<div class="tags-row">${tags.map((tag) => `<span class="tag plain">#${esc(tag)}</span>`).join("")}</div>` : ""}
          <div class="recipe-actions">
            <button class="ink-btn" data-edit="${esc(r.id)}">${esc(t("r.edit"))}</button>
            <button class="ink-btn danger" data-delete="${esc(r.id)}">${esc(t("r.delete"))}</button>
          </div>`;
      }
      case "notes":
        return `
          <h3 class="section-title">${esc(t("notes.title"))}</h3>
          <div class="note-card">${t("notes.body")}</div>`;
      case "end":
        return `
          <div class="end-page">
            <div class="big-emoji">✍️</div>
            <h2>${esc(t("end.title"))}</h2>
            <p class="muted">${esc(t("end.text"))}</p>
            <button class="ink-btn" data-new>${esc(t("end.button"))}</button>
          </div>`;
      default:
        return "";
    }
  }

  /** Full page markup. `i` beyond the page list renders as a blank sheet. */
  function pageHTML(i, side, interactive = true) {
    const p = state.pages[i];
    if (!p) return `<div class="page ${side}"></div>`;
    const showNum = p.type !== "title";
    let corners = "";
    if (interactive) {
      const canPrev = state.index > 0;
      const canNext = state.index + (state.single ? 1 : 2) < state.pages.length;
      if ((side === "left" || side === "single") && canPrev) corners += `<button class="corner prev" data-turn="prev" aria-label="${esc(t("nav.prev"))}"></button>`;
      if ((side === "right" || side === "single") && canNext) corners += `<button class="corner next" data-turn="next" aria-label="${esc(t("nav.next"))}"></button>`;
    }
    return `<div class="page ${side}"><div class="page-inner">${renderPageContent(p)}</div>${showNum ? `<span class="page-num">${i + 1}</span>` : ""}${corners}</div>`;
  }

  const pagesEl = () => $("#pages");

  function renderStatic() {
    const i = state.index;
    pagesEl().innerHTML = state.single ? pageHTML(i, "single") : pageHTML(i, "left") + pageHTML(i + 1, "right");
    $("#prevBtn").disabled = i <= 0;
    $("#nextBtn").disabled = i + (state.single ? 1 : 2) >= state.pages.length;
  }

  function normalizeIndex(i) {
    i = Math.max(0, Math.min(i, state.pages.length - 1));
    return state.single ? i : i - (i % 2);
  }

  function makeLeaf(cls, frontHTML, backHTML) {
    const leaf = document.createElement("div");
    leaf.className = `leaf ${cls}`;
    leaf.innerHTML = `<div class="leaf-face front">${frontHTML}</div><div class="leaf-face back">${backHTML}</div>`;
    return leaf;
  }

  function animateLeaf(leaf, from, to) {
    return new Promise((resolve) => {
      leaf.style.transition = "none";
      leaf.style.transform = `rotateY(${from}deg)`;
      pagesEl().appendChild(leaf);
      void leaf.offsetWidth; // commit the start position
      leaf.style.transition = "";
      const ms = parseFloat(getComputedStyle(leaf).transitionDuration) * 1000 || 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      leaf.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, ms + 120);
      requestAnimationFrame(() => (leaf.style.transform = `rotateY(${to}deg)`));
    });
  }

  async function flipTo(target) {
    target = normalizeIndex(target);
    const cur = state.index;
    if (state.flipping || target === cur) return;
    state.flipping = true;
    const forward = target > cur;

    try {
      if (state.single) {
        if (forward) {
          // current page swings away revealing the target underneath
          pagesEl().innerHTML = pageHTML(target, "single", false);
          await animateLeaf(makeLeaf("single", pageHTML(cur, "single", false), `<div class="page single blank-back"></div>`), 0, -180);
        } else {
          // target page swings back in over the current page
          pagesEl().innerHTML = pageHTML(cur, "single", false);
          await animateLeaf(makeLeaf("single", pageHTML(target, "single", false), `<div class="page single blank-back"></div>`), -180, 0);
        }
      } else if (forward) {
        pagesEl().innerHTML = pageHTML(cur, "left", false) + pageHTML(target + 1, "right", false);
        await animateLeaf(makeLeaf("from-right", pageHTML(cur + 1, "right", false), pageHTML(target, "left", false)), 0, -180);
      } else {
        pagesEl().innerHTML = pageHTML(target, "left", false) + pageHTML(cur + 1, "right", false);
        await animateLeaf(makeLeaf("from-left", pageHTML(cur, "left", false), pageHTML(target + 1, "right", false)), 0, 180);
      }
    } finally {
      state.index = target;
      state.flipping = false;
      renderStatic();
    }
  }

  const step = () => (state.single ? 1 : 2);
  const next = () => state.index + step() < state.pages.length && flipTo(state.index + step());
  const prev = () => state.index > 0 && flipTo(state.index - step());

  function contentsIndex() {
    return state.single ? 1 : 0;
  }

  function rebuild({ keepIndex = false } = {}) {
    state.pages = buildPages();
    state.index = normalizeIndex(keepIndex ? state.index : contentsIndex());
    renderFilters();
    renderStatic();
  }

  function pageOfRecipe(id) {
    return state.pages.findIndex((p) => p.type === "recipe-a" && p.recipe.id === id);
  }

  // ---------- Recipe form (create / update) ----------
  //
  // The form edits one language at a time. The draft holds every text as
  // { en, sr }; switching the form language saves the inputs into the draft
  // and loads the other language, showing untranslated text as placeholders.
  const dialog = () => $("#recipeDialog");
  const form = () => $("#recipeForm");

  const expandText = (v) => Object.fromEntries(LANGS.map((l) => [l, String(isLoc(v) ? v[l] ?? "" : v ?? "")]));

  /** Aligned rows [{ en, sr }] from a list value. */
  function expandRows(v) {
    const per = Object.fromEntries(LANGS.map((l) => [l, isLoc(v) ? v[l] || [] : v || []]));
    const n = Math.max(...LANGS.map((l) => per[l].length));
    return Array.from({ length: n }, (_, i) => Object.fromEntries(LANGS.map((l) => [l, per[l][i] ?? ""])));
  }

  /** Back to the stored shape: a plain string when all languages agree. */
  function collapseText(o) {
    const filled = LANGS.filter((l) => o[l].trim());
    if (!filled.length) return "";
    if (filled.length === LANGS.length && LANGS.every((l) => o[l].trim() === o[LANGS[0]].trim())) return o[LANGS[0]].trim();
    return Object.fromEntries(filled.map((l) => [l, o[l].trim()]));
  }

  function collapseRows(rows) {
    const per = Object.fromEntries(LANGS.map((l) => [l, rows.map((r) => r[l].trim()).filter(Boolean)]));
    const filled = LANGS.filter((l) => per[l].length);
    if (!filled.length) return [];
    if (filled.length === LANGS.length && LANGS.every((l) => JSON.stringify(per[l]) === JSON.stringify(per[LANGS[0]]))) return per[LANGS[0]];
    return Object.fromEntries(filled.map((l) => [l, per[l]]));
  }

  const otherLang = (lang) => LANGS.find((l) => l !== lang);

  function ingredientRow(i, lang) {
    const other = otherLang(lang);
    const row = document.createElement("div");
    row.className = "row ing";
    row.innerHTML = `
      <input data-f="amount" value="${esc(i.amount[lang])}" placeholder="${esc(i.amount[other] || t("ph.amount"))}" aria-label="${esc(t("form.amount"))}">
      <input data-f="name" value="${esc(i.name[lang])}" placeholder="${esc(i.name[other] || t("ph.ingredient"))}" list="dl-ingredients" aria-label="${esc(t("form.ingredient"))}">
      <button type="button" class="remove" data-remove="ingredients" aria-label="${esc(t("form.removeIngredient"))}">✕</button>`;
    return row;
  }

  function stepRow(s, lang, n) {
    const row = document.createElement("div");
    row.className = "row step";
    row.innerHTML = `
      <span class="num">${n}</span>
      <textarea rows="2" data-f="step" placeholder="${esc(s[otherLang(lang)] || t("ph.step"))}" aria-label="${esc(t("form.step"))} ${n}">${esc(s[lang])}</textarea>
      <button type="button" class="remove" data-remove="steps" aria-label="${esc(t("form.removeStep"))}">✕</button>`;
    return row;
  }

  /** Copy the inputs for the current form language into the draft. */
  function captureForm() {
    const d = state.draft, lang = state.formLang, f = form().elements;
    for (const name of TEXT_FIELDS) d[name][lang] = f[name].value;
    d.tags[lang] = f.tags.value;
    for (const name of ["emoji", "difficulty", "prepTime", "cookTime", "servings", "image"]) d[name] = f[name].value;
    $$("#ingredientRows .row").forEach((row, i) => {
      d.ingredients[i].amount[lang] = $('[data-f="amount"]', row).value;
      d.ingredients[i].name[lang] = $('[data-f="name"]', row).value;
    });
    $$("#stepRows textarea").forEach((ta, i) => (d.steps[i][lang] = ta.value));
  }

  /** Show the draft in the current form language. */
  function fillForm() {
    const d = state.draft, lang = state.formLang, other = otherLang(lang), f = form().elements;
    for (const name of TEXT_FIELDS) {
      f[name].value = d[name][lang];
      f[name].placeholder = d[name][other] || t(`ph.${name}`);
    }
    f.tags.value = d.tags[lang];
    f.tags.placeholder = d.tags[other] || t("ph.tags");
    for (const name of ["emoji", "difficulty", "prepTime", "cookTime", "servings", "image"]) f[name].value = d[name];
    $("#ingredientRows").replaceChildren(...d.ingredients.map((i) => ingredientRow(i, lang)));
    $("#stepRows").replaceChildren(...d.steps.map((s, i) => stepRow(s, lang, i + 1)));
    $$("#formLang button").forEach((b) => {
      const on = b.dataset.formLang === lang;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });
    fillDatalists(lang);
  }

  function setFormLang(lang) {
    if (lang === state.formLang) return;
    captureForm();
    state.formLang = lang;
    fillForm();
  }

  function openForm(recipe = null) {
    state.editingId = recipe ? recipe.id : null;
    state.formLang = state.lang;
    $("#recipeDialogTitle").textContent = t(recipe ? "form.edit" : "form.new");
    $("#formError").textContent = "";
    const r = recipe || { difficulty: "Easy", prepTime: 0, cookTime: 0, servings: 4, emoji: "", image: "" };
    const empty = () => Object.fromEntries(LANGS.map((l) => [l, ""]));
    const tags = isLoc(r.tags) ? r.tags : { en: r.tags || [], sr: r.tags || [] };
    state.draft = {
      ...Object.fromEntries(TEXT_FIELDS.map((name) => [name, expandText(r[name])])),
      emoji: r.emoji || "",
      image: r.image || "",
      difficulty: r.difficulty,
      prepTime: r.prepTime,
      cookTime: r.cookTime,
      servings: r.servings,
      tags: Object.fromEntries(LANGS.map((l) => [l, (tags[l] || []).join(", ")])),
      ingredients: recipe ? r.ingredients.map((i) => ({ amount: expandText(i.amount), name: expandText(i.name) })) : [0, 1, 2].map(() => ({ amount: empty(), name: empty() })),
      steps: recipe ? expandRows(r.steps) : [empty(), empty()],
      notes: r.notes,
    };
    fillForm();
    dialog().showModal();
    form().elements.title.focus();
  }

  function saveForm(e) {
    e.preventDefault();
    captureForm();
    const d = state.draft;
    const err = $("#formError");
    const title = collapseText(d.title);
    const ingredients = d.ingredients.map((i) => ({ amount: collapseText(i.amount), name: collapseText(i.name) })).filter((i) => allText(i.name).length);
    const steps = collapseRows(d.steps);
    if (!allText(title).length) return (err.textContent = t("err.title"));
    if (!allText(collapseText(d.preparation)).length) return (err.textContent = t("err.preparation"));
    if (!ingredients.length) return (err.textContent = t("err.ingredient"));
    if (!allText(steps).length) return (err.textContent = t("err.step"));

    const tagsByLang = Object.fromEntries(LANGS.map((l) => [l, d.tags[l].split(",").map((s) => s.trim()).filter(Boolean)]));
    const data = {
      title,
      description: collapseText(d.description),
      preparation: collapseText(d.preparation),
      category: collapseText(d.category),
      cuisine: collapseText(d.cuisine),
      emoji: d.emoji.trim() || "🍽️",
      image: d.image.trim() || undefined,
      difficulty: d.difficulty,
      prepTime: d.prepTime,
      cookTime: d.cookTime,
      servings: d.servings,
      ingredients,
      steps,
      tags: collapseRows(expandRows(tagsByLang)),
      notes: d.notes,
    };

    let saved;
    const wasEditing = !!state.editingId;
    if (wasEditing) {
      const idx = state.recipes.findIndex((r) => r.id === state.editingId);
      const others = new Set(state.recipes.filter((r) => r.id !== state.editingId).map((r) => r.id));
      saved = normalizeRecipe({ ...data, id: state.editingId }, others);
      state.recipes[idx] = saved;
    } else {
      const taken = new Set(state.recipes.map((r) => r.id));
      saved = normalizeRecipe({ ...data, id: slugify(tr(title, "en")) }, taken);
      state.recipes.push(saved);
    }
    persist();
    dialog().close();

    const name = tr(saved.title);
    state.pages = buildPages();
    renderFilters();
    const target = pageOfRecipe(saved.id);
    if (target === -1) {
      state.index = normalizeIndex(state.index);
      renderStatic();
      toast(t("toast.hidden", { t: name }));
    } else if (wasEditing && normalizeIndex(target) === state.index) {
      renderStatic();
      toast(t("toast.updated", { t: name }));
    } else {
      state.index = normalizeIndex(state.index);
      renderStatic();
      flipTo(target);
      toast(t(wasEditing ? "toast.updated" : "toast.added", { t: name }));
    }
  }

  function deleteRecipe(id) {
    const r = state.recipes.find((x) => x.id === id);
    if (!r || !confirm(t("confirm.delete", { t: tr(r.title) }))) return;
    state.recipes = state.recipes.filter((x) => x.id !== id);
    persist();
    rebuild({ keepIndex: true });
    toast(t("toast.deleted", { t: tr(r.title) }));
  }

  // ---------- Import / export ----------
  function exportJSON() {
    const blob = new Blob([serialize(state.recipes)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "recipes.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t("toast.exported"));
  }

  async function importJSON(file) {
    try {
      const list = normalizeAll(JSON.parse(await file.text()));
      if (!confirm(t("confirm.import", { a: state.recipes.length, b: list.length, f: file.name }))) return;
      state.recipes = list;
      persist();
      rebuild();
      toast(t("toast.imported", { n: list.length }));
    } catch (err) {
      toast(t("toast.importFailed", { e: err.message }), 5000);
    }
  }

  async function resetToFile() {
    if (!isDirty()) return toast(t("toast.resetNothing"));
    if (!confirm(t("confirm.reset"))) return;
    store.del(STORE_KEY);
    await loadData();
    rebuild();
    updateSyncStatus();
    toast(t("toast.resetDone"));
  }

  // ---------- GitHub sync ----------
  function guessRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return { owner: "", repo: "" };
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner: m[1], repo: seg && !seg.includes(".") ? seg : `${m[1]}.github.io` };
  }

  function openGithub() {
    let saved = {};
    try { saved = JSON.parse(store.get(GH_KEY) || "{}"); } catch { /* ignore */ }
    const g = { ...guessRepo(), path: DATA_URL, branch: "main", ...saved };
    const f = $("#githubForm").elements;
    f.owner.value = g.owner;
    f.repo.value = g.repo;
    f.branch.value = g.branch;
    f.path.value = g.path;
    const remembered = store.get(GH_TOKEN_KEY);
    f.token.value = remembered || store.get(GH_TOKEN_KEY, sessionStorage) || "";
    f.remember.checked = !!remembered;
    $("#githubError").textContent = "";
    $("#githubDialog").showModal();
  }

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function githubError(res) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    if (res.status === 401) return new Error(t("gh.badCreds"));
    if (res.status === 403 || res.status === 404) return new Error(t("gh.perm", { msg }));
    return new Error(msg);
  }

  async function saveToGithub(e) {
    e.preventDefault();
    const f = $("#githubForm").elements;
    const cfg = {
      owner: f.owner.value.trim(),
      repo: f.repo.value.trim(),
      branch: f.branch.value.trim(),
      path: f.path.value.trim().replace(/^\/+/, ""),
    };
    const token = f.token.value.trim();
    const errEl = $("#githubError");
    errEl.textContent = "";
    if (!cfg.owner || !cfg.repo || !cfg.path || !token) return (errEl.textContent = t("gh.fill"));

    store.set(GH_KEY, JSON.stringify(cfg));
    if (f.remember.checked) {
      store.set(GH_TOKEN_KEY, token);
    } else {
      store.del(GH_TOKEN_KEY);
      store.set(GH_TOKEN_KEY, token, sessionStorage);
    }

    const btn = $("#githubSubmit");
    btn.disabled = true;
    btn.textContent = t("gh.committing");
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      let sha;
      const cur = await fetch(cfg.branch ? `${url}?ref=${encodeURIComponent(cfg.branch)}` : url, { headers, cache: "no-store" });
      if (cur.ok) sha = (await cur.json()).sha;
      else if (cur.status !== 404) throw await githubError(cur);

      const body = { message: t("gh.message", { n: state.recipes.length }), content: toBase64(serialize(state.recipes)) };
      if (sha) body.sha = sha;
      if (cfg.branch) body.branch = cfg.branch;
      const put = await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!put.ok) throw await githubError(put);

      // The browser copy stays until the redeployed site serves the same file.
      state.fileSnapshot = JSON.stringify(state.recipes);
      updateSyncStatus();
      $("#githubDialog").close();
      toast(t("toast.ghDone"), 4500);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = t("gh.submit");
    }
  }

  // ---------- Events ----------
  function bindEvents() {
    $("#prevBtn").addEventListener("click", prev);
    $("#nextBtn").addEventListener("click", next);

    $("#book").addEventListener("click", (e) => {
      const el = e.target.closest("[data-turn],[data-goto],[data-edit],[data-delete],[data-new],[data-clear]");
      if (!el || state.flipping) return;
      if (el.dataset.turn) return el.dataset.turn === "next" ? next() : prev();
      if (el.dataset.goto) return flipTo(Number(el.dataset.goto));
      if (el.dataset.edit) return openForm(state.recipes.find((r) => r.id === el.dataset.edit));
      if (el.dataset.delete) return deleteRecipe(el.dataset.delete);
      if ("new" in el.dataset) return openForm();
      if ("clear" in el.dataset) return clearFilters();
    });

    // Swipe
    let touch = null;
    $("#book").addEventListener("touchstart", (e) => {
      const p = e.changedTouches[0];
      touch = { x: p.clientX, y: p.clientY };
    }, { passive: true });
    $("#book").addEventListener("touchend", (e) => {
      if (!touch) return;
      const p = e.changedTouches[0];
      const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? next : prev)();
    }, { passive: true });

    document.addEventListener("keydown", (e) => {
      if (document.querySelector("dialog[open]") || e.target.closest("input, textarea, select")) return;
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Home") flipTo(0);
      else if (e.key === "Escape") closeMenu();
    });

    // Language
    $$(".lang-switch button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));

    // Filters
    $("#toggleFilters").addEventListener("click", () => {
      const panel = $("#filters");
      panel.hidden = !panel.hidden;
      $("#toggleFilters").setAttribute("aria-expanded", !panel.hidden);
    });
    $("#filters").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (chip) {
        const set = state.filters[chip.dataset.group];
        set.has(chip.dataset.key) ? set.delete(chip.dataset.key) : set.add(chip.dataset.key);
        return rebuild();
      }
      const mode = e.target.closest("#ingredientMode button");
      if (mode) {
        state.filters.ingredientMode = mode.dataset.mode;
        return rebuild();
      }
    });
    $("#ingredientSearch").addEventListener("input", (e) => {
      state.ingredientQuery = e.target.value;
      renderFilters();
    });
    $("#maxTime").addEventListener("input", (e) => {
      state.filters.maxTime = Number(e.target.value);
      rebuild();
    });
    let searchTimer;
    $("#search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filters.search = norm(e.target.value);
        rebuild();
      }, 200);
    });
    $("#clearFilters").addEventListener("click", clearFilters);

    // Recipe form
    $("#newRecipe").addEventListener("click", () => openForm());
    form().addEventListener("submit", saveForm);
    $$("#formLang button").forEach((b) => b.addEventListener("click", () => setFormLang(b.dataset.formLang)));
    const blank = () => Object.fromEntries(LANGS.map((l) => [l, ""]));
    $("#addIngredient").addEventListener("click", () => {
      captureForm();
      state.draft.ingredients.push({ amount: blank(), name: blank() });
      fillForm();
      $("#ingredientRows .row:last-child input").focus();
    });
    $("#addStep").addEventListener("click", () => {
      captureForm();
      state.draft.steps.push(blank());
      fillForm();
      $("#stepRows .row:last-child textarea").focus();
    });
    form().addEventListener("click", (e) => {
      const rm = e.target.closest("[data-remove]");
      if (!rm) return;
      const row = rm.closest(".row");
      const index = [...row.parentElement.children].indexOf(row);
      captureForm();
      state.draft[rm.dataset.remove].splice(index, 1); // removes the row in every language
      fillForm();
    });
    $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

    // Data menu
    $("#dataMenuBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = $("#dataMenu");
      menu.hidden = !menu.hidden;
      $("#dataMenuBtn").setAttribute("aria-expanded", !menu.hidden);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".menu")) closeMenu();
    });
    $("#dataMenu").addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      closeMenu();
      if (action === "export") exportJSON();
      if (action === "import") $("#importFile").click();
      if (action === "github") openGithub();
      if (action === "reset") resetToFile();
    });
    $("#importFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) importJSON(file);
    });
    $("#githubForm").addEventListener("submit", saveToGithub);

    // Responsive single/double page layout
    const mq = matchMedia("(max-width: 860px)");
    const applyMode = () => {
      const single = mq.matches;
      if (single === state.single && state.pages.length) return;
      const keep = state.index;
      state.single = single;
      $("#book").classList.toggle("single", single);
      state.pages = buildPages();
      state.index = normalizeIndex(keep);
      renderStatic();
    };
    mq.addEventListener("change", applyMode);
    applyMode();
  }

  function closeMenu() {
    $("#dataMenu").hidden = true;
    $("#dataMenuBtn").setAttribute("aria-expanded", "false");
  }

  function clearFilters() {
    const f = state.filters;
    [f.ingredients, f.preparation, f.category, f.cuisine, f.difficulty].forEach((s) => s.clear());
    f.maxTime = MAX_TIME;
    f.search = "";
    $("#search").value = "";
    state.ingredientQuery = "";
    $("#ingredientSearch").value = "";
    rebuild();
  }

  // ---------- Boot ----------
  async function init() {
    state.lang = initialLang();
    applyStaticText();
    await loadData();
    bindEvents();
    rebuild();
    updateSyncStatus();
  }

  init();
})();
