# Private backup repository bootstrap

`stale-backup.yml` belongs in the private `eerovil/ruokalista-backup` repository as
`.github/workflows/stale-backup.yml`.

Install it with ordinary repository/admin access. Do **not** broaden the Worker's
`BACKUP_GITHUB_TOKEN`: that fine-grained PAT intentionally has only Contents
read/write on the backup repository and must not gain Workflows permission.

The workflow runs independently of Cloudflare each day. It reads `snapshot.json`,
requires a scheduled backup no older than 36 hours, opens at most one `backup stale`
issue while stale, and closes that issue when a fresh snapshot arrives.

For the later restore drill (#64), `workflow_dispatch` accepts paired
`scheduled_at_override` and `now_override` fixture timestamps so stale/fresh behavior
can be exercised without editing the real backup. A stale fixture intentionally makes
the workflow fail and may open the same `backup stale` issue; a subsequent fresh run
closes it.