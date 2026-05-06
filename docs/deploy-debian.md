# Deploying Mux on Debian (NAS / homelab)

Mux is a stateless Node service. The current production deploy on the
home NAS (`ARNABSNAS`, Debian) runs as a **user-level systemd service**
out of the user's home directory. This guide documents that setup, and
provides a from-scratch path for a fresh install.

## Current NAS deployment (reference)

This is what's actually running on the home NAS. Match this layout if
you're upgrading the existing deploy.

| Item | Value |
|------|-------|
| Source checkout | `/home/Arnab/clawd/projects/mux/` |
| systemd scope | user-level (`systemctl --user ...`) |
| Mux unit | `~/.config/systemd/user/mux.service` (port 8787) |
| LiteLLM unit | `~/.config/systemd/user/mux-litellm.service` (port 4001) |
| Node version | 22.x (via nvm at `~/.nvm/versions/node/v22.22.1`) |
| LiteLLM config | `/home/Arnab/clawd/projects/mux/.litellm.e2e.yaml` |
| LiteLLM env | `/home/Arnab/clawd/projects/mux/run/litellm.env` |
| Mux env | `/home/Arnab/clawd/projects/mux/.env` |
| Service ordering | `mux.service` `Requires=` and `After=` `mux-litellm.service` |

### Existing unit files

`~/.config/systemd/user/mux.service`:

```ini
[Unit]
Description=Mux policy router
After=network.target mux-litellm.service
Requires=mux-litellm.service

[Service]
Type=simple
WorkingDirectory=/home/Arnab/clawd/projects/mux
ExecStart=/usr/bin/node /home/Arnab/clawd/projects/mux/dist/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/mux-litellm.service`:

```ini
[Unit]
Description=LiteLLM for Mux E2E
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/Arnab/clawd/projects/mux
EnvironmentFile=/home/Arnab/clawd/projects/mux/run/litellm.env
ExecStart=/home/Arnab/.local/bin/litellm --host 127.0.0.1 --port 4001 --config /home/Arnab/clawd/projects/mux/.litellm.e2e.yaml
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

### Upgrade procedure (existing deploy)

Run from any user shell on the NAS:

```bash
cd ~/clawd/projects/mux

# Pull the new master
git fetch origin
git status                                 # check for local drift first
git pull --ff-only origin master

# Rebuild
export PATH=~/.nvm/versions/node/v22.22.1/bin:$PATH
npm ci
npm run build

# Restart (mux requires mux-litellm; restart in order if both changed)
systemctl --user restart mux.service
systemctl --user status  mux.service --no-pager
journalctl --user -u mux.service -n 30 --no-pager

# Smoke
curl -s http://localhost:8787/health   # liveness
curl -s http://localhost:8787/ready    # readiness + provider diagnostics
```

> **Drift caveat:** `package-lock.json` sometimes accumulates `peer: true`
> entries on the NAS due to mixed npm versions. `npm ci` rewrites the
> lockfile from `package.json` ranges, so stash any drift before pulling
> and accept that `npm ci` will normalize it.

### Enabling /v1/responses (PR #54 onward)

By default the synthesized "default" provider declares only
`["chat_completions"]`. To accept `POST /v1/responses` against a
responses-capable downstream:

```ini
# /home/Arnab/clawd/projects/mux/.env
DOWNSTREAM_PROTOCOLS=chat_completions,responses
```

Or, if using the multi-provider `PROVIDERS` JSON, add
`"protocols": ["chat_completions","responses"]` to the relevant
openai-compatible provider entry. Without one of these, mux returns
`503 service_unavailable: provider does not support responses protocol`
on the responses route. (The chat completions route is unaffected.)

### `anthropic-sdk` mode caveat

The current NAS deploy runs `DOWNSTREAM_MODE=anthropic-sdk`. In that
mode `MODEL_MAP` resolves to a model name sent **to the Anthropic API**.
A map like `{"gpt-4o":"gpt-4o-mini"}` will fail with
`404 not_found_error: model: gpt-4o-mini` because Anthropic doesn't have
that model. Use `ANTHROPIC_MODEL_MAP` (or values like
`claude-haiku-4-5-20251001`) when in `anthropic-sdk` mode.

---

## From-scratch install (alternative layout)

For a brand-new Debian box where you'd prefer system-level systemd and a
dedicated `mux` user (e.g., a hosted VM rather than a homelab user
account), use this layout instead.

### Prerequisites

- Debian 12+ / Ubuntu 22.04+ with `systemd`
- Node.js **22.x** (matches `.github/workflows/ci.yml`)
- Outbound HTTPS to whichever downstream(s) you'll route to

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

### Layout

```
/opt/mux/                      # source checkout
/opt/mux/.env                  # mode 600, owner mux:mux
/etc/systemd/system/mux.service
```

### Install

```bash
sudo useradd --system --create-home --home-dir /var/lib/mux \
  --shell /usr/sbin/nologin mux
