# Production domain

The public application is `https://ruokalista.vilpponen.fi`, but `vilpponen.fi`
does not use Cloudflare DNS. Keep the Worker on its normal Cloudflare origin and
put the existing VPS in front of it:

```
browser
  -> https://ruokalista.vilpponen.fi
  -> VPS / Caddy
  -> https://ruokalista.eerovil.workers.dev
  -> Worker / D1
```

Do **not** add `ruokalista.vilpponen.fi` as a Cloudflare Worker Custom Domain.
That feature requires the hostname to live in a Cloudflare zone.

## DNS

At the authoritative DNS provider for `vilpponen.fi`, create:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `ruokalista` | the VPS public IPv4 address |

Add an `AAAA` record only if the VPS has working public IPv6 and ports 80 and 443
are reachable over IPv6. Do not create a CNAME to `workers.dev`.

The VPS must accept inbound TCP 80 and 443. Port 80 is needed so Caddy can perform
HTTP-to-HTTPS redirects and certificate validation; the app itself is served on
HTTPS.

## Caddy

`deploy/Caddyfile` is the production virtual host. Install it into the VPS's
Caddy configuration (or merge the site block into the existing Caddyfile):

```caddyfile
ruokalista.vilpponen.fi {
    reverse_proxy https://ruokalista.eerovil.workers.dev {
        header_up Host ruokalista.eerovil.workers.dev
    }
}
```

The upstream `Host` must be the `workers.dev` hostname so Cloudflare can route the
request to this Worker and verify TLS. Caddy preserves the browser-facing host in
`X-Forwarded-Host` and the original scheme in `X-Forwarded-Proto`; the app trusts
that pair only when the request arrived at its exact known `workers.dev` origin.

Once DNS resolves to the VPS, Caddy obtains and renews the public TLS certificate
automatically. Validate and reload the server config after installing it, for
example:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Google OAuth

Register this exact authorized redirect URI for the existing Google OAuth client:

```
https://ruokalista.vilpponen.fi/auth/google/callback
```

Local development still uses:

```
http://127.0.0.1:8787/auth/google/callback
```

The Worker normally derives the callback from the request origin. Behind Caddy it
sees the `workers.dev` upstream hostname, so `src/public-origin.ts` recognizes
only this one production proxy path and restores the canonical public origin.
Arbitrary forwarded hosts are ignored.

## Cutover check

After DNS and Caddy are live and this code is deployed:

```sh
curl -fsS https://ruokalista.vilpponen.fi/health
curl -sS -D - -o /dev/null https://ruokalista.vilpponen.fi/recipes
curl -sS -D - -o /dev/null https://ruokalista.vilpponen.fi/auth/google
```

Expected results:

- `/health` returns JSON containing `"database":"ok"`.
- `/recipes` redirects a signed-out browser to `/signin`.
- `/auth/google` redirects to Google and its `redirect_uri` is
  `https://ruokalista.vilpponen.fi/auth/google/callback`.

Keep `https://ruokalista.eerovil.workers.dev` enabled. It is the VPS upstream and
also the endpoint the Cloudflare deployment workflow checks after each deploy.
`https://ruokalista.vilpponen.fi` is the canonical URL users should open.
