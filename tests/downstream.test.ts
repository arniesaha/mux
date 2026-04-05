import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { callDownstream, DownstreamNotConfiguredError } from "../src/downstream.js";
import type { ChatCompletionsRequest, RouteDecision } from "../src/types.js";

const requestPayload: ChatCompletionsRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "say hi" }],
};

const route: RouteDecision = {
  requestedModel: "gpt-4o",
  resolvedModel: "gpt-4o-mini",
  routeReason: "heuristic:test",
  provider: "openai-compatible",
  backendTarget: "http://localhost:4000/v1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callDownstream", () => {
  it("calls LiteLLM-compatible endpoint when configured", async () => {
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousApiKey = config.downstreamApiKey;

    config.downstreamBaseUrl = "http://127.0.0.1:4000/v1";
    config.downstreamApiKey = "test-key";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await callDownstream(requestPayload, route);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4000/v1/chat/completions");

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );

    expect(response.model).toBe("gpt-4o-mini");

    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamApiKey = previousApiKey;
  });

  it("throws when not configured and fallback disabled", async () => {
    const previousBaseUrl = config.downstreamBaseUrl;
    const previousFallback = config.downstreamMockFallbackEnabled;

    config.downstreamBaseUrl = null;
    config.downstreamMockFallbackEnabled = false;

    await expect(callDownstream(requestPayload, route)).rejects.toBeInstanceOf(
      DownstreamNotConfiguredError,
    );

    config.downstreamBaseUrl = previousBaseUrl;
    config.downstreamMockFallbackEnabled = previousFallback;
  });
});
