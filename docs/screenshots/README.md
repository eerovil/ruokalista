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
| `02-week.png` | Proposed grouped week: one card per cooked batch, with the meals it covers |
| `03-picker.png` | The recipe picker, reached from a slot |
| `04-recipes.png` | The recipe list, newest first |
| `05-recipe.png` | One recipe: every awkward line shape, source lines underneath |
| `06-recipe-no-yield.png` | A recipe with no yield, saying it cannot be scaled |
| `07-intake.png` | Intake: paste a recipe, or photograph a page |
| `08-correct.png` | Check and correct, with the new ingredient marked |
| `09-gate-refused.png` | The approval gate refusing a save |
| `10-recipes-search.png` | Search results |
| `11-editor.png` | The recipe editor: proposed compact ingredient rows and the always-visible `+ Lisää aines` |
| `12-ingredients.png` | The shared ingredient list, with usage counts |
| `13-dish-in-parts.png` | Proposed semantic order: pre-work, two sauces, assembly |
| `14-scaled.png` | The same lasagne planned for 8, amounts rounded for a kitchen |
| `15-meal-actions.png` | Proposed whole-batch recipe, portions, continuation and removal actions |
| `18-keep-awake-fallback.png` | An older iPad's gesture-started keep-awake confirmation |
| `19-batch-coverage.png` | Proposed tap-based lunch/dinner coverage editor |
| `20-agentdeck-batch-review.png` | Proposed AgentDeck bundle summary, ingredient decision and recipe preview |
| `21-agentdeck-stale-review.png` | Proposed stale ingredient review refusal before import |
| `24-multi-day-batch.png` | Proposed one card for a batch spanning three days beside a shorter one |
| `27-week-today.png` | Proposed current week: today highlighted with its `Tänään` badge |
| `28-week-not-admin.png` | Proposed account menu as an ordinary member sees it — sign-out and nothing else |
| `29-week-admin.png` | Proposed account menu as an admin sees it, with the one way into Ylläpito |
| `30-admin.png` | Proposed admin panel: recipe image management and the AgentDeck import |
| `32-admin-recipe-images.png` | Proposed picture list: missing, stale, current and manually added |
| `33-admin-recipe-images-confirm.png` | Proposed prompt to copy, the numbered manifest, and the sheet upload |
| `34-admin-recipe-images-done.png` | Proposed same screen after the browser cut a sheet and stored the crops |
| `32-generated-images.png` | Recipe list with every row pictured from one contact sheet |
| `33-generated-recipe.png` | One recipe with its picture from that sheet |
| `35-recipe-image-square.png` | Proposed recipe hero: a square generated picture shown whole rather than cropped into a strip |
| `36-week-empty-today.png` | Proposed empty current week as it opens — the viewport lands on today, not Monday (not full-page, on purpose) |
| `37-week-long-title.png` | Proposed long recipe name wrapping in the card head, beside the widest carried pill |
| `38-step-mentions-closed.png` | Proposed method with its ingredient mentions closed — ordinary instruction text |
| `39-step-mentions-open.png` | Proposed same method with two mentions tapped open, showing this meal's amounts inline |
| `40-step-mention-all-amounts.png` | Proposed duplicated ingredient mention showing every distinct stated amount inline |
| `40-shopping-pantry.png` | Proposed shopping list split in two: Ostettavat, then a Löytyy section keeping the cupboard's staples and their amounts |
| `41-pantry.png` | Proposed cupboard page: only what the household keeps in, each with the way to say it ran out |
| `42-admin-households.png` | Proposed household list, including the household this admin does not belong to |
| `43-admin-household.png` | Proposed household detail: the name, the members, and one member row opened for editing |
| `44-admin-member-refused.png` | Proposed refusal when an admin's Google sub is repointed — admin travels with the sub, so this stays an operator action |
| `45-admin-household-after-removal.png` | Proposed household after an established member is removed — no refusal, and the household stands |
| `46-recipes-after-removal.png` | Proposed recipe list after that removal: the recipes are still there and still credited to the person who wrote them |
| `47-admin-member-sub-refused.png` | Proposed refusal of something that is not a Google identifier — the contract the removed-member tombstone is kept outside of |
| `47-editor-remove-mentioned.png` | Proposed refusal when a linked row is repointed and removed together but the step still names its saved ingredient, with the step quoted and the forced-removal escape hatch |
| `48-step-mentions-all-open.png` | Proposed recipe-wide amount toggle with every ingredient amount revealed in the preparation sentences |
| `49-covered-days.png` | Proposed covered days: two recipes continuing into Tuesday, one covering both of Wednesday's meals, `katettu` in each heading and both add links still there (not full-page, on purpose) |
