import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { __resetProviderRegistryForTests } from "../src/providers/registry.js";

describe("createApp", () => {
  beforeAll(() => {
    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = null;
    config.downstreamMockFallbackEnabled = true;
    config.modelMap = {};
  });

  const app = createApp();

  it("returns health status", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      service: "mux",
    });
  });

  it("rejects invalid chat completions payloads", async () => {
    const res = await request(app).post("/v1/chat/completions").send({ messages: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });


  it("rejects invalid responses payloads", async () => {
    const res = await request(app).post("/v1/responses").send({ input: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("returns a stubbed responses payload when responses protocol is enabled", async () => {
    const previousProtocols = process.env.DOWNSTREAM_PROTOCOLS;
    process.env.DOWNSTREAM_PROTOCOLS = "chat_completions,responses";
    __resetProviderRegistryForTests();

    const res = await request(app)
      .post("/v1/responses")
      .set("x-runtime", "openclaw")
      .send({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hi" }] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(res.body.model).toBe("gpt-5.4");
    expect(JSON.stringify(res.body)).toContain("requested=gpt-5.4");

    process.env.DOWNSTREAM_PROTOCOLS = previousProtocols;
    __resetProviderRegistryForTests();
  });

  it("returns a stubbed chat completion and honors runtime header", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("x-runtime", "openclaw")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "say hi" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.model).toBe("gpt-4o-mini");
    expect(res.body.choices?.[0]?.message?.content).toContain("requested=gpt-4o");
    expect(res.body.choices?.[0]?.message?.content).toContain("resolved=gpt-4o-mini");
  });

  it("redacts prompt preview span attr by default in production", async () => {
    const previousNodeEnv = config.nodeEnv;
    const previousTracePreview = config.tracePromptPreviewEnabled;
    const previousRedactedValue = config.tracePromptPreviewRedactedValue;

    config.nodeEnv = "production";
    config.tracePromptPreviewEnabled = false;
    config.tracePromptPreviewRedactedValue = "[redacted]";

    const tracing = await import("../src/tracing.js");
    const spanSpy = vi.spyOn(tracing, "setSpanAttrs");

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "super secret prompt" }],
      });

    expect(res.status).toBe(200);
    const calls = spanSpy.mock.calls.map((c) => c[0]);
    const hasRedactedPreview = calls.some(
      (attrs) =>
        attrs &&
        typeof attrs === "object" &&
        (attrs as Record<string, unknown>)["prov.llm.prompt_preview"] === "[redacted]",
    );
    expect(hasRedactedPreview).toBe(true);

    config.nodeEnv = previousNodeEnv;
    config.tracePromptPreviewEnabled = previousTracePreview;
    config.tracePromptPreviewRedactedValue = previousRedactedValue;
  });

  it("returns OpenAI-compatible SSE chunks when stream=true", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "say hi" }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("\"object\":\"chat.completion.chunk\"");
    expect(res.text).toContain("\"delta\":{\"role\":\"assistant\"");
    expect(res.text).toContain("data: [DONE]");
  });

  it("keeps the stronger model for complex prompts", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "analyze this hard problem step-by-step" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("gpt-4o");
  });

  it("returns 503 when no downstream is configured and mock fallback is disabled", async () => {
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousFallback = config.downstreamMockFallbackEnabled;

    config.downstreamBaseUrl = null;
    config.downstreamMockFallbackEnabled = false;
    __resetProviderRegistryForTests();

    const res = await request(app).post("/v1/chat/completions").send({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe("service_unavailable");

    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamMockFallbackEnabled = previousFallback;
    __resetProviderRegistryForTests();
  });
});
