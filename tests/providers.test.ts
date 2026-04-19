import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  __resetProviderRegistryForTests,
  getProvider,
  listProviders,
} from "../src/providers/registry.js";
import type { ProviderConfig } from "../src/providers/types.js";
// Side-effect import: register built-in adapters so the registry can
// instantiate them.
import "../src/providers/index.js";

describe("provider registry", () => {
  let previousProviders: ProviderConfig[];
  let previousMode: typeof config.downstreamMode;
  let previousBaseUrl: typeof config.downstreamBaseUrl;
  let previousAnthropicOauth: typeof config.anthropicOauthToken;
  let previousMockFallback: typeof config.downstreamMockFallbackEnabled;

  beforeEach(() => {
    previousProviders = config.providers;
    previousMode = config.downstreamMode;
    previousBaseUrl = config.downstreamBaseUrl;
    previousAnthropicOauth = config.anthropicOauthToken;
    previousMockFallback = config.downstreamMockFallbackEnabled;
    __resetProviderRegistryForTests();
  });

  afterEach(() => {
    config.providers = previousProviders;
    config.downstreamMode = previousMode;
    config.downstreamBaseUrl = previousBaseUrl;
    config.anthropicOauthToken = previousAnthropicOauth;
    config.downstreamMockFallbackEnabled = previousMockFallback;
    __resetProviderRegistryForTests();
  });

  it("synthesizes a 'default' anthropic provider from legacy env", () => {
    config.providers = [];
    config.downstreamMode = "anthropic-sdk";
    config.anthropicOauthToken = "sk-ant-oat01-test";

    const providers = listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("default");
    expect(providers[0]?.kind).toBe("anthropic-sdk");
  });

  it("synthesizes a 'default' openai-compatible provider from legacy env", () => {
    config.providers = [];
    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.anthropicOauthToken = undefined;

    const providers = listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("default");
    expect(providers[0]?.kind).toBe("openai-compatible");
  });

  it("returns an empty registry when nothing is configured", () => {
    config.providers = [];
    config.downstreamMode = "openai-compatible";
    config.downstreamBaseUrl = null;
    config.downstreamMockFallbackEnabled = false;
    config.anthropicOauthToken = undefined;

    expect(listProviders()).toHaveLength(0);
    expect(getProvider("default")).toBeUndefined();
  });

  it("builds multiple providers from PROVIDERS config", () => {
    config.providers = [
      {
        id: "anthropic-oauth",
        kind: "anthropic-sdk",
        baseUrl: "http://proxy.local",
        auth: { mode: "anthropic-oauth", oauthToken: "sk-ant-oat01-x" },
        models: [{ id: "claude-sonnet-4-6", costInputUsdPerMTok: 3, costOutputUsdPerMTok: 15 }],
      },
      {
        id: "litellm",
        kind: "openai-compatible",
        baseUrl: "http://litellm.local/v1",
        auth: { mode: "bearer", apiKey: "sk-lite" },
        models: [{ id: "claude-sonnet-4-6", costInputUsdPerMTok: 2.5, costOutputUsdPerMTok: 12 }],
      },
    ];

    const providers = listProviders();
    expect(providers.map((p) => p.id).sort()).toEqual(["anthropic-oauth", "litellm"]);
    expect(getProvider("anthropic-oauth")?.kind).toBe("anthropic-sdk");
    expect(getProvider("litellm")?.kind).toBe("openai-compatible");
  });

  it("drops invalid entries from PROVIDERS config without throwing", () => {
    config.providers = [
      { id: "valid", kind: "openai-compatible", baseUrl: "http://x/v1", auth: { mode: "none" }, models: [] },
      // @ts-expect-error — intentionally malformed to verify it's filtered
      { kind: "openai-compatible" },
      // @ts-expect-error — intentionally malformed to verify it's filtered
      { id: "bad-kind", kind: "what-is-this", models: [], auth: { mode: "none" } },
    ];

    const providers = listProviders();
    expect(providers.map((p) => p.id)).toEqual(["valid"]);
  });
});
