# Where a public app can run

Research note for issue [#10](https://github.com/eerovil/ruokalista/issues/10). **Fact-finding only —
this document does not choose a hosting target.** Where ruokalista runs is deliberately fog on the
map (#1); the only thing locked is that the app must be reachable from the public web (#7).

Host inspection: 2026-08-24, host `Eero-bazzite`, read-only as user `eero`. Nothing was installed,
started, stopped or reconfigured; no port was opened; Funnel was **not** enabled. Product behaviour
is cited to official vendor documentation, fetched 2026-08-24. Prices move — re-check before
deciding. No credentials, tokens or key material appear below; credential-bearing files are named
by path only.

---

## 0. What the app actually needs (from decisions already locked)

These come from other tickets and are the yardstick the candidates are measured against.

| Requirement | Source |
| --- | --- |
| Reachable from the public web over HTTPS, any browser, no Tailscale on phones | [#7](https://github.com/eerovil/ruokalista/issues/7) |
| A stable public hostname — Google sign-in is the only gate, and OAuth needs a fixed redirect URI | [#8](https://github.com/eerovil/ruokalista/issues/8) |
| A small relational store that survives redeploys and holds years of menus | [#5](https://github.com/eerovil/ruokalista/issues/5), [#6](https://github.com/eerovil/ruokalista/issues/6) |
| Backups are mandatory, not a preference | [#7](https://github.com/eerovil/ruokalista/issues/7) |
| An outbound call to a language-model API at import time, which can take tens of seconds → **per-request timeout limits and outbound network policy matter** | [#4](https://github.com/eerovil/ruokalista/issues/4), [#9](https://github.com/eerovil/ruokalista/issues/9) |
| **No** blob/object storage requirement — images are discarded at import | [#4](https://github.com/eerovil/ruokalista/issues/4) |
| Traffic: one household, one or two concurrent users | [#1](https://github.com/eerovil/ruokalista/issues/1) |

---

## 1. Candidate A — the existing home server

### 1.1 What is on the machine today

Verified this session; the deeper inventory is in
[`what-the-home-server-hosts.md`](https://github.com/eerovil/ruokalista/blob/research/home-server-inventory/docs/research/what-the-home-server-hosts.md) (#3).

| Fact | Evidence |
| --- | --- |
| Bazzite 44 (Kinoite/`bazzite-nvidia`), image-based via `rpm-ostree`. Booted `44.20260608`; **a newer image `44.20260820` is already staged**, so the next reboot changes the OS | `rpm-ostree status` |
| Only three layered RPMs (`1password`, `1password-cli`, `rustdesk`) | `rpm-ostree status` → `LocalPackages` |
| Podman 5.8.2, rootless | `podman --version` |
| **No** `cloudflared`, `caddy`, `nginx`, `traefik`, `certbot`, `restic` or `borg` on the host | `command -v cloudflared caddy nginx traefik certbot restic borg` → exit 1, no output |
| Uptime 65 days; load 2.50/1.98/1.89 on 4 cores | `uptime` |
| 39 GiB RAM, 19 GiB available, but **10 GiB of 15 GiB swap already in use** | `free -h` |
| Primary btrfs at 81% (46 GB free); a second disk has 212 GB free | `df -hT` |
| Behind NAT: LAN address `192.168.34.181/24`, default gateway `192.168.34.1`, and a **different** public IPv4 seen from outside | `ip route show default`, `ip -4 -o addr show`, `curl -s https://api.ipify.org` (value not reproduced here) |

### 1.2 Tailscale Funnel — what it is and whether it is even permitted here

Tailscale 1.98.4 is installed (`tailscale version`). Three services are exposed, all **tailnet
only**, none public:

```
$ tailscale funnel status
https://bazzite.taile8d16e.ts.net (tailnet only)      -> proxy http://127.0.0.1:8756
https://bazzite.taile8d16e.ts.net:8123 (tailnet only) -> proxy http://127.0.0.1:8123
https://bazzite.taile8d16e.ts.net:8758 (tailnet only) -> proxy http://127.0.0.1:8757
```

**Is Funnel permitted on this tailnet? Almost certainly not, today.** Funnel requires "a `funnel`
node attribute in your tailnet policy file"
([docs](https://tailscale.com/docs/features/tailscale-funnel)). Reading this node's netmap
read-only, the self node's capability map contains `https` but **no `funnel` entry**:

```
$ tailscale debug netmap | python3 -c "...print sorted(SelfNode.CapMap.keys())"
['default-auto-update', 'https', 'https://tailscale.com/cap/file-sharing',
 'https://tailscale.com/cap/is-admin', 'https://tailscale.com/cap/is-owner',
 'https://tailscale.com/cap/ssh', 'https://tailscale.com/cap/tailnet-lock',
 'probe-udp-lifetime', 'ssh-behavior-v1', 'ssh-env-vars', 'store-appc-routes',
 'tailnet-display-name']
```

The presence of `https` is itself useful: HTTPS Certificates **are** already enabled for this
tailnet, which is one of Funnel's prerequisites
([kb/1153](https://tailscale.com/kb/1153/enabling-https)).

> **Gap.** Tailscale does not document that node attributes surface as `CapMap` keys — the
> documented check is `tailscale funnel status`, and the admin-console policy file was not
> inspected (that is a browser action, and inspecting it is outside a read-only host check). So
> "Funnel is not in the policy file" is a strong inference from the netmap, not a doc-confirmed
> fact. Confirming it means looking at the Access controls page in the admin console.

**What would have to change here, unchanged so far:** add the node attribute to the tailnet policy
file —

```json
"nodeAttrs": [ { "target": ["autogroup:member"], "attr": ["funnel"] } ]
```

— either by hand, or via Access controls → Funnel → "Add Funnel to policy", or by running
`tailscale funnel …` once and approving the web prompt it opens, which "triggers a web interface
that prompts you to approve enabling Funnel" and then provisions certificates and updates the
policy file ([docs](https://tailscale.com/docs/features/tailscale-funnel)). Then
`tailscale funnel --bg 443 …` for a persistent public listener
([CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel)). **None of this was
done.**

### 1.3 Funnel's documented shape

| Property | Fact | Source |
| --- | --- | --- |
| Ports | "Funnel can only listen on ports `443`, `8443`, and `10000`." Arbitrary public ports are impossible. The *local* target port is arbitrary. | [funnel](https://tailscale.com/docs/features/tailscale-funnel), [CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel) |
| Hostname | Only names in the tailnet's own domain: `machine.tailnet-name.ts.net`, i.e. `https://bazzite.taile8d16e.ts.net`. **No custom domain.** MagicDNS required. | [funnel](https://tailscale.com/docs/features/tailscale-funnel) |
| TLS | Let's Encrypt certificates for `machine.tailnet.ts.net`, provisioned by Tailscale when Funnel is enabled. | [kb/1153](https://tailscale.com/kb/1153/enabling-https), [funnel](https://tailscale.com/docs/features/tailscale-funnel) |
| Proxy target | "Only `http://127.0.0.1` is currently supported for proxies." Matches the pattern this host already uses. | [CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel) |
| Bandwidth | "Traffic sent over a Funnel is subject to non-configurable bandwidth limits." **No number is published.** | [funnel](https://tailscale.com/docs/features/tailscale-funnel) |
| Routing | Traffic egresses through Tailscale's "TCP proxy and Funnel relay servers"; public clients "cannot connect directly to your machine". Relays "do not decrypt the traffic". | [funnel](https://tailscale.com/docs/features/tailscale-funnel), [examples](https://tailscale.com/docs/reference/examples/funnel) |
| Identity | Funnel requests carry **no** Tailscale identity headers (unlike Serve) — so the app must do all its own auth. Consistent with #8. | [serve](https://tailscale.com/docs/features/tailscale-serve) |
| Cost | "Tailscale Funnel is available for all plans", free plan included. | [funnel](https://tailscale.com/docs/features/tailscale-funnel), [pricing](https://tailscale.com/pricing) |
| Privacy | All certs are logged in public Certificate Transparency logs, so `bazzite.taile8d16e.ts.net` becomes publicly discoverable. "Do not enable the HTTPS feature if any of your machine names contain sensitive information." | [kb/1153](https://tailscale.com/kb/1153/enabling-https) |
| Cert rate limit | Requesting certs too often can hit Let's Encrypt limits: "you may find yourself waiting 34 hours until you can try again." | [kb/1153](https://tailscale.com/kb/1153/enabling-https) |
| Abuse policy | A Funnel-specific AUP applies; Tailscale "retains full discretion to take action… including account suspension, account termination, or removal of content." Funnel has been abused for phishing in the wild and Tailscale enforces actively. | [funnel-aup](https://tailscale.com/funnel-aup), [security bulletins](https://tailscale.com/security-bulletins) |
| DNS propagation | Public DNS records "can take up to 10 minutes to show up". | [funnel](https://tailscale.com/docs/features/tailscale-funnel) |

**Can it front a small household app?** Nothing in the documentation forbids it; Tailscale's own
framing of the intended use is "share access to a local development server, test a webhook, or even
host a blog" ([Funnel beta blog](https://tailscale.com/blog/tailscale-funnel-beta)). For one
household's traffic that is a plausible fit. The hard constraints are the fixed `.ts.net` hostname
(no custom domain, and the name is published to CT logs) and the fact that the app must still be
kept running and backed up on this host regardless — Funnel solves ingress, nothing else.

> **Gaps on Funnel (docs are silent, do not guess):** no numeric bandwidth figure; no documented
> concurrent-connection, request-rate, body-size or **timeout** limits — the last matters directly
> for the slow LLM call at import; WebSocket support is never stated; no documented source-IP
> allowlisting; no documented access logging; no published latency figures for relay ingress; and
> no official statement either endorsing or forbidding production use.

### 1.4 What survives a reboot on this host — verified

This is the sharpest finding about the home server, and it is worse than #3 reported.

| Mechanism | Survives reboot? | Evidence |
| --- | --- | --- |
| `systemd --user` units | **Yes.** Lingering is enabled, so user units start at boot without a login session. | `loginctl show-user eero \| grep -i linger` → `Linger=yes`; [`loginctl(1)`](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html) `enable-linger` |
| Existing containers | **No.** 17 of 19 have restart policy `no`; two (`6d0b5fc43f47_sentry_mcp`, `storm_sentry_mcp`) are `unless-stopped`. And `podman-restart.service` — the unit that would start them — is `disabled`/`inactive`. | `podman inspect --format '{{.HostConfig.RestartPolicy.Name}}'` over all 19; `systemctl --user is-enabled podman-restart.service` → `disabled`; `systemctl --user is-active …` → `inactive` |
| Quantified: containers eligible to start at boot | **Exactly 1 of 19.** | `podman ps -a --filter should-start-on-boot=true` → only `6d0b5fc43f47_sentry_mcp` |
| Quadlets | None exist. | `ls /var/home/eero/.config/containers/systemd/` → No such file or directory |

A nuance worth correcting from #3: `unless-stopped` **does** come back at boot — podman's docs say
"After a system reboot, containers with this policy will be restarted by `podman-restart.service`
only if they were not explicitly stopped by the user before the reboot"
([`podman-run`](https://docs.podman.io/en/latest/markdown/podman-run.1.html)), and the
`should-start-on-boot` filter is documented as "True for containers with restart policy 'always', or
'unless-stopped' that were not explicitly stopped by the user"
([`podman-restart`](https://docs.podman.io/en/latest/markdown/podman-restart.1.html)). So the count
of 1 above is podman's own answer, and it is 1 rather than 2 because `storm_sentry_mcp` was stopped
by hand. Either way, with `podman-restart.service` disabled, **zero** come back.

`podman-restart.service` ships in the base image at `/usr/lib/systemd/user/podman-restart.service`
and runs `podman start --all --filter should-start-on-boot=true`
(`systemctl --user cat podman-restart.service`). So enabling it needs **no** `rpm-ostree` layering
and no reboot to install — it is a one-line `systemctl --user enable` — but it was not enabled here.

**What a new service on this host would need to come back after a reboot** — one of:

1. A `systemd --user` unit with `[Install] WantedBy=default.target`, relying on the lingering that
   is already on. This is exactly what agentdeck and the MuseScore app already do, three times over,
   and it is the only supervision on this box that demonstrably works across boots.
2. A Podman **Quadlet** file in `~/.config/containers/systemd/`, which podman's generator turns into
   a systemd unit; with `WantedBy=default.target` it starts at boot
   ([`podman-systemd.unit`](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)).
   Quadlet is the current recommendation; `podman generate systemd` is deprecated in its favour
   ([`podman-generate-systemd`](https://docs.podman.io/en/latest/markdown/podman-generate-systemd.1.html)).
3. A container with `--restart=always` **plus** `podman-restart.service` enabled.

Plus, for the ingress: `tailscale funnel --bg` persists across reboots
([CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)), and the existing
`tailscale serve` config already survives — it is stored in tailscaled's state, not in a unit file.

> **Gap.** Reboot survival was established from configuration, not by rebooting. Nobody rebooted
> this machine to test it. Note that with a new OS image already staged, the next reboot is also an
> OS change — so the first real test of "does it come back" would coincide with an OS upgrade.

### 1.5 Exposure today, and what a public listener changes

Firewall (`firewall-cmd --list-all`):

```
FedoraWorkstation (default, active)
  interfaces: enp0s31f6
  services: dhcpv6-client samba-client ssh
  ports: 1025-65535/udp 1025-65535/tcp
```

Listening sockets (`ss -tlnp`), grouped by what they are bound to:

| Binding | Ports | Reachable from |
| --- | --- | --- |
| `0.0.0.0` / `*` (all interfaces) | 22 (sshd), 1080, 3307, 5355, 5678, 8000, 8001, 8080, 8081, 8090, 8443, 13306, 15672, 1716 (kdeconnect) | **The LAN.** Not the internet, because the host is behind NAT and nothing forwards these. |
| `127.0.0.1` | 631, 8123, 8756, 8757, plus ephemeral tool ports | Localhost only |
| Tailscale IP `100.106.174.60` / `fd7a:…` | 443, 8123, 8758 | The 3-device tailnet only |

**Plainly, today:** nothing on this host is reachable from the public internet. The host has an
RFC1918 address behind a router, the public IPv4 seen from outside differs from the LAN address, and
`tailscale funnel status` reports every service as "tailnet only". The firewall's wide
`1025-65535/tcp` opening is a **LAN** exposure, not an internet one — it is the reason every
container-published port (a MySQL on 13306, another MySQL on 3307, a RabbitMQ management UI on
15672, a debugpy remote-debug port on 5678, six Django dev servers, two nginxes, a mail catcher on
1080) is reachable from any device on the home network.

**What a public listener would change — and what it would not:**

- **Tailscale Funnel or a Cloudflare Tunnel would change almost nothing about the above.** Both are
  outbound-initiated: the daemon dials out and the provider relays traffic back down that
  connection. No inbound port is opened, no firewall rule changes, and the LAN-only services stay
  LAN-only. Only the one hostname/port pair you explicitly publish becomes public. Funnel is also
  restricted to proxying `http://127.0.0.1` targets, which structurally limits the blast radius.
- **A reverse proxy on the host with its own certificates is different in kind.** ACME's HTTP-01 and
  TLS-ALPN-01 challenges need the public internet to reach port 80 / 443 on this machine, which
  means a router port-forward — a real inbound hole, in front of a machine whose firewall already
  trusts the whole 1025-65535 range from the LAN side.
- Either way, the app itself becomes the security perimeter. Funnel strips no requests and adds no
  identity headers; Google sign-in (#8) is the only gate.

**Things worth flagging, not fixed:**

1. `sshd` listens on `0.0.0.0:22` and `ssh` is an allowed firewall service — LAN-wide SSH. Fine
   today; it becomes interesting the moment anything forwards a port from the router.
2. Two MySQL 8 instances (3307, 13306) and a RabbitMQ management UI (15672) are LAN-reachable, and
   the work compose files carry inline dev passwords. Dev credentials on a home LAN.
3. A debugpy listener on `*:5678` is a remote code execution surface by design, reachable LAN-wide.
4. `firewalld` opening `1025-65535` on both TCP and UDP means the firewall provides essentially no
   protection above 1024 on the LAN interface — any future service that binds `0.0.0.0` is
   published to the house by default, with no explicit decision.
5. The booted OS image is 2.5 months old with an update staged that carries "2 critical, 21
   important" security advisories (`rpm-ostree status`). Uptime 65 days on an auto-updating OS means
   the updates are downloading but not being applied.
6. `net.ipv4.ip_unprivileged_port_start = 1024` (`sysctl`), so a rootless container **cannot** bind
   host port 80 or 443 as-is. Relevant to the reverse-proxy option below, and the workaround
   (lowering that sysctl) makes all privileged ports bindable by any unprivileged process on the
   box.

### 1.6 Backups from this host, and the restore story

Re-verified this session: `snapper list-configs` returns a header row and nothing else (no btrfs
snapshots configured); no backup job appears among the 8 system timers or the 13 user timers
(`systemctl list-timers --all`, `systemctl --user list-timers --all`); no `restic`/`borg` installed.

`rclone` v1.74.3 is at `/home/eero/.local/bin/rclone`, config at `~/.config/rclone/rclone.conf`
(path only; contents not reproduced). It has **exactly one remote**:

```
$ rclone listremotes
ha:
```

and that remote is **type `smb`, pointing at a private/RFC1918 LAN address** (established by parsing
only the `type` field and classifying the `host` field as private via `ipaddress.ip_address`; no
credential value was read or printed). It is mounted at `/var/home/eero/ha` by `ha-mount.service`
and is the Home Assistant box's share — where HA drops its own daily backup tarballs.

**So the honest reading of "rclone is already installed and configured" is: configured against
another machine in the same house.** There is no cloud remote, no offsite copy, and no encryption
configured. rclone is a usable *building block* — it speaks S3, B2, Drive, and a `crypt` wrapper
([rclone.org/docs](https://rclone.org/docs/)) — but as configured it is a LAN file copier.

A plausible restore story from here, stated as options rather than a recommendation:

- **What to copy.** If the store ends up being SQLite (the household's existing pattern in #3), the
  correct way to take a consistent copy of a live database is `VACUUM INTO` or the backup API, not
  `cp` — the SQLite docs are explicit that copying a WAL-mode database file with a filesystem copy
  can yield a corrupt result ([sqlite.org/backup.html](https://www.sqlite.org/backup.html),
  [lang_vacuum](https://www.sqlite.org/lang_vacuum.html)). For Postgres it is `pg_dump`.
- **Where to.** A `systemd --user` timer (the only scheduling mechanism on this box — there is no
  cron at all) running dump-then-`rclone copy`. To be a real backup rather than a second copy in the
  same house it needs a new **offsite** rclone remote, ideally wrapped in `rclone crypt`. That
  remote does not exist today.
- **Restore.** Stop the service, `rclone copy` the newest dump back, restore it, start the service.
  Untested, because there is nothing to test.
- **The gap that matters most:** a backup nobody has ever restored from is not a backup. Whatever is
  chosen needs one deliberate restore rehearsal.

> **Gap.** Whether the HA box's SMB share is itself backed up anywhere off-premises was not
> established — it is a separate machine and was not inspected. Also not established: available
> space on that share (`df` reports the rclone mount as a nominal 1.0P, which is a FUSE placeholder,
> not real capacity).

### 1.7 The other two ways to get in from outside, on this host

#### Cloudflare Tunnel

`cloudflared` is **not installed** (`command -v cloudflared` → nothing). Like Funnel, it is
outbound-only: "A lightweight daemon in your infrastructure (`cloudflared`) creates outbound-only
connections to Cloudflare's global network" and "No open inbound ports. No public IPs. No attack
surface." ([tunnel](https://developers.cloudflare.com/tunnel/),
[overview](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).

| Question | Answer | Source |
| --- | --- | --- |
| What must be installed here | `cloudflared`. On rpm-ostree the plain-RPM path is awkward: the official repo at `pkg.cloudflare.com` lists Amazon Linux, RHEL-generic and CentOS — **Fedora is not a listed distro**. Realistic routes are the RHEL-generic repo layered via `rpm-ostree install`, the static binary under `~/.local/bin`, or the official container image `cloudflare/cloudflared`. | [pkg.cloudflare.com](https://pkg.cloudflare.com/), [downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |
| Domain needed? | **Yes, for a real hostname:** "Before you publish an application through your tunnel, you must add a website to Cloudflare." Cloudflare need not be the authoritative DNS — a partial/CNAME setup works. Whether the household owns a domain was not established (see gaps). | [create-remote-tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), [FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) |
| Domain-free option | TryCloudflare quick tunnels give a random `*.trycloudflare.com` name, but are "intended for testing and development only", carry no SLA, cap at "200 in-flight requests", and don't support Server-Sent Events. A random, unstable hostname is also incompatible with a fixed Google OAuth redirect URI (#8). | [trycloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) |
| Outbound ports it needs | **7844** — TCP for `http2`, UDP for `quic` — to `region1/region2.v2.argotunnel.com`, plus optional 443. Default protocol is `auto`, falling back from QUIC to http2 if UDP is blocked. This host's firewall does not restrict egress, so nothing needs changing. | [tunnel-with-firewall](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/tunnel-with-firewall/), [run-parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/) |
| Certificates | Cloudflare terminates TLS at its edge and Universal SSL is "free, unshared, publicly trusted" and auto-renewed — "Cloudflare handles issuance, renewal, and deployment automatically." The origin needs **no certificate**: point ingress at `http://localhost:PORT`. | [universal-ssl](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/), [origin-parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/) |
| Cost | Included in the Zero Trust Free plan; no per-tunnel charge. Limit of 1,000 tunnels per account. A bare public hostname with no Access policy consumes no seat. | [setup](https://developers.cloudflare.com/cloudflare-one/setup/), [account-limits](https://developers.cloudflare.com/cloudflare-one/account-limits/), [seat-management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/) |
| **Timeout — decisive for the LLM call** | Proxy Read Timeout is **125 s**, after which the visitor gets Error 524. Only Enterprise can raise it (to 6,000 s) via a Cache Rule. Proxy Write Timeout 30 s; idle 900 s. | [connection-limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/), [error-524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) |
| Body size | 100 MB on Free/Pro, else `413`. Irrelevant here — images are discarded at import and never uploaded in bulk. | [error-413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/) |
| WebSockets | "Cloudflare Tunnel has full support for Websockets." | [FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) |
| Access control for free | Cloudflare Access can gate the app before it reaches the host, including a one-time-PIN login with no IdP. An alternative or complement to Google sign-in (#8). WARP on phones is **not** required. | [access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/) |
| Reboot | `cloudflared service install` creates a systemd service and "typically requires elevated privileges". A rootless container would need a Quadlet or `podman-restart.service` (see §1.4). | [as-a-service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/linux/) |
| Privacy | Visitor TLS terminates on Cloudflare's edge, and Cloudflare states that when traffic flows via Cloudflare "it's possible for us to inspect the traffic". Cloudflare is in the clear-text path in a way Funnel's relays are not — Funnel relays "do not decrypt the traffic". | [securing-data-in-transit](https://developers.cloudflare.com/reference-architecture/diagrams/security/securing-data-in-transit/) vs [funnel](https://tailscale.com/docs/features/tailscale-funnel) |
| Content terms | Cloudflare "reserves the right to disable or limit your access to or use of the CDN… if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files." A text-only meal planner is nowhere near this. (The often-cited ToS §2.8 no longer exists; the clause moved here.) | [service-specific terms](https://www.cloudflare.com/service-specific-terms-application-services/) |

**Gaps on Cloudflare Tunnel:** no documented per-tunnel concurrent-connection cap for named
tunnels; no documented bandwidth quota; no official statement on whether the container runs rootless
or needs `NET_ADMIN`; the docs never say the installed systemd unit is `enabled` (i.e. reboot-safe)
by default, and never mention `systemd --user` at all; and the widely-repeated "free for up to 50
users" Zero Trust figure could not be sourced to a fetchable official page.

#### A reverse proxy in a rootless podman container, getting its own certificates

This is the only one of the three ingress options that needs an inbound hole, and on this specific
host it is the most awkward.

| Question | Answer | Source |
| --- | --- | --- |
| What must be installed | Nothing via `rpm-ostree` if the proxy runs as a container — no proxy binary exists on the host today (`command -v caddy nginx traefik` → nothing). Caddy is the low-effort choice because ACME is built in. | host check |
| Certificate issuance | Caddy enables the HTTP and TLS-ALPN challenges by default. "This challenge requires port `80` to be externally accessible" and "This challenge requires port `443` to be externally accessible." | [automatic-https](https://caddyserver.com/docs/automatic-https) |
| **The blocker on this host** | `net.ipv4.ip_unprivileged_port_start = 1024` (verified by `sysctl`), and podman documents that "Unprivileged users on a Linux system can not bind to ports below 1024 by default. This limit can be configured in `/proc/sys/net/ipv4/ip_unprivileged_port_start`." So a rootless container **cannot** publish 80 or 443 without lowering that sysctl — which then lets *any* unprivileged process on the box bind privileged ports. | `sysctl net.ipv4.ip_unprivileged_port_start`; [podman troubleshooting #48](https://github.com/containers/podman/blob/main/troubleshooting.md) |
| Avoiding the inbound hole | The DNS-01 challenge "does not require any open ports" but "requires configuration" — DNS provider credentials — and the provider plugin "must be plugged in from one of the `caddy-dns` repositories", i.e. a **custom Caddy build**. It removes the need for inbound 80, but you still need inbound 443 to actually serve. | [automatic-https](https://caddyserver.com/docs/automatic-https), [tls directive](https://caddyserver.com/docs/caddyfile/directives/tls) |
| Renewal | Automatic and in the background; Caddy "keeps all managed certificates renewed", by default when ≤1/3 of the lifetime remains (`renewal_window_ratio` 0.3333 → ~30 days into a 90-day cert). | [automatic-https](https://caddyserver.com/docs/automatic-https), [renewal_window_ratio](https://caddyserver.com/docs/json/apps/tls/automation/policies/renewal_window_ratio/) |
| A domain is required | Let's Encrypt will not certify a name nobody owns: it "can't provide certificates for 'localhost' because nobody uniquely owns it". IP-address certificates are now GA but only via the `shortlived` profile (~160 h validity), which is not a sane basis for a household app. | [certificates-for-localhost](https://letsencrypt.org/docs/certificates-for-localhost/), [6-day and IP GA](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) |
| Rate limits | 50 certificates per registered domain per 7 days; 5 duplicate certificates (same identifier set) per 7 days; 5 authorization failures per identifier per account per hour. Generous for one hostname; the failure limit is the one you hit while misconfiguring. | [rate-limits](https://letsencrypt.org/docs/rate-limits/) |
| Cost | €0 in software; the cost is a domain registration and the router change. | — |
| What breaks on reboot | Everything, unless a Quadlet or `podman-restart.service` is set up (§1.4) — **and** the ISP-assigned public IP is stable, **and** the router's port-forward survives. Dynamic DNS becomes a new moving part. | §1.4; see gaps |
| If layering is chosen instead of a container | `rpm-ostree install` is offline by default: "every `rpm-ostree` operation is 'offline' — it has no effect on your running system, and will only take effect when you reboot" (`-A` can live-apply pure additions). Layered packages are "persistent across upgrades, rebases, and deploys", so every daily `uupd` image update must re-resolve them. | [administrator-handbook](https://coreos.github.io/rpm-ostree/administrator-handbook/), [layering](https://coreos.github.io/rpm-ostree/layering/) |

---

## 2. Candidate B — a small VPS

The household rents a Linux box, runs the app on it, and the data lives there instead of at home.

All prices fetched **2026-08-24** and move without notice. Note Hetzner adjusted prices on
15 June 2026, so older third-party figures are stale.

| | **Hetzner Cloud** | **netcup** | **Contabo** | **UpCloud** (Finnish) |
| --- | --- | --- | --- | --- |
| Cheapest always-on | **CX23 €5.49/mo** (x86); **CAX11 €5.99/mo** (2 Arm vCPU, 4 GB, 40 GB NVMe, 20 TB traffic) | **VPS piko G11s €1.84/mo** (1 vCore, 1 GB, 30 GB SSD, Nuremberg only); mainline **VPS 500 G12 €5.91/mo** | **Cloud VPS 4 €6.60/mo** (4 vCPU, 8 GB, 100 GB) — but that is a 24-month effective rate | "from €3/mo" — **exact spec/price unconfirmable, see gaps** |
| VAT | ex-VAT; Finland 25.5% applies to a private household | shown incl. 19% German VAT | incl. taxes | unconfirmed |
| IPv4 | **extra €0.50/mo**; IPv6-only possible | included (removing it saves €0.60/mo) | 1 included | bundled in Starter plans |
| Backups | **+20% of server price**, 7 slots; snapshots billed per GB/mo | snapshots included; separate Managed Backup product | 1 snapshot included; Auto Backup €1.15–12.00/mo | per GB stored, rate rises with retention |
| Nordic DC | **Yes — Helsinki (HEL)** published, plus Falkenstein and Nuremberg | **No Nordic DC** | no Nordic location published | Helsinki (`fi-hel1`) is its home region |
| Term | hourly, no term, no setup fee | setup €0.00 but **12-month minimum term** on VPS (the hourly-billing option has none) | 1-month minimum, 4 weeks' notice | hourly, capped monthly |

Sources: [Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/),
[Hetzner IPv4](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/),
[Hetzner backups](https://docs.hetzner.com/cloud/billing/faq/),
[Hetzner VAT](https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/value-added-tax/),
[Hetzner locations](https://www.hetzner.com/cloud/cost-optimized/),
[netcup VPS](https://www.netcup.com/en/server/vps),
[netcup VPS Lite](https://www.netcup.com/en/server/vps-lite),
[netcup cancellation](https://www.netcup.com/en/helpcenter/documentation/general/canceling-contract),
[Contabo VPS](https://contabo.com/en/vps/),
[Contabo Auto Backup](https://help.contabo.com/en/support/solutions/articles/103000331729-what-is-the-auto-backup-add-on-),
[UpCloud plans](https://upcloud.com/docs/products/cloud-servers/plans/),
[DigitalOcean droplets](https://www.digitalocean.com/pricing/droplets) ($4/mo 512 MiB, $6/mo 1 GiB,
IPv4 included; [backups](https://docs.digitalocean.com/products/backups/details/pricing/) 20%
weekly / 30% daily).

**Realistic all-in for the cheapest credible option:** Hetzner CX23 in Helsinki = €5.49 server +
€0.50 IPv4 + €1.10 backups = **€7.09/mo ex-VAT**, ≈ **€8.90/mo incl. 25.5% Finnish VAT**. netcup's
€1.84 piko is cheaper on paper but is Nuremberg-only with a 12-month commitment.

**The same questions, for this candidate:**

- **What must be installed/maintained.** Everything: OS and security updates, the Python runtime,
  a reverse proxy or Caddy, a host firewall, the app, and backups. This is the option with the most
  ongoing human work, and it is work nobody on this map is currently doing for anything.
- **TLS and hostname.** No platform subdomain and no managed TLS — plain IaaS. You bring a domain
  and run Caddy (ACME built in) or certbot. HTTP-01 needs port 80 reachable: "The HTTP-01 challenge
  can only be done on port 80… it is not allowed by the ACME standard"
  ([challenge types](https://letsencrypt.org/docs/challenge-types/)). Certbot ships renewal
  automation — "Most Certbot installations come with automatic renewals preconfigured… by means of a
  scheduled task which runs `certbot renew` periodically"
  ([certbot docs](https://eff-certbot.readthedocs.io/en/stable/using.html)). Caddy is less to reason
  about because there is no timer at all.
- **Persistent storage.** The server's own disk. A SQLite file or a local Postgres just sits there;
  nothing about a deploy touches it. This is the candidate where "does the DB survive a redeploy" is
  simply not a question.
- **Backups.** Provider disk backups are real but are whole-disk images, not an app-level restore —
  a complement to, not a substitute for, a tested dump.
- **What breaks on reboot.** Nothing, if you write a `systemd` unit and `systemctl enable` it. Same
  mechanism as Candidate A, but on a machine whose only job is this app.
- **Outbound and timeouts.** No platform-imposed request timeout at all — the slow LLM call is a
  non-issue. Outbound HTTPS is unrestricted.

> **Gap.** IPv6-only would save €0.50/mo on Hetzner, and Hetzner documents that you can run with no
> IPv4 — but the docs do not discuss the fallout, and an IPv4-only visitor could not reach the app.
> Treat the IPv4 as mandatory. Also unconfirmed on official pages: Hetzner's snapshot €/GB rate,
> Hetzner's traffic overage rate, CX23's exact specs (the spec tables are JS-rendered), UpCloud's
> EUR prices (all its pricing pages return HTTP 403 to fetches), whether netcup charges Finnish VAT
> via OSS, and Contabo's 1-month-term price.

---

## 3. Candidate C — a managed platform you push code to

Everything below fetched **2026-08-24**. The two axes that actually separate these platforms for
ruokalista are **per-request timeout** (because of the LLM call at import) and **storage that
survives a redeploy**.

### 3.1 Per-request timeout

| Platform | Free tier | Cheapest paid | Read for a tens-of-seconds LLM call |
| --- | --- | --- | --- |
| **Render** | "Render allows responses to take up to 100 minutes for HTTP requests" ([docs](https://render.com/docs/heroku)) | same | Enormous headroom; a non-issue |
| **Vercel** | **300 s on Hobby — and 300 s is also the Hobby maximum, not raisable** ([duration](https://vercel.com/docs/functions/configuring-functions/duration)) | Pro 800 s GA, 1800 s in beta | Comfortable |
| **Railway** | no free tier | "HTTP requests can run for up to 15 minutes if data keeps transferring… and are otherwise closed after 5 minutes with no data transferred" ([specs](https://docs.railway.com/networking/public-networking/specs-and-limits)) | Fine — a silent 60 s wait is well inside 5 min |
| **Cloudflare Workers** | CPU time **10 ms** per invocation; wall clock "No limit" while the client stays connected | Paid: CPU 30 s default, configurable up to 5 min | I/O wait doesn't burn CPU time, so an LLM call is survivable even free — **but Cloudflare's own 524 proxy timeout at ~125 s is the real wall** ([limits](https://developers.cloudflare.com/workers/platform/limits/), [connection-limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)) |
| **Fly.io** | no free tier | `idle_timeout` is configurable, but **no official page states an absolute maximum request duration** | **The one genuine unknown in this comparison** |

### 3.2 Storage that survives a redeploy

| Platform | Option | Survives redeploy | Free? | Cheapest paid | Sleeps or gets deleted? |
| --- | --- | --- | --- | --- | --- |
| **Render** | Persistent Disk (SQLite) or Render Postgres | Yes | **Disks are not available on free instances** — the free filesystem is wiped on every redeploy/restart/spin-down. Free Postgres = 1 GB | Starter instance + disk at $0.30/GB-mo, or a Basic Postgres | **Free Postgres expires 30 days after creation, +14-day grace, then is permanently deleted with all data.** Free web services spin down after 15 min idle (~1 min cold start) |
| **Railway** | Volume (SQLite) or a Postgres service | Yes | No free tier — one-time $5 trial credit, 30 days | **Hobby $5/mo including $5 usage** | Sleeping is opt-in and off by default. Volumes cap at 5 GB on Hobby, and "Replicas cannot be used with volumes" |
| **Cloudflare** | **D1** (SQLite) or SQLite-backed Durable Objects — both are *bindings*, not part of the script | Yes | Yes — D1 free 500 MB/db, 5 GB total, 5M rows read/day | $5/mo Workers Paid | Never deleted for inactivity |
| **Vercel** | **None on-platform.** Read-only filesystem plus a 500 MB `/tmp` not shared between invocations. "Vercel Postgres" was retired; you bring Neon/Supabase from the Marketplace | only in the external DB | Neon free 0.5 GB | Neon Launch, usage-based | Neon free compute **scale-to-zero after 5 min idle, not disableable**; Vercel functions are archived after 2 weeks with no production invocations, adding "at least 1 second" on the next call |
| **Fly.io** | Volume (SQLite) or Managed Postgres | Yes — the volume follows the machine | No free tier for new orgs since Oct 2024 | ≈**$2.17/mo** (shared-cpu-1x 256 MB + 1 GB volume); Managed Postgres starts at **$38/mo** | Nothing deleted; auto-stop is opt-in |

Sources: [Render disks](https://render.com/docs/disks), [Render free](https://render.com/docs/free),
[Render Postgres expiry](https://render.com/docs/postgresql-refresh),
[Render backups](https://render.com/docs/postgresql-backups), [Render TLS](https://render.com/docs/tls);
[Railway volumes](https://docs.railway.com/volumes), [Railway backups](https://docs.railway.com/volumes/backups),
[Railway plans](https://docs.railway.com/reference/pricing/plans), [app sleeping](https://docs.railway.com/reference/app-sleeping);
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [Python Workers](https://developers.cloudflare.com/workers/languages/python/);
[Vercel Python runtime](https://vercel.com/docs/functions/runtimes/python), [Vercel limitations](https://vercel.com/docs/functions/limitations),
[Vercel Postgres](https://vercel.com/docs/postgres), [Neon plans](https://neon.com/docs/introduction/plans), [Vercel Hobby](https://vercel.com/docs/plans/hobby);
[Fly pricing](https://fly.io/docs/about/pricing/), [Fly volumes](https://fly.io/docs/volumes/overview/),
[Fly custom domains](https://fly.io/docs/networking/custom-domain/), [Fly Managed Postgres](https://fly.io/docs/mpg/),
[Fly discontinued plans](https://fly.io/docs/about/discontinued-plans/), [Fly config reference](https://fly.io/docs/reference/configuration/).

### 3.3 The rest of the comparison, per platform

| | Install / maintain | TLS + hostname | Backups | Monthly cost | Restart / redeploy |
| --- | --- | --- | --- | --- | --- |
| **Render** | Push a git repo; Render detects Python, or bring a Dockerfile. No agent | Free `*.onrender.com`; "TLS certificates are always included for free", auto-renewed; custom domains free | Postgres logical backups retained 7 days on paid plans; PITR 3-day window on Hobby, 7-day on Pro+. None on Free (manual `pg_dump` only) | Free tier exists but spins down; cheapest always-on is Starter + disk (**exact $ figures are a gap** — the pricing page is client-rendered) | Comes back automatically. **Attaching a persistent disk disables zero-downtime deploys** — a brief outage on every deploy, because only one instance can mount the disk |
| **Railway** | Zero-config, auto-detects Python via Railpack; Dockerfile optional | Free `*.up.railway.app`; Let's Encrypt, auto-renewed; custom domains free | Scheduled volume backups: daily kept 6 days, weekly 1 month, monthly 3 months. Incremental | **$5/mo Hobby including $5 usage** — realistically the whole bill for this app | Default restart policy `ON_FAILURE`, max 10 attempts. A new deploy goes live only after its healthcheck passes |
| **Cloudflare Workers** | Wrangler CLI + config. **Python Workers are in open beta**, on Pyodide/PyEmscripten, only pure-Python or PyEmscripten-wheel packages; HTTP needs async libraries | Free `*.workers.dev` — but Cloudflare says it is "intended for personal or hobby projects that aren't business-critical". A custom domain needs the zone on your Cloudflare account; certs are issued for you | D1 Time Travel: **7 days on Free, 30 days on Paid**, minute-granularity restore | $0 (100k req/day) or $5/mo Paid. Never sleeps; cold start ~5 ms | Deploys publish an immutable version; nothing to restart, bound storage untouched |
| **Vercel** | Git integration; Python is a first-class runtime (3.12/3.13/3.14, WSGI and ASGI, Flask/FastAPI/Django documented) | Free `*.vercel.app`, auto-renewed Let's Encrypt; custom domain free to attach | None from Vercel — the storage provider's job. Neon PITR: free 6 h, Launch up to 7 days | **Hobby $0**, but restricted to "personal, non-commercial use" — a household app qualifies. Pro $20/user/mo | Deployments are immutable; a redeploy creates a new one. No `/tmp` or in-memory state survives |
| **Fly.io** | `flyctl` generates a Dockerfile + `fly.toml`. Unmanaged Fly Postgres is explicitly "not supported by Fly.io Support and users are responsible for operations, management, and disaster recovery" | Free `*.fly.dev`; Let's Encrypt auto-obtained and auto-renewed | Volume snapshots: "Automatic daily snapshots with 5 days retention are enabled by default", 1–60 configurable, $0.08/GB-mo with the first 10 GB free | ≈**$2.17/mo** — cheapest always-on here | Machine restart policy defaults to `on-failure`; `auto_start_machines` defaults true. Deploys update the existing machine, preserving its volume |

**Outbound network** — all five allow arbitrary outbound HTTPS, which the LLM call needs. Cloudflare
is the only one with a hard documented ceiling: **50 subrequests per invocation on Free**, 10,000 on
Paid, and at most 6 simultaneous connections awaiting response headers
([limits](https://developers.cloudflare.com/workers/platform/limits/)). For Render, Railway, Vercel
and Fly the permission is undocumented-but-obvious; treat "explicitly stated" as a gap.

**The single most important trap in this section:** Render's free tier looks like the obvious
zero-cost answer and is actively wrong for this app — free instances cannot have a disk, and free
Postgres **permanently deletes itself and its data about 44 days after creation**
([docs](https://render.com/docs/postgresql-refresh)). A menu history is exactly the kind of data
that would be lost quietly.

**A durability warning that applies to every single-volume deployment.** Fly is unusually honest
about it: "Volumes don't have built-in replication between them, so your app or database needs to
take care of replicating data between volumes"; "If you only have a single copy of your data on a
single volume, and that drive fails, then the data is lost"; and snapshots "shouldn't be your primary
backup method" ([Fly volumes](https://fly.io/docs/volumes/overview/)). Render says a persistent disk
"is accessible by only a single service instance" ([disks](https://render.com/docs/disks)). None of
these platforms removes the need for an off-platform backup of the database.

---

## 4. Side by side

The same questions, all four candidate classes.

| | **A. Home server** | **B. Small VPS** | **C1. Managed, with a disk/volume** (Render Starter, Railway Hobby, Fly) | **C2. Managed, serverless** (Cloudflare Workers + D1, Vercel + Neon) |
| --- | --- | --- | --- | --- |
| Install / maintain | Nothing new for a Python + `systemd --user` app — but the OS is image-based, so anything needing an RPM means layering and a reboot | Everything: OS, runtime, proxy, firewall, backups | Push a git repo; the platform builds it | Push a git repo; no server at all |
| Public hostname | Funnel: fixed `bazzite.taile8d16e.ts.net`, **no custom domain**. Cloudflare Tunnel: needs a domain you own. Own proxy: needs a domain **and** a router port-forward | You bring a domain; no free subdomain | Free platform subdomain (`*.onrender.com`, `*.up.railway.app`, `*.fly.dev`) | Free `*.workers.dev` / `*.vercel.app` |
| TLS | Funnel/Tunnel: fully automatic. Own proxy: Caddy ACME, needs inbound 80/443 | You run Caddy or certbot | Automatic, auto-renewed | Automatic, auto-renewed |
| Persistent storage | A file on a btrfs filesystem that is 81% full | The server's own disk | A volume or disk that survives redeploys | **A managed DB binding — no filesystem.** Free tiers sleep (Neon) or self-delete (Render free Postgres) |
| Survives a redeploy | Yes — nothing "deploys" over it | Yes | Yes | Yes, because storage is external to the code |
| Backups | **None exist.** rclone is present but configured only against a LAN SMB share | Provider disk backups (+20% at Hetzner) plus your own dump | Platform snapshots, 5–7 day retention typical | D1 Time Travel 7/30 days; Neon PITR 6 h on free |
| Monthly cost | €0 marginal (hardware and power already paid for) | ≈€7.09 ex-VAT / ≈€8.90 incl. VAT (Hetzner Helsinki, with IPv4 + backups) | $2.17 (Fly) – $5 (Railway) – Render Starter + disk | $0 possible; $5/mo Cloudflare Paid |
| LLM-call timeout | Funnel: **undocumented**. Cloudflare Tunnel: **125 s**. Own proxy: none | None | Render 100 min; Railway 5–15 min; **Fly undocumented** | Vercel Hobby 300 s hard; Workers CPU fine but ~125 s proxy wall |
| What breaks on reboot / restart | **Verified: containers do not come back at all** (`podman-restart.service` disabled; 1 of 19 even eligible). `systemd --user` units *do*, because lingering is on | Nothing, with an enabled systemd unit | The platform restarts it. Render: a disk **disables zero-downtime deploys** | Nothing to restart; but cold starts return (Vercel archives after 2 weeks idle, +1 s) |
| Biggest specific risk | No backups, a disk at 81%, an OS update staged but unapplied for 65 days, and a supervision story that demonstrably doesn't cover containers | Ongoing maintenance nobody is currently doing, and a 12-month term at some providers | A single unreplicated volume; Render's free tier is a data-loss trap | Runtime constraints (Python Workers are beta on Pyodide; Vercel has no filesystem) reach back and constrain the stack decision in #7 |

Two cross-cutting notes:

- **Funnel is the only option that cannot use a custom domain.** Since Google sign-in (#8) needs a
  fixed OAuth redirect URI, a `.ts.net` name works but permanently ties the app's public identity to
  the tailnet, and publishes the machine name to Certificate Transparency logs.
- **Ingress and hosting are separable.** Candidate A's three ingress options (Funnel, Cloudflare
  Tunnel, own proxy) are choices *within* the home-server candidate; a VPS or a managed platform
  makes the ingress question disappear entirely, at the cost of money and/or platform constraints.

---

## 5. Gaps — what this note did not establish

Listed rather than guessed.

**About the host.**

1. Reboot survival was established from configuration, not by rebooting. Nobody rebooted the
   machine. The next reboot also applies a staged OS image, so the first real test would coincide
   with an OS change.
2. Whether the tailnet policy file actually lacks the `funnel` node attribute. The netmap shows no
   `funnel` capability, but Tailscale does not document node attributes surfacing as `CapMap` keys,
   and the admin console was not opened.
3. Whether the household **owns a domain name** at all. Nothing on the host indicated one and it was
   not asked. Cloudflare Tunnel and a self-hosted proxy both require one; Funnel does not.
4. Whether the ISP gives a stable public IP, whether it uses CGNAT, and whether the router can
   port-forward. The host is behind NAT at `192.168.34.1`; the router was not inspected. This
   decides whether the self-hosted-proxy option is possible at all.
5. Whether the LAN SMB share rclone points at is itself backed up off-premises, and how much free
   space it really has (`df` shows the FUSE mount as a nominal 1.0P placeholder).
6. `btrfs subvolume list /` needs root and no non-interactive sudo is available, so snapshot history
   beyond snapper's zero configs is unknown.

**About the products.**

7. **Tailscale Funnel publishes no numeric bandwidth limit, no concurrency limit, no request-size
   limit and — most importantly here — no request timeout.** For an app that holds a request open
   while a language model works, that is the single most relevant unknown about Funnel, and the docs
   are silent. Confirming it means testing.
8. Cloudflare Tunnel: no documented per-tunnel concurrency cap; no official word on rootless
   container operation or `NET_ADMIN`; the docs never state that the installed systemd unit is
   enabled at boot, and never mention `systemd --user`.
9. **Fly.io publishes no absolute maximum HTTP request duration** anywhere in its docs — only a
   configurable idle timeout. Given the LLM call, this needs verifying before Fly could be chosen.
10. Render's actual dollar prices could not be read from an official page (the pricing table is
    client-rendered); only plan *names* and specs are confirmed in the docs. The commonly quoted
    $7/mo Starter figure is third-party sourced.
11. Cloudflare's Zero Trust free-tier seat cap (the widely repeated "50 users") has no citable
    official page.
12. Hetzner's snapshot €/GB rate and traffic overage rate; CX23's exact specs; UpCloud's EUR prices
    (every UpCloud pricing page returns HTTP 403 to fetches); whether netcup applies Finnish VAT.
13. Whether Python Workers are considered production-ready, and their bundle-size and cold-start
    behaviour. The docs say only that they are in open beta on Pyodide and that "WebAssembly support
    for Python packages is still in early stages".
14. Explicit vendor statements that arbitrary outbound HTTPS is permitted, for Render, Railway,
    Vercel and Fly. It plainly works and their own AI guides assume it, but no blanket statement was
    found.

---

## 6. What this note deliberately does not do

It does not pick a hosting target, a stack, a database or an ingress method. Those belong to
[#7](https://github.com/eerovil/ruokalista/issues/7), which is a conversation, not an agent
write-up. Nothing on the host was changed: no package installed, no service started or stopped, no
port opened, no Funnel enabled, no firewall rule touched.
