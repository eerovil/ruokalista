# ADR-0002: A part of a dish is a recipe

## Status

Accepted, 2026-08-25. Goes past what [the map](https://github.com/eerovil/ruokalista/issues/1)
locked, which is why it is written down.

## The problem

A lasagne is not one list of ingredients. It is a *jauhelihakastike* and a
*juustokastike*, each with its own ingredients and its own method. The same is
true of a cake with a filling, a roast with a sauce, a salad with a dressing.

Forced into one flat list, a lasagne reads wrong at the hob: you cannot tell
which 2 dl of milk belongs to which sauce.

## The decision

**A part of a dish is a recipe.** Not a new kind of record — the same `recipe`
row, with a parent.

```sql
ALTER TABLE recipe ADD COLUMN parent_id INTEGER REFERENCES recipe(id);
ALTER TABLE recipe ADD COLUMN part_position INTEGER;
```

`parent_id` NULL means "this is a dish". Non-null means "this is a part of that
dish, in this position".

### Why not a section table

The obvious alternative was a `recipe_section` table with lines and steps
pointing at it. It was drafted and rejected: a part has ingredients, steps, a
title and a yield — which is the whole of what a recipe is. Introducing a second
record with the same shape would have meant every read, every screen and the
editor learning to handle two things that behave identically.

`CONTEXT.md` says a recipe is "instructions for making one dish". A
jauhelihakastike is instructions for making one thing. It is a recipe.

### A part belongs to one dish

Two lasagnes with a *juustokastike* have two parts, not one shared record. They
are different sauces that happen to share a name, and sharing would mean editing
one dish silently changed another.

That also decides visibility: **parts do not appear in the recipe list or the
picker.** Only dishes do. A part is reached through its parent, and putting a
sauce on a Tuesday by itself is not a thing the household wants to do.

### One level, no deeper

A part cannot itself have parts. Nothing in a household kitchen needs it, and a
tree makes every read recursive.

## What this does not decide

**Scaling is deliberately left alone.** If a lasagne yields 4 and it is planned
for 6, its parts are shown exactly as written. Whether the parts should scale
with the parent is a real question and it is not answered here.

**Turning an existing flat recipe into a dish with parts** is not supported yet.
Dishes with parts are born that way, from a page that had sub-headings.

## The one wrinkle

A page can have sub-headings *and* loose lines: two sauces, plus the lasagne
sheets that belong to neither. Those loose lines stay on the parent, so a dish
may hold both parts and a little of its own.

The alternative was to invent a part to put them in, which would mean inventing a
Finnish name for something the page never named. Keeping them where the page put
them is the lesser evil.

## Consequences

Every existing recipe is unchanged and still valid — a dish with no parts is
exactly what a recipe was before this.

Editing a recipe already replaces its children wholesale; parts are separate
recipe rows, so each is edited on its own screen. Deleting a dish deletes its
parts with it.
