import Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type express from "express";

import { config } from "../config.js";
import { setSpanAttrs, withLlmSpan } from "../tracing.js";
import { computeCostUsd, resolveCallerAgentId } from "./cost.js";
import type { ChatCompletionsRequest, RouteDecision } from "../types.js";
import {
  anthropicStopReasonToOpenAI,
  buildAgentweaveHeaders,
  DownstreamNotConfiguredError,
  DownstreamRequestError,
  downstreamLogger,
  streamAnthropicToOpenAI,
  toAnthropicInput,
  toOpenAIResponse,
  translateToolChoiceToAnthropic,
  translateToolsToAnthropic,
  type AnthropicInputMessage,
  type DownstreamRequestContext,
  type DownstreamResponse,
} from "../downstream.js";
import { registerAdapter } from "./registry.js";
import type { Provider, ProviderConfig } from "./types.js";

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
const CLAUDE_CODE_VERSION = "2.1.62";

type AnthropicAuth = {
  mode: "oauth" | "apiKey";
  token: string;
  baseUrl: string | null;
};

const extractAuth = (cfg: ProviderConfig): AnthropicAuth => {
  const a = cfg.auth;
  if (a.mode === "anthropic-oauth") {
    return { mode: "oauth", token: a.oauthToken, baseUrl: a.baseUrl ?? cfg.baseUrl ?? null };
  }
  if (a.mode === "anthropic-api-key") {
    return { mode: "apiKey", token: a.apiKey, baseUrl: a.baseUrl ?? cfg.baseUrl ?? null };
  }
  throw new DownstreamNotConfiguredError(
    `provider '${cfg.id}' (kind=anthropic-sdk) requires anthropic-oauth or anthropic-api-key auth`,
  );
};

type ClientCache = { client: Anthropic; key: string } | null;

