import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertImagesReadable, auditBackupImages, createR2ImageReader, imageAuditSummary,
  parseImageAuditArgs, r2ImageArgs, runImageAudit,
} from "../scripts/backup-images.ts";
import { BACKUP_TABLES, canonicalJson, type BackupSnapshotUnsigned } from "../src/backup.ts";
import type { Env } from "../src/env.ts";
import { MAX_IMAGE_BYTES } from "../src/image-bytes.ts";
import { encodePng } from "../src/png.ts";
import { cleanupDeletedRecipeImages, deleteRecipeWithImages } from "../src/recipe-deletion.ts";
import { storeRecipeImage } from "../src/recipe-images.ts";
import { assertRestoredRows, finalizeSnapshot, generateRestoreSql, parseAndValidateSnapshot } from "../src/restore.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

async function snapshotOf(f: FakeD1) {
  const tables = Object.fromEntries(BACKUP_TABLES.map(({ name, orderBy }) => [
    name, f.sql.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all(),
  ])) as BackupSnapshotUnsigned["tables"];
  const names = BACKUP_TABLES.map(({ name }) => `'${name}'`).join(", ");
  return finalizeSnapshot({
    format_version: 1, scheduled_at: "2026-09-08T00:00:00Z", captured_at: "2026-09-08T00:00:01Z",
    schema: f.sql.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND (name IN (${names}) OR tbl_name IN (${names}))
      ORDER BY type, name`).all() as unknown as BackupSnapshotUnsigned["schema"],
    tables,
    row_counts: Object.fromEntries(BACKUP_TABLES.map(({ name }) => [name, tables[name].length])) as BackupSnapshotUnsigned["row_counts"],
  });
}

async function fixture() {
  const database = migratedDatabase();
  database.sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti');
    INSERT INTO member (id, household_id, google_sub, display_name) VALUES (1, 1, 'test', 'Test');
    INSERT INTO recipe (id, household_id, title, source_text, source_route, created_by, updated_by)
      VALUES (1, 1, 'Dish', 'private text', 'pasted', 1, 1), (2, 1, 'Part', '', 'pasted', 1, 1);
    UPDATE recipe SET parent_id = 1, part_position = 1 WHERE id = 2;
  `);
  const bytes = await encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: ArrayBuffer) => { objects.set(key, new Uint8Array(value).slice()); },
    delete: async (key: string) => { objects.delete(key); },
  };
  const env = { DB: database.db, RECIPE_IMAGES: bucket } as unknown as Env;
  for (const id of [1, 2]) assert.equal(await storeRecipeImage(env, 1, id, null, bytes.slice().buffer), null);
  const snapshot = await parseAndValidateSnapshot(canonicalJson(await snapshotOf(database)));
  return { ...database, database, objects, env, snapshot, bytes,
    read: async (key: string) => objects.get(key) ?? null };
}

