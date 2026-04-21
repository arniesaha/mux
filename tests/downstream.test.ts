import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import {
  __resetAnthropicClientForTests,
  callDownstream,
  DownstreamNotConfiguredError,
  DownstreamRequestError,
  anthropicStopReasonToOpenAI,
  downstreamLogger,
  streamAnthropicToOpenAI,
  streamDownstream,
  toAnthropicInput,
  toOpenAIResponse,
  translateToolChoiceToAnthropic,
  translateToolsToAnthropic,
} from "../src/downstream.js";
import type { ChatCompletionsRequest, OpenAIToolDef, RouteDecision } from "../src/types.js";

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

  // --- instrumentation (issue #37) --------------------------------------------

  it("fires mux.downstream_request and mux.downstream_response for non-streaming calls", async () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousApiKey = config.downstreamApiKey;
    const previousAuthMode = config.downstreamAuthMode;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamApiKey = "test-key";
    config.downstreamAuthMode = "bearer";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const infoSpy = vi.spyOn(downstreamLogger, "info");

    await callDownstream(requestPayload, route);

    const calls = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);

    const reqEvent = calls.find((c) => c.event === "mux.downstream_request");
    expect(reqEvent).toBeDefined();
    expect(reqEvent?.resolvedModel).toBe("gpt-4o-mini");
    expect(reqEvent?.requestedModel).toBe("gpt-4o");
    expect(reqEvent?.url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    expect(reqEvent?.authMode).toBe("bearer");
    expect(reqEvent?.streamed).toBe(false);

    const respEvent = calls.find((c) => c.event === "mux.downstream_response");
    expect(respEvent).toBeDefined();
    expect(respEvent?.status).toBe(200);
    expect(respEvent?.model).toBe("gpt-4o-mini");
    expect(respEvent?.inputTokens).toBe(7);
    expect(respEvent?.outputTokens).toBe(3);
    expect(respEvent?.totalTokens).toBe(10);
    expect(respEvent?.stopReason).toBe("stop");
    expect(respEvent?.streamed).toBe(false);
    expect(typeof respEvent?.latencyMs).toBe("number");

    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamApiKey = previousApiKey;
    config.downstreamAuthMode = previousAuthMode;
  });

  it("fires mux.downstream_error on non-2xx response", async () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousApiKey = config.downstreamApiKey;
    const previousAuthMode = config.downstreamAuthMode;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamApiKey = "test-key";
    config.downstreamAuthMode = "bearer";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const errorSpy = vi.spyOn(downstreamLogger, "error");

    await expect(callDownstream(requestPayload, route)).rejects.toBeInstanceOf(
      DownstreamRequestError,
    );

    const calls = errorSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const errEvent = calls.find((c) => c.event === "mux.downstream_error");
    expect(errEvent).toBeDefined();
    expect(errEvent?.status).toBe(401);
    expect(errEvent?.resolvedModel).toBe("gpt-4o-mini");

    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamApiKey = previousApiKey;
    config.downstreamAuthMode = previousAuthMode;
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

  it("translates Anthropic stop_reason into OpenAI finish_reason", () => {
    const build = (stopReason: string) =>
      toOpenAIResponse(
        {
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Parameters<typeof toOpenAIResponse>[0],
        "claude-sonnet-4-6",
      );

    expect(build("end_turn").choices[0]!.finish_reason).toBe("stop");
    expect(build("stop_sequence").choices[0]!.finish_reason).toBe("stop");
    expect(build("max_tokens").choices[0]!.finish_reason).toBe("length");
    expect(build("tool_use").choices[0]!.finish_reason).toBe("tool_calls");
  });
});

