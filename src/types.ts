export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  // Upstream clients (OpenAI-style, pi-ai, etc.) send either a plain string
  // or an array of content parts (text, image_url, native Anthropic blocks).
  // We normalize downstream.
  content: unknown;
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
