import type {
  Message,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type express from "express";
import pino from "pino";

import { config } from "./config.js";
import { getProvider } from "./providers/registry.js";
import { setSpanAttrs } from "./tracing.js";
// Side-effect import: adapter modules call registerAdapter() on load. Placed
// here (not only in app.ts) so tests that import downstream.ts directly still
// get adapters registered. The circular import is safe: adapters only USE
// downstream's exports inside closures, not at module-eval time.
import "./providers/index.js";
import type {
  ChatCompletionsRequest,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIToolDef,
  RouteDecision,
} from "./types.js";

export const downstreamLogger = pino({
  level: config.nodeEnv === "development" ? "debug" : "info",
  name: "mux.downstream",
});

export type DownstreamResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      // OpenAI spec: content is null when tool_calls is present. Many
      // clients accept both null and "" — we emit null when we have tool
      // calls to match the canonical OpenAI shape.
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
    };
  };
};

// Anthropic ephemeral prompt-cache breakpoint. Attaching this to a content
// block tells Anthropic to cache the prefix up to and including that block
// for ~5 minutes; subsequent requests with the same prefix read from cache
// at ~90% discount. See issue #49.
export type AnthropicCacheControl = { type: "ephemeral" };

export class DownstreamNotConfiguredError extends Error {
  constructor(message = "Downstream is not configured") {
    super(message);
    this.name = "DownstreamNotConfiguredError";
  }
}

export class DownstreamRequestError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Downstream request failed with status ${status}`);
    this.name = "DownstreamRequestError";
    this.status = status;
    this.payload = payload;
  }
}

// Decide whether a downstream failure should trigger cross-provider failover.
// Retryable: 408/429/5xx from DownstreamRequestError, 401/403 (auth may differ
// per provider), and network-layer errors (AbortError from our timeout or
// "fetch failed" from Node's fetch). Non-retryable: 4xx client errors (400,
// 404, 422) — the request is malformed and won't improve on another provider.
export const isRetryableDownstreamError = (err: unknown): boolean => {
  if (err instanceof DownstreamRequestError) {
    const s = err.status;
    if (s === 408 || s === 429) return true;
    if (s >= 500 && s < 600) return true;
    if (s === 401 || s === 403) return true;
    return false;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (err.message.toLowerCase().includes("fetch failed")) return true;
  }
  return false;
};

const estimateTokens = (req: ChatCompletionsRequest): number => {
  return Math.max(1, Math.ceil(JSON.stringify(req.messages).length / 4));
};

export const buildMockResponse = (
  req: ChatCompletionsRequest,
  route: RouteDecision,
): DownstreamResponse => {
  const promptTokens = estimateTokens(req);

  return {
    id: `mux-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: route.resolvedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `MVP stub response from Mux. requested=${route.requestedModel}, resolved=${route.resolvedModel}, reason=${route.routeReason}`,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 20,
      total_tokens: promptTokens + 20,
    },
  };
};

export const parseJsonSafely = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

export type DownstreamRequestContext = {
  incomingAuthorizationHeader?: string;
  agentweaveHeaders?: Record<string, string>;
};

export const buildAgentweaveHeaders = (context?: DownstreamRequestContext): Record<string, string> => ({
  "x-agentweave-agent-id": config.agentweaveAgentId,
  "x-agentweave-session-id": "mux",
  "x-agentweave-project": "mux",
  ...context?.agentweaveHeaders,
});

// Test-only: drop all provider-internal caches (chiefly the Anthropic SDK
// client, which captures a `fetch` reference at construction and survives
// `vi.restoreAllMocks()`). Delegates to the provider registry which rebuilds
// providers on next access, so their caches get reset with them.
export { __resetProviderRegistryForTests as __resetAnthropicClientForTests } from "./providers/registry.js";

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

// Anthropic content block types we emit. Kept as plain object literals so we
// don't couple the rest of the file to SDK internals.
type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/;

