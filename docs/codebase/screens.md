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

### Server-rendered inline script islands

Three screens ship a hand-written `<script>` rather than a build step, and all
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
- `src/week-screens.ts::SCROLL_TO_TODAY` — proposed for issue #119. Rendered
  whenever the week on screen is the current one, empty or not — seven day
  headings and fourteen add links already outrun a phone, and an empty week is
  exactly the one somebody opens in order to plan today. It runs once at parse
  time, before anyone can have scrolled, so it cannot fight a member who is
  already moving. It bails out on an explicit `#` anchor and on a scroll
  position the browser restored, and a browser without `scrollIntoView` simply
  opens at Monday as before.

All three islands are written in ES5 (`var`, no arrow functions, no regular
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
