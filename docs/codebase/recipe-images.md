# Pictures of a recipe

How a recipe gets a picture — uploaded by hand, or bought sixteen at a time from OpenAI and cut apart locally — and how staleness and money are kept apart.

## A recipe's picture

Pictures are made outside Ruokalista and uploaded (#88). The bytes live in R2
and `recipe.image_key` holds the object key, so an image is optional and a
recipe without one is not a special case anywhere.

`recipeImage()` in `src/recipes.ts` is the only thing that renders one, and it
always renders *something* — the picture, or the same space saying there is
none, so a list row's height never depends on whether a photo exists. It is
read-only by construction, which is what keeps the upload control in the
editor and nowhere else.

Two sizes serve one object: `hero` above a title (recipe screen, planned meal,
editor), `thumb` at the start of a row (recipe list, picker, week). Both crop
rather than squash. The picture is decorative — the title is always beside it
— so it carries no alt text and is hidden from a screen reader.

Anything that renders a picture needs `imageKey` on the row it already loads:
`recipeSummaries`/`findRecipe` in `src/recipes.ts`, `PlannedBatch` in
`src/menu.ts`. Nothing does a second query for it.

**Nothing trusts the content type a caller declares.** `src/image-bytes.ts`
reads the signature and pixel size out of the file's own header, and that
decides whether the bytes are stored, what type they're served as, and the
key's extension. The response also carries `nosniff`. `dev/check-image-bytes.ts`
checks the reader directly — including that HTML calling itself a PNG is
refused — because a browser test only ever sends real images.

That reader's JPEG half is fiddlier than it looks: the frame-marker filter once
excluded `0xc9` on the belief that it was DNL. It is not — `0xc9` is an
arithmetic-coded SOF, and DNL is `0xdc`, outside the SOF range entirely — so
the exclusion silently refused a whole class of real JPEG. No fixture used that
marker, so no test failed; a review lane caught it by reasoning about the
ranges. `dev/check-image-bytes.ts` now walks `[0xffc0, 0xffc1, 0xffc2, 0xffc9,
0xffcb]` so the same mistake cannot come back unnoticed.

Serving revalidates rather than caching for long: `GET /api/recipes/:id/image`
passes `onlyIf: request.headers` to R2 and answers 304 when the object has not
changed. A long cache lifetime would be wrong here because the URL is stable
across a replacement — same recipe id, different bytes — so a cached copy would
keep showing the old picture.

Normalizing happens in the browser: the editor's island shrinks the chosen
picture to a long edge of 1,200 px and re-encodes it as JPEG before posting,
the same canvas job as the intake camera route. A Worker cannot re-encode
without another Cloudflare product, so the server's half is a bound rather
than a transform — 5 MiB and a 2,000 px longest edge, refused with the
measurement in the message. Bulk callers get the bound, not the shrink.

Replacing writes the new object, points the row at it, then deletes the old
one, so a failure leaves a stray object rather than a recipe pointing at
nothing. Deleting a recipe drops its pictures and its parts' first, since the
keys are only readable while the rows still exist.

`src/recipe-images.ts::storeRecipeImage` and `::removeRecipeImage` take the
`oldKey` the caller believes is current and write with
`UPDATE … WHERE image_key IS ?` — `IS` not `=`, because a recipe with no
picture holds NULL and `= NULL` is never true; losing that comparison would
refuse every first upload. Losing the race is a 409 and the loser deletes the
object it just wrote, so a lost race never orphans in R2. `removeRecipeImage`
stays silent on a lost race instead (removing an already-gone picture isn't an
error) and only deletes the R2 object if the row it cleared was the one it
expected.

This matters because the batch generator below reads every recipe, waits up to
three minutes for a sheet, and comes back to rows that may have moved on.
Without the comparison, a manual upload made during that wait would be
silently replaced by a generated picture, and the uploaded bytes orphaned.

## Is the picture still the dish?

`src/recipe-fingerprint.ts` hashes the content that decides what the picture
shows: title, every line's amount/range/unit/second measurement/ingredient
name, and each part of a multipart dish under its own name. Not the steps, the
source text, the yield, an id, or row order — reordering lines or fixing a
step typo doesn't change the fingerprint, and putting an ingredient back gives
it the value it had before. `VERSION` is how the rule itself changes: bumping
it makes every old fingerprint compare unequal on purpose.

`recipe.image_origin`, `image_fingerprint`, `image_generated_at`,
`image_generated_by` (migration 0007) say what the stored picture is;
`src/image-freshness.ts` turns that into `missing`/`fresh`/`stale` — one
function, no queries, so the generator and the admin list can't disagree.

A picture somebody uploaded is *manually managed*: fresh until replaced or
removed, never compared, never queued for paid regeneration. A row predating
this scheme carries no origin and reads as one of those, so nothing existing
went stale when the migration landed. Only a picture recorded as generated is
compared, and only against the fingerprint it states it was made from —
`PUT /api/recipes/:id/image?origin=generated&fingerprint=…&model=…`. Omitting
the fingerprint claims "made from the recipe as it stands right now," a claim
about a recipe nobody read.

## Sixteen pictures for one request

`POST /api/admin/recipe-images/generate` and the screen-facing
`POST /admin/recipe-images/generate` (both behind `requireAdmin` /
`requireAdminScreen`, `src/auth.ts`) take up to sixteen recipe ids, buy **one**
OpenAI image — a 4×4 grid of dishes on transparent background — and cut it up
locally. A hundred-recipe household costs seven paid requests, not a hundred.

Position is the whole mapping: cell 1 is the first id posted, row-major to
cell 16. No OCR, vision model or semantic matching in the split — position
already answers the question, and a second opinion just adds a way to be
wrong. The prompt renders no text, and always asks for sixteen cells even for
a smaller batch, since a shape that depended on batch size would move every
cell. It asks for generous transparent gutters and each dish sitting well
inside its cell — the slack the splitter recovers with.

`src/png.ts` is a from-scratch PNG decoder/encoder, since a Worker has no
image library or canvas. It leans on `DecompressionStream("deflate")` for the
zlib payload and implements only the chunk envelope, scanline filters and CRC
— deliberately narrow: 8-bit non-interlaced only, refusing anything else by
name. `MAX_PIXELS` (16 megapixels, 4x the largest sheet) caps what it decodes.

`src/contact-sheet.ts` treats the 4×4 grid as a *locator*, not a promise the
model kept — a real sheet had a dish drawn over its cell boundary, and cutting
on the arithmetic line sliced it in half. Each cell's artwork is found by
following its own alpha out into the gutter; the crop is that artwork's real
bounding box, padded square and scaled to 512 px. Splitting costs ~1.5s CPU on
a dev host (a fifth of that per crop) — comfortably inside a Worker's budget.

**It fails closed, and it fails whole.** A sheet is refused entirely — nothing
stored, no recipe marked fresh, no existing picture replaced — if any
requested cell has no artwork, touches the gutter/sheet edge, is fused to a
neighbour, or overlaps another cell's crop. Retrying buys one more sheet; the
cut stays local and free, and there's no automatic retry because that would
spend the household's money on a decision nobody made.

Order of work is the safety property: recipes load and fingerprint, the sheet
is bought, all sixteen crops are cut and validated — all *before* the first
byte reaches R2. Storage goes through `storeRecipeImage` with
`origin: generated`, sharing freshness bookkeeping with the manual path;
`image_generated_by` carries provider, model and style version together, so no
new column was needed.

Once writes start, `commitCrops` (`src/recipe-image-batch.ts`) stops being
all-or-nothing on purpose. **A recipe already given its picture keeps it** —
if a later crop fails to store, earlier ones aren't rolled back, since each is
a correct picture with a fingerprint that still matches. One failure doesn't
stop the rest either, since the sheet is already paid for. The response names
every recipe and whether it got its picture.

Storage failure and the lost-update race are checked in
`dev/check-recipe-image-commit.ts` against a bucket/DB that fail on demand,
since neither is provokable through a browser and `retries: 0`
(`docs/codebase/testing.md`) rules out a timing-dependent test. That check is
also why `Raw` in `src/html.ts` is written out longhand: `--experimental-
strip-types` can't desugar a constructor parameter property, and that one line
made every module reaching `html.ts` (most of them, via `auth.ts`)
unloadable in `dev/`.

`src/image-generation.ts::MODEL` is pinned to `gpt-image-2`, not
`gpt-image-1`: at build time every other OpenAI image model on the account
(`gpt-image-1`, `-1-mini`, `-1.5`, `chatgpt-image-latest`) carried a
retirement date within months and `gpt-image-2` didn't — check via
`GET /v1/models`'s `shutdown_date` field before assuming a newer-looking id is
the right pin. Quality is `high`; the one real sheet bought while building
this cost 7,024 image output tokens plus 487 text input tokens for eight
dishes on a 1,024-square (~$0.28 at the time, under two cents a recipe at a
full sixteen). The dollar figure isn't kept in the source comment, since
image-output pricing has moved before — only the measured token counts are,
pointing at OpenAI's current pricing page for the arithmetic. `STYLE_VERSION`
is the dial: change the style text, bump the version, everything drawn before
it is dated on purpose. One thing the real sheet didn't obey: the locked style
asks for semi-realistic clip-art and `gpt-image-2` drew photographs — left
as-is since the pictures are good and re-wording costs another sheet.

That one real sheet is committed as `tests/fixtures/contact-sheet.png` and is
what the browser suite splits every run. **No test calls OpenAI, and none
may** — every request in `tests/recipe-image-batch.spec.ts` supplies the sheet
itself, accepted in place of buying one, gated by `isLocalOrigin` exactly like
`Avaa esimerkkiluonnos` (`docs/codebase/intake.md`). Check that this fixture
already exists before buying a new one for related work.

`OPENAI_API_KEY` has to be listed in `wrangler.jsonc`'s secrets block (next to
`ANTHROPIC_API_KEY`, `BACKUP_GITHUB_TOKEN`) or local dev won't expose it from
`.dev.vars` at all, even placed there correctly. `scripts/save-openai-key.sh`
sets it locally and as a Worker secret, and does a free model-list check.