const parseImageUrl = (url: unknown): AnthropicImageBlock | null => {
  if (typeof url !== "string" || url.length === 0) return null;
  const match = url.match(DATA_URL_RE);
  if (match) {
    return {
      type: "image",
      source: { type: "base64", media_type: match[1]!, data: match[2]! },
    };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
};

const partToBlock = (part: unknown): AnthropicContentBlock | null => {
  if (typeof part === "string") {
    return part.length > 0 ? { type: "text", text: part } : null;
  }
  if (!part || typeof part !== "object") return null;

  const p = part as Record<string, unknown>;

  // OpenAI-style image_url part: { type: "image_url", image_url: { url } }
  if (p.type === "image_url") {
    const imageUrl = p.image_url;
    if (typeof imageUrl === "string") {
      return parseImageUrl(imageUrl);
    }
    if (imageUrl && typeof imageUrl === "object") {
      return parseImageUrl((imageUrl as Record<string, unknown>).url);
    }
    return null;
  }

  // Native Anthropic image block passthrough.
  if (p.type === "image" && p.source && typeof p.source === "object") {
    return { type: "image", source: p.source as AnthropicImageBlock["source"] };
  }

  // Native Anthropic tool_use block passthrough (assistant history).
  if (p.type === "tool_use" && typeof p.id === "string" && typeof p.name === "string") {
    return { type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} };
  }

  // Native Anthropic tool_result block passthrough (tool-role history).
  if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
    const content =
      typeof p.content === "string"
        ? p.content
        : Array.isArray(p.content)
          ? p.content
              .map((c) => partToBlock(c))
              .filter((b): b is AnthropicTextBlock => b?.type === "text")
          : stringifyUnknown(p.content);
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: p.tool_use_id,
      content: content as string | AnthropicTextBlock[],
    };
    if (p.is_error === true) block.is_error = true;
    return block;
  }

  // Text-like parts.
  if (p.type === "text" && typeof p.text === "string") {
    return p.text.length > 0 ? { type: "text", text: p.text } : null;
  }
  if (p.type === "input_text" && typeof p.text === "string") {
    return p.text.length > 0 ? { type: "text", text: p.text } : null;
  }
  if (typeof p.text === "string") {
    return p.text.length > 0 ? { type: "text", text: p.text } : null;
  }
  if (typeof p.content === "string") {
    return p.content.length > 0 ? { type: "text", text: p.content } : null;
  }

  return null;
};

const normalizeContentToBlocks = (content: unknown): AnthropicContentBlock[] => {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    const blocks: AnthropicContentBlock[] = [];
    for (const part of content) {
      const block = partToBlock(part);
      if (block) blocks.push(block);
    }
    return blocks;
  }
  if (content && typeof content === "object") {
    const block = partToBlock(content);
    if (block) return [block];
  }
  return [];
};

const normalizeContentToText = (content: unknown): string => {
  return normalizeContentToBlocks(content)
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
};

export type AnthropicInputMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

// Convert an OpenAI-style tool_call (as seen on prior assistant turns in
// ChatMessage.tool_calls) into an Anthropic tool_use block. The OpenAI spec
// has `arguments` as a JSON-encoded string; we parse it back into an object
// for Anthropic. Unparseable arguments fall back to {_raw: "..."} so the model
// still sees what was attempted.
const openAIToolCallToToolUse = (call: OpenAIToolCall): AnthropicToolUseBlock => {
  let input: unknown = {};
  const raw = call.function?.arguments;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = { _raw: raw };
    }
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.function?.name ?? "unknown",
    input,
  };
};

export type AnthropicSystemBlock = {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
};

export type ToAnthropicInputOptions = {
  // When true, inject ephemeral cache_control breakpoints at:
  //   1. the (single) system text block, and
  //   2. the last content block of the last message — provided history has
  //      at least 2 messages. Single-message history skips (2) because
  //      there's no prior turn whose prefix we'd be re-using.
  cacheControl?: boolean;
};

