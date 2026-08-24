# What the home server can already host

Research note for issue [#3](https://github.com/eerovil/ruokalista/issues/3). Fact-finding only — this
document does not pick or recommend a stack.

Inspected: 2026-08-24, host `Eero-bazzite`, read-only inspection as user `eero`. Every claim below
names the command or file that supports it. No credentials, tokens or key material are reproduced
here; credential-bearing files are named by path only.

---

## 1. Operating system and its constraints

| Fact | Evidence |
| --- | --- |
| Bazzite 44 (Kinoite variant, `bazzite-nvidia`), Fedora-derived, `ID_LIKE="fedora"` | `cat /etc/os-release` |
| Image-based / atomic: booted deployment is `ostree-image-signed:docker://ghcr.io/ublue-os/bazzite-nvidia:stable`, version `44.20260608` | `rpm-ostree status` |
| A newer deployment (`44.20260820`) is already staged, so the host reboots into a new image | `rpm-ostree status` (two entries, `●` marks the booted one) |
| Only three layered RPMs: `1password`, `1password-cli`, `rustdesk` | `rpm-ostree status` → `LocalPackages` |
| Kernel `7.0.9-ogc3.2.fc44.x86_64` | `uname -a` |
| Automatic OS updates run daily via `uupd.timer` | `systemctl list-timers --all` |

**Constraint that matters:** `/` is a read-only composefs (`df -hT` shows `composefs overlay 42M … 100% /`).
Installing software the usual way means either `rpm-ostree install` (layering, needs a reboot), a
container image, a Flatpak, or a user-local install under `/var/home/eero`. Everything currently
self-hosted on this box follows the last two routes — containers plus `systemd --user` units. There
is no `/usr/local` content at all (`ls /var/usrlocal/bin/` is empty) and no `cron` (`crontab` →
`command not found`, `/etc/cron.d` does not exist); scheduling is systemd timers only.

## 2. Container runtime

| Fact | Evidence |
| --- | --- |
| Podman 5.8.2, from the base image (`podman-5.8.2-1.fc44.x86_64`) | `podman --version`, `rpm -q podman` |
| **Rootless** — `Host.Security.Rootless = true`, storage at `/var/home/eero/.local/share/containers/storage` | `podman info --format '{{.Host.Security.Rootless}} {{.Store.GraphRoot}}'` |
| Docker Engine is **not** installed. `docker` is a shell alias to `podman` plus a wrapper script `/var/home/eero/.local/bin/docker` that re-exports `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` before `exec podman "$@"` | `rpm -q docker` → not installed; `command -v docker`; `head -20 /var/home/eero/.local/bin/docker` |
| Compose is the upstream Docker Compose plugin v5.1.4 installed at `~/.docker/cli-plugins/docker-compose`, driven through `podman compose` against the rootless podman socket | `ls /var/home/eero/.docker/cli-plugins/`, `podman compose version` |
| `podman.socket` (user) is **enabled**; `podman-restart.service` is **disabled** | `systemctl --user is-enabled podman.socket podman-restart.service` |
| User lingering is on, so `systemd --user` services keep running without a login session | `loginctl show-user eero \| grep Linger` → `Linger=yes` |
| No quadlets: `~/.config/containers/systemd/` does not exist | `ls -la /var/home/eero/.config/containers/systemd/` |
| Container storage is large: 247 images / 31.06 GB (27.27 GB reclaimable), 43 volumes / 29.04 GB | `podman system df` |

### How containers are actually started and kept alive

Containers are **not** managed by systemd. They carry Compose project labels
(`podman inspect sos --format '{{index .Config.Labels "com.docker.compose.project"}}'` → `outdoor`)
and a restart policy of `no` (same command, `.HostConfig.RestartPolicy.Name` → empty). They are
started by hand from the project compose files (`/home/eero/outdoor/docker-compose.yml`,
`/home/eero/storm/docker-compose.yml`, wrapped by `/home/eero/outdoor/init.sh` and
`/home/eero/storm/init.sh`) and simply survive because the host has been up 65 days
(`uptime`). With `podman-restart.service` disabled and no restart policies, **nothing brings these
containers back after a reboot** — a real gap if a household-facing service were put here as a
container.

What *is* supervised by systemd are plain `systemd --user` units (see §5 and
`ls -la /var/home/eero/.config/systemd/user/`), several of which are symlinks into the project repos.

### Containers that exist now

`podman ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'`:

| Name | Image | Status | Published ports |
| --- | --- | --- | --- |
| `sos` | `outdoor_sos:python3` | Up 5 days | 8000→8000 |
| `tilhi` | `outdoor_tilhi:python3` | Up 5 days | 8001→8000 |
| `objective_bartik` | `outdoor_metso:python3` | Up 3 days | 18003→8000 |
| `soi` | `outdoor_soi:python3` | Created (not running) | 8002→8000 |
| `metso` | `outdoor_metso:python3` | Created (not running) | 8003→8000 |
| `so_nginx` | `nginx:stable` | Up 7 weeks | 8080-8081, 8443→8080 |
| `so_db` | `outdoor-so_db` (MySQL) | Up 5 days | 13306→3306 |
| `so_redis` | `redis:4-alpine` | Up 5 days | internal 6379 |
| `so_rabbitmq` | `rabbitmq:3.6-management` | Up 5 days | 15672 |
| `so_flower` | `outdoor-so_flower` | Exited (0) 2 months | 5555 |
| `6d0b5fc43f47_sentry_mcp` | `outdoor-sentry_mcp` | Up 2 weeks | internal 8000 |
| `storm-storm-1` | `storm:python3` | Up 2 months | 5678 (debugpy) |
| `storm-nginx-1` | `nginx:stable` | Up 2 months | 8090→80 |
| `storm-mariadb-1` | `mysql:8.0` | Up 5 weeks | 3307→3306 |
| `storm-redis-1` | `redis:7` | Up 2 months | internal 6379 |
| `storm-elasticsearch-1` | `elasticsearch:8.14.1` | Up 5 weeks | internal 9200/9300 |
| `storm_sentry_mcp` | `storm-sentry_mcp` | Exited 2 weeks ago | 8000 |
| `maildump` | `ball6847/maildump` | Up 2 months | 1080→1080 |
| `stemma-dev` | `node:22-bookworm` | Exited (1) 2 months | 5173 |

All of these are **work development stacks** (outdoor = Scandinavian Outdoor, storm = Protecomp), not
household services. Note `storm-mariadb-1` is named "mariadb" but runs the `mysql:8.0` image.

## 3. What is already serving HTTP, and how the household reaches it

Tailscale 1.98.4 (`tailscale version`) is the only remote-access path.

`tailscale serve status`:

```
https://bazzite.taile8d16e.ts.net        (tailnet only)  /  -> proxy http://127.0.0.1:8756
https://bazzite.taile8d16e.ts.net:8123   (tailnet only)  /  -> proxy http://127.0.0.1:8123
https://bazzite.taile8d16e.ts.net:8758   (tailnet only)  /  -> proxy http://127.0.0.1:8757
```

`tailscale funnel status` shows the same three entries all marked **"tailnet only"** — nothing is
published to the public internet. So the pattern already in use is: bind a service to `127.0.0.1`,
then `tailscale serve` it on an HTTPS port of the tailnet name.

Who owns those local ports (`ss -tlnp`, then `ps -o pid,args -p <pid>`):

| Local port | Process |
| --- | --- |
| 127.0.0.1:8756 | `/home/eero/agentdeck/.venv/bin/python -m agentdeck.web_supervisor` (socket-activated, `ListenStream=127.0.0.1:8756` in `/home/eero/agentdeck/systemd/agentdeck.socket`) |
| 127.0.0.1:8757 | the same for `agentdeck-staging` (`ListenStream=127.0.0.1:8757`) |
| 127.0.0.1:8123 | `/var/home/eero/musescore-choir-plugins/.venv/bin/python song.py --host 127.0.0.1 --port 8123` |

Worth flagging: port **8123 is the Home Assistant default port, but here it is the MuseScore choir
"song" app**. Home Assistant itself does **not** run on this host — `/home/eero/hass` is only tooling
for a separate Home Assistant OS box, reached over an rclone SMB FUSE mount (`ha-mount.service`:
`rclone mount ha: %h/ha`, `Documentation=https://rclone.org/smb/`).

`tailscale status` shows a three-node tailnet: this host `bazzite` (100.106.174.60),
`eeros-macbook-air`, `oneplus-nord-4` — all owned by the same account. That is the household's
device fleet. `tailscale status` also reports a health warning: *"Tailscale can't reach the
configured DNS servers"*.

**Reverse proxies:** there is no host-level reverse proxy. `command -v caddy nginx traefik` finds
nothing on the host. nginx 1.30.2 exists only inside the `so_nginx` and `storm-nginx-1` containers
(`podman exec so_nginx nginx -v`), serving the work dev stacks on 8080/8081/8443/8090.

**LAN exposure:** `firewall-cmd --list-all` shows zone `FedoraWorkstation` active on `enp0s31f6` with
`ports: 1025-65535/udp 1025-65535/tcp` open. All the container-published ports (8000, 8001, 8080,
8090, 3307, 13306, 15672, 18003, 1080 …) bind `0.0.0.0`/`*` per `ss -tlnp`, so they are reachable
from the LAN, not just localhost. Only the three Tailscale-served apps are bound to loopback.

## 4. Databases already running or installed

| Engine | State | Version | Evidence |
| --- | --- | --- | --- |
| MySQL 8 (`so_db`, outdoor dev) | running, published on host port **13306** | `mysql Ver 8.0.45` | `podman exec so_db mysql --version` |
| MySQL 8 (`storm-mariadb-1`, storm dev) | running, published on host port **3307** | `mysql Ver 8.0.46` | `podman exec storm-mariadb-1 mysql --version` |
| Redis (`so_redis`) | running, container-internal only | `4.0.14` | `podman exec so_redis redis-server --version` |
| Redis (`storm-redis-1`) | running, container-internal only | `7.4.9` | `podman exec storm-redis-1 redis-server --version` |
| Elasticsearch (`storm-elasticsearch-1`) | running, container-internal | `8.14.1` (JVM 22.0.1) | `podman exec storm-elasticsearch-1 elasticsearch --version` |
| RabbitMQ (`so_rabbitmq`) | running, mgmt UI on 15672 | version not determined — `podman exec so_rabbitmq rabbitmqctl version` returned empty output; image tag is `rabbitmq:3.6-management` | `podman ps` |
| **PostgreSQL** | **not present anywhere** | — | `command -v psql` → nothing; `podman images \| grep -i postgres` → no match; `grep -ril postgres` over `/home/eero/{outdoor,storm}/docker-compose.yml` and `/home/eero/hass/compose.yaml` → no match |
| MariaDB | not running; a stale `mariadb:11.3` image from ~2 years ago exists | `podman images \| grep -i mariadb` |
| SQLite | no `sqlite3` CLI on the host, but the Python stdlib module reports SQLite **3.51.2** | `command -v sqlite3` → nothing; `python3 -c "import sqlite3; print(sqlite3.sqlite_version)"` |

**SQLite is the household pattern.** The three genuinely household-facing projects all use SQLite
files, not a server: `~/.local/share/agentdeck/agentdeck.db` (+ `-wal`/`-shm`) and
`~/.cache/agentdeck/github_metadata.sqlite3` for agentdeck (`/home/eero/agentdeck/src/agentdeck/db.py`);
`/home/eero/actual-api/data/My-Finances-adbcaa7/db.sqlite`; and Home Assistant's own recorder DB
`~/hass/config/home-assistant_v2.db` on the mounted HA box. `mysql` client 8.x is present on the
host (`command -v mysql` → `/usr/bin/mysql`) from the base image.

Reachability was inferred from listening sockets and container state; no connection attempt was made,
because that would need credentials.

## 5. Language runtimes on the host, and what the neighbouring projects are

### Host runtimes

`python3 --version` etc., run one per command:

| Runtime | Result |
| --- | --- |
| Python | **3.14.5** (system, from the OS image) |
| `uv` | **0.11.26** (`/home/eero/.local/bin/uv`) — the project venv manager in use |
| git | 2.54.0 |
| Node / npm | **not on the host** (`node --version` → command not found; `rpm -q nodejs` → not installed). Node exists only inside container images (`node:22-bookworm`, `node:22-alpine`, `node:20`) and as a vendored binary inside agentdeck's venv (a `cursor_sdk` bridge). |
| Go, Rust/Cargo, Java, PHP, Ruby, Deno, Bun, pnpm, sqlite3 | not found on the host |
| Version managers | none: `.nvm`, `.volta`, `.bun`, `.cargo`, `.sdkman`, `mise` all absent |

So the host's only first-class native runtime is **Python 3.14 + uv**. Anything else has to arrive in
a container (JDK/Gradle and Node images are already pulled) or via `rpm-ostree` layering.

### Neighbouring projects in /home/eero

Established by reading each repo's manifests, unit files and compose files (paths given):

| Project | Language | Framework | How it is deployed |
| --- | --- | --- | --- |
| **agentdeck** (`/home/eero/agentdeck`) | Python ≥3.12, uv-managed (`pyproject.toml`, `uv.lock`) | FastAPI + uvicorn + Jinja2 | `systemd --user`, socket-activated: `systemd/agentdeck.service` + `agentdeck.socket` on 127.0.0.1:8756, plus `agentdeck-poller@.service/.timer` and a self-deploy timer `agentdeck-deploy.timer` running `scripts/deploy-live.sh` (git fetch → `uv sync` → hot reload). Data: SQLite. A staging copy runs the same way on 8757 from `/home/eero/agentdeck-staging`. |
| **hass** (`/home/eero/hass`) | YAML + shell, one stdlib Python script | none (Home Assistant config) | Not an app. `compose.yaml` only runs a `cytopia/yamllint` lint container. Live HA lives on a separate HAOS box, mounted here by `ha-mount.service` (rclone SMB). Data: HA's own SQLite recorder. |
| **outdoor** (`/home/eero/outdoor`) | Python 3.10 in-container, Node 20.19.5 for the frontend | Django (`sos` on Django ~5.1, `metso` on Django 3.1) + Nuxt/Vue 3 (pnpm) | Local dev only on this host: Compose devcontainers from `docker-compose.yml` + `docker-compose-base.yml` via `init.sh`. Real deploys go to Kubernetes via Drone CI + Helm (`.drone.yml`, `helm/`). DB: MySQL 8, plus Redis/RabbitMQ/Elasticsearch. Work project, not household. |
| **storm** (`/home/eero/storm`) | Python 3.10.14 in-container | Django ~4.2 + Vue 2/webpack 4 | Local dev via `docker-compose.yml` + `init.sh` (nginx 8090, debugpy 5678). Production deploy is Fabric over SSH (`deploy.sh prod\|staging`, `conf/fabric/fabfile.py`), **not** containers, with cron files in `conf/cron/`. DB: MySQL 8, Redis 7, Elasticsearch 8.14.1. Work project. |
| **actual-api** (`/home/eero/actual-api`) | Node (CommonJS), one dep `@actual-app/api`; small stdlib Python helper `notify.py` | none (CLI/report script) | `systemd --user` timers `actual-classify.timer`, `actual-report.timer`, `actual-report-daily.timer`, which shell out to `run.sh` → `podman run … docker.io/library/node:20 node actual.js`. Output is written into the HA config and pushed as a phone notification. Data: local SQLite cache. **This is the closest existing analogue to a household app.** |
| **musescore-choir-plugins** (`/home/eero/musescore-choir-plugins`) | Python (venv) | small Python web app (`song.py`) | `systemd --user` `song-app.service` binding 127.0.0.1:8123, plus a `song-app-deploy.timer` auto-deployer; exposed through `tailscale serve` on port 8123. Has the one real backup script on the box. |
| ruokalista (this repo) | — | — | docs only so far. |

Other top-level dirs (`ls -la /home/eero`): `agentdeck-pass5`, `agentdeck-staging`,
`musescore-choir-plugins-mobile`, `pokefirered-fi`, `stemmanauhat`, `terraria-fi`, `asemakaava_out`,
`ha` (rclone mount).

**Takeaway on cost of maintenance (fact, not a recommendation):** the household-facing pattern this
host already runs, three times over, is *Python venv managed by uv + a `systemd --user` unit bound to
127.0.0.1 + `tailscale serve` + a SQLite file*, with an optional auto-deploy timer that pulls from
git. MySQL, Redis, Elasticsearch and Compose are present but exclusively serve work dev stacks.

### Credential-bearing config (paths only, contents not inspected/copied)

`/home/eero/agentdeck/.env`, `~/.config/agentdeck/config.toml`, `/home/eero/hass/.env`,
`/home/eero/hass/config/secrets.yaml`, `/home/eero/hass/config/SERVICE_ACCOUNT.json`,
`/home/eero/outdoor/.env`, `/home/eero/storm/.env`,
`/home/eero/storm/stormfi/google/storm-translation-api.json`, `/home/eero/actual-api/.env`,
`/home/eero/actual-api/ids.env`, `~/.config/rclone/rclone.conf`. The work compose files also carry
inline dev database passwords. Nothing from these files is reproduced in this document.

## 6. Backups of service data

Searched with `find /var/home/eero -maxdepth 3 -iname '*backup*'`, `systemctl --user list-timers
--all`, `systemctl list-timers --all`, `command -v restic borg rsnapshot`, `snapper list-configs`.

| Finding | Evidence |
| --- | --- |
| **No general backup system for host service data.** No backup or dump timer exists among the 13 user timers or the 8 system timers | `systemctl --user list-timers --all`, `systemctl list-timers --all` |
| No `restic`, `borg` or `rsnapshot` installed | `command -v restic borg rsnapshot` → nothing |
| `snapper` and `btrfs` binaries exist, but **snapper has zero configs**, so no btrfs snapshots are being taken | `snapper list-configs` → header row only |
| No cron at all | `crontab` → command not found; `/etc/cron.d` absent |
| **Home Assistant backs itself up** — daily tarballs land on the mounted HAOS share, most recent `Automatic_backup_2026.7.1_2026-08-24_04.46_43003659.tar` | `find /var/home/eero -maxdepth 3 -iname '*backup*'` listing `/var/home/eero/ha/BACKUP/` |
| The only hand-written backup script on the box is `/home/eero/musescore-choir-plugins/backup.sh`, which copies `*.mscz` files into a local `./backup` directory (no offsite copy) | file exists; same script duplicated in `musescore-choir-plugins-mobile` |
| The work repos have DB *dump/refresh* tooling, not backups of household data: `/home/eero/outdoor/drone/dump_db.sh` (mysqldump), `/home/eero/outdoor/Docker/bin/download-dump.sh` (pulls prod dumps from UpCloud S3), `/home/eero/storm/Docker/reset-database`. Leftover artifacts: `/home/eero/outdoor/xtrabackup/`, `/home/eero/storm/pricehistory_backup_20260612_1012.sql.gz` | paths exist |
| agentdeck's and actual-api's SQLite databases are **not backed up** by anything found | no timer, script or tool references them |

**Bottom line:** whatever data a household app stores here would currently have no backup unless one
is created for it. `rclone` (0.x, `~/.local/bin/rclone`) is already installed and configured with at
least one remote, which is the nearest existing building block.

## 7. Resource headroom

| Resource | Value | Evidence |
| --- | --- | --- |
| CPU | Intel Core i5-6400 @ 2.70 GHz, **4 cores** (no SMT) | `nproc`, `grep 'model name' /proc/cpuinfo` |
| Load | 2.15 / 1.83 / 1.73 on 4 cores — the box is already ~45% busy | `uptime` |
| RAM | **39 GiB total**, 19 GiB used, **19 GiB available** | `free -h` |
| Swap | 15 GiB total, **10 GiB already in use** — notable pressure given 19 GiB "available" | `free -h` |
| Main disk | `/dev/nvme0n1p3` btrfs, 237 GB, 189 GB used, **46 GB free (81% used)**, carrying `/var`, `/var/home` and `/etc` | `df -hT` |
| Second disk | `/dev/sda3` btrfs, 236 GB, 22 GB used, **212 GB free (10%)**, mounted at `/run/media/system/bazzite00` | `df -hT` |
| `/boot` | 974 MB, 267 MB free | `df -hT` |
| Reclaimable container space | 27.27 GB of images plus 2.2 GB of volumes | `podman system df` |
| Uptime | 65 days | `uptime` |

CPU and free disk on the primary filesystem are the tight resources; RAM is plentiful, though 10 GiB
of swap in use suggests the current workload already spills.

---

## Not determined

- RabbitMQ's exact running version (`rabbitmqctl version` produced no output inside `so_rabbitmq`);
  only the image tag `rabbitmq:3.6-management` is known.
- Whether the MySQL/Redis instances are actually *usable* by a new app — no connection was attempted,
  since that needs credentials, and both are dev stacks that get reset by `reset-database` tooling.
- Whether the running containers would come back after a reboot was inferred from
  `podman-restart.service` being disabled and restart policies being `no`; it was not tested (that
  would require a reboot).
- Btrfs snapshot history beyond snapper: `btrfs subvolume list /` requires root and no
  non-interactive sudo was available (`sudo -n` → "a password is required").
- Total tailnet membership beyond the three devices listed by `tailscale status`; ACLs and the
  tailnet's admin-side config were not inspected.
