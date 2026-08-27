# Importing a recipe

How a recipe gets structured from text or a photograph, what that costs, and the review screen that follows it.

`src/intake.ts` calls Claude Sonnet 5 (decision #11) with **structured outputs**,
so the draft is schema-valid by construction rather than parsed and retried. The
model id and effort are constants, not env overrides — an override was one of the
things that drifted in #13.

**`DRAFT_SCHEMA` may only use the JSON Schema subset structured outputs accept.**
An unsupported keyword is not ignored and does not degrade: the request is a
400, so *every* model-backed import stops working at once. `maxItems` did
exactly that after #120 — the cap was added to the schema, nothing about it
needed a paid call to review, and the first symptom a household saw was
`Reseptin jäsennys ei onnistunut` on an intake screen three hops from the
cause. Size and count caps therefore live in the prompt and in
`assertDraftWire`, never in the schema, and `dev/check-draft-schema.ts` walks
the schema for the whole unsupported list without spending anything.

**Both model calls stream, and both check `stop_reason`.** `structureDraft`
awaits `finalMessage()` rather than posting a plain request, because the SDK
refuses a non-streaming call whose token budget could outrun ten minutes, and
`max_tokens` is the model's full 128000 — a ceiling rather than a spend, so it
costs nothing to leave high, but it is well over that line. `streamDraft`
checks the stop reason after `finalMessage()` too: a draft cut off at
`max_tokens` is a JSON document that just ends, and a refusal is no text at
all. Neither raises anything in the transport, so before this check both
reached the browser looking like a finished import and failed one screen later
at `/intake/correct`'s `JSON.parse`. The streaming path retries once, but only
while no byte has been sent — after that the member sees the failure. Failures
reach a member as Finnish through `importFailureMessage`, which logs the
English detail; `intake.model_usage` carries `stop_reason` alongside the token
counts, so a truncated import is visible in `wrangler tail`.

**To walk the import flow by hand, use the sample draft and spend nothing.**
A development server shows `Avaa esimerkkiluonnos` on `/intake`. It posts
`src/sample-draft.ts` to the same `/intake/correct` the streaming island hands
over to, so the review, the editor and the save are all the real ones — only
the model call is skipped. That is the same fixture the browser suite answers
`/api/intake/structure` from, so there is one draft rather than two that drift.

The button exists only when `isLocalOrigin` (`src/public-origin.ts`) says the
browser reached a loopback or private-network address. It is not a flag or an
env var on purpose: a deployed Worker is only ever addressed by a public
hostname, so nothing you can misconfigure — including `wrangler secret put` —
turns it on live. `dev/check-local-origin.ts` checks that gate directly,
because a browser test always runs on 127.0.0.1 and would agree with any
implementation that just returned true.

**The API key has a small balance, so do not re-run imports casually.** Almost
everything is testable without spending anything: the correction screen, the
approval gate and the save path all take an ordinary form post, so exercise them
by POSTing to `/recipes` directly with hand-built fields. Only call the real
model when the model call itself changed — one import is enough to prove it. In
practice, getting the per-line `note` wording right (below) still took two paid
calls rather than one: the first wording flagged 4 of 6 lines on a deliberately
messy test recipe, which was noise, and the tightened wording flagged 3, all
genuinely lossy. The extra spend was judged worth it because shipping the loose
wording would only have swapped one kind of noise for another.

`EFFORT` in `src/intake.ts` is the cost dial, currently `medium`. `docs/spec.md`
estimates roughly $0.03/import, but that estimate assumes no thinking, and
`medium` runs with adaptive thinking on, which spends extra output tokens on top
of it. Nothing in `src/intake.ts` logs `usage.input_tokens` or
`usage.output_tokens` per import, so the real figure is still unmeasured —
`observability.enabled` is on in `wrangler.jsonc`, so `wrangler tail` would show
it if that logging were ever added. This is worth closing because the
household's entire yearly budget for the app is the model calls (hosting is
free-tier D1/Workers): at the estimated rate, importing a few-hundred-recipe
cookbook in one sitting would cost close to a year's budget.

**Prompt work belongs on free Sonnet, not on the key.** The standing rules in
`src/intake.ts` are plain Finnish text — iterate on them with a Sonnet agent in
AgentDeck and paste the result in, rather than looping real imports.

## Why pasted text, not a URL importer