export const toAnthropicInput = (
  req: ChatCompletionsRequest,
  opts: ToAnthropicInputOptions = {},
): {
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicInputMessage[];
} => {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => normalizeContentToText(m.content))
    .join("\n\n")
    .trim();

  const messages: AnthropicInputMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "system") continue;

    // role:"tool" → Anthropic user message with a single tool_result block.
    // tool_call_id is the link back to the assistant's earlier tool_use.id.
    if (m.role === "tool") {
      const toolUseId = m.tool_call_id;
      if (!toolUseId) {
        // No correlation id — fall back to a plain text user message so the
        // content isn't lost.
        const blocks = normalizeContentToBlocks(m.content);
        if (blocks.length > 0) messages.push({ role: "user", content: blocks });
        continue;
      }
      const resultContent =
        typeof m.content === "string"
          ? m.content
          : stringifyUnknown(normalizeContentToText(m.content) || m.content);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: resultContent,
          },
        ],
      });
      continue;
    }

    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const blocks = normalizeContentToBlocks(m.content);

    // Assistant turns may carry OpenAI-style tool_calls (from prior turns that
    // the agent replayed). Convert each to an Anthropic tool_use block and
    // append after the text blocks.
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const call of m.tool_calls) {
        blocks.push(openAIToolCallToToolUse(call));
      }
    }

    if (blocks.length === 0) continue;
    messages.push({ role, content: blocks });
  }

  // Cache-control injection. Kept out of the hot loop so the non-cache path
  // (opts.cacheControl !== true) is a no-op.
  if (opts.cacheControl) {
    // Breakpoint on last block of last message — caches the full history
    // prefix so multi-turn loops hit cache from turn 2 onwards. Skip when
    // history is a single turn: nothing to reuse yet.
    if (messages.length >= 2) {
      const last = messages[messages.length - 1]!;
      const lastBlock = last.content[last.content.length - 1];
      if (lastBlock) {
        (lastBlock as { cache_control?: AnthropicCacheControl }).cache_control = {
          type: "ephemeral",
        };
      }
    }

    if (system) {
      return {
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
      };
    }
    return { system: undefined, messages };
  }

  return { system: system || undefined, messages };
};

export type AnthropicToolDef = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
};

export type TranslateToolsOptions = {
  // When true, attach ephemeral cache_control to the LAST translated tool —
  // Anthropic caches the entire tools block up to the last marker. See #49.
  cacheControl?: boolean;
};

export const translateToolsToAnthropic = (
  tools: OpenAIToolDef[] | undefined,
  opts: TranslateToolsOptions = {},
): AnthropicToolDef[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const translated: AnthropicToolDef[] = tools
    .filter(
      (t): t is OpenAIToolDef =>
        !!t && t.type === "function" && !!t.function && typeof t.function.name === "string",
    )
    .map((t) => {
      const params = t.function.parameters;
      const input_schema: Record<string, unknown> =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : { type: "object", properties: {} };
      const out: AnthropicToolDef = {
        name: t.function.name,
        input_schema,
      };
      if (typeof t.function.description === "string") {
        out.description = t.function.description;
      }
      return out;
    });
  if (translated.length === 0) return undefined;
  if (opts.cacheControl) {
    translated[translated.length - 1]!.cache_control = { type: "ephemeral" };
  }
  return translated;
};

export const translateToolChoiceToAnthropic = (
  choice: OpenAIToolChoice | undefined,
):
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string }
  | undefined => {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (
    typeof choice === "object" &&
    choice.type === "function" &&
    choice.function &&
    typeof choice.function.name === "string"
  ) {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
};

/**
 * Translate an Anthropic `stop_reason` into an OpenAI `finish_reason`.
 *
 * OpenAI clients (including pi-ai's openai-completions adapter) only know the
 * OpenAI vocabulary: `stop | length | tool_calls | content_filter | function_call`.
 * If Mux passes Anthropic values through verbatim (`end_turn`, `max_tokens`, …),
 * pi-ai's mapStopReason throws `Unhandled stop reason: end_turn` AFTER the
 * text has already streamed. The assistant message is then persisted by the
 * agent with stopReason="error" and transform-messages.js drops it on every
 * subsequent turn — producing the +1/turn context bleed tracked in
 * arniesaha/agent-max#24.
 */
export const anthropicStopReasonToOpenAI = (
  reason: string | null | undefined,
): "stop" | "length" | "tool_calls" => {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    default:
      // end_turn / stop_sequence / refusal / pause_turn / null / unknown → "stop"
      return "stop";
  }
};

