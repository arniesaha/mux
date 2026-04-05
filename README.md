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
