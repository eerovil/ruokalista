# The development environment

Running the app and its checks on this host: the container, the dev server, `.dev.vars`, minting a session, dev sign-in, and the traps that cost a session real turns.

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

## What counts as "local" — and why it's wider than loopback

`isLocalOrigin` (`src/public-origin.ts`) recognizes more than loopback and
private-network addresses: it also treats Tailscale's CGNAT range
(`100.64.0.0`–`100.127.255.255`) and any hostname ending in `.ts.net` as local.
This exists specifically so `tailscale serve --https=8787 http://127.0.0.1:8787`
can expose the dev server over HTTPS to a phone on the same tailnet — the
session cookie is `Secure`, so plain-HTTP LAN access can't carry it.

Google's real OAuth flow cannot complete when the dev server is reached through
`tailscale serve`: Tailscale's proxy talks plain HTTP to the app, so
`publicOrigin`/`googleCallbackUrl` (`src/public-origin.ts`) build an
`http://…ts.net/auth/google/callback` redirect URI, and Google rejects
non-HTTPS redirect URIs outside localhost. This is *why* `Kehityskirjautuminen`
exists — not just "no Google credentials in CI" but "no way to complete Google
sign-in at all when testing over a tailnet."

The private-IPv4 check (`src/public-origin.ts::isPrivateIpv4`) is a hand-parsed
octet check, not a regex: a first attempt written as a pattern
(`/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}$/`) miscounted
octets and returned `false` for `10.0.0.7`. This class of function is worth
treating carefully on any future change — getting it subtly wrong in the "safe"
direction blocks a legitimate LAN or tailnet test, but getting it wrong the
other way is exactly how a shortcut ships. `dev/check-local-origin.ts` is the
regression guard, exercised directly rather than only through a browser test
that always runs on 127.0.0.1 and would agree with any implementation that just
returned `true`.

## A fresh worktree has no `.dev.vars`

`.dev.vars` is gitignored and is not carried by `git worktree add`, so a fresh
agent worktree for this repo starts with none. The browser suite's own fixup,
`tests/support/dev-vars.ts::ensureDevVars()` (called from `playwright.config.ts`
before `wrangler dev` starts), only fills in blanks in a file that already
exists — it does not create the file. With zero `.dev.vars`, the first failure
is an unrelated-looking `ENOENT: no such file or directory, open
'/app/.dev.vars'` out of `tests/support/session.ts::sessionSecret()`, not a
clear "run this setup step" message. Copy `.dev.vars.example` to `.dev.vars` in
every new worktree before running local D1 commands or the Playwright
`webServer`.

`ensureDevVars()` only fills `SESSION_SECRET`, `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` when they're blank — a real value already in
`.dev.vars` (e.g. because somebody signs in with Google locally) is left
alone, and `ANTHROPIC_API_KEY` is never touched. See
[testing](docs/codebase/testing.md) for how the browser suite uses this.

## A parameter-property constructor can break a `dev/*.ts` check

Node's `--experimental-strip-types` (used by `dev/*.ts` checks, see
[testing](docs/codebase/testing.md)) only strips types — it does not desugar
TypeScript syntax such as parameter-property constructor sugar (e.g.
`constructor(readonly value: string) {}`). One such line used to sit in
`src/html.ts::Raw`; it's since been rewritten longhand (a plain field plus an
ordinary assignment in the constructor body), because the sugar made every
module that transitively imports `html.ts` — most of `src/`, via `auth.ts` —
fail to load under `node --experimental-strip-types --test`, blocking any new
`dev/` check that reaches into those modules. Worth checking before adding a
`dev/*.ts` check that imports deep into `src/`: a parameter-property
constructor anywhere in that import chain fails with an unhelpful stack trace,
not an obvious syntax error. `grep -n "constructor(readonly\|constructor(private\|constructor(public" src/*.ts`
is the quick way to rule it out.
