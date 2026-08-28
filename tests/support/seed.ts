import { execFileSync } from "node:child_process";

/**
 * Put the local database back to dev/seed.sql. Called before each spec file so
 * a test that saves a recipe cannot change what a later test sees.
 */
export function reseed(): void {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "ruokalista", "--local", "--file", "dev/seed.sql"],
    { cwd: process.cwd(), stdio: "ignore" },
  );
}

/** Add one test's focused fixture rows without changing the shared seed. */
export function executeLocalSql(sql: string): void {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "ruokalista", "--local", "--command", sql],
    { cwd: process.cwd(), stdio: "ignore" },
  );
}
