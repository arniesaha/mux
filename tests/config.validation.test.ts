import { describe, expect, it } from "vitest";

type EnvMap = Record<string, string | undefined>;

const validateWithEnv = async (env: EnvMap) => {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    previous.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  try {
    const nonce = `case-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const modPath = new URL(`../src/config.ts?${nonce}`, import.meta.url).href;
    const mod = await import(modPath);
    mod.validateStartupConfig(mod.config);
    return mod;
  } finally {
    for (const [k, v] of previous.entries()) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
};

describe("startup config validation", () => {
  it("fails fast when DOWNSTREAM_MODE is invalid", async () => {
    await expect(
      validateWithEnv({
        PROVIDERS: "[]",
        DOWNSTREAM_MODE: "bad-mode",
        DOWNSTREAM_BASE_URL: "http://localhost:4000/v1",
        DOWNSTREAM_AUTH_MODE: "none",
      }),
    ).rejects.toThrow(/DOWNSTREAM_MODE/);
  });

  it("fails fast when DOWNSTREAM_AUTH_MODE requires API key", async () => {
    await expect(
      validateWithEnv({
        PROVIDERS: "[]",
        DOWNSTREAM_MODE: "openai-compatible",
        DOWNSTREAM_BASE_URL: "http://localhost:4000/v1",
        DOWNSTREAM_AUTH_MODE: "bearer",
        DOWNSTREAM_API_KEY: "",
      }),
    ).rejects.toThrow(/DOWNSTREAM_API_KEY is required/);
  });

  it("fails fast on invalid JSON map", async () => {
    await expect(
      validateWithEnv({
        PROVIDERS: "[]",
        DOWNSTREAM_MODE: "openai-compatible",
        DOWNSTREAM_BASE_URL: "http://localhost:4000/v1",
        DOWNSTREAM_AUTH_MODE: "none",
        MODEL_MAP: "{not-json}",
      }),
    ).rejects.toThrow(/MODEL_MAP/);
  });

  it("fails fast when anthropic-sdk has no providers and no token", async () => {
    await expect(
      validateWithEnv({
        PROVIDERS: "[]",
        DOWNSTREAM_MODE: "anthropic-sdk",
        ANTHROPIC_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
      }),
    ).rejects.toThrow(/DOWNSTREAM_MODE=anthropic-sdk/);
  });

  it("fails fast when 'responses' is declared globally but no provider exposes it", async () => {
    await expect(
      validateWithEnv({
        DOWNSTREAM_MODE: "openai-compatible",
        DOWNSTREAM_AUTH_MODE: "none",
        DOWNSTREAM_PROTOCOLS: "chat_completions,responses",
        PROVIDERS: JSON.stringify([
          {
            id: "default",
            kind: "openai-compatible",
            baseUrl: "http://localhost:4000/v1",
            auth: { mode: "none" },
            protocols: ["chat_completions"],
            models: [{ id: "gpt-4o-mini" }],
          },
        ]),
      }),
    ).rejects.toThrow(/responses/);
  });
});
