# Preview ingress: a zone for session dev servers

The preview router lets a session show its dev server at its own address, for example
`https://dev4.fixplay.dev`, without a tunnel per session. Nothing here depends on Cloudflare: the
public entry point is whatever reverse proxy or provider forwards HTTP(S) to this machine.

```
Browser ──https──▶ TLS terminator (Caddy or the provider)
                        │  Host: dev4.fixplay.dev
                        ▼
                 preview router 127.0.0.1:8090   (part of the csm daemon)
                        │  Host rewritten to localhost:<port>
                        ▼
                 127.0.0.1:5173  Vite / Nuxt / any dev server
                        ▲
                        └── csm `register_preview` (MCP) or POST /api/sessions/:id/preview
```

The router is part of the daemon process (`csm`), not a second service. It answers only for names
registered right now, and it drops registrations after 12 hours unless the session renews them.

## 1. Point the zone at this machine

Use a zone whose DNS you control, for example `preview.fixplay.dev` or a dedicated `fixplay.dev`.
Two DNS shapes work:

- **A wildcard record** `*.preview.fixplay.dev → <public address>` (or `CNAME` to whatever the
  provider gives you). Everything in the zone then reaches the proxy.
- **A delegated subzone.** Keep the parent zone where it is and delegate: `preview` `NS` → the
  nameservers of the provider that will host the preview zone. Only the subzone moves.

Wildcards only work as a whole leftmost label: `*.preview.fixplay.dev` is fine, `dev*.fixplay.dev`
is not. Start with a TTL of 300 while you test.

If your provider maps a domain to the VM itself (instead of giving you a public IP), use that: it
usually creates the A/AAAA record and forwards 80/443. Confirm that (a) `Host` reaches this machine,
and (b) a wildcard or arbitrary subdomain can be sent there.

## 2. Run the daemon with the router

```bash
CSM_PREVIEW_PORT=8090 csm
```

| Variable               | Default     | Meaning                                                                    |
| ---------------------- | ----------- | -------------------------------------------------------------------------- |
| `CSM_PREVIEW_PORT`     | `8090`      | Router port; `0` disables it.                                              |
| `CSM_PREVIEW_BIND`     | `127.0.0.1` | Bind address. Keep loopback when the TLS proxy runs on this host.          |
| `CSM_PREVIEW_SECRET`   | none        | Required for a non-loopback bind; the proxy sends it as a header.          |
| `CSM_PREVIEW_PASSWORD` | none        | When set, every preview asks for this password once. Minimum 8 characters. |

Then set **Settings → Preview links → Preview zone** to the zone, for example `preview.fixplay.dev`.
`csm doctor` prints the router configuration.

## 3. Terminate TLS

### Caddy on this machine (recommended)

Caddy issues a certificate per name on first use. It asks the daemon first, so a host that was never
registered never reaches Let's Encrypt:

```caddyfile
{
	on_demand_tls {
		ask http://127.0.0.1:4747/api/previews/ask
	}
}

*.preview.fixplay.dev {
	tls {
		on_demand
	}

	# Only needed when CSM_PREVIEW_BIND is not loopback. Use the same value here.
	# reverse_proxy 127.0.0.1:8090 {
	# 	header_up X-Preview-Secret <secret>
	# }
	reverse_proxy 127.0.0.1:8090
}
```

- `ask` must point at the daemon's loopback port (`CSM_PORT`, 4747 by default).
- The router reads `X-Forwarded-Host` first, so Caddy's usual Host handling is fine.
- No wildcard certificate and no DNS API credentials are needed: `on_demand` issues one certificate
  per registered name.

### Login, without breaking the app

Set `CSM_PREVIEW_PASSWORD` (8+ characters) and the router asks for it once per browser:

| Route                | Behaviour                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------- |
| any page (no cookie) | login form, 200, `Cache-Control: no-store`                                                    |
| any XHR (no cookie)  | `401 {"error":"login_required"}` — an app never sees HTML where JSON belongs                  |
| `POST /__csm/login`  | sets `csm_preview`, `HttpOnly; Secure; SameSite=Lax`, 12 hours, then 303 to the original path |
| `GET /__csm/logout`  | clears the cookie, back to the form                                                           |
| WebSocket upgrade    | 401 without the cookie                                                                        |