describe("anthropicStopReasonToOpenAI", () => {
  it("maps Anthropic stop_reason values to the OpenAI vocabulary", () => {
    expect(anthropicStopReasonToOpenAI("end_turn")).toBe("stop");
    expect(anthropicStopReasonToOpenAI("stop_sequence")).toBe("stop");
    expect(anthropicStopReasonToOpenAI("refusal")).toBe("stop");
    expect(anthropicStopReasonToOpenAI("pause_turn")).toBe("stop");
    expect(anthropicStopReasonToOpenAI("max_tokens")).toBe("length");
    expect(anthropicStopReasonToOpenAI("model_context_window_exceeded")).toBe("length");
    expect(anthropicStopReasonToOpenAI("tool_use")).toBe("tool_calls");
    expect(anthropicStopReasonToOpenAI(null)).toBe("stop");
    expect(anthropicStopReasonToOpenAI(undefined)).toBe("stop");
    // Unknown values fall back to "stop" instead of throwing, so an
    // unrecognized Anthropic value never poisons downstream agents.
    expect(anthropicStopReasonToOpenAI("totally_made_up" as any)).toBe("stop");
  });
});

describe("translateToolsToAnthropic", () => {
  it("converts OpenAI function tool definitions into Anthropic tool shape", () => {
    const tools: OpenAIToolDef[] = [
      {
        type: "function",
        function: {
          name: "gpu_status",
          description: "Report GPU state",
          parameters: {
            type: "object",
            properties: { verbose: { type: "boolean" } },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    const result = translateToolsToAnthropic(tools);
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      name: "gpu_status",
      description: "Report GPU state",
      input_schema: {
        type: "object",
        properties: { verbose: { type: "boolean" } },
        required: [],
      },
    });
    expect(result![1]).toEqual({
      name: "read_file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    });
  });

  it("returns undefined for empty or missing tools", () => {
    expect(translateToolsToAnthropic(undefined)).toBeUndefined();
    expect(translateToolsToAnthropic([])).toBeUndefined();
  });

  it("supplies a default input_schema when parameters are missing", () => {
    const result = translateToolsToAnthropic([
      { type: "function", function: { name: "noop" } },
    ]);
    expect(result![0]!.input_schema).toEqual({ type: "object", properties: {} });
  });
});

describe("translateToolChoiceToAnthropic", () => {
  it("maps each OpenAI tool_choice variant to the Anthropic shape", () => {
    expect(translateToolChoiceToAnthropic("auto")).toEqual({ type: "auto" });
    expect(translateToolChoiceToAnthropic("none")).toEqual({ type: "none" });
    expect(translateToolChoiceToAnthropic("required")).toEqual({ type: "any" });
    expect(
      translateToolChoiceToAnthropic({ type: "function", function: { name: "read_file" } }),
    ).toEqual({ type: "tool", name: "read_file" });
    expect(translateToolChoiceToAnthropic(undefined)).toBeUndefined();
  });
});

describe("toAnthropicInput — tool round-trip", () => {
  it("converts an assistant message with OpenAI tool_calls into Anthropic tool_use blocks", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "check gpu" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "gpu_status", arguments: '{"verbose":true}' },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(2);
    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(assistant.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "gpu_status",
      input: { verbose: true },
    });
  });

  it("handles unparseable tool_call arguments by wrapping them in {_raw}", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_bad",
              type: "function",
              function: { name: "noop", arguments: "not-json" },
            },
          ],
        },
      ],
    });
    const toolUse = messages[0]!.content[0] as { type: "tool_use"; input: unknown };
    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.input).toEqual({ _raw: "not-json" });
  });

  it("converts a role:'tool' message into an Anthropic tool_result block", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "GPU is idle",
        },
      ],
    });

    expect(messages).toHaveLength(1);
    const userMsg = messages[0]!;
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "GPU is idle",
      },
    ]);
  });

  it("falls back to plain user text when a tool message has no tool_call_id", () => {
    const { messages } = toAnthropicInput({
      model: "claude-sonnet-4-6",
      messages: [{ role: "tool", content: "orphaned tool output" }],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toEqual([{ type: "text", text: "orphaned tool output" }]);
  });
});

