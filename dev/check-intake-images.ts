import assert from "node:assert/strict";
import test from "node:test";

import { readImages } from "../src/intake-jobs.ts";
import { MAX_IMAGES, requestFor, type IntakeSource } from "../src/intake.ts";

/**
 * What a photographed import actually asks the model, for one page and for
 * several (#156).
 *
 * A recipe printed across a spread is one dish, and the only thing standing
 * between that and two half-recipes is the wording of this request: the pages
 * in the order the member chose them, labelled so the model can tell them
 * apart, and a standing rule saying they make one recipe. None of that is
 * visible from the outside without spending on a real call, so it is checked
 * here instead — the API key has a small balance and this costs nothing.
 */

const NO_INGREDIENTS: [] = [];

function contentOf(source: IntakeSource) {
  return requestFor(source, NO_INGREDIENTS).messages[0].content;
}

function systemOf(source: IntakeSource) {
  return requestFor(source, NO_INGREDIENTS).system;
}

function page(label: string) {
  return { base64: label, mediaType: "image/jpeg" };
}

test("pasted text is handed over as text, not as content blocks", () => {
  const content = contentOf({ route: "pasted", text: "Uunikaali\n½ dl öljyä" });

  assert.equal(content, "Uunikaali\n½ dl öljyä");
});

test("one page is worded exactly as it was before pages were plural", () => {
  const content = contentOf({
    route: "photographed",
    images: [page("sivu-1")],
  });

  assert.deepEqual(content, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "sivu-1" },
    },
    { type: "text", text: "Jäsennä tämän sivun resepti." },
  ]);
});

test("several pages arrive in order, each announced before its picture", () => {
  const content = contentOf({
    route: "photographed",
    images: [page("sivu-1"), page("sivu-2"), page("sivu-3")],
  });

  assert.deepEqual(
    content.map((block) =>
      block.type === "image" ? `image:${block.source.data}` : block.text,
    ),
    [
      "Sivu 1/3:",
      "image:sivu-1",
      "Sivu 2/3:",
      "image:sivu-2",
      "Sivu 3/3:",
      "image:sivu-3",
      "Jäsennä näiden 3 sivun resepti. Sivut ovat saman reseptin osia annetussa järjestyksessä.",
    ],
  );
});

test("a single page is not told it is one of several", () => {
  const system = systemOf({ route: "photographed", images: [page("sivu-1")] });

  assert.ok(system.includes("Kuvatun sivun lisäsäännöt"));
  assert.ok(!system.includes("Monisivuisen reseptin lisäsäännöt"));
});

test("several pages are told they make one recipe, in the given order", () => {
  const system = systemOf({
    route: "photographed",
    images: [page("sivu-1"), page("sivu-2")],
  });

  assert.ok(system.includes("Monisivuisen reseptin lisäsäännöt"));
  assert.ok(system.includes("täsmälleen yksi resepti"));
  assert.ok(system.includes("siinä järjestyksessä kuin ne on"));
});

test("pasted text gets neither set of photograph rules", () => {
  const system = systemOf({ route: "pasted", text: "Uunikaali" });

  assert.ok(!system.includes("Kuvatun sivun lisäsäännöt"));
  assert.ok(!system.includes("Monisivuisen reseptin lisäsäännöt"));
});

test("the pages arrive off the wire in the order they were sent", () => {
  const images = readImages({
    images: [
      { image: "a", mediaType: "image/jpeg" },
      { image: "b", mediaType: "image/png" },
      { image: "c" },
    ],
  });

  assert.deepEqual(images, [
    { base64: "a", mediaType: "image/jpeg" },
    { base64: "b", mediaType: "image/png" },
    { base64: "c", mediaType: "image/jpeg" },
  ]);
});

test("a single-image body from a cached older client still reads", () => {
  // Ruokalista is an installable PWA, so a browser can be running yesterday's
  // island. Its one-photo import must not become a 400 overnight.
  assert.deepEqual(readImages({ image: "a", mediaType: "image/jpeg" }), [
    { base64: "a", mediaType: "image/jpeg" },
  ]);
});

test("nothing usable reads as no pages at all", () => {
  assert.deepEqual(readImages({}), []);
  assert.deepEqual(readImages({ image: "" }), []);
  assert.deepEqual(readImages({ images: [] }), []);
  assert.deepEqual(readImages({ images: [{ mediaType: "image/jpeg" }] }), []);
  assert.deepEqual(readImages({ images: [null, 7, "a"] }), []);
});

test("the page cap leaves room for a spread and then some", () => {
  // The case this exists for is a recipe over two facing pages; the cap is a
  // guard against a runaway multi-select, not a limit anybody should meet.
  assert.ok(MAX_IMAGES >= 2);
  assert.ok(Number.isSafeInteger(MAX_IMAGES));
});
