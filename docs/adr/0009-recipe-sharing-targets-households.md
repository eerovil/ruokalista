# ADR-0009: Recipe sharing targets households

## Status

Proposed by issue #185. This proposal extends ADR-0006's public-or-private
publication rule without changing its shared-not-copied recipe model.

## The decision this change introduces

A dish has one of three visibility states:

- **private** — only its owning household may read it;
- **selected** — its owner and one or more named recipient households may read
  and plan it; or
- **public** — every signed-in household may read and plan it.

Ownership never moves. Every edit, image write, deletion and sharing change
stays scoped to `recipe.household_id`; a recipient reads the same recipe row and
therefore sees the owner's later corrections immediately. Parts still ride with
their dish and are not independently shareable or directly addressable.

Public visibility remains `recipe.published_at`. Selected recipients are rows in
`recipe_share(recipe_id, household_id)`. The states are kept unambiguous: making
a recipe public clears selected-recipient rows, and making it selected clears
the public fields. A selected state with no recipient is refused.

## Recipient discovery

Recipients are households, not members. Every signed-in member may search all
household display names, because a recipient picker cannot work without a
shared directory. The picker returns no member name, email, Google subject or
admin status, and sharing never creates a user-level ACL.

The recipe API follows the same boundary. Across households, its existing
string-shaped `createdBy` field says the owning household's name rather than an
individual member's display name.

## Taking access back

A sharing change first identifies the households that would lose access. It is
refused if any of those households has the dish on a future planned occurrence.
Adding a recipient never blocks. Removing one selected recipient checks that
recipient only; changing public to selected checks every non-selected household;
changing to private checks every other household.

Past occurrences remain historical records and do not block a change, matching
ADR-0006. A recipe with either public or selected recipients must be made private
before deletion, and deletion still checks every household's remaining batches.

## Consequences

Every server-side read and planning gate uses owner-or-public-or-selected logic:
the recipe screen and API, shared list, picker, batch writes, recipe preferences,
ingredient usage counts and recipe images (including images on parts). UI hiding
is never the authorization boundary; an unshared direct URL remains a 404.

`recipe_share` joins the backup and restore manifest in the repository's usual
six-file lockstep.
