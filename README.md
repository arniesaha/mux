# Mux

A thin model routing and policy layer for agent runtimes.

Mux sits in front of existing model gateways/providers and makes system-driven routing decisions based on policy, not per-user micromanagement. It is designed to work across multiple agent runtimes like OpenClaw and pi-mono/Max, while emitting rich routing telemetry to AgentWeave from day one.

## Why Mux exists

Strong models are expensive. Cheap models are often good enough.

In practice, personal agent stacks end up with the same problem:
- one runtime uses a strong model by default
- another runtime has a different provider abstraction
- fallbacks and routing are hard to reason about
- token/cost usage becomes visible only after the bill hurts

Mux is the control point for that problem.

## Core idea

Mux provides:
- an OpenAI-compatible endpoint
- a lightweight policy engine
- routing decisions across models/providers
- fallback/escalation handling
- routing metadata for observability

AgentWeave remains the observability layer. Mux is the policy/control layer.

## Initial goals

- Support OpenClaw and pi-mono/Max through one shared endpoint
- Route requests by simple policy heuristics first
- Track requested model vs resolved model
- Capture why a route happened
- Emit routing spans/attributes for AgentWeave

## Non-goals for v0

- perfect learned routing
- enterprise auth/governance features
- supporting every provider under the sun
- replacing LiteLLM or OpenRouter wholesale

## Expected architecture

Client runtime (OpenClaw / pi-mono)
→ Mux policy layer
→ downstream provider or gateway
→ response back to client

Along the way, Mux records:
- runtime
- agent/session context
- requested model
- resolved model
- route reason
- fallback/escalation path
- cost and latency metadata

## MVP success criteria

- OpenClaw can use Mux as its model endpoint
- Max/pi-mono can use Mux as its model endpoint
- simple prompts route to a cheaper model
- harder prompts can escalate to a stronger model
- routing decisions are visible in AgentWeave

---

## MVP implementation (review build)

This repo now includes a reviewable MVP skeleton with:

- `POST /v1/chat/completions` (OpenAI-compatible shape)
- `GET /health`
- simple rule-based routing/policy stub (requested model -> resolved model)
- structured route decision logs
- downstream passthrough abstraction (LiteLLM/OpenAI-compatible + explicit mock fallback)
- unit tests for routing and downstream behavior

### Stack

- **Node.js + TypeScript**
- **Express** for HTTP
- **Pino** for structured JSON logs
- **Vitest** for basic tests

Chosen for fast local setup, low code surface area, and easy review.

### Quick start

```bash
cd /home/Arnab/clawd/projects/mux
npm install
cp .env.example .env
npm run dev
```

Server runs on `http://localhost:8787` by default.

### Run with LiteLLM locally

Mux expects an OpenAI-compatible backend and is tested against LiteLLM's `/v1/chat/completions` interface.

1. Start LiteLLM (example):

```bash
litellm --host 0.0.0.0 --port 4000
```

2. In `.env`, point Mux to LiteLLM:

```bash
DOWNSTREAM_BASE_URL=http://localhost:4000/v1
DOWNSTREAM_API_KEY= # optional, based on auth mode
DOWNSTREAM_AUTH_MODE=bearer
DOWNSTREAM_EXTRA_HEADERS={}
DOWNSTREAM_TIMEOUT_MS=30000
DOWNSTREAM_MOCK_FALLBACK=false
```

3. Start Mux (`npm run dev`) and send OpenAI-compatible requests to Mux.

### Test

```bash
npm test
```

### Example request

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-runtime: openclaw' \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "say hi"}]
  }' | jq
```

### Current behavior

- If `MODEL_MAP` includes the requested model, that mapping wins.
- Else, `gpt-4o` is downgraded to `gpt-4o-mini` for simple prompts.
- If prompt appears complex (basic keyword heuristic), model is kept.
- If `DOWNSTREAM_BASE_URL` is set, Mux forwards to `${DOWNSTREAM_BASE_URL}/chat/completions` with the resolved model.
- Downstream auth is configurable via `DOWNSTREAM_AUTH_MODE`:
  - `bearer` (default): `Authorization: Bearer ${DOWNSTREAM_API_KEY}`
  - `x-api-key`: `x-api-key: ${DOWNSTREAM_API_KEY}`
  - `passthrough`: forwards inbound `Authorization` header as-is
  - `none`: no auth header
- Optional static headers can be added with `DOWNSTREAM_EXTRA_HEADERS` (JSON map).
- If `DOWNSTREAM_BASE_URL` is not set:
  - and `DOWNSTREAM_MOCK_FALLBACK=true`, Mux returns an explicit local mock response (safe dev path)
  - and `DOWNSTREAM_MOCK_FALLBACK=false`, Mux returns `503 service_unavailable`

### Environment variables

- `PORT` (default `8787`)
- `NODE_ENV` (default `development`)
- `MODEL_MAP` (JSON map for explicit model overrides)
- `DEFAULT_PROVIDER` (metadata for logs)
- `DEFAULT_BACKEND_TARGET` (metadata for logs)
- `DOWNSTREAM_BASE_URL` (e.g. `http://localhost:4000/v1`)
- `DOWNSTREAM_API_KEY` (optional key/token for downstream auth)
- `DOWNSTREAM_AUTH_MODE` (`bearer` default, `x-api-key`, `passthrough`, `none`)
- `DOWNSTREAM_EXTRA_HEADERS` (JSON map, optional extra headers)
- `DOWNSTREAM_TIMEOUT_MS` (default `30000`)
- `DOWNSTREAM_MOCK_FALLBACK` (default true outside production)

### Structured logging fields

Each request logs:

- `runtime`
- `requestedModel`
- `resolvedModel`
- `routeReason`
- `provider`
- `backendTarget`

This is intended as the minimum routing telemetry surface before wiring into AgentWeave/OpenClaw/Max.

