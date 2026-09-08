import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_TABLES,
  type BackupSnapshot,
  type BackupTableName,
} from "../src/backup.ts";
import {
  assertCompatibleTarget,
  generateRestoreSql,
} from "../src/restore.ts";

function emptySnapshot(): BackupSnapshot {
  const tables = Object.fromEntries(
    BACKUP_TABLES.map(({ name }) => [name, []]),
  ) as BackupSnapshot["tables"];
  const rowCounts = Object.fromEntries(
    BACKUP_TABLES.map(({ name }) => [name, 0]),
  ) as Record<BackupTableName, number>;
  return {
    format_version: 1,
    scheduled_at: "2026-09-09T00:00:00.000Z",
    captured_at: "2026-09-09T00:00:01.000Z",
    schema: [],
    row_counts: rowCounts,
    tables,
    sha256: "0".repeat(64),
  };
}

function emptyColumns(): Record<BackupTableName, string[]> {
  return Object.fromEntries(
    BACKUP_TABLES.map(({ name }) => [name, []]),
  ) as Record<BackupTableName, string[]>;
}

function emptyCounts(): Record<BackupTableName, number> {
  return Object.fromEntries(
    BACKUP_TABLES.map(({ name }) => [name, 0]),
  ) as Record<BackupTableName, number>;
}

test("migration-seeded category rows are allowed and replaced before restore", () => {
  const snapshot = emptySnapshot();
  const rowCounts = { ...emptyCounts(), category: 9 };

  assert.doesNotThrow(() => assertCompatibleTarget(snapshot, {
    schema: [],
    columns: emptyColumns(),
    rowCounts,
  }));

  const sql = generateRestoreSql(snapshot);
  assert.match(sql, /DELETE FROM "category";/);
  assert.equal((sql.match(/DELETE FROM/g) ?? []).length, 1);
});

test("ordinary durable tables still require an empty restore target", () => {
  const snapshot = emptySnapshot();
  const rowCounts = { ...emptyCounts(), recipe: 1 };

  assert.throws(
    () => assertCompatibleTarget(snapshot, {
      schema: [],
      columns: emptyColumns(),
      rowCounts,
    }),
    /target table recipe is not empty/,
  );
});