export const toOpenAIResponse = (response: Message, model: string): DownstreamResponse => {
  const textBlocks = response.content.filter((block) => block.type === "text") as Array<{
    type: "text";
    text: string;
  }>;
  const toolUseBlocks = response.content.filter((block) => block.type === "tool_use") as Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
  }>;

  const joined = textBlocks.map((block) => block.text).join("\n").trim();

  const tool_calls: OpenAIToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            // OpenAI spec requires a JSON-encoded string for arguments.
            arguments:
              typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
          },
        }))
      : undefined;

  // Content resolution:
  //   - text present → use joined text
  //   - no text but tool_calls present → null (canonical OpenAI shape)
  //   - nothing → synthetic empty-response marker so regressions are loud
  let content: string | null;
  if (joined.length > 0) {
    content = joined;
  } else if (tool_calls) {
    content = null;
  } else {
    content = `[empty response from downstream — stop_reason=${
      response.stop_reason ?? "unknown"
    }, blocks=${response.content.map((b) => b.type).join(",") || "none"}]`;
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  // Anthropic reports cached tokens in separate buckets outside input_tokens.
  // For an OpenAI-shaped client to see the true billable prompt size, we roll
  // them back into prompt_tokens and expose the cache-hit portion via the
  // canonical prompt_tokens_details.cached_tokens field. See #49.
  const rawUsage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  const cacheCreation = rawUsage.cache_creation_input_tokens ?? 0;
  const cacheRead = rawUsage.cache_read_input_tokens ?? 0;
  const hasCacheFields =
    rawUsage.cache_creation_input_tokens != null ||
    rawUsage.cache_read_input_tokens != null;

  const promptTokens = inputTokens + cacheCreation + cacheRead;
  const usage: NonNullable<DownstreamResponse["usage"]> = {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
  };
  if (hasCacheFields) {
    usage.prompt_tokens_details = { cached_tokens: cacheRead };
  }

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(tool_calls ? { tool_calls } : {}),
        },
        finish_reason: anthropicStopReasonToOpenAI(response.stop_reason),
      },
    ],
    usage,
  };
};

// Build the ordered provider chain for this request: primary followed by up
// to config.failoverMaxAttempts fallbacks. Legacy callers that pass a route
// without fallbackProviderIds get a single-entry chain.
const buildProviderChain = (route: RouteDecision): string[] => {
  const primary = route.providerId || "default";
  const fallbacks = route.fallbackProviderIds ?? [];
  const hops = Math.max(0, Math.min(config.failoverMaxAttempts, fallbacks.length));
  return [primary, ...fallbacks.slice(0, hops)];
};

const annotateFailoverHop = (
  i: number,
  id: string,
  failedProviders: string[],
  lastError: unknown,
): void => {
  setSpanAttrs({
    "prov.failover.attempt": i,
    "prov.failover.failed_providers": failedProviders.join(","),
    "prov.failover.active_provider": id,
    "prov.route.provider_id": id,
  });
  downstreamLogger.warn({
    event: "mux.failover_hop",
    from: failedProviders[failedProviders.length - 1],
    to: id,
    attempt: i,
    reason:
      lastError instanceof DownstreamRequestError
        ? `status=${lastError.status}`
        : lastError instanceof Error
          ? lastError.name
          : "unknown",
  });
};

export const callDownstream = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
  context?: DownstreamRequestContext,
): Promise<DownstreamResponse> => {
  const chain = buildProviderChain(route);
  const failedProviders: string[] = [];
  let lastError: unknown;

  for (let i = 0; i < chain.length; i++) {
    const providerId = chain[i]!;
    const provider = getProvider(providerId);
    if (!provider) {
      // Preserve legacy mock-fallback behavior only when primary "default"
      // is unregistered AND we're on the first attempt with no fallbacks —
      // otherwise the request intended a real provider and should error.
      if (
        i === 0 &&
        chain.length === 1 &&
        providerId === "default" &&
        config.downstreamMockFallbackEnabled
      ) {
        return buildMockResponse(req, route);
      }
      lastError = new DownstreamNotConfiguredError(
        `provider '${providerId}' is not registered (no matching entry in PROVIDERS env or legacy DOWNSTREAM_*)`,
      );
      failedProviders.push(providerId);
      if (i === chain.length - 1) throw lastError;
      continue;
    }

    if (i > 0) annotateFailoverHop(i, providerId, failedProviders, lastError);

    try {
      return (await provider.call(req, route, context)) as DownstreamResponse;
    } catch (err) {
      lastError = err;
      failedProviders.push(providerId);
      if (!isRetryableDownstreamError(err)) throw err;
      if (i === chain.length - 1) throw err;
    }
  }
  throw lastError ?? new DownstreamNotConfiguredError("no providers available");
};

// --- Streaming path ------------------------------------------------------

export type StreamLogCtx = {
  requestedModel: string;
  resolvedModel: string;
};

type ToolCallAccum = {
  index: number;
  id: string;
  name: string;
  argsLength: number;
};

export type StreamResult = {
  inputTokens: number;
  outputTokens: number;
  // Ephemeral-cache token buckets Anthropic reports alongside input_tokens.
  // Both default to 0 when the model/request doesn't carry cache fields.
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason: string | null;
};

