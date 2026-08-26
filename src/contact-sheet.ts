import { decodePng, encodePng, PngError, type Raster } from "./png.ts";

/**
 * Cutting one 4×4 transparent contact sheet into up to sixteen recipe pictures.
 *
 * The split is not another model call, and nothing here looks at what a picture
 * depicts. Which recipe a crop belongs to is decided entirely by where it sits:
 * cell 1 is the first recipe the caller asked for, cell 2 the second, row-major
 * to cell 16. That is the whole mapping, and it is why no OCR, no vision model
 * and no semantic matching appears in this file — position is already the
 * answer, and asking a model to confirm it would only add a way to be wrong.
 *
 * What a naive fixed 4×4 crop gets wrong
 * --------------------------------------
 * A real generated sheet had one dish drawn slightly outside its nominal cell,
 * and cutting on the arithmetic boundary sliced it in half. So the grid is
 * treated as a *locator*, not as a promise the model kept: each cell's artwork
 * is found by following its own non-transparent pixels outward into the gutter
 * the prompt asked for, and the crop is that artwork's real bounding box.
 *
 * Which only works while the artwork is still separable. Where it is not — two
 * dishes drawn into each other, a dish running past the recoverable gutter,
 * a cell with nothing in it — the honest answer is that this sheet cannot be
 * cut, and the whole sheet is rejected. Nothing is stored from a sheet that
 * failed here, so a wrong or clipped picture never reaches a recipe.
 *
 * What it costs
 * -------------
 * Unpacking a 1,024 px sheet, flooding it and writing sixteen crops measured at
 * about 1.5 seconds of CPU on a development host, a fifth of that for one crop.
 * That is far outside this deployment's 10 ms Worker budget, which is why #111
 * runs this shared module in the admin's browser. Worth knowing before anybody
 * moves it back or optimises the per-scanline filter search in `png.ts`, where
 * most of the time goes.
 */

/** Four columns, four rows, sixteen cells. The contract, not a setting. */
export const GRID = 4;
export const MAX_CELLS = GRID * GRID;

/**
 * How far outside its nominal cell a dish may stray and still be recovered, as
 * a share of one cell's edge. The prompt asks for generous transparent gutters
 * and for each dish to sit well inside its cell, so a quarter of a cell of
 * recovery room on every side is slack for a model that placed things a little
 * loosely — not permission to ignore the grid.
 */
const GUTTER_SHARE = 0.25;

/**
 * Below this, a pixel is background. Not zero: a transparent PNG's edges are
 * anti-aliased, so the faintest fringe of a dish is a pixel or two of alpha
 * that would otherwise chain two neighbours together into one component.
 */
const ALPHA_FLOOR = 8;

/**
 * Artwork smaller than this is a speck — a stray dot of anti-aliasing or a
 * compression artefact — and is ignored rather than treated as a dish or as a
 * collision. At the sheet sizes the image API returns this is a few hundredths
 * of one percent of a cell.
 */
const MIN_COMPONENT_PIXELS = 48;

/**
 * When one piece of artwork straddles two nominal cells, the cell holding most
 * of it owns it — but only if it is clearly most. Once the runner-up holds this
 * share of the winner's pixels, which cell the dish belongs to is genuinely
 * unclear, and a guess would put a picture on the wrong recipe.
 */
const OWNERSHIP_MARGIN = 0.25;

/**
 * Every stored crop is this square. One size because a list of recipes whose
 * row height depends on the picture is a list that jumps about while you scroll
 * it, and because the recipe screen's own band is a fixed height already.
 *
 * It is larger than one cell of a 1,024 px sheet, so a crop is scaled up rather
 * than down. That is the real cost of asking for sixteen dishes in one paid
 * request: per-dish resolution is the thing being traded away. Flat cookbook
 * illustration — which is what the locked style asks for — survives it far
 * better than a photograph would.
 */
export const OUTPUT_EDGE = 512;

