/* Family Cookbook — a static, flip-page recipe book.
 *
 * Data flow:
 *   data/recipes.json  ──fetch──▶  recipes (in memory)  ──▶ book pages
 *   Edits are kept in localStorage until they are exported (Download JSON)
 *   or committed back to data/recipes.json through the GitHub contents API.
 */
(() => {
  "use strict";

  const DATA_URL = "data/recipes.json";
  const STORE_KEY = "cookbook.recipes.v1";
  const GH_KEY = "cookbook.github.v1";
  const GH_TOKEN_KEY = "cookbook.github.token";
  const MAX_TIME = 240;
  const DIFFICULTIES = ["Easy", "Medium", "Hard"];
  const DEFAULT_PREPARATIONS = ["Baked", "Roasted", "Grilled", "Fried", "Pan-fried", "Stir-fried", "Boiled", "Simmered", "Steamed", "Slow-cooked", "Raw", "No-bake"];
  const DEFAULT_CATEGORIES = ["Breakfast", "Starter", "Soup", "Salad", "Main", "Side", "Dessert", "Snack", "Drink"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    recipes: [],
    fileSnapshot: "[]", // JSON of recipes.json as last loaded / committed
    pages: [],
    index: 0, // left page index in spread mode, page index in single mode
    single: false,
    flipping: false,
    editingId: null,
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
  const slugify = (s) => norm(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";
  const totalTime = (r) => (Number(r.prepTime) || 0) + (Number(r.cookTime) || 0);
  const fmtTime = (m) => {
    m = Number(m) || 0;
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  };
  const store = {
    get(key, area = localStorage) { try { return area.getItem(key); } catch { return null; } },
    set(key, val, area = localStorage) { try { area.setItem(key, val); } catch { /* storage unavailable */ } },
    del(key, area = localStorage) { try { area.removeItem(key); } catch { /* storage unavailable */ } },
  };

  let toastTimer;
  function toast(msg, ms = 2800) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- Data ----------
  function normalizeRecipe(r, taken = new Set()) {
    const out = {
      id: String(r.id || "").trim() || slugify(r.title),
      title: String(r.title || "Untitled recipe").trim(),
      emoji: String(r.emoji || "🍽️").trim(),
      description: String(r.description || "").trim(),
      category: String(r.category || "").trim(),
      preparation: String(r.preparation || "").trim(),
      cuisine: String(r.cuisine || "").trim(),
      difficulty: DIFFICULTIES.includes(r.difficulty) ? r.difficulty : "Easy",
      prepTime: Math.max(0, parseInt(r.prepTime, 10) || 0),
      cookTime: Math.max(0, parseInt(r.cookTime, 10) || 0),
      servings: Math.max(1, parseInt(r.servings, 10) || 1),
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients : [])
        .map((i) => (typeof i === "string" ? { amount: "", name: i } : { amount: String(i.amount || "").trim(), name: String(i.name || "").trim() }))
        .filter((i) => i.name),
      steps: (Array.isArray(r.steps) ? r.steps : []).map((s) => String(s).trim()).filter(Boolean),
      tags: (Array.isArray(r.tags) ? r.tags : String(r.tags || "").split(",")).map((t) => String(t).trim()).filter(Boolean),
    };
    if (r.image) out.image = String(r.image).trim();
    if (r.notes) out.notes = String(r.notes).trim();
    let id = out.id, n = 2;
    while (taken.has(id)) id = `${out.id}-${n++}`;
    out.id = id;
    taken.add(id);
    return out;
  }

  function normalizeAll(list) {
    if (!Array.isArray(list)) throw new Error("Expected a JSON array of recipes.");
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
      toast(`Could not load ${DATA_URL}: ${err.message}`, 5000);
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
    $("#syncDot").title = dirty ? "Unsaved changes" : "In sync with recipes.json";
    $("#syncStatus").textContent = dirty
      ? "Your edits are saved in this browser only. Download or save to GitHub to update recipes.json."
      : "Everything matches recipes.json.";
  }

  // ---------- Filtering ----------
  function activeFilterCount() {
    const f = state.filters;
    return f.ingredients.size + f.preparation.size + f.category.size + f.cuisine.size + f.difficulty.size + (f.maxTime < MAX_TIME ? 1 : 0);
  }

  function matches(r) {
    const f = state.filters;
    if (f.search) {
      const hay = norm([r.title, r.description, r.category, r.preparation, r.cuisine, r.tags.join(" "), r.ingredients.map((i) => i.name).join(" ")].join(" "));
      if (!f.search.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (f.ingredients.size) {
      const names = new Set(r.ingredients.map((i) => norm(i.name)));
      const sel = [...f.ingredients];
      const ok = f.ingredientMode === "all" ? sel.every((n) => names.has(n)) : sel.some((n) => names.has(n));
      if (!ok) return false;
    }
    if (f.preparation.size && !f.preparation.has(norm(r.preparation))) return false;
    if (f.category.size && !f.category.has(norm(r.category))) return false;
    if (f.cuisine.size && !f.cuisine.has(norm(r.cuisine))) return false;
    if (f.difficulty.size && !f.difficulty.has(norm(r.difficulty))) return false;
    if (f.maxTime < MAX_TIME && totalTime(r) > f.maxTime) return false;
    return true;
  }

  const filteredRecipes = () =>
    state.recipes.filter(matches).sort((a, b) => a.title.localeCompare(b.title));

  /** Distinct values of a recipe field: [{key, label, count}] */
  function facet(getValues) {
    const map = new Map();
    for (const r of state.recipes) {
      for (const v of getValues(r)) {
        const key = norm(v);
        if (!key) continue;
        const e = map.get(key) || { key, label: v.trim(), count: 0 };
        e.count++;
        map.set(key, e);
      }
    }
    return [...map.values()];
  }

  function chipHTML(group, { key, label, count }, selected) {
    return `<button type="button" class="chip" data-group="${group}" data-key="${esc(key)}" aria-pressed="${selected.has(key)}">${esc(label)}${count != null ? `<span class="n">${count}</span>` : ""}</button>`;
  }

  function renderFilters() {
    const f = state.filters;
    const facets = {
      ingredients: facet((r) => r.ingredients.map((i) => i.name)).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      preparation: facet((r) => [r.preparation]).sort((a, b) => a.label.localeCompare(b.label)),
      category: facet((r) => [r.category]).sort((a, b) => a.label.localeCompare(b.label)),
      cuisine: facet((r) => [r.cuisine]).sort((a, b) => a.label.localeCompare(b.label)),
      difficulty: facet((r) => [r.difficulty]).sort((a, b) => DIFFICULTIES.indexOf(a.label) - DIFFICULTIES.indexOf(b.label)),
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
    $("#ingredientChips").innerHTML = ing.map((i) => chipHTML("ingredients", i, f.ingredients)).join("") || `<span class="muted">No ingredients match “${esc(state.ingredientQuery)}”.</span>`;
    $("#preparationChips").innerHTML = facets.preparation.map((i) => chipHTML("preparation", i, f.preparation)).join("");
    $("#categoryChips").innerHTML = facets.category.map((i) => chipHTML("category", i, f.category)).join("");
    $("#cuisineChips").innerHTML = facets.cuisine.map((i) => chipHTML("cuisine", i, f.cuisine)).join("");
    $("#difficultyChips").innerHTML = facets.difficulty.map((i) => chipHTML("difficulty", i, f.difficulty)).join("");

    $$(".seg button").forEach((b) => {
      const on = b.dataset.mode === f.ingredientMode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });
    $("#maxTime").value = f.maxTime;
    $("#maxTimeLabel").textContent = f.maxTime >= MAX_TIME ? "Any" : `≤ ${fmtTime(f.maxTime)}`;

    const count = activeFilterCount();
    $("#filterCount").hidden = count === 0;
    $("#filterCount").textContent = count;
    const shown = state.recipes.filter(matches).length;
    $("#resultCount").textContent = `Showing ${shown} of ${state.recipes.length} recipe${state.recipes.length === 1 ? "" : "s"}`;

    // Suggestions for the recipe form
    const fill = (id, defaults, values) => {
      const all = [...new Set([...values, ...defaults])].sort((a, b) => a.localeCompare(b));
      $(id).innerHTML = all.map((v) => `<option value="${esc(v)}"></option>`).join("");
    };
    fill("#dl-preparation", DEFAULT_PREPARATIONS, facets.preparation.map((i) => i.label));
    fill("#dl-category", DEFAULT_CATEGORIES, facets.category.map((i) => i.label));
    fill("#dl-cuisine", [], facets.cuisine.map((i) => i.label));
  }

  // ---------- Book pages ----------
  function buildPages() {
    const list = filteredRecipes();
    const pages = [{ type: "title", shown: list.length }];
    const perToc = state.single ? 10 : 11;
    const recipeStart = (tocCount) => {
      const front = 1 + tocCount;
      return front + (front % 2); // recipes always start on a left (even) page
    };
    const tocCount = Math.max(1, Math.ceil(list.length / perToc));
    const start = recipeStart(tocCount);
    for (let t = 0; t < tocCount; t++) {
      pages.push({
        type: "toc",
        part: t,
        parts: tocCount,
        items: list.slice(t * perToc, (t + 1) * perToc).map((r) => ({ r, page: start + list.indexOf(r) * 2 })),
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

  function renderPageContent(p) {
    switch (p.type) {
      case "title": {
        const total = state.recipes.length;
        const filtered = p.shown !== total;
        return `
          <div class="title-page">
            <div class="big-emoji">🍳</div>
            <h1>The Family<br>Cookbook</h1>
            <div class="subtitle">recipes worth passing on</div>
            <div class="ornament">❦ ❦ ❦</div>
            <div class="count">${total} recipe${total === 1 ? "" : "s"} collected${filtered ? `<br>${p.shown} match your filters` : ""}</div>
          </div>`;
      }
      case "toc": {
        if (!p.items.length) {
          return `
            <div class="toc">
              <h2>Contents</h2>
              <div class="empty-state">
                <div class="big-emoji">🧺</div>
                <p>${state.recipes.length ? "No recipes match your filters." : "This book is still empty."}</p>
                ${state.recipes.length ? `<button class="ink-btn" data-clear>Clear filters</button>` : `<button class="ink-btn" data-new>Write the first recipe</button>`}
              </div>
            </div>`;
        }
        return `
          <div class="toc">
            <h2>Contents</h2>
            <div class="toc-sub">${p.parts > 1 ? `part ${p.part + 1} of ${p.parts}` : "a table of good things"}</div>
            <ol>
              ${p.items.map(({ r, page }) => `
                <li><button class="toc-item" data-goto="${page}" title="${esc(r.title)}">
                  <span class="toc-emoji">${esc(r.emoji)}</span>
                  <span class="toc-title">${esc(r.title)}</span>
                  <span class="toc-dots"></span>
                  <span class="toc-meta">${esc(r.preparation)}</span>
                  <span class="toc-page">${page + 1}</span>
                </button></li>`).join("")}
            </ol>
          </div>`;
      }
      case "recipe-a": {
        const r = p.recipe;
        const art = r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : esc(r.emoji);
        return `
          <div class="recipe-head">
            <div class="recipe-art">${art}</div>
            <h2>${esc(r.title)}</h2>
          </div>
          ${r.description ? `<p class="recipe-desc">${esc(r.description)}</p>` : ""}
          <div class="tags-row">
            ${r.preparation ? `<span class="tag prep">${esc(r.preparation)}</span>` : ""}
            ${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}
            ${r.cuisine ? `<span class="tag">${esc(r.cuisine)}</span>` : ""}
          </div>
          <div class="stats">
            <div><b>${fmtTime(r.prepTime)}</b><span>Prep</span></div>
            <div><b>${fmtTime(r.cookTime)}</b><span>Cook</span></div>
            <div><b>${r.servings}</b><span>Serves</span></div>
            <div><b>${esc(r.difficulty)}</b><span>Level</span></div>
          </div>
          <h3 class="section-title">Ingredients</h3>
          <ul class="ingredients">
            ${r.ingredients.map((i) => `<li><label><input type="checkbox"><span>${i.amount ? `<span class="amt">${esc(i.amount)}</span> ` : ""}${highlightIngredient(i.name)}</span></label></li>`).join("")}
          </ul>`;
      }
      case "recipe-b": {
        const r = p.recipe;
        return `
          <h3 class="section-title">Method</h3>
          ${r.steps.length ? `<ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<p class="muted">No steps written yet.</p>`}
          ${r.notes ? `<div class="note-card">${esc(r.notes)}</div>` : ""}
          ${r.tags.length ? `<div class="tags-row">${r.tags.map((t) => `<span class="tag plain">#${esc(t)}</span>`).join("")}</div>` : ""}
          <div class="recipe-actions">
            <button class="ink-btn" data-edit="${esc(r.id)}">✎ Edit</button>
            <button class="ink-btn danger" data-delete="${esc(r.id)}">🗑 Delete</button>
          </div>`;
      }
      case "notes":
        return `
          <h3 class="section-title">Kitchen notes</h3>
          <div class="note-card">Taste as you go.<br>Salt the pasta water like the sea.<br>Let meat rest before slicing.<br>Read the whole recipe first!</div>`;
      case "end":
        return `
          <div class="end-page">
            <div class="big-emoji">✍️</div>
            <h2>Room for one more?</h2>
            <p class="muted">Every good cookbook has a few blank pages.</p>
            <button class="ink-btn" data-new>Write a new recipe</button>
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
      if ((side === "left" || side === "single") && canPrev) corners += `<button class="corner prev" data-turn="prev" aria-label="Previous page"></button>`;
      if ((side === "right" || side === "single") && canNext) corners += `<button class="corner next" data-turn="next" aria-label="Next page"></button>`;
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
  const dialog = () => $("#recipeDialog");
  const form = () => $("#recipeForm");

  function ingredientRow(i = { amount: "", name: "" }) {
    const row = document.createElement("div");
    row.className = "row ing";
    row.innerHTML = `
      <input data-f="amount" placeholder="200 g" value="${esc(i.amount)}" aria-label="Amount">
      <input data-f="name" placeholder="ingredient" value="${esc(i.name)}" list="dl-ingredients" aria-label="Ingredient">
      <button type="button" class="remove" aria-label="Remove ingredient">✕</button>`;
    return row;
  }

  function stepRow(text = "") {
    const row = document.createElement("div");
    row.className = "row step";
    row.innerHTML = `
      <span class="num"></span>
      <textarea rows="2" data-f="step" placeholder="Describe this step…" aria-label="Step">${esc(text)}</textarea>
      <button type="button" class="remove" aria-label="Remove step">✕</button>`;
    return row;
  }

  function renumberSteps() {
    $$("#stepRows .row").forEach((row, i) => ($(".num", row).textContent = i + 1));
  }

  function ensureIngredientDatalist() {
    let dl = $("#dl-ingredients");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "dl-ingredients";
      document.body.appendChild(dl);
    }
    const names = [...new Set(state.recipes.flatMap((r) => r.ingredients.map((i) => norm(i.name))))].sort();
    dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
  }

  function openForm(recipe = null) {
    state.editingId = recipe ? recipe.id : null;
    $("#recipeDialogTitle").textContent = recipe ? "Edit recipe" : "New recipe";
    $("#formError").textContent = "";
    const f = form();
    f.reset();
    const r = recipe || { difficulty: "Easy", prepTime: 0, cookTime: 0, servings: 4, ingredients: [], steps: [], tags: [] };
    for (const name of ["title", "emoji", "description", "preparation", "category", "cuisine", "difficulty", "prepTime", "cookTime", "servings", "image"]) {
      if (f.elements[name]) f.elements[name].value = r[name] ?? "";
    }
    f.elements.tags.value = (r.tags || []).join(", ");

    const ing = $("#ingredientRows");
    ing.innerHTML = "";
    (r.ingredients.length ? r.ingredients : [{}, {}, {}]).forEach((i) => ing.appendChild(ingredientRow(i)));
    const steps = $("#stepRows");
    steps.innerHTML = "";
    (r.steps.length ? r.steps : ["", ""]).forEach((s) => steps.appendChild(stepRow(s)));
    renumberSteps();
    ensureIngredientDatalist();

    dialog().showModal();
    f.elements.title.focus();
  }

  function readForm() {
    const f = form().elements;
    return {
      title: f.title.value.trim(),
      emoji: f.emoji.value.trim() || "🍽️",
      description: f.description.value.trim(),
      preparation: f.preparation.value.trim(),
      category: f.category.value.trim(),
      cuisine: f.cuisine.value.trim(),
      difficulty: f.difficulty.value,
      prepTime: f.prepTime.value,
      cookTime: f.cookTime.value,
      servings: f.servings.value,
      image: f.image.value.trim(),
      tags: f.tags.value,
      ingredients: $$("#ingredientRows .row").map((row) => ({ amount: $('[data-f="amount"]', row).value, name: $('[data-f="name"]', row).value })),
      steps: $$("#stepRows textarea").map((t) => t.value),
    };
  }

  function saveForm(e) {
    e.preventDefault();
    const data = readForm();
    const err = $("#formError");
    if (!data.title) return (err.textContent = "Please give the recipe a title.");
    if (!data.preparation) return (err.textContent = "Please choose a preparation type.");
    if (!data.ingredients.some((i) => i.name.trim())) return (err.textContent = "Add at least one ingredient.");
    if (!data.steps.some((s) => s.trim())) return (err.textContent = "Add at least one step.");

    let saved;
    if (state.editingId) {
      const idx = state.recipes.findIndex((r) => r.id === state.editingId);
      const old = state.recipes[idx];
      const others = new Set(state.recipes.filter((r) => r.id !== old.id).map((r) => r.id));
      saved = normalizeRecipe({ ...old, ...data, id: old.id, image: data.image || undefined }, others);
      state.recipes[idx] = saved;
    } else {
      const taken = new Set(state.recipes.map((r) => r.id));
      saved = normalizeRecipe({ ...data, id: slugify(data.title) }, taken);
      state.recipes.push(saved);
    }
    persist();
    dialog().close();

    const wasEditing = !!state.editingId;
    state.pages = buildPages();
    renderFilters();
    const target = pageOfRecipe(saved.id);
    if (target === -1) {
      state.index = normalizeIndex(state.index);
      renderStatic();
      toast(`“${saved.title}” saved — hidden by the current filters.`);
    } else if (wasEditing && normalizeIndex(target) === state.index) {
      renderStatic();
      toast(`“${saved.title}” updated.`);
    } else {
      state.index = normalizeIndex(Math.min(state.index, state.pages.length - 1));
      renderStatic();
      flipTo(target);
      toast(`“${saved.title}” ${wasEditing ? "updated" : "added to the book"}.`);
    }
  }

  function deleteRecipe(id) {
    const r = state.recipes.find((x) => x.id === id);
    if (!r || !confirm(`Delete “${r.title}”? This cannot be undone.`)) return;
    state.recipes = state.recipes.filter((x) => x.id !== id);
    persist();
    rebuild({ keepIndex: true });
    toast(`“${r.title}” deleted.`);
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
    toast("Downloaded recipes.json — replace data/recipes.json in the repo with it.");
  }

  async function importJSON(file) {
    try {
      const list = normalizeAll(JSON.parse(await file.text()));
      if (!confirm(`Replace the current ${state.recipes.length} recipes with ${list.length} recipes from “${file.name}”?`)) return;
      state.recipes = list;
      persist();
      rebuild();
      toast(`Imported ${list.length} recipes.`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 5000);
    }
  }

  async function resetToFile() {
    if (!isDirty()) return toast("Nothing to discard — you're in sync with recipes.json.");
    if (!confirm("Discard all changes made in this browser and reload recipes.json?")) return;
    store.del(STORE_KEY);
    await loadData();
    rebuild();
    updateSyncStatus();
    toast("Reloaded recipes.json.");
  }

  // ---------- GitHub sync ----------
  function guessRepo() {
    const host = location.hostname;
    const m = host.match(/^([^.]+)\.github\.io$/i);
    if (!m) return { owner: "", repo: "" };
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner: m[1], repo: seg && !seg.includes(".") ? seg : `${m[1]}.github.io` };
  }

  function openGithub() {
    let saved = {};
    try { saved = JSON.parse(store.get(GH_KEY) || "{}"); } catch { /* ignore */ }
    const g = { ...guessRepo(), path: DATA_URL, branch: "", ...saved };
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
    if (res.status === 401) msg = "Bad credentials — check the token.";
    if (res.status === 403 || res.status === 404) msg += " — does the token have Contents: read & write on this repo?";
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
    if (!cfg.owner || !cfg.repo || !cfg.path || !token) return (errEl.textContent = "Please fill in owner, repository, path and token.");

    store.set(GH_KEY, JSON.stringify(cfg));
    if (f.remember.checked) {
      store.set(GH_TOKEN_KEY, token);
    } else {
      store.del(GH_TOKEN_KEY);
      store.set(GH_TOKEN_KEY, token, sessionStorage);
    }

    const btn = $("#githubSubmit");
    btn.disabled = true;
    btn.textContent = "Committing…";
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      let sha;
      const cur = await fetch(cfg.branch ? `${url}?ref=${encodeURIComponent(cfg.branch)}` : url, { headers, cache: "no-store" });
      if (cur.ok) sha = (await cur.json()).sha;
      else if (cur.status !== 404) throw await githubError(cur);

      const body = { message: `Update recipes (${state.recipes.length} recipes) from the cookbook app`, content: toBase64(serialize(state.recipes)) };
      if (sha) body.sha = sha;
      if (cfg.branch) body.branch = cfg.branch;
      const put = await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!put.ok) throw await githubError(put);

      // The browser copy stays until the redeployed site serves the same file.
      state.fileSnapshot = JSON.stringify(state.recipes);
      updateSyncStatus();
      $("#githubDialog").close();
      toast("Committed to GitHub. The site will redeploy in about a minute.", 4500);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Commit recipes.json";
    }
  }

  // ---------- Events ----------
  function bindEvents() {
    $("#prevBtn").addEventListener("click", prev);
    $("#nextBtn").addEventListener("click", next);

    $("#book").addEventListener("click", (e) => {
      const t = e.target.closest("[data-turn],[data-goto],[data-edit],[data-delete],[data-new],[data-clear]");
      if (!t || state.flipping) return;
      if (t.dataset.turn) return t.dataset.turn === "next" ? next() : prev();
      if (t.dataset.goto) return flipTo(Number(t.dataset.goto));
      if (t.dataset.edit) return openForm(state.recipes.find((r) => r.id === t.dataset.edit));
      if (t.dataset.delete) return deleteRecipe(t.dataset.delete);
      if ("new" in t.dataset) return openForm();
      if ("clear" in t.dataset) return clearFilters();
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
      const mode = e.target.closest(".seg button");
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
    $("#addIngredient").addEventListener("click", () => {
      const row = ingredientRow();
      $("#ingredientRows").appendChild(row);
      $("input", row).focus();
    });
    $("#addStep").addEventListener("click", () => {
      const row = stepRow();
      $("#stepRows").appendChild(row);
      renumberSteps();
      $("textarea", row).focus();
    });
    form().addEventListener("click", (e) => {
      const rm = e.target.closest(".remove");
      if (!rm) return;
      rm.closest(".row").remove();
      renumberSteps();
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
    await loadData();
    bindEvents();
    rebuild();
    updateSyncStatus();
  }

  init();
})();
