import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CELLS,
  NO_TRANSPARENCY,
  OUTPUT_EDGE,
  splitContactSheet,
  type SplitResult,
} from "../src/contact-sheet.ts";
import { decodePng } from "../src/png.ts";
import { blank, cell, disc, dish, opaquePixels, png, rawPng } from "./support/sheet.ts";

/**
 * The splitter, which is the part of #96 that must not be wrong.
 *
 * Everything it decides — which recipe a picture belongs to, whether a dish was
 * cut off, whether two dishes can be told apart — is decided from pixels, so
 * pixels are what it is shown here. A real generated sheet had one dish drawn
 * over its cell boundary, so the recoverable case and the unrecoverable one are
 * both here, drawn a few pixels apart.
 *
 * A sheet size of 512 keeps every case fast: cells are 128 px, which is enough
 * room for a dish, a gutter and a deliberate overrun.
 */

const SHEET = 512;

/** A sheet with a well-behaved dish in each of the first `count` cells. */
async function tidySheet(count: number, size = SHEET): Promise<Uint8Array> {
  const sheet = blank(size, size);
  for (let index = 0; index < count; index += 1) dish(sheet, index);
  return png(sheet);
}

function ok(result: SplitResult): Extract<SplitResult, { ok: true }> {
  assert.equal(result.ok, true, `expected a split, got ${JSON.stringify(result)}`);
  return result as Extract<SplitResult, { ok: true }>;
}

/**
 * A sheet refused cell by cell. Distinct from a sheet refused whole — the
 * transparency case below — because the two are answered differently on screen:
 * one names the cells, the other names the sheet.
 */
function refused(result: SplitResult): Extract<SplitResult, { kind: "cells" }> {
  assert.equal(result.ok, false, "expected the sheet to be refused");
  assert.equal(
    (result as Extract<SplitResult, { ok: false }>).kind,
    "cells",
    `expected per-cell problems, got ${JSON.stringify(result)}`,
  );
  return result as Extract<SplitResult, { kind: "cells" }>;
}

test("a full sheet yields sixteen square crops, in manifest order", async () => {
  const split = ok(await splitContactSheet(await tidySheet(MAX_CELLS), MAX_CELLS));

  assert.equal(split.crops.length, MAX_CELLS);
  assert.deepEqual(
    split.crops.map((crop) => crop.cell),
    Array.from({ length: MAX_CELLS }, (_, at) => at),
  );

  for (const crop of split.crops) {
    const image = await decodePng(crop.png);
    assert.equal(image.width, OUTPUT_EDGE, `cell ${crop.cell} width`);
    assert.equal(image.height, OUTPUT_EDGE, `cell ${crop.cell} height`);
    // A crop with nothing in it would still be the right size, so the artwork
    // has to be there too — and it has to be roughly the same amount of artwork
    // in every cell, since the same dish was drawn sixteen times.
    const filled = opaquePixels(image) / (OUTPUT_EDGE * OUTPUT_EDGE);
    assert.ok(filled > 0.6 && filled < 0.9, `cell ${crop.cell} is ${filled} full`);
  }
});

test("a partial batch cuts only what was asked for", async () => {
  const split = ok(await splitContactSheet(await tidySheet(3), 3));
  assert.equal(split.crops.length, 3);
  assert.deepEqual(split.crops.map((crop) => crop.cell), [0, 1, 2]);
});

test("artwork in a cell nobody asked for is ignored, not an error", async () => {
  // A model that filled the blank cells anyway. Cells 4 to 16 are not ours.
  const split = ok(await splitContactSheet(await tidySheet(MAX_CELLS), 3));
  assert.equal(split.crops.length, 3);
});

test("a sheet whose edges do not divide by four is padded, not refused", async () => {
  const sheet = blank(509, 511);
  for (let index = 0; index < 4; index += 1) dish(sheet, index);

  const split = ok(await splitContactSheet(await png(sheet), 4));
  assert.equal(split.crops.length, 4);
  assert.equal(split.sheet.width, 512);
  assert.equal(split.sheet.height, 512);
});

