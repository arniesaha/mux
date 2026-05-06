# Compatibility matrix

This document tracks which (provider kind × protocol × feature) combinations are
exercised by automated tests, which are merely intended to work, and which are
known gaps. A combination is only marked "supported + tested" when at least one
e2e test under `tests/e2e/` drives it through `createApp()` end-to-end.

Status legend:

- supported + tested — at least one e2e or integration test asserts the contract
- supported + untested — code path exists but no e2e coverage; relies on unit tests only
- intentionally unsupported — out of scope by design
- broken / known-gap — known not to work, tracked as an issue

| Provider kind        | Protocol           | Feature                                                | Status                  | Notes |
| -------------------- | ------------------ | ------------------------------------------------------ | ----------------------- | ----- |
| openai-compatible    | chat_completions   | non-streaming response (`POST /v1/chat/completions`)   | supported + tested      | `tests/e2e/chat-completions.e2e.test.ts` mocks `globalThis.fetch`, asserts 200 + canonical `chat.completion` shape |
| openai-compatible    | chat_completions   | streaming SSE (`stream:true`)                          | supported + tested      | `tests/e2e/chat-completions.e2e.test.ts` asserts `text/event-stream` framing + terminal `data: [DONE]` |
| openai-compatible    | chat_completions   | tool calling round-trip                                | supported + tested      | `tests/e2e/tools.e2e.test.ts` — request includes `tools`, downstream returns OpenAI `tool_calls`, response surfaces them |
| openai-compatible    | responses          | non-streaming passthrough (`POST /v1/responses`)       | supported + tested      | `tests/e2e/responses.e2e.test.ts` configures provider with `protocols: ["chat_completions","responses"]` |
| openai-compatible    | responses          | streaming SSE                                          | supported + untested    | implementation lives in `streamResponsesDownstream`; no e2e yet — covered indirectly by unit tests in `tests/downstream.test.ts` |
| anthropic-sdk        | chat_completions   | non-streaming, OpenAI-shape input → Anthropic translation | supported + tested   | `tests/e2e/anthropic-translation.e2e.test.ts` mocks `globalThis.fetch` (the Anthropic SDK hits it under the hood) and asserts the upstream payload is in Anthropic shape |
| anthropic-sdk        | chat_completions   | streaming SSE                                          | supported + untested    | covered by unit tests (`streamAnthropicToOpenAI`); no e2e yet |
| anthropic-sdk        | chat_completions   | tool calling round-trip                                | supported + untested    | covered by `tests/downstream.test.ts` ("callDownstream — tools forwarding to Anthropic SDK"); no e2e |
| anthropic-sdk        | chat_completions   | `cache_control` injection on translated requests       | supported + tested      | `tests/e2e/anthropic-translation.e2e.test.ts` asserts ephemeral `cache_control` on the last tool/message block |
| anthropic-sdk        | chat_completions   | `cache_read` / `cache_creation` usage surfacing        | supported + untested    | covered by unit tests; no e2e |
| anthropic-sdk        | responses          | non-streaming + streaming                              | intentionally unsupported | the Anthropic SDK adapter does not implement `callResponses` / `streamResponses`; routing rejects responses requests for anthropic-sdk providers |
| any                  | n/a                | `GET /health`                                          | supported + tested      | `tests/app.test.ts` |
| any                  | n/a                | `GET /ready` (200 with providers)                      | supported + tested      | `tests/e2e/health-readiness.e2e.test.ts` |
| any                  | n/a                | `GET /ready` (503 with no providers)                   | supported + tested      | `tests/e2e/health-readiness.e2e.test.ts` |
| any                  | n/a                | `POST /v1/route/resolve` (no dispatch)                 | supported + tested      | `tests/e2e/route-resolve.e2e.test.ts` asserts `globalThis.fetch` is never called |
| any                  | n/a                | cross-provider failover on retryable errors            | supported + untested    | covered by unit tests in `tests/downstream.test.ts`; no e2e |

## Heavier integration coverage

A real integration suite that hits a live LiteLLM or Anthropic endpoint is
intentionally out of scope for the default CI run — it's flaky, slow, and
requires secrets. The e2e suite under `tests/e2e/` mocks at the network
boundary (`globalThis.fetch`), which is what both the openai-compatible
adapter and the Anthropic SDK use. If/when a live integration suite is
added it should run as a separate, optional CI job.

## How to add a row

1. Pick the (provider kind × protocol × feature) cell.
2. Add a focused test under `tests/e2e/` that drives it through `createApp()`.
3. Update the row's status to "supported + tested" with a link to the test.
