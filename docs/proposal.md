# Mux Proposal

## Thesis

Mux is a thin router/policy layer for multi-agent runtimes that optimizes model usage across providers and runtimes, while making routing decisions observable from day one.

This is not "another generic LLM gateway." The purpose is narrower and more practical:
- reduce real token burn in personal/agentic workflows
- provide one shared policy engine across OpenClaw and Max/pi-mono
- preserve clear visibility into what happened and why

## Problem

Current agent stacks often have fragmented model usage:
- different runtimes use different provider abstractions
- strong models become the default because they are easy and reliable
- routing/fallback behavior is invisible or ad hoc
- cost control is reactive instead of policy-driven

For a personal multi-agent setup, that means higher spend and weaker intuition about where the money went.

## Why existing tools are not enough

Existing gateways/routers like LiteLLM, RouteLLM, and OpenRouter provide important building blocks.

But the gap for this setup is:
- shared use across OpenClaw and pi-mono
- system-driven routing as a first-class behavior
- routing decisions observable in AgentWeave
- a thin, hackable layer tuned for agent runtimes rather than generic app traffic

## Proposed shape

Mux should start as a separate OSS project.

- **Mux** = control/policy layer
- **AgentWeave** = observability/provenance layer
- **OpenClaw / pi-mono** = client runtimes

This keeps product boundaries clean.

## MVP architecture

1. OpenAI-compatible request surface
2. Policy engine classifies request into coarse buckets
3. Router selects provider/model
4. Request is forwarded downstream
5. Response returns to caller
6. Mux emits routing telemetry for AgentWeave

## First-pass policy buckets

- simple-chat
- reasoning
- coding
- multimodal
- fallback-retry

## Key metadata to emit

- runtime
- agent id
- session id
- requested model
- resolved model
- provider
- route reason
- fallback/escalation status
- latency
- token counts
- cost

## MVP milestones

### Milestone 1 — Thin proxy
- accept OpenAI-compatible requests
- forward to one downstream backend
- return responses transparently

### Milestone 2 — Policy routing
- classify by heuristics
- route simple vs strong
- preserve override hooks

### Milestone 3 — Runtime integrations
- OpenClaw integration
- pi-mono integration

### Milestone 4 — Observability
- AgentWeave instrumentation
- routing metadata visible in traces/dashboard

## Risks

- scope creep into full gateway platform
- routing heuristics hurting output quality
- blurred ownership between Mux and AgentWeave

## How to avoid that

- keep v0 rule-based and narrow
- optimize for observability first, sophistication second
- treat LiteLLM/OpenRouter as substrates, not competitors to reimplement

## Why this is worth building

It solves a real personal pain point now, works across multiple runtimes, and creates a stronger dogfooding loop for AgentWeave.
