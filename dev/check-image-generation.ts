import assert from "node:assert/strict";
import test from "node:test";

import { MAX_CELLS } from "../src/contact-sheet.ts";
import type { Env } from "../src/env.ts";
import {
  dishBrief,
  generateContactSheet,
  GENERATED_BY,
  GenerationError,
  sheetPrompt,
  STYLE_VERSION,
} from "../src/image-generation.ts";
import type { FingerprintRecipe } from "../src/recipe-fingerprint.ts";

/**
 * The prompt and the brief, checked here rather than by calling the model.
 *
 * Three things in the prompt are load-bearing, and all three are silent
 * failures if they break: a grid that stops being sixteen cells moves every
 * cell a recipe was mapped to, rendered text gives a positional mapping
 * something to be misread against, and a brief that lost a multipart dish's
 * parts describes an empty plate. None of those would make the request fail —
 * they would make it succeed and be wrong, having spent the money.
 */

function line(ingredient: string) {
  return {
    ingredient,
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
  };
}

function recipe(
  title: string,
  ingredients: string[],
  parts: FingerprintRecipe["parts"] = [],
): FingerprintRecipe {
  return { title, lines: ingredients.map(line), parts };
}

test("the prompt always asks for sixteen cells, whatever the batch size", () => {
  for (const count of [1, 3, 16]) {
    const dishes = Array.from({ length: count }, (_, at) =>
      dishBrief(at + 1, recipe(`Ruoka ${at + 1}`, ["peruna"])),
    );
    const prompt = sheetPrompt(dishes);

    assert.match(prompt, /exactly 16 food illustrations/, `${count} dishes`);
    assert.match(prompt, /4-column by 4-row grid/, `${count} dishes`);
    assert.match(prompt, new RegExp(`Cell ${count}: Ruoka ${count}`), `${count} dishes`);
    assert.doesNotMatch(prompt, new RegExp(`Cell ${count + 1}:`), `${count} dishes`);
  }
});

test("a partial batch says the rest must be left empty and not rearranged", () => {
  const prompt = sheetPrompt([dishBrief(1, recipe("Kaalilaatikko", ["kaali"]))]);
  assert.match(prompt, /Cells 2 to 16 are unused/);
  assert.match(prompt, /completely empty and fully transparent/);
  assert.match(prompt, /do not rearrange the used cells/);
});

test("a full batch does not talk about unused cells", () => {
  const dishes = Array.from({ length: MAX_CELLS }, (_, at) =>
    dishBrief(at + 1, recipe(`Ruoka ${at + 1}`, ["peruna"])),
  );
  assert.match(sheetPrompt(dishes), /All sixteen cells are used/);
});

