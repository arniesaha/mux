# Deploying Mux on Debian (NAS / homelab)

This guide installs Mux as a long-running systemd service on a Debian-based
machine (tested on Debian 12 / Ubuntu 22.04+). Mux is a stateless Node
process — no database, no persistent disk requirements beyond the source
checkout and `node_modules`.

## Prerequisites

- Debian 12+ (or Ubuntu 22.04+) with `systemd`
- Node.js **22.x** (matches the CI version pinned in `.github/workflows/ci.yml`)
- A dedicated UNIX user (`mux`), to avoid running as root
- Outbound HTTPS to whichever downstream(s) you'll route to (OpenAI,
  Anthropic, a local LiteLLM proxy, etc.)

Install Node 22 via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

## Layout

```
/opt/mux/                      # source checkout (git)
/opt/mux/.env                  # environment file (chmod 600, owner mux:mux)
/etc/systemd/system/mux.service
```

## Install

```bash
sudo useradd --system --create-home --home-dir /var/lib/mux --shell /usr/sbin/nologin mux
sudo mkdir -p /opt/mux
sudo chown mux:mux /opt/mux

sudo -u mux git clone https://github.com/arniesaha/mux.git /opt/mux
cd /opt/mux
sudo -u mux npm ci
sudo -u mux npm run build
```

## Configure

Copy `.env.example` to `/opt/mux/.env` and edit. The minimum required keys
for a typical NAS deployment:

```bash
sudo -u mux cp /opt/mux/.env.example /opt/mux/.env
sudo chmod 600 /opt/mux/.env
sudo chown mux:mux /opt/mux/.env
```

Edit `/opt/mux/.env`:

```ini
PORT=8787
NODE_ENV=production

# Pick ONE downstream mode. For OpenClaw + LiteLLM in front of OpenAI/Codex:
DOWNSTREAM_MODE=openai-compatible
DOWNSTREAM_BASE_URL=http://localhost:4000/v1   # LiteLLM, vLLM, etc.
DOWNSTREAM_AUTH_MODE=bearer
DOWNSTREAM_API_KEY=<key for the downstream>

# Enable native /v1/responses passthrough alongside chat completions.
# Without this, Mux returns 503 "provider does not support responses protocol".
DOWNSTREAM_PROTOCOLS=chat_completions,responses

# Mock fallback OFF in prod — without a configured downstream, Mux returns 503
DOWNSTREAM_MOCK_FALLBACK=false

# Optional: AgentWeave OTLP for tracing/cost dashboards
AGENTWEAVE_OTLP_ENDPOINT=http://localhost:30400
AGENTWEAVE_AGENT_ID=mux-router
```

Adjust `MODEL_MAP` / `ANTHROPIC_MODEL_MAP` / `PROVIDERS` as needed. See
`.env.example` for the full surface.

## systemd unit

Create `/etc/systemd/system/mux.service`:

```ini
[Unit]
Description=Mux model router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mux
Group=mux
WorkingDirectory=/opt/mux
EnvironmentFile=/opt/mux/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=2

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/mux
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mux.service
sudo systemctl status mux.service
journalctl -u mux.service -f
```

Verify:

```bash
curl -s http://localhost:8787/health
# {"ok":true,"service":"mux","env":"production"}
```

## Upgrades

```bash
sudo -u mux git -C /opt/mux fetch --tags origin
sudo -u mux git -C /opt/mux merge --ff-only origin/master
sudo -u mux npm ci --prefix /opt/mux
sudo -u mux npm run build --prefix /opt/mux
sudo systemctl restart mux.service
```

If `npm ci` fails or you need to roll back: `git -C /opt/mux reset --hard <prev-sha>`
followed by rebuild + restart.

## Reverse proxy / TLS (optional)

For LAN-only access, exposing port 8787 directly is fine. For remote access,
front Mux with nginx or Caddy:

```caddy
mux.local {
  reverse_proxy localhost:8787 {
    flush_interval -1   # critical for SSE streaming
  }
}
```

