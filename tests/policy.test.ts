import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { resolveRoute } from "../src/policy.js";

describe("resolveRoute", () => {
  it("downgrades gpt-4o to gpt-4o-mini for simple prompts", () => {
    const previousModelMap = config.modelMap;
    config.modelMap = {};

    const route = resolveRoute({
      model: "gpt-4o",
      messages: [{ role: "user", content: "say hi" }],
    });

    expect(route.resolvedModel).toBe("gpt-4o-mini");
    expect(route.routeReason).toBe("heuristic:downgrade_simple_prompt");

    config.modelMap = previousModelMap;
  });

  it("keeps strong model for complex prompts", () => {
    const previousModelMap = config.modelMap;
    config.modelMap = {};

    const route = resolveRoute({
      model: "gpt-4o",
      messages: [{ role: "user", content: "analyze this complex problem step-by-step" }],
    });

    expect(route.resolvedModel).toBe("gpt-4o");
    expect(route.routeReason).toBe("heuristic:keep_strong_model");

    config.modelMap = previousModelMap;
  });
});
