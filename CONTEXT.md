# Ruokalista

A household plans which meals it will eat on which days. Recipes exist in order
to be placed on those days.

## Language

### Who uses it

**Household**:
A group of people who plan meals together, and the owner of everything they
create — every record belongs to exactly one. More than one can exist, but
nothing in the app creates them.
_Avoid_: Family, team, tenant, account

**Member**:
One person in a household, known by the Google account they sign in with.
Everything they create is attributed to them, and every member of a household
may do everything.
_Avoid_: User, person, owner, role

### The menu

**Recipe**:
Instructions for making one dish, held in the recipe store so it can be placed
on a day. The only thing that may appear on a menu.
_Avoid_: Dish, meal

**Part**:
A named piece of a dish that has its own ingredients and its own method — a
lasagne's jauhelihakastike. A part is a recipe with a parent, not a new kind of
record. It belongs to one dish, is reached only through it, and never appears in
the recipe list or on a menu by itself.
_Avoid_: Section, component, sub-recipe, group

**Menu**:
The set of meal entries falling in a range of dates — most often a week. Not a
record of its own and not owned by anything; asking for a menu is asking a
question about dates.
_Avoid_: Meal plan, week, schedule

**Meal entry**:
One recipe placed on one date in one slot, with a portion count. The unit the
whole app is built from.
_Avoid_: Meal, planned meal, menu item, entry

ADR-0004 proposes replacing this unit with a **planned batch**: one cooking of
one recipe with stable identity, cooked portions, and its own selected
date/slot occurrences. Until that proposal merges, meal entry remains the live
term above.

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

### What a recipe is made of

**Ingredient line**:
One line of a recipe: how much, in what unit, of which ingredient — plus the
sentence it was written as. Quantity and unit may be missing, and are never
guessed. A quantity may be a range, and a line may state the same amount twice
in different units ("½ (500 g) valkokaali"); neither of the two is the primary
one, and nothing is ever converted between them.
_Avoid_: Ingredient (that is the shared record), row, item

**Ingredient**:
A shared record for one foodstuff, referred to by every line that uses it. No
new one exists until a human has approved it, which is what keeps "purjo" and
"purjosipuli" from both existing.
_Avoid_: Product, foodstuff, item, ingredient name

**Unit**:
The measure a quantity is written in — dl, rkl, tl, kpl, g. Kept exactly as the
recipe stated it; nothing is ever converted between units.
_Avoid_: Measure, uom

**Yield**:
How many portions a recipe's own ingredient quantities make. Unknown unless the
source said so, and a recipe of unknown yield cannot be scaled.
_Avoid_: Servings, portions (that is the count on a meal entry), makes
