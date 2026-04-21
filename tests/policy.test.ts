import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { resolveRoute } from "../src/policy.js";

describe("resolveRoute", () => {
  it("downgrades gpt-4o to gpt-4o-mini for simple prompts", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "gpt-4o",
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(route.resolvedModel).toBe("gpt-4o-mini");
    expect(route.routeReason).toBe("heuristic:downgrade_simple_prompt");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("keeps strong model for complex prompts", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "gpt-4o",
      messages: [{ role: "user", content: "analyze this complex problem step-by-step" }],
    });

    expect(route.resolvedModel).toBe("gpt-4o");
    expect(route.routeReason).toBe("heuristic:keep_strong_model");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("applies Anthropic-specific model map for Claude models", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {
      "claude-3-7-sonnet-latest": "claude-sonnet-4-6",
    };

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.routeReason).toBe("config:anthropic_model_map_override");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("prefers Anthropic model map over generic MODEL_MAP for Claude models", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {
      "claude-3-7-sonnet-latest": "claude-sonnet-4-6",
    };
    config.anthropicModelMap = {
      "claude-3-7-sonnet-latest": "claude-sonnet-4-6",
    };

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.routeReason).toBe("config:anthropic_model_map_override");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("routes Max lightweight Claude prompts to Haiku", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      runtime: "max",
      messages: [{ role: "user", content: "give me a quick summary" }],
    });

    expect(route.resolvedModel).toBe("claude-haiku-4-5-20251001");
    expect(route.routeReason).toBe("heuristic:max_anthropic_haiku_simple");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("routes to Haiku when last user message is simple even in multi-turn", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "claude-sonnet-4-6",
      runtime: "max",
      messages: [
        { role: "user", content: "help me with this" },
        { role: "assistant", content: "sure, what do you need?" },
        { role: "user", content: "make it better" },
      ],
    });

    expect(route.resolvedModel).toBe("claude-haiku-4-5-20251001");
    expect(route.routeReason).toBe("heuristic:max_anthropic_haiku_simple");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("routes to Haiku for simple prompt even when tools are present", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "claude-sonnet-4-6",
      runtime: "max",
      messages: [{ role: "user", content: "check status" }],
      tools: [{ type: "function", function: { name: "get_status", parameters: {} } }],
    });

    expect(route.resolvedModel).toBe("claude-haiku-4-5-20251001");
    expect(route.routeReason).toBe("heuristic:max_anthropic_haiku_simple");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("routes Max task-oriented prompts to Sonnet, not Haiku", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "claude-sonnet-4-6",
      runtime: "max",
      messages: [{ role: "user", content: "implement issue number seven" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.routeReason).toBe("heuristic:max_anthropic_coding");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("routes Max coding/debug Claude prompts to Sonnet", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "claude-sonnet-4-6",
      runtime: "max",
      messages: [{ role: "user", content: "debug this TypeScript stack trace" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.routeReason).toBe("heuristic:max_anthropic_coding");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("routes Max deep-reasoning Claude prompts to Opus", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      runtime: "max",
      messages: [{ role: "user", content: "analyze architecture tradeoffs and make a long-term roadmap" }],
    });

    expect(route.resolvedModel).toBe("claude-opus-4-6");
    expect(route.routeReason).toBe("heuristic:max_anthropic_deep_reasoning");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("keeps Anthropic model-map override ahead of Max heuristics", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {
      "claude-3-7-sonnet-latest": "claude-sonnet-4-6",
    };

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      runtime: "max",
      messages: [{ role: "user", content: "analyze architecture tradeoffs" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.routeReason).toBe("config:anthropic_model_map_override");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  // --- Provider selection (#39 Phase 1) ---------------------------------------

  it("defaults providerId to 'default' when no registered provider serves the model", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const route = resolveRoute(
      { model: "gpt-4o", messages: [{ role: "user", content: "say hi" }] },
      /* providers */ [],
    );

    expect(route.providerId).toBe("default");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("picks the cheapest provider when multiple serve the resolved model (cost-weighted)", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const providers = [
      {
        id: "expensive",
        kind: "anthropic-sdk" as const,
        models: [
          { id: "claude-sonnet-4-6", costInputUsdPerMTok: 3, costOutputUsdPerMTok: 15 },
        ],
        call: async () => ({} as any),
        stream: async () => {},
      },
      {
        id: "cheap",
        kind: "openai-compatible" as const,
        models: [
          { id: "claude-sonnet-4-6", costInputUsdPerMTok: 2, costOutputUsdPerMTok: 10 },
        ],
        call: async () => ({} as any),
        stream: async () => {},
      },
    ];

    const route = resolveRoute(
      {
        model: "claude-sonnet-4-6",
        runtime: "max",
        messages: [{ role: "user", content: "refactor this function for me" }],
      },
      providers,
    );

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.providerId).toBe("cheap");
    expect(route.routeReason).toBe("heuristic:max_anthropic_coding+cost_weighted");
    // Primary excluded; more-expensive provider queued as fallback for #45
    expect(route.fallbackProviderIds).toEqual(["expensive"]);

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("does not annotate route reason when only one provider serves the model", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {};
    config.anthropicModelMap = {};

    const providers = [
      {
        id: "only-one",
        kind: "anthropic-sdk" as const,
        models: [{ id: "claude-sonnet-4-6" }],
        call: async () => ({} as any),
        stream: async () => {},
      },
    ];

    const route = resolveRoute(
      {
        model: "claude-sonnet-4-6",
        runtime: "max",
        messages: [{ role: "user", content: "refactor this function" }],
      },
      providers,
    );

    expect(route.providerId).toBe("only-one");
    expect(route.routeReason).toBe("heuristic:max_anthropic_coding");
    expect(route.fallbackProviderIds).toEqual([]);

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });
});
