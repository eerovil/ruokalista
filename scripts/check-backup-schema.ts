import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  assertBackupTableDefinitions,
  BACKUP_TABLES,
} from "../src/backup.ts";

const query = `
  SELECT name
    FROM sqlite_schema
   WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%'
     AND name NOT LIKE '_cf_%'
     AND name <> 'd1_migrations'
   ORDER BY name
`;

const output = execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "ruokalista",
    "--local",
    "--command",
    query,
    "--json",
  ],
  { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);

const parsed = JSON.parse(output) as Array<{
  results?: Array<{ name?: unknown }>;
}>;
const actual = (parsed[0]?.results ?? [])
  .map(({ name }) => {
    assert.equal(typeof name, "string", "D1 returned a non-string table name");
    return name;
  })
  .sort();

assertBackupTableDefinitions(actual);

console.log(
  `backup/restore definition coverage ok: ${BACKUP_TABLES.map(({ name }) => name).join(", ")}`,
);