/** One recipe's picture, cut out and ready to store. */
export interface Crop {
  /** The cell it came from, 0-based row-major. */
  cell: number;
  /** A `${OUTPUT_EDGE}`-square PNG. */
  png: Uint8Array;
}

/** Why one cell could not be cut. */
export interface CellProblem {
  cell: number;
  reason: string;
}

/**
 * Why a whole sheet was refused before any cell was looked at. There is one
 * such reason, and it is the one an external image tool is most likely to hit.
 */
export const NO_TRANSPARENCY =
  "this sheet has no transparent pixels at all, so there is no background to " +
  "tell the sixteen dishes apart by — the tool that made it has flattened the " +
  "transparency, and a sheet drawn on white cannot be cut";

export type SplitResult =
  | { ok: true; crops: Crop[]; sheet: { width: number; height: number } }
  /** The sheet is not a sheet. Nothing about individual cells was even asked. */
  | { ok: false; kind: "sheet"; reason: string }
  | { ok: false; kind: "cells"; problems: CellProblem[] };

/**
 * Cut `count` pictures out of a contact sheet, or refuse the sheet.
 *
 * Refusing is a returned value rather than an exception because every cell's
 * complaint is worth reporting at once: a caller looking at "cells 3 and 4 are
 * joined together" knows to retry, and a caller looking at ten empty cells
 * knows the prompt or the model is the problem.
 */
export async function splitContactSheet(
  bytes: Uint8Array,
  count: number,
): Promise<SplitResult> {
  if (count < 1 || count > MAX_CELLS || !Number.isInteger(count)) {
    throw new RangeError(`A contact sheet holds 1 to ${MAX_CELLS} pictures.`);
  }

  const decoded = await decodePng(bytes);

  // Before anything else, and before padding — which adds transparent pixels of
  // its own and would answer this question for us. A sheet with no transparency
  // is one flat opaque rectangle: every dish on it is joined to every other by
  // the background, so the flood fill below would find one enormous component
  // and report sixteen cells as joined together. Saying *why* is far more use
  // than sixteen identical complaints, and the cause is nearly always the same
  // one — plenty of external image tools flatten transparency on export.
  //
  // There is deliberately no white-background fallback. Deciding which white
  // pixels are plate and which are background is guesswork, and guessing wrong
  // means a recipe gets a picture of half of somebody else's dinner.
  if (!hasTransparency(decoded)) {
    return { ok: false, kind: "sheet", reason: NO_TRANSPARENCY };
  }

  const sheet = padToGrid(decoded);
  const cellWidth = sheet.width / GRID;
  const cellHeight = sheet.height / GRID;

  const components = findComponents(sheet);
  const problems: CellProblem[] = [];
  const boxes: (Box | null)[] = [];

  // Ownership first, for every component on the sheet: a dish drawn across two
  // cells has to be resolved before either of those cells can be cut, and a
  // component nobody requested still matters if it is joined to one that was.
  const owned = new Map<number, Component[]>();
  for (const component of components) {
    const claim = ownerOf(component);
    if (claim.ambiguous) {
      // Only a problem if it would have gone to a recipe. Two dishes drawn into
      // each other in the blank corner of a partial batch is not our business.
      const involved = claim.candidates.filter((cell) => cell < count);
      for (const cell of involved) {
        problems.push({
          cell,
          reason:
            `artwork here runs into cell ${claim.candidates.filter((c) => c !== cell)[0]! + 1} ` +
            "as one joined shape, so which recipe it belongs to cannot be decided",
        });
      }
      continue;
    }
    const list = owned.get(claim.cell);
    if (list === undefined) owned.set(claim.cell, [component]);
    else list.push(component);
  }

  for (let cell = 0; cell < count; cell += 1) {
    const search = searchRegion(cell, sheet, cellWidth, cellHeight);
    const mine = owned.get(cell) ?? [];

    if (mine.length === 0) {
      // Only complain once: a cell whose artwork was rejected as ambiguous has
      // already said why, and "and it is also empty" adds nothing.
      if (!problems.some((problem) => problem.cell === cell)) {
        problems.push({ cell, reason: "no artwork found in this cell or its gutter" });
      }
      boxes.push(null);
      continue;
    }

    const box = union(mine.map((component) => component.box));

    const touching = touchedEdges(box, search, sheet);
    if (touching !== null) {
      problems.push({ cell, reason: touching });
      boxes.push(null);
      continue;
    }

    boxes.push(box);
  }

  // Two cells whose artwork ended up overlapping the same pixels are separable
  // as components but not as pictures — one dish would appear in both crops.
  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      const first = boxes[a];
      const second = boxes[b];
      if (first === null || second === null || first === undefined || second === undefined) continue;
      if (!overlaps(first, second)) continue;
      problems.push({
        cell: a,
        reason: `artwork overlaps cell ${b + 1}'s, so the two cannot be cut apart`,
      });
    }
  }

  if (problems.length > 0) {
    problems.sort((a, b) => a.cell - b.cell);
    return { ok: false, kind: "cells", problems };
  }

  const crops: Crop[] = [];
  for (let cell = 0; cell < count; cell += 1) {
    const box = boxes[cell]!;
    crops.push({ cell, png: await encodePng(normalize(sheet, box)) });
  }

  return { ok: true, crops, sheet: { width: sheet.width, height: sheet.height } };
}

