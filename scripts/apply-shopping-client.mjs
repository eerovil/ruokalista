import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, unlink, writeFile } from "node:fs/promises";

const parts = [1, 2, 3, 4].map((number) =>
  `scripts/.shopping-client.part${number}`,
);
const encoded = (
  await Promise.all(parts.map((path) => readFile(path, "utf8")))
).map((part) => part.trim()).join("");
const shoppingSource = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
const sourceDigest = createHash("sha256").update(shoppingSource).digest("hex");
if (sourceDigest !== "ded3a97774058eb0f4661b78ebef581d2108d8362adf678f75e34f28b62c1fb9") {
  throw new Error(`shopping source digest mismatch: ${sourceDigest}`);
}
await writeFile("src/client/shopping.ts", shoppingSource);

const path = "src/shopping-screens.ts";
let source = await readFile(path, "utf8");

if (!source.includes('import shoppingClient from "./generated/shopping.ts";')) {
  source = source.replace(
    'import { problem } from "./auth.ts";\n',
    'import { problem } from "./auth.ts";\nimport shoppingClient from "./generated/shopping.ts";\n',
  );
}

source = source.replace(
  'a browser that cannot run `SHOPPING_ISLAND` still',
  'a browser that cannot run the optional shopping client still',
);
source = source.replace(
  '${external ? html`<script>${raw(SHOPPING_ISLAND)}</script>` : ""}',
  '${external ? html`<script>${raw(shoppingClient)}</script>` : ""}',
);
source = source.replace(
  '<section class="s-shopping-send" aria-labelledby="s-shopping-title">',
  '<section class="s-shopping-send" aria-labelledby="s-shopping-title" data-product-picture="${JSON.stringify(PRODUCT_PICTURE)}">',
);

const startMarker = '/**\n * Everything #159 asks the browser to do, in one island.';
const endMarker = '/**\n * The one thing a shopping-list row can be told:';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0 || end <= start) {
  throw new Error("shopping island markers were not found");
}
source = source.slice(0, start) + source.slice(end);
await writeFile(path, source);

for (const temporary of [
  ...parts,
  "scripts/apply-shopping-client.mjs",
  ".github/workflows/prepare-shopping-client.yml",
]) {
  await unlink(temporary);
}
