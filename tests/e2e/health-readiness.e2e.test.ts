import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { __resetProviderRegistryForTests } from "../../src/providers/registry.js";

describe("e2e: GET /health and GET /ready", () => {
  const previous = {
    mode: config.downstreamMode,
    baseUrl: config.downstreamBaseUrl,
    fallback: config.downstreamMockFallbackEnabled,
    providers: config.providers,
  };

  beforeEach(() => {
    __resetProviderRegistryForTests();
  });

  afterEach(() => {
    config.downstreamMode = previous.mode;
    config.downstreamBaseUrl = previous.baseUrl;
    config.downstreamMockFallbackEnabled = previous.fallback;
    config.providers = previous.providers;
    __resetProviderRegistryForTests();
  });

  it("/health is always 200", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("/ready returns 200 with at least one chat-capable provider", async () => {
    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://upstream.test/v1";
    config.downstreamMockFallbackEnabled = true;
    config.providers = [];
    __resetProviderRegistryForTests();

    const app = createApp();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.providerCount).toBeGreaterThan(0);
    expect(Array.isArray(res.body.diagnostics?.providers)).toBe(true);
  });

  it("/ready returns 503 when no providers can be synthesized", async () => {
    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = null;
    config.downstreamMockFallbackEnabled = false;
    config.providers = [];
    __resetProviderRegistryForTests();

    const app = createApp();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.reasons).toContain("no providers are registered");
  });
});
