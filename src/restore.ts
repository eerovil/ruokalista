import {
  BACKUP_TABLES,
  canonicalJson,
  type BackupSchemaEntry,
  type BackupSnapshot,
  type BackupSnapshotUnsigned,
  type BackupTableName,
} from "./backup.ts";

type BackupRow = BackupSnapshotUnsigned["tables"][BackupTableName][number];

export interface TargetSnapshotData {
  schema: BackupSchemaEntry[];
  columns: Record<BackupTableName, string[]>;
  rowCounts: Record<BackupTableName, number>;
}

const EXPECTED_TABLES = BACKUP_TABLES.map(({ name }) => name);
const RESTORE_ORDER: readonly BackupTableName[] = [
  "household",
  "member",
  "ingredient",
  "recipe",
  "recipe_step",
  "ingredient_line",
  "meal_entry",
];

export async function parseAndValidateSnapshot(text: string): Promise<BackupSnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("snapshot is not valid JSON");
  }
  if (!isRecord(raw)) throw new Error("snapshot root must be an object");
  assertExactKeys(raw, [
    "format_version",
    "scheduled_at",
    "captured_at",
    "schema",
    "row_counts",
    "tables",
    "sha256",
  ], "snapshot");
  if (raw.format_version !== 1) {
    throw new Error(`unsupported backup format_version: ${String(raw.format_version)}`);
  }
  if (typeof raw.scheduled_at !== "string" || !Number.isFinite(Date.parse(raw.scheduled_at))) {
    throw new Error("snapshot scheduled_at is invalid");
  }
  if (typeof raw.captured_at !== "string" || !Number.isFinite(Date.parse(raw.captured_at))) {
    throw new Error("snapshot captured_at is invalid");
  }
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    throw new Error("snapshot sha256 is invalid");
  }

  const schema = validateSchema(raw.schema);
  const tables = validateTables(raw.tables);
  const rowCounts = validateRowCounts(raw.row_counts, tables);
  const unsigned: BackupSnapshotUnsigned = {
    format_version: 1,
    scheduled_at: raw.scheduled_at,
    captured_at: raw.captured_at,
    schema,
    row_counts: rowCounts,
    tables,
  };
  const digest = await snapshotDigest(unsigned);
  if (digest !== raw.sha256) throw new Error("snapshot SHA-256 does not match its contents");

  const snapshot: BackupSnapshot = { ...unsigned, sha256: raw.sha256 };
  validateRelationships(snapshot);
  return snapshot;
}

export async function snapshotDigest(unsigned: BackupSnapshotUnsigned): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(unsigned)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function finalizeSnapshot(unsigned: BackupSnapshotUnsigned): Promise<BackupSnapshot> {
  return { ...unsigned, sha256: await snapshotDigest(unsigned) };
}

export function assertCompatibleTarget(
  snapshot: BackupSnapshot,
  target: TargetSnapshotData,
): void {
  const snapshotSchema = canonicalJson(sortSchema(snapshot.schema));
  const targetSchema = canonicalJson(sortSchema(target.schema));
  if (snapshotSchema !== targetSchema) {
    throw new Error("target schema does not exactly match the snapshot schema");
  }

  for (const table of EXPECTED_TABLES) {
    if (target.rowCounts[table] !== 0) {
      throw new Error(`target table ${table} is not empty`);
    }
    const expectedColumns = [...target.columns[table]].sort();
    for (const [index, row] of snapshot.tables[table].entries()) {
      const rowColumns = Object.keys(row).sort();
      if (canonicalJson(rowColumns) !== canonicalJson(expectedColumns)) {
        throw new Error(`snapshot ${table} row ${index} columns do not match target schema`);
      }
    }
  }
}

