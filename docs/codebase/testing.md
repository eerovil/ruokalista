# Tests and checks

How the repo verifies itself: the pure-module check tier, the browser suite, CI, and the gotchas that have cost real debugging time.

## Checks

`npm run check` runs `dev/*.ts` under node's own test runner — no test framework
as a dependency. `dev/` is outside the Worker's tsconfig on purpose: node's
globals clash with the Workers ones. Most checks are pure-module tests;
`dev/check-local-d1.ts` is the deliberate exception that runs Wrangler against
an isolated temporary persistence directory to prove the browser bootstrap can
migrate an empty database and then run again safely.

`dev/check-batch-intake.ts` is a good template for this tier: it tests
`remainingBundle`/`saveRecipesSequentially` from `src/batch-save.ts` directly
with an in-memory fake save callback, asserting the exact retryable-remainder
shape after a mid-batch failure — no Worker, no D1, no Playwright.

## Browser tests

    ./scripts/playwright.sh npx playwright test

Runs in Microsoft's Playwright image, which already carries the browsers —
installing them into the plain node image would need root for apt. The config
starts its own `wrangler dev` and each spec reseeds the local database first, so
a test that saves a recipe cannot change what a later test sees.

Keep a full run in the foreground and do not pipe it through `tail`: `tail`
holds the useful final lines until the command ends, leaving a long run with no
visible progress or diagnosis if its runner times out first. A local run stops
after its first failure so that one trace and its underlying Wrangler error
stay visible instead of being followed by dozens of
`ECONNREFUSED` failures after a dead server. Re-run that one spec while the
signal is small. GitHub Actions deliberately keeps running after a failure,
because its single clean-room run is where the complete cross-browser failure
surface belongs.

**No browser test calls Anthropic.** `tests/support/draft.ts` intercepts
`/api/intake/imports` and persists a ready D1 job from the sample fixture, so
the suite exercises the real later-review route without reaching the Queue or
model. That fixture is also what makes the
approval gate testable: one of its lines is deliberately unmatched.
`tests/batch-intake.spec.ts` (8 scenarios: happy-path save through the shared
`saveRecipe` path, repointing a proposed ingredient name everywhere, refusing
duplicate titles, refusing malformed drafts, refusing a non-verbatim
`source_line`, collection-count caps plus a tampered confirmation body, a
near-limit bundle surviving review and confirmation encoding, and refusing a
reviewed repoint whose exact-name resolution changed between review and
confirmation) is a second example of exercising the real save path without
spending on the model.

Every spec reseeds in `beforeAll`. Skipping that is not a shortcut — it makes a
spec depend on rows an earlier run happened to leave, which passes locally and
fails on a fresh database. `dev/seed.sql` keeps two households on purpose, plus
three members: member 1 (household 1, ordinary) is the one nearly every spec
signs in as — a "quietly stopped refusing" canary if a gate ever loosens;
member 2 is household 2's, there so anything leaking across `household_id`
shows up immediately; member 3 (household 1, `is_admin=1`) exists solely to
prove the admin side of the admin gate. `tests/admin.spec.ts` is the pattern to
copy for any future "prove nothing else grants this" gate test: it doesn't
stop at the happy path, it POSTs/GETs with fabricated `X-Admin` and
`X-Forwarded-Host` headers and query-string claims (`?admin=1`, `?isAdmin=true`,
`?memberId=3`) against an ordinary member's real cookie and asserts 404 on all
of them.

