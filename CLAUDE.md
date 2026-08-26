# ruokalista

A recipe store: a Cloudflare Worker in TypeScript over D1. The wayfinder map
(issue #1) holds the decisions that were expensive to reverse, and `docs/spec.md`
is the v1 build spec — the schema, the screens and the intake flow, end to end.

v1 is being built in thin vertical slices, one PR per working thing. An earlier
attempt built it all in one 36-commit PR (#13, closed unmerged); it drifted from
the spec and grew three stacked fetch handlers, and none of it was reviewable.
Hence the slices, and hence the rule below.

## Running it

There is no node on this host. Every npm and wrangler command goes through a
container:

    ./scripts/node.sh npm install
    ./scripts/node.sh npm run typecheck
    ./scripts/node.sh npm run migrate:local
    ./scripts/node.sh npm run seed:local
    ./scripts/node.sh --serve npm run dev

`--serve` publishes port 8787 and belongs only to the dev server. Without it no
port is published, which is what lets you run a one-off command while the dev
server is up — publishing an already-bound port kills the container.

The dev server answers on `http://127.0.0.1:8787`. Use the IP, not `localhost` —
podman's port mapping here is IPv4-only and `localhost` resolves to `::1` first.

Copy `.dev.vars.example` to `.dev.vars` for a local `SESSION_SECRET`. To call a
protected route before Google sign-in exists, mint a cookie for a seeded member:

    curl -H "Cookie: $(./scripts/node.sh node scripts/mint-cookie.mjs 1)" \
      http://127.0.0.1:8787/api/ingredients

That script is a developer tool, not a route.

A development server also offers **Kehityskirjautuminen** on `/signin`: a button
per existing member that issues a session directly. This is the one exception to
"no way in without Google", and it is narrow on purpose, because a shipped auth
bypass is one of the things that went wrong in #13:

- `POST /auth/dev-signin` **refuses with a 404** unless `isLocalOrigin`
  (`src/public-origin.ts`) says the browser reached a loopback, private-network
  or tailnet address. The route says no; it does not merely hide a button.
- The gate is the address, not a flag — no env var and no `wrangler secret put`
  can turn it on for the deployment.
- It **creates nobody.** Only a `member` row that already exists gets a session,
  which is the same rule Google sign-in follows. There is still no signup path.

`tests/auth.spec.ts` checks that it refuses both production hostnames and sets
no cookie, and that an unknown member id is refused. Those are the tests that
fail if somebody widens this.

The local D1 database is keyed by the `database_id` in `wrangler.jsonc`. Change
that id and local dev silently points at a different, empty database — the
symptom is `no such table: member`. Re-run `migrate:local` and `seed:local`.

## Cloudflare

Live at https://ruokalista.eerovil.workers.dev, D1 database `ruokalista`
(`f81fabeb-…`), `SESSION_SECRET` set as a Worker secret.

Credentials live in `~/.local/share/ruokalista/cloudflare.env` (mode 600), which
`scripts/lib-cloudflare.sh` sources into every script that needs them. Not
`.dev.vars`: that file is loaded into the Worker's own environment during local
development, which is no place for an account-wide API token.

`scripts/cloudflare-setup.sh` does the whole setup in one command and is safe to
re-run. `push-google-secrets.sh` pushes the Google credentials and deploys;
`add-member.sh` inserts a member, which is the only way anybody gets in.

Recipe images (#88) add an R2 bucket, `ruokalista-recipe-images`, bound as
`RECIPE_IMAGES`. The setup script creates it if it is missing, but **R2 has to
be switched on for the account in the dashboard first** — no API token can do
that, and `wrangler deploy` refuses outright while `wrangler.jsonc` binds a
bucket that does not exist. Since merging to `main` applies migrations and then
deploys, turning R2 on has to happen before that merge, or production gets the
new column and keeps the old Worker.

The backup covers D1, not R2. A restored snapshot therefore carries
`recipe.image_key` values whose bytes may be gone; the recipe screen falls back
to the placeholder, which is the same thing it does for a recipe that never had
a picture.

`SESSION_SECRET` is generated during setup and never stored anywhere, so a
signed-in session on the live Worker cannot be forged from this host — the live
signed-in path can only be exercised through a real browser sign-in.

## One fetch handler

`src/index.ts` is the only `fetch` handler and `src/router.ts` is the only place
a request is matched. There is one `Env` (`src/env.ts`), bound once and passed
down; nothing copies or rewrites it, and nothing smuggles identity through it.
This is the shape the closed attempt got wrong, so it is written down.

Every route that touches household data is wrapped in `requireMember`
(`src/auth.ts`), and every query below it takes the member's `household_id` as a
parameter. There is no other way in. Another household's record is a 404, not a
403 — whether it exists is not this household's business.

## Sign-in

Google is the gate and there is no signup path. A Google account with no `member`
row is shown the wall and nothing is created.

Which means member rows are a bootstrap problem: a member is matched on Google's
`sub`, and the only way to learn somebody's `sub` is for them to try to sign in.
So the wall shows the person their own `sub`, for the household to insert by
hand:

    INSERT INTO member (household_id, google_sub, display_name, email)
    VALUES (1, '<sub from the wall>', 'Nimi', 'nimi@example.com');

The Google client id and secret are Worker secrets. Without them the app says
sign-in is not configured and lets nobody in. The redirect URI is derived from
the request's origin, so every origin used has to be registered in Google Cloud
Console — the live one and `http://127.0.0.1:8787` for local work.

## Intake, and what it costs to test

`src/intake.ts` calls Claude Sonnet 5 (decision #11) with **structured outputs**,
so the draft is schema-valid by construction rather than parsed and retried. The
model id and effort are constants, not env overrides — an override was one of the
things that drifted in #13.

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
model when the model call itself changed — one import is enough to prove it.

`EFFORT` in `src/intake.ts` is the cost dial. `medium` is what has actually been
tested end to end; lower it if imports feel dear, but re-test the awkward line
shapes if you do.

**Prompt work belongs on free Sonnet, not on the key.** The standing rules in
`src/intake.ts` are plain Finnish text — iterate on them with a Sonnet agent in
AgentDeck and paste the result in, rather than looping real imports.

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

## Finish states

Deleting a recipe is a two-step: `GET /recipes/:id/delete` asks, naming the
parts that go with it, and only the POST from that screen deletes. The editor
links to it rather than submitting.

The ingredient list is read-first — each row is the name and how many recipes
use it, and the row *is* the disclosure that reveals the rename box. A list of
live text boxes read as a form nobody had finished filling in.

Intake's progress is counted, not dumped: the island reads the streaming JSON
and shows "Uunikaali · 5 ainesta · 2 vaihetta" rather than the raw bytes. Note
that `STREAMING_ISLAND` is a template literal, so **a backslash in it is eaten
before the browser sees it** — no regular expressions in that script.

## A recipe's picture

Pictures are made outside Ruokalista and uploaded (#88). The bytes live in R2
and `recipe.image_key` holds the object key, so an image is optional and a
recipe without one is not a special case anywhere.

`recipeImage()` in `src/recipes.ts` is the only thing that renders one, and it
always renders *something* — the picture, or the same space saying there is
none. A row whose height depends on whether somebody got round to adding a
photograph is a list that jumps about while you scroll it. It is read-only by
construction, which is what keeps the upload control in the editor and nowhere
else.

It has two sizes, because one object has to serve both a recipe screen and a
list row: `hero` is the band above a title (the recipe screen, the planned
meal, the editor), `thumb` is the square at the start of a row (the recipe
list, the picker, each meal on the week). Both crop rather than squash — a
recipe photograph is not a shape we choose. The picture is decorative, since
the title is always beside it, so it carries no alt text and the empty one is
hidden from a screen reader.

Anything that renders a picture needs `imageKey` on the row it already loads:
`recipeSummaries` and `findRecipe` in `src/recipes.ts` carry it, and so does
`PlannedBatch` in `src/menu.ts`. Nothing does a second query for it.

**Nothing trusts the content type a caller declares.** `src/image-bytes.ts`
reads the signature and the pixel size out of the file's own header, and that is
what decides whether the bytes are stored, what type they are served as, and
what the key's extension says. A browser sends whatever the operating system
guessed from the file name; a script sends whatever its author typed. The
response also carries `nosniff`, because these are bytes from outside served
from this app's own origin. `dev/check-image-bytes.ts` checks the reader
directly — including that HTML calling itself a PNG is refused — because a
browser test only ever sends real images and would agree with an implementation
that always said yes.

Normalizing happens in the browser: the editor's island shrinks the chosen
picture to a long edge of 1,200 px and re-encodes it as JPEG before it is
posted, the same canvas job and the same reason as the intake camera route. A
Worker cannot re-encode an image without another Cloudflare product, so the
server's half is a bound rather than a transform — 5 MiB and a 2,000 px longest
edge, refused with the measurement in the message. Bulk callers get the bound,
not the shrink, so they have to send display-sized pictures. If image
transformation is ever enabled on the account, `storeRecipeImage` is the one
place that would change.

That island is a template literal too, so the backslash rule from *Finish
states* applies to it.

Replacing writes the new object, points the row at it, and only then deletes the
old one — so a failure leaves a stray object rather than a recipe pointing at
nothing. Deleting a recipe drops its pictures and its parts' pictures first, for
the same reason: the keys are only readable while the rows still exist.

## Checks

`npm run check` runs `dev/*.ts` under node's own test runner — no test framework
as a dependency. `dev/` is outside the Worker's tsconfig on purpose: node's
globals clash with the Workers ones.

## Parts of a dish

A lasagne is a jauhelihakastike and a juustokastike. Each part is an ordinary
`recipe` row with `parent_id` set — not a second kind of record. Parts are
excluded from the recipe list and the picker, so only dishes can be planned.

The model marks parts by writing a name into each line's and step's `section`
field; `saveRecipe` turns distinct names into child recipes. Nothing carries a
section once saved, which is why the editor has no part field: a saved part is a
recipe you edit on its own screen.

See `docs/adr/0002-a-part-is-a-recipe.md`, including what it deliberately does
not decide — scaling parts with the parent is still open.

## Scaling

A recipe opened from a day carries that day's portions. The week itself is for
reading, so the link is one step further in: a planned meal opens
`/meal-entries/:id`, and *that* screen links to `/recipes/:id?portions=N` — it
is also where portions get changed and a meal gets taken off the list. The week
holds no inputs and no delete buttons on purpose (decision #36).

`src/scaling.ts` turns those portions into a factor, and a
dish's factor reaches into its parts — a part has no yield of its own because it
is a piece of the dish.

Amounts round to what a cook can measure rather than to what the arithmetic
says: 5 dl times 1⅓ reads 6½ dl, not 6,666. Small amounts keep quarters, larger
ones go to halves and then whole numbers, weights go to the nearest 5 or 10 g.

The recipe screen is cook-first (decision #37), so a source line is not repeated
under every ingredient. `sourceWorthShowing` in `src/recipes.ts` surfaces it in
exactly two cases: a line with **no stated amount**, because "hieman" and "maun
mukaan" have no field to live in, and a line whose amount **the factor changed**,
because the number on screen is no longer the number on the page. Ranges and
second measurements round-trip through the fields intact, so they carry no copy.
The full source text sits behind `Näytä alkuperäinen`, still stored, still one
tap away.

A recipe with no stated yield cannot be scaled and says so — there is nothing to
scale *from*.

## Browser compatibility

Issue #65 establishes old-browser support as a standing frontend requirement,
with older iPads and Safari as important targets. Keep core reading, planning
and navigation server-rendered and usable without optional browser APIs. Ship
enhancements through feature detection and compatible syntax, add a modest
fallback when it preserves an important flow, and let unsupported extras fail
quietly without taking the page with them. Inline browser scripts are delivered
without transpilation, so write them for the oldest target they need to serve.

## Browser tests

    ./scripts/playwright.sh npx playwright test

Runs in Microsoft's Playwright image, which already carries the browsers —
installing them into the plain node image would need root for apt. The config
starts its own `wrangler dev` and each spec reseeds the local database first, so
a test that saves a recipe cannot change what a later test sees.

**No browser test calls Anthropic.** `tests/support/draft.ts` intercepts
`/api/intake/structure` with `page.route()` and answers from a fixture, so the
suite is free to run as often as you like. That fixture is also what makes the
approval gate testable: one of its lines is deliberately unmatched.

Every spec reseeds in `beforeAll`. Skipping that is not a shortcut — it makes a
spec depend on rows an earlier run happened to leave, which passes locally and
fails on a fresh database.

`retries: 0`, on purpose. The one flake this suite ever had turned out to be two
real faults, and a retry would have kept both hidden.

CI (`.github/workflows/ci.yml`) runs typecheck, the checks and the browser suite
on every pull request, in the same pinned Playwright image. It writes a
throwaway `.dev.vars` with no `ANTHROPIC_API_KEY` — if a test ever needs one, it
is calling the model, and that is a test that should not exist.

**Merging to `main` deploys.** The same workflow applies any new migration and
then deploys, but only on a push to `main` and only after the tests pass. A pull
request never reaches that job, so the Cloudflare token is never exposed to one —
which is what makes keeping it in a public repository's secrets safe. It finishes
by curling the live site, because a deploy reporting success is not the same as
the app answering.

Screenshots land in `docs/screenshots/` and are committed as review artifacts —
nothing compares them, so they cannot fail a build. Regenerate with
`./scripts/playwright.sh npx playwright test screenshots`.

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

## Agent skills

### Issue tracker

Issues, PRDs and wayfinder maps live in this repo's GitHub Issues, driven with
the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, unchanged: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. Both exist —
`CONTEXT.md` is the glossary to use, and the ADRs record decisions that go past
what the wayfinder map locked. See `docs/agents/domain.md`.
