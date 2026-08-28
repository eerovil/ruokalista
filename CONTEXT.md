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
may do everything the household does day to day — plan, cook, import, edit.
_Avoid_: User, person, owner, role

**Admin**:
A member who may also use the few operations that are not everybody's to run:
the ones that spend money or rewrite what the household already has. It is one
flag on the member row, marked by hand like membership itself, and it is the
only distinction between members there is or is meant to be. This is what #94
proposes; before it, every member could do everything.
_Avoid_: Role, permission, superuser, owner

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

ADR-0007 proposes replacing this unit with a **multiplier**. Until that
proposal merges, portions remains the live term above.

**Multiplier**:
How much of a recipe one cooking makes. The recipe as written is 1×; 1,5× is
half again of every amount in it. It is a property of the planned batch, and it
is what every scaled amount on a screen or a shopping list comes from. Any
positive number, though the screens offer 0,5×, 1×, 1,5× and 2× with one tap.
_Avoid_: Factor, scale, ratio, portions

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

**Alternative group** (*vaihtoehtoryhmä*):
Two or more ingredient lines of one recipe that are a choice rather than a
list — lihaliemikuutio **tai** fondiannos. Each option is a whole line with its
own amount, its own unit and its own ingredient, and the group belongs to that
recipe alone: it never says that the two foodstuffs are interchangeable
anywhere else. The first option is the default, and it is the only one the
shopping list buys. Proposed by #183; see
[ADR-0009](docs/adr/0009-an-alternative-is-a-line-not-a-substitution-rule.md).
_Avoid_: Substitution, substitute, equivalence, swap, variant

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
How many portions the source page claimed a recipe's own ingredient quantities
make. Unknown unless the source said so. Under ADR-0007 it is source metadata
and nothing else: it is not what scaling starts from, and a recipe of unknown
yield scales like any other.
_Avoid_: Servings, portions (that is the count on a meal entry), makes