export const createAnthropicSdkProvider = (cfg: ProviderConfig): Provider => {
  if (cfg.kind !== "anthropic-sdk") {
    throw new Error(`createAnthropicSdkProvider: wrong kind=${cfg.kind}`);
  }
  const timeoutMs = cfg.timeoutMs ?? 30_000;

  // Per-provider client cache. The SDK captures `fetch` at construction time,
  // which survives vitest's restoreAllMocks — so tests reset the cache via the
  // registry reset. The cache key encodes (baseUrl, auth) so a config swap
  // mid-session rebuilds the client.
  let cache: ClientCache = null;

  const getClient = (): Anthropic => {
    const auth = extractAuth(cfg);
    const key = `${auth.baseUrl ?? "default"}|${auth.mode}|${auth.token}`;
    if (cache && cache.key === key) return cache.client;

    const client = new Anthropic({
      ...(auth.mode === "oauth"
        ? { authToken: auth.token, apiKey: null }
        : { apiKey: auth.token }),
      baseURL: auth.baseUrl ?? undefined,
      timeout: timeoutMs,
      dangerouslyAllowBrowser: true,
      defaultHeaders:
        auth.mode === "oauth"
          ? {
              accept: "application/json",
              "anthropic-dangerous-direct-browser-access": "true",
              "anthropic-beta":
                "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
              "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
              "x-app": "cli",
            }
          : {
              accept: "application/json",
              "anthropic-dangerous-direct-browser-access": "true",
              "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
            },
    });
    cache = { client, key };
    return client;
  };

  const resetClient = (): void => {
    cache = null;
  };

  const summarizeMessagesForLog = (messages: AnthropicInputMessage[]) =>
    messages.map((m, index) => {
      const textLength = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .reduce((sum, b) => sum + b.text.length, 0);
      const imageCount = m.content.filter((b) => b.type === "image").length;
      return { index, role: m.role, textLength, imageCount, blockCount: m.content.length };
    });

  const prepare = (
    req: ChatCompletionsRequest,
    route: RouteDecision,
    streamed: boolean,
  ): { client: Anthropic; params: Record<string, unknown> } => {
    const client = getClient();
    const cacheControl = config.anthropicPromptCacheEnabled;
    const { system, messages } = toAnthropicInput(req, { cacheControl });
    const isOauth = cfg.auth.mode === "anthropic-oauth";

    // Normalize to the shape Anthropic's SDK accepts: string | block[].
    // When cacheControl is on, toAnthropicInput already returns blocks. The
    // oauth branch must always prepend the Claude Code identity prefix, and
    // merge with whatever toAnthropicInput returned.
    let systemBlocks: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined;
    if (isOauth) {
      const prefix = {
        type: "text" as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      };
      if (Array.isArray(system)) {
        systemBlocks = [prefix, ...system];
      } else if (typeof system === "string" && system.length > 0) {
        systemBlocks = [prefix, { type: "text", text: system }];
      } else {
        systemBlocks = [prefix];
      }
    } else {
      systemBlocks = system;
    }

    const maxTokens = req.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    const systemLength = Array.isArray(systemBlocks)
      ? systemBlocks.reduce((sum, b) => sum + b.text.length, 0)
      : (systemBlocks?.length ?? 0);

    const anthropicTools = translateToolsToAnthropic(req.tools, { cacheControl });
    const anthropicToolChoice = translateToolChoiceToAnthropic(req.tool_choice);

    downstreamLogger.info({
      event: "mux.anthropic_request",
      requestedModel: route.requestedModel,
      resolvedModel: route.resolvedModel,
      maxTokens,
      systemLength,
      messageCount: messages.length,
      rawMessageCount: req.messages.length,
      rawRoles: req.messages.map((m) => m.role),
      messages: summarizeMessagesForLog(messages),
      toolsCount: anthropicTools?.length ?? 0,
      toolChoice: anthropicToolChoice ?? null,
      streamed,
    });

    const params: Record<string, unknown> = {
      model: route.resolvedModel,
      max_tokens: maxTokens,
      temperature: req.temperature,
      system: systemBlocks,
      messages,
    };
    if (anthropicTools) params.tools = anthropicTools;
    if (anthropicToolChoice) params.tool_choice = anthropicToolChoice;

    return { client, params };
  };

  const handleError = (error: unknown, route: RouteDecision): DownstreamRequestError | Error => {
    if (error instanceof Anthropic.APIError) {
      downstreamLogger.error({
        event: "mux.anthropic_api_error",
        resolvedModel: route.resolvedModel,
        status: error.status ?? null,
        name: error.name,
        message: error.message,
        body: error.error ?? null,
      });
      return new DownstreamRequestError(error.status ?? 500, error.error ?? error.message);
    }
    downstreamLogger.error({
      event: "mux.anthropic_unknown_error",
      resolvedModel: route.resolvedModel,
      err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return error instanceof Error ? error : new Error(String(error));
  };

  const call = async (
    req: ChatCompletionsRequest,
    route: RouteDecision,
    context?: DownstreamRequestContext,
  ): Promise<DownstreamResponse> => {
    return withLlmSpan("anthropic", route.resolvedModel, async () => {
      const { client, params } = prepare(req, route, false);
      try {
        const response = await client.messages.create(
          { ...(params as any), stream: false },
          { headers: buildAgentweaveHeaders(context) },
        );

        const textBlocks = response.content.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use") as Array<{ type: "tool_use"; name: string }>;
        const joinedTextLength = textBlocks.reduce((sum, b) => sum + b.text.length, 0);
        const blockTypes = response.content.map((b) => b.type);
        const empty = toolUseBlocks.length === 0 && (textBlocks.length === 0 || joinedTextLength === 0);

        const costUsd = computeCostUsd(
          cfg,
          route.resolvedModel,
          response.usage.input_tokens,
          response.usage.output_tokens,
        );
        const callerAgentId = resolveCallerAgentId(context);
        setSpanAttrs({
          "prov.llm.prompt_tokens": response.usage.input_tokens,
          "prov.llm.completion_tokens": response.usage.output_tokens,
          "prov.llm.total_tokens": response.usage.input_tokens + response.usage.output_tokens,
          "prov.llm.stop_reason": anthropicStopReasonToOpenAI(response.stop_reason) ?? "unknown",
          "cost.usd": costUsd,
          ...(callerAgentId ? { "prov.agent.id": callerAgentId } : {}),
        });

        const respEvent = {
          event: "mux.anthropic_response",
          resolvedModel: route.resolvedModel,
          stopReason: response.stop_reason ?? null,
          stopSequence: response.stop_sequence ?? null,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          blockCount: response.content.length,
          blockTypes,
          textBlockCount: textBlocks.length,
          toolUseBlockCount: toolUseBlocks.length,
          toolNames: toolUseBlocks.map((b) => b.name),
          joinedTextLength,
          empty,
        };
        if (empty) downstreamLogger.warn(respEvent); else downstreamLogger.info(respEvent);

        return toOpenAIResponse(response, route.resolvedModel);
      } catch (error) {
        throw handleError(error, route);
      }
    });
  };

  const stream = async (
    req: ChatCompletionsRequest,
    route: RouteDecision,
    res: express.Response,
    context?: DownstreamRequestContext,
  ): Promise<void> => {
    await withLlmSpan("anthropic", route.resolvedModel, async () => {
      const { client, params } = prepare(req, route, true);

      let anthropicStream: Awaited<ReturnType<typeof client.messages.create>>;
      try {
        anthropicStream = (await client.messages.create(
          { ...(params as any), stream: true },
          { headers: buildAgentweaveHeaders(context) },
        )) as any;
      } catch (error) {
        throw handleError(error, route);
      }

      if (!res.headersSent) {
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
      }

      const abortable = anthropicStream as unknown as {
        controller?: AbortController;
        [Symbol.asyncIterator]: () => AsyncIterator<RawMessageStreamEvent>;
      };

      const result = await streamAnthropicToOpenAI(
        abortable as AsyncIterable<RawMessageStreamEvent>,
        res,
        route.resolvedModel,
        { requestedModel: route.requestedModel, resolvedModel: route.resolvedModel },
        () => {
          try { abortable.controller?.abort(); } catch { /* best effort */ }
        },
      );

      const costUsd = computeCostUsd(
        cfg,
        route.resolvedModel,
        result.inputTokens,
        result.outputTokens,
      );
      const callerAgentId = resolveCallerAgentId(context);
      setSpanAttrs({
        "prov.llm.prompt_tokens": result.inputTokens,
        "prov.llm.completion_tokens": result.outputTokens,
        "prov.llm.total_tokens": result.inputTokens + result.outputTokens,
        "prov.llm.stop_reason": anthropicStopReasonToOpenAI(result.stopReason) ?? "unknown",
        "cost.usd": costUsd,
        ...(callerAgentId ? { "prov.agent.id": callerAgentId } : {}),
      });
    });
  };

  // Expose resetClient through the provider's .call indirectly — we attach it
  // via a well-known property so downstream.ts can re-export a global reset.
  const provider: Provider & { __resetClient: () => void } = {
    id: cfg.id,
    kind: cfg.kind,
    models: cfg.models,
    call,
    stream,
    __resetClient: resetClient,
  };
  return provider;
};

registerAdapter("anthropic-sdk", createAnthropicSdkProvider);
