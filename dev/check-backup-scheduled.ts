import assert from "node:assert/strict";
import test from "node:test";

import { scheduledBackup } from "../src/backup-scheduled.ts";

test("scheduled backup logs invocation and failure metadata before rethrowing", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));

  try {
    await assert.rejects(
      scheduledBackup(
        {
          scheduledTime: Date.parse("2026-08-25T18:15:00.000Z"),
          cron: "*/5 * * * *",
        },
        { DB: {} as D1Database },
      ),
      /BACKUP_GITHUB_TOKEN is not configured/,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]!), {
    event: "backup.scheduled_started",
    scheduled_at: "2026-08-25T18:15:00.000Z",
    cron: "*/5 * * * *",
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(errors[0]!), {
    event: "backup.scheduled_failed",
    scheduled_at: "2026-08-25T18:15:00.000Z",
    cron: "*/5 * * * *",
    error: "BACKUP_GITHUB_TOKEN is not configured",
  });
});
