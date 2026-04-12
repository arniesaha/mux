# LiteLLM E2E Validation Runbook

Validates that Mux's `openai-compatible` downstream mode correctly routes
requests through a real LiteLLM proxy backed by Google Gemini. This proves the
full chain: client -> Mux (route_decision) -> LiteLLM -> Gemini -> response.

## Prerequisites

1. **mux-litellm.service** running on `127.0.0.1:4001` with a valid
   `.litellm.e2e.yaml` config and Gemini API key in `run/litellm.env`.
   ```bash
   systemctl --user status mux-litellm.service
   ```
2. **dist/ built** (`npm run build` if stale).
3. **Production mux on 8787 left untouched** -- do not restart or reconfigure it.

## Procedure

### 1. Start a temporary Mux instance on port 8788

```bash
cd /home/Arnab/clawd/projects/mux

PORT=8788 \
  DOWNSTREAM_MODE=openai-compatible \
  DOWNSTREAM_BASE_URL=http://127.0.0.1:4001/v1 \
  DOWNSTREAM_API_KEY=mux-litellm-local \
  DOWNSTREAM_AUTH_MODE=bearer \
  DOWNSTREAM_MOCK_FALLBACK=false \
  NODE_ENV=development \
  node dist/server.js > /tmp/mux-e2e.log 2>&1 &

MUX_PID=$!
sleep 3
curl -sf localhost:8788/health   # expect {"ok":true}
```

### 2. Test: non-streaming request

```bash
curl -s http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-runtime: openclaw" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in exactly 5 words."}],
    "max_tokens": 50
  }'
```

### 3. Test: streaming request

```bash
curl -s http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-runtime: openclaw" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in exactly 5 words."}],
    "max_tokens": 100,
    "stream": true
  }'
```

### 4. Test: model downgrade (gpt-4o -> gpt-4o-mini)

```bash
curl -s http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-runtime: openclaw" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words."}],
    "max_tokens": 50
  }'
```

### 5. Check logs and tear down

```bash
cat /tmp/mux-e2e.log   # inspect route_decision, errors
kill $MUX_PID
curl -sf localhost:8787/health   # confirm production mux still alive
```

## Observed Results (2025-04-11)

### Non-streaming (Test 2) -- PASS

**Log: `mux.route_decision`**
```json
{
  "event": "mux.route_decision",
  "runtime": "openclaw",
  "requestedModel": "gpt-4o-mini",
  "resolvedModel": "gpt-4o-mini",
  "routeReason": "default:passthrough",
  "provider": "openai-compatible",
  "backendTarget": "http://127.0.0.1:4001/v1",
  "downstreamMode": "openai-compatible"
}
```

**Response body** (truncated):
```json
{
  "id": "fxvbaZm5OpOtqtsP2efUoQ8",
  "model": "gpt-4o-mini",
  "object": "chat.completion",
  "choices": [
    {
      "finish_reason": "length",
      "index": 0,
      "message": { "content": null, "role": "assistant" }
    }
  ],
  "usage": { "completion_tokens": 47, "prompt_tokens": 9, "total_tokens": 56 }
}
```

Note: `content: null` with all tokens as `reasoning_tokens` is a Gemini 2.5
thinking-model quirk via LiteLLM -- the model used its entire budget on
reasoning. Increase `max_tokens` or use a non-thinking model to see text output.

### Streaming (Test 3) -- FAIL (known bug)

**Error**: `SyntaxError: Unexpected token d in JSON at position 0`

The `callOpenAICompatible` function in `src/downstream.ts` always calls
`response.json()` on the upstream response, even when `stream: true` was sent
in the payload. LiteLLM returns an SSE text stream (`data: {...}\n\n`), which
cannot be parsed as JSON. The openai-compatible streaming path is not
implemented -- streaming only works via the `anthropic-sdk` downstream mode.

**Log: `mux.unhandled_error`**
```json
{
  "event": "mux.unhandled_error",
  "runtime": "openclaw",
  "err": {
    "type": "SyntaxError",
    "message": "Unexpected token d in JSON at position 0"
  }
}
```

### Model downgrade (Test 4) -- PASS

**Log: `mux.route_decision`**
```json
{
  "event": "mux.route_decision",
  "runtime": "openclaw",
  "requestedModel": "gpt-4o",
  "resolvedModel": "gpt-4o-mini",
  "routeReason": "config:model_map_override",
  "provider": "openai-compatible",
  "backendTarget": "http://127.0.0.1:4001/v1",
  "downstreamMode": "openai-compatible"
}
```

Response returned `"model": "gpt-4o-mini"` confirming the downgrade applied.

## Caveats

1. **Streaming is broken in openai-compatible mode.**
   `callOpenAICompatible()` does not handle SSE responses. When `stream: true`
   is passed, the upstream returns SSE but Mux tries `response.json()` and
   crashes. This needs a dedicated streaming code path similar to what exists
   for `anthropic-sdk` mode.

2. **No `downstream_request` / `downstream_response` log events** exist for the
   openai-compatible path. Only `mux.route_decision` fires. The anthropic path
   logs `mux.anthropic_request` and `mux.anthropic_response`, but the
   openai-compatible path has no equivalent instrumentation.

3. **Auth mode matters.** `DOWNSTREAM_AUTH_MODE=none` does NOT work with
   LiteLLM when a `master_key` is configured. Use `bearer` mode with
   `DOWNSTREAM_API_KEY` set to the LiteLLM master key.

4. **Gemini thinking models** (gemini-2.5-pro, gemini-2.5-flash) may return
   `content: null` with all tokens counted as `reasoning_tokens` when
   `max_tokens` is low. This is upstream LiteLLM/Gemini behavior, not a Mux bug.

## Status: validated 2025-04-11
