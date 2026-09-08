import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** JSON becomes a build-time constant through Wrangler's key:value --define. */
export function releaseArgs(sha, migrations) {
  if (typeof sha !== "string" || sha.length !== 40 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Release SHA is invalid");
  if (!Array.isArray(migrations) || migrations.length === 0 ||
      migrations.some((name) => typeof name !== "string" || name.trim() !== name || !/^\d+_[a-z0-9_]+\.sql$/.test(name)) ||
      new Set(migrations).size !== migrations.length) {
    throw new Error("Release migration list is invalid");
  }
  const manifest = { sha, migrations: [...migrations].sort() };
  return ["deploy", "--define", `__RUOKALISTA_RELEASE__:${JSON.stringify(manifest)}`, "--tag", sha];
}

export function assertReleaseCheckout(sha, expectedSha, status) {
  if (expectedSha && expectedSha !== sha) {
    throw new Error("Checked-out commit does not match GITHUB_SHA");
  }
  if (status.trim() !== "") throw new Error("Refusing to stamp a dirty checkout as a release");
}

function main() {
  const extra = process.argv.slice(2);
  if (extra.some((arg) => arg !== "--dry-run")) {
    throw new Error("Only --dry-run is supported; release identity cannot be overridden");
  }
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  // Actions may check out as a different uid inside its job container. Trust
  // exactly this worktree for these read-only Git commands, not every directory.
  const git = (...args) => execFileSync("git", ["-c", `safe.directory=${root}`, ...args],
    { cwd: root, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  assertReleaseCheckout(sha, process.env.GITHUB_SHA, git("status", "--porcelain", "--untracked-files=normal"));
  const migrations = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"));
  const args = releaseArgs(sha, migrations);
  console.log(`Building release ${sha} with ${migrations.length} expected migrations`);
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    ...args, ...extra,
  ], { cwd: root, stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