test("parent and part image bytes are read once per distinct key, without altering the snapshot", async () => {
  const f = await fixture();
  try {
    f.snapshot.tables.recipe[1]!.image_key = f.snapshot.tables.recipe[0]!.image_key!;
    const before = canonicalJson(f.snapshot);
    const calls: string[] = [];
    const audit = await auditBackupImages(f.snapshot, async (key) => { calls.push(key); return f.read(key); });
    assertImagesReadable(audit);
    assert.equal(audit.references, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(audit.objects[0]!.recipeIds, [1, 2]);
    assert.equal(audit.objects[0]!.sha256, createHash("sha256").update(f.bytes).digest("hex"));
    assert.equal(canonicalJson(f.snapshot), before);
  } finally { f.sql.close(); }
});

for (const action of ["replace", "delete"] as const) {
  test(`${action}: a restore outside retention does not conceal missing historical images`, async () => {
    const f = await fixture();
    const target = migratedDatabase();
    try {
      const original = new Map(f.objects);
      const baseline = await auditBackupImages(f.snapshot, f.read);
      if (action === "replace") {
        const old = f.snapshot.tables.recipe[0]!.image_key as string;
        assert.equal(await storeRecipeImage(f.env, 1, 1, old, f.bytes.slice().buffer), null);
      } else assert.equal(await deleteRecipeWithImages(f.env, 1, 1), true);
      // Deliberately exceed the supported window. The audit must still report
      // missing bytes, rather than overpromise recovery for older snapshots.
      f.sql.exec("UPDATE recipe_image_cleanup SET queued_at = '2020-01-01 00:00:00.000'");
      await cleanupDeletedRecipeImages(f.env);
      target.sql.exec(generateRestoreSql(f.snapshot));
      const restored = await snapshotOf(target);
      assertRestoredRows(f.snapshot, restored.tables);
      const audit = await auditBackupImages(restored, f.read);
      assert.throws(() => assertImagesReadable(audit), /unavailable=/);
      assert.equal(audit.objects.filter((item) => item.status === "unavailable").length, action === "delete" ? 2 : 1);
      // An independent byte copy, not a row restore, is what repairs this fixture.
      for (const [key, bytes] of original) f.objects.set(key, bytes);
      const recovered = await auditBackupImages(restored, f.read);
      assertImagesReadable(recovered);
      assert.deepEqual(recovered.objects, baseline.objects);
    } finally { f.sql.close(); target.sql.close(); }
  });
}

test("unreadable objects do not stop later keys and provider details never enter the report", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const audit = await auditBackupImages(f.snapshot, async (key) => {
      if (++calls === 1) throw new Error("credential=private-provider-detail");
      return f.read(key);
    });
    assert.equal(calls, 2);
    assert.deepEqual(audit.objects.map((item) => item.status), ["unavailable", "readable"]);
    assert.ok(!JSON.stringify(audit).includes("private-provider-detail"));
    assert.ok(!imageAuditSummary(audit).includes("recipes/"));
  } finally { f.sql.close(); }
});

test("empty, non-image and oversized responses cannot pass an image audit", async () => {
  const f = await fixture();
  try {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode("<html>denied</html>"), new Uint8Array(MAX_IMAGE_BYTES + 1)]) {
      const audit = await auditBackupImages(f.snapshot, async () => bytes);
      assert.ok(audit.objects.every((item) => item.status === "invalid"));
      assert.throws(() => assertImagesReadable(audit), /invalid=2/);
    }
  } finally { f.sql.close(); }
});

test("invalid image keys are refused before any object is requested", async () => {
  const f = await fixture();
  try {
    for (const key of ["", " ", "bad\nkey", "bad\0key", "ö".repeat(513), 42]) {
      f.snapshot.tables.recipe[1]!.image_key = key;
      let calls = 0;
      await assert.rejects(auditBackupImages(f.snapshot, async () => { calls++; return f.bytes; }), /invalid image key/);
      assert.equal(calls, 0);
    }
  } finally { f.sql.close(); }
});

test("a snapshot with no images performs no storage operations", async () => {
  const f = await fixture();
  try {
    delete f.snapshot.tables.recipe[0]!.image_key;
    f.snapshot.tables.recipe[1]!.image_key = null;
    const audit = await auditBackupImages(f.snapshot, async () => { throw new Error("not called"); });
    assert.equal(audit.references, 0);
    assert.deepEqual(audit.objects, []);
    assertImagesReadable(audit);
  } finally { f.sql.close(); }
});