Wayfinder decision #4 ("Where recipes come from", closed) ruled out fetching
recipes from a URL even though it was shown to work: `recipe-scrapers`
extracted clean `schema.org/Recipe` JSON-LD from most Finnish recipe sites
tested, with no Finnish-specific code needed. It was rejected anyway because
pasting text already covers those sites *and* the ones a scraper can't reach —
one route instead of two, no importer to maintain, no robots.txt question.
There is no URL-fetch or scraper code anywhere in `src/`; if that is proposed
again, this is the recorded reasoning to weigh against.

The same decision is why the model does the structuring rather than a
Finnish-language ingredient-line parser: no such parser exists. The
English-only options (an NYT-trained CRF, a popular ingredient-parser package)
don't cover Finnish, and the few Finnish-aware hobby parsers found rely on
hardcoded dictionaries that don't handle partitive word forms ("sipulia"). So
`src/intake.ts` hands the model raw Finnish sentences instead of pre-parsing
them.

For a photographed page, `source_text` in the draft is the model's own
transcription of the image (`PHOTOGRAPHED_RULES` in `src/intake.ts`) — the
photo itself is never stored, only held in memory for the one model call. That
also traces to decision #4: raw text is kept forever, images are discarded, so
a photo import stays re-runnable but never re-readable.

## Review, not correction

