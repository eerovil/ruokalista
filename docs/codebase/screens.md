# Screens and HTML

The one HTML shell, and the standing rules for what a screen may assume about the browser reading it.

## HTML

`src/html.ts` holds the one shell and the `html` tagged template, which escapes
every interpolated value. `raw()` is the only way past that escaping, so it is
also the only thing to check when reviewing for injection.

`page()` takes a `Shell` — `week`, `recipes`, `intake`, `ingredients`, or
`signed-out` — which is the bottom-tab destination the screen belongs to, so an
inner screen like a recipe still lights up `Reseptit`. Issue #106 proposes that
it also take a viewer so the shared account menu can offer the admin panel only
to an admin. `signed-out` renders no tabs or account button, because there is
nowhere to navigate yet.

Hierarchy comes from the colour tokens in `:root`, not from opacity: faded text
is the first thing to become unreadable on a phone in a bright kitchen. Controls
are at least `--tap` tall, `--tap-compact` where a row would otherwise blow up.

## The week

Issue #119 proposes replacing the week's occurrence-per-row layout with one card
per cooked batch. `src/week-screens.ts::weekScreen` groups by `PlannedBatch.id`
— never by recipe title, so two cookings of the same dish stay two cards — and
draws each batch once, in the day of its first occurrence inside the visible
week (`anchorDate`). The card carries the recipe, `Kokataan · N annosta`, one
row per covered day (`ma 7.12. · Lounas · Päivällinen`), and the batch's edge
state: `Kokattu 6.12.` when the cooking happened before the visible week,
`viimeinen annos` when it ends inside it, `jatkuu ensi viikolle` when it does
not. The proposal deletes the left-hand rail #90 added, because a card that
lists its own days no longer needs a line drawn beside it.

The card's shape follows the mockup the issue's author attached to #119: a
bordered `.batch-card` with the recipe, a round thumbnail and the portions pill
(`.batch-start`, or `.batch-carried` when the cooking predates the visible
week) in its head, then one hairline-separated row per covered day, each row
laid out as weekday, date, meals, and a `jatkuu` pill pushed to the right on
every row after the first.

The head wraps rather than clips, which matters because the card hides its
overflow and recipe titles have no length limit. Picture and title sit in one
`.batch-head-main` group so they stay on the same line; that group is sized
from its content, so the pill stays inline beside a short title and drops onto
its own line beneath a long one, and `overflow-wrap: break-word` plus
`min-width: 0` break a single unbroken Finnish compound instead of letting it
run past the card's edge. `tests/week-grouping.spec.ts` guards it by comparing
each card's `scrollWidth` with its `clientWidth`; a page-level overflow check
cannot see inside a clipping card.

Issue #138 proposes what a *later* day shows once its meals are already served
by food cooked earlier, because anchoring each card on its first occurrence
leaves those days reading as empty. `week-screens.ts::continuingRecipesOn`
collects the batches whose anchor day is before this date and which still have
an occurrence on it, and reduces them to one `.continuing-row` per recipe with
that day's meal labels combined (`Lounas · Päivällinen`) — so two cookings of
the same dish continuing into one day become one row, even though they stay two
cards on their anchor day. The rows sit in a `.continuing-card`, and the
heading gains `✓ katettu` only when the continuations cover every slot in
`SLOTS`; a day whose remaining slot is filled by fresh cooking is not
"covered by earlier food" and does not claim to be.

The summary is deliberately not a second batch card: no thumbnail, no portions
pill, no link. The card on the anchor day is still the one way into everything
you can do to that cooking, which is what keeps #119's grouping-by-batch-id
intact while the later-day view groups by recipe purely for reading. Both
`+ Lounas` and `+ Päivällinen` stay on a covered day too — a second dish beside
leftovers is an ordinary thing to plan.

The current day gets `.day.is-today`, `id="tanaan"` and a `Tänään` badge, and a
floating `.to-today` chip offers the way back after scrolling elsewhere — the
week nav keeps "Tämä viikko" on every week, as the mockup shows. A third inline
island scrolls to today — see below.

Two places where that mockup and the issue's own text disagree, resolved in
favour of the text because it states both as acceptance criteria: the mockup
draws only days that start something, while every one of the seven days keeps
its heading; and the mockup replaces the per-day add links with a single
`+ Lisää ateria` button, which has no day or meal to hand `/picker`, so
`+ Lounas` / `+ Päivällinen` stay per day.

## The shopping list

