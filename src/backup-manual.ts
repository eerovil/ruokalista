import { runNightlyBackup } from "./backup.ts";
import type { RouteContext } from "./router.ts";

// Temporary #64 acceptance hook. A fixed timestamp makes repeated calls
// idempotent, so even an accidental retry cannot create a stream of commits.
const MANUAL_BACKUP_SCHEDULED_TIME = Date.parse("2026-08-25T14:40:00.000Z");

export async function manualBackupSmoke({ env }: RouteContext): Promise<Response> {
  try {
    const result = await runNightlyBackup(env, MANUAL_BACKUP_SCHEDULED_TIME);
    return Response.json({
      status: "ok",
      scheduled_at: result.scheduledAt,
      committed: result.committed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown backup error";
    console.error(JSON.stringify({ event: "backup.manual_failed", error: message }));
    return Response.json({ status: "error", error: message }, { status: 500 });
  }
}
