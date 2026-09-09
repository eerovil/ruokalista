import { readFile, writeFile, unlink } from "node:fs/promises";

const path = "src/shopping-screens.ts";
let source = await readFile(path, "utf8");
const before = `  /**\n   * The typed shopping client shows the choice before this answer arrives, so a\n * refusal has to\n   * be sayable to it.`;
const after = `  /**\n   * The typed shopping client shows the choice before this answer arrives, so a\n   * refusal has to be sayable to it.`;
if (!source.includes(before)) throw new Error("expected malformed comment not found");
source = source.replace(before, after);
await writeFile(path, source);
await unlink("scripts/fix-shopping-comment-indent.mjs");
await unlink(".github/workflows/fix-shopping-comment-indent.yml");
