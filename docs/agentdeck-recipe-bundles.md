# AgentDeck recipe bundles

This change introduces a model-free handoff for original recipes generated in
an AgentDeck-owned session. The generated file is private household data: write
it under `.generated/`, which this change adds to `.gitignore`, and never commit
the file.

The generator should produce a version 1 bundle, not database rows:

```json
{
  "format_version": 1,
  "generator": {
    "via": "agentdeck",
    "provider": "codex",
    "model": "gpt-5.6"
  },
  "recipes": [
    {
      "title": "Sitruunainen papukeitto",
      "yield_portions": 4,
      "source_text": "Sitruunainen papukeitto\n2 dl valkoisia papuja\nKeitä 15 minuuttia.",
      "steps": [
        { "text": "Keitä 15 minuuttia.", "section": null, "phase": null }
      ],
      "lines": [
        {
          "quantity": 2,
          "quantity_max": null,
          "unit": "dl",
          "alt_quantity": null,
          "alt_unit": null,
          "ingredient_id": null,
          "ingredient_name": "valkoinen papu",
          "source_line": "2 dl valkoisia papuja",
          "section": null,
          "phase": null,
          "note": null
        }
      ]
    }
  ]
}
```

Generation contract:

- Generate original Finnish household recipes; do not copy publisher text.
- Use the intake wire fields shown above, never D1-shaped rows.
- Leave every `ingredient_id` as `null`. Ruokalista resolves current household
  ingredients during review.
- Use clean canonical Finnish ingredient names, without brand or preparation
  prose when a stable ingredient name is enough.
- Prefer unambiguous, representable amounts and units. Never invent an amount
  that the generated source text does not state.
- Write a complete `source_text`, and copy each `source_line` from one of its
  lines verbatim.
- Use named `section` values only for real parts of a dish. For a multipart
  dish, parent-level content has `before_parts` or `after_parts`; content inside
  a named part has a null phase. A plain recipe has null sections and phases.
- Before handoff, self-check unique titles, verbatim source lines, sections and
  phases, realistic quantities, null ingredient IDs, and obvious near-duplicate
  recipes in the batch.

The signed-in member can upload or paste the file from the proposed
`/intake/batch` screen. Ruokalista will validate the full bundle, show its
provenance and proposed new ingredients, allow each proposed name to be
repointed to an existing ingredient, preview every recipe, and only then offer
the save action. No Anthropic intake call or AgentDeck production credential is
part of this path.
