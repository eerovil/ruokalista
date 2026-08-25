import { runNightlyBackup } from "./backup.ts";

interface BackupScheduledEnv {
  DB: D1Database;
  BACKUP_GITHUB_TOKEN?: string;
}

/** The Cron Trigger entrypoint, kept independent of the HTTP router. */
export async function scheduledBackup(
  controller: Pick<ScheduledController, "scheduledTime">,
  env: BackupScheduledEnv,
): Promise<void> {
  await runNightlyBackup(env, controller.scheduledTime);
}