describe("toOpenAIResponse — tool_calls surfacing", () => {
  const baseUsage = { input_tokens: 1, output_tokens: 1 };

  it("exposes Anthropic tool_use blocks as OpenAI tool_calls on the message", () => {
    const response = toOpenAIResponse(
      {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "Checking now." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "gpu_status",
            input: { verbose: true },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: baseUsage,
      } as unknown as Parameters<typeof toOpenAIResponse>[0],
      "claude-sonnet-4-6",
    );

    const msg = response.choices[0]!.message;
    expect(msg.content).toBe("Checking now.");
    expect(msg.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "gpu_status", arguments: '{"verbose":true}' },
      },
    ]);
    expect(response.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("sets content to null when the only output is a tool_use block", () => {
    const response = toOpenAIResponse(
      {
        id: "msg_tool_only",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "/etc/hosts" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: baseUsage,
      } as unknown as Parameters<typeof toOpenAIResponse>[0],
      "claude-sonnet-4-6",
    );

    const msg = response.choices[0]!.message;
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]!.function.arguments).toBe('{"path":"/etc/hosts"}');
    // Must NOT fall through to the synthetic empty-response marker — content
    // is null (canonical OpenAI shape), not a placeholder string.
    expect(typeof msg.content === "string" && /empty response/.test(msg.content)).toBe(false);
  });
});

describe("callDownstream — tools forwarding to Anthropic SDK", () => {
  it("forwards req.tools and req.tool_choice to the Anthropic API", async () => {
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
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "toolu_x", name: "gpu_status", input: {} },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await callDownstream(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "check the gpu" }],
        tools: [
          {
            type: "function",
            function: {
              name: "gpu_status",
              description: "Report GPU state",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
      },
      { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.tools).toEqual([
      {
        name: "gpu_status",
        description: "Report GPU state",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });

    // Response round-trips the tool_use block as OpenAI tool_calls.
    const msg = response.choices[0]!.message;
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]!.function.name).toBe("gpu_status");
    expect(response.choices[0]!.finish_reason).toBe("tool_calls");

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });

  it("omits tools from the Anthropic request body when req.tools is absent", async () => {
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
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hi" }],
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
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();

    config.downstreamMode = previousMode;
    config.anthropicOauthToken = previousOauthToken;
    config.anthropicApiKey = previousApiKey;
    config.anthropicBaseUrl = previousAnthropicBaseUrl;
  });
});

// --- streaming helper + integration -----------------------------------------

type StubResponse = {
  writes: string[];
  statusCode: number | null;
  headers: Record<string, string>;
  ended: boolean;
  status: (code: number) => StubResponse;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
  headersSent: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
  once: (event: string, cb: () => void) => void;
  off: (event: string, cb: () => void) => void;
  emit: (event: string) => void;
  _listeners: Record<string, Array<() => void>>;
};

const makeStubRes = (): StubResponse => {
  const res: StubResponse = {
    writes: [],
    statusCode: null,
    headers: {},
    ended: false,
    headersSent: false,
    _listeners: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    getHeader(k: string) {
      return res.headers[k];
    },
    write(chunk: string) {
      res.headersSent = true;
      res.writes.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
    },
    once(event: string, cb: () => void) {
      (res._listeners[event] ||= []).push(cb);
    },
    off(event: string, cb: () => void) {
      const list = res._listeners[event];
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event: string) {
      for (const cb of res._listeners[event] ?? []) cb();
    },
  };
  return res;
};

const parseSseFrames = (writes: string[]): Array<Record<string, unknown> | "[DONE]"> => {
  const frames: Array<Record<string, unknown> | "[DONE]"> = [];
  const joined = writes.join("");
  for (const raw of joined.split("\n\n")) {
    const line = raw.trim();
    if (!line.startsWith("data: ")) continue;
    const body = line.slice(6);
    if (body === "[DONE]") {
      frames.push("[DONE]");
      continue;
    }
    frames.push(JSON.parse(body));
  }
  return frames;
};

const eventsAsAsyncIterable = <T>(events: T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    let i = 0;
    return {
      async next() {
        if (i >= events.length) return { value: undefined as unknown as T, done: true };
        return { value: events[i++]!, done: false };
      },
    };
  },
});

