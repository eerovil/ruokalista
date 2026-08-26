# ADR-0005: The Worker does no pixel work

## Status

Accepted, 2026-08-26, in [#111](https://github.com/eerovil/ruokalista/issues/111).
Reverses part of [#96](https://github.com/eerovil/ruokalista/issues/96), which
had already shipped to `main`.

## What happened

The recipe-image generator from #96 and #97 was used on the live Worker for the
first time on 2026-08-26. `POST /admin/recipe-images/generate` ran for **178.5
seconds** and was killed. Cloudflare's own logs say `exceededResources`, "Worker
exceeded CPU time limit", CPU 2.17 s. The browser showed a 504.

Nothing was stored. D1 held 17 recipes with 0 images and the R2 bucket held 0
objects. **The contact sheet was bought from OpenAI and thrown away.**

## Why

The account is on the **Workers Free** plan, which gives a request **10 ms of
CPU**.

Measured on the development host against `tests/fixtures/contact-sheet.png`:

| step | CPU |
| --- | --- |
| decoding one 1024×1024 PNG sheet | ~0.22 s |
| encoding sixteen 512 px PNG crops | ~1.0 s |

That is roughly **a hundred times the budget**. It is not a tuning problem.
Nothing in `png.ts` or `contact-sheet.ts` can be made two orders of magnitude
cheaper, and the wall-clock figure above is what a request looks like when it
spends its whole life being throttled for exceeding its CPU slice.

Note what this is *not*. It is not the three-minute wait for the image API, and
it is not the money. Removing the paid call removes both of those and changes
nothing about this: a sheet an admin drew for free somewhere else needs exactly
the same decode and the same sixteen encodes.

## The decision

**The Worker does no pixel work. Ever.** Not on a bought sheet, not on an
uploaded one, not behind a queue, not on a smaller sheet.

Two consequences, both taken in #111:

1. **The paid OpenAI path is removed rather than kept alongside anything.** A
   button that always 504s after spending money is worse than no button. Gone:
   `generateContactSheet` and its request, `POST /api/admin/recipe-images/generate`,
   `src/recipe-image-batch.ts`, `OPENAI_API_KEY` everywhere it was named, and the
   `sheetBase64` + `isLocalOrigin` escape hatch that existed only to keep tests
   off the API.

   What stays is the prompt: `sheetPrompt`, `dishBrief` and `STYLE_VERSION` in
   `src/image-generation.ts`. An admin copies the prompt, draws the sheet in
   whichever image tool they like, and brings the file back.

2. **The split runs in the admin's browser, from the same implementation.**
   `src/client/recipe-image-split.ts` imports `contact-sheet.ts` and `png.ts` —
   the very modules `dev/check-contact-sheet.ts` tests under node — and
   `npm run generate:client` bundles them with esbuild into a committed
   `src/generated/recipe-image-split.ts`. There is one splitter, and
   `npm run check` fails when the bundle is stale.

   Each crop is stored through `PUT /api/recipes/:id/image?origin=generated&fingerprint=…&model=…`,
   which is #89's bulk route with #95's provenance. One request per recipe, and
   no new endpoint: the freshness bookkeeping and the compare-and-swap that
   protects a picture somebody uploaded in the meantime are code that was already
   there and already tested.

So the Worker's whole part in a batch is now: list the recipes, write the
prompt, state each recipe's fingerprint, and answer up to sixteen ordinary image
PUTs. Storing bytes in R2 and updating a row are I/O, not CPU.

### What this costs

- **One screen now requires JavaScript**, which is a deliberate exception to the
  standing rule in [#65](https://github.com/eerovil/ruokalista/issues/65). It
  says so on the screen and its button is rendered disabled until the bundle
  turns it on. Cutting a PNG apart is not something a server on this plan can do
  at all, and the image manager is not a screen anybody uses on an old iPad.
- **A generated artifact is committed**, following the pattern
  `assets/pwa/generated/*.png` already set, so CI and the deploy job need no new
  build step and the deployed bytes are the reviewed bytes. The price is having
  to run `npm run generate:client` after touching the splitter, which
  `npm run check` reminds anybody who forgets.
- **A second tsconfig**, because DOM globals and Workers globals disagree about
  `Response` and `fetch`. The modules both platforms share get typechecked
  twice, once against each — which is a small gain rather than a cost.
- **Sheets with no transparency are refused**, with transparency named as the
  reason and no white-background fallback. Plenty of external image tools
  flatten transparency on export, so this refusal will be met often. It is still
  the right answer: the splitter tells sixteen dishes apart by nothing but their
  own alpha, and guessing which white pixels are plate would put half of
  somebody else's dinner on a recipe.

### What was deliberately not done

- **Upgrading to the Workers Paid plan.** It would raise the CPU limit and make
  #96's design work as written. It is a recurring bill for one admin screen used
  a few times a year, and the browser already has the CPU.
- **Cloudflare Images or another product that transforms images.** Same
  objection, plus a second vendor in the picture path.
- **A queue or Durable Object doing the work in slices.** The limit is CPU per
  request, so this would mean splitting one sheet across many requests, holding
  a decoded raster between them, and inventing failure handling for a
  half-cut sheet. All of that to reach an outcome the browser reaches in one go.

## What would reverse this

A move to a plan whose CPU limit exceeds the measured cost with room to spare.
`storeRecipeImage` would then be the one place that changes, and the browser
bundle could go — but the prompt-copy workflow would be worth keeping anyway,
since it is what removed the recurring image bill.
