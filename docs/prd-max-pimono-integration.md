# PRD: Max / pi-mono integration for Mux (AgentWeave from day 1)

## Goal

Make Max (built on pi-mono) use Mux as its model routing layer before OpenClaw integration, while emitting AgentWeave-compatible telemetry from day one.

This should validate that Mux is truly cross-runtime and not just OpenClaw-specific glue.

## Why Max first

- pi-mono is lighter-weight and code-driven, so model routing integration is likely easier to reason about.
- It provides a second runtime proving the architecture works beyond OpenClaw.
- AgentWeave can then compare routing behavior across two runtimes.

## Success criteria

1. Max/pi-mono sends model requests through Mux.
2. Mux resolves requested vs resolved model and forwards to LiteLLM.
3. AgentWeave receives routing metadata for the request.
4. At least one routed request is visible end-to-end with:
   - runtime=max or pi-mono
   - requested model
   - resolved model
   - route reason
   - provider/backend target
5. No changes are required to OpenClaw for this milestone.

## Proposed integration shape

### Request path
pi-mono / Max
→ Mux (`/v1/chat/completions`)
→ LiteLLM
→ provider/model

### Telemetry path
Mux
→ AgentWeave instrumentation

## Required configuration surface

For Max/pi-mono, we need a clean way to set:
- Mux base URL
- optional Mux API key if added later
- default requested model
- runtime identifier (`max`, `pi-mono`, or a more specific agent label)
- AgentWeave session/agent context if available from caller side

## Implementation tasks

1. Identify the current pi-mono model client abstraction and where the OpenAI-compatible base URL can be swapped.
2. Add Mux as a configurable backend for Max.
3. Ensure Max includes a runtime identifier/header (e.g. `x-runtime: max`).
4. Verify requested model from Max reaches Mux correctly.
5. Add/verify Mux → LiteLLM forwarding.
6. Add Mux routing telemetry fields needed for AgentWeave.
7. Validate one real request end-to-end.
8. Document setup and known limitations.

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

- The exact pi-mono integration point may differ from earlier planning notes.
- If Max uses provider-specific features beyond OpenAI-compatible chat, Mux may need a compatibility layer.
- AgentWeave instrumentation may be easiest to add in Mux first, then enrich later.

## Non-goals

- Full Max refactor
- Perfect routing policy
- OpenClaw integration in the same milestone
- Multi-turn policy optimization

## Deliverables

- Max configured to call Mux locally
- One end-to-end validated routed request
- AgentWeave-visible routing metadata
- Setup docs
- Follow-up issues for anything still missing
