# Screens and HTML

The one HTML shell, and the standing rules for what a screen may assume about the browser reading it.

## HTML

`src/html.ts` holds the one shell and the `html` tagged template, which escapes
every interpolated value. `raw()` is the only way past that escaping, so it is
also the only thing to check when reviewing for injection.

`page()` takes a `Shell` — `week`, `recipes`, `intake`, `ingredients`, or
`signed-out` — which is the bottom-tab destination the screen belongs to, so an
inner screen like a recipe still lights up `Reseptit`. `signed-out` renders no
tabs and no sign-out, because there is nowhere to navigate yet.

Hierarchy comes from the colour tokens in `:root`, not from opacity: faded text
is the first thing to become unreadable on a phone in a bright kitchen. Controls
are at least `--tap` tall, `--tap-compact` where a row would otherwise blow up.

### Server-rendered inline script islands

Two screens ship a hand-written `<script>` rather than a build step, and both
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

Both islands are written in ES5 (`var`, no arrow functions, no regular
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

`src/recipe-image-admin.ts` (issue #97, PR #105) is a three-screen, JS-free
flow and the only place in the app from which money can be spent by a person
rather than by a script:

1. `GET /admin/recipe-images` (`recipeImageAdminScreen`) — every dish and the
   freshness of its picture.
2. `GET /admin/recipe-images/confirm` (`recipeImageConfirmScreen`) — the exact
   recipes about to be drawn, in cell order. Still free.
3. `POST /admin/recipe-images/generate` (`recipeImageGenerateForm`) — the one
   paid request, rendered as a report rather than redirected to, because the
   report of what happened to each recipe exists only once.

`runImageBatch` (`src/recipe-image-batch.ts`) is the shared batch core, factored
out so this form route and the JSON API (`docs/codebase/recipe-images.md`) run
identical logic — same cap, same manifest order, same all-or-nothing sheet
split — and differ only in response shape.

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
