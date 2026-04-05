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
  constructor(message = "LiteLLM downstream is not configured") {
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

const callLiteLLM = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
): Promise<DownstreamResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.downstreamTimeoutMs);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (config.downstreamApiKey) {
    headers.authorization = `Bearer ${config.downstreamApiKey}`;
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

export const callDownstream = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
): Promise<DownstreamResponse> => {
  if (!config.downstreamBaseUrl) {
    if (config.downstreamMockFallbackEnabled) {
      return buildMockResponse(req, route);
    }

    throw new DownstreamNotConfiguredError(
      "DOWNSTREAM_BASE_URL is required when DOWNSTREAM_MOCK_FALLBACK=false",
    );
  }

  return callLiteLLM(req, route);
};