`tests/public-recipes.spec.ts` is the spec for sharing between households
(#143), and it is the one to read before touching that boundary: it drives
publishing through the screens rather than the database, and every case is
really "does the wall hold in the one place it was deliberately opened". Three
seed facts it leans on — member 1 is Koti's, member 2 is Naapuri's, and recipe 6
(Naapurin uunikala) ships already published so the read-only side has something
to read. That last one changes counts in specs that assert how many recipes a
picker offers; `tests/parts.spec.ts` is the worked example.

`retries: 0`, on purpose. The one flake this suite ever had turned out to be two
real faults, and a retry would have kept both hidden.

The fixture helpers in `tests/support/seed.ts` keep stderr from a failed local
Wrangler command. If a reseed or focused D1/R2 fixture write fails, diagnose the
reported Wrangler reason; do not replace it with a browser assertion fix.

The S-ostoslista tests proposed by #147 never reach the private service.
Playwright starts `tests/support/s-ostoslista-server.ts` on the port immediately
after `PLAYWRIGHT_PORT`, and local Wrangler receives that fixture URL plus a
harmless token through `--var`. The fixture records writes and can fail the next
request, which proves EAN/note payloads, pantry exclusion, and recoverable
outages without putting test rows on the phone's list.

The suite runs two Playwright projects (`playwright.config.ts`): `chromium`
(Pixel 7, a phone, because a week gets planned at the kitchen table) for
everything except `keep-awake-legacy.spec.ts`, and `legacy-ipad-fallback`
(WebKit forced on an iPad device profile, `navigator.wakeLock` removed by the
test) for that one spec — the closest reproducible target to pre-iPadOS-16.4
Safari, not real iOS. It is the first WebKit lane in the repo and the pattern
to follow for any future browser-specific spec: route by filename with
`testMatch`/`testIgnore`, not by tagging. For a fallback whose whole point is
real media or API behaviour, mocking the control flow (`play()`/`pause()`) is
not enough — `keep-awake-legacy.spec.ts` also has a dedicated test that lets
the real embedded `<video>` play, because that is the part compatibility
actually depends on.

A test that wants one of a line's uncommon fields — a range bound, a second
measurement, a spare row, or the intake review's whole editable draft form —
has to open it explicitly first, mirroring what a person does:
`tests/support/lines.ts` provides `openMore(line)`, `openSpareLines(page)` and
`openDraftEditor(page)` for exactly that; a new spec touching those fields
should use them rather than `.click()` on a hidden input. Two hand-built PNGs
used across the image specs — `onePixelPng()` (the smallest real upload) and
`emptySheet()` (a sheet with no artwork) — live in `tests/support/png.ts`.
`tests/walkthrough.spec.ts` is a
hand-walk of the whole product, not an assertion suite, and does not reseed on
purpose — it is meant to be pointed at whatever the development database
already holds; its own docstring says it is "kept out of `npm run check` and
CI", but nothing in `playwright.config.ts` or `.github/workflows/ci.yml`
actually excludes it, so it currently runs as part of any full
`npx playwright test` alongside the real specs.

**Focused locally, complete in CI.** A change runs the typecheck, the checks and
the specs that cover what it touched, and lets CI run everything else. This
proposal drops the rule that made a change full-suite for touching `src/html.ts`,
`src/router.ts`, `src/index.ts`, `src/auth.ts`, `src/env.ts` or a migration: the
suite still runs on every pull request, so running it here first only bought the
same answer four minutes earlier. A full local run is now for the cases where it
tells you something — a failure that could reach flows you did not touch,
reproducing a CI-only problem, or a change no spec covers.
`docs/agents/verification.md` has the rule and the table of which spec covers
what. `tests/support/dev-vars.ts::ensureDevVars()` creates
`.dev.vars` when it is missing and fills only blank `SESSION_SECRET` and Google
keys; a real Google client id is left alone, and `ANTHROPIC_API_KEY` is never
touched. This change makes the suite prepare the other half of its local
environment before `wrangler dev` starts:
`tests/support/local-d1.ts::ensureLocalD1()` applies the repository's D1
migrations to this worktree's local persistence. The new bootstrap establishes
only the schema; every spec's existing reseed remains responsible for fixture
data and isolation. A brand-new worktree still has no `node_modules`, so run
`./scripts/node.sh npm install` before the suite or typecheck can start.

`playwright.config.ts` reads `PLAYWRIGHT_PORT` (default 8787) for the port both
`wrangler dev` and the browser suite bind to. Two ruokalista agent sessions in
different worktrees both defaulting to 8787 share local D1 state and produce
`ERR_CONNECTION_REFUSED` and D1-lock-flavoured failures that look like code
bugs but are port/database contention — set `PLAYWRIGHT_PORT` to a scratch
value in one of them.

Until this pull request, setting it did nothing: `scripts/playwright.sh` runs
the suite in a container and forwarded only `HOME` and `CI`, so the variable
never reached `playwright.config.ts` and both worktrees still bound 8787.
Because `webServer.reuseExistingServer` is `true`, the second suite to start
did not fail — it quietly attached to the *other* worktree's `wrangler dev`,
testing that worktree's code against that worktree's database. The symptom was
a full suite failing over a hundred assertions in specs the change never
touched, with `connect ECONNREFUSED 127.0.0.1:8787` in the middle of it, which
reads like broad breakage rather than like two containers sharing a port. This
pull request forwards `PLAYWRIGHT_PORT` and `PLAYWRIGHT_WALKTHROUGH` into the
container so the documented remedy works. **If a full run fails widely, check
the port in the error against the one you set before reading the diff.** On a cold worktree, `wrangler dev`'s first boot inside
the Playwright container can also exceed the config's 120s
`webServer.timeout` even though it would have come up fine; if so, start
`wrangler dev` detached, poll `/health` until it answers, then run
`playwright test`, which picks it up via `reuseExistingServer: true` instead
of racing a fresh boot.

Screenshots land in `docs/screenshots/` and are committed as review artifacts —
nothing compares their PNG bytes, so rendering differences do not fail a build.
The flows and assertions in `screenshots.spec.ts` are still behavioural coverage
and run in every ordinary suite. Only its calls that write review artifacts are
conditional on `PLAYWRIGHT_SCREENSHOTS=1`, which `scripts/playwright.sh`
forwards into the container. `dev/check-screenshot-capture.ts` rejects direct
calls that would bypass that helper. Regenerate with
`PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots`
and commit what it wrote. They have caught
real layout bugs the assertions missed (a shared flex rule misplacing a save
button) — the visual diff does work the green checks don't. The bottom
navigation is `position: fixed`, so a full-page screenshot paints it wherever
the viewport was scrolled to, which is why it can show up partway down a tall
page; that is the screenshot, not the app. Regenerating after a copy tweak and
re-reading the result is a normal loop here, not a wasted step.

CI (`.github/workflows/ci.yml`) runs typecheck, the checks and the browser suite
on every pull request, in the same pinned Playwright image. It writes a
throwaway `.dev.vars` with no `ANTHROPIC_API_KEY` — if a test ever needs one, it
is calling the model, and that is a test that should not exist.

The restore round-trip is the one step this proposal makes conditional on a pull
request. It costs minutes where the rest of the check tier costs seconds, and it
can only say something when the schema, the backup format, the restore path or
their fixtures moved — so a "Decide whether the restore round-trip applies" step
diffs the pull request against its base and skips it otherwise. On a push to
`main` it always runs, because that is the run that migrates the live database
and deploys. The paths it watches are the same six-files list in `CLAUDE.md` plus
`scripts/check-backup-schema.ts`, `package.json` and the workflow itself; add to
that list in the workflow if you add another file the drill depends on.

**Merging to `main` deploys.** The same workflow applies any new migration and
then deploys, but only on a push to `main` and only after the tests pass. A pull
request never reaches that job, so the Cloudflare token is never exposed to one —
which is what makes keeping it in a public repository's secrets safe. It finishes
by curling the live site, because a deploy reporting success is not the same as
the app answering.

## Test-writing gotchas

- Prefer a specific locator over a shared label once more than one field can
  answer to it — `page.getByLabel("Nimi")` goes ambiguous once a second field
  uses that label; `page.locator("#title")` doesn't. Save button labels differ
  by screen too (editor: `"Tallenna muutokset"`, intake review:
  `"Tallenna resepti"`) — grep existing specs for a button-name locator before
  assuming one carries over from another screen.
- A recipe step's linked ingredient amounts sit in the markup with
  `display: none` on them until they are tapped (issue #120), so they are in
  `textContent` and therefore in a plain `toContainText`. Assert a step's
  wording with `{ useInnerText: true }`, which is what a person actually sees;
  `tests/intake.spec.ts`'s reordering test is the worked example.
- An assertion about household isolation has to pick something that is still
  household-scoped. Several specs used to prove the wall with the ingredient
  list; #143 made that dictionary global on purpose, and those assertions were
  rewritten to use a recipe instead. If a test named "another household cannot
  see X" starts failing, check whether X is still supposed to be private before
  changing the code.
- Don't assert on a behaviour a feature doesn't actually own — an "etag
  changes on regeneration" test built on a content-based-etag assumption was
  testing content-hashing behaviour the etag never promised, and was reworked
  to assert what the etag actually guarantees.
- A drawing/rasterizing helper's assumptions can be stricter than they look:
  `dev/support/sheet.ts`'s `dish()` needs every earlier cell populated or
  later bounding-box assertions drift; a "reaching the gutter" refusal needs
  `share: 0.66`+ on every drawn cell, not just the one under test; and the
  fractional circle rasterizer's "nothing was clipped" check tolerates ~4%
  area error, not ~2% — `dev/check-contact-sheet.ts` uses 0.04.

See also `docs/agents/verification.md` for which spec covers what.

## The dev checks run without a TypeScript compiler

`npm run check` runs `node --experimental-strip-types --test dev/*.ts`. Types are
*erased*, never compiled, so anything that needs code generation is a hard error
at import time — and it is an error in whichever `src/` module the check imports,
not in the check itself.

The one that has already cost a session: a constructor parameter property.

```ts
// Fails the check with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
constructor(readonly categories: readonly Category[]) {}

// Fine.
readonly categories: readonly Category[];
constructor(categories: readonly Category[]) { this.categories = categories; }
```

It typechecks, and it runs under `npx tsx`, which is what makes it confusing:
running the one check file directly with `tsx` passes while `npm run check`
reports the whole file as failed with no assertion in sight. Reach for
`node --experimental-strip-types --test dev/check-<name>.ts` when a check fails
in the suite but not on its own.

Enums and namespaces are the other members of that family. Nothing in `src/`
uses them today.

## A dev check with a real database

Almost everything in `dev/` tests a pure function, and anything that needs a
database goes to the browser suite instead. `dev/check-category-integrity.ts`
(#210) is the exception, and the shape is worth reusing when the same problem
comes up again.

What it is for is a race, not a screen: a category removed in the moment between
a save validating the vocabulary and the save writing it. That window is a few
statements wide and closes by itself, so no browser test can be aimed at it —
Playwright can press a button at the wrong moment, but not at that moment.

`dev/support/d1.ts::migratedDatabase` builds the answer. `node:sqlite` applies
the real migration files, `beforeBatch` runs something in exactly the window,
and the returned object satisfies enough of `D1Database` that `saveRecipe`,
`replaceRecipe` and the bulk category action run against it unchanged. Foreign
keys are on and a batch really is one transaction, because those are the two
things being checked; nothing else about it is a simulation.

It costs no wrangler, no container port and no live database. What it cannot
prove is that D1 accepts the statements — `npm run migrate:local` and the browser
suite are what do that.
