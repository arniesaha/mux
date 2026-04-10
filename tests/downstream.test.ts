import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { callDownstream, DownstreamNotConfiguredError } from "../src/downstream.js";
import type { ChatCompletionsRequest, RouteDecision } from "../src/types.js";

const requestPayload: ChatCompletionsRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "say hi" }],
};

const route: RouteDecision = {
  requestedModel: "gpt-4o",
  resolvedModel: "gpt-4o-mini",
  routeReason: "heuristic:test",
  provider: "openai-compatible",
  backendTarget: "http://localhost:4000/v1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callDownstream", () => {
  it("calls LiteLLM-compatible endpoint when configured", async () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousApiKey = config.downstreamApiKey;
    const previousAuthMode = config.downstreamAuthMode;
    const previousExtraHeaders = config.downstreamExtraHeaders;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamApiKey = "test-key";
    config.downstreamAuthMode = "bearer";
    config.downstreamExtraHeaders = { "x-mux-test": "1" };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await callDownstream(requestPayload, route);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4000/v1/chat/completions");

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    const headers = requestInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["x-mux-test"]).toBe("1");

    expect(response.model).toBe("gpt-4o-mini");

    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamApiKey = previousApiKey;
    config.downstreamAuthMode = previousAuthMode;
    config.downstreamExtraHeaders = previousExtraHeaders;
  });

  it("supports x-api-key auth mode for downstream", async () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousApiKey = config.downstreamApiKey;
    const previousAuthMode = config.downstreamAuthMode;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamApiKey = "abc123";
    config.downstreamAuthMode = "x-api-key";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await callDownstream(requestPayload, route);

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("abc123");
    expect(headers.authorization).toBeUndefined();

    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamApiKey = previousApiKey;
    config.downstreamAuthMode = previousAuthMode;
  });

  it("supports passthrough auth mode", async () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousAuthMode = config.downstreamAuthMode;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamAuthMode = "passthrough";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await callDownstream(requestPayload, route, {
      incomingAuthorizationHeader: "Bearer passthrough-token",
    });

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer passthrough-token");

    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamAuthMode = previousAuthMode;
  });

  it("uses Anthropic SDK adapter when enabled", async () => {
    const previousMode = config.downstreamMode;
    const previousOauthToken = config.anthropicOauthToken;
    const previousApiKey = config.anthropicApiKey;
    const previousAnthropicBaseUrl = config.anthropicBaseUrl;

    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";
    config.anthropicApiKey = undefined;
    config.anthropicBaseUrl = "http://127.0.0.1:30400";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hello from claude" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await callDownstream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "say hi" }],
      },
      {
        ...route,
        requestedModel: "claude-sonnet-4-6",
        resolvedModel: "claude-sonnet-4-6",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstArg = String(fetchSpy.mock.calls[0]?.[0]);
    expect(firstArg).toContain("/v1/messages");
    expect(response.model).toBe("claude-sonnet-4-6");
    expect(response.choices[0]?.message.content).toBe("hello from claude");

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });

  it("throws when not configured and fallback disabled", async () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousFallback = config.downstreamMockFallbackEnabled;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = null;
    config.downstreamMockFallbackEnabled = false;

    await expect(callDownstream(requestPayload, route)).rejects.toBeInstanceOf(
      DownstreamNotConfiguredError,
    );

    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamMockFallbackEnabled = previousFallback;
  });
});
