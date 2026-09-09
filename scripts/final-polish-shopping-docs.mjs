import { readFile, writeFile, unlink } from "node:fs/promises";

let docs = await readFile("docs/codebase/screens.md", "utf8");
docs = docs
  .replace(
    "  client sets `details.open = false` in `persist`'s success branch, so the\npicture is\n",
    "  client sets `details.open = false` in `persist`'s success branch, so the\n  picture is\n",
  )
  .replace(
    "  answer carries the same fact as `synced: false` so the shopping client can say it\n  too.",
    "  answer carries the same fact as `synced: false` so the shopping client can\n  say it too.",
  )
  .replace(
    "  hidden), the shopping client moves that element into the sheet on open and puts it\n  back on close.",
    "  hidden), the shopping client moves that element into the sheet on open and\n  puts it back on close.",
  )
  .replace(
    "  that arithmetic is the server's — so the shopping client sets the hash to the row's\n  anchor before reloading",
    "  that arithmetic is the server's — so the shopping client sets the hash to the\n  row's anchor before reloading",
  );
await writeFile("docs/codebase/screens.md", docs);

let screen = await readFile("src/shopping-screens.ts", "utf8");
screen = screen
  .replace(
    " * where there is a browser to fill it, so there is no screen to re-render on a refusal: the\n * answer is JSON on both paths.",
    " * where there is a browser to fill it, so there is no screen to re-render on a\n * refusal: the answer is JSON on both paths.",
  )
  .replace(
    " * The typed shopping client shows the choice before this answer arrives, so a\n * refusal has to\n * be sayable to it.",
    " * The typed shopping client shows the choice before this answer arrives, so a\n * refusal has to be sayable to it.",
  );
await writeFile("src/shopping-screens.ts", screen);

await unlink("scripts/final-polish-shopping-docs.mjs");
await unlink(".github/workflows/final-polish-shopping-docs.yml");