Testing the deployed v1 found that 99% of imports need no change and 99% of
unmatched ingredients are genuinely new, so the screen after the model runs is a
**review, not a correction** (decision #53). It reads as the recipe it is about
to become — parts and all — with one `Tallenna resepti`. The editable form is
the same form, one `<details>` down, so nothing about validation or saving
changed.

Two things make a read view safe. The draft schema carries a per-line `note` —
the model's own short sentence about what it guessed or lost — gathered at the
top where it cannot be scrolled past. And the ingredients that will be created
are *stated* rather than asked about: a name the model proposed is preselected
as "create it", so saving needs no interaction. The gate is narrowed, not
removed — a line with no answer at all is still refused. This reverses part of
what #1 locked; #53 says why.

The `note` rule is the fiddly part of the prompt. Too loose and it flags most
lines, which is the noise the review was meant to remove; the wording in
`src/intake.ts` says a note belongs only where something was guessed or lost,
and caps the expectation at zero or one per recipe.

The correction screen and the editor share `lineRow` in `src/line-form.ts`, and
it is exception-first (decision #35). A row shows amount, unit and ingredient;
the range's upper bound, the second measurement, the part, the source line, the
position and the remove box live under a `Lisätiedot` disclosure. Hidden is not
dropped — a closed `<details>` still submits its fields — and `hasUncommonValues`
opens the disclosure for any line that already carries one of those values, so
nothing real is ever folded out of sight, including on a re-render after a
refusal. The spare blank rows sit behind `+ Lisää ainesrivi` rather than trailing
every recipe; `lineRows` decides which rows are spare by reading the values, as
"everything after the last row anybody put anything in".

Intake has two paths on purpose. Without JavaScript the form posts to `/intake`
and the model call is a plain request. With it, the island in
`src/intake-screens.ts` streams from `/api/intake/structure` so bytes never stop
flowing, then hands the finished draft to `/intake/correct` — which keeps the
correction screen server-rendered rather than built in the browser. The camera
route needs the island either way: downscaling a photograph is a canvas job.

Intake's progress is counted, not dumped: the island reads the streaming JSON
and shows "Uunikaali · 5 ainesta · 2 vaihetta" rather than the raw bytes. Note
that `STREAMING_ISLAND` is a template literal, so **a backslash in it is eaten
before the browser sees it** — no regular expressions in that script.

## Marking the ingredients a step names (issue #120)

This pull request proposes a second job for the same model call: alongside the
lines and the steps, mark which words in each step name which of the draft's own
ingredient lines. It is a marking task and the prompt says so — no new
ingredient, no amount copied into a step, no rewording of the step text. A step
that names nothing gets `[]`, and a generic phrase like "lisää loput ainekset"
is left alone.

`ingredient_refs` on a draft step is `{line, matched_text, approx_position}`,
where `line` is the *index* of the ingredient line in the same draft. An
ingredient id does not exist yet at draft time, which is half the point of an
import. `assertDraftWire` treats the field as **optional** — a bundle written
before this exists is still a valid bundle — and `toDraftRefs` silently drops a
reference that points past the end of `lines`, points into another part of the
dish, or claims wording the step does not contain. Every one of those is a
producer having got something slightly wrong, and the recipe is worth more than
the link.

Nothing here was proved with a paid call. The sample draft
(`src/sample-draft.ts`) carries references, so the review screen, the save and
the recipe screen are all walked with the real code and no model.

## Batch intake from AgentDeck (#87)

Issue #82 added a second, model-free intake path: a bundle of recipes generated
outside the app (by AgentDeck) is uploaded and saved without calling Anthropic
at all. It reuses the same draft wire format as ordinary intake rather than
inventing a parallel one — `DRAFT_SCHEMA` in `src/intake.ts` is exported so
`src/batch-intake.ts` validates against the exact contract the model's
structured output already satisfies.

`draftFromJson` (`src/intake.ts`) now calls `assertDraftWire`, which *rejects*
malformed wire JSON — missing, extra or mistyped fields — instead of silently
defaulting them the way the old normalization did. That normalization is fine
for a trusted model response but was unsafe once an external generator could
hand in bad JSON. The same check enforces that `alt_quantity`/`alt_unit` must
both be null or both be set, and that `alt_quantity` requires a non-null
`quantity` — a rule that used to be silently discarded rather than validated.

`analyseBatch(db, member, json)` in `src/batch-intake.ts` parses a versioned
bundle (`format_version: 1`, `generator: {via:"agentdeck", provider, model}`,
`recipes[]`) and refuses the whole bundle rather than partially accepting it:

- every line's `ingredient_id` must be `null` — production ingredient ids are
  resolved by Ruokalista, never supplied by the generator;
- every `source_line` must occur verbatim in that recipe's own `source_text`.
  This check is stricter than ordinary intake, where verbatim source lines are
  only a prompt convention — the existing multipart fixture in
  `tests/parts.spec.ts` has source lines absent from `source_text`, so this
  check must stay local to the batch path and not move into the shared parser;
- titles must be unique both within the bundle and against the household's
  existing top-level recipes (compared case-insensitively, Finnish locale);
- the bundle is capped (`MAX_RECIPES=100`, `MAX_TOTAL_LINES=1000`,
  `MAX_TOTAL_STEPS=1000`, `MAX_NEW_INGREDIENTS=500`, plus the per-recipe
  `MAX_LINES`/`MAX_STEPS` from `src/line-form.ts`).

`analyseBatch` also runs the real `validateRecipe()` (`src/recipe-save.ts`)
against every draft up front, defaulting new-ingredient decisions to "new", and
turns a `SaveRefused` into a `BatchRefused` so the routes only ever need to
catch one refusal type.

Issue #106 proposes moving all three routes behind `requireAdminScreen`:
`GET /intake/batch` (upload form), `POST /intake/batch/review` (validate and
show a review, no save), and `POST /intake/batch/import` (revalidate and save),
in `src/batch-intake-screens.ts`. The paths stay unchanged, but the entry moves
from ordinary intake navigation to the admin panel because importing a bundle
writes many recipes and may create ingredients in one operation.

Saving reuses `saveRecipe()` unchanged, called once per recipe in sequence via
`saveRecipesSequentially` (`src/batch-save.ts`) — sequentially so a new
ingredient created by recipe 1 resolves as existing for recipe 2, with no
cross-recipe transaction needed. On a save failure partway through,
`remainingBundle()` returns only the unattempted remainder, so retrying doesn't
hit the duplicate-title check against the recipes that already saved.

Ingredient review/repoint decisions round-trip through the confirmation POST as
fixed indexed hidden fields (`ingredient.0`, `ingredient.1`, …) plus a
separately-carried key list, rather than embedding the ingredient name in the
field name, which keeps field-name size independent of ingredient-name length
under `MAX_FORM_BYTES`. The import route also recomputes
`analysis.proposedIngredients` and compares it against the review form's key
set; a mismatch (e.g. another member created a matching ingredient in between)
is a 409 that re-renders the review rather than silently overriding the
member's repoint choice.

`MAX_BUNDLE_BYTES` (2,000,000) bounds the raw uploaded bundle text and
`MAX_FORM_BYTES` (4,100,000) the full confirmation POST, both in
`src/batch-intake-screens.ts` — checked on both the review and the import
endpoint, since checking only on review left import reading an unbounded body
before validating anything.

`docs/agentdeck-recipe-bundles.md` is the docs-only contract for the bundle
JSON shape and generation rules. `.generated/` is git-ignored, since a
generated bundle is private household data and must never be committed.
