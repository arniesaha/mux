# PRD: agent-max integration with Mux (AgentWeave from day 1)

## Goal

Make **agent-max** use Mux as its model routing layer before OpenClaw integration, while preserving and extending AgentWeave visibility from day one.

This should validate that Mux is truly cross-runtime and not just OpenClaw-specific glue.

## Why agent-max first

- `agent-max` is a real working runtime with a clean TypeScript codebase.
- It already uses `@mariozechner/pi-ai`, so there is an explicit model/client integration point.
- It already contains AgentWeave-related code (`src/tracing.ts`, `src/agentweave-context.ts`), which makes telemetry validation easier.
- It is a better first integration target than OpenClaw because the code path is smaller and more directly controlled.

## Repo / runtime reality

Validated local repo:
- Local path: `/home/Arnab/x-workspace/agent-max`
- Git remote: `https://github.com/arniesaha/agent-max`

Relevant files:
- `src/agent.ts` — model creation and stream wrapper
- `src/index.ts` — startup path
- `src/tracing.ts` — AgentWeave tracing setup
- `src/agentweave-context.ts` — session context tracking
- `tests/tracing.test.ts` — current tracing test anchor

## Current model path in agent-max

Today, `agent-max` creates its model in `src/agent.ts` roughly like this:
- chooses `DEFAULT_MODEL`
- derives provider from model name (`claude*` → Anthropic, otherwise Google in current implementation)
- calls `getModel(provider, defaultModel)` from `@mariozechner/pi-ai`
- overrides provider base URLs for AgentWeave proxy if set:
  - `ANTHROPIC_BASE_URL`
  - `GOOGLE_GENAI_BASE_URL`
- wraps `streamSimple()` with AgentWeave headers (`X-AgentWeave-*`)

This means the likely Mux integration point is in `src/agent.ts`, at the model/base URL layer and/or request stream path.

## Success criteria

1. `agent-max` sends model requests through Mux.
2. Mux resolves requested vs resolved model and forwards to LiteLLM.
3. AgentWeave receives routing metadata for the request.
4. At least one routed request is visible end-to-end with:
   - runtime=`max` or `agent-max`
   - requested model
   - resolved model
   - route reason
   - provider/backend target
5. Existing agent-max behavior remains intact aside from routing path changes.
6. No OpenClaw changes are required for this milestone.

## Proposed integration shape

### Request path
agent-max
→ Mux (`/v1/chat/completions`)
→ LiteLLM
→ provider/model

### Telemetry path
agent-max
→ AgentWeave spans (existing)
Mux
→ routing metadata / route-decision spans

The important thing is that both layers are observable:
- agent-max still emits its runtime/agent spans
- Mux emits the model routing decision

## Most likely implementation approach

### Option A — OpenAI-compatible base URL override (preferred if pi-ai supports it cleanly)
Configure agent-max so that its model calls target Mux as an OpenAI-compatible endpoint, while preserving the requested model name and AgentWeave headers.

This is likely the simplest path if `@mariozechner/pi-ai` allows an OpenAI-compatible transport/base URL for the relevant provider path.

### Option B — Custom wrapper around pi-ai stream path
If direct base URL override is awkward across providers, add a narrow wrapper at the `streamSimple()` or model-client call site in `src/agent.ts` that sends requests to Mux explicitly.

This should be used only if Option A is not clean enough.

## Required configuration surface in agent-max

Need a clean way to set:
- Mux base URL
- optional Mux API key if added later
- default requested model
- runtime identifier header (e.g. `x-runtime: agent-max`)
- AgentWeave session/agent context if useful to forward

Likely env vars to introduce on the agent-max side:
- `MUX_BASE_URL`
- `MUX_API_KEY` (optional, future-safe)
- maybe `MUX_ENABLED=true|false`

## Implementation tasks

1. Inspect exactly how `@mariozechner/pi-ai` handles provider base URLs / OpenAI-compatible endpoints in agent-max.
2. Add Mux as a configurable backend in `src/agent.ts`.
3. Ensure agent-max includes runtime identifier/header (e.g. `x-runtime: agent-max`).
4. Verify requested model from agent-max reaches Mux correctly.
5. Verify Mux → LiteLLM forwarding works.
6. Add/verify Mux routing telemetry fields needed for AgentWeave.
7. Validate one real request end-to-end.
8. Add or extend tests if feasible.
9. Document setup and known limitations.

## Telemetry requirements for AgentWeave

At minimum, Mux should emit:
- runtime
- requestedModel
- resolvedModel
- routeReason
- provider
- backendTarget
- latency
- token counts if available
- cost if available

Later additions:
- fallback/escalation metadata
- policy class
- route confidence
- local-vs-cloud selection reason

## Risks / unknowns

- `@mariozechner/pi-ai` may not expose one clean provider-agnostic override path for Mux.
- agent-max currently infers provider somewhat simplistically (`claude*` vs Google), which may need refinement once Mux supports broader routing.
- If agent-max depends on provider-specific features beyond OpenAI-compatible chat, Mux may need a compatibility layer later.
- AgentWeave instrumentation may be easiest to enrich in Mux first, then correlate with agent-max runtime spans.

## Non-goals

- Full agent-max refactor
- Perfect routing policy
- OpenClaw integration in the same milestone
- Multi-turn policy optimization
- Replacing pi-ai internals wholesale

## Deliverables

- agent-max configured to call Mux locally
- one end-to-end validated routed request
- AgentWeave-visible routing metadata
- setup docs
- follow-up issues for anything still missing