describe("streamAnthropicToOpenAI", () => {
  it("emits role chunk, text deltas, final finish_reason, and [DONE]", async () => {
    const res = makeStubRes();
    const events = [
      { type: "message_start", message: { id: "msg_1" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    ];

    await streamAnthropicToOpenAI(
      eventsAsAsyncIterable(events as any),
      res as unknown as import("express").Response,
      "claude-sonnet-4-6",
      { requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const frames = parseSseFrames(res.writes);
    expect(frames[frames.length - 1]).toBe("[DONE]");
    const chunks = frames.filter((f): f is Record<string, unknown> => f !== "[DONE]");
    // 1: role, 2: "hel", 3: "lo", 4: final finish_reason
    expect(chunks).toHaveLength(4);

    const firstDelta = (chunks[0] as any).choices[0].delta;
    expect(firstDelta).toEqual({ role: "assistant" });
    expect((chunks[0] as any).choices[0].finish_reason).toBeNull();

    expect((chunks[1] as any).choices[0].delta).toEqual({ content: "hel" });
    expect((chunks[2] as any).choices[0].delta).toEqual({ content: "lo" });

    const last = chunks[3] as any;
    expect(last.choices[0].delta).toEqual({});
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(res.ended).toBe(true);
  });

  it("streams tool_use start + input_json_delta fragments with the same index", async () => {
    const res = makeStubRes();
    const events = [
      { type: "message_start", message: { id: "msg_1" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"/e' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'tc/hosts"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
      { type: "message_stop" },
    ];

    await streamAnthropicToOpenAI(
      eventsAsAsyncIterable(events as any),
      res as unknown as import("express").Response,
      "claude-sonnet-4-6",
      { requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const chunks = parseSseFrames(res.writes).filter(
      (f): f is Record<string, unknown> => f !== "[DONE]",
    );
    // Role chunk + tool_use start + 2 argument fragments + final.
    expect(chunks).toHaveLength(5);

    const toolStart = (chunks[1] as any).choices[0].delta.tool_calls;
    expect(toolStart).toEqual([
      {
        index: 0,
        id: "toolu_1",
        type: "function",
        function: { name: "read_file", arguments: "" },
      },
    ]);

    // Subsequent deltas carry PARTIAL fragments at the same tool_calls index.
    // The client concatenates; we must not do it ourselves.
    const frag1 = (chunks[2] as any).choices[0].delta.tool_calls;
    expect(frag1).toEqual([{ index: 0, function: { arguments: '{"path":"/e' } }]);
    const frag2 = (chunks[3] as any).choices[0].delta.tool_calls;
    expect(frag2).toEqual([{ index: 0, function: { arguments: 'tc/hosts"}' } }]);

    // Final chunk uses tool_use → tool_calls mapping.
    expect((chunks[4] as any).choices[0].finish_reason).toBe("tool_calls");
  });

  it("writes a terminal [stream error:] chunk when the event source throws", async () => {
    const res = makeStubRes();
    const events: AsyncIterable<any> = {
      [Symbol.asyncIterator]() {
        let sent = 0;
        return {
          async next() {
            if (sent === 0) {
              sent++;
              return { value: { type: "message_start", message: { id: "x" } }, done: false };
            }
            throw new Error("transport died");
          },
        };
      },
    };

    await streamAnthropicToOpenAI(
      events,
      res as unknown as import("express").Response,
      "claude-sonnet-4-6",
      { requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const joined = res.writes.join("");
    expect(joined).toContain("[stream error: transport died]");
    expect(joined.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(res.ended).toBe(true);
  });

  it("logs real input/output token counts from message_start and message_delta", async () => {
    const res = makeStubRes();
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 17 },
      },
      { type: "message_stop" },
    ];

    const infoSpy = vi.spyOn(downstreamLogger, "info");

    await streamAnthropicToOpenAI(
      eventsAsAsyncIterable(events as any),
      res as unknown as import("express").Response,
      "claude-sonnet-4-6",
      { requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const calls = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const respEvent = calls.find((c) => c.event === "mux.anthropic_response");
    expect(respEvent).toBeDefined();
    expect(respEvent?.inputTokens).toBe(42);
    expect(respEvent?.outputTokens).toBe(17);
  });

  it("uses the final cumulative output_tokens when message_delta fires multiple times", async () => {
    const res = makeStubRes();
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
      { type: "content_block_stop", index: 0 },
      // Anthropic emits output_tokens cumulatively — successive message_delta
      // events should overwrite, not sum. Final value should win.
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 3 } },
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 7 } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 25 },
      },
      { type: "message_stop" },
    ];

    const infoSpy = vi.spyOn(downstreamLogger, "info");

    await streamAnthropicToOpenAI(
      eventsAsAsyncIterable(events as any),
      res as unknown as import("express").Response,
      "claude-sonnet-4-6",
      { requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
    );

    const calls = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const respEvent = calls.find((c) => c.event === "mux.anthropic_response");
    expect(respEvent).toBeDefined();
    expect(respEvent?.inputTokens).toBe(10);
    // Must be the last seen value (25), NOT a sum (3 + 7 + 25 = 35).
    expect(respEvent?.outputTokens).toBe(25);
  });
});

describe("streamDownstream", () => {
  const setupAnthropic = () => {
    const previousMode = config.downstreamMode;
    const previousOauthToken = config.anthropicOauthToken;
    const previousApiKey = config.anthropicApiKey;
    const previousAnthropicBaseUrl = config.anthropicBaseUrl;

    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";
    config.anthropicApiKey = undefined;
    config.anthropicBaseUrl = "http://127.0.0.1:30400";

    return () => {
      config.downstreamMode = previousMode;
      config.anthropicOauthToken = previousOauthToken;
      config.anthropicApiKey = previousApiKey;
      config.anthropicBaseUrl = previousAnthropicBaseUrl;
    };
  };

  const sseResponse = (frames: string[]): Response => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const anthropicSseFrame = (eventName: string, data: unknown): string =>
    `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;

  it("produces OpenAI chunks and a terminal [DONE] for a text stream", async () => {
    const restore = setupAnthropic();
    try {
      const frames = [
        anthropicSseFrame("message_start", {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
        anthropicSseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        anthropicSseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        }),
        anthropicSseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " there" },
        }),
        anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSseFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
        anthropicSseFrame("message_stop", { type: "message_stop" }),
      ];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(frames));

      const res = makeStubRes();
      await streamDownstream(
        {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
        res as unknown as import("express").Response,
      );

      expect(res.headers["Content-Type"]).toContain("text/event-stream");
      const parsed = parseSseFrames(res.writes);
      expect(parsed[parsed.length - 1]).toBe("[DONE]");
      const chunks = parsed.filter((f): f is Record<string, unknown> => f !== "[DONE]");
      const content = chunks
        .map((c: any) => c.choices?.[0]?.delta?.content)
        .filter(Boolean)
        .join("");
      expect(content).toBe("hi there");
      const final = chunks[chunks.length - 1] as any;
      // Anthropic end_turn → OpenAI stop (via anthropicStopReasonToOpenAI).
      expect(final.choices[0].finish_reason).toBe("stop");
    } finally {
      restore();
    }
  });

  it("rejects with DownstreamRequestError when the stream start fails", async () => {
    const restore = setupAnthropic();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "bad prompt" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const res = makeStubRes();
      await expect(
        streamDownstream(
          {
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          },
          { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
          res as unknown as import("express").Response,
        ),
      ).rejects.toBeInstanceOf(DownstreamRequestError);

      // No bytes may be written when the start fails — app.ts's 502 branch
      // takes over and sends a JSON error.
      expect(res.writes).toHaveLength(0);
      expect(res.ended).toBe(false);
    } finally {
      restore();
    }
  });

  it("fires mux.anthropic_request with streamed:true and mux.anthropic_response on success", async () => {
    const restore = setupAnthropic();
    try {
      const frames = [
        anthropicSseFrame("message_start", {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
        anthropicSseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        anthropicSseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        }),
        anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSseFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        anthropicSseFrame("message_stop", { type: "message_stop" }),
      ];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(frames));

      const infoSpy = vi.spyOn(downstreamLogger, "info");

      const res = makeStubRes();
      await streamDownstream(
        {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        { ...route, requestedModel: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
        res as unknown as import("express").Response,
      );

      const calls = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const reqEvent = calls.find((c) => c.event === "mux.anthropic_request");
      expect(reqEvent).toBeDefined();
      expect(reqEvent?.streamed).toBe(true);

      const respEvent = calls.find((c) => c.event === "mux.anthropic_response");
      expect(respEvent).toBeDefined();
      expect(respEvent?.streamed).toBe(true);
      expect(respEvent?.stopReason).toBe("end_turn");
      expect(respEvent?.joinedTextLength).toBe(2);
    } finally {
      restore();
    }
  });

  // --- openai-compatible streaming (issue #36) --------------------------------

  const setupOpenAICompat = () => {
    const previousMode = config.downstreamMode;
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousApiKey = config.downstreamApiKey;
    const previousAuthMode = config.downstreamAuthMode;

    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamApiKey = "test-key";
    config.downstreamAuthMode = "bearer";

    return () => {
      config.downstreamMode = previousMode;
      config.downstreamBaseUrl = previousBaseUrl;
      config.downstreamApiKey = previousApiKey;
      config.downstreamAuthMode = previousAuthMode;
    };
  };

  const openaiSseFrames = [
    `data: ${JSON.stringify({
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];

  it("pipes OpenAI SSE through when downstreamMode=openai-compatible", async () => {
    const restore = setupOpenAICompat();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(openaiSseFrames));

      const res = makeStubRes();
      await streamDownstream(
        {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        route,
        res as unknown as import("express").Response,
      );

      expect(res.headers["Content-Type"]).toContain("text/event-stream");
      const parsed = parseSseFrames(res.writes);
      expect(parsed[parsed.length - 1]).toBe("[DONE]");
      const chunks = parsed.filter((f): f is Record<string, unknown> => f !== "[DONE]");
      const content = chunks
        .map((c: any) => c.choices?.[0]?.delta?.content)
        .filter(Boolean)
        .join("");
      expect(content).toBe("hi there");
    } finally {
      restore();
    }
  });

  it("forwards stream:true in the upstream request body for openai-compatible", async () => {
    const restore = setupOpenAICompat();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(sseResponse(openaiSseFrames));

      const res = makeStubRes();
      await streamDownstream(
        {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        route,
        res as unknown as import("express").Response,
      );

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.stream).toBe(true);
      expect(body.model).toBe(route.resolvedModel);
    } finally {
      restore();
    }
  });

  it("fires mux.downstream_request and mux.downstream_response for streaming openai-compatible", async () => {
    const restore = setupOpenAICompat();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(openaiSseFrames));
      const infoSpy = vi.spyOn(downstreamLogger, "info");

      const res = makeStubRes();
      await streamDownstream(
        {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        route,
        res as unknown as import("express").Response,
      );

      const calls = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);

      const reqEvent = calls.find((c) => c.event === "mux.downstream_request");
      expect(reqEvent).toBeDefined();
      expect(reqEvent?.resolvedModel).toBe("gpt-4o-mini");
      expect(reqEvent?.streamed).toBe(true);

      const respEvent = calls.find((c) => c.event === "mux.downstream_response");
      expect(respEvent).toBeDefined();
      expect(respEvent?.status).toBe(200);
      expect(respEvent?.streamed).toBe(true);
      expect(typeof respEvent?.latencyMs).toBe("number");
    } finally {
      restore();
    }
  });

  it("throws DownstreamRequestError on non-2xx before any bytes hit the wire (openai-compatible)", async () => {
    const restore = setupOpenAICompat();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );

      const res = makeStubRes();
      await expect(
        streamDownstream(
          {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          },
          route,
          res as unknown as import("express").Response,
        ),
      ).rejects.toBeInstanceOf(DownstreamRequestError);

      expect(res.writes).toHaveLength(0);
      expect(res.ended).toBe(false);
    } finally {
      restore();
    }
  });
});

// --- cross-provider failover (issue #45) ------------------------------------

describe("callDownstream — failover", () => {
  const failoverRoute: RouteDecision = {
    requestedModel: "gpt-4o",
    resolvedModel: "gpt-4o-mini",
    routeReason: "heuristic:test+cost_weighted",
    provider: "openai-compatible",
    backendTarget: "http://a/v1",
    providerId: "a",
    fallbackProviderIds: ["b"],
  };

  const setupTwoProviders = () => {
    const previousProviders = config.providers;
    const previousAttempts = config.failoverMaxAttempts;
    config.providers = [
      {
        id: "a",
        kind: "openai-compatible",
        baseUrl: "http://a/v1",
        auth: { mode: "bearer", apiKey: "key-a" },
        models: [{ id: "gpt-4o-mini", costInputUsdPerMTok: 0.1, costOutputUsdPerMTok: 0.4 }],
      },
      {
        id: "b",
        kind: "openai-compatible",
        baseUrl: "http://b/v1",
        auth: { mode: "bearer", apiKey: "key-b" },
        models: [{ id: "gpt-4o-mini", costInputUsdPerMTok: 0.2, costOutputUsdPerMTok: 0.5 }],
      },
    ];
    config.failoverMaxAttempts = 1;
    __resetAnthropicClientForTests();
    return () => {
      config.providers = previousProviders;
      config.failoverMaxAttempts = previousAttempts;
      __resetAnthropicClientForTests();
    };
  };

  const okJsonResponse = (model: string, content: string): Response =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        created: 1,
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("retries on 5xx from primary and succeeds with fallback", async () => {
    const restore = setupTwoProviders();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith("http://a/")) {
            return new Response(JSON.stringify({ error: { message: "boom" } }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.startsWith("http://b/")) {
            return okJsonResponse("gpt-4o-mini", "from-b");
          }
          throw new Error(`unexpected url: ${url}`);
        });

      const result = await callDownstream(requestPayload, failoverRoute);
      expect(result.choices[0]?.message.content).toBe("from-b");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("does not retry on 4xx client error from primary", async () => {
    const restore = setupTwoProviders();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith("http://a/")) {
            return new Response(JSON.stringify({ error: { message: "bad request" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected url: ${url}`);
        });

      await expect(callDownstream(requestPayload, failoverRoute)).rejects.toBeInstanceOf(
        DownstreamRequestError,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("surfaces the last error when all providers fail", async () => {
    const restore = setupTwoProviders();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        const status = url.startsWith("http://a/") ? 503 : 504;
        return new Response(JSON.stringify({ error: { message: "down" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      });

      await expect(callDownstream(requestPayload, failoverRoute)).rejects.toSatisfy(
        (err) => err instanceof DownstreamRequestError && err.status === 504,
      );
    } finally {
      restore();
    }
  });

  it("disables failover when FAILOVER_MAX_ATTEMPTS=0", async () => {
    const restore = setupTwoProviders();
    try {
      config.failoverMaxAttempts = 0;
      __resetAnthropicClientForTests();

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        );

      await expect(callDownstream(requestPayload, failoverRoute)).rejects.toSatisfy(
        (err) => err instanceof DownstreamRequestError && err.status === 503,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("logs a mux.failover_hop event on hop", async () => {
    const restore = setupTwoProviders();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("http://a/")) {
          return new Response("x", { status: 503 });
        }
        return okJsonResponse("gpt-4o-mini", "hi");
      });
      const warnSpy = vi.spyOn(downstreamLogger, "warn");

      await callDownstream(requestPayload, failoverRoute);

      const hopLog = warnSpy.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((c) => c.event === "mux.failover_hop");
      expect(hopLog).toBeDefined();
      expect(hopLog?.from).toBe("a");
      expect(hopLog?.to).toBe("b");
      expect(hopLog?.attempt).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("streamDownstream — failover", () => {
  const streamRoute: RouteDecision = {
    requestedModel: "gpt-4o",
    resolvedModel: "gpt-4o-mini",
    routeReason: "heuristic:test+cost_weighted",
    provider: "openai-compatible",
    backendTarget: "http://a/v1",
    providerId: "a",
    fallbackProviderIds: ["b"],
  };

  const setupTwoProviders = () => {
    const previousProviders = config.providers;
    const previousAttempts = config.failoverMaxAttempts;
    config.providers = [
      {
        id: "a",
        kind: "openai-compatible",
        baseUrl: "http://a/v1",
        auth: { mode: "bearer", apiKey: "key-a" },
        models: [{ id: "gpt-4o-mini", costInputUsdPerMTok: 0.1, costOutputUsdPerMTok: 0.4 }],
      },
      {
        id: "b",
        kind: "openai-compatible",
        baseUrl: "http://b/v1",
        auth: { mode: "bearer", apiKey: "key-b" },
        models: [{ id: "gpt-4o-mini", costInputUsdPerMTok: 0.2, costOutputUsdPerMTok: 0.5 }],
      },
    ];
    config.failoverMaxAttempts = 1;
    __resetAnthropicClientForTests();
    return () => {
      config.providers = previousProviders;
      config.failoverMaxAttempts = previousAttempts;
      __resetAnthropicClientForTests();
    };
  };

  const makeStreamRes = () => {
    const res: any = {
      statusCode: 0,
      headersSent: false,
      headers: {} as Record<string, string>,
      writes: [] as string[],
      ended: false,
      _listeners: {} as Record<string, Array<() => void>>,
      status(code: number) { res.statusCode = code; return res; },
      setHeader(k: string, v: string) { res.headers[k] = v; },
      getHeader(k: string) { return res.headers[k]; },
      write(chunk: string) { res.headersSent = true; res.writes.push(chunk); return true; },
      end() { res.ended = true; },
      once(event: string, cb: () => void) { (res._listeners[event] ||= []).push(cb); },
      off(event: string, cb: () => void) {
        const list = res._listeners[event];
        if (!list) return;
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      },
      emit(event: string) { for (const cb of res._listeners[event] ?? []) cb(); },
    };
    return res;
  };

  const sseOk = (content: string): Response => {
    const encoder = new TextEncoder();
    const frames = [
      `data: ${JSON.stringify({
        id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  it("retries pre-stream on 503 and streams from fallback", async () => {
    const restore = setupTwoProviders();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("http://a/")) {
          return new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return sseOk("hi from b");
      });

      const res = makeStreamRes();
      await streamDownstream(
        { ...requestPayload, stream: true },
        streamRoute,
        res as unknown as import("express").Response,
      );

      const joined = res.writes.join("");
      expect(joined).toContain("hi from b");
      expect(joined).toContain("[DONE]");
    } finally {
      restore();
    }
  });

  it("does not failover on a mid-stream non-retryable error from the primary", async () => {
    const restore = setupTwoProviders();
    try {
      // Primary opens a 200 stream but the body errors mid-pull with a plain
      // Error (not a retryable class). Dispatcher must rethrow without calling
      // provider B, even if res.headersSent has not yet flipped — because the
      // error itself is non-retryable.
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith("http://a/")) {
            const stream = new ReadableStream({
              pull(controller) {
                controller.error(new Error("mid-stream boom"));
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          throw new Error("provider b must not be called");
        });

      const res = makeStreamRes();
      await expect(
        streamDownstream(
          { ...requestPayload, stream: true },
          streamRoute,
          res as unknown as import("express").Response,
        ),
      ).rejects.toThrow(/mid-stream boom/);

      // Provider A was called; provider B was NOT.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/^http:\/\/a\//);
    } finally {
      restore();
    }
  });
});
