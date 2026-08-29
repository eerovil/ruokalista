import { execFileSync } from "node:child_process";

type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => unknown;

/** Run one local Wrangler fixture command, keeping its error for the test log. */
export function runLocalWrangler(
  args: string[],
  action: string,
  run: CommandRunner = execFileSync,
): void {
  try {
    run("npx", ["wrangler", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown })?.stderr;
    const stdout = (error as { stdout?: unknown })?.stdout;
    const stderrDetail = stderr === undefined || stderr === null
      ? ""
      : String(stderr).trim();
    const stdoutDetail = stdout === undefined || stdout === null
      ? ""
      : String(stdout).trim();
    const detail = stderrDetail || stdoutDetail;
    throw new Error(
      `${action} failed.${detail === "" ? "" : `\n\n${detail}`}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

/**
 * Put the local database back to dev/seed.sql. Called before each spec file so
 * a test that saves a recipe cannot change what a later test sees.
 */
export function reseed(): void {
  runLocalWrangler(
    ["d1", "execute", "ruokalista", "--local", "--file", "dev/seed.sql"],
    "Resetting local D1 before a browser test",
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
  runLocalWrangler(
    [
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
    "Writing a local R2 browser fixture",
  );
}

/** Add one test's focused fixture rows without changing the shared seed. */
export function executeLocalSql(sql: string): void {
  runLocalWrangler(
    ["d1", "execute", "ruokalista", "--local", "--command", sql],
    "Writing focused local D1 browser fixtures",
  );
}
