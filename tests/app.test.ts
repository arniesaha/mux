import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("createApp", () => {
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
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ messages: [] });

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
});
