import { readFile, writeFile, unlink } from "node:fs/promises";

function required(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing ${label}`);
  return text.replace(before, after);
}

let screen = await readFile("src/shopping-screens.ts", "utf8");
screen = required(
  screen,
  ` * \`GET /ostoslista/haku?haku=…\` — the same catalogue search the product screen\n * runs, as JSON, so the typed shopping client can search inside the row and warm the next\n * row's search before anybody asks for it.`,
  ` * \`GET /ostoslista/haku?haku=…\` — the same catalogue search the product screen\n * runs as JSON, so the typed shopping client can search in its fixed sheet and\n * warm the next row's search before anybody asks for it.`,
  "product search comment",
);
screen = screen
  .replace(
    ` * The panel this serves is drawn by the typed shopping client and exists only where there is\n * a browser to fill it`,
    ` * The panel this serves is drawn by the typed shopping client and exists only\n * where there is a browser to fill it`,
  )
  .replace(
    `/** The typed shopping client asks for JSON with a field, so one route serves both callers. */`,
    `/** The typed shopping client asks for JSON, so one route serves both callers. */`,
  )
  .replace(
    ` * The typed shopping client shows the choice before this answer arrives, so a refusal has to`,
    ` * The typed shopping client shows the choice before this answer arrives, so a\n * refusal has to`,
  )
  .replace(
    ` * These numbers pair with the sizes in \`html.ts\` and are handed to the typed shopping client\n * below`,
    ` * These numbers pair with the sizes in \`html.ts\` and are handed to the typed\n * shopping client below`,
  )
  .replace(
    ` * The scope choice, drawn by the server and hidden, for the typed shopping client to lift into\n * its panel.`,
    ` * The scope choice, drawn by the server and hidden, for the typed shopping\n * client to lift into its panel.`,
  )
  .replace(
    ` * plainly that there is nothing to add a size to yet, and the typed shopping client only has to\n * enable it.`,
    ` * plainly that there is nothing to add a size to yet, and the typed shopping\n * client only has to enable it.`,
  );
await writeFile("src/shopping-screens.ts", screen);

let docs = await readFile("docs/codebase/screens.md", "utf8");
docs = docs
  .replace(
    `\`/ostoslista/tuote\`, the send form still posts, and the only thing missing is the panel a browser has to\nfill. Three JSON answers serve the shopping client, and two of them are new routes:`,
    `\`/ostoslista/tuote\`, the send form still posts, and the only thing missing is\nthe panel a browser has to fill. Three JSON answers serve the shopping client,\nand two of them are new routes:`,
  )
  .replace(
    `client sets \`details.open = false\` in \`persist\`'s success branch, so the picture is\n`,
    `client sets \`details.open = false\` in \`persist\`'s success branch, so the\npicture is\n`,
  )
  .replace(
    `sheet described under #200 opens without replacing the server-rendered row, so\n  choosing a product is not a page navigation and coming back is not a page load.`,
    `sheet described under #200 opens without replacing the server-rendered row,\n  so choosing a product is not a page navigation and coming back is not a page\n  load.`,
  )
  .replace(
    `client and appended to \`<body>\` rather than into a row. It is \`position: fixed\`, so\n`,
    `client and appended to \`<body>\` rather than into a row. It is\n  \`position: fixed\`, so\n`,
  );
await writeFile("docs/codebase/screens.md", docs);

await unlink("scripts/review-fix-shopping-docs.mjs");
await unlink(".github/workflows/review-fix-shopping-docs.yml");
