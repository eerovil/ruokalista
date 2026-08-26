/**
 * Reading and writing PNG pixels, in as little code as the job needs.
 *
 * The contact sheet in #96 has to be cut apart by looking at its alpha channel,
 * and a Worker has no image library and no canvas — so the pixels have to be
 * unpacked here. What makes that affordable is that the compression is not ours
 * to write: a PNG's image data is a zlib stream, and the runtime already has
 * one in `DecompressionStream("deflate")`. What is left is the chunk envelope,
 * the scanline filters, and a CRC.
 *
 * This is deliberately narrow. It understands 8-bit non-interlaced PNGs in the
 * five colour types that describes, and refuses everything else by name rather
 * than guessing: a 16-bit or interlaced sheet is a sheet we cannot split, and
 * saying so is better than splitting the wrong pixels. It always hands back
 * straight RGBA, so nothing downstream has to care which of those five it was.
 *
 * `dev/check-png.ts` checks it against bytes it builds itself, including the
 * shapes it is supposed to refuse.
 */

/** Pixels, row-major, four bytes per pixel, not premultiplied. */
export interface Raster {
  width: number;
  height: number;
  /** `width * height * 4` bytes: r, g, b, a. */
  data: Uint8Array;
}

/** Why a PNG could not be read. Carried as text because a caller reports it. */
export class PngError extends Error {}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A cap on what we will unpack, because the pixel buffer is four bytes a pixel
 * and a Worker's memory is not ours to spend. Sixteen megapixels is four times
 * the largest sheet the image API will return.
 */
const MAX_PIXELS = 16 * 1024 * 1024;

/** Decode a PNG into RGBA pixels. Throws `PngError` on anything unsupported. */
export async function decodePng(bytes: Uint8Array): Promise<Raster> {
  if (bytes.length < 8 || !SIGNATURE.every((byte, at) => bytes[at] === byte)) {
    throw new PngError("Not a PNG.");
  }

  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  const parts: Uint8Array[] = [];

  for (const chunk of chunks(bytes)) {
    if (chunk.type === "IHDR") header = readHeader(chunk.data);
    else if (chunk.type === "PLTE") palette = chunk.data;
    else if (chunk.type === "tRNS") paletteAlpha = chunk.data;
    else if (chunk.type === "IDAT") parts.push(chunk.data);
    else if (chunk.type === "IEND") break;
  }

  if (header === null) throw new PngError("PNG has no header.");
  if (parts.length === 0) throw new PngError("PNG has no image data.");

  const raw = await inflate(concat(parts));
  const channels = unfilter(raw, header);
  return toRgba(channels, header, palette, paletteAlpha);
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * Always colour type 6 at 8 bits: the pictures this writes are crops of a
 * transparent sheet, so there is always an alpha channel worth keeping, and one
 * output shape means nothing downstream has to branch on what it got back.
 */
export async function encodePng(raster: Raster): Promise<Uint8Array> {
  const { width, height, data } = raster;
  if (width <= 0 || height <= 0) throw new PngError("Nothing to encode.");
  if (data.length !== width * height * 4) {
    throw new PngError("Pixel buffer does not match its stated size.");
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // compression 0, filter 0, interlace 0 — the only values PNG defines.

  const idat = await deflate(filterScanlines(raster));

  return concat([
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

interface Header {
  width: number;
  height: number;
  colourType: number;
  /** Bytes per pixel in the unfiltered data, at least one. */
  stride: number;
  channels: number;
}

function readHeader(data: Uint8Array): Header {
  if (data.length < 13) throw new PngError("PNG header is truncated.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = data[8]!;
  const colourType = data[9]!;
  const interlace = data[12]!;

  if (width === 0 || height === 0) throw new PngError("PNG has no pixels.");
  if (width * height > MAX_PIXELS) {
    throw new PngError(`PNG is ${width}x${height}, which is too large to read.`);
  }
  if (depth !== 8) {
    throw new PngError(`PNG is ${depth} bits per channel; only 8 is supported.`);
  }
  if (interlace !== 0) throw new PngError("PNG is interlaced, which is not supported.");

  const channels = channelsFor(colourType);
  return { width, height, colourType, channels, stride: channels };
}

function channelsFor(colourType: number): number {
  if (colourType === 0) return 1; // greyscale
  if (colourType === 2) return 3; // truecolour
  if (colourType === 3) return 1; // palette index
  if (colourType === 4) return 2; // greyscale with alpha
  if (colourType === 6) return 4; // truecolour with alpha
  throw new PngError(`PNG colour type ${colourType} is not supported.`);
}

interface Chunk {
  type: string;
  data: Uint8Array;
}

/**
 * Walk the chunk chain. A length that runs off the end stops the walk rather
 * than throwing: the caller's complaint is "no image data", which says more
 * about the file than "chunk 4 is short" does.
 */
function* chunks(bytes: Uint8Array): Generator<Chunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;

  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const start = at + 8;
    if (start + length > bytes.length) return;

    yield { type, data: bytes.subarray(start, start + length) };
    at = start + length + 4; // past the CRC
  }
}

/**
 * Undo the per-scanline filters, dropping the filter byte as it goes.
 *
 * Every filter is a prediction from the pixel to the left and the scanline
 * above, so this has to run in order and in place — which is also why it is a
 * loop over bytes rather than anything prettier.
 */
function unfilter(raw: Uint8Array, header: Header): Uint8Array {
  const { width, height, stride } = header;
  const rowBytes = width * stride;
  if (raw.length < (rowBytes + 1) * height) {
    throw new PngError("PNG image data is truncated.");
  }

  const out = new Uint8Array(rowBytes * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)]!;
    const from = y * (rowBytes + 1) + 1;
    const to = y * rowBytes;
    const above = to - rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[from + x]!;
      const left = x >= stride ? out[to + x - stride]! : 0;
      const up = y > 0 ? out[above + x]! : 0;
      const upLeft = y > 0 && x >= stride ? out[above + x - stride]! : 0;

      let restored: number;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) restored = value + paeth(left, up, upLeft);
      else throw new PngError(`PNG scanline filter ${filter} is not defined.`);

      out[to + x] = restored & 0xff;
    }
  }

  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}