Do **not** put Caddy's `basic_auth` on the same block as well. The cookie approach is what keeps
everything working:

- The browser adds the cookie to the page, its assets, its XHRs and the HMR WebSocket alike, so an app
  can keep sending its own `Authorization` header (Firebase bearer token, the admin's basic
  credentials) — a Basic prompt would fight over that header.
- Relative and absolute redirects keep working: the router passes `Location` through unchanged and
  tells the app the real scheme and host via `X-Forwarded-Proto: https` and `X-Forwarded-Host`.
- Cookies the app sets are untouched, so Firebase sessions, the admin token and CSRF cookies survive
  the proxy.
- `POST /__csm/login` accepts a `next` field and only redirects to a path on the same host.

The cookie is signed with the password as the key, so it survives a daemon restart and a password
change invalidates every session. The password lives in the environment, not in the state file — keep
it out of the repository, for example `/root/.claude-session-manager/preview.env` with mode 600:

```ini
CSM_PREVIEW_PASSWORD=<long-random-value>
```

```ini
# in the unit
EnvironmentFile=/root/.claude-session-manager/preview.env
```

### The provider terminates TLS

If the provider's proxy already answers HTTPS for the zone and forwards plain HTTP to this machine,
skip Caddy. Bind the router where the provider can reach it and require the secret:

```bash
CSM_PREVIEW_BIND=10.0.2.2 CSM_PREVIEW_SECRET=<secret> csm
```

The provider must send `X-Preview-Secret: <secret>` (configure it in the provider's proxy settings)
and pass the original host in `Host` or `X-Forwarded-Host`. Wildcard certificates are then the
provider's responsibility; check that it covers every subdomain.

If the provider only exposes port 80, that is enough — sessions are still reachable, but browsers may
warn on `http`. Prefer a terminator that can do TLS.

## 4. Register a preview from a session

With the plugin installed, the session calls the MCP tool:

```json
{ "port": 5173, "name": "dev4" }
```

`name` is optional; without it the label is derived from the session name, the custom title or the
project folder. Names are unique among live registrations, so a second session asking for `dev4`
gets `dev4-2`. The tool returns the public URL.

### Apps whose API runs on another port

A Vite app usually serves only the frontend; `/api` belongs to a backend. Register the routes
alongside the port, and the router sends matching paths to that backend instead — longest prefix
wins, `strip: true` drops the prefix:

```json
{
  "port": 5176,
  "name": "admin",
  "routes": [{ "prefix": "/api/", "port": 7100 }]
}
```

`/api/orders` then reaches `127.0.0.1:7100/api/orders` while every other path stays on the Vite
server. With `"strip": true` the backend would see `/orders`. A Nuxt app that owns `/api` in its
own BFF (the public site) needs no routes.

The same through HTTP (with a token if one is configured):

```bash
curl -s -X POST http://127.0.0.1:4747/api/sessions/<session-id>/preview \
  -H 'content-type: application/json' \
  -d '{"port":5173,"name":"dev4"}'
```

The board and the session page show the link as soon as the next summary is computed. Remove it with
`DELETE` on the same route, or the `clear_preview` MCP tool.

## 5. How names are confined

- A registration name is one DNS label (`[a-z0-9-]`, at most 63 characters). A session cannot
  register `foo.bar` and cannot escape the zone.
- The router matches the request host against the zone and requires a live registration; the apex
  and deeper names are refused.
- Only ports 1–65535 are accepted. The router always connects to `127.0.0.1`, never to a remote host.
- A route prefix is a normalised path inside the preview (`/api/`), not a host: it cannot redirect a
  request to another machine, and `..` is refused.
- Registrations expire on their own; they are persisted with the rest of the state in
  `<data-dir>/state.json`.

## 6. Troubleshooting

| Symptom                                      | Likely cause                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Certificate request fails                    | `ask` unreachable, or the name is not registered (the daemon answers 403).     |
| `404 No preview is registered for this host` | Zone mismatch in Settings, or the registration expired.                        |
| `502 The preview is not answering`           | The dev server is bound to another port or to IPv6 only (`::1` is not routed). |
| HMR reconnects but the page works            | A proxy in front dropped the WebSocket upgrade; the router tunnels upgrades.   |
| `401 Missing the preview secret`             | The proxy does not send `X-Preview-Secret` while `CSM_PREVIEW_SECRET` is set.  |
