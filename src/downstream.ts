import type { ChatCompletionsRequest, RouteDecision } from "./types.js";

type DownstreamResponse = {
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
    finish_reason: "stop";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

const estimateTokens = (req: ChatCompletionsRequest): number => {
  return Math.max(1, Math.ceil(JSON.stringify(req.messages).length / 4));
};

export const callDownstream = async (
  req: ChatCompletionsRequest,
  route: RouteDecision,
): Promise<DownstreamResponse> => {
  // MVP stub: this is where a provider SDK or gateway HTTP call would happen.
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