export function generateRestoreSql(snapshot: BackupSnapshot): string {
  const lines = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  const tables = { ...snapshot.tables };
  tables.recipe = sortRecipesParentFirst(snapshot.tables.recipe);

  for (const table of RESTORE_ORDER) {
    for (const row of tables[table]) {
      const columns = Object.keys(row);
      if (columns.length === 0) throw new Error(`snapshot ${table} contains an empty row`);
      const names = columns.map(quoteIdentifier).join(", ");
      const values = columns.map((column) => sqlValue(row[column] ?? null)).join(", ");
      lines.push(`INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${values});`);
    }
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

export function assertRestoredRows(
  snapshot: BackupSnapshot,
  actual: Record<BackupTableName, BackupRow[]>,
): void {
  for (const { name } of BACKUP_TABLES) {
    if (canonicalJson(actual[name]) !== canonicalJson(snapshot.tables[name])) {
      throw new Error(`restored table ${name} does not exactly match snapshot rows`);
    }
  }
}

function validateSchema(value: unknown): BackupSchemaEntry[] {
  if (!Array.isArray(value)) throw new Error("snapshot schema must be an array");
  const schema = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`snapshot schema entry ${index} must be an object`);
    assertExactKeys(entry, ["type", "name", "tbl_name", "sql"], `snapshot schema entry ${index}`);
    if (
      typeof entry.type !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.tbl_name !== "string" ||
      typeof entry.sql !== "string"
    ) {
      throw new Error(`snapshot schema entry ${index} has invalid fields`);
    }
    if (!EXPECTED_TABLES.includes(entry.tbl_name as BackupTableName)) {
      throw new Error(`snapshot schema contains non-app object ${entry.name}`);
    }
    return {
      type: entry.type,
      name: entry.name,
      tbl_name: entry.tbl_name,
      sql: entry.sql,
    };
  });
  const tableEntries = schema
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name)
    .sort();
  const expected = [...EXPECTED_TABLES].sort();
  if (canonicalJson(tableEntries) !== canonicalJson(expected)) {
    throw new Error("snapshot schema is missing or has unexpected app tables");
  }
  return schema;
}

function validateTables(value: unknown): Record<BackupTableName, BackupRow[]> {
  if (!isRecord(value)) throw new Error("snapshot tables must be an object");
  assertExactKeys(value, EXPECTED_TABLES, "snapshot tables");
  const tables = {} as Record<BackupTableName, BackupRow[]>;
  for (const table of EXPECTED_TABLES) {
    const rows = value[table];
    if (!Array.isArray(rows)) throw new Error(`snapshot table ${table} must be an array`);
    tables[table] = rows.map((row, index) => validateRow(table, row, index));
  }
  return tables;
}

function validateRow(table: BackupTableName, value: unknown, index: number): BackupRow {
  if (!isRecord(value)) throw new Error(`snapshot ${table} row ${index} must be an object`);
  const row: BackupRow = {};
  for (const [column, cell] of Object.entries(value)) {
    if (
      cell !== null &&
      typeof cell !== "string" &&
      typeof cell !== "number" &&
      typeof cell !== "boolean"
    ) {
      throw new Error(`snapshot ${table}.${column} contains unsupported data`);
    }
    if (typeof cell === "number" && !Number.isFinite(cell)) {
      throw new Error(`snapshot ${table}.${column} contains a non-finite number`);
    }
    row[column] = cell;
  }
  return row;
}

function validateRowCounts(
  value: unknown,
  tables: Record<BackupTableName, BackupRow[]>,
): Record<BackupTableName, number> {
  if (!isRecord(value)) throw new Error("snapshot row_counts must be an object");
  assertExactKeys(value, EXPECTED_TABLES, "snapshot row_counts");
  const counts = {} as Record<BackupTableName, number>;
  for (const table of EXPECTED_TABLES) {
    const count = value[table];
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error(`snapshot row count for ${table} is invalid`);
    }
    if (count !== tables[table].length) {
      throw new Error(`snapshot row count for ${table} does not match rows`);
    }
    counts[table] = count as number;
  }
  return counts;
}

