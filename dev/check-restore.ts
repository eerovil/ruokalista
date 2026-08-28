import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  type BackupSchemaEntry,
  type BackupSnapshotUnsigned,
  type BackupTableName,
} from "../src/backup.ts";
import {
  assertCompatibleTarget,
  finalizeSnapshot,
  generateRestoreSql,
  parseAndValidateSnapshot,
} from "../src/restore.ts";

const TABLES: readonly BackupTableName[] = [
  "household",
  "member",
  "intake_job",
  "member_invitation",
  "ingredient",
  "recipe",
  "recipe_share",
  "recipe_category",
  "recipe_step",
  "ingredient_line",
  "planned_batch",
  "batch_occurrence",
  "pantry_entry",
  "recipe_preference",
  "ingredient_product",
  "recipe_ingredient_product",
];

test("a valid snapshot passes checksum and relationship validation", async () => {
  const snapshot = await validSnapshot();
  const parsed = await parseAndValidateSnapshot(canonicalJson(snapshot));
  assert.equal(parsed.sha256, snapshot.sha256);
  assert.equal(
    parsed.tables.recipe.find((row) => row.id === 1)?.source_text,
    "Lasagne\n400 g jauhelihaa",
  );
  assert.equal(parsed.tables.ingredient_product[0]?.ean, "6415712506032");
});

test("a corrupt checksum is rejected", async () => {
  const snapshot = await validSnapshot();
  snapshot.tables.recipe.find((row) => row.id === 1)!.title = "Tampered";
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(snapshot)),
    /SHA-256 does not match/,
  );
});

test("an unknown backup format is rejected", async () => {
  const snapshot = await validSnapshot();
  const raw = { ...snapshot, format_version: 2 };
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(raw)),
    /unsupported backup format_version: 2/,
  );
});

test("missing and unexpected tables are rejected", async () => {
  const snapshot = await validSnapshot();
  const tables = { ...snapshot.tables } as Record<string, unknown>;
  delete tables.batch_occurrence;
  const raw = { ...snapshot, tables };
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(raw)),
    /snapshot tables has missing or unexpected fields/,
  );
});

test("duplicate ids are rejected before restore", async () => {
  const snapshot = await validSnapshot();
  const unsigned = unsignedOf(snapshot);
  unsigned.tables.member.push({ ...unsigned.tables.member[0]! });
  unsigned.row_counts.member += 1;
  const duplicate = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(duplicate)),
    /duplicate member id 1/,
  );
});

test("active members and invitations cannot share a normalized email", async () => {
  const snapshot = await validSnapshot();
  let unsigned = unsignedOf(snapshot);
  unsigned.tables.member_invitation[0]!.email = "EERO@example.com";
  let duplicate = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(duplicate)),
    /duplicate member invitation email/,
  );

  unsigned = unsignedOf(snapshot);
  unsigned.tables.member_invitation.push({
    ...unsigned.tables.member_invitation[0]!,
    id: 2,
    email: "UUSI@example.com",
  });
  unsigned.row_counts.member_invitation += 1;
  duplicate = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(duplicate)),
    /duplicate member invitation email/,
  );
});

test("orphan foreign keys are rejected before restore", async () => {
  const snapshot = await validSnapshot();
  const unsigned = unsignedOf(snapshot);
  unsigned.tables.planned_batch[0]!.recipe_id = 999;
  const orphan = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(orphan)),
    /orphan planned_batch\.recipe_id=999/,
  );
});

test("orphan and duplicate batch occurrences are rejected", async () => {
  const snapshot = await validSnapshot();
  let unsigned = unsignedOf(snapshot);
  unsigned.tables.batch_occurrence[0]!.batch_id = 999;
  let invalid = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(invalid)),
    /orphan batch_occurrence\.batch_id=999/,
  );

  unsigned = unsignedOf(snapshot);
  unsigned.tables.batch_occurrence.push({
    ...unsigned.tables.batch_occurrence[0]!,
  });
  unsigned.row_counts.batch_occurrence += 1;
  invalid = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(invalid)),
    /duplicate batch occurrence/,
  );
});

