# Mux

> A thin model routing and policy layer for agent runtimes.

Mux sits in front of existing model gateways/providers and makes system-driven routing decisions based on policy, not per-user micromanagement. It is designed to work across multiple agent runtimes (OpenClaw, pi-mono/Max) while emitting rich routing telemetry to [AgentWeave](https://github.com/arniesaha/agentweave).

## Why Mux exists

Strong models are expensive. Cheap models are often good enough.

In practice, personal agent stacks end up with the same problem:
- one runtime uses a strong model by default
- another runtime has a different provider abstraction
- fallbacks and routing are hard to reason about
- token/cost usage becomes visible only after the bill hurts

Mux is the control point for that problem.

## What Mux provides

- an OpenAI-compatible `/v1/chat/completions` endpoint
- a configurable policy-based routing rules
- support for routing across models and providers
- fallback and escalation handling
- structured routing metadata for observability

## Architecture

Mux sits between heterogeneous agent runtimes and heterogeneous model backends. One OpenAI-compatible endpoint, a policy layer, and a downstream dispatcher selected via `DOWNSTREAM_MODE`.

![Mux architecture](./docs/diagrams/architecture.png)

Inside `src/downstream.ts`, Mux translates OpenAI chat-completion shape to and from the Anthropic Messages API — content blocks (text + image), tools, and stop reasons all map across:

![Shape translation](./docs/diagrams/shape-translation.png)

End-to-end, a single streaming request flows through validation, routing, the Anthropic SDK, and an event mapper that rewrites Anthropic stream events as OpenAI SSE chunks on the way back to the client:

![Turn lifecycle](./docs/diagrams/sequence.png)

## Getting started

```bash
git clone https://github.com/arniesaha/mux.git
cd mux
npm install
cp .env.example .env
npm run dev
```

Server starts on `http://localhost:8787` by default.

## Configure your downstream

### Option 1 — OpenAI-compatible backend (e.g. LiteLLM, OpenRouter)

```bash
DOWNSTREAM_MODE=openai-compatible
DOWNSTREAM_BASE_URL=https://your-gateway.com/v1   # your proxy/gateway URL
DOWNSTREAM_API_KEY=sk-...                          # your API key
DOWNSTREAM_AUTH_MODE=bearer                         # bearer | x-api-key | passthrough | none
DOWNSTREAM_EXTRA_HEADERS={}
DOWNSTREAM_TIMEOUT_MS=30000
```

### Option 2 — Anthropic SDK (direct OAuth tokens)

```bash
DOWNSTREAM_MODE=anthropic-sdk
ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-...            # Anthropic OAuth token
ANTHROPIC_BASE_URL=https://api.anthropic.com        # or your proxy URL
DOWNSTREAM_TIMEOUT_MS=30000
```

> **Note:** Keep sending OpenAI-compatible requests to Mux (`/v1/chat/completions`). Mux translates to the downstream API internally.

## Routing behavior

Mux routes requests using configurable policy rules:

| Request type | Resolved model |
|---|---|
| Short lightweight prompts (< 80 chars, no task cues) | `claude-haiku-4-5-20251001` |
| Coding / debugging / execution cues | `claude-sonnet-4-6` |
| Complex reasoning / planning / architecture cues | `claude-opus-4-6` |
| `gpt-4o` (simple prompts) | downgraded to `gpt-4o-mini` |

Routing for Max runtime requests is evaluated on the **last user message only** — system prompts and conversation history are ignored to prevent false escalation.

Route decisions are logged with: `runtime`, `requestedModel`, `resolvedModel`, `routeReason`, `provider`, `backendTarget`.

## Example request

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-runtime: openclaw' \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "say hi"}]}' | jq
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Server port |
| `NODE_ENV` | `development` | Environment |
| `MODEL_MAP` | `{}` | JSON map of `requestedModel → resolvedModel` |
| `ANTHROPIC_MODEL_MAP` | `{}` | Anthropic-only routing overrides |
| `DOWNSTREAM_MODE` | `openai-compatible` | `openai-compatible` or `anthropic-sdk` |
| `DOWNSTREAM_BASE_URL` | — | Backend URL (openai-compatible mode) |
| `DOWNSTREAM_API_KEY` | — | API key for downstream auth |
| `DOWNSTREAM_AUTH_MODE` | `bearer` | `bearer` \| `x-api-key` \| `passthrough` \| `none` |
| `DOWNSTREAM_EXTRA_HEADERS` | `{}` | JSON map of extra static headers |
| `DOWNSTREAM_TIMEOUT_MS` | `30000` | Request timeout in ms |
| `DOWNSTREAM_MOCK_FALLBACK` | `true` (dev) | Return mock response when no backend configured |
| `ANTHROPIC_OAUTH_TOKEN` | — | OAuth token (preferred for anthropic-sdk) |
| `ANTHROPIC_API_KEY` | — | API key fallback for anthropic-sdk |
| `ANTHROPIC_BASE_URL` | — | Override Anthropic API URL (supports proxies) |

## Running tests

```bash
npm test
```

## Architecture diagrams

Diagram sources are in `docs/diagrams/` as `.excalidraw` files. Re-render with the [excalidraw-diagram-skill](https://github.com/coleam00/excalidraw-diagram-skill).

## License

MIT © 2026 Arnab Saha