function validateRelationships(snapshot: BackupSnapshot): void {
  const householdIds = uniqueIntegerKey(snapshot.tables.household, "id", "household");
  const memberIds = uniqueIntegerKey(snapshot.tables.member, "id", "member");
  const ingredientIds = uniqueIntegerKey(snapshot.tables.ingredient, "id", "ingredient");
  const recipeIds = uniqueIntegerKey(snapshot.tables.recipe, "id", "recipe");
  uniqueIntegerKey(snapshot.tables.ingredient_line, "id", "ingredient_line");
  uniqueIntegerKey(snapshot.tables.meal_entry, "id", "meal_entry");
  uniqueComposite(snapshot.tables.recipe_step, ["recipe_id", "position"], "recipe_step");
  uniqueComposite(snapshot.tables.ingredient_line, ["recipe_id", "position"], "ingredient_line order");
  uniqueComposite(snapshot.tables.member, ["google_sub"], "member google_sub");
  uniqueComposite(snapshot.tables.ingredient, ["household_id", "name"], "ingredient name");

  for (const row of snapshot.tables.member) {
    requireReference(row, "household_id", householdIds, "member.household_id");
  }
  for (const row of snapshot.tables.ingredient) {
    requireReference(row, "household_id", householdIds, "ingredient.household_id");
    requireReference(row, "created_by", memberIds, "ingredient.created_by");
  }
  for (const row of snapshot.tables.recipe) {
    requireReference(row, "household_id", householdIds, "recipe.household_id");
    requireReference(row, "created_by", memberIds, "recipe.created_by");
    requireReference(row, "updated_by", memberIds, "recipe.updated_by");
    if (row.parent_id !== null) requireReference(row, "parent_id", recipeIds, "recipe.parent_id");
  }
  sortRecipesParentFirst(snapshot.tables.recipe);
  for (const row of snapshot.tables.recipe_step) {
    requireReference(row, "recipe_id", recipeIds, "recipe_step.recipe_id");
  }
  for (const row of snapshot.tables.ingredient_line) {
    requireReference(row, "recipe_id", recipeIds, "ingredient_line.recipe_id");
    requireReference(row, "ingredient_id", ingredientIds, "ingredient_line.ingredient_id");
  }
  for (const row of snapshot.tables.meal_entry) {
    requireReference(row, "household_id", householdIds, "meal_entry.household_id");
    requireReference(row, "recipe_id", recipeIds, "meal_entry.recipe_id");
    requireReference(row, "created_by", memberIds, "meal_entry.created_by");
  }
}

function sortRecipesParentFirst(rows: BackupRow[]): BackupRow[] {
  const pending = [...rows];
  const restored = new Set<number>();
  const ordered: BackupRow[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((row) => {
      const parent = row.parent_id;
      return parent === null || (typeof parent === "number" && restored.has(parent));
    });
    if (index < 0) throw new Error("recipe parent graph contains a cycle or invalid parent");
    const [row] = pending.splice(index, 1);
    if (!row) throw new Error("recipe ordering failed");
    const id = integerCell(row, "id", "recipe.id");
    ordered.push(row);
    restored.add(id);
  }
  return ordered;
}

function uniqueIntegerKey(rows: BackupRow[], column: string, label: string): Set<number> {
  const values = new Set<number>();
  for (const row of rows) {
    const value = integerCell(row, column, `${label}.${column}`);
    if (values.has(value)) throw new Error(`snapshot has duplicate ${label} ${column} ${value}`);
    values.add(value);
  }
  return values;
}

function uniqueComposite(rows: BackupRow[], columns: string[], label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = canonicalJson(columns.map((column) => row[column]));
    if (seen.has(key)) throw new Error(`snapshot has duplicate ${label}`);
    seen.add(key);
  }
}

function requireReference(
  row: BackupRow,
  column: string,
  ids: Set<number>,
  label: string,
): void {
  const value = integerCell(row, column, label);
  if (!ids.has(value)) throw new Error(`snapshot has orphan ${label}=${value}`);
}

function integerCell(row: BackupRow, column: string, label: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`snapshot ${label} must be an integer`);
  }
  return value;
}

function sortSchema(schema: BackupSchemaEntry[]): BackupSchemaEntry[] {
  return [...schema].sort((a, b) =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQL identifier in snapshot: ${value}`);
  }
  return `"${value}"`;
}

function sqlValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot contains a non-finite number");
    return String(value);
  }
  throw new Error("snapshot row contains unsupported nested JSON data");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} has missing or unexpected fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
