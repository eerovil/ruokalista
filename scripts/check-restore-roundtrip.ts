import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKUP_TABLES,
  canonicalJson,
  type BackupSchemaEntry,
  type BackupSnapshotUnsigned,
  type BackupTableName,
} from "../src/backup.ts";
import { finalizeSnapshot } from "../src/restore.ts";

type BackupRow = Record<string, string | number | boolean | null>;

const root = join(process.cwd(), ".wrangler", "restore-roundtrip");
const sourceState = join(root, "source");
const targetState = join(root, "target");
const snapshotPath = join(root, "snapshot.json");
const database = "ruokalista";

try {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  runWrangler(["d1", "migrations", "apply", database, "--local", "--persist-to", sourceState]);
  runWrangler(["d1", "execute", database, "--local", "--persist-to", sourceState, "--file", "dev/seed.sql"]);
  runWrangler([
    "d1",
    "execute",
    database,
    "--local",
    "--persist-to",
    sourceState,
    "--command",
    "INSERT INTO planned_batch (id, household_id, recipe_id, portions, created_at, created_by) VALUES (1, 1, 3, 6, '2026-08-25 12:00:00', 1); INSERT INTO batch_occurrence (batch_id, date, slot) VALUES (1, '2026-08-25', 'dinner'), (1, '2026-08-26', 'lunch')",
  ]);

  const snapshot = await captureSnapshot(sourceState);
  writeFileSync(snapshotPath, `${canonicalJson(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });

  runNode([
    "scripts/restore-backup.ts",
    "--snapshot",
    snapshotPath,
    "--database",
    database,
    "--local",
    "--persist-to",
    targetState,
  ]);

  const target = readTables(targetState);
  for (const { name } of BACKUP_TABLES) {
    if (canonicalJson(target[name]) !== canonicalJson(snapshot.tables[name])) {
      throw new Error(`round-trip table mismatch: ${name}`);
    }
  }

  const sourceRecipe = target.recipe.find((row) => row.id === 3);
  if (sourceRecipe?.source_text !== "Lasagne\nJauhelihakastike\n400 g jauhelihaa\nJuustokastike\n5 dl maitoa\n2 dl juustoa") {
    throw new Error("round-trip did not preserve exact multipart recipe source text");
  }
  const parts = target.recipe
    .filter((row) => row.parent_id === 3)
    .map((row) => [row.title, row.part_position]);
  if (canonicalJson(parts) !== canonicalJson([["Jauhelihakastike", 1], ["Juustokastike", 2]])) {
    throw new Error("round-trip did not preserve multipart recipe relationships");
  }
  if (target.member[0]?.household_id !== 1 || target.ingredient.find((row) => row.name === "jauheliha")?.household_id !== 1) {
    throw new Error("round-trip did not preserve household/member/ingredient relationships");
  }
  if (target.planned_batch[0]?.recipe_id !== 3 || target.planned_batch[0]?.portions !== 6) {
    throw new Error("round-trip did not preserve the planned batch");
  }
  if (canonicalJson(target.batch_occurrence) !== canonicalJson([
    { batch_id: 1, date: "2026-08-25", slot: "dinner" },
    { batch_id: 1, date: "2026-08-26", slot: "lunch" },
  ])) {
    throw new Error("round-trip did not preserve batch occurrences");
  }

  console.log(`restore round-trip ok: sha256=${snapshot.sha256}`);
} finally {
  try {
    unlinkSync(snapshotPath);
  } catch {
    // The private fixture snapshot may not have been written yet.
  }
  rmSync(root, { recursive: true, force: true });
}

async function captureSnapshot(persistTo: string) {
  const schema = query(persistTo, schemaQuery()).map(toSchemaEntry);
  const tables = readTables(persistTo);
  const unsigned: BackupSnapshotUnsigned = {
    format_version: 1,
    scheduled_at: "2026-08-25T02:17:00.000Z",
    captured_at: "2026-08-25T02:17:01.000Z",
    schema,
    row_counts: Object.fromEntries(
      BACKUP_TABLES.map(({ name }) => [name, tables[name].length]),
    ) as Record<BackupTableName, number>,
    tables,
  };
  return finalizeSnapshot(unsigned);
}

function readTables(persistTo: string): Record<BackupTableName, BackupRow[]> {
  const tables = {} as Record<BackupTableName, BackupRow[]>;
  for (const { name, orderBy } of BACKUP_TABLES) {
    tables[name] = query(
      persistTo,
      `SELECT * FROM ${quoteIdentifier(name)} ORDER BY ${orderBy}`,
    ) as BackupRow[];
  }
  return tables;
}

function schemaQuery(): string {
  const names = BACKUP_TABLES.map(({ name }) => `'${name}'`).join(", ");
  return `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND (name IN (${names}) OR tbl_name IN (${names})) ORDER BY type, name`;
}

function query(persistTo: string, sql: string): Record<string, unknown>[] {
  const output = runWrangler([
    "d1",
    "execute",
    database,
    "--local",
    "--persist-to",
    persistTo,
    "--command",
    sql,
    "--json",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Wrangler did not return valid JSON during restore round-trip");
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(result) || result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Wrangler returned an unexpected D1 result during restore round-trip");
  }
  return result.results.map((row, index) => {
    if (!isRecord(row)) throw new Error(`invalid D1 row ${index}`);
    return row;
  });
}

function runNode(args: string[]): string {
  const result = spawnSync("node", ["--experimental-strip-types", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "restore CLI failed").trim());
  }
  return result.stdout;
}

function runWrangler(args: string[]): string {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "wrangler failed").trim());
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
    throw new Error("source schema row has an unexpected shape");
  }
  return { type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql };
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
