# ADR-0003: Parent content has a cooking phase

## Status

Proposed by issue #58, 2026-08-25. This change implements the product decision
recorded in issue #50 without changing ADR-0002's one-level recipe parts.

## The decision this change introduces

Ingredient lines and steps on a multipart dish may carry `before_parts` or
`after_parts`. The cooking view uses those meanings to show parent preparation,
then each named part in its existing order, then parent assembly and finishing.
The phase is not a general sequence or dependency graph.

Named parts do not carry phases of their own. A plain recipe also leaves the
field empty and continues to render in its stored line and step order.

## Existing multipart recipes

The migration leaves every existing line and step `NULL`. That value means
"unclassified", not "the model chose before parts". The cooking view keeps such
parent content in its old parent-first position, alongside `before_parts`, so
the migration does not reorder existing recipes. The editor names this legacy
behavior and lets a member classify it deliberately.

New model-structured multipart drafts assign a phase to parent content. Content
inside a named part and all content in a plain recipe remain `NULL`.
