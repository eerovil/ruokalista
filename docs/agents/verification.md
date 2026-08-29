# How much to verify before opening a pull request

CI is the gate. `.github/workflows/ci.yml` runs the typecheck, the checks and
the whole browser suite on every pull request — plus the restore round-trip
whenever the schema, the backup format or the restore path moved — and merging
to `main` deploys. Nothing here lowers that bar, and nothing here is a reason to
merge something CI has not agreed with.

What this proposes to change is the run *before* the pull request. A session that
reruns the entire browser suite locally for a two-line ordering fix is paying for
the same answer twice — once in a container on this host, and again in CI four
minutes later — and that duplication is most of why an implementation session
takes an hour when the change took ten minutes.

One rule, and everything below is that rule spelled out: **focused locally,
complete in CI.** Say in the pull request exactly what you ran.

## The focused tier

This is what a change normally gets — not a shortcut you have to earn, and not
something a particular filename can take away from you. Use it whenever you can
name what your change could break.

1. `./scripts/node.sh npm run typecheck`
2. `./scripts/node.sh npm run check`
3. the browser spec or specs that cover what you touched, and only those:
   `./scripts/playwright.sh npx playwright test tests/week.spec.ts`
4. one screenshot, only when the change is visual, and only of the screen that
   changed — screenshot capture is opt-in, so it is
   `PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots`
5. open the pull request and let CI run the rest

Steps 1 and 2 are cheap and catch most of what a full suite would have caught, so
they are not optional at any tier.

Every spec reseeds the local database in `beforeAll`, so running one spec on its
own is as sound as running it inside the suite — the reseed is not something the
other specs do for it. `reuseExistingServer` means a `wrangler dev` you already
have up is used rather than a second one started.

Which spec covers what, roughly:

| What changed | The spec to run |
| --- | --- |
| the week, the days, a planned meal | `week.spec.ts`, `week-grouping.spec.ts` |
| the shopping list, ingredient aggregation | `shopping.spec.ts`, `dev/check-shopping.ts` |
| the shopping row's own layout on a narrow phone | `shopping-row-213.spec.ts` |
| the recipe screen, the list, the picker | `recipes.spec.ts` |
| the editor, the line form | `editor.spec.ts` |
| removing an ingredient a step still mentions | `editor.spec.ts`, `dev/check-line-removal.ts` |
| ingredient mentions in a step, tap to reveal an amount | `ingredient-mentions.spec.ts`, `dev/check-ingredient-refs.ts` |
| portions, factors, rounding | `scaling.spec.ts` |
| parts of a dish | `parts.spec.ts` |
| categories, the list's category filter | `categories.spec.ts`, `dev/check-categories.ts` |
| import, background jobs, the review screen | `intake.spec.ts`, `batch-intake.spec.ts` |
| pictures, upload, the bulk API | `recipe-images.spec.ts` |
| the contact-sheet splitter, the crop rules | `dev/check-contact-sheet.ts` |
| choosing recipes, the copied prompt, cutting a sheet in the browser | `recipe-image-admin.spec.ts` |
| sign-in, sessions, the development shortcut | `auth.spec.ts` |
| the admin gate, the admin screen | `admin.spec.ts` |
| households and their members, admin-side | `household-admin.spec.ts` |
| the shell, the tabs, navigation | `shell.spec.ts` |
| escaping, ownership, refusals | `hardening.spec.ts` |
| keeping the screen awake | `keep-awake.spec.ts`, `keep-awake-legacy.spec.ts` |
| the schema, a migration, the backup or restore path | `npm run check:backup-schema`, `npm run check:restore-roundtrip` |

A change that touches a file every screen goes through — `src/html.ts`,
`src/router.ts`, `src/index.ts`, `src/auth.ts`, `src/env.ts`, the shell's CSS, a
migration — is still a focused change if you can say which screens it reaches.
A one-line fix to how one shopping row is drawn does not become a release
because the function lives in `src/html.ts`. Run the specs for the screens it
reaches, and let CI run the other three hundred tests it does not.

If you cannot find the row your change belongs to, that is itself the answer:
run the whole suite locally, because there is nothing narrower to run.

## Running the whole suite locally

This proposal makes a full local `npx playwright test` the exception, not the
tier a filename puts you in. Do it when:

- a test failed and the failure could plausibly reach a flow you were not
  working on — a suspected shared-state or session fault is not a narrow change,
  whatever the diff says
- CI failed something your focused run passed, and you are reproducing it here
- no focused spec covers what you changed, so the suite is the only coverage
  there is
- you are about to claim something works live, rather than that it is ready for
  CI to check

Everything else goes to CI, which runs the complete browser suite on every pull
request and is the thing that has to be green before a merge. Opening a pull
request without the full local run is not skipping verification; it is running
it once instead of twice.

## After a review fixes something

A review pass — `review-fix-pr`, `code-review`, or a person — reruns validation
proportional to its own fix, not the whole release sequence again. A wording
change in a comment reruns nothing. A one-line correction in a rendering
function reruns the typecheck, the checks and that screen's spec. Only a fix
that widens the risk surface — it changes behaviour the original change did not
touch, or it lands somewhere the focused specs you already ran do not reach —
earns anything more.

Evidence already gathered this session stays valid as long as the fix could not
have invalidated it. Do not recapture a screenshot of a screen the fix did not
render differently.

## What CI runs, so you know what you are handing it

Every pull request gets the typecheck, `npm run check`, the backup-schema check
and the complete browser suite. That is the gate; it has not moved.

One thing this proposal takes out of the ordinary pull-request run, because it
was paid for on every change and earned nothing on most of them:

- The restore round-trip costs minutes next to seconds for everything else in
  the check tier, and it can only tell you something when the schema, the backup
  format, the restore path or their fixtures moved. So on a pull request it runs
  only when one of those files changed. On a push to `main` — the run that
  applies migrations to the live database and deploys — it always runs.
- `tests/screenshots.spec.ts` remains part of every ordinary browser run because
  it contains behavioural flows and assertions. Its PNG bytes are not compared,
  so only writing those review artifacts is opt-in:
  `PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots`.
  Commit what it wrote, the same as before.

Every behavioural spec still runs on every pull request. Nothing here decides
what CI checks by looking at which files you touched.

## The Google values

The browser suite fills its own blanks. `tests/support/dev-vars.ts` runs from
`playwright.config.ts` before `wrangler dev` starts, and writes a
`SESSION_SECRET`, a `GOOGLE_CLIENT_ID` and a `GOOGLE_CLIENT_SECRET` into
`.dev.vars` if they are missing or empty — the same harmless placeholders CI
writes for itself.

This removes a fail-then-rerun that was pure waste: `.dev.vars.example` ships the
Google values empty, and two specs in `auth.spec.ts` need them set, so the first
run on a fresh checkout always failed and always had to be started again.

It fills blanks only. A real client id you put there to sign in with Google
locally is left alone, and `ANTHROPIC_API_KEY` is never written — a browser test
that reached Anthropic would be a test that should not exist.