/** Expand whatever colour type this was into straight RGBA. */
function toRgba(
  channels: Uint8Array,
  header: Header,
  palette: Uint8Array | null,
  paletteAlpha: Uint8Array | null,
): Raster {
  const { width, height, colourType, stride } = header;
  const data = new Uint8Array(width * height * 4);

  for (let i = 0, at = 0; i < width * height; i += 1, at += stride) {
    const out = i * 4;

    if (colourType === 6) {
      data[out] = channels[at]!;
      data[out + 1] = channels[at + 1]!;
      data[out + 2] = channels[at + 2]!;
      data[out + 3] = channels[at + 3]!;
    } else if (colourType === 2) {
      data[out] = channels[at]!;
      data[out + 1] = channels[at + 1]!;
      data[out + 2] = channels[at + 2]!;
      data[out + 3] = 255;
    } else if (colourType === 0) {
      const grey = channels[at]!;
      data[out] = grey;
      data[out + 1] = grey;
      data[out + 2] = grey;
      data[out + 3] = 255;
    } else if (colourType === 4) {
      const grey = channels[at]!;
      data[out] = grey;
      data[out + 1] = grey;
      data[out + 2] = grey;
      data[out + 3] = channels[at + 1]!;
    } else {
      if (palette === null) throw new PngError("Palette PNG has no palette.");
      const index = channels[at]!;
      if (index * 3 + 2 >= palette.length) {
        throw new PngError("Palette PNG indexes a colour it does not have.");
      }
      data[out] = palette[index * 3]!;
      data[out + 1] = palette[index * 3 + 1]!;
      data[out + 2] = palette[index * 3 + 2]!;
      data[out + 3] = paletteAlpha === null ? 255 : (paletteAlpha[index] ?? 255);
    }
  }

  return { width, height, data };
}

/**
 * Filter every scanline, picking per row whichever of the five predicts best.
 *
 * "Best" is the smallest sum of absolute deviations, which is the heuristic the
 * PNG specification itself suggests. It matters here because the alternative —
 * writing every row unfiltered — leaves flat illustration compressing several
 * times worse, and the stored crop has a byte cap to fit under.
 */
function filterScanlines({ width, height, data }: Raster): Uint8Array {
  const rowBytes = width * 4;
  const out = new Uint8Array((rowBytes + 1) * height);
  const candidate = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    const above = row - rowBytes;
    let bestFilter = 0;
    let bestScore = Infinity;

    for (let filter = 0; filter <= 4; filter += 1) {
      let score = 0;
      for (let x = 0; x < rowBytes; x += 1) {
        const value = data[row + x]!;
        const left = x >= 4 ? data[row + x - 4]! : 0;
        const up = y > 0 ? data[above + x]! : 0;
        const upLeft = y > 0 && x >= 4 ? data[above + x - 4]! : 0;
        const residual = predict(filter, value, left, up, upLeft);
        score += residual < 128 ? residual : 256 - residual;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
      }
    }

    for (let x = 0; x < rowBytes; x += 1) {
      const value = data[row + x]!;
      const left = x >= 4 ? data[row + x - 4]! : 0;
      const up = y > 0 ? data[above + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? data[above + x - 4]! : 0;
      candidate[x] = predict(bestFilter, value, left, up, upLeft);
    }

    out[y * (rowBytes + 1)] = bestFilter;
    out.set(candidate, y * (rowBytes + 1) + 1);
  }

  return out;
}

function predict(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) return value;
  if (filter === 1) return (value - left) & 0xff;
  if (filter === 2) return (value - up) & 0xff;
  if (filter === 3) return (value - ((left + up) >> 1)) & 0xff;
  return (value - paeth(left, up, upLeft)) & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A PNG's image data is a zlib stream, which is what `"deflate"` means to the
 * platform's compression streams — `"deflate-raw"` is the headerless one. So
 * both directions are the runtime's work, not ours.
 */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await through(bytes, new DecompressionStream("deflate"));
  } catch {
    throw new PngError("PNG image data is not valid compressed data.");
  }
}

function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new CompressionStream("deflate"));
}

async function through(
  bytes: Uint8Array,
  transform: { readable: ReadableStream; writable: WritableStream },
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const out = await new Response(source.pipeThrough(transform as never)).arrayBuffer();
  return new Uint8Array(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
