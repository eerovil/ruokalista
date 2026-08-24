# Ruokalista

A household plans which meals it will eat on which days. Recipes exist in order
to be placed on those days.

## Language

### The menu

**Household**:
The small group of trusted people this app serves. It is a single implicit
group, never a record: the app has no notion of the individual people in it.
_Avoid_: Family, team, tenant, user

**Recipe**:
Instructions for making one dish, held in the recipe store so it can be placed
on a day. The only thing that may appear on a menu.
_Avoid_: Dish, meal

**Menu**:
The set of meal entries falling in a range of dates — most often a week. Not a
record of its own and not owned by anything; asking for a menu is asking a
question about dates.
_Avoid_: Meal plan, week, schedule

**Meal entry**:
One recipe placed on one date in one slot, with a portion count. The unit the
whole app is built from.
_Avoid_: Meal, planned meal, menu item, entry

**Slot**:
Which of a day's two planned meals an entry belongs to: lunch or dinner. A day
has exactly these two, and each holds any number of meal entries — several
meaning different people eating different food at the same sitting.
_Avoid_: Mealtime, course, timeslot

**Portions**:
How many servings of that one recipe are wanted in that one slot. A bare count,
never a list of who is eating.
_Avoid_: Servings, yield, headcount

### Getting recipes in

**Intake**:
Getting a recipe into the store. Only two routes exist: pasting text, or
photographing a printed page. Nothing is ever fetched from a web address.
_Avoid_: Import, scraping, ingestion

**Source text**:
The Finnish text a recipe arrived as, kept forever exactly as it came in —
whether pasted or read off a photograph. What a recipe is re-derived from.
_Avoid_: Raw text, original, blob, paste

**Structuring**:
Turning source text into a recipe's title, ingredients and steps. Done by a
language model, because no parser for Finnish ingredient lines exists.
_Avoid_: Parsing, extraction, OCR
