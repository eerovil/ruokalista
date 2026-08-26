# Screenshots

Review artifacts, not golden images — nothing compares them, so a font
rendering a pixel differently cannot fail a build. They are here so a pull
request can be looked at without running the app.

Taken on a Pixel 7 viewport, because a week gets planned at the kitchen table
and a recipe gets read at the hob.

Regenerate after a change that alters a screen:

    ./scripts/playwright.sh npx playwright test screenshots

| file | screen |
| --- | --- |
| `01-signin.png` | Sign-in — the one button |
| `02-week.png` | Proposed batch timeline: cooking marker, continuation rail and final portion |
| `03-picker.png` | The recipe picker, reached from a slot |
| `04-recipes.png` | The recipe list, newest first |
| `05-recipe.png` | One recipe: every awkward line shape, source lines underneath |
| `06-recipe-no-yield.png` | A recipe with no yield, saying it cannot be scaled |
| `07-intake.png` | Intake: paste a recipe, or photograph a page |
| `08-correct.png` | Check and correct, with the new ingredient marked |
| `09-gate-refused.png` | The approval gate refusing a save |
| `10-recipes-search.png` | Search results |
| `11-editor.png` | The recipe editor, with source text read-only below |
| `12-ingredients.png` | The shared ingredient list, with usage counts |
| `13-dish-in-parts.png` | Proposed semantic order: pre-work, two sauces, assembly |
| `14-scaled.png` | The same lasagne planned for 8, amounts rounded for a kitchen |
| `15-meal-actions.png` | Proposed whole-batch recipe, portions, continuation and removal actions |
| `18-keep-awake-fallback.png` | An older iPad's gesture-started keep-awake confirmation |
| `19-batch-coverage.png` | Proposed tap-based lunch/dinner coverage editor |
