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

const getAnthropicClient = (): Anthropic => {
  const token = config.anthropicOauthToken?.trim() || config.anthropicApiKey?.trim();
  const baseURL = config.anthropicBaseUrl || config.downstreamBaseUrl || undefined;

  if (!token) {
    throw new DownstreamNotConfiguredError(
      "ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY is required when DOWNSTREAM_MODE=anthropic-sdk",
    );
  }

  const cacheKey = `${baseURL ?? "default"}|${token}`;
  if (anthropicClient && anthropicClientKey === cacheKey) {
    return anthropicClient;
  }

  anthropicClient = new Anthropic({
    apiKey: token,
    baseURL,
    timeout: config.downstreamTimeoutMs,
  });
  anthropicClientKey = cacheKey;

  return anthropicClient;
};

const toAnthropicInput = (req: ChatCompletionsRequest): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} => {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();

  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.role === "tool" ? `[tool]\n${m.content}` : m.content,
    }));

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

  try {
    const response = await client.messages.create({
      model: route.resolvedModel,
      max_tokens: req.max_tokens ?? 1024,
      temperature: req.temperature,
      system,
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
