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

describe("e2e: POST /v1/chat/completions (openai-compatible)", () => {
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

  it("returns a canonical OpenAI chat.completion shape end-to-end (non-stream)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJson({
        id: "chatcmpl-e2e-1",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from e2e" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "say hi" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.choices?.[0]?.message?.role).toBe("assistant");
    expect(res.body.choices?.[0]?.message?.content).toBe("hello from e2e");
    expect(res.body.choices?.[0]?.finish_reason).toBe("stop");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "http://upstream.test/v1/chat/completions",
    );
  });

  it("streams SSE with data: framed chunks and a terminal [DONE]", async () => {
    const frames = [
      `data: ${JSON.stringify({
        id: "chatcmpl-e2e-stream",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-e2e-stream",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-e2e-stream",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(frames));

    const app = createApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .buffer(true)
      .parse((response, cb) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => cb(null, text));
      })
      .send({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "say hi" }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const text = res.body as unknown as string;
    expect(typeof text).toBe("string");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines.length).toBeGreaterThan(0);
    expect(dataLines[dataLines.length - 1]).toBe("data: [DONE]");
    // First payload-bearing chunk must be a chat.completion.chunk delta.
    const firstPayload = dataLines.find((l) => l !== "data: [DONE]");
    expect(firstPayload).toBeDefined();
    const parsed = JSON.parse(firstPayload!.replace(/^data:\s*/, ""));
    expect(parsed.object).toBe("chat.completion.chunk");
  });
});
