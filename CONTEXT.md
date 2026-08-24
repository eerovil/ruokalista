# Ruokalista

A household plans which meals it will eat on which days. Recipes exist in order
to be placed on those days.

## Language

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
