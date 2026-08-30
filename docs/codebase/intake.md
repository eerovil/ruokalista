# Importing a recipe

How a recipe gets structured from text or a photograph, what that costs, and the review screen that follows it.

`src/intake.ts` calls Claude Sonnet 5 (decision #11) with **structured outputs**,
so the draft is schema-valid by construction rather than parsed and retried. The
model id and effort are constants, not env overrides — an override was one of the
things that drifted in #13.

Issue #215 proposes making this same screen and durable job path the assisted
editor for an existing recipe. `/intake?recipe=:id` keeps every normal input —
text, photographs and a web address — but adds the explicit **Täydennä
nykyistä / Korvaa resepti** choice. The job stores a server-loaded snapshot of
the owned recipe and its parts, so queue delay or retry cannot silently change
the context the member started from. Its answer is the ordinary intake draft,
shown in this same review form; the form carries the saved revisions into
`replaceRecipe`, updates the same recipe row and keeps its original source and
categories. An ordinary `/intake` job still creates a recipe exactly as before.

The snapshot rather than only a recipe id is the concurrency boundary. The
model sees what the member chose to edit, while `replaceRecipe` checks the dish
and each named part are still at those revisions before writing anything.

**`DRAFT_SCHEMA` may only use the JSON Schema subset structured outputs accept.**
An unsupported keyword is not ignored and does not degrade: the request is a
400, so *every* model-backed import stops working at once. `maxItems` did
exactly that after #120 — the cap was added to the schema, nothing about it
needed a paid call to review, and the first symptom a household saw was
`Reseptin jäsennys ei onnistunut` on an intake screen three hops from the
cause. Size and count caps therefore live in the prompt and in
`assertDraftWire`, never in the schema, and `dev/check-draft-schema.ts` walks
the schema for the whole unsupported list without spending anything.

**The queued model call streams internally and checks `stop_reason`.** `max_tokens` is the
model's full 128000 — a ceiling rather than a spend, so it costs nothing to
leave high. `streamDraft` checks the stop reason after `finalMessage()`: a draft cut off at
`max_tokens` is a JSON document that just ends, and a refusal is no text at
all. Neither condition raises anything in the transport, so before this check
both looked like a finished import and failed one screen later at
`/intake/correct`'s `JSON.parse`. The stream retries once and records a ready
job only after the final draft parses on the server. Failures
reach a member as Finnish through `importFailureMessage`, which logs the
English detail; `intake.model_usage` carries `stop_reason` alongside the token
counts, so a truncated import is visible in `wrangler tail`.

## A failure in the browser leaves a line too (#222)

**This section describes what this pull request proposes; none of it is on
`main` yet.** Until it lands, an import that dies before the request goes out
leaves nothing anywhere — no request, no log line, no row — so the only
evidence an investigation has is the absence of evidence. Diagnosing #218 took
two attempts and produced two different answers for exactly that reason, and
settling it needed a Cloudflare log query and a database query where reading
one screen should have been enough.

The change adds `POST /api/intake/failures`
(`intake-screens.ts::reportIntakeFailure`), which logs one
`intake.client_failed` record and answers 204 to anything — including a body it
could not read. It is best-effort by construction: nothing waits for it, it is
never on the path of a working import, and every way it can fail is swallowed
in the island. A report route must not become a second thing that can fail an
import.

The island tags each hop it can give way at: `shrink` and `oversize` while a
page is being chosen, `encode` and `send` while the request is being built and
dispatched, `refused` and `reply` once the Worker has answered.
`intake.ts::clientFailureLog` narrows every field rather than trusting it — the
report comes from a page, so an unrecognised step is recorded as `unknown` and
a long detail is cut at 300 characters.

**`intake.client_failed` is a promise about where the import died, so only the
first four steps earn it.** Once the Worker has answered, the request
demonstrably arrived and the Worker's own logging is what represents it — a
line saying the browser gave up would be false. So the island reports nothing
for `refused` and `reply`, and `intake.ts::clientReportEvent` decides the name
from the step rather than from the body, which is what stops a report the
island did not send from borrowing it; anything else is logged under the
neutral `intake.client_report`, which claims nothing.

`startIntakeJob`'s 503 branch gains a line of its own, `intake.start_failed`.
It is what makes "a server refusal is represented server-side" true: before
this the branch logged nothing at all, which is why the browser's report was
covering for it under a name that said the opposite.

**Three names, and reading one is enough.** `intake.failed` is a refusal that
reached the model or the queue; `intake.start_failed` is the Worker declining
an import it received; `intake.client_failed` is the browser giving up before
anything left the device. On screen the two generic sentences are different
too: *Reseptin lähetys ei onnistunut tällä laitteella…* when nothing left the
device, *Palvelin ei ottanut reseptiä vastaan…* when the Worker answered badly.
Before this they read almost identically — the island's own sentence was
mistaken for the server's during #218, which is what made an error message look
like it contradicted the fix.

**The removed synchronous route had one unguarded `await`, and it is gone.**
`POST /api/intake/structure` (deleted 2026-08-28 in 374efb2) called
`ingredientsFor` outside any `try`, before the `Response` was built, so a D1
failure there escaped as an uncaught exception with no status and no message —
`importFailureMessage` is the only thing that logs `intake.failed`, and the
throw never reached it. Today's `startIntakeJob` has no such call: its body
parse is guarded and `createIntakeJob` is wrapped in a `catch` that answers 400
or 503, so nothing on the request side can throw uncaught. Every failure on the
queue side goes through `importFailureMessage`.

**To walk the import flow by hand, use the sample draft and spend nothing.**
A development server shows `Avaa esimerkkiluonnos` on `/intake`. It posts
`src/sample-draft.ts` to the same `/intake/correct` the ready-job route uses,
over to, so the review, the editor and the save are all the real ones — only
the model call is skipped. The browser suite persists the same fixture as a
ready queued import, so there is one draft rather than two that drift.

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

## Existing-recipe edits reuse these rules (#208, #215)

`DRAFT_RULES` and `ingredientDictionary` are exported because changing a saved
recipe asks the model for the same draft under the same standing rules, and a
second copy would be a second thing to drift. The edit request reuses
`DRAFT_SCHEMA`, `draftStream`'s attempt loop and `draftFromJson`; it adds the
server-captured recipe context and the explicit extend/replace rules. Issue
#215 proposes moving the review and save onto intake's own durable path as
described above. See [recipes](recipes.md).

## A web address, and the decision it reverses (#192)

Wayfinder decision #4 ("Where recipes come from", closed) ruled out fetching
recipes from a URL even though it was shown to work: `recipe-scrapers`
extracted clean `schema.org/Recipe` JSON-LD from most Finnish recipe sites
tested, with no Finnish-specific code needed. It was rejected anyway because
pasting text already covers those sites *and* the ones a scraper can't reach —
one route instead of two, no importer to maintain, no robots.txt question.

**Issue #192 reverses that half of #4, and this pull request proposes the
change.** The capability argument held; the effort one did not. Pasting a
recipe on a phone means selecting text interleaved with adverts and a life
story, and that is the step where an import gets abandoned. See
[ADR-0011](../adr/0011-a-web-address-is-a-third-way-in.md) for the full
reasoning, including why the robots question is answered narrowly rather than
dismissed. Both #4 and #192 come from the same person, so this is a change of
mind rather than a contested reversal.

`src/recipe-fetch.ts` is the reading half of it, and it never calls a model. It
turns an address into the plainest text the page reduces to, and everything
after that is the ordinary path — `IntakeSource` gains a `linked` arm carrying
text and the address, and nothing downstream of the model knows the difference.
That is what keeps there being one importer rather than two.

Four things about it are load-bearing:

- **A linked import is a background job, and the page is read by the queue
  consumer.** The address goes to the same `POST /api/intake/imports` the other
  two routes use, and `intake_job` gains a `linked` route and a `source_url`
  column. `sourceForJob` in `src/intake-jobs.ts` is what fetches the site,
  which is the only place it can go now that #186 has moved imports off the
  request: a slow site would otherwise hold a request open, and a member who
  navigated away would lose the import. The text it reads is written back onto
  the job before the model runs, so a retry after a *model* failure structures
  the text again rather than asking the site again, and a failed import can
  still show what it did manage to read. A retry after a *fetch* failure has no
  text to reuse and does go back to the site, which is what a retry means
  there.
- **A refusal is one of five words, never prose.** `FetchFailure` is
  `invalid_url`, `unreachable`, `not_a_page`, `too_large` or `no_recipe`, and
  `LINK_REFUSALS` in `src/intake-jobs.ts` is the one place each becomes
  Finnish. A fetched page's own error text — or worse, somebody else's Finnish
  — must never land on a member's screen, which is the same rule the streamed
  failures follow. The wording lands on the job, so a failed linked import
  reads on the import list next to every other background failure rather than
  as a message that disappears with the page. An address that is not an address
  is refused by `createIntakeJob` before a job exists at all, while the member
  is still looking at the field they typed it into.
- **Only a public web address, at every hop.** `normaliseRecipeUrl` takes an
  HTTP address by hostname and nothing else: no bare IP, no loopback or private
  name, no credentials, no other scheme. Redirects are followed by hand rather
  than by the platform precisely so a public address that bounces to a private
  one is refused at the bounce. The body is capped as it arrives, because a
  `Content-Length` is a claim.
- **Structured data first, page text second.** A `schema.org/Recipe` node is
  rendered as the plain Finnish a person would have pasted — name, yield,
  ingredient lines, numbered steps, with a `HowToSection`'s name kept as a
  heading because that is exactly the wording the model reads as a named part
  of the dish. A page with no such node gives up its visible text with the
  scripts, styles and navigation stripped out. Neither path parses ingredient
  lines; that is still the model's job, for the reason below.

The address is saved on the recipe as `recipe.source_url`, and `source_route`
gains `linked`, so how a recipe arrived stays recorded truthfully. The recipe
screen shows the link inside **Näytä alkuperäinen**, next to the text.

Four checks cover it, none of them spending anything or touching the network.
`dev/check-recipe-fetch.ts` covers the address guard and the extraction against
fixtures. `dev/check-intake-jobs.ts` drives the job half through
`processIntakeJob` with a stand-in for `fetch`: that the page is read in the
consumer, that a job which already has text does not read it again, and that a
fetch refusal lands on the job as Finnish. `tests/intake.spec.ts` covers the
screens, with the stub standing in for what the consumer would have written.
`dev/check-intake-page-image.ts` covers the picture, below.

### Guidance and visible flavor variants (#219)

Issue #219 proposes two linked refinements to the web-address route. The URL
field reveals an optional **Lisäohje tuontiin** field once an address is entered.
The guidance is stored on the queued `intake_job`, not on the recipe, and reaches
the existing structuring request as a separate user instruction. An empty field
keeps the old request shape; a filled field does not add a second model call.

Complete JSON-LD is still the preferred source, but it may flatten a visibly
structured ingredient list. `readRecipeFromPage` therefore proposes preserving
one bounded visible outline when, and only when, a heading explicitly announces
flavor/version alternatives and at least two same-level headings follow it. The
model gets that outline after the JSON-LD text. Ordinary component headings such
as *pohja*, *täyte*, *kuorrute* and *kastike* do not trigger the outline.

The structuring rules propose that a clearly named common base remains on the
parent (`section: null`) while each sibling flavor becomes an ordinary named
part. That is the representation requested for #219: all such parts remain part
of the dish's cooking and shopping behavior, just like every existing child
recipe. The common base is not copied into each part.

### The picture on the page (#205)

#192 shipped without the page's photograph, and
[ADR-0011](../adr/0011-a-web-address-is-a-third-way-in.md) wrote down why. Issue
#205 reverses that one rejection, and **this pull request proposes the change**:
a linked import now brings the dish's own picture in with the recipe. Sending
somebody back to the site to save the picture and upload it by hand is the same
friction that made an address worth accepting in the first place.

- **The page names it; nothing is guessed.** `recipeImageUrls` in
  `src/recipe-fetch.ts` reads `schema.org/Recipe`'s own `image` — a string, a
  list of crops, or an `ImageObject` — and falls back to `og:image` *only on a
  page that carried a `Recipe` node at all*. That condition is the guard the
  issue asks for: `og:image` on a recipe page is the dish, and on any other page
  it is a masthead or an advert. A page with no structured recipe on it offers
  no picture. Every candidate is resolved against the page's own address and put
  back through `normaliseRecipeUrl`, so a picture "hosted" on a private name is
  dropped before anything is dialled.
- **Candidates, plural.** `Recipe.image` is routinely the same photograph in
  three or four crops, and the biggest of them can be past the pixel cap while
  the next is not. `fetchRecipeImage` tries up to `MAX_IMAGE_CANDIDATES` in the
  page's own order and takes the first that is really storable.
- **The bytes are ours.** `keepPageImage` in `src/intake-jobs.ts` stores them in
  R2 under the job (`intake/<job>/found.<ext>`) and records the key on
  `intake_job.page_image_key` — a column of its own rather than `image_refs`,
  because those are a *photographed* import's input pages and are deleted the
  moment a draft exists. Saving the recipe copies the object onto it through
  `storeRecipeImage`, so what the household ends up with is indistinguishable
  from a picture somebody uploaded, and nothing depends on the site keeping its
  URL alive.
- **What we will keep is one set of rules.** `storableImage` in
  `src/image-bytes.ts` holds the byte and pixel caps that the upload route uses,
  and a found picture has to clear the same ones. A site's `Content-Type` is not
  evidence; the signature is.
- **Nothing about it can fail an import.** It is fetched *after* the recipe text
  is written back onto the job, has its own shorter timeout, and every failure —
  unreachable, an error page served as an image, too many pixels, bytes that are
  not a picture — is a log line and an import that carries on without one.
- **The member sees it before it is saved.** The review screen shows it from
  `GET /api/intake/imports/:id/image` with a tick that is on by default;
  unticking it saves the recipe with no picture. Saving deletes the job and its
  object either way.

`dev/check-recipe-fetch.ts` covers which address a page is read as offering and
what `fetchRecipeImage` will and will not accept;
`dev/check-intake-page-image.ts` covers the hand-over to the recipe;
`tests/intake.spec.ts` covers the review screen with a real picture in the local
bucket.

Decision #4 is also why the model does the structuring rather than a
Finnish-language ingredient-line parser: no such parser exists. The
English-only options (an NYT-trained CRF, a popular ingredient-parser package)
don't cover Finnish, and the few Finnish-aware hobby parsers found rely on
hardcoded dictionaries that don't handle partitive word forms ("sipulia"). So
`src/intake.ts` hands the model raw Finnish sentences instead of pre-parsing
them.

For a photographed page, `source_text` in the draft is the model's own
transcription of the image (`PHOTOGRAPHED_RULES` in `src/intake.ts`) — the
photo is retained privately in R2 while its queued import is pending or failed.
It is deleted as soon as a validated draft is ready; the transcription then
becomes the durable source text. A failed import keeps the pages so retry means
retrying the same source rather than asking the member to photograph it again.

## Photographing a printed recipe (#156)

Issue #156 proposes two changes to that route, and this pull request makes
them: a recipe may be photographed **across several pages**, and the photograph
may be **taken in the app** rather than fetched from the picture library.

`IntakeSource`'s `photographed` arm carries `images: IntakeImage[]` rather than
one base64 string, and the order of that array is the reading order of the
printed recipe. Nothing between the browser and the model may sort or dedupe
it. `MAX_IMAGES` (8) caps it, and the cap lives in `src/intake.ts` next to the
type rather than in `DRAFT_SCHEMA` — a count keyword in the schema is the
failure described at the top of this document, where every import stops at once.

`userContent` announces each page with a short `Sivu 2/3:` line of its own
before the picture. That labelling is not decoration: with several unlabelled
images the model has no way to refer to "the second page", and the point of the
whole change is that page two is page two. A **single** page is worded exactly
as it was before pages were plural, so the one-photo import is not quietly a
different prompt than the one that has been running.

`MULTIPAGE_RULES` is added to the system prompt only when there is more than one
page, and it says the one thing a spread can get catastrophically wrong: the
pages are one recipe in the given order, not one recipe each, and an ingredient
list on one page belongs to the steps on the other.
`dev/check-intake-images.ts` asserts the page order, the labelling and which
rules each shape of import gets — the parts of this that a real model call would
otherwise be the only way to see, on a key with a small balance.

On the screen (`src/intake-screens.ts`) there are now two file inputs: `camera`
carries `capture="environment"`, and `photo` carries `multiple`. **Neither one
holds the list of pages**, because neither one can — a camera capture replaces
its input's single file every time, so a member shooting page two would lose
page one. The island owns the list, both inputs only append to it, and each
input is cleared after it is read so pressing the camera button again for an
identical next shot still fires a `change`. The chosen pages are drawn as a
numbered list with a thumbnail and a `Poista` button each, rebuilt whole on
every change so the numbering always agrees with the list. Pages are downscaled
one at a time rather than all at once: the order has to survive, and a phone
decoding eight full-size photographs at the same time is how a tab gets killed.
*When* that downscale happens is the subject of the #218 section below, which
moves it from the button to the moment a page is chosen.

`readImages` in `src/intake-jobs.ts` still accepts the older single-`image`
body. Ruokalista is an installable PWA (#100), so a browser can be running a
cached copy of yesterday's island, and its one-photo import must not become a
400 overnight.

### A page is shrunk when it is chosen, not when it is sent (#218)

Four photographed pages did not fail an import — they killed the tab, and this
pull request proposes the change that stops it. Nothing about the model or the
context window was involved: measured on the local dev server with four
12-megapixel photographs, the request weighs 2.6 MB of base64 and the model
call reads 13,249 input tokens, which is under 7% of Sonnet's window. What ran
out was the browser's memory.

Two things spent it, and both are the same mistake. The page list held the
original `File` and pointed each 3 rem thumbnail straight at it, and **a
browser decodes a picture at its own size before it draws it small** — about
50 MB a page, four times over. Then pressing the button decoded every page
again, at full size, to downscale it. Peak renderer memory across the four-page
import measured 596 MB, nearly 480 MB of it arriving in the second between the
button being pressed and the request being built. A phone does not lend a tab
that, so the tab died on the button — which is why it reads as "creating the
recipe crashes" rather than as an import that failed.

So `shrink` now runs as each page is chosen, one at a time as it always did,
and what the list keeps is what will be sent: a ~1500 px JPEG plus a
thumbnail-sized one, both base64. The original is let go there and then —
`bitmap.close()`, and no object URL to hold it. Pressing the button decodes
nothing. The same measurement afterwards is 188 MB peak, and all of the rise is
while choosing rather than at the press.

While a page is being read the submit button and both file inputs are disabled
and the status says which page it is on, because half a spread must not be
importable and on a phone this is the part that takes a moment.

`MAX_PAGE_BASE64_BYTES` and `MAX_PAGES_BASE64_BYTES` in `src/intake.ts` are the
UX half of the issue: an import too large to carry is refused in Finnish rather
than failing with nothing a household can read. A shrunk page weighs about
400 kB, so neither fires on an ordinary import — they are the floor under the
screen, not a working limit. The browser applies them as each page is chosen
and `createIntakeJob` applies them again, before anything is written to R2.

`intake.pages_received` logs the page count, the total base64 and the largest
page at job creation, so a photographed import that goes wrong is a number in
`wrangler tail` rather than a job id and a guess.

`tests/intake.spec.ts` covers the two things a reader would otherwise have to
take on trust: that a row shows a small `data:` copy rather than a `blob:` URL
of the photograph, and that nothing can be submitted while a page is still
being read. `dev/check-intake-jobs.ts` covers both refusals and that four
ordinary pages clear them.

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

Intake requires JavaScript. The form has no server action and its submit button
is disabled until the island in `src/intake-screens.ts` finds the browser
features it needs. The island posts the prepared source to
`/api/intake/imports`; that route writes an `intake_job`, sends its id to
`INTAKE_QUEUE`, and returns before the model call begins. The import screen
lists queued/running, ready and failed jobs for the signed-in household. A
ready row opens the same server-rendered review used by the development sample,
and saving removes the job. The camera route still needs the island because
downscaling a photograph is a canvas job.

## Two ways off this screen (issue #211)

Proposed here. *Lisää resepti* used to offer one thing, behind a button that
said **Jäsennä** — a word this codebase uses among itself and one no household
reads anywhere else. This pull request renames it to **Muodosta resepti**
(`STRUCTURE_LABEL` in `src/intake-screens.ts`) and puts a sentence under it
saying what it will do with the text, address or photographs above it.

Beside it, and headed by its own question, sits a second whole way out: a name,
and **Tallenna keskeneräisenä**. It posts to `/intake/keskeneras`
(`quickSaveScreen`), writes a recipe with `saveRecipe` and nothing but a title,
and redirects to it. Nothing on that path calls the model, waits for a queue or
needs an ingredient — the case it is for is somebody who remembers what the dish
is called and has the recipe nowhere near them.

It is also the one thing on this screen that works with JavaScript off: an
ordinary `method="post"` form, no island, no `<script>`. The paragraph below
about intake requiring JavaScript is still true of the import itself, and only
of that.

The rule it needed relaxing is `validateRecipe`'s one-ingredient rule; see
[A recipe may be nothing but its name](recipes.md#a-recipe-may-be-nothing-but-its-name-issue-211)
for why the import paths keep it.

## Background lifecycle (issue #186)

`src/intake-jobs.ts` owns the lifecycle. A queue message carries only the job
id; source data, Finnish failure text and the validated draft are household-
scoped in D1. The consumer claims a job with a 16-minute lease, so duplicate
at-least-once deliveries do not call the model twice. Ready and failed writes
carry the claim's opaque lease id, so an older consumer cannot overwrite a
newer claim. A five-minute Cron Trigger re-enqueues queued jobs and reclaims a
running job only after its lease is stale, even if Cloudflare exhausted or lost
the original Queue message. `waitUntil()` is deliberately not used: Cloudflare
cancels it 30 seconds after a browser disconnect, which is shorter than the
long call this feature exists for.

Pasted text stays in `intake_job.source_text`. Downscaled photographed pages
use private `intake/<job>/<page>` objects in the existing R2 bucket and D1 keeps
only their ordered keys. Success deletes those objects; failure retains them
for the explicit retry action. Ready and failed jobs remain until the member
saves the recipe or retries them. The same maintenance pass removes a temporary
`intake/` object only when no D1 job references it and it is at least a day old;
failed source pages have no blanket expiry.

## What the internal stream says about its attempts (issue #146)

This pull request proposes closing an asymmetry between the two paths. The
plain path has always had `structureDraftWithRetry`, which retries a retryable
failure once, and `structureDraft`, which checks `stop_reason` before parsing.
The streaming path had neither: an answer cut off at `max_tokens` was streamed
through as if it were whole, the island handed it to `/intake/correct`, and the
member met the parser's own English — "The model returned unparseable JSON."

Attempts still use NDJSON internally: each line is one JSON record.
`delta` carries draft text as an escaped string, `restart` says everything
streamed so far is dead and a second attempt begins, `complete` says the current
draft already parsed on the server, and `failed` says every attempt failed.
Because pasted text is data inside a JSON string, it cannot impersonate a record
boundary or control record. The queue consumer resets only for a parsed
`restart` record and persists only after `complete`, so two attempts cannot be
joined and a half-draft never becomes a ready job however the chunks fall.

The retry itself stays on the server, in `draftStream`, next to the
retryability it already knows about. `draftStream` takes the model call as an
argument purely so `dev/check-intake-stream.ts` can drive the whole loop from
fake responses — a cut-off first attempt, an unparseable one that stopped
cleanly, a refusal that must not be retried, and two failures in a row — with
no model call and nothing spent. `dev/check-intake-jobs.ts` covers the queue
collector's fragmented-record side from the same protocol.

A terminal failure closes the internal body on a `failed` record rather than
tearing the stream down. A body that simply stops never becomes a ready draft.
`importFailureMessage` still logs the English detail as `intake.failed`, so
`wrangler tail` shows one shape for every import failure however it arrived.

The job stores only the Finnish wording from `importFailureMessage`; raw model
or transport errors stay in logs and never land on a member's screen.

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

## Proposing a `tai` line (issue #183)

An ingredient line may offer a choice, and the model is asked to spot one:
`DRAFT_SCHEMA` gains a nullable `alternative_group`, and the standing rules tell
it to write **one line per option**, give them the same number, and give each
its own quantity, unit and `ingredient_name` — never `hunaja tai sokeri` as a
single ingredient, which is exactly what it has been producing.

The rules also tell it to keep a group's options in one `section` and one
`phase`. Both halves of a choice are used at the same moment, and the save
refuses a group that straddles either — asking the model for the right shape is
cheaper than a refusal three screens from the cause.

`alternative_group` is **optional on the wire**, the same way `ingredient_refs`
is: a bundle AgentDeck wrote before #183 carries none, and refusing it would
break every draft already generated. `dev/check-draft-schema.ts` covers the
schema-keyword risk for free, as it does for every other field.

The parsing side is deliberately forgiving. `alternatives.ts::alternativeGroup`
degrades anything that is not a positive whole number to "no group" rather than
refusing the import — a draft is reviewed by a person before it is saved, and a
refusal three hops from the cause is worse than a line that offers no
alternative. `saveRecipe` then dissolves any group the review left with one
member. See [recipes](recipes.md).

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
