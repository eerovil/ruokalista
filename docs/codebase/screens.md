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
- **A row closes itself once its product has saved** — this is what #204
  proposes. The open row is the tallest thing on the screen at exactly the
  moment there is nothing left to do in it, and what somebody reported was
  finishing one ingredient and having to hunt for where they were. The island
  sets `details.open = false` in `persist`'s success branch, so the picture is
  what is left saying the row is done and the next ingredient is on the next
  line. Only on success: a refusal's error and retry are inside the row, so a
  refused save leaves it open. Collapsing removes only what is below the summary
  line, so the row's own line and everything above it stay put — #200's promise
  survives it. The cost is one more tap to reach `Lisää toinen pakkauskoko` or
  `Löytyy jo kaapista`, which is the trade the card asked for.
- **Product choice happens in a panel inside the row**, so choosing a product
  is not a page navigation and coming back is not a page load. (Inside the row
  is the part #200 takes back below — the panel is what made the list move.)
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

### Stopping the screen moving under the member (issue #200)

The shape above worked and read badly on a phone. Every part of choosing a
product changed the height of something *inside* the list, so the list slid
under the thumb of the person using it: the search panel grew inside the row it
belonged to, the chosen product replaced a two-line placeholder with a card
carrying a 64 px picture, the saving spinner and the refusal were nodes inserted
and removed, and two of the save paths reloaded the page outright. Walking
twenty ingredients meant re-finding your place twenty times.

This pull request proposes moving everything that changes size out of the list.
Nothing here is a scroll-position patch; the positions never move to be
restored.

- **The picker is one fixed sheet** (`.s-sheet`), built once by the island and
  appended to `<body>` rather than into a row. It is `position: fixed`, so
  opening it, searching in it and closing it reflow nothing. Because it is no
  longer sitting inside the row it belongs to, its head names the ingredient and
  its amount and says what is chosen for it now — on a phone that heading is the
  only thing that answers "which of these am I doing". A backdrop click, the
  `Sulje` button and `Escape` all close it. Above 48rem the same sheet becomes a
  centred dialog; the flow is not phone-only.
- **The scope choice visits the sheet, it does not live there.** The server
  still draws `.s-product-scope-choice` inside the row (`.s-scope-source`,
  hidden), the island moves that element into the sheet on open and puts it back
  on close. A dish's title is escaped once, by the server, and the option values
  cannot drift from what the save accepts.
- **The row's product line is compact and the same height in both states.** 40 px
  rather than 64, the name and EAN held to one line each, and a reserved
  `min-height`, so swapping "Teksti" for a chosen product moves nothing. It
  takes the full width with its buttons underneath, because squeezed beside them
  the name ellipsised away the very thing somebody is shopping for. The island's
  `showProduct` builds that shape **exactly** — same `.s-shopping-product-one`
  wrapper, same 40 px — because it runs the instant a member taps `Valitse`, and
  a shape of its own is a shape the row's CSS was not sized for.
- **The product pictures say their size in CSS, not only in attributes.** The
  shell's own `img` rule sets `height: auto`, which outranks an `img` element's
  `height` attribute — so a tall carton photograph drew itself several hundred
  pixels high and `object-fit: contain` never got a box to fit it inside. The
  `.shopping-thumb` picture always stated its size in CSS, which is why it was
  the only one on this screen behaving. `.s-shopping-product-one img` and
  `.s-product-results img` now state theirs too.
- **A product picture is asked for at the width it is drawn at, and cropped from
  the top** — this is what #204 proposes. There are three slots (26 px on the
  row, 40 px in the open row's summary, 80 px in the picker's results) and a
  single `PRODUCT_PICTURE` in `shopping-screens.ts` holds each one's size and the
  width to fetch, handed to the island rather than written twice.
  `s-ostoslista.ts::sProductImageAtWidth` swaps the width into the CDN path at
  render time — not in `sProductImageUrl`, because that URL is already saved in
  `image_url` for every product any household has chosen. Two reasons for all
  this: S sends one 256 px picture whatever the slot, which on a portrait carton
  is 44 kB apiece; and a product photograph is shot however the package stands,
  so `object-fit: contain` drew a 256 × 705 carton as a 9 px sliver of white in
  its square. `cover` with `object-position: center top` fills the square with
  the part of the package that carries the brand and the product name.
