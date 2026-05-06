import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { __resetProviderRegistryForTests } from "../../src/providers/registry.js";

describe("e2e: POST /v1/route/resolve", () => {
  const previous = {
    mode: config.downstreamMode,
    fallback: config.downstreamMockFallbackEnabled,
    rules: config.routingRules,
  };

  beforeEach(() => {
    config.downstreamMode = "openai-compatible";
    config.downstreamMockFallbackEnabled = true;
    config.routingRules = [];
    __resetProviderRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.downstreamMode = previous.mode;
    config.downstreamMockFallbackEnabled = previous.fallback;
    config.routingRules = previous.rules;
    __resetProviderRegistryForTests();
  });

  it("returns the route decision without invoking globalThis.fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const app = createApp();
    const res = await request(app)
      .post("/v1/route/resolve")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "say hi" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.route).toBeDefined();
    expect(res.body.route.requestedModel).toBe("gpt-4o");
    expect(typeof res.body.route.resolvedModel).toBe("string");
    expect(typeof res.body.route.providerId).toBe("string");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a route decision for responses-protocol payloads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const app = createApp();
    const res = await request(app)
      .post("/v1/route/resolve")
      .send({
        protocol: "responses",
        model: "gpt-4o",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hi" }] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.route.protocol).toBe("responses");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
