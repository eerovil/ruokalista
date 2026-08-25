import assert from "node:assert/strict";
import test from "node:test";

import { forD1Import } from "../scripts/d1-import-sql.ts";

test("D1 import SQL removes the explicit transaction wrapper only", () => {
  const sql = [
    "PRAGMA foreign_keys = ON;",
    "BEGIN TRANSACTION;",
    "INSERT INTO \"household\" (\"id\") VALUES (1);",
    "COMMIT;",
    "",
  ].join("\n");

  assert.equal(
    forD1Import(sql),
    [
      "PRAGMA foreign_keys = ON;",
      "INSERT INTO \"household\" (\"id\") VALUES (1);",
      "",
    ].join("\n"),
  );
});

test("D1 import SQL refuses an unexpected transaction shape", () => {
  assert.throws(
    () => forD1Import("PRAGMA foreign_keys = ON;\nINSERT INTO x VALUES (1);\n"),
    /transaction wrapper changed unexpectedly/,
  );
  assert.throws(
    () => forD1Import("BEGIN TRANSACTION;\nBEGIN TRANSACTION;\nCOMMIT;\n"),
    /BEGIN=2, COMMIT=1/,
  );
});