test("orphan and duplicate pantry entries are rejected", async () => {
  const snapshot = await validSnapshot();
  let unsigned = unsignedOf(snapshot);
  unsigned.tables.pantry_entry[0]!.ingredient_id = 999;
  let invalid = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(invalid)),
    /orphan pantry_entry\.ingredient_id=999/,
  );

  // Two answers for one ingredient is not a pantry, it is a disagreement — the
  // table's UNIQUE says so and a restore must not be the way around it.
  unsigned = unsignedOf(snapshot);
  unsigned.tables.pantry_entry.push({
    ...unsigned.tables.pantry_entry[0]!,
    id: 2,
  });
  unsigned.row_counts.pantry_entry += 1;
  invalid = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(invalid)),
    /duplicate pantry entry/,
  );
});

test("a cyclic recipe parent graph is rejected", async () => {
  const snapshot = await validSnapshot();
  const unsigned = unsignedOf(snapshot);
  unsigned.tables.recipe.find((row) => row.id === 1)!.parent_id = 2;
  const cyclic = await finalizeSnapshot(unsigned);
  await assert.rejects(
    parseAndValidateSnapshot(canonicalJson(cyclic)),
    /cycle or invalid parent/,
  );
});

test("restore SQL writes a parent recipe before its part", async () => {
  const snapshot = await validSnapshot();
  assert.equal(snapshot.tables.recipe[0]?.title, "Kastike");
  const sql = generateRestoreSql(snapshot);
  const parent = sql.indexOf("'Lasagne'");
  const child = sql.indexOf("'Kastike'");
  assert.ok(parent >= 0 && child > parent);
  assert.match(sql, /BEGIN TRANSACTION;/);
  assert.match(sql, /COMMIT;/);
});

test("an incompatible or non-empty migrated target is rejected", async () => {
  const snapshot = await validSnapshot();
  const columns = columnsFrom(snapshot);
  const emptyCounts = Object.fromEntries(TABLES.map((table) => [table, 0])) as Record<BackupTableName, number>;

  const incompatibleSchema = snapshot.schema.map((entry) => ({ ...entry }));
  incompatibleSchema[0] = { ...incompatibleSchema[0]!, sql: "CREATE TABLE household (id INTEGER PRIMARY KEY)" };
  assert.throws(
    () => assertCompatibleTarget(snapshot, {
      schema: incompatibleSchema,
      columns,
      rowCounts: emptyCounts,
    }),
    /target schema does not exactly match/,
  );

  assert.throws(
    () => assertCompatibleTarget(snapshot, {
      schema: snapshot.schema,
      columns,
      rowCounts: { ...emptyCounts, recipe: 1 },
    }),
    /target table recipe is not empty/,
  );
});

