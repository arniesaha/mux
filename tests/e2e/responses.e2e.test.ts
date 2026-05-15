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

describe("e2e: POST /v1/responses (openai-compatible passthrough)", () => {
  const previous = {
    providers: config.providers,
    mode: config.downstreamMode,
    fallback: config.downstreamMockFallbackEnabled,
  };

  beforeEach(() => {
    config.downstreamMode = "openai-compatible";
    config.downstreamMockFallbackEnabled = false;
    config.providers = [
      {
        id: "default",
        kind: "openai-compatible",
        baseUrl: "http://upstream.test/v1",
        protocols: ["chat_completions", "responses"],
        auth: { mode: "bearer", apiKey: "test-key" },
        models: [{ id: "gpt-5" }],
      },
    ];
    __resetProviderRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.providers = previous.providers;
    config.downstreamMode = previous.mode;
    config.downstreamMockFallbackEnabled = previous.fallback;
    __resetProviderRegistryForTests();
  });

  it("forwards a non-streaming Responses request to /responses and returns the upstream body verbatim", async () => {
    const upstreamBody = {
      id: "resp_e2e_1",
      object: "response",
      created_at: 1700000000,
      model: "gpt-5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from responses" }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson(upstreamBody));

    const app = createApp();
    const res = await request(app)
      .post("/v1/responses")
      .send({
        model: "gpt-5",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hi" }] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(res.body.id).toBe("resp_e2e_1");
    expect(res.body.output?.[0]?.content?.[0]?.text).toBe("hello from responses");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://upstream.test/v1/responses");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-5");
    expect(Array.isArray(body.input)).toBe(true);
  });
});
