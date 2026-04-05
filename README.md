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
- downstream passthrough abstraction (currently mock/stubbed)
- unit tests for routing behavior

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
- Response is stubbed via `src/downstream.ts` but keeps OpenAI-compatible response shape.

### Structured logging fields

Each request logs:

- `runtime`
- `requestedModel`
- `resolvedModel`
- `routeReason`
- `provider`
- `backendTarget`

This is intended as the minimum routing telemetry surface before wiring into AgentWeave/OpenClaw/Max.

