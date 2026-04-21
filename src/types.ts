export type OpenAIFunctionDef = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type OpenAIToolDef = {
  type: "function";
  function: OpenAIFunctionDef;
};

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    // OpenAI spec: JSON-encoded string of the arguments.
    arguments: string;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  // Upstream clients (OpenAI-style, pi-ai, etc.) send either a plain string
  // or an array of content parts (text, image_url, native Anthropic blocks).
  // We normalize downstream.
  content: unknown;
  // Present on assistant messages from prior turns that invoked tools.
  tool_calls?: OpenAIToolCall[];
  // Present on role:"tool" messages; correlates to the tool_calls[].id that
  // produced this result.
  tool_call_id?: string;
};

export type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  runtime?: string;
  tools?: OpenAIToolDef[];
  tool_choice?: OpenAIToolChoice;
};

export type RouteDecision = {
  requestedModel: string;
  resolvedModel: string;
  routeReason: string;
  // Legacy descriptive fields (kind + target). Kept for log/dashboard
  // compatibility. New code should use `providerId` for dispatch.
  provider: string;
  backendTarget: string;
  // The registered provider identifier the dispatcher uses to look up a
  // concrete backend. Defaults to "default" for legacy single-provider setups.
  providerId: string;
  // Cost-ordered fallback chain (primary excluded). When the primary returns
  // a retryable error, the dispatcher walks this list up to
  // config.failoverMaxAttempts hops. Empty when only one provider matches.
  fallbackProviderIds: string[];
};