test("CLI validates snapshot integrity before reading images and keeps failed reports private", async () => {
  const f = await fixture();
  const directory = mkdtempSync(join(tmpdir(), "ruokalista-image-audit-"));
  try {
    const file = join(directory, "snapshot.json");
    const report = join(directory, "report.json");
    const options = { snapshot: file, bucket: "test-images", remote: false, report };
    writeFileSync(file, canonicalJson({ ...f.snapshot, sha256: "0".repeat(64) }));
    let calls = 0;
    await assert.rejects(runImageAudit(options, async () => { calls++; return f.bytes; }), /SHA-256/);
    assert.equal(calls, 0);
    writeFileSync(file, canonicalJson(f.snapshot));
    await assert.rejects(runImageAudit(options, async () => null), /image audit failed/);
    assert.equal(statSync(report).mode & 0o777, 0o600);
    const saved = readFileSync(report, "utf8");
    assert.ok(!saved.includes("private text"));
    assert.ok(JSON.parse(saved).objects.every((item: { status: string }) => item.status === "unavailable"));
    await assert.rejects(runImageAudit(options, f.read), /EEXIST/);
    assert.equal(readFileSync(report, "utf8"), saved);
  } finally { f.sql.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("bucket selection is explicit and command construction can only GET", () => {
  const source = { bucket: "test-images", remote: false, persistTo: "/tmp/drill" };
  assert.deepEqual(r2ImageArgs(source, "recipes/1/2/test.png"), [
    "r2", "object", "get", "test-images/recipes/1/2/test.png", "--pipe", "--local", "--persist-to", "/tmp/drill",
  ]);
  assert.deepEqual(parseImageAuditArgs(["--snapshot", "backup.json", "--bucket", "test-images", "--remote"]), {
    snapshot: "backup.json", bucket: "test-images", remote: true, persistTo: undefined, report: undefined,
  });
  for (const args of [[], ["--local"], ["--bucket", "test-images", "--snapshot", "backup.json"],
    ["--bucket", "../escape", "--snapshot", "backup.json", "--local"],
    ["--bucket", "test-images", "--snapshot", "backup.json", "--remote", "--local"],
    ["--bucket", "test-images", "--snapshot", "backup.json", "--local", "--local"],
    ["--bucket", "test-images", "--snapshot", "backup.json", "--remote", "--persist-to", "scratch"],
    ["--delete"], ["--snapshot"]]) assert.throws(() => parseImageAuditArgs(args));
});

test("Wrangler reads are memory/time bounded, binary, and suppress raw failures", async () => {
  let called = false;
  const reader = createR2ImageReader({ bucket: "test-images", remote: true }, ((_node, args, options) => {
    called = true;
    assert.ok(args);
    assert.ok(options);
    assert.ok(options.env);
    assert.ok(args[0]!.endsWith("/wrangler/wrangler-dist/cli.js"));
    assert.ok(args.includes("--pipe"));
    assert.ok(args.includes("--remote"));
    assert.equal(options.maxBuffer, MAX_IMAGE_BYTES + 1);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.env.CI, "true");
    assert.equal(options.shell, undefined);
    return { status: 0, stdout: Buffer.from([1, 2, 3]) };
  }) as Parameters<typeof createR2ImageReader>[1]);
  assert.deepEqual(await reader("key"), Buffer.from([1, 2, 3]));
  assert.equal(called, true);
  for (const failure of [{ status: 1, stderr: Buffer.from("secret") }, { status: null, error: new Error("timeout secret") }]) {
    const failed = createR2ImageReader({ bucket: "test-images", remote: true }, (() => failure) as unknown as Parameters<typeof createR2ImageReader>[1]);
    await assert.rejects(failed("key"), /^Error: Image could not be read$/);
  }
});

test("the D1 restore command cannot imply that image bytes were verified", () => {
  const source = readFileSync("scripts/restore-backup.ts", "utf8");
  assert.match(source, /D1 restore verified:/);
  assert.match(source, /Image bytes were NOT checked/);
});

test("actual CLI refuses a corrupt snapshot without printing its private values", async () => {
  const { spawnSync } = await import("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "ruokalista-image-cli-"));
  try {
    const file = join(directory, "snapshot.json");
    writeFileSync(file, '{"private":"private-snapshot-sentinel"}');
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/backup-images.ts",
      "--snapshot", file, "--bucket", "test-images", "--local"], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Image audit failed/);
    assert.ok(!(result.stdout + result.stderr).includes("private-snapshot-sentinel"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