export { PngError };

interface Box {
  left: number;
  top: number;
  /** Inclusive. */
  right: number;
  /** Inclusive. */
  bottom: number;
}

interface Component {
  box: Box;
  pixels: number;
  /** How many of its pixels fall in each nominal cell. */
  perCell: number[];
}

/**
 * Transparent-pad the sheet so both edges divide by four, which is what defines
 * the nominal grid at all. A 1,023 px sheet is not a broken sheet; it is a
 * sheet whose cells are not whole pixels, and one column of transparency fixes
 * that without moving any artwork.
 */
/**
 * Whether any pixel on this sheet is see-through. One pass over the alpha
 * channel, and it stops at the first one it finds — a real transparent sheet
 * answers this within its first row of gutter.
 */
function hasTransparency({ data }: Raster): boolean {
  for (let at = 3; at < data.length; at += 4) {
    if (data[at]! < ALPHA_FLOOR) return true;
  }
  return false;
}

function padToGrid(raster: Raster): Raster {
  const width = raster.width + ((GRID - (raster.width % GRID)) % GRID);
  const height = raster.height + ((GRID - (raster.height % GRID)) % GRID);
  if (width === raster.width && height === raster.height) return raster;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < raster.height; y += 1) {
    data.set(
      raster.data.subarray(y * raster.width * 4, (y + 1) * raster.width * 4),
      y * width * 4,
    );
  }
  return { width, height, data };
}

/**
 * Every piece of non-transparent artwork on the sheet, as a bounding box and a
 * per-cell pixel count.
 *
 * Eight-connected, so a dish whose parts meet only diagonally is one shape
 * rather than two. The stack is explicit because a thousand-by-thousand sheet
 * of one connected blob would blow a recursive flood fill's call stack.
 */
function findComponents({ width, height, data }: Raster): Component[] {
  const seen = new Uint8Array(width * height);
  const cellWidth = width / GRID;
  const cellHeight = height / GRID;
  const components: Component[] = [];
  const stack: number[] = [];

  const opaque = (at: number): boolean => data[at * 4 + 3]! >= ALPHA_FLOOR;

  for (let start = 0; start < seen.length; start += 1) {
    if (seen[start] === 1 || !opaque(start)) continue;

    let pixels = 0;
    const perCell = new Array<number>(MAX_CELLS).fill(0);
    const box: Box = {
      left: width,
      top: height,
      right: -1,
      bottom: -1,
    };

    seen[start] = 1;
    stack.push(start);

    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % width;
      const y = (at - x) / width;

      pixels += 1;
      const cell =
        Math.min(GRID - 1, Math.floor(y / cellHeight)) * GRID +
        Math.min(GRID - 1, Math.floor(x / cellWidth));
      perCell[cell] = perCell[cell]! + 1;

      if (x < box.left) box.left = x;
      if (x > box.right) box.right = x;
      if (y < box.top) box.top = y;
      if (y > box.bottom) box.bottom = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (seen[next] === 1 || !opaque(next)) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }

    if (pixels >= MIN_COMPONENT_PIXELS) components.push({ box, pixels, perCell });
  }

  return components;
}

