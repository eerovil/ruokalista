import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBackupTableDefinitions,
  BACKUP_TABLES,
  restoreTableOrder,
  type BackupTableDefinition,
} from "../src/backup.ts";

const NAMES = BACKUP_TABLES.map(({ name }) => name);

test("one manifest covers capture, restore dependencies and target start policy", () => {
  assert.doesNotThrow(() => assertBackupTableDefinitions(NAMES));

  const order = restoreTableOrder();
  assert.equal(order.length, BACKUP_TABLES.length);
  assert.equal(new Set(order).size, order.length);

  const position = new Map(order.map((name, index) => [name, index]));
  for (const definition of BACKUP_TABLES) {
    assert.notEqual(definition.orderBy.trim(), "");
    for (const dependency of definition.restoreAfter) {
      assert.ok(
        position.get(dependency)! < position.get(definition.name)!,
        `${dependency} must restore before ${definition.name}`,
      );
    }
  }
});

test("category is the only migration-seeded table the snapshot replaces", () => {
  const replacing = BACKUP_TABLES
    .filter(({ targetStart }) => targetStart === "replace-seeded")
    .map(({ name }) => name);
  assert.deepEqual(replacing, ["category"]);
});

test("schema coverage rejects a migrated table with no complete definition", () => {
  assert.throws(
    () => assertBackupTableDefinitions([...NAMES, "forgotten_table"]),
    /migrated app tables and backup\/restore definitions differ/,
  );
});

test("definition validation rejects incomplete metadata and bad dependencies", () => {
  const incomplete = BACKUP_TABLES.map((definition) => ({ ...definition })) as unknown as
    BackupTableDefinition[];
  (incomplete[0] as unknown as Record<string, unknown>)["orderBy"] = "";
  assert.throws(
    () => assertBackupTableDefinitions(NAMES, incomplete),
    /definition is incomplete/,
  );

  const unknownDependency = BACKUP_TABLES.map((definition) => ({
    ...definition,
    restoreAfter: [...definition.restoreAfter],
  })) as BackupTableDefinition[];
  unknownDependency[0]!.restoreAfter = ["not_a_table"];
  assert.throws(
    () => assertBackupTableDefinitions(NAMES, unknownDependency),
    /unknown restore dependency/,
  );

  const cyclic = BACKUP_TABLES.map((definition) => ({
    ...definition,
    restoreAfter: [...definition.restoreAfter],
  })) as BackupTableDefinition[];
  const household = cyclic.find(({ name }) => name === "household")!;
  household.restoreAfter = ["member"];
  assert.throws(
    () => assertBackupTableDefinitions(NAMES, cyclic),
    /restore dependencies contain a cycle/,
  );
});