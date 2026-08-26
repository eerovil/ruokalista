# Pictures of a recipe

How a recipe gets a picture, how staleness is tracked, and how PR #115 proposes
moving contact-sheet cutting out of the Worker.

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

This matters across any long generation gap. A caller must carry the image key
it saw before that gap into the later PUT; reading the key only when the PUT
arrives would treat a newer manual picture as expected and overwrite it.

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

## Sixteen pictures from one sheet, cut in the browser (#111, proposed)

PR #115 proposes replacing the paid Worker-side generator from #96/#97. The
live route exceeded the Workers Free plan's CPU budget after buying a sheet and
stored nothing. `docs/adr/0005-the-worker-does-no-pixel-work.md` records why the
Worker must not generate, decode, split or encode contact sheets on this plan.

The proposed flow leaves two admin-only GETs: the list and a confirmation screen
with the exact prompt, ordered manifest and PNG file input. An admin copies the
prompt to an external image tool and brings the 4×4 sheet back. Ruokalista calls
no image provider and spends no API money.

Position is the whole mapping: cell 1 is the first id posted, row-major to
cell 16. No OCR, vision model or semantic matching in the split — position
already answers the question, and a second opinion just adds a way to be
wrong. The prompt renders no text, and always asks for sixteen cells even for
a smaller batch, since a shape that depended on batch size would move every
cell. It asks for generous transparent gutters and each dish sitting well
inside its cell — the slack the splitter recovers with.

`src/client/recipe-image-split.ts` imports `src/contact-sheet.ts` and
`src/png.ts`, the same modules the node checks exercise. An esbuild step writes
a committed `src/generated/recipe-image-split.ts`; `npm run check` refuses a
stale bundle, so CI and deployment do not need a build step and there is still
only one implementation of the crop rules. The client has its own DOM tsconfig.

`src/contact-sheet.ts` treats the 4×4 grid as a locator, not a promise the image
tool kept. Each cell's artwork is found by following alpha into the gutter; the
real bounding box is padded square and scaled to 512 px. A sheet with no
transparency is refused by name. There is deliberately no white-background
fallback: many external tools flatten alpha, but guessing foreground from white
would make the mapping unsafe.

**It fails closed, and it fails whole.** Every requested crop is cut and checked
before the first upload. Missing artwork, opaque backgrounds, gutter or sheet
edges, fused neighbours and overlapping crops refuse the whole sheet.

Once validation succeeds, each crop goes through the existing
`PUT /api/recipes/:id/image?origin=generated&fingerprint=…&model=…` route. The
confirmation manifest supplies the recipe fingerprint and the image key seen
before the external generation gap. The PUT conditions storage on that captured
key, so a later manual replacement wins. `model` records
`supplied:manual/<style>` and generated freshness continues to work.

Once uploads start, a successful crop is not rolled back when a later one fails,
and one failure does not stop the rest. The browser reports every recipe's
result. This preserves #96's ordering without asking the Worker to do pixel work.

Storage failures remain covered by `dev/check-recipe-image-commit.ts`. The
long-gap lost-update case is also exercised through the real browser/API path:
the test replaces an image after confirmation and expects the crop PUT to lose
with 409 rather than overwrite it.

`src/image-generation.ts` retains only `sheetPrompt`, `dishBrief`,
`STYLE_VERSION` and the external source marker. The prompt still fixes the 4×4
row-major mapping, blank unused cells, transparent gutters and no rendered text.
Changing the style text requires bumping the version.

The real sheet committed as `tests/fixtures/contact-sheet.png` drives the browser
flow. The test suite asserts no request reaches OpenAI, and the prompt check also
asserts that the prompt module contains no `fetch`.

## Choosing which pictures to make (#111, proposed)

The proposed `/admin/recipe-images` flow lists every dish as **Ei kuvaa**,
**Vanhentunut**, **Ajan tasalla** or **Itse lisätty**. The list is server-rendered;
the confirmation screen needs modern JavaScript because the Worker cannot do the
split. Its button stays disabled until the generated client bundle loads, and
the screen says this requirement plainly.

Missing and stale recipes are preselected up to sixteen. Current generated
pictures sit behind a closed disclosure and a manually-managed upload has no
checkbox at all; replacing a photograph a person chose stays the editor's job.

`imageCandidates` in `src/recipe-image-admin.ts` reads the whole list in two
queries and fingerprints in memory rather than calling `findRecipe` per recipe.
It also carries the captured image key into the manifest for the conditional PUT.

The Copy button uses the clipboard promise only when it succeeds, falls back to
`execCommand` on rejection, and otherwise leaves the prompt selected for a
keyboard copy. It never reports success before one of those paths succeeds.