// Consume an async-iterable of Anthropic RawMessageStreamEvents and write
// OpenAI-shaped chat.completion.chunk SSE frames to `res`. Returns once the
// stream is fully drained (or a terminal error chunk has been written). The
// caller is responsible for setting SSE headers BEFORE invoking this.
export const streamAnthropicToOpenAI = async (
  events: AsyncIterable<RawMessageStreamEvent>,
  res: express.Response,
  model: string,
  logCtx: StreamLogCtx,
  onAbort?: () => void,
): Promise<StreamResult> => {
  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const writeChunk = (delta: Record<string, unknown>, finishReason: string | null) => {
    const payload = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const anyRes = res as unknown as { flush?: () => void };
    if (typeof anyRes.flush === "function") anyRes.flush();
  };

  // block_index (Anthropic) → accumulator. We map each Anthropic content-block
  // index to a dense OpenAI tool_calls index so clients see 0,1,2... even if
  // Anthropic emits blocks at e.g. index 1 (text at 0, tool_use at 1).
  const toolCalls = new Map<number, ToolCallAccum>();
  let nextToolIndex = 0;
  let textLength = 0;
  let finalStopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let phase: string = "start";
  let aborted = false;
  let clientClosed = false;

  const onClose = () => {
    clientClosed = true;
    if (!aborted) {
      aborted = true;
      try {
        onAbort?.();
      } catch {
        // swallow — best-effort abort
      }
      downstreamLogger.info({
        event: "mux.anthropic_stream_client_closed",
        resolvedModel: logCtx.resolvedModel,
        phase,
      });
    }
  };
  res.once("close", onClose);

  writeChunk({ role: "assistant" }, null);

  try {
    for await (const event of events) {
      if (clientClosed) break;
      phase = event.type;
      switch (event.type) {
        case "message_start": {
          // role chunk already emitted; capture usage counters. Anthropic
          // splits billable input into input_tokens (fresh) plus two cache
          // buckets — we track all three so the final usage chunk can roll
          // them together for OpenAI parity (see #52).
          const msg = (event as {
            message?: {
              usage?: {
                input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
          }).message;
          if (msg?.usage) {
            if (typeof msg.usage.input_tokens === "number") {
              inputTokens = msg.usage.input_tokens;
            }
            if (typeof msg.usage.cache_read_input_tokens === "number") {
              cacheReadTokens = msg.usage.cache_read_input_tokens;
            }
            if (typeof msg.usage.cache_creation_input_tokens === "number") {
              cacheCreationTokens = msg.usage.cache_creation_input_tokens;
            }
          }
          break;
        }
        case "content_block_start": {
          const block = (event as { content_block: { type: string; id?: string; name?: string } }).content_block;
          if (block.type === "tool_use") {
            const idx = nextToolIndex++;
            toolCalls.set(event.index, {
              index: idx,
              id: block.id ?? "",
              name: block.name ?? "",
              argsLength: 0,
            });
            writeChunk(
              {
                tool_calls: [
                  {
                    index: idx,
                    id: block.id ?? "",
                    type: "function",
                    function: { name: block.name ?? "", arguments: "" },
                  },
                ],
              },
              null,
            );
          }
          break;
        }
        case "content_block_delta": {
          const delta = (event as { delta: { type: string; text?: string; partial_json?: string } }).delta;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            textLength += delta.text.length;
            writeChunk({ content: delta.text }, null);
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const accum = toolCalls.get(event.index);
            if (accum) {
              accum.argsLength += delta.partial_json.length;
              writeChunk(
                {
                  tool_calls: [
                    {
                      index: accum.index,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                null,
              );
            }
          }
          break;
        }
        case "content_block_stop":
          // accumulator closes implicitly
          break;
        case "message_delta": {
          const d = (event as { delta: { stop_reason?: string | null }; usage?: { output_tokens?: number } }).delta;
          if (d && typeof d.stop_reason === "string") {
            finalStopReason = d.stop_reason;
          }
          // Anthropic output_tokens is cumulative — always take the latest value.
          // Some models also update cache_* buckets here; apply the same
          // last-value-wins rule so telemetry matches what Anthropic billed.
          const mdUsage = (event as {
            usage?: {
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          }).usage;
          if (mdUsage) {
            if (typeof mdUsage.output_tokens === "number") {
              outputTokens = mdUsage.output_tokens;
            }
            if (typeof mdUsage.cache_read_input_tokens === "number") {
              cacheReadTokens = mdUsage.cache_read_input_tokens;
            }
            if (typeof mdUsage.cache_creation_input_tokens === "number") {
              cacheCreationTokens = mdUsage.cache_creation_input_tokens;
            }
          }
          break;
        }
        case "message_stop":
          // terminal — fall through to end-of-stream logic below
          break;
        default:
          break;
      }
    }

    const toolUseBlockCount = toolCalls.size;
    const empty = toolUseBlockCount === 0 && textLength === 0;
    const respEvent = {
      event: "mux.anthropic_response",
      resolvedModel: logCtx.resolvedModel,
      stopReason: finalStopReason,
      stopSequence: null,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      blockCount: (textLength > 0 ? 1 : 0) + toolUseBlockCount,
      blockTypes: [
        ...(textLength > 0 ? ["text"] : []),
        ...Array.from({ length: toolUseBlockCount }, () => "tool_use"),
      ],
      textBlockCount: textLength > 0 ? 1 : 0,
      toolUseBlockCount,
      toolNames: Array.from(toolCalls.values()).map((t) => t.name),
      joinedTextLength: textLength,
      empty,
      streamed: true,
    };
    if (empty) {
      downstreamLogger.warn(respEvent);
    } else {
      downstreamLogger.info(respEvent);
    }

    if (!clientClosed) {
      writeChunk({}, anthropicStopReasonToOpenAI(finalStopReason));
      // OpenAI include_usage convention: trailing chunk with choices: [] + usage.
      // Mirrors toOpenAIResponse — cache tokens get rolled into prompt_tokens
      // so billable prompt size is symmetric across streaming and non-streaming.
      const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
      const usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens: number };
      } = {
        prompt_tokens: promptTokens,
        completion_tokens: outputTokens,
        total_tokens: promptTokens + outputTokens,
      };
      if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
        usage.prompt_tokens_details = { cached_tokens: cacheReadTokens };
      }
      res.write(
        `data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage,
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    downstreamLogger.error({
      event: "mux.anthropic_stream_error",
      resolvedModel: logCtx.resolvedModel,
      phase,
      err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
    });
    if (!clientClosed) {
      const msg = err instanceof Error ? err.message : String(err);
      writeChunk({ content: `[stream error: ${msg}]` }, null);
      writeChunk({}, anthropicStopReasonToOpenAI(finalStopReason));
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } finally {
    res.off("close", onClose);
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    stopReason: finalStopReason,
  };
};

export const emitDownstreamResponseAsSse = (res: express.Response, completion: DownstreamResponse): void => {
  if (!res.headersSent) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
  }
  const msg = completion.choices?.[0]?.message;
  const text = typeof msg?.content === "string" ? msg.content : "";
  const finishReason = completion.choices?.[0]?.finish_reason ?? "stop";
  const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const created = completion.created;
  const id = completion.id;
  const model = completion.model;

  write({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant", ...(text ? { content: text } : {}) }, finish_reason: null }],
  });
  write({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  if (completion.usage) {
    write({ id, object: "chat.completion.chunk", created, model, choices: [], usage: completion.usage });
  }
  res.write("data: [DONE]\n\n");
  res.end();
};

export const streamDownstream = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
  res: express.Response,
  context?: DownstreamRequestContext,
): Promise<void> => {
  const chain = buildProviderChain(route);
  const failedProviders: string[] = [];
  let lastError: unknown;

  for (let i = 0; i < chain.length; i++) {
    const providerId = chain[i]!;
    const provider = getProvider(providerId);
    if (!provider) {
      if (
        i === 0 &&
        chain.length === 1 &&
        providerId === "default" &&
        config.downstreamMockFallbackEnabled
      ) {
        emitDownstreamResponseAsSse(res, buildMockResponse(req, route));
        return;
      }
      lastError = new DownstreamNotConfiguredError(
        `provider '${providerId}' is not registered (no matching entry in PROVIDERS env or legacy DOWNSTREAM_*)`,
      );
      failedProviders.push(providerId);
      if (i === chain.length - 1) throw lastError;
      continue;
    }

    if (i > 0) annotateFailoverHop(i, providerId, failedProviders, lastError);

    try {
      await provider.stream(req, route, res, context);
      return;
    } catch (err) {
      lastError = err;
      failedProviders.push(providerId);
      // Once bytes have been written to the client we cannot failover — the
      // adapter is responsible for emitting an in-band error chunk and
      // ending the SSE stream. Rethrow so the app layer logs it.
      if (res.headersSent) throw err;
      if (!isRetryableDownstreamError(err)) throw err;
      if (i === chain.length - 1) throw err;
    }
  }
  throw lastError ?? new DownstreamNotConfiguredError("no providers available");
};
