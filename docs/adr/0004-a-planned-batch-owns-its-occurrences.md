# ADR-0004: A planned batch owns its occurrences

## Status

Proposed by issue #57, 2026-08-26. This change intentionally replaces the
earlier assumption that one meal entry is the unit of the menu.

## The decision this change introduces

A **planned batch** represents one cooking of one recipe. It has stable identity,
belongs to a household, records its creator and cooked portions, and owns an
ordered set of **occurrences**. Each occurrence is one date plus lunch or dinner.
Two batches of the same recipe remain two different planned batches.

A menu remains a date-range query rather than a record. The query will project
every batch whose chronological span intersects the requested dates, including a
batch that begins before or ends after the visible week.

Coverage must contain at least one occurrence. Between its first and last dates,
every intervening day must contain at least one occurrence; lunch and dinner do
not otherwise need to form a continuous sequence. Cooked portions provide
display and recipe-scaling context but never determine coverage.

## Persistence introduced by this change

`planned_batch` will hold the stable identity, recipe, household, creator, and
portions. `batch_occurrence` will hold its selected `(date, slot)` values. The
same slot may still contain any number of batches, and independent batches may
overlap.

The migration will turn every existing `meal_entry` into one `planned_batch`
with one `batch_occurrence`, preserving its id, recipe, household, creator,
portion count, date, and slot. It will not infer continuations from recipe ids.

## Consequences

Editing coverage, portions, recipe, or deletion addresses the whole batch. The
week screen and API consume the projected batch view rather than copied entries.
Backup and restore include both new tables so batch identity and occurrence sets
round-trip together.