test("a dish drawn over its cell boundary is recovered whole", async () => {
  // This is the case a fixed 4×4 crop got wrong on a real sheet: the dish is
  // pushed a sixth of a cell past the line, well inside the gutter we allow.
  const centred = blank(SHEET, SHEET);
  const shifted = blank(SHEET, SHEET);
  for (let index = 0; index < 6; index += 1) {
    dish(centred, index, { share: 0.5 });
    dish(shifted, index, index === 5 ? { share: 0.5, offsetX: 0.17, offsetY: -0.14 } : { share: 0.5 });
  }

  const before = ok(await splitContactSheet(await png(centred), 6));
  const after = ok(await splitContactSheet(await png(shifted), 6));

  const wanted = opaquePixels(await decodePng(before.crops[5]!.png));
  const got = opaquePixels(await decodePng(after.crops[5]!.png));

  // Nothing was clipped: the same dish, the same amount of it, wherever the
  // model happened to put it. A naive crop would have lost a corner, which is
  // tens of percent — the few percent allowed here is the rasteriser rounding a
  // circle drawn at a fractional centre.
  assert.ok(
    Math.abs(got - wanted) / wanted < 0.04,
    `recovered ${got} pixels against ${wanted} centred`,
  );
});

test("artwork reaching the edge of the gutter is refused", async () => {
  const sheet = blank(SHEET, SHEET);
  for (let index = 0; index < 6; index += 1) dish(sheet, index, { share: 0.66 });

  // A thin spur off the last dish — a spoon handle, a spilled sauce — reaching
  // right to the far side of the gutter. Nearly all of the dish is still in its
  // own cell, so ownership is not in doubt; what is in doubt is whether the
  // artwork stopped there or continued past where we looked.
  const box = cell(sheet, 5);
  for (let y = box.top + box.height / 2 - 3; y <= box.top + box.height / 2 + 3; y += 1) {
    for (let x = box.left + box.width / 2; x < box.left + box.width + 34; x += 1) {
      sheet.data[(y * sheet.width + x) * 4 + 3] = 255;
    }
  }

  const problems = refused(await splitContactSheet(await png(sheet), 6)).problems;
  assert.deepEqual(problems.map((problem) => problem.cell), [5]);
  assert.match(problems[0]!.reason, /recoverable gutter/);
});

test("artwork touching the edge of the sheet is refused", async () => {
  const sheet = blank(SHEET, SHEET);
  disc(sheet, 20, 20, 40); // Runs off the top-left corner.

  const problems = refused(await splitContactSheet(await png(sheet), 1)).problems;
  assert.match(problems[0]!.reason, /edge of the sheet/);
});

test("two dishes drawn into one another are refused, not guessed", async () => {
  const sheet = blank(SHEET, SHEET);
  const first = cell(sheet, 0);
  // One shape lying across the boundary between cell 1 and cell 2, half in each.
  disc(sheet, first.left + first.width, first.top + first.height / 2, 44);

  const problems = refused(await splitContactSheet(await png(sheet), 2)).problems;
  assert.deepEqual(problems.map((problem) => problem.cell), [0, 1]);
  for (const problem of problems) assert.match(problem.reason, /joined shape/);
});

test("separate dishes whose crops would overlap are refused", async () => {
  const sheet = blank(SHEET, SHEET);
  // Two discs that never touch — a transparent lane runs between them — but
  // whose bounding boxes cross diagonally, so each crop would contain a slice
  // of the other dish. Each still sits almost entirely in its own cell, so this
  // is not the ambiguous-ownership case: it is two pictures that cannot be cut
  // apart as rectangles.
  disc(sheet, 110, 60, 20);
  disc(sheet, 146, 92, 20);

  const problems = refused(await splitContactSheet(await png(sheet), 2)).problems;
  assert.match(problems[0]!.reason, /overlaps cell 2/);
});

test("a requested cell with nothing in it is refused", async () => {
  const sheet = blank(SHEET, SHEET);
  dish(sheet, 0);
  dish(sheet, 2);

  const problems = refused(await splitContactSheet(await png(sheet), 3)).problems;
  assert.deepEqual(problems.map((problem) => problem.cell), [1]);
  assert.match(problems[0]!.reason, /no artwork found/);
});

test("an entirely transparent sheet is refused, every cell of it", async () => {
  const problems = refused(
    await splitContactSheet(await png(blank(SHEET, SHEET)), 4),
  ).problems;
  assert.equal(problems.length, 4);
  for (const problem of problems) assert.match(problem.reason, /no artwork found/);
});

test("a speck is background, not a dish", async () => {
  const sheet = blank(SHEET, SHEET);
  dish(sheet, 0);
  const second = cell(sheet, 1);
  // Three pixels across: a stray dot of anti-aliasing, not somebody's dinner.
  disc(sheet, second.left + second.width / 2, second.top + second.height / 2, 1.5);

  const problems = refused(await splitContactSheet(await png(sheet), 2)).problems;
  assert.deepEqual(problems.map((problem) => problem.cell), [1]);
  assert.match(problems[0]!.reason, /no artwork found/);
});