type Claim =
  | { ambiguous: false; cell: number }
  | { ambiguous: true; candidates: number[] };

/**
 * Which cell a piece of artwork belongs to: the one holding most of its pixels.
 *
 * A dish that leaked a little into its neighbour's gutter still has almost all
 * of itself at home, so this is decisive for exactly the case the gutter exists
 * for. It stops being decisive when two dishes have been drawn into one another,
 * which is the case that must not be guessed.
 */
function ownerOf(component: Component): Claim {
  let best = 0;
  let bestCount = -1;
  let runnerUp = -1;
  let runnerUpCount = -1;

  for (let cell = 0; cell < MAX_CELLS; cell += 1) {
    const count = component.perCell[cell]!;
    if (count > bestCount) {
      runnerUp = best;
      runnerUpCount = bestCount;
      best = cell;
      bestCount = count;
    } else if (count > runnerUpCount) {
      runnerUp = cell;
      runnerUpCount = count;
    }
  }

  if (runnerUpCount > 0 && runnerUpCount >= bestCount * OWNERSHIP_MARGIN) {
    return { ambiguous: true, candidates: [best, runnerUp].sort((a, b) => a - b) };
  }
  return { ambiguous: false, cell: best };
}

/** A cell plus the gutter we are willing to look into for its artwork. */
function searchRegion(
  cell: number,
  sheet: Raster,
  cellWidth: number,
  cellHeight: number,
): Box {
  const col = cell % GRID;
  const row = (cell - col) / GRID;
  const slackX = Math.round(cellWidth * GUTTER_SHARE);
  const slackY = Math.round(cellHeight * GUTTER_SHARE);

  return {
    left: Math.max(0, col * cellWidth - slackX),
    top: Math.max(0, row * cellHeight - slackY),
    right: Math.min(sheet.width - 1, (col + 1) * cellWidth - 1 + slackX),
    bottom: Math.min(sheet.height - 1, (row + 1) * cellHeight - 1 + slackY),
  };
}

/**
 * Whether this artwork runs up against a limit, and which one — the edge of
 * what we were willing to search, or the edge of the sheet itself.
 *
 * Either way the crop cannot be trusted: artwork that stops exactly at a
 * boundary is artwork we have no way of knowing continued past it, and a crop
 * that clips a dish is worse than no picture at all.
 */
function touchedEdges(box: Box, search: Box, sheet: Raster): string | null {
  const atSheetEdge =
    box.left <= 0 || box.top <= 0 ||
    box.right >= sheet.width - 1 || box.bottom >= sheet.height - 1;
  if (atSheetEdge) {
    return "artwork reaches the edge of the sheet, so it may be cut off already";
  }

  const atSearchEdge =
    box.left <= search.left || box.top <= search.top ||
    box.right >= search.right || box.bottom >= search.bottom;
  if (atSearchEdge) {
    return "artwork reaches the edge of the recoverable gutter, so it may extend past it";
  }

  return null;
}

function union(boxes: Box[]): Box {
  return boxes.reduce((a, b) => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }));
}

function overlaps(a: Box, b: Box): boolean {
  return a.left <= b.right && b.left <= a.right &&
    a.top <= b.bottom && b.top <= a.bottom;
}

/**
 * Crop the artwork, pad it out to a square with transparency, and scale that to
 * the one stored size. Padding rather than stretching, for the same reason the
 * recipe list crops rather than squashes: the shape a dish was drawn in is not
 * ours to change.
 */
