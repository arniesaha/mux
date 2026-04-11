import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import {
  __resetAnthropicClientForTests,
  callDownstream,
  DownstreamNotConfiguredError,
  downstreamLogger,
  toAnthropicInput,
  toOpenAIResponse,
} from "../src/downstream.js";
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
  __resetAnthropicClientForTests();
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

  it("forwards req.max_tokens to Anthropic when set", async () => {
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
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await callDownstream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8192,
      },
      { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.max_tokens).toBe(8192);

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });

  it("defaults Anthropic max_tokens to 4096 when request omits it", async () => {
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
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await callDownstream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
      { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.max_tokens).toBe(4096);

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });

  it("logs mux.anthropic_request and mux.anthropic_response on success", async () => {
    const previousMode = config.downstreamMode;
    const previousOauthToken = config.anthropicOauthToken;
    const previousApiKey = config.anthropicApiKey;
    const previousAnthropicBaseUrl = config.anthropicBaseUrl;

    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";
    config.anthropicApiKey = undefined;
    config.anthropicBaseUrl = "http://127.0.0.1:30400";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const infoSpy = vi.spyOn(downstreamLogger, "info");

    await callDownstream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
      { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const events = infoSpy.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain("mux.anthropic_request");
    expect(events).toContain("mux.anthropic_response");

    const reqEvent = infoSpy.mock.calls.find(
      (c) => (c[0] as { event: string }).event === "mux.anthropic_request",
    )?.[0] as Record<string, unknown>;
    expect(reqEvent.messageCount).toBe(1);
    expect(reqEvent.maxTokens).toBe(4096);

    const respEvent = infoSpy.mock.calls.find(
      (c) => (c[0] as { event: string }).event === "mux.anthropic_response",
    )?.[0] as Record<string, unknown>;
    expect(respEvent.stopReason).toBe("end_turn");
    expect(respEvent.textBlockCount).toBe(1);
    expect(respEvent.joinedTextLength).toBe(5);

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });

  it("warns with empty:true when Anthropic returns no text blocks", async () => {
    const previousMode = config.downstreamMode;
    const previousOauthToken = config.anthropicOauthToken;
    const previousApiKey = config.anthropicApiKey;
    const previousAnthropicBaseUrl = config.anthropicBaseUrl;

    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";
    config.anthropicApiKey = undefined;
    config.anthropicBaseUrl = "http://127.0.0.1:30400";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_empty",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: "max_tokens",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1024 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const warnSpy = vi.spyOn(downstreamLogger, "warn");

    const response = await callDownstream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      },
      { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const warnEvents = warnSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const emptyEvent = warnEvents.find((e) => e.event === "mux.anthropic_response");
    expect(emptyEvent).toBeDefined();
    expect(emptyEvent?.empty).toBe(true);
    expect(emptyEvent?.stopReason).toBe("max_tokens");

    // Surface synthetic marker to the client instead of plain empty string.
    expect(response.choices[0]?.message.content).toContain("[empty response");
    expect(response.choices[0]?.message.content).toContain("max_tokens");

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });

  it("logs mux.anthropic_api_error on Anthropic 4xx", async () => {
    const previousMode = config.downstreamMode;
    const previousOauthToken = config.anthropicOauthToken;
    const previousApiKey = config.anthropicApiKey;
    const previousAnthropicBaseUrl = config.anthropicBaseUrl;

    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";
    config.anthropicApiKey = undefined;
    config.anthropicBaseUrl = "http://127.0.0.1:30400";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "bad image" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    const errorSpy = vi.spyOn(downstreamLogger, "error");

    await expect(
      callDownstream(
        {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
        },
        { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
      ),
    ).rejects.toBeDefined();

    const events = errorSpy.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain("mux.anthropic_api_error");

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

describe("toAnthropicInput", () => {
  it("converts OpenAI image_url data URL into an Anthropic base64 image block", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,ABCDEF" },
            },
          ],
        } as unknown as ChatCompletionsRequest["messages"][number],
      ],
    });

    expect(messages).toHaveLength(1);
    const blocks = messages[0]!.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "ABCDEF" },
    });
  });

  it("converts OpenAI image_url https URL into an Anthropic url image block", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/pic.png" },
            },
          ],
        } as unknown as ChatCompletionsRequest["messages"][number],
      ],
    });

    expect(messages[0]!.content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/pic.png" },
      },
    ]);
  });

  it("passes through Anthropic-native image blocks unchanged", () => {
    const nativeBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "XYZ" },
    };
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [nativeBlock],
        } as unknown as ChatCompletionsRequest["messages"][number],
      ],
    });

    expect(messages[0]!.content).toEqual([nativeBlock]);
  });

  it("preserves a plain text message as a text block", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("keeps an image-only user message (no text) in the output", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,ZZZ" },
            },
          ],
        } as unknown as ChatCompletionsRequest["messages"][number],
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content[0]!.type).toBe("image");
  });
});

describe("toOpenAIResponse", () => {
  it("returns joined text from text blocks", () => {
    const response = toOpenAIResponse(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      } as unknown as Parameters<typeof toOpenAIResponse>[0],
      "claude-sonnet-4-6",
    );

    expect(response.choices[0]!.message.content).toBe("hello\nworld");
  });

  it("surfaces a synthetic empty-response marker when no text blocks survive", () => {
    const response = toOpenAIResponse(
      {
        id: "msg_empty",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1024 },
      } as unknown as Parameters<typeof toOpenAIResponse>[0],
      "claude-sonnet-4-6",
    );

    expect(response.choices[0]!.message.content).toContain("[empty response");
    expect(response.choices[0]!.message.content).toContain("max_tokens");
  });
});
