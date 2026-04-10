import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";

import { config } from "./config.js";
import type { ChatCompletionsRequest, RouteDecision } from "./types.js";

export type DownstreamResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
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

const normalizeContentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (p.type === "input_text" && typeof p.text === "string") return p.text;
          if (p.type === "text" && typeof p.text === "string") return p.text;
        }
        return stringifyUnknown(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return stringifyUnknown(content);
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

const toAnthropicInput = (req: ChatCompletionsRequest): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }>;
} => {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => normalizeContentToText(m.content))
    .join("\n\n")
    .trim();

  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const text = normalizeContentToText(m.content);
      return {
        role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content: [
          {
            type: "text" as const,
            text: m.role === "tool" ? `[tool]\n${text}` : text,
          },
        ],
      };
    });

  return { system: system || undefined, messages };
};

const toOpenAIResponse = (response: Message, model: string): DownstreamResponse => {
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

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
          content: text,
        },
        finish_reason: response.stop_reason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
};

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

  try {
    const response = await client.messages.create({
      model: route.resolvedModel,
      max_tokens: req.max_tokens ?? 1024,
      temperature: req.temperature,
      system: systemBlocks as any,
      messages,
      stream: false,
    });

    return toOpenAIResponse(response, route.resolvedModel);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      throw new DownstreamRequestError(error.status ?? 500, error.error ?? error.message);
    }

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
