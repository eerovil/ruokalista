import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
 * Where `wrangler dev` keeps the local D1 database: Wrangler's default
 * persistence, one SQLite file per database. There is one database binding, so
 * there must be exactly one file; anything else means the layout moved and
 * writing to a guess would be worse than stopping.
 */
const LOCAL_D1_DIR = join(".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");

function localD1File(): string {
  const files = readdirSync(join(process.cwd(), LOCAL_D1_DIR)).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (files.length !== 1) {
    throw new Error(
      `Expected one local D1 database in ${LOCAL_D1_DIR}, found ${files.length}.`,
    );
  }
  return join(process.cwd(), LOCAL_D1_DIR, files[0]!);
}

/**
 * Run SQL against the local D1 file directly, in one transaction.
 *
 * This used to go through `wrangler d1 execute --local`, which writes the same
 * file but boots Wrangler every time: about 2.4 s against about 90 ms here
 * (#347). Specs that reseed before every test spent most of their time on that.
 * The running `wrangler dev` sees the write the way it saw Wrangler's, as
 * another SQLite connection to the same file. Foreign keys are on, as in D1.
 */
function runLocalSql(sql: string, action: string): void {
  const db = new DatabaseSync(localD1File(), { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    throw new Error(
      `${action} failed.\n\n${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  } finally {
    db.close();
  }
}

const SEED_SQL = readFileSync(join(process.cwd(), "dev", "seed.sql"), "utf8");

/**
 * Put the local database back to dev/seed.sql. Called before each spec file so
 * a test that saves a recipe cannot change what a later test sees.
 */
export function reseed(): void {
  runLocalSql(SEED_SQL, "Resetting local D1 before a browser test");
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
  runLocalSql(sql, "Writing focused local D1 browser fixtures");
}
