# ruokalista

A recipe store.

A household plans the week's meals together. Recipes exist in order to be placed
on days.

The expensive-to-reverse decisions have been made and are recorded on [the
wayfinder map](https://github.com/eerovil/ruokalista/issues/1), which indexes
them and links to the ticket holding each one's full reasoning. `CONTEXT.md` is
the glossary those decisions produced, and `docs/spec.md` turns them into the v1
build spec — the D1 schema, the screens, and the intake flow.

In short: a Cloudflare Worker in TypeScript over a D1 database. Recipes get in by
pasting text or photographing a printed page, and a language model turns either
into structured ingredient lines. Menus are dated meal entries, not records.
Members sign in with Google.

## Local development

Requires Node.js and npm.

```sh
npm install
npm run db:migrate:local
npm run dev
```

The app is then served by Wrangler (normally at `http://localhost:8787`). The
`/health` endpoint performs a real `SELECT 1` through the D1 binding and returns
`{"ok":true}` when the Worker and local database plumbing are both working.

`wrangler.jsonc` intentionally contains a placeholder D1 database UUID so local
development can be bootstrapped before a production database exists. Before the
first deployment, create the real database with Cloudflare and replace the
placeholder `database_id` with the returned UUID.

See `docs/agents/issue-tracker.md` for how the tracker is wired up.
