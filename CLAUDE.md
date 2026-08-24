# ruokalista

A recipe store. Nothing is implemented yet. The stack is decided — a Cloudflare
Worker in TypeScript over D1 — along with everything else expensive to reverse;
see the wayfinder map (issue #1) for the decisions and `docs/spec.md` for the
v1 build spec.

## Agent skills

### Issue tracker

Issues, PRDs and wayfinder maps live in this repo's GitHub Issues, driven with
the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, unchanged: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. `CONTEXT.md`
exists and is the glossary to use; `docs/adr/` does not yet, and gets created
lazily by `/domain-modeling`. See `docs/agents/domain.md`.
