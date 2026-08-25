# Private backup repository bootstrap

The private `eerovil/ruokalista-backup` repository stores `snapshot.json` and its git history. It should not run a GitHub-hosted watchdog itself: private-repository Actions can require paid minutes or billing capacity.

The independent watchdog now lives in the public source repository at `.github/workflows/backup-freshness.yml`, where GitHub-hosted Actions are free. It reads only `snapshot.json` from the private repository using a separate fine-grained PAT stored in the public repository as Actions secret `BACKUP_REPO_READ_TOKEN`.

That token must be restricted to **only** `eerovil/ruokalista-backup` with repository **Contents: Read-only** (plus the required Metadata read). It must not have write, Actions, administration, issues, or workflow permissions. Do not reuse or broaden the Worker's `BACKUP_GITHUB_TOKEN`, which intentionally has Contents read/write for writing snapshots.

The public workflow runs independently of Cloudflare each day. It checks only `snapshot.json.scheduled_at`, requires a scheduled backup no older than 36 hours, opens at most one `backup stale` issue in `eerovil/ruokalista` while stale, and closes that issue when a fresh snapshot arrives. It never copies private snapshot contents into the public repository, artifacts, issues, or logs.

For acceptance testing, `workflow_dispatch` accepts paired `scheduled_at_override` and `now_override` fixture timestamps. Supplying `scheduled_at_override` bypasses the private-repository read entirely, so stale/fresh alert behavior can be exercised safely without touching `snapshot.json` or requiring the read token.
