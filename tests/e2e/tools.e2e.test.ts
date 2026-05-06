import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { __resetProviderRegistryForTests } from "../../src/providers/registry.js";

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("e2e: chat_completions tool calling round-trip (openai-compatible)", () => {
  const previous = {
    mode: config.downstreamMode,
    baseUrl: config.downstreamBaseUrl,
    apiKey: config.downstreamApiKey,
    authMode: config.downstreamAuthMode,
    fallback: config.downstreamMockFallbackEnabled,
    providers: config.providers,
  };

  beforeEach(() => {
    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://upstream.test/v1";
    config.downstreamApiKey = "test-key";
    config.downstreamAuthMode = "bearer";
    config.downstreamMockFallbackEnabled = false;
    config.providers = [];
    __resetProviderRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.downstreamMode = previous.mode;
    config.downstreamBaseUrl = previous.baseUrl;
    config.downstreamApiKey = previous.apiKey;
    config.downstreamAuthMode = previous.authMode;
    config.downstreamMockFallbackEnabled = previous.fallback;
    config.providers = previous.providers;
    __resetProviderRegistryForTests();
  });

  it("forwards tools to the upstream and surfaces tool_calls on the response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJson({
        id: "chatcmpl-tools-1",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "gpu_status", arguments: '{"verbose":true}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "check the gpu" }],
        tools: [
          {
            type: "function",
            function: {
              name: "gpu_status",
              description: "Report GPU state",
              parameters: { type: "object", properties: { verbose: { type: "boolean" } } },
            },
          },
        ],
        tool_choice: "auto",
      });

    expect(res.status).toBe(200);
    const msg = res.body.choices?.[0]?.message;
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe("gpu_status");
    expect(res.body.choices[0].finish_reason).toBe("tool_calls");

    // Upstream payload must carry the tools array verbatim (openai-compatible).
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sentBody = JSON.parse(String(init.body));
    expect(Array.isArray(sentBody.tools)).toBe(true);
    expect(sentBody.tools[0].function.name).toBe("gpu_status");
    expect(sentBody.tool_choice).toBe("auto");
  });
});