async function validSnapshot() {
  const tables = {
    household: [
      { id: 1, name: "Koti", created_at: "2026-08-25 00:00:00" },
      { id: 2, name: "Naapuri", created_at: "2026-08-25 00:00:00" },
    ],
    member: [
      {
        id: 1,
        household_id: 1,
        google_sub: "dev-user",
        display_name: "Eero",
        email: "eero@example.com",
        created_at: "2026-08-25 00:00:00",
      },
    ],
    intake_job: [
      {
        id: "job-1",
        household_id: 1,
        created_by: 1,
        status: "failed",
        lease_id: null,
        source_route: "pasted",
        source_text: "Uunikaali",
        image_refs: null,
        draft_json: null,
        error_message: "Jäsennys epäonnistui.",
        created_at: "2026-08-25 00:00:00",
        updated_at: "2026-08-25 00:01:00",
      },
    ],
    member_invitation: [
      {
        id: 1,
        household_id: 1,
        email: "uusi@example.com",
        created_at: "2026-08-25 00:00:00",
        created_by: 1,
      },
    ],
    ingredient: [
      {
        id: 1,
        household_id: 1,
        name: "jauheliha",
        ean: "6415712506032",
        external_product_name: "Kotimaista jauheliha 400 g",
        external_product_image_url:
          "https://cdn.s-cloud.fi/v1/w256_q75/product/ean/6415712506032_kuva1.jpg",
        created_at: "2026-08-25 00:00:00",
        created_by: 1,
      },
    ],
    // Deliberately child first: SQL generation must reorder it safely.
    recipe: [
      {
        id: 2,
        household_id: 1,
        title: "Kastike",
        yield_portions: null,
        source_text: "Lasagne",
        source_route: "pasted",
        structured_by: "fixture",
        structured_at: "2026-08-25 00:00:00",
        created_at: "2026-08-25 00:00:00",
        created_by: 1,
        updated_at: "2026-08-25 00:00:00",
        updated_by: 1,
        parent_id: 1,
        part_position: 1,
        revision: 0,
        edit_token: null,
      },
      {
        id: 1,
        household_id: 1,
        title: "Lasagne",
        yield_portions: 4,
        source_text: "Lasagne\n400 g jauhelihaa",
        source_route: "pasted",
        structured_by: "fixture",
        structured_at: "2026-08-25 00:00:00",
        created_at: "2026-08-25 00:00:00",
        created_by: 1,
        updated_at: "2026-08-25 00:00:00",
        updated_by: 1,
        parent_id: null,
        part_position: null,
        revision: 0,
        edit_token: null,
      },
    ],
    recipe_share: [
      {
        recipe_id: 1,
        household_id: 2,
        shared_at: "2026-08-25 00:00:00",
        shared_by: 1,
      },
    ],
    recipe_category: [
      { recipe_id: 1, category: "uuniruoka" },
      { recipe_id: 1, category: "pasta" },
    ],
    recipe_step: [
      { recipe_id: 2, position: 1, text: "Ruskista." },
    ],
    ingredient_line: [
      {
        id: 1,
        recipe_id: 2,
        position: 1,
        quantity: 400,
        quantity_max: null,
        unit: "g",
        alt_quantity: null,
        alt_unit: null,
        ingredient_id: 1,
        source_line: "400 g jauhelihaa",
      },
    ],
    planned_batch: [
      {
        id: 1,
        household_id: 1,
        recipe_id: 1,
        multiplier: 1.5,
        legacy_portions: null,
        created_at: "2026-08-25 00:00:00",
        created_by: 1,
      },
    ],
    batch_occurrence: [
      { batch_id: 1, date: "2026-08-25", slot: "dinner" },
    ],
    pantry_entry: [
      {
        id: 1,
        household_id: 1,
        ingredient_id: 1,
        state: "unlimited",
        quantity: null,
        quantity_unit: null,
        added_at: "2026-08-25 00:00:00",
        added_by: 1,
      },
    ],
    recipe_preference: [
      {
        id: 1,
        household_id: 1,
        recipe_id: 1,
        default_multiplier: 1.5,
        updated_at: "2026-08-25 00:00:00",
        updated_by: 1,
      },
    ],
    ingredient_product: [
      {
        id: 1,
        ingredient_id: 1,
        ean: "6415712506032",
        name: "Kotimaista rypsiöljy 500 ml",
        image_url: "https://cdn.s-cloud.fi/kuva.jpg",
        package_quantity: 500,
        package_unit: "ml",
        position: 1,
      },
    ],
    recipe_ingredient_product: [
      {
        id: 1,
        household_id: 1,
        recipe_id: 1,
        ingredient_id: 1,
        ean: "6415712506049",
        name: "Keiton oma öljy 250 ml",
        image_url: null,
        package_quantity: 250,
        package_unit: "ml",
      },
    ],
  } satisfies BackupSnapshotUnsigned["tables"];

  const unsigned: BackupSnapshotUnsigned = {
    format_version: 1,
    scheduled_at: "2026-08-25T02:17:00.000Z",
    captured_at: "2026-08-25T02:17:01.000Z",
    schema: schemaFixture(),
    row_counts: Object.fromEntries(
      TABLES.map((table) => [table, tables[table].length]),
    ) as Record<BackupTableName, number>,
    tables,
  };
  return finalizeSnapshot(unsigned);
}

function schemaFixture(): BackupSchemaEntry[] {
  return TABLES.map((table) => ({
    type: "table",
    name: table,
    tbl_name: table,
    sql: `CREATE TABLE ${table} (fixture TEXT)`,
  }));
}

function unsignedOf(snapshot: Awaited<ReturnType<typeof validSnapshot>>): BackupSnapshotUnsigned {
  return JSON.parse(canonicalJson({
    format_version: snapshot.format_version,
    scheduled_at: snapshot.scheduled_at,
    captured_at: snapshot.captured_at,
    schema: snapshot.schema,
    row_counts: snapshot.row_counts,
    tables: snapshot.tables,
  })) as BackupSnapshotUnsigned;
}

function columnsFrom(snapshot: Awaited<ReturnType<typeof validSnapshot>>): Record<BackupTableName, string[]> {
  return Object.fromEntries(
    TABLES.map((table) => [table, Object.keys(snapshot.tables[table][0] ?? {})]),
  ) as Record<BackupTableName, string[]>;
}
