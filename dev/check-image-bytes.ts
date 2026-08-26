import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { extensionFor, readImage } from "../src/image-bytes.ts";

/**
 * The signature reader is what decides whether bytes are stored at all, so it
 * is checked directly rather than through a browser: a browser test always
 * sends a real image and would agree with an implementation that just said yes.
 */

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([head, typed, crc]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG with one comment segment before the frame header, as cameras write. */
function jpeg(width: number, height: number, sofMarker = 0xffc0): Buffer {
  const comment = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0x08]),
    Buffer.from("ruoka!", "ascii"),
  ]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(sofMarker, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, sof]);
}

function webpLossy(width: number, height: number): Buffer {
  const out = Buffer.alloc(30);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(22, 4);
  out.write("WEBP", 8, "ascii");
  out.write("VP8 ", 12, "ascii");
  out.writeUInt32LE(10, 16);
  out[23] = 0x9d;
  out[24] = 0x01;
  out[25] = 0x2a;
  out.writeUInt16LE(width, 26);
  out.writeUInt16LE(height, 28);
  return out;
}

function facts(bytes: Buffer) {
  return readImage(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

test("a PNG is identified and measured from its header", () => {
  assert.deepEqual(facts(png(1600, 900)), {
    contentType: "image/png",
    width: 1600,
    height: 900,
  });
});

test("a JPEG is measured past the segments in front of its frame header", () => {
  assert.deepEqual(facts(jpeg(640, 480)), {
    contentType: "image/jpeg",
    width: 640,
    height: 480,
  });
});

test("every frame marker that states a size is read, not just the common one", () => {
  // 0xc2 is progressive and 0xc9 is arithmetic-coded. Both are JPEGs, and both
  // carry their size in the same place as the baseline 0xc0.
  for (const marker of [0xffc0, 0xffc1, 0xffc2, 0xffc9, 0xffcb]) {
    assert.deepEqual(
      facts(jpeg(1024, 768, marker)),
      { contentType: "image/jpeg", width: 1024, height: 768 },
      `marker ${marker.toString(16)}`,
    );
  }

  // The three in that range that state no size are not frames, so a file whose
  // only such marker is one of them is not measurable.
  for (const marker of [0xffc4, 0xffc8, 0xffcc]) {
    assert.equal(facts(jpeg(1024, 768, marker)), null, `marker ${marker.toString(16)}`);
  }
});

test("a lossy WebP is identified and measured", () => {
  assert.deepEqual(facts(webpLossy(300, 200)), {
    contentType: "image/webp",
    width: 300,
    height: 200,
  });
});

test("the type a caller claims is not what decides", () => {
  // The whole point: this is what an upload declaring image/png really is.
  const html = Buffer.from("<html><script>alert(1)</script></html>", "ascii");
  assert.equal(facts(html), null);
});

test("bytes that are not an image at all are refused", () => {
  assert.equal(facts(Buffer.alloc(0)), null);
  assert.equal(facts(Buffer.from("GIF89a", "ascii")), null);
  // A PNG signature with nothing behind it is not a PNG.
  assert.equal(
    facts(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    null,
  );
});

test("the stored extension follows the type the bytes proved", () => {
  assert.equal(extensionFor("image/jpeg"), "jpg");
  assert.equal(extensionFor("image/png"), "png");
  assert.equal(extensionFor("image/webp"), "webp");
});
