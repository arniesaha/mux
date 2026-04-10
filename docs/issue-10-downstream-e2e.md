# Issue #10 — Downstream E2E plan (Mux -> LiteLLM -> real provider)

## Recommended first path (most reliable)

Use **Mux -> LiteLLM with API-key auth** first, not OAuth:

1. Run LiteLLM as OpenAI-compatible proxy (`/v1/chat/completions`)
2. Configure LiteLLM with real provider keys (OpenAI and/or Anthropic)
3. Give Mux a LiteLLM-facing key (`DOWNSTREAM_API_KEY`) and use `DOWNSTREAM_AUTH_MODE=bearer`
4. Validate Mux request succeeds with `DOWNSTREAM_MOCK_FALLBACK=false`

Why first:
- smallest moving parts
- aligns with Mux default OpenAI-compatible contract
- avoids current OAuth edge-case risk, especially Anthropic passthrough

## Auth mode support in Mux

Mux now supports these downstream auth modes:

- `bearer` (default): `Authorization: Bearer <DOWNSTREAM_API_KEY>`
- `x-api-key`: `x-api-key: <DOWNSTREAM_API_KEY>`
- `passthrough`: forwards inbound `Authorization` header
- `none`: sends no auth header

Also supports `DOWNSTREAM_EXTRA_HEADERS` for provider/proxy-specific headers.

## LiteLLM auth maturity snapshot

Based on docs + open issues:

- **OpenAI API key auth:** mature, recommended now
- **Anthropic API key auth:** mature, recommended now
- **OpenAI OAuth / custom OpenAI-compatible OAuth:** possible, but more config + less battle-tested than API key for this setup
- **Anthropic OAuth passthrough:** not reliable enough to be first path (known header-handling issues have existed)

## Practical execution order

1. **Land Mux auth-mode flexibility** (this PR)
2. Stand up/test LiteLLM with API-key based provider config
3. Validate E2E via curl against Mux (mock fallback disabled)
4. Only after stable E2E, evaluate optional OAuth track in a separate issue/PR

## Example env for initial E2E

```bash
DOWNSTREAM_BASE_URL=http://<litellm-host>:4000/v1
DOWNSTREAM_API_KEY=<litellm-virtual-or-proxy-key>
DOWNSTREAM_AUTH_MODE=bearer
DOWNSTREAM_EXTRA_HEADERS={}
DOWNSTREAM_MOCK_FALLBACK=false
```

If downstream expects `x-api-key` instead:

```bash
DOWNSTREAM_AUTH_MODE=x-api-key
```
