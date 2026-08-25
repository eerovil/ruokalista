import { runNightlyBackup } from "./backup.ts";

interface BackupScheduledEnv {
  DB: D1Database;
  BACKUP_GITHUB_TOKEN?: string;
}

/** The Cron Trigger entrypoint, kept independent of the HTTP router. */
export async function scheduledBackup(
  controller: Pick<ScheduledController, "scheduledTime" | "cron">,
  env: BackupScheduledEnv,
): Promise<void> {
  const scheduledAt = new Date(controller.scheduledTime).toISOString();
  console.log(JSON.stringify({
    event: "backup.scheduled_started",
    scheduled_at: scheduledAt,
    cron: controller.cron,
  }));

  try {
    await runNightlyBackup(env, controller.scheduledTime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "backup.scheduled_failed",
      scheduled_at: scheduledAt,
      cron: controller.cron,
      error: message,
    }));
    throw error;
  }
}
