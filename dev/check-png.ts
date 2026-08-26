import assert from "node:assert/strict";
import test from "node:test";

import { decodePng, encodePng, PngError, type Raster } from "../src/png.ts";
import { blank, disc, rawPng } from "./support/sheet.ts";

/**
 * The PNG codec is checked directly because everything above it trusts it
 * completely: the splitter reads whatever alpha this hands back, and a decoder
 * that quietly mangled a scanline would produce crops that look plausible and
 * are wrong. A browser test would only ever feed it well-formed images from one
 * encoder, and would agree with a decoder that only handled that one.
 */

function rgba(width: number, height: number): Raster {
  const sheet = blank(width, height);
  // Something with edges, gradients and transparency in it, so a filter that
  // predicts badly shows up as a difference rather than as a lucky match.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      sheet.data[at] = (x * 7) & 0xff;
      sheet.data[at + 1] = (y * 5) & 0xff;
      sheet.data[at + 2] = ((x + y) * 3) & 0xff;
      sheet.data[at + 3] = x < 3 ? 0 : 255;
    }
  }
  disc(sheet, width / 2, height / 2, Math.min(width, height) / 3, [10, 200, 90]);
  return sheet;
}

test("pixels survive a round trip exactly", async () => {
  const source = rgba(37, 23);
  const decoded = await decodePng(await encodePng(source));

  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 23);
  assert.deepEqual([...decoded.data], [...source.data]);
});

test("a one-pixel image is still a PNG", async () => {
  const one: Raster = { width: 1, height: 1, data: new Uint8Array([9, 8, 7, 6]) };
  const decoded = await decodePng(await encodePng(one));
  assert.deepEqual([...decoded.data], [9, 8, 7, 6]);
});

test("every scanline filter decodes to the same pixels", async () => {
  const width = 6;
  const height = 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < pixels.length; at += 1) pixels[at] = (at * 11) & 0xff;

  // Filter 0 is the unfiltered baseline, so a filter that undoes wrongly
  // differs from it. Filters 1-4 are written by hand here because the encoder
  // picks one per row and would never exercise all five on the same pixels.
  const expected = await decodePng(
    rawPng({ width, height, colourType: 6, pixels, filter: 0 }),
  );

  for (const filter of [1, 2, 3, 4]) {
    const filtered = new Uint8Array(pixels.length);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < rowBytes; x += 1) {
        const value = pixels[y * rowBytes + x]!;
        const left = x >= 4 ? pixels[y * rowBytes + x - 4]! : 0;
        const up = y > 0 ? pixels[(y - 1) * rowBytes + x]! : 0;
        const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * rowBytes + x - 4]! : 0;
        filtered[y * rowBytes + x] = predict(filter, value, left, up, upLeft);
      }
    }

    const decoded = await decodePng(
      rawPng({ width, height, colourType: 6, pixels: filtered, filter }),
    );
    assert.deepEqual([...decoded.data], [...expected.data], `filter ${filter}`);
  }
});

function predict(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 1) return (value - left) & 0xff;
  if (filter === 2) return (value - up) & 0xff;
  if (filter === 3) return (value - ((left + up) >> 1)) & 0xff;
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  const guess = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
  return (value - guess) & 0xff;
}

test("colour types without an alpha channel decode as opaque", async () => {
  const grey = await decodePng(
    rawPng({ width: 2, height: 1, colourType: 0, pixels: new Uint8Array([40, 200]) }),
  );
  assert.deepEqual([...grey.data], [40, 40, 40, 255, 200, 200, 200, 255]);

  const colour = await decodePng(
    rawPng({
      width: 2,
      height: 1,
      colourType: 2,
      pixels: new Uint8Array([1, 2, 3, 4, 5, 6]),
    }),
  );
  assert.deepEqual([...colour.data], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("greyscale with alpha keeps its alpha", async () => {
  const decoded = await decodePng(
    rawPng({
      width: 2,
      height: 1,
      colourType: 4,
      pixels: new Uint8Array([90, 0, 90, 255]),
    }),
  );
  assert.deepEqual([...decoded.data], [90, 90, 90, 0, 90, 90, 90, 255]);
});

test("a palette PNG takes its transparency from tRNS", async () => {
  const decoded = await decodePng(
    rawPng({
      width: 3,
      height: 1,
      colourType: 3,
      pixels: new Uint8Array([0, 1, 2]),
      palette: new Uint8Array([10, 10, 10, 20, 20, 20, 30, 30, 30]),
      paletteAlpha: new Uint8Array([0, 128]),
    }),
  );

  // Index 0 transparent, index 1 half, index 2 has no tRNS entry so it is opaque.
  assert.deepEqual([...decoded.data], [
    10, 10, 10, 0,
    20, 20, 20, 128,
    30, 30, 30, 255,
  ]);
});

test("what the decoder refuses, it refuses by name", async () => {
  const cases: [string, Uint8Array, RegExp][] = [
    [
      "not a PNG at all",
      new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]),
      /Not a PNG/,
    ],
    [
      "sixteen bits a channel",
      rawPng({ width: 1, height: 1, depth: 16, colourType: 6, pixels: new Uint8Array(8) }),
      /16 bits per channel/,
    ],
    [
      "interlaced",
      rawPng({ width: 1, height: 1, colourType: 6, interlace: 1, pixels: new Uint8Array(4) }),
      /interlaced/,
    ],
    [
      "a colour type that does not exist",
      rawPng({ width: 1, height: 1, colourType: 5, pixels: new Uint8Array(4) }),
      /colour type 5/,
    ],
    [
      "no pixels",
      rawPng({ width: 0, height: 1, colourType: 6, pixels: new Uint8Array(0) }),
      /no pixels/,
    ],
    [
      "no image data",
      rawPng({ width: 1, height: 1, colourType: 6, pixels: new Uint8Array(4), omitData: true }),
      /no image data/,
    ],
    [
      "a filter that is not defined",
      rawPng({ width: 1, height: 1, colourType: 6, pixels: new Uint8Array(4), filter: 9 }),
      /filter 9/,
    ],
    [
      "less image data than it claims",
      rawPng({ width: 8, height: 8, colourType: 6, pixels: new Uint8Array(4) }),
      /truncated/,
    ],
    [
      "a palette it does not carry",
      rawPng({ width: 1, height: 1, colourType: 3, pixels: new Uint8Array([0]) }),
      /no palette/,
    ],
  ];

  for (const [what, bytes, expected] of cases) {
    await assert.rejects(
      () => decodePng(bytes),
      (error: unknown) => {
        assert.ok(error instanceof PngError, `${what}: ${error}`);
        assert.match((error as Error).message, expected, what);
        return true;
      },
      what,
    );
  }
});

test("a header claiming more pixels than we will hold is refused", async () => {
  await assert.rejects(
    () => decodePng(rawPng({ width: 40000, height: 40000, colourType: 6, pixels: new Uint8Array(4) })),
    /too large/,
  );
});

test("the encoder refuses a pixel buffer that does not match its size", async () => {
  await assert.rejects(
    () => encodePng({ width: 4, height: 4, data: new Uint8Array(8) }),
    /does not match/,
  );
});
