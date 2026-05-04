import type express from "express";

import type {
  ChatCompletionsRequest,
  ResponsesRequest,
  RouteDecision,
} from "../types.js";

export type Protocol = "chat_completions" | "responses";

export type ProviderKind = "openai-compatible" | "anthropic-sdk";

export type ProviderAuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; apiKey: string }
  | { mode: "x-api-key"; apiKey: string }
  | { mode: "passthrough" }
  | { mode: "anthropic-oauth"; oauthToken: string; baseUrl?: string | null }
  | { mode: "anthropic-api-key"; apiKey: string; baseUrl?: string | null };

export type ProviderModelConfig = {
  id: string;
  costInputUsdPerMTok?: number;
  costOutputUsdPerMTok?: number;
};

export type ProviderConfig = {
  id: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  auth: ProviderAuthConfig;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  models: ProviderModelConfig[];
  protocols?: Protocol[];
};

export type ProviderCapabilities = {
  protocols: Protocol[];
};

// Forward-declared to avoid a circular import with downstream.ts
export type DownstreamResponseLike = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: unknown };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type DownstreamResponsesResponseLike = {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  output: unknown[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
};

export type DownstreamRequestContextLike = {
  incomingAuthorizationHeader?: string;
  agentweaveHeaders?: Record<string, string>;
};

export type Provider = {
  id: string;
  kind: ProviderKind;
  models: ProviderModelConfig[];
  capabilities: ProviderCapabilities;
  call(
    req: ChatCompletionsRequest,
    route: RouteDecision,
    ctx?: DownstreamRequestContextLike,
  ): Promise<DownstreamResponseLike>;
  stream(
    req: ChatCompletionsRequest,
    route: RouteDecision,
    res: express.Response,
    ctx?: DownstreamRequestContextLike,
  ): Promise<void>;
  callResponses?(
    req: ResponsesRequest,
    route: RouteDecision,
    ctx?: DownstreamRequestContextLike,
  ): Promise<DownstreamResponsesResponseLike>;
  streamResponses?(
    req: ResponsesRequest,
    route: RouteDecision,
    res: express.Response,
    ctx?: DownstreamRequestContextLike,
  ): Promise<void>;
};
