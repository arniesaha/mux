import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import pino from "pino";

import { config } from "./config.js";
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

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

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
  };
};

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

const estimateTokens = (req: ChatCompletionsRequest): number => {
  return Math.max(1, Math.ceil(JSON.stringify(req.messages).length / 4));
};

const buildMockResponse = (
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

const parseJsonSafely = async (response: Response): Promise<unknown> => {
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
};

const resolveAuthHeader = (context?: DownstreamRequestContext): string | null => {
  if (config.downstreamAuthMode === "none") return null;

  if (config.downstreamAuthMode === "passthrough") {
    const value = context?.incomingAuthorizationHeader?.trim();
    return value ? value : null;
  }

  const token = config.downstreamApiKey?.trim();
  if (!token) return null;

  if (config.downstreamAuthMode === "x-api-key") {
    return token;
  }

  return `Bearer ${token}`;
};

const callOpenAICompatible = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
  context?: DownstreamRequestContext,
): Promise<DownstreamResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.downstreamTimeoutMs);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...config.downstreamExtraHeaders,
  };

  const authHeader = resolveAuthHeader(context);
  if (authHeader) {
    if (config.downstreamAuthMode === "x-api-key") {
      headers["x-api-key"] = authHeader;
    } else {
      headers.authorization = authHeader;
    }
  }

  const payload = {
    ...req,
    model: route.resolvedModel,
  };

  try {
    const response = await fetch(`${config.downstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new DownstreamRequestError(response.status, await parseJsonSafely(response));
    }

    return (await response.json()) as DownstreamResponse;
  } finally {
    clearTimeout(timeout);
  }
};

let anthropicClient: Anthropic | null = null;
let anthropicClientKey: string | null = null;

// Test-only: drop the cached Anthropic client so a fresh one is constructed
// on the next call. Needed because the SDK captures a `fetch` reference at
// construction time, which survives `vi.restoreAllMocks()`.
export const __resetAnthropicClientForTests = () => {
  anthropicClient = null;
  anthropicClientKey = null;
};

const CLAUDE_CODE_VERSION = "2.1.62";

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

const getAnthropicClient = (): Anthropic => {
  const oauthToken = config.anthropicOauthToken?.trim();
  const apiKey = config.anthropicApiKey?.trim();
  const baseURL = config.anthropicBaseUrl || config.downstreamBaseUrl || undefined;

  if (!oauthToken && !apiKey) {
    throw new DownstreamNotConfiguredError(
      "ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY is required when DOWNSTREAM_MODE=anthropic-sdk",
    );
  }

  const authKind = oauthToken ? "oauth" : "apiKey";
  const authValue = oauthToken || apiKey!;
  const cacheKey = `${baseURL ?? "default"}|${authKind}|${authValue}`;
  if (anthropicClient && anthropicClientKey === cacheKey) {
    return anthropicClient;
  }

  anthropicClient = new Anthropic({
    ...(oauthToken ? { authToken: oauthToken, apiKey: null } : { apiKey: apiKey! }),
    baseURL,
    timeout: config.downstreamTimeoutMs,
    dangerouslyAllowBrowser: true,
    defaultHeaders: oauthToken
      ? {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
          "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
          "x-app": "cli",
        }
      : {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
        },
  });
  anthropicClientKey = cacheKey;

  return anthropicClient;
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

export const toAnthropicInput = (req: ChatCompletionsRequest): {
  system?: string;
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

  return { system: system || undefined, messages };
};

export const translateToolsToAnthropic = (
  tools: OpenAIToolDef[] | undefined,
): Array<{ name: string; description?: string; input_schema: Record<string, unknown> }> | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const translated = tools
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
      const out: { name: string; description?: string; input_schema: Record<string, unknown> } = {
        name: t.function.name,
        input_schema,
      };
      if (typeof t.function.description === "string") {
        out.description = t.function.description;
      }
      return out;
    });
  return translated.length > 0 ? translated : undefined;
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
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
};

const summarizeMessagesForLog = (messages: AnthropicInputMessage[]) =>
  messages.map((m, index) => {
    const textLength = m.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .reduce((sum, b) => sum + b.text.length, 0);
    const imageCount = m.content.filter((b) => b.type === "image").length;
    return { index, role: m.role, textLength, imageCount, blockCount: m.content.length };
  });

const callAnthropicSdk = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
): Promise<DownstreamResponse> => {
  const client = getAnthropicClient();
  const { system, messages } = toAnthropicInput(req);
  const isOauth = Boolean(config.anthropicOauthToken?.trim());
  const systemBlocks = isOauth
    ? [
        { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ...(system ? [{ type: "text" as const, text: system }] : []),
      ]
    : system;

  const maxTokens = req.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const systemLength = Array.isArray(systemBlocks)
    ? systemBlocks.reduce((sum, b) => sum + b.text.length, 0)
    : (systemBlocks?.length ?? 0);

  const anthropicTools = translateToolsToAnthropic(req.tools);
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
  });

  try {
    const response = await client.messages.create({
      model: route.resolvedModel,
      max_tokens: maxTokens,
      temperature: req.temperature,
      system: systemBlocks as any,
      messages: messages as any,
      stream: false,
      ...(anthropicTools ? { tools: anthropicTools as any } : {}),
      ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice as any } : {}),
    });

    const textBlocks = response.content.filter((b) => b.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      name: string;
    }>;
    const joinedTextLength = textBlocks.reduce((sum, b) => sum + b.text.length, 0);
    const blockTypes = response.content.map((b) => b.type);
    // A response with tool_use blocks is not empty — the model is calling a
    // tool, even if it produced no user-visible text. Only warn when there is
    // genuinely nothing for the client to render or act on.
    const empty =
      toolUseBlocks.length === 0 && (textBlocks.length === 0 || joinedTextLength === 0);

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
    if (empty) {
      downstreamLogger.warn(respEvent);
    } else {
      downstreamLogger.info(respEvent);
    }

    return toOpenAIResponse(response, route.resolvedModel);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      downstreamLogger.error({
        event: "mux.anthropic_api_error",
        resolvedModel: route.resolvedModel,
        status: error.status ?? null,
        name: error.name,
        message: error.message,
        body: error.error ?? null,
      });
      throw new DownstreamRequestError(error.status ?? 500, error.error ?? error.message);
    }

    downstreamLogger.error({
      event: "mux.anthropic_unknown_error",
      resolvedModel: route.resolvedModel,
      err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    throw error;
  }
};

export const callDownstream = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
  context?: DownstreamRequestContext,
): Promise<DownstreamResponse> => {
  if (config.downstreamMode === "anthropic-sdk") {
    return callAnthropicSdk(req, route);
  }

  if (!config.downstreamBaseUrl) {
    if (config.downstreamMockFallbackEnabled) {
      return buildMockResponse(req, route);
    }

    throw new DownstreamNotConfiguredError(
      "DOWNSTREAM_BASE_URL is required when DOWNSTREAM_MOCK_FALLBACK=false",
    );
  }

  return callOpenAICompatible(req, route, context);
};