The `flush_interval -1` (or `proxy_buffering off` in nginx) is **required**
for `stream: true` responses — without it the proxy will buffer SSE chunks
and clients will see no events until the response completes.

## Plumbing with OpenClaw + AgentWeave

Mux sits between agent runtimes and the actual LLM endpoints. Typical chain
for a NAS deployment:

```
OpenClaw agent ─► AgentWeave proxy ─► Mux ─► LiteLLM/Anthropic/OpenAI
```

### OpenClaw → Mux

Configure your OpenClaw `openai-codex` (or any OpenAI-compatible) provider
with a custom `baseUrl` pointing at Mux:

```jsonc
{
  "id": "mux-openai",
  "kind": "openai-codex",
  "baseUrl": "http://<nas-host>:8787/v1",
  "auth": { "mode": "bearer", "token": "<downstream key>" }
}
```

OpenClaw's `openai-codex` provider posts to `<baseUrl>/responses` and
`<baseUrl>/chat/completions`. With `baseUrl=http://nas:8787/v1`, those land
on Mux's `POST /v1/responses` and `POST /v1/chat/completions`.

> **Note:** OpenClaw fix `13085b0bdf` ("honor providerConfig.baseUrl in
> dynamic-model synthesis fallback") is required — earlier versions silently
> fall back to `api.openai.com` / `chatgpt.com`, bypassing Mux. Make sure
> the OpenClaw build is at or after that commit.

### AgentWeave → Mux

If you're routing through AgentWeave's Python proxy first, point its
upstream at Mux. AgentWeave forwards `Authorization` and `X-AgentWeave-*`
headers verbatim; Mux uses `DOWNSTREAM_AUTH_MODE=passthrough` to forward
the inbound `Authorization` to the eventual downstream:

```ini
DOWNSTREAM_AUTH_MODE=passthrough
```

> **Note:** AgentWeave PR #183 reroutes `/v1/responses` calls carrying
> ChatGPT-mode JWTs (`eyJ...`) to `codex/responses`. That rewrite happens
> inside AgentWeave's proxy and is independent of Mux. If AgentWeave
> forwards the call to Mux as `/v1/responses`, Mux handles it normally; if
> the rewrite redirects to `chatgpt.com` directly, the call doesn't transit
> Mux at all.

### Caller agent attribution

Mux propagates `X-AgentWeave-*` headers to the downstream and emits
`prov.agent.id` span attributes when `X-AgentWeave-Agent-Id` is present.
No additional config required — just make sure your reverse proxy doesn't
strip those headers.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `503 service_unavailable: provider 'default' does not support responses protocol` | `DOWNSTREAM_PROTOCOLS` not set to include `responses` |
| `502 downstream_error` with `additional_properties_strict` complaint | A pre-PR-54 Mux is leaking the `runtime` field downstream — upgrade past PR #54 |
| SSE stream stalls / events arrive in one chunk at the end | Reverse proxy buffering — set `flush_interval -1` (Caddy) / `proxy_buffering off` (nginx) |
| 401 from upstream when using ChatGPT-mode JWT | Wrong upstream — ChatGPT-mode tokens require `chatgpt.com/backend-api/codex`, not `api.openai.com`. See AgentWeave #183. |

## Environment reference

Full env-var reference lives in `.env.example` and the README's
"Environment variables" table. The keys most relevant to a NAS deploy:

- `PORT`, `NODE_ENV`
- `DOWNSTREAM_MODE`, `DOWNSTREAM_BASE_URL`, `DOWNSTREAM_AUTH_MODE`, `DOWNSTREAM_API_KEY`
- `DOWNSTREAM_PROTOCOLS` *(new in PR #54 — needed for /v1/responses)*
- `DOWNSTREAM_MOCK_FALLBACK=false` for production
- `AGENTWEAVE_OTLP_ENDPOINT`, `AGENTWEAVE_AGENT_ID`
- `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` if `DOWNSTREAM_MODE=anthropic-sdk`
