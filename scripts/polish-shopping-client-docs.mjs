import { readFile, writeFile, unlink } from "node:fs/promises";

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing ${label}`);
  return text.replace(before, after);
}

let screens = await readFile("docs/codebase/screens.md", "utf8");
screens = replaceRequired(
  screens,
  `still the form it was: without\nJavaScript the row's button still navigates`,
  `still the form it was: without JavaScript the row's button still navigates`,
  "no-JavaScript sentence",
);
screens = replaceRequired(
  screens,
  `and the\n  island drops any answer that does not match what the row is currently asking`,
  `and the\n  shopping client drops any answer that does not match what the row is currently asking`,
  "prefetch client reference",
);
screens = replaceRequired(
  screens,
  `- **Product choice happens in a panel inside the row**, so choosing a product\n  is not a page navigation and coming back is not a page load. (Inside the row\n  is the part #200 takes back below — the panel is what made the list move.)`,
  `- **Product choice is an enhancement, not a navigation.** The current fixed\n  sheet described under #200 opens without replacing the server-rendered row, so\n  choosing a product is not a page navigation and coming back is not a page load.`,
  "picker location description",
);
await writeFile("docs/codebase/screens.md", screens);

await unlink("scripts/polish-shopping-client-docs.mjs");
await unlink(".github/workflows/polish-shopping-client-docs.yml");
