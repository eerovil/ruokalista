# Screenshots

Review artifacts, not golden images — nothing compares them, so a font
rendering a pixel differently cannot fail a build. They are here so a pull
request can be looked at without running the app.

Taken on a Pixel 7 viewport, because a week gets planned at the kitchen table
and a recipe gets read at the hob.

The flows and assertions in `screenshots.spec.ts` run in every ordinary suite.
Writing these review artifacts is deliberate because nothing compares their PNG
bytes: set `PLAYWRIGHT_SCREENSHOTS=1` after a change that alters a screen, and
commit what it wrote:

    PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots

The last two are the exception: they are written by
`tests/shopping-row-213.spec.ts` instead, because what they show is a row on a
320 px screen rather than on the Pixel 7 every other picture here is taken on.
The same environment variable gates them.

    PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test shopping-row-213

| file | screen |
| --- | --- |
| `01-signin.png` | Sign-in — the one button |
| `02-week.png` | Proposed grouped week: one card per cooked batch, with the meals it covers |
| `03-picker.png` | The recipe picker, reached from a slot |
| `04-recipes.png` | The recipe list, newest first |
| `05-recipe.png` | One recipe: every awkward line shape, source lines underneath |
| `06-recipe-no-yield.png` | Proposed recipe whose source never stated a yield, scaled to 2× anyway (#165) |
| `07-intake.png` | Intake: paste a recipe, take a photograph of a page, or choose pictures of one |
| `08-correct.png` | Check and correct, with the new ingredient marked |
| `09-gate-refused.png` | The approval gate refusing a save |
| `10-recipes-search.png` | Search results |
| `11-editor.png` | The recipe editor: proposed compact ingredient rows and the always-visible `+ Lisää aines` |
| `12-ingredients.png` | The shared ingredient list, with usage counts |
| `13-dish-in-parts.png` | Proposed semantic order: pre-work, two sauces, assembly |
| `14-scaled.png` | Proposed same lasagne at 1,5×, amounts rounded for a kitchen |
| `15-meal-actions.png` | Proposed whole-batch recipe, multiplier chips, continuation and removal actions |
| `18-keep-awake-fallback.png` | An older iPad's gesture-started keep-awake confirmation |
| `19-batch-coverage.png` | Proposed tap-based lunch/dinner coverage editor |
| `20-agentdeck-batch-review.png` | Proposed AgentDeck bundle summary, ingredient decision and recipe preview |
| `21-agentdeck-stale-review.png` | Proposed stale ingredient review refusal before import |
| `24-multi-day-batch.png` | Proposed one card for a batch spanning three days beside a shorter one |
| `27-week-today.png` | Proposed current week: today highlighted with its `Tänään` badge |
| `28-week-not-admin.png` | Proposed account menu as an ordinary member sees it — sign-out and nothing else |
| `29-week-admin.png` | Proposed account menu as an admin sees it, with the one way into Ylläpito |
| `30-admin.png` | Proposed admin panel: recipe image management and the AgentDeck import |
| `32-admin-recipe-images.png` | Proposed all-household admin picture list: missing, stale, current and manually added |
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
| `47-admin-member-sub-refused.png` | Proposed email-only member form refusing an address that already belongs to an active member (#187) |
| `47-editor-remove-mentioned.png` | Proposed refusal when a linked row is repointed and removed together but the step still names its saved ingredient, with the step quoted and the forced-removal escape hatch |
| `48-step-mentions-all-open.png` | Proposed recipe-wide amount toggle with every ingredient amount revealed in the preparation sentences |
| `49-covered-days.png` | Proposed covered days: two recipes continuing into Tuesday, one covering both of Wednesday's meals, `katettu` in each heading and both add links still there (not full-page, on purpose) |
| `50-recipes-select-to-publish.png` | Proposed recipe list with two recipes selected for the bulk publish action |
| `51-recipes-published.png` | Proposed same list afterwards: what was published says so on the row, and the action reports what happened |
| `52-recipe-owner-sharing.png` | Proposed owner's view of a published recipe: this household's own default multiplier, and the control to take the publication back |
| `68-recipe-selected-sharing.png` | Proposed owner view after sharing a recipe with one selected household, including the searchable household-only recipient picker |
| `53-public-recipes.png` | Proposed public section as the other household sees it — recipes from all households, each credited to the one that shared it |
| `54-public-recipe-read-only.png` | Proposed public recipe read by a non-owner: whose it is said under the title, and no way to edit it |
| `55-unpublish-refused.png` | Proposed refusal when unpublishing would pull a recipe out from under another household's future cooking |
| `56-intake-two-pages.png` | Proposed intake with a recipe printed across a spread: page one shot with the camera, page two picked from the library, both numbered in reading order and both bound for one recipe |
| `57-intake-requires-javascript.png` | Proposed intake without JavaScript: the requirement is stated in Finnish and structuring stays unavailable |
| `59-s-ostoslista-waits-for-product.png` | Proposed S-ostoslista send while an optimistic product choice is still saving: the chosen product stays visible and the send button says it is finishing that choice first |
| `60-product-scope-choice.png` | Proposed product panel with #161's one extra question: whether this choice is always this ingredient's, or only this recipe's — and each result showing the packet size read off its name |
| `61-package-count.png` | Proposed shopping row buying two litres of milk because the week needs fifteen decilitres, with what the packets hold said underneath |
| `62-package-sizes.png` | Proposed same ingredient after a second package size was added from the row itself, each with its stored size and a way to drop it |
| `63-cast-receiver.png` | Proposed 16:9 Cast receiver with the recipe title and multiplier above ingredients and preparation shown together |
| `64-cast-receiver-long.png` | Proposed 20-line recipe on a 1024×600 receiver: the ingredients flow into two sub-columns instead of shrinking to the scale floor (#180) |
| `65-editor-save-bar.png` | Proposed editor on a phone, scrolled to the ingredient rows: **Tallenna muutokset** rides the scroll just above the tab strip instead of waiting at the end of the form (#184) |
| `66-parts-only-editor.png` | Proposed editor of a dish written entirely in named parts — no ingredient rows of its own, and no refusal (#184) |
| `67-parts-only-dish.png` | The same dish after saving: both parts and their ingredients intact, the dish itself carrying only its method |
| `69-alternative-editor.png` | Proposed editor with two rows given the same alternative group number — the box that makes a `tai` line, beside the part and phase fields |
| `70-alternative-recipe.png` | Proposed recipe screen reading `½ dl öljy tai ½ dl margariini` as one row: each option with its own amount and unit, joined by the word |
| `71-alternative-shopping.png` | Proposed shopping list for that cooking: the first option is bought and the second is not there at all |
| `72-alternative-scaled-source.png` | Proposed imported choice at 2×: both options scaled, and the source sentence they share stated once for the row instead of repeated under each (#183 review) |
| `75-recipe-category-editor.png` | Proposed category picker in the recipe editor: checkboxes, two ticked, no heavier than the fields around it (#196) |
| `76-recipe-categories.png` | Proposed recipe screen carrying its categories under the title, beside the rest of the dish's own facts |
| `77-recipes-category-filter.png` | Proposed recipe list standing in **Uuniruoka**: the scrolling chip row above, only the recipes in that category below |
| `78-intake-background-failed.png` | Proposed retained background import after failure: the original paste and explicit retry remain available (#186) |
| `79-intake-from-link.png` | Proposed linked intake with its optional interpretation guidance visible and filled in (#219) |
| `80-linked-recipe-source.png` | The same recipe after saving, with **Näytä alkuperäinen** open: the text read off the page, and the address it came from kept as a link |
| `81-recipes-bulk-category.png` | Proposed recipe list with two recipes ticked: the count saying how many the action will hit, and the category control above the publish buttons (#199) |
| `82-recipes-bulk-category-done.png` | The same list after one press: both recipes carry **Keitto**, the chip row has gained it, and the notice counts what moved |
| `87-prompt-edit-proposal.png` | The proposal that came back, at the head of the shared intake review: which mode was used, what moved, and that nothing has been saved yet (#215) |
| `88-prompt-edit-review.png` | The same review whole — an assisted edit is reviewed in the ordinary import review, so every ingredient and step can still be corrected by hand before saving |
| `89-prompt-edit-saved.png` | The recipe after **Tallenna muutokset**: the side dish added, and everything the change request did not ask about unchanged |
| `90-prompt-edit-part-review.png` | Proposed review of *Lisää kastikkeeseen puuttuvat ainekset* on the lasagne: the change is named as the juustokastike's, because the model was shown the part's own contents |
| `91-prompt-edit-part-saved.png` | The lasagne after saving: butter and flour are on the juustokastike's own recipe row, the jauhelihakastike is untouched, and there is no second part |
| `92-prompt-edit-replace-form.png` | The shared intake screen with **Korvaa resepti** chosen: the mode is a control, not something read out of the wording |
| `93-prompt-edit-replace-review.png` | Proposed whole-recipe rewrite under replace mode, with what it dropped named as plainly as what it added |
| `94-prompt-edit-replace-saved.png` | The rewritten recipe after saving — same record, new contents, and the original source text still kept |
| `95-prompt-edit-part-stale.png` | Proposed refusal when the juustokastike was edited on its own screen while the proposal was open: the whole save is refused, dish included, and the proposal stays on screen |
| `96-prompt-edit-part-stale-recipe.png` | The lasagne after that refusal: the newer 7 dl of milk stands, the proposal's butter never landed, and the dish itself did not move either |
| `97-admin-categories.png` | Proposed admin category screen: the vocabulary as rows with slug and recipe count, ↑/↓ ordering, and a freshly added **Wokki** (#199) |
| `98-admin-category-delete.png` | Proposed removal confirmation: the recipes that would lose **Keitto**, named before anything happens |
| `101-shopping-long-total.png` | Proposed shopping list at 320 px with two rows whose totals read `1 + 1 kpl + määrä reseptin mukaan`: the name keeps the first line and the long total takes the second, instead of the name being squeezed into a column of single letters (#213) |
| `102-shopping-long-total-with-picture.png` | The same row shape with a chosen product's picture on it, among ordinary short-total rows |
| `103-intake-edit.png` | Issue #215's shared **Lisää resepti** screen in existing-recipe mode: the owned recipe is named, complete/replace is explicit, and text, URL and photograph inputs are the ordinary intake controls |
| `104-intake-edit-review.png` | The ordinary intake draft review for an existing recipe, stating that save updates the current recipe and offering **Tallenna muutokset** rather than creating another recipe |
| `105-review-save-bar.png` | Proposed import review with the draft opened and its name changed: the save bar rides the scroll saying there are unsaved changes, instead of sitting several screens above (#217) |
| `106-sharing-shortcut.png` | Proposed recipe screen saying who can see the dish under its title, with the way to change it — so nobody opens the editor for a control it does not have (#217) |
| `107-sharing-save-bar.png` | The sharing control one tap later: the visibility choice and **Tallenna jako** on screen together, in the same bar the editor and the import review use |
| `108-intake-four-pages.png` | Proposed import with four photographed pages chosen: each one already shrunk to what will be sent, so the list holds small copies rather than the photographs (#218) |