Issue #123 proposes `GET /ostoslista` (`src/shopping-screens.ts`), a fifth
bottom tab and a computed view over what is already planned — no
shopping-list table, no saved basket, no pantry or purchased state. The
proposal keeps the whole selection in the query string: `valittu=1` marks that
the member has actually chosen, and one `ateria=<batch id>` per ticked cooking.
Without `valittu` the screen preselects everything cooked today through the
next four days; with it, an empty selection means "I unticked everything",
which is a thing a member is allowed to mean.

That encoding is what keeps the screen a plain GET form with no JavaScript at
all, which the browser-compatibility rule below asks for. The picker is a
`<details>` that stays closed unless nothing is selected, and each ingredient
row is its own `<details>` whose body names the contributing cookings.

The arithmetic lives in `src/shopping.ts::shoppingList`, apart from the markup
and tested directly in `dev/check-shopping.ts`. Three rules the proposal treats
as fixed: a batch is one cooking however many meals it covers, so it is counted
once; nothing converts between units, so two units of one ingredient read
`5 dl + 2 rkl`; and a line whose source stated no amount keeps its place and
says `määrä reseptin mukaan` rather than getting a number invented for it. A
total is the sum of the *rounded* contributions, so the breakdown a member
opens adds up to the number above it.

The proposal also moves `sourceWorthShowing` out of `src/recipes.ts` and into
`src/scaling.ts`, unchanged, because the shopping list's breakdown has to ask
the same question the cooking view does — see
[recipes](docs/codebase/recipes.md).

Issue #147 proposes an opt-in S-ostoslista action on that same projection. It is
shown only to the household named by server configuration. Every send
recomputes the selected batches and `src/pantry.ts::splitByPantry` on the
server, then sends only `Ostettavat`: a mapped ingredient goes by EAN, while an
unmapped one becomes a note carrying the ingredient name and Ruokalista amount.
No recipe amount becomes a package count.

An opened buy row shows either the cached S-group product or that it will be a
note. Product choice is a server-rendered search at `/ostoslista/tuote`.
Selecting a result repeats the search before writing, so the browser cannot
invent a product name, EAN, or image URL. Search and send failures render a
Finnish refusal without changing the local mapping or computed list. The
private service calls live in `src/s-ostoslista.ts`; no API token reaches the
markup.

### Making that half feel immediate (issue #159)

This pull request proposes an inline script island,
`shopping-screens.ts::SHOPPING_ISLAND`, on top of everything above — not
instead of it. Every form on the screen is still the form it was: without
JavaScript the row's button still navigates to `/ostoslista/tuote`, the send
form still posts, and the only thing missing is the panel a browser has to
fill. Three JSON answers serve the island, and two of them are new routes:

- `GET /ostoslista/haku?haku=…` (`productSearchJson`) — the catalogue search,
  echoing the term it ran.
- `GET /ostoslista/s-lista` (`currentListJson`) — what the S-ostoslista already
  holds, read *after* the screen is drawn.
- `POST /ostoslista/tuote` and `POST /ostoslista/laheta` answer JSON instead of
  a screen when the form carries `muoto=json`. The product save still
  re-searches before writing on both paths, so the boundary #147 drew is
  unchanged.

What that buys, and the rules each part follows:

- **The chosen product's picture is on the row itself**, in a
  `.shopping-thumb` slot inside the summary. It is smaller than the row's
  existing `--tap` minimum, so no row grows, and the slot collapses when there
  is no picture (`.shopping-thumb:empty`) rather than leaving an empty box.
- **Product choice happens in a panel inside the row**, so choosing a product
  is not a page navigation and coming back is not a page load.
- **The next buy row's search is prefetched** while a panel is open. The cache
  is keyed by the search term and the server echoes the term it ran, and the
  island drops any answer that does not match what the row is currently asking
  — a prefetched answer cannot be drawn into the wrong ingredient.
- **A selection is optimistic and never silent.** The row shows the product and
  the panel closes at once; a `.spinner` says the save is still going; a
  failure puts the row back exactly as the server still has it and shows the
  refusal with `Yritä uudelleen`. A row that is saving ignores a second choice.
- **One spinner for everything asynchronous** — the saving row, the send button
  (which is disabled for the duration, so the same send cannot be started
  twice), and the S-ostoslista read.
- **The current S-ostoslista is a panel that loads after the screen.** It never
  delays the household's own list, and a failed read is one line and a retry
  inside that panel. A successful send refreshes it.
- **A finished send pushes the phone's list.** `sendShoppingListForm` calls
  `SOstoslistaClient::sync` once, after the last item has been accepted — never
  per item and never after a partial send, because there is nothing to push
  half of. The service syncs on its own schedule anyway, so a failed push is
  not a failed send: the screen keeps its `N ainesta lähetettiin` notice and
  adds a line saying the phone will catch up at the next sweep, and the JSON
  answer carries the same fact as `synced: false` so the island can say it too.

