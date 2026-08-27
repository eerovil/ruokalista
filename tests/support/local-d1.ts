import { execFileSync } from "node:child_process";

interface LocalD1Options {
  persistTo?: string;
  stdio?: "inherit" | "pipe";
}

/** Apply this checkout's migrations before Playwright starts `wrangler dev`. */
export function ensureLocalD1({
  persistTo,
  stdio = "inherit",
}: LocalD1Options = {}): void {
  const args = ["run", "migrate:local"];
  if (persistTo !== undefined) args.push("--", "--persist-to", persistTo);

  // Wrangler owns both the migrations directory and local persistence layout.
  // Reusing the repository script keeps the bootstrap on that same path.
  execFileSync("npm", args, {
    env: { ...process.env, CI: "1" },
    stdio,
  });
}
