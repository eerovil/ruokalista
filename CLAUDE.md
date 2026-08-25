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

That script is a developer tool, not a route. The Worker has no way to sign
anyone in without Google, on purpose — a shipped auth bypass is one of the things
that went wrong in #13.

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

Intake has two paths on purpose. Without JavaScript the form posts to `/intake`
and the model call is a plain request. With it, the island in
`src/intake-screens.ts` streams from `/api/intake/structure` so bytes never stop
flowing, then hands the finished draft to `/intake/correct` — which keeps the
correction screen server-rendered rather than built in the browser. The camera
route needs the island either way: downscaling a photograph is a canvas job.

## Checks

`npm run check` runs `dev/*.ts` under node's own test runner — no test framework
as a dependency. `dev/` is outside the Worker's tsconfig on purpose: node's
globals clash with the Workers ones.

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

Screenshots land in `docs/screenshots/` and are committed as review artifacts —
nothing compares them, so they cannot fail a build. Regenerate with
`./scripts/playwright.sh npx playwright test screenshots`.

## HTML

`src/html.ts` holds the one shell and the `html` tagged template, which escapes
every interpolated value. `raw()` is the only way past that escaping, so it is
also the only thing to check when reviewing for injection.

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
