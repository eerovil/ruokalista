import assert from "node:assert/strict";
import test from "node:test";

import { backupSnapshotForRestoreDrill } from "../src/backup-drill.ts";
import type { Env } from "../src/env.ts";

test("restore-drill snapshot bridge is hidden without its short-lived token", async () => {
  const env = { BACKUP_GITHUB_TOKEN: "github-token" } as Env;
  const response = await backupSnapshotForRestoreDrill({
    request: new Request("https://example.test/__ops/backup-snapshot-64"),
    env,
  });
  assert.equal(response.status, 404);
});

test("restore-drill snapshot bridge refuses the wrong bearer token", async () => {
  const env = {
    BACKUP_GITHUB_TOKEN: "github-token",
    BACKUP_DRILL_TOKEN: "correct-token",
  } as Env;
  const response = await backupSnapshotForRestoreDrill({
    request: new Request("https://example.test/__ops/backup-snapshot-64", {
      headers: { Authorization: "Bearer wrong-token" },
    }),
    env,
  });
  assert.equal(response.status, 404);
});

test("authorized restore-drill bridge returns the private file without caching", async () => {
  const snapshot = '{"format_version":1,"sha256":"fixture"}\n';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer github-token");
    return Response.json({
      encoding: "base64",
      content: Buffer.from(snapshot, "utf8").toString("base64"),
    });
  };

  try {
    const env = {
      BACKUP_GITHUB_TOKEN: "github-token",
      BACKUP_DRILL_TOKEN: "drill-token",
    } as Env;
    const response = await backupSnapshotForRestoreDrill({
      request: new Request("https://example.test/__ops/backup-snapshot-64", {
        headers: { Authorization: "Bearer drill-token" },
      }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), snapshot);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