The island follows the same discipline as the other three: ES5, no regular
expressions, feature-detected (it does nothing at all without `XMLHttpRequest`,
`JSON` or `addEventListener`), and it builds every node with `createElement`
and `createTextNode` so a product name from the shop can never become markup.

## The cupboard

This pull request proposes `GET /kaappi` (`src/pantry-screens.ts`) and a
two-section shopping list (#125). The screen shows only what the household
keeps in — not a catalogue of every ingredient with a switch beside it — and
the one action on a row is `Loppui`, which removes it.

Things get *into* the cupboard from the shopping list, because that is where
somebody notices oregano on the list and remembers the jar in the cupboard.
Each opened list row carries a small POST form to `/ostoslista/kaappi`; the
ticked cookings ride along as hidden `ateria` fields and are re-serialised from
integers into the redirect, so the member lands back on the same list rather
than a default one, and nothing the browser sent is echoed back as-is.

A cupboard ingredient does not vanish from the list. It moves under a `Löytyy`
heading at the bottom, keeping the total and the breakdown `shoppingList`
worked out, because "why does this week need oregano at all" is worth being
able to answer about a staple too. With an empty cupboard there are no section
headings at all — one list needs no heading saying it is the list.

There is no sixth bottom tab: the cupboard hangs off the Ainekset screen, which
is the same ingredients seen another way, and off the `Löytyy` section itself.
The split rule is `src/pantry.ts::splitByPantry`, tested directly in
`dev/check-pantry.ts`.

## The recipe editor's ingredient rows

This pull request proposes reshaping the recipe editor's ingredient rows around
the four things somebody opens a saved recipe to do (#128): pick the ingredient,
change the amount's number, remove the line, and add one. Those four are on the
row itself; everything else — the unit included — moves behind the row's own
`Lisää asetuksia` disclosure.

`lineRow`/`lineRows` in `src/line-form.ts` are shared with the intake correction
screen, so the change arrives as an option (`LineRowOptions.compact`) that only
`src/recipe-editor.ts` passes. Intake keeps the row it has: it is checking a
whole import line by line against the text it came from, and the unit is part of
what is being checked. Without the option the markup is unchanged.

Two things follow from making removal a one-tap action:

- **The editor has no spare rows.** `+ Lisää aines` is always visible at the end
  of the list and is a plain submit button, not a script: it posts the form,
  `saveEditForm` sees `addLine`, and the screen comes back with one more row and
  everything typed so far still in it. The new row's picker gets `autofocus`, so
  the browser scrolls to it instead of dropping the member at the top. Because
  that button is now the first submit button on the form, the form also carries
  an off-screen copy of the save button ahead of it (`.default-submit`), so
  pressing Enter in a text field still saves.
- **A removal that would orphan a step's mention is refused.**
  `src/line-removal.ts::removalConflicts` asks the ingredient↔step anchors from
  #120 — not the raw text — whether any step still names the ingredient being
  removed, ignoring links whose wording the member has already edited away and
  ingredients another row still carries. The refusal quotes the steps at fault
  above the method, and `Poista silti` is a separate button inside that block
  that forces it through. The rule is pure and tested in
  `dev/check-line-removal.ts`.

## The cooking view on a wider screen

Issue #160 proposes using a tablet's width for the recipe itself, without
changing the phone-first shell. At 48rem and above, each cooking block places
its ingredients on the left and its preparation steps on the right. Multipart
dishes keep their existing parent-before-parts, named-parts, parent-after-parts
order; each block becomes two columns rather than flattening that cooking order.

The picture stays whole and above the cooking content, while its wide-screen
band becomes shorter so the useful cooking information gets more of the
viewport. The columns have no fixed height and do not hide overflow. Long steps
wrap normally and make the page taller when they need to, and the visible
`Näytä kaikki määrät` control remains after the final preparation block.

### Server-rendered inline script islands

Four screens ship a hand-written `<script>` rather than a build step, and all
follow the same discipline because the string reaches the browser without
transpilation:

- `src/intake-screens.ts::STREAMING_ISLAND` — see `docs/codebase/intake.md`.
- `src/keep-awake.ts::KEEP_AWAKE_ISLAND`, called from `recipeBody()` in
  `src/recipes.ts` and inserted directly into the recipe detail markup (issue
  #65, PR #75) — not a global slot on `page()`. It tries
  `navigator.wakeLock.request('screen')` first; on absence or rejection it
  falls back to a gesture-started, looping, silent inline `<video>` (a ~2s
  base64 `data:video/mp4` clip, `SILENT_VIDEO`, generated locally with ffmpeg
  and embedded in the TS source — old iOS keeps the display awake while inline
  media plays). A `requestGeneration` counter discards a native wake-lock
  request that resolves after the tab was already backgrounded, and
  `pagehide`/`pageshow` handlers stop and reacquire the lock across Safari's
  back-forward cache.
- `src/shopping-screens.ts::SHOPPING_ISLAND` — proposed for issue #159, see
  the shopping list above.
- `src/week-screens.ts::SCROLL_TO_TODAY` — proposed for issue #119. Rendered
  whenever the week on screen is the current one, empty or not — seven day
  headings and fourteen add links already outrun a phone, and an empty week is
  exactly the one somebody opens in order to plan today. It runs once at parse
  time, before anyone can have scrolled, so it cannot fight a member who is
  already moving. It bails out on an explicit `#` anchor and on a scroll
  position the browser restored, and a browser without `scrollIntoView` simply
  opens at Monday as before.

All four islands are written in ES5 (`var`, no arrow functions, no regular
expressions) — see Browser compatibility below.

## Browser compatibility

Issue #65 establishes old-browser support as a standing frontend requirement,
with older iPads and Safari as important targets. Keep core reading, planning
and navigation server-rendered and usable without optional browser APIs. Ship
enhancements through feature detection and compatible syntax, add a modest
fallback when it preserves an important flow, and let unsupported extras fail
quietly without taking the page with them. Inline browser scripts are delivered
without transpilation, so write them for the oldest target they need to serve.

## The recipe-image admin screen

PR #115 proposes replacing #97's paid three-screen flow with an admin-only list
and confirmation screen:

1. `GET /admin/recipe-images` (`recipeImageAdminScreen`) — every dish and the
   freshness of its picture.
2. `GET /admin/recipe-images/confirm` (`recipeImageConfirmScreen`) — the exact
   recipes in cell order, the shared prompt and the contact-sheet file input.

The proposed confirmation screen deliberately requires modern JavaScript. It
loads the committed browser bundle from an admin-gated route, cuts and validates
the whole sheet before uploading any crop, then PUTs 512 px PNGs through the
existing recipe-image API. The page says that JavaScript is required and leaves
the action disabled until the bundle is ready.

Selection UX worth reusing elsewhere: recipes missing or with a stale picture
are checkboxes, preselected up to `MAX_CELLS`; recipes with a current picture
sit behind a closed `<details class="image-current">` with their own separate
regenerate button and no checkbox in the main list, so a fresh row can never
share a checkbox with an actionable one. A manually-uploaded picture
(`ImageOrigin` "manual") gets no checkbox at all — only the editor replaces it.
(`src/recipe-image-admin.ts::currentSection`, `src/image-freshness.ts::imageStatus`.)

CSS gotcha documented inline in `recipe-image-admin.ts`'s `LIST_STYLE`: the
global `form.stacked label { display: block }` rule in `src/html.ts` beats a
less-specific `.image-list label`, stacking a row's checkbox, picture and title
vertically. The fix is a list-item-scoped selector (`.image-list li label`) —
worth knowing before any future admin or stacked-form screen wants an inline
row of controls.

## Related docs

- `docs/codebase/intake.md` — the correction screen, `lineRow`, and the other
  streaming island.
- `docs/codebase/recipe-images.md` — the generator and freshness rules this
  admin screen is built on.
- `docs/codebase/testing.md` — the browser suite that walks these screens.

## Publishing, on the screens (issue #143)

Three screens gained something, and the shapes are worth knowing before adding a
fourth.

- **`/recipes` is one form.** The whole list posts to `/recipes/julkaisu` with a
  checkbox per row and two submit buttons that differ only by `value`. The
  checkbox is a sibling of the row's link rather than inside it, so tapping a
  row still opens the recipe; `.recipes.is-selectable` is the rule that lays
  those two out side by side. A published row carries a `.badge.is-published`.
- **`/recipes/julkiset` is a separate section**, not a filter on the list, and
  it excludes this household's own published recipes.
- **The recipe screen ends in `.recipe-sharing`**, which holds both this
  household's default portions and — for the owner only — the publish control.
  Both are about this household's relationship to the recipe rather than about
  the cooking, which is what the rest of the screen is for. A non-owner gets a
  `.shared-from` line under the title instead of an edit link, said before the
  ingredients because whose recipe this is changes how it should be read.

`PUBLISH_STYLE` in `src/recipes.ts` holds the rules, beside the screens that use
them rather than in the shell — the same arrangement as `MENTION_STYLE`. None of
it needs a script.
