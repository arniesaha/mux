export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  runtime?: string;
};

export type RouteDecision = {
  requestedModel: string;
  resolvedModel: string;
  routeReason: string;
  provider: string;
  backendTarget: string;
};
