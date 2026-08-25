import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKUP_TABLES,
  canonicalJson,
  type BackupSchemaEntry,
  type BackupTableName,
} from "../src/backup.ts";
import {
  assertCompatibleTarget,
  assertRestoredRows,
  generateRestoreSql,
  parseAndValidateSnapshot,
  type TargetSnapshotData,
} from "../src/restore.ts";

interface Options {
  snapshot: string;
  database: string;
  remote: boolean;
  persistTo?: string;
  databaseId?: string;
  wranglerConfig?: string;
}

type BackupRow = Record<string, string | number | boolean | null>;

const PRODUCTION_DATABASE_ID = "f81fabeb-b38f-453d-8966-dfe52c721341";
const PRODUCTION_DATABASE_SELECTORS = new Set([
  "ruokalista",
  "DB",
  PRODUCTION_DATABASE_ID,
]);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const snapshotText = readFileSync(options.snapshot, "utf8");

  // Integrity and relationship validation deliberately happen before Wrangler
  // is allowed to write even migrations to the target.
  const snapshot = await parseAndValidateSnapshot(snapshotText);

  assertSafeRemoteTarget(options);
  const targetOptions = prepareTargetOptions(options);

  try {
    runWrangler([
      "d1",
      "migrations",
      "apply",
      targetOptions.database,
      ...targetFlags(targetOptions),
    ]);

    const target = readTargetSnapshotData(targetOptions);
    assertCompatibleTarget(snapshot, target);

    const sql = generateRestoreSql(snapshot);
    const sqlPath = join(tmpdir(), `ruokalista-restore-${crypto.randomUUID()}.sql`);
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    try {
      runWrangler([
        "d1",
        "execute",
        targetOptions.database,
        ...targetFlags(targetOptions),
        "--file",
        sqlPath,
      ]);
    } finally {
      removePrivateTempFile(sqlPath);
    }

    const actual = readAllTables(targetOptions);
    assertRestoredRows(snapshot, actual);
    const foreignKeyProblems = query(targetOptions, "PRAGMA foreign_key_check");
    if (foreignKeyProblems.length !== 0) {
      throw new Error(`restored database has ${foreignKeyProblems.length} foreign-key violation(s)`);
    }

    console.log(
      `restore verified: sha256=${snapshot.sha256} counts=${canonicalJson(snapshot.row_counts)}`,
    );
  } finally {
    if (targetOptions.wranglerConfig) removePrivateTempFile(targetOptions.wranglerConfig);
  }
}