- **`Lisää toinen pakkauskoko` is disabled on an unmapped row, not hidden.**
  There is still nothing to add a second size to until a product is chosen, but
  hidden it *appeared* the moment one was — a whole tap target arriving mid-row,
  shoving every row under it down the screen at the exact moment the member had
  tapped something. Disabled it holds its own space and says plainly why.
- **A row's busy line is reserved, not inserted.** The server ships an empty
  `.s-status` on every mapped-capable row and the island only fills and empties
  it.
- **A refusal is a fixed strip** (`.s-toast`) above the tab bar, with the retry
  in it, rather than a paragraph pushed into the list at the moment the member
  is being told something went wrong.
- **The current-S-ostoslista panel moved below the list.** Its contents are an
  unknown number of lines that arrive after the screen does, and above the list
  every one of them pushed the list down while it was being read.
- **Every row is anchored and every server round-trip returns to its row.**
  `itemList` gives the first row of each ingredient `id="aines-<ingredientId>"`,
  and `listLocation` puts that fragment on the redirects from the cupboard
  buttons, from dropping a package size, and from the whole no-JavaScript
  product flow. The ingredient rather than the row key, because those are
  exactly the round-trips that change a key: pinning a product to one dish
  splits a row in two, and the cupboard moves a row to the other list.
- **One save path still reloads, and it lands on the ingredient.** A second
  package size or a recipe's own product changes what the row adds up to, and
  that arithmetic is the server's — so the island sets the hash to the row's
  anchor before reloading rather than drawing a guess.

`tests/shopping.spec.ts` has the regression the issue asks for: it scrolls to a
row deep in the list and demands nothing move after opening the picker,
searching again, closing it, drawing the optimistic choice and having the save
land — plus two more that assert the reload and the cupboard button come back to
the row they were pressed on.

It watches two different things on purpose, because either alone passes while
the screen still misbehaves. `window.scrollY` catches the page being yanked
somewhere else, but holds perfectly still while a row grows and shoves every row
under it down; so the edited row's own height and the next row's top are checked
too, including while the optimistic draw is on screen and the save has not
answered. That second pair is what a redraw not matching the server's shape
shows up in, and it is the assertion that catches the 64 px picture, the missing
wrapper and the tap target appearing mid-row.

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

## Saving a recipe, in every screen that writes one (issue #217)

This pull request proposes one save action with one shape, because there were
three. #184 gave the editor a sticky bar; the import review put
`Tallenna resepti` *above* its `Muokkaa ennen tallennusta` disclosure, so
opening that disclosure and editing the draft pushed the save several screens
up — the one case where somebody certainly has changes to save; and changing who
can see a dish meant scrolling the whole recipe screen to its foot, which is why
people opened the editor looking for a control that was never in it.

- **`html.ts::saveBar` is the one save action**, and a form gets exactly one, at
  its end. `.save-bar` is #184's `.editor-actions` renamed and generalised —
  same `position: sticky` clear of the fixed tab strip, so the placement is
  still CSS only and a browser without sticky positioning gets the button at the
  end of the form as before. The editor, the import review
  (`intake-screens.ts::renderCorrection`) and the sharing form
  (`recipes.ts::sharingSection`) all use it.
