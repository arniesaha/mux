import type express from "express";

import { setSpanAttrs, withLlmSpan } from "../tracing.js";
import { computeCostUsd, resolveCallerAgentId } from "./cost.js";
import type { ChatCompletionsRequest, RouteDecision } from "../types.js";
import {
  buildMockResponse,
  DownstreamRequestError,
  downstreamLogger,
  emitDownstreamResponseAsSse,
  parseJsonSafely,
  type DownstreamRequestContext,
  type DownstreamResponse,
} from "../downstream.js";
import { registerAdapter } from "./registry.js";
import type { Provider, ProviderConfig } from "./types.js";

const resolveAuthHeaderForProvider = (
  cfg: ProviderConfig,
  context?: DownstreamRequestContext,
): { header: "authorization" | "x-api-key"; value: string } | null => {
  const auth = cfg.auth;
  if (auth.mode === "none") return null;

  if (auth.mode === "passthrough") {
    const value = context?.incomingAuthorizationHeader?.trim();
    return value ? { header: "authorization", value } : null;
  }

  if (auth.mode === "x-api-key") {
    const token = auth.apiKey?.trim();
    return token ? { header: "x-api-key", value: token } : null;
  }

  if (auth.mode === "bearer") {
    const token = auth.apiKey?.trim();
    return token ? { header: "authorization", value: `Bearer ${token}` } : null;
  }

  // anthropic-* modes don't apply to openai-compatible — fall through
  return null;
};

const logDownstreamRequest = (
  cfg: ProviderConfig,
  req: ChatCompletionsRequest,
  route: RouteDecision,
  url: string,
  streamed: boolean,
): void => {
  downstreamLogger.info({
    event: "mux.downstream_request",
    providerId: cfg.id,
    requestedModel: route.requestedModel,
    resolvedModel: route.resolvedModel,
    url,
    authMode: cfg.auth.mode,
    timeoutMs: cfg.timeoutMs ?? null,
    messageCount: req.messages.length,
    rawRoles: req.messages.map((m) => m.role),
    toolsCount: req.tools?.length ?? 0,
    streamed,
  });
};

export const createOpenAICompatibleProvider = (cfg: ProviderConfig): Provider => {
  if (cfg.kind !== "openai-compatible") {
    throw new Error(`createOpenAICompatibleProvider: wrong kind=${cfg.kind}`);
  }
  const timeoutMs = cfg.timeoutMs ?? 30_000;

  const call = async (
    req: ChatCompletionsRequest,
    route: RouteDecision,
    context?: DownstreamRequestContext,
  ): Promise<DownstreamResponse> => {
    if (!cfg.baseUrl) {
      // No base URL — this provider exists only as a mock-fallback for tests.
      // Return a mock response directly so callers get a working shape.
      return buildMockResponse(req, route);
    }

    return withLlmSpan("openai-compatible", route.resolvedModel, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(cfg.extraHeaders ?? {}),
      };
      const auth = resolveAuthHeaderForProvider(cfg, context);
      if (auth) headers[auth.header] = auth.value;

      const payload = { ...req, model: route.resolvedModel };
      const url = `${cfg.baseUrl}/chat/completions`;
      logDownstreamRequest(cfg, req, route, url, false);
      const startedAt = Date.now();

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await parseJsonSafely(response);
          downstreamLogger.error({
            event: "mux.downstream_error",
            providerId: cfg.id,
            resolvedModel: route.resolvedModel,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            body,
            streamed: false,
          });
          throw new DownstreamRequestError(response.status, body);
        }

        const result = (await response.json()) as DownstreamResponse;
        const latencyMs = Date.now() - startedAt;

        const promptTokens = result.usage?.prompt_tokens ?? 0;
        const completionTokens = result.usage?.completion_tokens ?? 0;
        const costUsd = computeCostUsd(cfg, route.resolvedModel, promptTokens, completionTokens);
        const callerAgentId = resolveCallerAgentId(context);
        setSpanAttrs({
          "prov.llm.prompt_tokens": promptTokens,
          "prov.llm.completion_tokens": completionTokens,
          "prov.llm.total_tokens": result.usage?.total_tokens ?? 0,
          "prov.llm.stop_reason": result.choices?.[0]?.finish_reason ?? "unknown",
          "cost.usd": costUsd,
          ...(callerAgentId ? { "prov.agent.id": callerAgentId } : {}),
        });

        downstreamLogger.info({
          event: "mux.downstream_response",
          providerId: cfg.id,
          resolvedModel: route.resolvedModel,
          status: response.status,
          model: result.model ?? null,
          inputTokens: result.usage?.prompt_tokens ?? null,
          outputTokens: result.usage?.completion_tokens ?? null,
          totalTokens: result.usage?.total_tokens ?? null,
          stopReason: result.choices?.[0]?.finish_reason ?? null,
          latencyMs,
          streamed: false,
        });

        return result;
      } finally {
        clearTimeout(timeout);
      }
    });
  };

  const stream = async (
    req: ChatCompletionsRequest,
    route: RouteDecision,
    res: express.Response,
    context?: DownstreamRequestContext,
  ): Promise<void> => {
    if (!cfg.baseUrl) {
      // Mock fallback for streaming — emit the mock response as SSE chunks.
      emitDownstreamResponseAsSse(res, buildMockResponse(req, route));
      return;
    }

    await withLlmSpan("openai-compatible", route.resolvedModel, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(cfg.extraHeaders ?? {}),
      };
      const auth = resolveAuthHeaderForProvider(cfg, context);
      if (auth) headers[auth.header] = auth.value;

      const payload = { ...req, model: route.resolvedModel, stream: true };
      const url = `${cfg.baseUrl}/chat/completions`;
      logDownstreamRequest(cfg, req, route, url, true);
      const startedAt = Date.now();

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await parseJsonSafely(response);
          downstreamLogger.error({
            event: "mux.downstream_error",
            providerId: cfg.id,
            resolvedModel: route.resolvedModel,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            body,
            streamed: true,
          });
          throw new DownstreamRequestError(response.status, body);
        }

        if (!response.body) {
          throw new DownstreamRequestError(502, { message: "empty response body from downstream" });
        }

        if (!res.headersSent) {
          res.status(200);
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
        }

        const onClientClose = () => {
          try { controller.abort(); } catch { /* best effort */ }
        };
        res.once("close", onClientClose);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytesStreamed = 0;
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) {
              bytesStreamed += value.length;
              res.write(decoder.decode(value, { stream: true }));
            }
          }
          const tail = decoder.decode();
          if (tail) res.write(tail);
        } finally {
          res.off("close", onClientClose);
          try { reader.releaseLock(); } catch { /* best effort */ }
        }

        res.end();

        downstreamLogger.info({
          event: "mux.downstream_response",
          providerId: cfg.id,
          resolvedModel: route.resolvedModel,
          status: response.status,
          bytesStreamed,
          latencyMs: Date.now() - startedAt,
          streamed: true,
        });
      } finally {
        clearTimeout(timeout);
      }
    });
  };

  return {
    id: cfg.id,
    kind: cfg.kind,
    models: cfg.models,
    call,
    stream,
  };
};

// Register at module load so the registry can instantiate.
registerAdapter("openai-compatible", createOpenAICompatibleProvider);
