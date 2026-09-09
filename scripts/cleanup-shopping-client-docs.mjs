import { readFile, writeFile, unlink } from "node:fs/promises";

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing ${label}`);
  return text.replace(before, after);
}

let claude = await readFile("CLAUDE.md", "utf8");
claude = replaceRequired(
  claude,
  `- **Hand-written inline browser scripts are shipped untranspiled.** Intake and\n  the image splitter use the typed-client pipeline; run \`generate:client\` after\n  changes there. For remaining template-string islands, write ES5 and remember\n  that these scripts are template literals, so a backslash is eaten before the\n  browser ever sees it — no regular expressions. See\n  [screens](docs/codebase/screens.md).`,
  `- **Browser code has two paths.** Intake, shopping, and the recipe-image\n  splitter live under \`src/client/\` and are DOM-typechecked and generated into\n  committed \`src/generated/\` modules; run \`generate:client\` after changes\n  there, and \`check:client\` rejects stale output. Remaining hand-written\n  template-string islands are shipped untranspiled: write ES5 there and remember\n  that a backslash is eaten before the browser sees it. See\n  [screens](docs/codebase/screens.md).`,
  "CLAUDE browser-code guidance",
);
await writeFile("CLAUDE.md", claude);

let screens = await readFile("docs/codebase/screens.md", "utf8");
const start = screens.indexOf("### Making that half feel immediate (issue #159)");
const end = screens.indexOf("## The cupboard", start);
if (start < 0 || end < 0) throw new Error("shopping docs section markers missing");
let shopping = screens.slice(start, end);
shopping = replaceRequired(
  shopping,
  `This pull request proposes an inline script island,\n\`shopping-screens.ts::SHOPPING_ISLAND\`, on top of everything above — not\ninstead of it. Every form on the screen is still the form it was: without`,
  `The optional enhancement now lives in \`src/client/shopping.ts\`, is\nDOM-typechecked by \`tsconfig.client.json\`, and is generated into the committed\n\`src/generated/shopping.ts\` bundle embedded by \`shopping-screens.ts\`. It sits\non top of everything above — not instead of it. Every form on the screen is\nstill the form it was: without`,
  "shopping client section opening",
);
shopping = replaceRequired(
  shopping,
  `The island follows the same discipline as the other three: ES5, no regular\nexpressions, feature-detected (it does nothing at all without \`XMLHttpRequest\`,\n\`JSON\` or \`addEventListener\`), and it builds every node with \`createElement\`\nand \`createTextNode\` so a product name from the shop can never become markup.`,
  `The typed source is bundled to the same ES5 browser floor through\n\`scripts/build-client.mjs\` and remains feature-detected (it does nothing at all\nwithout \`XMLHttpRequest\`, \`JSON\` or \`addEventListener\`). It still builds\nevery node with \`createElement\` and \`createTextNode\`, so a product name from\nthe shop can never become markup. Unlike the old server template string, the\nsource may use ordinary TypeScript syntax because escaping/transpilation belongs\nto the client build rather than to \`shopping-screens.ts\`.`,
  "shopping client build discipline",
);
shopping = shopping.replaceAll("The island", "The shopping client");
shopping = shopping.replaceAll("the island", "the shopping client");
screens = screens.slice(0, start) + shopping + screens.slice(end);
await writeFile("docs/codebase/screens.md", screens);

let shoppingScreen = await readFile("src/shopping-screens.ts", "utf8");
shoppingScreen = shoppingScreen.replaceAll("the island", "the typed shopping client");
shoppingScreen = shoppingScreen.replaceAll("The island", "The typed shopping client");
await writeFile("src/shopping-screens.ts", shoppingScreen);

await unlink("scripts/cleanup-shopping-client-docs.mjs");
await unlink(".github/workflows/cleanup-shopping-client-docs.yml");
