import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ensureLocalD1 } from "../tests/support/local-d1.ts";

const persistence = mkdtempSync(join(tmpdir(), "ruokalista-local-d1-"));
const expectedMigrations = readdirSync(new URL("../migrations", import.meta.url)).filter(
  (name) => name.endsWith(".sql"),
).length;
after(() => rmSync(persistence, { recursive: true, force: true }));

function appliedMigrations(): number {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "ruokalista",
      "--local",
      "--persist-to",
      persistence,
      "--command",
      "SELECT COUNT(*) AS count FROM d1_migrations",
      "--json",
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output) as Array<{ results: Array<{ count: number }> }>;
  return result[0]?.results[0]?.count ?? 0;
}

test("an empty local D1 is migrated and the bootstrap can be rerun", () => {
  ensureLocalD1({ persistTo: persistence, stdio: "pipe" });
  assert.equal(appliedMigrations(), expectedMigrations);

  ensureLocalD1({ persistTo: persistence, stdio: "pipe" });
  assert.equal(appliedMigrations(), expectedMigrations);
});