test("the prompt forbids text and asks for the gutters the splitter needs", () => {
  const prompt = sheetPrompt([dishBrief(1, recipe("Uunikaali", ["kaali"]))]);
  assert.match(prompt, /no text, no numbers, no labels/);
  assert.match(prompt, /fully transparent background/);
  assert.match(prompt, /generous fully transparent gutters/);
  assert.match(prompt, /never touching or crossing the cell boundary/);
  assert.match(prompt, /may overlap or touch another cell's dish/);
});

test("a brief is the dish's own title and ingredients", () => {
  const brief = dishBrief(7, recipe("  Uunikaali  ", ["kaali", "riisi", "maito"]));
  assert.deepEqual(brief, {
    recipeId: 7,
    title: "Uunikaali",
    ingredients: ["kaali", "riisi", "maito"],
  });
});

test("a multipart dish's parts are in its brief", () => {
  const brief = dishBrief(
    3,
    recipe("Lasagne", ["lasagnelevy"], [
      recipe("Jauhelihakastike", ["jauheliha", "tomaatti"]),
      recipe("Juustokastike", ["juusto", "maito"]),
    ]),
  );
  assert.deepEqual(brief.ingredients, [
    "lasagnelevy",
    "jauheliha",
    "tomaatti",
    "juusto",
    "maito",
  ]);
});

test("an ingredient named twice is described once", () => {
  const brief = dishBrief(
    4,
    recipe("Kastike", ["Maito", "voi"], [recipe("Pohja", ["maito", "jauho"])]),
  );
  assert.deepEqual(brief.ingredients, ["Maito", "voi", "jauho"]);
});

test("a long ingredient list is cut down, not pasted whole", () => {
  const many = Array.from({ length: 30 }, (_, at) => `aines-${at}`);
  assert.equal(dishBrief(5, recipe("Iso", many)).ingredients.length, 8);
});

test("a dish with no ingredients still gets a usable brief", () => {
  const prompt = sheetPrompt([dishBrief(6, recipe("Pannukakku", []))]);
  assert.match(prompt, /Cell 1: Pannukakku — no ingredient list available/);
});

test("a batch bigger than a sheet is a programming error", () => {
  const dishes = Array.from({ length: MAX_CELLS + 1 }, (_, at) =>
    dishBrief(at + 1, recipe("Ruoka", ["peruna"])),
  );
  assert.throws(() => sheetPrompt(dishes), RangeError);
  assert.throws(() => sheetPrompt([]), RangeError);
});

test("what gets stored names the provider, the model and the style version", () => {
  assert.equal(GENERATED_BY, `openai:gpt-image-2/${STYLE_VERSION}`);
});

/**
 * How a paid request fails, checked with the network replaced rather than
 * called. Every one of these has to come back as a `GenerationError` carrying
 * something a caller can read: the route turns it into a 502 and nothing is
 * stored, so a failure that arrived as a bare crash would be a 500 with no
 * explanation and the same amount of money spent.
 */

const DISHES = [dishBrief(1, recipe("Kaalilaatikko", ["kaali"]))];

/** Run one generation against a canned reply. Restores `fetch` afterwards. */
async function against(
  reply: Response | (() => never),
  env: Partial<Env> = { OPENAI_API_KEY: "test-key-not-a-real-one" },
): Promise<unknown> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (typeof reply === "function") reply();
    return reply;
  }) as typeof fetch;
  try {
    return await generateContactSheet(env as Env, DISHES);
  } finally {
    globalThis.fetch = real;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("without a key, nothing is requested and nothing is spent", async () => {
  let called = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return json({});
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => generateContactSheet({} as Env, DISHES),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.match((error as Error).message, /not configured/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(called, false, "a keyless deployment must not call out at all");
});

test("the provider's own explanation is passed on, and only that", async () => {
  await assert.rejects(
    () => against(json({ error: { message: "Your quota is exhausted." } }, 429)),
    (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.match((error as Error).message, /answered 429/);
      assert.match((error as Error).message, /quota is exhausted/);
      // Not the key, and not the prompt.
      assert.doesNotMatch((error as Error).message, /test-key/);
      assert.doesNotMatch((error as Error).message, /Kaalilaatikko/);
      return true;
    },
  );
});

test("an error page instead of JSON does not become a crash", async () => {
  await assert.rejects(
    () => against(new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    /No explanation was given/,
  );
});

test("a success that carries no image is a failure", async () => {
  await assert.rejects(() => against(json({ data: [] })), /returned no image/);
  await assert.rejects(() => against(json({})), /returned no image/);
  await assert.rejects(() => against(json({ data: [{}] })), /returned no image/);
});

test("a reply that is not JSON at all is a failure", async () => {
  await assert.rejects(
    () => against(new Response("nonsense", { status: 200 })),
    /not JSON/,
  );
});

test("an image that is not base64 is a failure, not a mangled PNG", async () => {
  await assert.rejects(
    () => against(json({ data: [{ b64_json: "!!! not base64 !!!" }] })),
    /cannot decode/,
  );
});

test("a reply that declares more than we will read is refused unread", async () => {
  const oversized = new Response("{}", {
    status: 200,
    headers: { "content-length": String(64 * 1024 * 1024) },
  });
  await assert.rejects(() => against(oversized), /more data than we will read/);
});

test("a request that never answers is a failure with a duration in it", async () => {
  await assert.rejects(
    () =>
      against(() => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    /no answer within 180 seconds/,
  );
});

test("a network that is simply not there is a failure", async () => {
  await assert.rejects(
    () =>
      against(() => {
        throw new TypeError("fetch failed");
      }),
    /could not be made/,
  );
});
