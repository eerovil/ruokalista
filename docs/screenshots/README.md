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
| `02-recipes.png` | The recipe list, newest first |
| `03-recipe.png` | One recipe: every awkward line shape, source lines underneath |
| `04-recipe-no-yield.png` | A recipe with no yield, saying it cannot be scaled |
| `05-intake.png` | Intake: paste a recipe, or photograph a page |
| `06-correct.png` | Check and correct, with the new ingredient marked |
| `07-gate-refused.png` | The approval gate refusing a save |
| `08-recipes-search.png` | Search results |

The week screen, the recipe editor and the ingredients screen are not built
yet, so they are not here.
