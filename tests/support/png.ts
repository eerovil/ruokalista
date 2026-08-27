import zlib from "node:zlib";

/**
 * The PNGs the image specs build by hand.
 *
 * All of them are real files rather than fixtures on disk, because what makes
 * them useful is being exactly one thing: a picture with a single pixel in it,
 * a sheet with nothing drawn on it, a sheet with no transparency left. They are
 * shared so two specs cannot drift into testing two different "empty sheets".
 */

/** The smallest real picture a person could upload. */
export function onePixelPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 20, 90, 40, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A transparent PNG with nothing drawn on it — a sheet the model wasted. */
export function emptySheet(edge = 512): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(edge, 0);
  ihdr.writeUInt32BE(edge, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(edge * 4)]);
  const pixels = Buffer.concat(Array.from({ length: edge }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/**
 * A sheet with every pixel opaque — the transparency flattened out of it.
 *
 * This is the export mistake #111's refusal exists for: plenty of external
 * image tools write a flat background instead of an alpha channel, and the
 * splitter tells the sixteen dishes apart by nothing but their own alpha. There
 * is no artwork on it because the refusal comes before any is looked for.
 */
export function opaqueSheet(edge = 512): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(edge, 0);
  ihdr.writeUInt32BE(edge, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const row = Buffer.alloc(edge * 4 + 1);
  for (let at = 1; at < row.length; at += 4) {
    row[at] = 240;
    row[at + 1] = 240;
    row[at + 2] = 240;
    row[at + 3] = 255;
  }
  const pixels = Buffer.concat(Array.from({ length: edge }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([head, typed, crc]);
}