## Choosing which pictures to buy

`/admin/recipe-images` lists every dish with what its picture is — **Ei
kuvaa**, **Vanhentunut**, **Ajan tasalla**, **Itse lisätty** — the only place
in the app where a person can spend money. Three plain form posts, no
JavaScript needed: the list, `GET /admin/recipe-images/confirm` naming the
exact recipes in cell order, then `POST /admin/recipe-images/generate` — the
paid one, reached only from a button that says so. Nothing regenerates on
save, on a schedule, or on opening a page.

Missing and stale are preselected, up to sixteen; a seventeenth candidate is
the next batch, said in the wording. Current pictures sit behind a closed
disclosure with nothing ticked and their own button, since a fresh recipe with
the same checkbox is one mis-click from being paid for. A manually-managed
upload has no checkbox at all — this screen spending money to overwrite a
chosen photograph is exactly what that rule prevents. Replacing one stays the
editor's job.

`runImageBatch` in `src/recipe-image-batch.ts` is the batch route with
response-shaping lifted out, so the screen and
`POST /api/admin/recipe-images/generate` run identical work and only the words
differ. `imageCandidates` in `src/recipe-image-admin.ts` reads the whole list
in two queries and fingerprints in memory rather than calling `findRecipe` per
recipe — a hundred recipes would otherwise be hundreds of round trips. The
verdict is still `imageStatus`, so this screen and the JSON API can't
disagree.

The form accepts a supplied `sheetBase64` on a local origin, the same escape
hatch as the JSON route, which is how `tests/recipe-image-admin.spec.ts` walks
selection through confirmation, split, commit and refreshed statuses without
calling OpenAI. A small feature-detected script disables the submit button as
the form goes; without it the worst case is a duplicate, not a broken screen.
