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

`scripts/cloudflare-setup.sh` does the whole setup in one command and is safe to
re-run. It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token is
handed over one command at a time and may be single-use, which is why the script
does everything in one run and keeps going after a failed step instead of
abandoning the rest.

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

## Checks

`npm run check` runs `dev/*.ts` under node's own test runner — no test framework
as a dependency. `dev/` is outside the Worker's tsconfig on purpose: node's
globals clash with the Workers ones.

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
