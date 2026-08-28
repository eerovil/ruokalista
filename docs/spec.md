# Ruokalista — build spec for v1

Everything expensive to reverse was decided on [the map](https://github.com/eerovil/ruokalista/issues/1).
This document turns those decisions into something buildable: the D1 schema, the
screens, and the intake flow end to end. Where it makes a call the map did not,
it says so.

Vocabulary is `CONTEXT.md`'s and is used exactly — household, member, recipe,
menu, meal entry, slot, portions, intake, source text, structuring, ingredient
line, ingredient, unit, yield.

## Shape of the thing

A single Cloudflare Worker in TypeScript, serving both the HTML app and its JSON
API, over one D1 database. Google sign-in is the gate. Household administration
has since moved from hand-written rows to the admin screens; #187 proposes the
email-only member enrollment described in `docs/codebase/auth.md`.

Deferred out of v1, on purpose:

- **Shopping list.** The map left its design undecided and it is not needed to
  plan a week. It arrives once the menu is being used for real.
- **Nightly git export (#12).** v1 leans on D1's 7-day Time Travel. The export
  and its restore drill are committed work, just not first.

Everything on the map's Out of scope list stays out.

## D1 schema

D1 is SQLite, so the model from #5 and #6 lands without translation. Migrations
live in `migrations/`, applied with `wrangler d1 migrations apply`.

Conventions: ids are `INTEGER PRIMARY KEY` (SQLite rowid aliases — small,
household-private, never shown to the world). Timestamps are ISO 8601 text in
UTC. Dates are `YYYY-MM-DD` text, compared as strings, which sorts correctly.
Every table that holds household data carries `household_id`, and every query
filters on it.

```sql
-- 0001_init.sql

CREATE TABLE household (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE member (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  google_sub    TEXT NOT NULL UNIQUE,   -- Google's stable account id, not email
  display_name  TEXT NOT NULL,
  email         TEXT,                   -- shown, never used to match
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX member_by_household ON member(household_id);

CREATE TABLE ingredient (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,          -- as the household approved it
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);
CREATE UNIQUE INDEX ingredient_name_per_household
  ON ingredient(household_id, name);

CREATE TABLE recipe (
  id                 INTEGER PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES household(id),
  title              TEXT NOT NULL,
  yield_portions     INTEGER,           -- NULL when the source did not say
  source_text        TEXT NOT NULL,     -- kept forever, exactly as it arrived
  source_route       TEXT NOT NULL CHECK (source_route IN ('pasted','photographed')),
  structured_by      TEXT,              -- model id that produced the first draft
  structured_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  created_by         INTEGER NOT NULL REFERENCES member(id),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by         INTEGER NOT NULL REFERENCES member(id)
);
CREATE INDEX recipe_by_household ON recipe(household_id, title);

CREATE TABLE recipe_step (
  recipe_id  INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (recipe_id, position)
);

CREATE TABLE ingredient_line (
  id             INTEGER PRIMARY KEY,
  recipe_id      INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  quantity       REAL,                  -- NULL when absent or unrepresentable
  quantity_max   REAL,                  -- set only for a range; NULL otherwise
  unit           TEXT,                  -- as written: dl, rkl, tl, kpl, g
  alt_quantity   REAL,                  -- a second measurement of the same item
  alt_unit       TEXT,                  -- in a different unit; both or neither
  ingredient_id  INTEGER NOT NULL REFERENCES ingredient(id),
  source_line    TEXT NOT NULL,         -- the sentence it was written as

  -- a second measurement is both halves or neither, and never stands alone
  CHECK ((alt_quantity IS NULL) = (alt_unit IS NULL)),
  CHECK (alt_quantity IS NULL OR quantity IS NOT NULL)
);
CREATE UNIQUE INDEX ingredient_line_order ON ingredient_line(recipe_id, position);
CREATE INDEX ingredient_line_by_ingredient ON ingredient_line(ingredient_id);

CREATE TABLE meal_entry (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  date          TEXT NOT NULL,          -- YYYY-MM-DD
  slot          TEXT NOT NULL CHECK (slot IN ('lunch','dinner')),
  recipe_id     INTEGER NOT NULL REFERENCES recipe(id),
  portions      INTEGER NOT NULL CHECK (portions > 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);
CREATE INDEX meal_entry_by_date ON meal_entry(household_id, date, slot);
```

Notes on the choices, since a schema is where a decision quietly gets reversed:

- **There is no `menu` table**, per #5. A menu is
  `SELECT ... FROM meal_entry WHERE household_id = ? AND date BETWEEN ? AND ?`.
  A slot with several rows is several people eating different food; a slot with
  none is a slot nobody has filled. Nothing distinguishes an empty week from a
  missing one, which is correct — there is nothing to create.
- **Issue #57 proposes superseding `meal_entry` with `planned_batch` and
  `batch_occurrence`.** This pull request would migrate each existing row into
  one batch with one occurrence, then project batches whose spans intersect a
  menu range. ADR-0004 records the proposed replacement and its gap rule.
- **`quantity` is a number and may be blank.** "½ dl" becomes `0.5` + `dl`.
  A line with no stated amount — `tuoretta timjamia`, `hyppysellinen suolaa` —
  leaves it NULL, and `source_line` carries the truth. Nothing is ever invented
  to fill the column. About a fifth of the lines in the #2 sample are like this,
  and NULL is the honest answer for them.
- **`quantity_max` exists only for ranges.** k-ruoka's `1–1 ja ½ l vettä`
  stores as `1` / `1.5` / `l` and renders "1–1½ l". Without the column a stated
  amount would vanish from the screen entirely, which is worse than showing
  either end. It is NULL on almost every line — one in roughly forty-five in the
  sample — and scaling uses `quantity`, the low end.
- **A line may carry a second measurement.** meillakotona's
  `½ (500 g) valkokaali` is half a cabbage *and* 500 g, in different units —
  not a range, so `quantity_max` cannot hold it. `alt_quantity` / `alt_unit`
  do. This case is likelier in the #2 sample than a range is.

  **Neither measurement is the primary one.** `alt_` means "written second",
  not "less important"; the two `CHECK`s only stop a second measurement
  existing without a first. Which one a screen leads with is a render decision,
  spelled out under Screens — because "decide at render" still needs every
  screen to have an answer, and scaling needs one too.

  The limit: the second measurement cannot itself be a range, and there is no
  room for a third. Neither appears in the sample. A line needing either keeps
  the truth in `source_line` as before.

  This shape goes past what #6 locked, so the reasoning is written up in
  [ADR-0001](adr/0001-an-ingredient-line-holds-more-than-one-measurement.md).
- **`unit` is free text**, per #6. No unit table, no conversions, no densities.
- **`ingredient_id` is NOT NULL.** A line cannot exist pointing at an
  unapproved ingredient — that rule is what stops "purjo" and "purjosipuli"
  from both appearing, and the schema, not just the screen, enforces it.
- **`source_text` sits on the recipe** rather than in an intake table, because
  a re-import on a future model (#11) needs exactly the recipe and its text.
  Photographed images are never written anywhere.
- **No session table.** See Sign-in below.
- **Author stamps** are on every household-owned record, per #8. There are no
  roles and nothing checks them; they are there so you can see who added a
  thing.
- **`ON DELETE CASCADE`** on the recipe's children only. Deleting a recipe that
  is on a menu is refused at the API, not the schema — D1 has foreign keys on,
  and `meal_entry.recipe_id` has no cascade, so the delete fails loudly.

## Sign-in

Google OAuth, authorization-code flow, handled in the Worker. On callback,
verify the id token and look up `member` by `google_sub`. Existing members never
fall back to email matching. #187 proposes one explicit enrollment path: an
unknown `sub` may consume an admin-created invitation for the same verified
Google email, creating its permanent member row before the stable-`sub` lookup
is repeated. Every other unknown account is refused.

The session is a signed cookie (HttpOnly, Secure, SameSite=Lax) holding
`member_id` and an expiry, HMAC'd with a Worker secret. No session table: with
one household and a handful of members, revocation means rotating the secret,
which is acceptable and saves a table plus a read on every request.

Every API handler resolves the cookie to a member, reads that member's
`household_id`, and passes it to the query layer. One helper does this and every
query takes the household id as a parameter — that is the whole of "tenancy is
modelled, not built".

## Screens

Mobile-first, because a week gets planned at the kitchen table and a recipe gets
read at the hob. Server-rendered HTML with small islands of interactivity;
the streaming intake screen is the only place that needs real client-side work.

**Sign-in.** One button. Also the wall a stranger hits: signed in with Google
but no member row, and it says so plainly.

**The week.** The home screen and the point of the app. Seven days down the
page, each with its lunch and dinner slot, each slot listing whatever recipes
are on it with their portion counts. Empty slots are visible and tappable —
they are the invitation. Arrows move to the previous and next week. Adding to a
slot opens the recipe picker; each entry can have its portions changed or be
removed.

**Recipe picker.** Reached from an empty slot. Search over the household's
recipe titles, most recently added first when the box is empty. Picking one asks
for portions, defaulting to the recipe's yield when it has one and to a
household default when it does not.

**Recipe list.** Everything in the store, searchable by title, showing when it
came in and who added it. The way in to reading, editing, and adding a recipe to
a day from the recipe's own side.

**Recipe.** Title, yield if known, the ingredient lines, the steps. Each line
shows quantity, unit and ingredient, with the source line available underneath
for the ones where the structured fields still lost something.

Since no measurement is primary in the data, the screens decide:

- **A range** reads as one figure — "1–1½ l vettä".
- **A second measurement** is shown in full, in the order the source wrote it —
  "½ kpl (500 g) valkokaali". The recipe screen never picks one and hides the
  other; both were stated, so both are shown.
- **Scaling** uses `quantity`, and where a range exists, its low end. When a
  line has a second measurement, scaling multiplies both. This is the one place
  a rule was unavoidable, and it favours the source's own order rather than
  guessing which unit is more useful.
- **The eventual shopping list** is free to prefer whichever of the two units
  it can group with other lines. That is exactly why both are stored, and it is
  the reason this is worth a column rather than a note in the source line. A recipe with no yield
says so where a scale control would otherwise be — you cannot scale it, and the
screen should explain why rather than hide the fact. From here: add to a day,
edit, delete.

**Recipe editor.** The same fields, writable. Lines can be added, reordered,
retyped and repointed at a different ingredient; the ingredient field is a
picker over the household's approved list, with the same approve-a-new-one step
the intake screen has. Source text is shown read-only at the bottom — it is
never edited, because it is the record of what actually arrived.

**Intake.** Two ways in on one screen: a text box to paste into, and a camera
button for a printed page. What happens next is the flow below.

**Check and correct.** Where a structured draft becomes a recipe. Described
with the flow, because it is part of it.

**Ingredients.** The shared list, alphabetical, each with the number of recipes
using it. Rename is available; merging two that should have been one is not in
v1, so the list exists partly so the household can see the drift early.

## The intake flow, end to end

One import is roughly 2,900 input and 1,400 output tokens against Claude
Sonnet 5 — about $0.03 at standard pricing — and a photographed page about 1.5×
that (#9, #11). A 300-recipe lifetime cookbook is under ten dollars, so this
flow is optimised entirely for the quality of the draft and the ease of
correcting it. Figures are worked through under What it costs to run.

**1. The member gives the app a source.**

Pasting: a textarea, sent as-is. Photographing: a file/camera input, downscaled
in the browser to a long edge of about 1,500 px and re-encoded as JPEG before
upload — enough for printed text, small enough to keep the request quick. The
image is held in memory in the Worker for the length of one model call and then
dropped. It is never written to D1 and it never reaches R2 — the recipe image
bucket added for #88 holds pictures a household chose to show, and a
photographed cookbook page is not one of those.

**2. `POST /api/intake/structure` runs the model.**

The Worker loads the household's whole ingredient list — id and name, about 300
rows — and puts it in the prompt, per #11. It asks for one JSON object:

```json
{
  "title": "...",
  "yield_portions": 4,
  "source_text": "...",
  "steps": ["...", "..."],
  "lines": [
    { "quantity": 0.5, "quantity_max": null, "unit": "dl",
      "alt_quantity": null, "alt_unit": null, "ingredient_id": 42,
      "ingredient_name": "öljy", "source_line": "½dl öljyä" },
    { "quantity": 1, "quantity_max": 1.5, "unit": "l",
      "alt_quantity": null, "alt_unit": null, "ingredient_id": 7,
      "ingredient_name": "vesi", "source_line": "1–1 ja ½ l vettä" },
    { "quantity": 0.5, "quantity_max": null, "unit": "kpl",
      "alt_quantity": 500, "alt_unit": "g", "ingredient_id": 91,
      "ingredient_name": "valkokaali", "source_line": "½ (500 g) valkokaali" },
    { "quantity": null, "quantity_max": null, "unit": null,
      "alt_quantity": null, "alt_unit": null, "ingredient_id": null,
      "ingredient_name": "sitruunaruoho", "source_line": "hieman sitruunaruohoa" }
  ]
}
```

The prompt's standing rules: never invent a quantity or a unit; keep the unit
exactly as the recipe wrote it; copy each source line verbatim; set
`quantity_max` only when the line genuinely states a range, including ones
written out in words like `1–1 ja ½ l`, and leave it null otherwise; use
`alt_quantity` / `alt_unit` when the line measures the same item twice in
different units, keeping the two in the order the source wrote them; set
`yield_portions` only when the text states one; and match each line to an
existing ingredient by id when one clearly fits, otherwise leave `ingredient_id`
null and propose a name. `source_text` is echoed back for the pasted route and
is the transcription for the photographed route — that is what gets kept
forever.

**3. The response streams.**

The Worker calls the model with streaming on and pipes the token stream straight
into its own response body. Bytes never stop flowing, so Cloudflare's ~125 s
proxy cutoff never fires — this is the whole reason the stack is Workers (#7).
The browser shows the draft filling in as it arrives, which also makes a slow
import feel like progress rather than a hang.

**4. Check and correct.**

The draft lands on a screen the human works through:

- Title and yield, both editable. Yield left blank stays blank.
- Steps, editable and reorderable.
- Each ingredient line as a row: quantity, unit, ingredient, and the source line
  shown beneath it so the two can be compared without leaving the screen. The
  quantity field takes an optional second number for a range, and a line can be
  given a second measurement in another unit. This row is where a human fixes
  whatever the model could not fit.
- Lines whose `ingredient_id` came back null are marked **new**. Each offers two
  answers: approve the proposed name as a new shared ingredient, or point the
  line at an existing one. Nothing can be saved while a line is unanswered —
  this is the human approval #6 requires, and it is deliberately in the way.
- Lines can be deleted and added by hand; the model missing one is expected.

**5. `POST /api/recipes` saves it.**

One D1 batch, so a half-written recipe cannot exist:

1. Insert each approved new ingredient with
   `INSERT ... ON CONFLICT(household_id, name) DO NOTHING`, then resolve every
   name to an id.
2. Insert the recipe with `source_text`, `source_route`, `structured_by` and
   `structured_at`.
3. Insert the steps and the ingredient lines with their positions.

The server re-checks that every line has a resolvable ingredient and rejects the
save otherwise — the screen's rule is enforced again where it counts. On
success it redirects to the new recipe, which offers "add to a day" straight
away, because that is why the recipe was imported.

**When it goes wrong.** A model error, a timeout, or unparseable JSON ends the
stream with an error the screen shows without throwing away what the member
typed or photographed; retry re-runs step 2 from the same source. Malformed
JSON is retried once automatically before the member sees anything. Nothing is
written to D1 until step 5, so a failed import leaves no trace and a closed tab
loses only the draft — one re-run, about two cents. That is the reason there is
no draft table.

## API

Small enough to list. All of them require a session and all of them scope to the
signed-in member's household.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/auth/google` , `/auth/google/callback` | Sign-in |
| `POST` | `/auth/signout` | Clear the cookie |
| `GET` | `/api/menu?from=&to=` | Proposed by #57: planned batches intersecting a date range |
| `POST` | `/api/batches` | Proposed by #57: start one cooked batch in a date and slot |
| `PATCH` | `/api/batches/:id` | Proposed by #57: change its recipe, portions or occurrences |
| `DELETE` | `/api/batches/:id` | Proposed by #57: remove the whole cooked batch |
| `GET` | `/api/recipes?q=` | Search by title |
| `GET` | `/api/recipes/:id` | One recipe with lines and steps |
| `POST` | `/api/recipes` | Save a corrected draft |
| `PUT` | `/api/recipes/:id` | Edit |
| `DELETE` | `/api/recipes/:id` | Delete, refused if it is on a menu |
| `POST` | `/api/intake/structure` | Run the model, stream the draft |
| `GET` | `/api/ingredients` | The shared list with usage counts |
| `PATCH` | `/api/ingredients/:id` | Rename |

## What it costs to run

Three bills: Cloudflare Workers, D1, and the Anthropic API. Prices checked
2026-08-24 against each vendor's own pricing page.

**Workers and D1 are free at this size, and it is not close.**

| | Free plan allows | A household uses |
| --- | --- | --- |
| Worker requests | 100,000 / day | a few hundred |
| Worker CPU | 10 ms per invocation | see the note below |
| D1 rows read | 5,000,000 / day | a few thousand |
| D1 rows written | 100,000 / day | tens |
| D1 storage | 5 GB | a few MB — 300 recipes of text |

**The 10 ms CPU limit does not threaten the streaming import**, which is the one
place you would expect it to. Cloudflare bills *CPU* time, not wall-clock
duration, and time spent waiting on the model's response is not CPU — the
Worker is idle while bytes arrive. A 60-second import burns milliseconds of CPU.
Duration is explicitly not charged and not limited on either plan.

**The Workers Paid plan costs $5/month and buys one thing worth having.** Not
capacity — D1's Time Travel goes from **7 days of restore history to 30**.
Decision #7 called Time Travel "the first real answer to backups", and it was
reasoning from the 7-day figure. Time Travel itself costs nothing on either
plan. Once the nightly git export (#12) exists, the 30 days matter less; until
then, $5/month is the cheapest thing in this document that reduces real risk.

**The Anthropic API is the only bill that scales with use**, and it is a
build-the-cookbook cost rather than a running one. At Sonnet 5's standard
$3 / $15 per million tokens:

| | Tokens | Cost |
| --- | --- | --- |
| One pasted import | ~2,900 in, ~1,400 out | **$0.030** |
| One photographed page | ~1.5× | **$0.045** |
| Building a 300-recipe cookbook | | **~$8.90** |
| Two imports a week, thereafter | | **~$0.25 / month** |

**Decision #11's figures are about to go stale, and this is the one thing here
that needs a decision.** #11 costed a 300-recipe cookbook at $5.34, which is
Sonnet 5's *introductory* rate of $2 / $10 per million tokens. That rate ends
**2026-08-31 — seven days from now**. After it, the same cookbook costs about
$8.90. Nothing about #11's reasoning changes: quality was the deciding axis and
a factor-of-1.7 move on a sub-ten-dollar lifetime total does not touch that. But
the number written on the ticket will be wrong, and anyone importing in bulk is
better off doing it this week.

**Prompt caching does not help**, confirming #9. A cache write costs 1.25× the
base rate (5-minute retention) or 2× (1-hour), and a read costs about 0.1×. It
pays off from the second request inside the retention window. At a few imports a
week the window has always expired, so every import would pay the write premium
and never collect a read. Do not add `cache_control` to the import prompt.

**All together, for a household already past the initial import:** $0/month, or
$5/month with the paid plan, plus well under a euro of model usage. The cost of
this app is not its running cost — it is the afternoon spent photographing the
cookbook.

## What v1 is done when

- A member signs in with Google and a stranger cannot.
- A pasted Finnish recipe and a photographed printed page both become a stored
  recipe, with their source text kept and every ingredient either matched or
  approved by hand.
- The week screen shows lunch and dinner for seven days, entries can be added,
  re-portioned and removed, and a slot can hold more than one recipe.
- A recipe can be edited after import, and its source text still says what
  arrived.
- Deleting a recipe that is on a menu fails with a message rather than a stack
  trace.
