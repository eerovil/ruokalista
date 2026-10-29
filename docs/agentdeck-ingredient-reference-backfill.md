# AgentDeck ingredient-reference backfill

This change proposes a one-off handoff for recipes saved before issue #120.
The nightly backup is the source; neither AgentDeck nor these tools need
Cloudflare credentials or an Anthropic API call.

Every generated file contains private household data. Keep all three under
`.generated/`, which Git ignores, and never commit or paste their contents into
an issue, pull request, or chat transcript.

## 1. Export the marking input

From the repository root, run:

```sh
./scripts/export-ingredient-ref-backfill.sh
```

The script reads `snapshot.json` from `eerovil/ruokalista-backup` with `gh`,
validates its digest and the recipe/ingredient relationships needed here, and writes
`.generated/ingredient-reference-export.json`. The small output contains only
each unmarked recipe's id, ingredient positions/ids/names, and step
positions/texts. An already non-NULL `ingredient_refs` value is never exported.
If the snapshot predates #120 and therefore has no such column, all of its steps
are unmarked and eligible.
The check deliberately permits unrelated tables to trail the checkout: a nightly
snapshot can predate a migration merged later the same day without making its
recipe rows untrustworthy.

## 2. Mark in an AgentDeck session

Give the session the export file and this contract. Ask it to write
`.generated/ingredient-reference-marks.json`:

```json
{
  "formatVersion": 1,
  "snapshotSha256": "copy from the export",
  "recipes": [
    {
      "recipeId": 123,
      "steps": [
        {
          "position": 1,
          "ingredientRefs": [
            {
              "ingredientId": 456,
              "matchedText": "tomaatit",
              "approxPosition": 6
            }
          ]
        }
      ]
    }
  ]
}
```

Standing rules for the marking session:

- Preserve `formatVersion`, `snapshotSha256`, recipe ids, step positions, and
  every step text. The marks file may omit recipes and steps with no confident
  marks.
- Point only at an ingredient id listed for that recipe.
- Copy `matchedText` from the step's own wording. Never include an amount,
  invent an ingredient, or reword a step.
- Use `approxPosition` only as the rough zero-based start of that wording.
- Leave a generic or uncertain phrase unmarked. Missing a link is safer than
  showing the wrong ingredient amount.
- Return JSON only. Do not call the Anthropic API.

## 3. Validate and make SQL

Run:

```sh
./scripts/node.sh node --experimental-strip-types \
  scripts/apply-ingredient-ref-backfill.ts \
  --export .generated/ingredient-reference-export.json \
  --marks .generated/ingredient-reference-marks.json \
  --output .generated/ingredient-reference-backfill.sql
```

The validator drops malformed marks, ingredients that do not belong to the
recipe, wording that `mentionResolves` cannot find in the real step text, and
any step exceeding `MAX_REFS_PER_STEP`. A step with no accepted marks produces
no statement. It reports only counts, not household text.

Inspect the counts and SQL structure without copying its private contents into
review systems. The SQL updates only `recipe_step.ingredient_refs`. Every
statement also requires the step text to still equal the backup, all referenced
ingredient lines to still belong to the recipe, and `ingredient_refs` to still
be NULL. Those guards make a stale snapshot or second run a no-op.

Run this while nobody has a recipe editor open: this backfill deliberately does
not bump `recipe.revision`, so saving an older open form would replace the new
references. Apply it once with:

```sh
./scripts/node.sh --cloudflare npx wrangler d1 execute ruokalista --remote \
  --file .generated/ingredient-reference-backfill.sql
```

`--cloudflare` is what loads the saved account credentials and forwards them
into the container; without it wrangler cannot reach the account at all and
says so. It is the same flag `push-google-secrets.sh` and `cloudflare-setup.sh`
use, and nothing has to be exported by hand first.

Production execution is a separate, deliberate operator step. This repository
change does not run it.

## Adding group phrases to existing recipes (#376)

Since #376 a phrase like "kuivat aineet" may stand for several ingredient
lines: one reference per line, all with the same wording, and the recipe screen
lists them after the phrase. Recipes imported before that have no such groups,
and most of their steps already hold single references, so the job above
(which only fills empty steps) never reaches them. Its second mode does.

Export every step, marked or not, with what it already holds:

```sh
./scripts/export-ingredient-ref-backfill.sh .generated/ingredient-group-export.json --groups
```

The export is `formatVersion: 2`, and each step carries `existingRefs`: the
stored column exactly as the snapshot had it, or `null`.

Ask the AgentDeck session to write `.generated/ingredient-group-marks.json`
in the same shape as above, but with `"formatVersion": 2`, and with these
rules on top of the standing ones:

- Mark **only group phrases**: wording that stands for two or more of the
  recipe's ingredients, such as "kuivat aineet", "märät aineet" or "kastikkeen
  ainekset". Write one reference per ingredient in the group, all with the same
  `matchedText` (the whole phrase) and the same `approxPosition`.
- Leave "lisää loput ainekset" and anything else whose contents depend on what
  earlier steps used unmarked, and leave a phrase unmarked when unsure which
  lines it covers.
- Do not repeat a step's `existingRefs`; they are kept as they are.

Then validate and make SQL with the same apply command, pointing at the group
files:

```sh
./scripts/node.sh node --experimental-strip-types \
  scripts/apply-ingredient-ref-backfill.ts \
  --export .generated/ingredient-group-export.json \
  --marks .generated/ingredient-group-marks.json \
  --output .generated/ingredient-group-backfill.sql
```

On top of the checks above, it drops any mark whose wording is not shared by
at least two distinct ingredients in that step, drops a group the step already
holds, and drops a step's new marks if they would take it past
`MAX_REFS_PER_STEP`. Each statement writes the existing references followed by
the new ones, and is guarded on the column still holding exactly what the
snapshot had, so an edit since the snapshot, or a second run, is a no-op. Apply
it with the same `wrangler d1 execute` command, with the same caution about open
editors.
