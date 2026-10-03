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

## Recipe format

```json
{
  "id": "margherita-pizza",
  "title": "Margherita Pizza",
  "emoji": "🍕",
  "image": "https://… (optional)",
  "description": "…",
  "category": "Main",
  "preparation": "Baked",
  "cuisine": "Italian",
  "difficulty": "Easy | Medium | Hard",
  "prepTime": 90,
  "cookTime": 10,
  "servings": 2,
  "ingredients": [{ "amount": "300 g", "name": "flour" }],
  "steps": ["…"],
  "tags": ["vegetarian"]
}
```

Use the same ingredient name in every recipe (e.g. always `olive oil`) so the ingredient filter groups them.

## Run locally

There is no build step. Serve the folder over HTTP (the app needs `fetch`, so opening the file directly won't work):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deployment

`.github/workflows/pages.yml` validates `recipes.json` on every push and pull request, and deploys the site to GitHub Pages from the default branch.

To set it up once, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
