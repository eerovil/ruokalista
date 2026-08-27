# How much to verify before opening a pull request

CI is the gate. `.github/workflows/ci.yml` runs the typecheck, the checks, the
backup round-trip and the whole browser suite on every pull request, and merging
to `main` deploys. Nothing here lowers that bar, and nothing here is a reason to
merge something CI has not agreed with.

What this proposes to change is the run *before* the pull request. A session that
reruns the entire browser suite locally for a two-line ordering fix is paying for
the same answer twice — once in a container on this host, and again in CI four
minutes later — and that duplication is most of why an implementation session
takes an hour when the change took ten minutes.

So pick a tier, and say in the pull request which one you picked.

## The focused tier

This is the default. Use it for a change whose blast radius you can name.

1. `./scripts/node.sh npm run typecheck`
2. `./scripts/node.sh npm run check`
3. the browser spec or specs that cover what you touched, and only those:
   `./scripts/playwright.sh npx playwright test tests/week.spec.ts`
4. one screenshot, only when the change is visual, and only of the screen that
   changed
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
| the recipe screen, the list, the picker | `recipes.spec.ts` |
| the editor, the line form | `editor.spec.ts` |
| ingredient mentions in a step, tap to reveal an amount | `ingredient-mentions.spec.ts`, `dev/check-ingredient-refs.ts` |
| portions, factors, rounding | `scaling.spec.ts` |
| parts of a dish | `parts.spec.ts` |
| import, the review screen, the streaming island | `intake.spec.ts`, `batch-intake.spec.ts` |
| pictures, upload, the bulk API | `recipe-images.spec.ts` |
| the contact-sheet splitter, the crop rules | `dev/check-contact-sheet.ts` |
| choosing recipes, the copied prompt, cutting a sheet in the browser | `recipe-image-admin.spec.ts` |
| sign-in, sessions, the development shortcut | `auth.spec.ts` |
| the admin gate, the admin screen | `admin.spec.ts` |
| the shell, the tabs, navigation | `shell.spec.ts` |
| escaping, ownership, refusals | `hardening.spec.ts` |
| keeping the screen awake | `keep-awake.spec.ts`, `keep-awake-legacy.spec.ts` |

If you cannot find the row your change belongs to, that is itself the answer:
you are in the full tier.

## The full tier

Run everything locally — `npx playwright test` with no path — when any of these
is true:

- the change is in something every screen goes through: `src/html.ts`,
  `src/router.ts`, `src/index.ts`, `src/auth.ts`, `src/env.ts`, the shell's CSS,
  or a migration
- the change alters the database schema, the backup format, or the restore path
- no focused spec covers it, so "the suite" is the only coverage there is
- a test failed and the failure could plausibly reach a flow you were not
  working on — a suspected shared-state or session fault is not a narrow change,
  whatever the diff says
- you are about to claim something works live, rather than that it is ready for
  CI to check

The full tier is not a punishment for a big change; it is what you do when you
genuinely cannot say what the change cannot break.

## After a review fixes something

A review pass — `review-fix-pr`, `code-review`, or a person — reruns validation
proportional to its own fix, not the whole release sequence again. A wording
change in a comment reruns nothing. A one-line correction in a rendering
function reruns the typecheck, the checks and that screen's spec. Only a fix
that widens the risk surface — it moves to a file in the full-tier list above,
or it changes behaviour the original change did not touch — earns a full rerun.

Evidence already gathered this session stays valid as long as the fix could not
have invalidated it. Do not recapture a screenshot of a screen the fix did not
render differently.

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
