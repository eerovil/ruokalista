# Production domain

The public application is `https://ruokalista.vilpponen.fi`, but `vilpponen.fi`
does not use Cloudflare DNS. Keep the Worker on its normal Cloudflare origin and
put the existing VPS in front of it:

```
browser
  -> https://ruokalista.vilpponen.fi
  -> VPS / nginx
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

The VPS must accept inbound TCP 80 and 443. Port 80 serves dehydrated's HTTP-01
challenge and redirects ordinary requests to HTTPS; the app itself is served on
HTTPS.

## nginx and TLS

The production reverse-proxy configuration is managed in the private
`eerovil/vps-config` repository, not in this application repository. Its
`nginx/sites-available/ruokalista` vhost:

- terminates TLS for `ruokalista.vilpponen.fi` using dehydrated's certificate,
- sends the upstream `Host` and TLS SNI as `ruokalista.eerovil.workers.dev` so
  Cloudflare routes the request to this Worker,
- sends `X-Forwarded-Host: ruokalista.vilpponen.fi` and
  `X-Forwarded-Proto: https` so the Worker can reconstruct the canonical public
  origin for OAuth.

That repo also enables the vhost and includes `ruokalista.vilpponen.fi` in
`dehydrated/domains.txt`, so the normal weekly dehydrated job renews the
certificate after the initial issuance.

The first certificate must be issued before installing the HTTPS vhost because
`nginx -t` rejects a configuration that references certificate files which do
not yet exist. The VPS repo's pull request contains the bootstrap sequence.

## Google OAuth

Register this exact authorized redirect URI for the existing Google OAuth client:

```
https://ruokalista.vilpponen.fi/auth/google/callback
```

Local development still uses:

```
http://127.0.0.1:8787/auth/google/callback
```

The Worker normally derives the callback from the request origin. Behind nginx it
sees the `workers.dev` upstream hostname, so `src/public-origin.ts` recognizes
only this one production proxy path and restores the canonical public origin.
Arbitrary forwarded hosts are ignored.

## Cutover check

After DNS, the VPS certificate and nginx are live, and this code is deployed:

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
