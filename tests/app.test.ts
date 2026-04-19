import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

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
