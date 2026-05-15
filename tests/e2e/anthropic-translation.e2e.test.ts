import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { __resetAnthropicClientForTests } from "../../src/downstream.js";
import { __resetProviderRegistryForTests } from "../../src/providers/registry.js";

const anthropicJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("e2e: OpenAI-shape input → Anthropic translation (anthropic-sdk)", () => {
  const previous = {
    mode: config.downstreamMode,
    oauth: config.anthropicOauthToken,
    apiKey: config.anthropicApiKey,
    baseUrl: config.anthropicBaseUrl,
    providers: config.providers,
    fallback: config.downstreamMockFallbackEnabled,
    cache: config.anthropicPromptCacheEnabled,
  };

  beforeEach(() => {
    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";
    config.anthropicApiKey = undefined;
    config.anthropicBaseUrl = "http://anthropic.test";
    config.downstreamMockFallbackEnabled = false;
    config.anthropicPromptCacheEnabled = true;
    config.providers = [];
    __resetProviderRegistryForTests();
    __resetAnthropicClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.downstreamMode = previous.mode;
    config.anthropicOauthToken = previous.oauth;
    config.anthropicApiKey = previous.apiKey;
    config.anthropicBaseUrl = previous.baseUrl;
    config.providers = previous.providers;
    config.downstreamMockFallbackEnabled = previous.fallback;
    config.anthropicPromptCacheEnabled = previous.cache;
    __resetProviderRegistryForTests();
    __resetAnthropicClientForTests();
  });

  it("translates an OpenAI request to Anthropic shape, injects ephemeral cache_control, and returns chat.completion", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      anthropicJson({
        id: "msg_e2e_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello from claude" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "first turn" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "second turn" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.choices?.[0]?.message?.content).toBe("hello from claude");
    expect(res.body.choices?.[0]?.finish_reason).toBe("stop");

    expect(fetchSpy).toHaveBeenCalled();
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]!;
    const init = lastCall[1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    // Anthropic shape: top-level system + messages array of role/content blocks.
    expect(sent.model).toBe("claude-sonnet-4-6");
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.messages[0].role).toBe("user");
    // System prompt is hoisted to top-level. Under the Anthropic OAuth path the
    // first system block is the Claude Code identity prefix (no cache_control);
    // the user's "be terse" system block lives after it and carries the marker.
    expect(Array.isArray(sent.system)).toBe(true);
    const cachedSystem = (sent.system as Array<{ cache_control?: unknown }>).find(
      (b) => b.cache_control,
    );
    expect(cachedSystem?.cache_control).toEqual({ type: "ephemeral" });
    // The last block of the last message also carries ephemeral cache_control
    // when there are >=2 messages (multi-turn prefix caching).
    const lastMsg = sent.messages[sent.messages.length - 1];
    const lastBlock = Array.isArray(lastMsg.content)
      ? lastMsg.content[lastMsg.content.length - 1]
      : null;
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral" });
  });
});
