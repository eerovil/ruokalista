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

/**
 * Put bytes straight into the local R2 bucket, at a key nothing exposes a
 * route for.
 *
 * The picture an import found on a web page (#205) is written by the queue
 * consumer, and a browser run has no queue and no network — so without this
 * there is no way to stand a linked job up with a real picture on it, and the
 * review screen could only ever be tested with a broken image on it.
 */
export function putLocalObject(key: string, file: string, contentType: string): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `ruokalista-recipe-images/${key}`,
      "--local",
      "--file",
      file,
      "--content-type",
      contentType,
    ],
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