- **The bar's status line has a reserved height**, and the reserved height and
  the filled height are the same number — the rule the shopping list's busy line
  follows (#200). Untouched, unsaved and saving are the same size, so nothing
  moves under the member's thumb at the moment they are being told something.
- **What saving does here is said by the server where it differs.** The import
  review's bar starts out reading `Uusi resepti — ei vielä tallennettu`, which is
  true with no JavaScript at all; the editor of a stored recipe has nothing to
  say until something changes.
- **`html.ts::SAVE_BAR_ISLAND` adds the two things markup cannot say**: that
  there are changes not yet saved (`Tallentamattomia muutoksia`, plus
  `.is-dirty` on the bar) and that a save is running (`Tallennetaan…` with the
  shared `.spinner`, and the button disabled against a second tap). Same
  discipline as the other islands — ES5, no regular expressions, feature
  detected, every string written as a text node.
- **Unsaved is a comparison, not a latch.** The island remembers every *named*
  control's server-rendered default and asks whether the form still says that.
  Two faults follow from getting this wrong, and both were found in review of
  this change: typing in the sharing form's `#recipient-search`, which has no
  `name` and only filters the household list, announced changes that were never
  going to be posted; and editing a field back to what it was left the bar still
  claiming otherwise. The defaults rather than a reading of the live fields,
  because a browser puts form values back on a back navigation *before* any
  script runs, and a snapshot taken then would agree with the restored edit and
  call it clean.
- **`pageshow` re-asks the question rather than answering it.** A back
  navigation arrives either from the browser's page cache — whole document,
  script state and all — or as a rebuilt document with the field values put
  back. Either way the island clears the disabled button, then works the answer
  out again from the fields. An edit nobody saved still says so. A page returned
  to after its own save reads clean when it came from the cache; when the
  document was rebuilt, its markup predates the save and the newer values
  restored into it really do differ from it, so the bar says so — of a page
  whose save the revision check would refuse as stale anyway.
- **Only the bar's own button puts the bar into the saving state.** The editor's
  form has other submit buttons — `+ Lisää aines`, `Poista silti` — that
  re-render the screen rather than save it, and the island leaves those alone. A
  submit with no submitter is Enter in a text field, which *is* a save.
- **The button is disabled from a timeout, not inside the submit handler.** A
  disabled button is not a successful submitter, so disabling it synchronously
  would take `action=save` out of the sharing form's post.
- **`.sharing-shortcut` says who can see the dish, under its title**, with a
  link to `#jakaminen`. Only for the household that owns it, and never for a
  part, because `sharingSection` draws nothing for one. This is what stops a
  member opening the editor for a control the editor does not have.

`tests/save-action.spec.ts` walks the two cases the issue names plus the long
editor #184 covered, in both directions: with JavaScript and without.

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

## Casting a recipe to a TV

The cooking view carries an optional Google Cast action (#176). When a
`CAST_APP_ID` is configured and Google's sender SDK reports support, its native
Cast launcher appears under the title. Starting or resuming a session sends a
versioned, display-only recipe message: title, formatted multiplier, scaled
ingredient strings and instructions. Navigating to another recipe or multiplier
while the origin-scoped Cast session remains active sends that newly rendered
state as soon as the page joins the session.

Whether that row is on the screen at all follows the SDK's cast state, and
nothing else: `NO_DEVICES_AVAILABLE` hides it, any other state shows it. This
change proposes taking that decision away from the launcher element. Google's
launcher hides itself with an inline `display: none` and does not reliably undo
it when a device turns up later, which left the row's `Lähetä televisioon`
label standing next to an invisible button — the shape a member first saw on a
live TV-less page. An author `!important` in the island's own `<style>` outranks
that inline style, so the button is visible whenever the row is.

`GET /cast/receiver` is deliberately public because a Chromecast has none of
the member's session cookie. It is also deliberately data-free: it reads no D1
row and accepts no recipe id. `src/cast.ts::castRecipe` removes household,
source, edit, image and product data before the sender passes the message over
`CAST_NAMESPACE`; the receiver validates that shape and builds text nodes rather
than markup from it.

The receiver is a separate 16:9 screen rather than the phone shell stretched
wide. Ingredients and preparation stay in adjacent columns under the title and
multiplier. `src/cast.ts::CAST_RECEIVER_ISLAND` reduces a shared type scale
until an ordinary recipe fits the available height, while the viewport itself
never becomes a scrolling TV page.

Shrinking is the last thing it does, because the whole recipe being on one
screen is the point. `fit()` first tries each of three column layouts and keeps
whichever ends at the biggest type, with a tie going to the plainest: the even
`columns`, then `split` — a long ingredient list flowed into two sub-columns
with width taken from the method (#180) — and, this change proposes, `lean`,
which is the opposite shape, a handful of ingredients narrowed so a page of
method gets the width. Flowing the method itself into sub-columns is
deliberately not a candidate: a paragraph needs the same area whatever shape it
is poured into.

This change also proposes treating a receiver no taller than 800 px as a small
dense panel rather than a small television. A Nest Hub is 1024×600 across seven
diagonal inches — about 170 pixels to the inch, against roughly fifty on a TV —
so the same `vw` size is a fraction of the physical height in the kitchen that
it is on the television, and a 1024×600 screenshot looked at on a laptop
flatters it by nearly two to one. Under that media query the type has a much
larger `rem` minimum and the page's margins, gaps and row spacing are cut back
to pay for it, while the title is allowed to get smaller so a long recipe name
stops taking an eighth of the screen. A television is untouched, because a
receiver that trims its margins loses them to overscan. `tests/cast.spec.ts`
measures the result in millimetres at the panel's own density rather than in
CSS pixels, and writes the two review pictures described in
`docs/screenshots/README.md` (#227).

### Server-rendered inline script islands

Seven screens ship a hand-written `<script>` rather than a build step, and all
follow the same discipline because the string reaches the browser without
transpilation:

- `src/html.ts::SAVE_BAR_ISLAND` — proposed for issue #217, see the save bar
  above. It ships with the bar rather than from the shell, so a screen without
  one carries no script at all.

- `src/intake-screens.ts::STREAMING_ISLAND` — starts a durable background import
  and prepares camera pages; see `docs/codebase/intake.md`.
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
- `src/cast.ts::CAST_SENDER_ISLAND` and `CAST_RECEIVER_ISLAND` — proposed for
  issue #176. The sender feature-detects Google's framework and keeps the action
  hidden when unavailable; the receiver validates custom messages and writes
  their strings with `textContent`.

All seven islands are written in ES5 (`var`, no arrow functions, no regular
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

- `docs/codebase/intake.md` — the background import, correction screen and
  `lineRow`.
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

## Changing a category on several recipes at once (issue #199)

This pull request proposes a second thing the list's existing selection can do:
`categories.ts::categoryBulkControls` renders a `<select>` of the seven
categories and two buttons whose `formaction` sends the same form to
`POST /recipes/kategoriat` (`src/category-bulk.ts::categoryBulkForm`). One form,
one set of checkboxes; a row ticked for publishing is the same row ticked for a
category, which is why this is not a second selection UI.

Three rules the proposal treats as fixed:

- **One category per press, added or removed.** The bulk edit never replaces a
  recipe's whole set, so a category the member cannot see on this screen cannot
  be lost to a button on it. The editor's checkbox picker is still the only
  place a recipe's categories are set wholesale.
- **Ownership is `recipe-publish.ts::ownedDishes`**, now exported and shared
  with publishing rather than restated. Another household's recipe, a part of a
  dish and an id that never existed are all absent from the result, so the empty
  selection refusal is the answer to all three.
- **The count is said twice.** Before the press,
  `categories.ts::SELECTION_COUNT_ISLAND` keeps `.selection-count` reading
  `3 reseptiä valittuna`; without JavaScript that line is the plain sentence the
  server rendered and every button still works. After it, the notice counts what
  actually moved and says separately how many were already in that state.

The list comes back in the same search and category filter it was posted from,
and a refusal keeps the chosen category in the box — `ownRecipeList` takes the
bulk control's state as its own parameter, deliberately separate from the
category the list is filtered to.

## Curating the categories, from the admin panel (issue #199)

This pull request also proposes `/admin/kategoriat`
(`src/category-admin.ts::categoryAdminScreen`), behind `requireAdminScreen`, and
a row on the admin panel pointing at it. It is the screen that makes the
vocabulary data rather than code — see
[ADR-0013](../adr/0013-the-category-vocabulary-is-curated-not-compiled.md) and
[recipes](recipes.md).

The shape, and why:

- **One row per category**, each with the label in a text box, the slug and the
  recipe count in the meta line under it, and the actions under that. The slug
  is printed rather than editable: it is what recipes store, so it is derived
  from the label once and never again.
- **Every action is its own form.** A row with one text field and four submit
  buttons is a row where pressing Enter does something surprising, so renaming,
  ↑, ↓ and Poista do not share a form.
- **↑ and ↓ swap two positions**, and the button that would do nothing is simply
  not drawn on the first and last rows.
- **Removal is a screen, not a dialog**
  (`categoryDeleteScreen`): it lists the recipes that would lose the category
  and says how many, because that list is the whole point and a browser confirm
  cannot show it. The POST then detaches and deletes in one batch. No recipe is
  ever deleted.
- **An empty vocabulary is a legal state.** `categoryChoices` and
  `categoryBulkControls` render nothing at all when the list is empty, and
  `categoryFilter` already did — which is the same markup a recipe with no
  category has always produced.

Nothing here needs a script, and no screen on the reading path changed shape:
the picker and the chip row are the same markup drawn from a query instead of a
constant.
