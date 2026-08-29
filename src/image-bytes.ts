/**
 * What a recipe image actually is, read from its first bytes.
 *
 * The type a caller declares is not evidence. A browser sends whatever the
 * operating system guessed from the file extension, and a bulk script sends
 * whatever its author typed into a header — so trusting either would let any
 * bytes at all be stored and then served back from this app's own origin under
 * an `image/*` label. The signature is the only thing that knows.
 *
 * Reading the header also gives the pixel size for free, which is what the
 * upload bound is really about: five megabytes of JPEG and five megabytes of
 * PNG are wildly different pictures, and it is the pixels that wreck a phone
 * layout, not the bytes.
 */

export interface ImageFacts {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

/**
 * What we will keep as a recipe picture, whoever it arrived from.
 *
 * The byte cap is the ingest guard; the edge cap is the one that matters,
 * because it is pixels that make a picture too big to store and too wide to
 * read on a phone. They live here rather than with the upload route because
 * the same two numbers now decide what a page's own photograph has to be for
 * `recipe-fetch.ts` to bother downloading it (#205) — one set of limits, not
 * two that can drift.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2000;

/**
 * The picture these bytes are, if they are one we would store — null when they
 * are not an image at all, or are past either cap.
 *
 * A caller that owes somebody a reason for the refusal reads `readImage` and
 * the caps itself; this is for the callers that simply move on to the next
 * candidate.
 */
export function storableImage(bytes: ArrayBuffer): ImageFacts | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const facts = readImage(bytes);
  if (facts === null) return null;
  return Math.max(facts.width, facts.height) > MAX_IMAGE_EDGE ? null : facts;
}

/** The file extension we store a given type under. */
export function extensionFor(contentType: ImageFacts["contentType"]): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

/**
 * Identify and measure an image, or return null if these bytes are not one of
 * the three formats we accept.
 */
export function readImage(bytes: ArrayBuffer): ImageFacts | null {
  const view = new DataView(bytes);
  return readPng(view) ?? readJpeg(view) ?? readWebp(view);
}

function readPng(view: DataView): ImageFacts | null {
  // 8-byte signature, then a length+type header, then IHDR's width and height.
  if (view.byteLength < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, at) => view.getUint8(at) === byte)) return null;
  if (ascii(view, 12, 4) !== "IHDR") return null;

  return {
    contentType: "image/png",
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

function readJpeg(view: DataView): ImageFacts | null {
  if (view.byteLength < 4) return null;
  if (view.getUint16(0) !== 0xffd8) return null;

  // Walk the segment chain to the frame header, which is the only segment that
  // states the size. Everything before it — EXIF, colour profiles, a thumbnail
  // — is skipped by its own declared length.
  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return null;

    const marker = view.getUint8(at + 1);
    // Padding between segments, and the standalone markers that carry no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }

    const length = view.getUint16(at + 2);
    if (length < 2) return null;

    // SOF0-SOF15, less the three markers sharing that range that are not frame
    // headers: DHT, JPG and DAC. Every other value here states a size, however
    // the picture behind it happens to be coded.
    const isFrame = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > view.byteLength) return null;
      return {
        contentType: "image/jpeg",
        height: view.getUint16(at + 5),
        width: view.getUint16(at + 7),
      };
    }

    // Scan data is not length-delimited, so there is nothing left to walk.
    if (marker === 0xda) return null;
    at += 2 + length;
  }

  return null;
}

function readWebp(view: DataView): ImageFacts | null {
  if (view.byteLength < 30) return null;
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WEBP") return null;

  const chunk = ascii(view, 12, 4);

  // Lossy: the VP8 keyframe header, past its 3-byte start code and the
  // 0x9d012a sync word. Both dimensions are 14 bits.
  if (chunk === "VP8 ") {
    if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 ||
        view.getUint8(25) !== 0x2a) return null;
    return {
      contentType: "image/webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }

  // Lossless: 14 bits each, packed little-endian after the 0x2f signature,
  // and stored one less than the real size.
  if (chunk === "VP8L") {
    if (view.getUint8(20) !== 0x2f) return null;
    const packed = view.getUint32(21, true);
    return {
      contentType: "image/webp",
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  // Extended: 24 bits each, little-endian, also stored one less.
  if (chunk === "VP8X") {
    return {
      contentType: "image/webp",
      width: uint24(view, 24) + 1,
      height: uint24(view, 27) + 1,
    };
  }

  return null;
}

function uint24(view: DataView, at: number): number {
  return view.getUint8(at) |
    (view.getUint8(at + 1) << 8) |
    (view.getUint8(at + 2) << 16);
}

function ascii(view: DataView, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(at + i));
  return out;
}