sudo mkdir -p /opt/mux
sudo chown mux:mux /opt/mux

sudo -u mux git clone https://github.com/arniesaha/mux.git /opt/mux
cd /opt/mux
sudo -u mux npm ci
sudo -u mux npm run build

sudo -u mux cp .env.example .env
sudo chmod 600 /opt/mux/.env
# ...edit /opt/mux/.env to your downstream
```

### Unit file (`/etc/systemd/system/mux.service`)

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mux.service
curl -s http://localhost:8787/health
curl -s http://localhost:8787/ready
```

---

## Reverse proxy / TLS (optional)

For LAN-only access, exposing port 8787 directly is fine. For remote
access, front Mux with Caddy or nginx:

```caddy
mux.local {
  reverse_proxy localhost:8787 {
    flush_interval -1   # critical for SSE streaming
  }
}
```

The `flush_interval -1` (Caddy) / `proxy_buffering off` (nginx) is
**required** for `stream: true` responses — without it the proxy
buffers SSE chunks and clients see no events until the response
completes.

## Plumbing with OpenClaw + AgentWeave

```
OpenClaw agent ─► AgentWeave proxy ─► Mux ─► LiteLLM/Anthropic/OpenAI
```

### OpenClaw → Mux

Configure your OpenClaw `openai-codex` (or any OpenAI-compatible)
provider with a custom `baseUrl` pointing at Mux:

```jsonc
{
  "id": "mux-openai",
  "kind": "openai-codex",
  "baseUrl": "http://192.168.1.70:8787/v1",
  "auth": { "mode": "bearer", "token": "<downstream key>" }
}
```

OpenClaw posts to `<baseUrl>/responses` and `<baseUrl>/chat/completions`,
landing on Mux's `/v1/responses` and `/v1/chat/completions`.

> **Required:** OpenClaw fix `13085b0bdf` ("honor providerConfig.baseUrl
> in dynamic-model synthesis fallback"). Earlier versions silently fall
> back to `api.openai.com` / `chatgpt.com` and bypass Mux entirely. Make
> sure the OpenClaw build is at or after that commit.

### AgentWeave → Mux

If routing through AgentWeave's Python proxy first, point its upstream at
Mux and use:

```ini
DOWNSTREAM_AUTH_MODE=passthrough
```

so Mux forwards the inbound `Authorization` header to the eventual
downstream. AgentWeave PR #183 reroutes `/v1/responses` calls carrying
ChatGPT-mode JWTs to `chatgpt.com/backend-api/codex/responses` — that
rewrite happens inside AgentWeave's proxy and is independent of Mux.

### Caller agent attribution

Mux propagates `X-AgentWeave-*` headers and emits `prov.agent.id` span
attributes when `X-AgentWeave-Agent-Id` is present. Make sure your
reverse proxy doesn't strip those headers.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `503 service_unavailable: provider 'default' does not support responses protocol` | `DOWNSTREAM_PROTOCOLS` not set to include `responses` (or the matching `PROVIDERS` entry lacks `"responses"`) |
| `404 not_found_error: model: <name>` from Anthropic | In `anthropic-sdk` mode, `MODEL_MAP` is rewriting to a non-Anthropic model name. Use `ANTHROPIC_MODEL_MAP` or a Claude model name. |
| `502 downstream_error` with `additional_properties_strict` complaint | Pre-PR #54 Mux leaking the `runtime` field downstream — upgrade past #54 (`e13d242`) |
| SSE stream stalls / events arrive in one chunk at the end | Reverse-proxy buffering — set `flush_interval -1` (Caddy) / `proxy_buffering off` (nginx) |
| 401 from upstream when using ChatGPT-mode JWT | Wrong upstream — ChatGPT-mode tokens require `chatgpt.com/backend-api/codex`, not `api.openai.com`. See AgentWeave PR #183. |
| `mux.service` won't start (user systemd) | Check `loginctl enable-linger arnab` so user services run without an active session. `systemctl --user status` will be empty over plain SSH otherwise — use `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user ...`. |

## Environment reference

Full env-var reference lives in `.env.example` and the README's
"Environment variables" table. The keys most relevant to a NAS deploy:

- `PORT`, `NODE_ENV`
- `DOWNSTREAM_MODE`, `DOWNSTREAM_BASE_URL`, `DOWNSTREAM_AUTH_MODE`,
  `DOWNSTREAM_API_KEY`
- `DOWNSTREAM_PROTOCOLS` (PR #54 — needed for `/v1/responses`)
- `DOWNSTREAM_MOCK_FALLBACK=false` for production
- `MODEL_MAP` / `ANTHROPIC_MODEL_MAP` (the latter applies first for
  Claude requests)
- `AGENTWEAVE_OTLP_ENDPOINT`, `AGENTWEAVE_AGENT_ID`
- `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` if
  `DOWNSTREAM_MODE=anthropic-sdk`