function normalize(sheet: Raster, box: Box): Raster {
  const width = box.right - box.left + 1;
  const height = box.bottom - box.top + 1;
  const side = Math.max(width, height);

  const square: Raster = {
    width: side,
    height: side,
    data: new Uint8Array(side * side * 4),
  };
  const offsetX = Math.floor((side - width) / 2);
  const offsetY = Math.floor((side - height) / 2);

  for (let y = 0; y < height; y += 1) {
    const from = ((box.top + y) * sheet.width + box.left) * 4;
    square.data.set(
      sheet.data.subarray(from, from + width * 4),
      ((offsetY + y) * side + offsetX) * 4,
    );
  }

  return resize(square, OUTPUT_EDGE);
}

/**
 * Scale a square raster to `edge` pixels, sampling on premultiplied alpha.
 *
 * Premultiplying is not a detail: on a transparent sheet the colour under a
 * fully transparent pixel is arbitrary, and averaging it in unpremultiplied
 * would paint a halo of that arbitrary colour around every dish. Shrinking by
 * more than half halves in whole steps first, because a single bilinear tap
 * over a large footprint reads a fraction of the pixels and aliases the rest.
 */
function resize(source: Raster, edge: number): Raster {
  let current = premultiply(source);
  while (current.width >= edge * 2) current = halve(current);
  if (current.width === edge) return unpremultiply(current);

  const data = new Uint8Array(edge * edge * 4);
  const scale = (current.width - 1) / Math.max(1, edge - 1);

  for (let y = 0; y < edge; y += 1) {
    const sy = Math.min(current.height - 1, y * scale);
    const y0 = Math.floor(sy);
    const y1 = Math.min(current.height - 1, y0 + 1);
    const wy = sy - y0;

    for (let x = 0; x < edge; x += 1) {
      const sx = Math.min(current.width - 1, x * scale);
      const x0 = Math.floor(sx);
      const x1 = Math.min(current.width - 1, x0 + 1);
      const wx = sx - x0;

      const out = (y * edge + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = current.data[(y0 * current.width + x0) * 4 + channel]!;
        const topRight = current.data[(y0 * current.width + x1) * 4 + channel]!;
        const bottomLeft = current.data[(y1 * current.width + x0) * 4 + channel]!;
        const bottomRight = current.data[(y1 * current.width + x1) * 4 + channel]!;
        const top = topLeft + (topRight - topLeft) * wx;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * wx;
        data[out + channel] = Math.round(top + (bottom - top) * wy);
      }
    }
  }

  return unpremultiply({ width: edge, height: edge, data });
}

function premultiply({ width, height, data }: Raster): Raster {
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3]!;
    out[at] = Math.round((data[at]! * alpha) / 255);
    out[at + 1] = Math.round((data[at + 1]! * alpha) / 255);
    out[at + 2] = Math.round((data[at + 2]! * alpha) / 255);
    out[at + 3] = alpha;
  }
  return { width, height, data: out };
}

function unpremultiply({ width, height, data }: Raster): Raster {
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3]!;
    if (alpha === 0) continue;
    out[at] = Math.min(255, Math.round((data[at]! * 255) / alpha));
    out[at + 1] = Math.min(255, Math.round((data[at + 1]! * 255) / alpha));
    out[at + 2] = Math.min(255, Math.round((data[at + 2]! * 255) / alpha));
    out[at + 3] = alpha;
  }
  return { width, height, data: out };
}

/** One whole-step box downsample, which is exact and cannot alias. */
function halve({ width, height, data }: Raster): Raster {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = ((y * 2) * width + x * 2) * 4;
      const b = a + 4;
      const c = a + width * 4;
      const d = c + 4;
      const to = (y * w + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        out[to + channel] = (
          data[a + channel]! + data[b + channel]! +
          data[c + channel]! + data[d + channel]! + 2
        ) >> 2;
      }
    }
  }

  return { width: w, height: h, data: out };
}
