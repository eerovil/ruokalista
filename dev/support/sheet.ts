import zlib from "node:zlib";

import { encodePng, type Raster } from "../../src/png.ts";

/**
 * Building contact sheets to cut apart, and PNGs to refuse.
 *
 * The sheets here are drawn rather than committed, for the same reason the
 * browser suite builds its own images: what is under test is what the pixels
 * say — where a dish sits, whether two of them touch, whether a cell is empty —
 * and a committed fixture would hide the one thing each case is about. Every
 * awkward sheet the splitter has to reject is therefore a few lines of drawing
 * rather than a file somebody has to trust.
 */

export const GRID = 4;

/** A fully transparent sheet. */
export function blank(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Where cell `index` (0-based, row-major) sits on a sheet. */
export function cell(
  sheet: Raster,
  index: number,
): { left: number; top: number; width: number; height: number } {
  const cellWidth = Math.floor(sheet.width / GRID);
  const cellHeight = Math.floor(sheet.height / GRID);
  const col = index % GRID;
  const row = Math.floor(index / GRID);
  return {
    left: col * cellWidth,
    top: row * cellHeight,
    width: cellWidth,
    height: cellHeight,
  };
}

/**
 * Draw a filled disc. A disc rather than a square because a dish's real
 * bounding box being larger than the pixels it fills is exactly the case the
 * splitter's crop-then-pad has to get right.
 */
export function disc(
  sheet: Raster,
  centreX: number,
  centreY: number,
  radius: number,
  colour: [number, number, number] = [200, 110, 60],
): void {
  for (let y = Math.max(0, Math.floor(centreY - radius)); y <= Math.min(sheet.height - 1, Math.ceil(centreY + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(centreX - radius)); x <= Math.min(sheet.width - 1, Math.ceil(centreX + radius)); x += 1) {
      const dx = x - centreX;
      const dy = y - centreY;
      if (dx * dx + dy * dy > radius * radius) continue;
      const at = (y * sheet.width + x) * 4;
      sheet.data[at] = colour[0];
      sheet.data[at + 1] = colour[1];
      sheet.data[at + 2] = colour[2];
      sheet.data[at + 3] = 255;
    }
  }
}

/**
 * A dish in the middle of its cell, at the share of the cell the prompt asks
 * for. `offsetX`/`offsetY` nudge it, as a share of a cell edge, which is how a
 * model that placed things loosely is reproduced.
 */
export function dish(
  sheet: Raster,
  index: number,
  options: { share?: number; offsetX?: number; offsetY?: number } = {},
): void {
  const box = cell(sheet, index);
  const share = options.share ?? 0.66;
  const radius = (Math.min(box.width, box.height) * share) / 2;
  disc(
    sheet,
    box.left + box.width / 2 + (options.offsetX ?? 0) * box.width,
    box.top + box.height / 2 + (options.offsetY ?? 0) * box.height,
    radius,
  );
}

/** How many pixels of this raster are not transparent. */
export function opaquePixels({ data }: Raster, floor = 8): number {
  let count = 0;
  for (let at = 3; at < data.length; at += 4) if (data[at]! >= floor) count += 1;
  return count;
}

/** The sheet as PNG bytes, through the encoder the Worker itself uses. */
export function png(sheet: Raster): Promise<Uint8Array> {
  return encodePng(sheet);
}

interface RawOptions {
  width: number;
  height: number;
  depth?: number;
  colourType: number;
  interlace?: number;
  /** Unfiltered channel bytes, one row after another. */
  pixels: Uint8Array;
  /** The filter byte to put in front of every row. */
  filter?: number;
  palette?: Uint8Array;
  paletteAlpha?: Uint8Array;
  /** Leave the image data out entirely. */
  omitData?: boolean;
}

/**
 * A PNG built by hand, so the decoder can be shown the shapes it must refuse —
 * sixteen bits a channel, interlaced, a colour type that does not exist — none
 * of which our own encoder can produce.
 */
export function rawPng(options: RawOptions): Uint8Array {
  const {
    width,
    height,
    depth = 8,
    colourType,
    interlace = 0,
    pixels,
    filter = 0,
    palette,
    paletteAlpha,
    omitData = false,
  } = options;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colourType;
  ihdr[12] = interlace;

  const rowBytes = pixels.length / height;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([filter]));
    rows.push(Buffer.from(pixels.subarray(y * rowBytes, (y + 1) * rowBytes)));
  }

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (palette !== undefined) parts.push(chunk("PLTE", Buffer.from(palette)));
  if (paletteAlpha !== undefined) parts.push(chunk("tRNS", Buffer.from(paletteAlpha)));
  if (!omitData) parts.push(chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))));
  parts.push(chunk("IEND", Buffer.alloc(0)));

  return new Uint8Array(Buffer.concat(parts));
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([head, typed, crc]);
}
