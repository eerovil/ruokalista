import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Give the browser suite the values it cannot run without.
 *
 * Two specs need Google to be configured — the sign-in screen only offers the
 * Google link when it is, and `/auth/google` only redirects when it is. A fresh
 * checkout copies `.dev.vars.example`, whose `GOOGLE_CLIENT_ID` and
 * `GOOGLE_CLIENT_SECRET` are empty, so the first local run failed those two and
 * had to be started again with values pasted in. CI never had that problem: it
 * writes harmless placeholders before it runs the suite. This does the same
 * thing locally.
 *
 * They are placeholders, not credentials. Nothing in the suite talks to Google
 * — the tests check the redirect this app builds, not what Google does with it.
 *
 * Only blanks are filled. A real client id already in `.dev.vars`, because
 * somebody signs in with Google locally, is left exactly as it was, and
 * `ANTHROPIC_API_KEY` is never touched: a browser test that reached Anthropic
 * would be a test that should not exist.
 */

const DEV_VARS = new URL("../../.dev.vars", import.meta.url);

const NEEDED: ReadonlyArray<readonly [string, () => string]> = [
  // Not a fixed string: this one signs real session cookies, and a secret
  // committed to a repository is not a secret.
  ["SESSION_SECRET", () => randomBytes(32).toString("base64")],
  ["GOOGLE_CLIENT_ID", () => "dev.apps.googleusercontent.com"],
  ["GOOGLE_CLIENT_SECRET", () => "dev-not-a-real-secret"],
];

function keyOf(line: string): string | null {
  const separator = line.indexOf("=");
  return separator === -1 ? null : line.slice(0, separator).trim();
}

function valueOf(line: string): string {
  return line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/**
 * The whole decision, as text in and text out, so `dev/check-dev-vars.ts` can
 * check it without a file on disk — and so the one case that matters, a real
 * value left alone, is checkable at all. A browser test only ever sees the
 * file after this ran and would agree with an implementation that overwrote
 * everything.
 */
export function fillDevVars(text: string): string {
  const lines = text === "" ? [] : text.split("\n");
  const added: string[] = [];
  let changed = false;

  for (const [key, value] of NEEDED) {
    // The blank line is rewritten where it stands rather than a second one
    // appended: a duplicate key is a coin toss over which of the two anything
    // reading the file picks up.
    const at = lines.findIndex((line) => keyOf(line) === key);
    if (at !== -1 && valueOf(lines[at] as string) !== "") continue;

    const replacement = `${key}="${value()}"`;
    if (at === -1) added.push(replacement);
    else lines[at] = replacement;
    changed = true;
  }
  if (!changed) return text;

  const head = lines.join("\n").replace(/\n*$/, "");
  const tail =
    added.length === 0
      ? ""
      : `${head === "" ? "" : "\n"}\n# Added by the browser suite — placeholders, not credentials.\n${added.join("\n")}`;

  return `${head}${tail}\n`;
}

/** Fill in whatever the suite needs and nothing else. Safe to run every time. */
export function ensureDevVars(): void {
  let text = "";
  try {
    text = readFileSync(DEV_VARS, "utf8");
  } catch {
    text = "";
  }

  const filled = fillDevVars(text);
  if (filled !== text) writeFileSync(DEV_VARS, filled);
}
