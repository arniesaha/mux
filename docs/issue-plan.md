# Initial Issue Plan

## Epic: Bootstrap Mux

1. **Repo bootstrap + README**
   - project thesis
   - architecture diagram
   - non-goals
   - quickstart

2. **OpenAI-compatible `/chat/completions` proxy**
   - accept request
   - forward downstream
   - return response transparently

3. **Policy engine v0**
   - classify request into coarse buckets
   - requested vs resolved model selection
   - config-driven rules

4. **Provider/backend adapter abstraction**
   - start with one backend path
   - likely direct OpenAI-compatible downstream first

5. **Routing decision logging**
   - requested model
   - resolved model
   - provider
   - route reason
   - fallback info

6. **AgentWeave instrumentation**
   - emit spans/attributes for routing decisions
   - make telemetry visible in traces

7. **OpenClaw integration**
   - docs
   - test against local config
   - capture requested vs resolved model usage

8. **pi-mono / Max integration**
   - docs
   - example config
   - verify router-compatible flow

## Follow-ups

9. **Fallback + escalation policies**
10. **Budget guardrails**
11. **Dry-run / shadow routing mode**
12. **Savings reporting dashboard**