function parseArgs(args: string[]): Options {
  let snapshot = "";
  let database = "";
  let remote = false;
  let local = false;
  let persistTo: string | undefined;
  let databaseId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--snapshot") snapshot = requiredValue(args, ++index, arg);
    else if (arg === "--database") database = requiredValue(args, ++index, arg);
    else if (arg === "--database-id") databaseId = requiredValue(args, ++index, arg);
    else if (arg === "--persist-to") persistTo = requiredValue(args, ++index, arg);
    else if (arg === "--remote") remote = true;
    else if (arg === "--local") local = true;
    else throw new Error(`unknown restore argument: ${arg}`);
  }

  if (!snapshot) throw new Error("--snapshot is required");
  if (!database) throw new Error("--database is required");
  if (remote === local) throw new Error("choose exactly one of --local or --remote");
  if (remote && persistTo) throw new Error("--persist-to is local-only");
  if (!remote && databaseId) throw new Error("--database-id is remote-only");
  if (databaseId && !isUuid(databaseId)) throw new Error("--database-id must be a UUID");

  return {
    snapshot,
    database,
    remote,
    ...(persistTo ? { persistTo } : {}),
    ...(databaseId ? { databaseId } : {}),
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function assertSafeRemoteTarget(options: Options): void {
  if (!options.remote) return;
  if (PRODUCTION_DATABASE_SELECTORS.has(options.database)) {
    throw new Error(`refusing to restore into production database selector '${options.database}'`);
  }
  if (options.databaseId === PRODUCTION_DATABASE_ID) {
    throw new Error(`refusing to restore into production database id '${options.databaseId}'`);
  }
}

function prepareTargetOptions(options: Options): Options {
  if (!options.remote || !options.databaseId) return options;

  // Freshly-created D1 databases are not in the repository's wrangler.jsonc yet.
  // Build a private, one-use config that binds only the explicitly supplied
  // non-production UUID, so the documented restore tool can target it without
  // ever editing or deploying the production binding.
  const wranglerConfig = join(
    process.cwd(),
    `.wrangler-restore-${crypto.randomUUID()}.json`,
  );
  const config = {
    name: "ruokalista-restore-target",
    d1_databases: [
      {
        binding: "RESTORE_TARGET",
        database_name: options.database,
        database_id: options.databaseId,
        migrations_dir: "migrations",
      },
    ],
  };
  writeFileSync(wranglerConfig, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return { ...options, database: "RESTORE_TARGET", wranglerConfig };
}

function targetFlags(options: Options): string[] {
  const flags = options.remote
    ? ["--remote"]
    : ["--local", ...(options.persistTo ? ["--persist-to", options.persistTo] : [])];
  if (options.wranglerConfig) flags.push("--config", options.wranglerConfig);
  return flags;
}

function readTargetSnapshotData(options: Options): TargetSnapshotData {
  const schema = query(options, schemaQuery()).map(toSchemaEntry);
  const columns = {} as Record<BackupTableName, string[]>;
  const rowCounts = {} as Record<BackupTableName, number>;
  for (const { name } of BACKUP_TABLES) {
    columns[name] = query(options, `PRAGMA table_info(${quoteIdentifier(name)})`).map((row) => {
      const column = row.name;
      if (typeof column !== "string") throw new Error(`target ${name} has invalid column metadata`);
      return column;
    });
    const rows = query(options, `SELECT count(*) AS count FROM ${quoteIdentifier(name)}`);
    const count = rows[0]?.count;
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error(`target ${name} returned an invalid row count`);
    }
    rowCounts[name] = count as number;
  }
  return { schema, columns, rowCounts };
}

function readAllTables(options: Options): Record<BackupTableName, BackupRow[]> {
  const tables = {} as Record<BackupTableName, BackupRow[]>;
  for (const { name, orderBy } of BACKUP_TABLES) {
    tables[name] = query(
      options,
      `SELECT * FROM ${quoteIdentifier(name)} ORDER BY ${orderBy}`,
    ) as BackupRow[];
  }
  return tables;
}

function schemaQuery(): string {
  const names = BACKUP_TABLES.map(({ name }) => `'${name}'`).join(", ");
  return `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND (name IN (${names}) OR tbl_name IN (${names})) ORDER BY type, name`;
}

function query(options: Options, sql: string): Record<string, unknown>[] {
  const output = runWrangler([
    "d1",
    "execute",
    options.database,
    ...targetFlags(options),
    "--command",
    sql,
    "--json",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Wrangler did not return valid JSON");
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(result) || result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Wrangler D1 query failed or returned an unexpected shape");
  }
  return result.results.map((row, index) => {
    if (!isRecord(row)) throw new Error(`Wrangler D1 row ${index} is invalid`);
    return row;
  });
}

function runWrangler(args: string[]): string {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "wrangler failed").trim();
    throw new Error(detail);
  }
  return result.stdout;
}

function toSchemaEntry(row: Record<string, unknown>): BackupSchemaEntry {
  if (
    typeof row.type !== "string" ||
    typeof row.name !== "string" ||
    typeof row.tbl_name !== "string" ||
    typeof row.sql !== "string"
  ) {
    throw new Error("target schema row has an unexpected shape");
  }
  return { type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql };
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function removePrivateTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort. Files created here contain private target config or backup data.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