test("a speck beside a real dish does not disturb it", async () => {
  const sheet = blank(SHEET, SHEET);
  dish(sheet, 0, { share: 0.5 });
  const box = cell(sheet, 0);
  disc(sheet, box.left + 12, box.top + 12, 1.5);

  const split = ok(await splitContactSheet(await png(sheet), 1));
  assert.equal(split.crops.length, 1);
});

test("bytes that are not an image are a PngError, not a crash", async () => {
  await assert.rejects(
    () => splitContactSheet(new Uint8Array([1, 2, 3, 4]), 1),
    /Not a PNG/,
  );
});

test("an image we cannot unpack is refused before any cutting", async () => {
  await assert.rejects(
    () => splitContactSheet(
      rawPng({ width: 8, height: 8, depth: 16, colourType: 6, pixels: new Uint8Array(8 * 8 * 8) }),
      1,
    ),
    /16 bits per channel/,
  );
});

test("a batch size outside one to sixteen is a programming error", async () => {
  const sheet = await tidySheet(1);
  await assert.rejects(() => splitContactSheet(sheet, 0), RangeError);
  await assert.rejects(() => splitContactSheet(sheet, MAX_CELLS + 1), RangeError);
  await assert.rejects(() => splitContactSheet(sheet, 1.5), RangeError);
});

test("a crop keeps the dish's shape rather than stretching it", async () => {
  // A wide dish: half as tall as it is broad. Padding to square must keep that,
  // so the crop is a wide shape centred in transparency — not a circle.
  const sheet = blank(SHEET, SHEET);
  const box = cell(sheet, 0);
  const centreX = box.left + box.width / 2;
  const centreY = box.top + box.height / 2;
  for (let y = centreY - 12; y <= centreY + 12; y += 1) {
    for (let x = centreX - 36; x <= centreX + 36; x += 1) {
      const at = (Math.round(y) * sheet.width + Math.round(x)) * 4;
      sheet.data[at + 3] = 255;
    }
  }

  const split = ok(await splitContactSheet(await png(sheet), 1));
  const image = await decodePng(split.crops[0]!.png);

  // The artwork is 73 x 25, padded to a 73-square and scaled to OUTPUT_EDGE, so
  // roughly a third of the crop is filled and the rest is transparent.
  const filled = opaquePixels(image) / (OUTPUT_EDGE * OUTPUT_EDGE);
  assert.ok(filled > 0.28 && filled < 0.40, `${filled} of the crop is filled`);

  // The middle row is artwork and the top row is not, which a stretched crop
  // could not manage.
  const middle = (OUTPUT_EDGE / 2) * OUTPUT_EDGE * 4;
  assert.equal(image.data[middle + (OUTPUT_EDGE / 2) * 4 + 3], 255);
  assert.equal(image.data[3], 0);
});

/**
 * The refusal an external image tool is most likely to earn (#111).
 *
 * The sheet is no longer drawn by an API this app calls; an admin copies the
 * prompt and brings a file back from whichever tool they chose, and plenty of
 * those flatten transparency on export. A flat opaque sheet is one enormous
 * connected component, so without this check the flood fill would report every
 * cell as joined to every other — sixteen identical complaints for one cause.
 *
 * There is deliberately no white-background fallback. Deciding which white
 * pixels are plate and which are background is guesswork, and guessing wrong
 * puts half of somebody else's dinner on a recipe.
 */
test("a sheet with no transparency is refused whole, naming transparency", async () => {
  const sheet = blank(SHEET, SHEET);
  // Opaque everywhere, with dishes drawn on it — a perfectly good-looking sheet
  // that happens to have been exported onto a background.
  for (let at = 3; at < sheet.data.length; at += 4) sheet.data[at] = 255;
  for (let index = 0; index < 4; index += 1) dish(sheet, index);

  const result = await splitContactSheet(await png(sheet), 4);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "sheet", "the sheet is refused whole, not cell by cell");
  if (result.kind !== "sheet") return;
  assert.equal(result.reason, NO_TRANSPARENCY);
  assert.match(result.reason, /transparen/);
});

/**
 * And the other side of it: the padding the splitter does itself must not be
 * mistaken for the transparency it requires. A sheet whose edges are not a
 * multiple of four is padded transparent, so the check has to run on the
 * decoded image rather than the padded one — otherwise every flattened sheet of
 * an awkward size would slip through and be mis-cut.
 */
test("the splitter's own padding does not count as transparency", async () => {
  const sheet = blank(SHEET + 2, SHEET + 2);
  for (let at = 3; at < sheet.data.length; at += 4) sheet.data[at] = 255;
  for (let index = 0; index < 2; index += 1) dish(sheet, index);

  const result = await splitContactSheet(await png(sheet), 2);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "sheet");
});
