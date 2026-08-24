# ruokalista

A recipe store.

A household plans the week's meals together. Recipes exist in order to be placed
on days.

Nothing is built yet. The expensive-to-reverse decisions have been made and are
recorded on [the wayfinder map](https://github.com/eerovil/ruokalista/issues/1),
which indexes them and links to the ticket holding each one's full reasoning.
`CONTEXT.md` is the glossary those decisions produced. Research notes live on
unmerged `research/*` branches, linked from their tickets.

In short: a Cloudflare Worker in TypeScript over a D1 database. Recipes get in by
pasting text or photographing a printed page, and a language model turns either
into structured ingredient lines. Menus are dated meal entries, not records.
Members sign in with Google.

See `docs/agents/issue-tracker.md` for how the tracker is wired up.
