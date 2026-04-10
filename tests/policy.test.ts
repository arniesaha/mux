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
      "claude-3-7-sonnet-latest": "claude-sonnet-4-5",
    };

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-5");
    expect(route.routeReason).toBe("config:anthropic_model_map_override");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });

  it("prefers Anthropic model map over generic MODEL_MAP for Claude models", () => {
    const previousModelMap = config.modelMap;
    const previousAnthropicModelMap = config.anthropicModelMap;
    config.modelMap = {
      "claude-3-7-sonnet-latest": "claude-3-5-haiku-latest",
    };
    config.anthropicModelMap = {
      "claude-3-7-sonnet-latest": "claude-sonnet-4-5",
    };

    const route = resolveRoute({
      model: "claude-3-7-sonnet-latest",
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-5");
    expect(route.routeReason).toBe("config:anthropic_model_map_override");

    config.modelMap = previousModelMap;
    config.anthropicModelMap = previousAnthropicModelMap;
  });
});
