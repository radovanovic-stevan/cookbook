# 📖 Family Cookbook

A static, flip-through cookbook. Recipes live in [`data/recipes.json`](data/recipes.json) and are shown as a two-page book with animated page turns. On phones it shows one page at a time.

## Features

- **Flip-page book**: title page, contents, then one spread per recipe (ingredients on the left, method on the right). Turn pages with the arrows, the page corners, ← / → keys or by swiping. Click an entry in the contents to jump to that recipe.
- **CRUD**: add a recipe with **+ New recipe**, or use the **Edit** and **Delete** buttons on its method page.
- **Filters**:
  - ingredients (multi-select, *has all* or *has any*)
  - preparation type (baked, grilled, steamed…)
  - course
  - cuisine
  - difficulty
  - maximum total time
  - free-text search
- **JSON storage**: the book loads `data/recipes.json`. GitHub Pages can't write files, so your edits are kept in the browser until you save them with the **Data** menu:
  - **Download recipes.json**: download the file and commit it to `data/recipes.json`.
  - **Save to GitHub…**: commit `data/recipes.json` straight from the page with a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) that has *Contents: read & write* on this repo. The commit redeploys the site.
  - **Import recipes.json…** / **Discard browser changes**.

  The dot on the **Data** button turns orange when the browser has changes that aren't in `recipes.json` yet.

## Languages

The interface is available in **English** and **Serbian** (Latin script). Use the **EN | SR** switch in the top bar. The choice is remembered. You can also link to a language with `?lang=sr` or `?lang=en`. On first visit the language is picked from the browser's language settings.

Interface strings live in [`js/i18n.js`](js/i18n.js).

Recipes can be translated too. Any text field can be a plain string, used for both languages, or an object with one value per language. Steps and tags can be a plain array, or one array per language. If a translation is missing, the other language is shown, along with a small "not fully translated yet" note.

In the recipe form, **Writing in English / Srpski** chooses which language you are editing. Switch it to add a translation. Text not yet translated shows the other language in grey as a hint. Selected filters carry over when you switch language, and search matches both languages.

## Recipe format

```json
{
  "id": "margherita-pizza",
  "title": { "en": "Margherita Pizza", "sr": "Pica margarita" },
  "emoji": "🍕",
  "image": "https://… (optional)",
  "description": { "en": "…", "sr": "…" },
  "category": { "en": "Main", "sr": "Glavno jelo" },
  "preparation": { "en": "Baked", "sr": "Pečeno u rerni" },
  "cuisine": { "en": "Italian", "sr": "Italijanska" },
  "difficulty": "Easy | Medium | Hard",
  "prepTime": 90,
  "cookTime": 10,
  "servings": 2,
  "ingredients": [
    { "amount": "300 g", "name": { "en": "flour", "sr": "brašno" } },
    { "amount": { "en": "2 tbsp", "sr": "2 kašike" }, "name": { "en": "olive oil", "sr": "maslinovo ulje" } }
  ],
  "steps": { "en": ["…"], "sr": ["…"] },
  "tags": { "en": ["vegetarian"], "sr": ["vegetarijansko"] }
}
```

The simple form, `"title": "Margherita Pizza"` and `"steps": ["…"]`, still works. Use the same ingredient name in every recipe (e.g. always `olive oil` / `maslinovo ulje`) so the ingredient filter groups them.

## Run locally

There is no build step. Serve the folder over HTTP (the app needs `fetch`, so opening the file directly won't work):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deployment

`.github/workflows/pages.yml` validates `recipes.json` on every push and pull request, and deploys the site to GitHub Pages from the default branch.

To set it up once, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
