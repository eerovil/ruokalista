import { readFile, writeFile, unlink } from "node:fs/promises";

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing ${label}`);
  return text.replace(before, after);
}

let screen = await readFile("src/shopping-screens.ts", "utf8");
screen = replaceRequired(
  screen,
  ` * the form it was, and a browser that cannot run the optional shopping client still\n * navigates to \`/ostoslista/tuote\`, still posts the send form, and simply never\n * sees the current S-ostoslista panel. What the typed shopping client adds is the product\n * search in a panel inside the row, an optimistic selection saved in the\n * background, a spinner on everything asynchronous, and the contents of the`,
  ` * the form it was, and a browser that cannot run the optional shopping client\n * still navigates to \`/ostoslista/tuote\`, still posts the send form, and simply\n * never sees the current S-ostoslista panel. What the typed shopping client adds\n * is the fixed product sheet, an optimistic selection saved in the background,\n * a spinner on everything asynchronous, and the contents of the`,
  "shopping screen enhancement comment",
);
await writeFile("src/shopping-screens.ts", screen);

let docs = await readFile("docs/codebase/screens.md", "utf8");
docs = docs
  .replace(
    `still the form it was: without JavaScript the row's button still navigates to \`/ostoslista/tuote\`, the send\nform still posts`,
    `still the form it was: without JavaScript the row's button still navigates to\n\`/ostoslista/tuote\`, the send form still posts`,
  )
  .replace(
    `finishing one ingredient and having to hunt for where they were. The shopping client\n  sets`,
    `finishing one ingredient and having to hunt for where they were. The shopping\n  client sets`,
  )
  .replace(
    `shopping client drops any answer that does not match what the row is currently asking\n  —`,
    `shopping client drops any answer that does not match what the row is currently\n  asking —`,
  )
  .replace(
    `answer carries the same fact as \`synced: false\` so the shopping client can say it too.`,
    `answer carries the same fact as \`synced: false\` so the shopping client can say it\n  too.`,
  )
  .replace(
    `- **The picker is one fixed sheet** (\`.s-sheet\`), built once by the shopping client and\n  appended`,
    `- **The picker is one fixed sheet** (\`.s-sheet\`), built once by the shopping\n  client and appended`,
  )
  .replace(
    `hidden), the shopping client moves that element into the sheet on open and puts it back\n  on close.`,
    `hidden), the shopping client moves that element into the sheet on open and puts it\n  back on close.`,
  )
  .replace(
    `the name ellipsised away the very thing somebody is shopping for. The shopping client's\n  \`showProduct\``,
    `the name ellipsised away the very thing somebody is shopping for. The shopping\n  client's \`showProduct\``,
  )
  .replace(
    `\`.s-status\` on every mapped-capable row and the shopping client only fills and empties\n  it.`,
    `\`.s-status\` on every mapped-capable row and the shopping client only fills and\n  empties it.`,
  );
await writeFile("docs/codebase/screens.md", docs);

await unlink("scripts/finalize-shopping-client-docs.mjs");
await unlink(".github/workflows/finalize-shopping-client-docs.yml");
