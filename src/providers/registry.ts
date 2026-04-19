import { config } from "../config.js";
import type { Provider, ProviderConfig } from "./types.js";

let registry: Map<string, Provider> | null = null;

// Provider adapters register themselves by being invoked from here. We keep
// a minimal factory map so we don't have to eagerly import adapters (which
// would create a circular dep with downstream.ts).
type AdapterFactory = (cfg: ProviderConfig) => Provider;
const adapterFactories: Partial<Record<ProviderConfig["kind"], AdapterFactory>> = {};

export const registerAdapter = (
  kind: ProviderConfig["kind"],
  factory: AdapterFactory,
): void => {
  adapterFactories[kind] = factory;
};

// When PROVIDERS env is empty, synthesize a single "default" provider from
// the legacy DOWNSTREAM_* / ANTHROPIC_* env vars so existing deployments
// keep working without a config change.
const synthesizeLegacyProvider = (): ProviderConfig | null => {
  if (config.downstreamMode === "anthropic-sdk") {
    const oauth = config.anthropicOauthToken?.trim();
    const apiKey = config.anthropicApiKey?.trim();
    if (!oauth && !apiKey) return null;
    return {
      id: "default",
      kind: "anthropic-sdk",
      baseUrl: config.anthropicBaseUrl,
      auth: oauth
        ? { mode: "anthropic-oauth", oauthToken: oauth, baseUrl: config.anthropicBaseUrl }
        : { mode: "anthropic-api-key", apiKey: apiKey!, baseUrl: config.anthropicBaseUrl },
      models: [],
    };
  }

  // openai-compatible: a provider exists as long as we have a baseUrl OR
  // the mock-fallback path is enabled (tests / local dev).
  if (!config.downstreamBaseUrl && !config.downstreamMockFallbackEnabled) return null;

  const auth: ProviderConfig["auth"] =
    config.downstreamAuthMode === "none"
      ? { mode: "none" }
      : config.downstreamAuthMode === "passthrough"
        ? { mode: "passthrough" }
        : config.downstreamAuthMode === "x-api-key"
          ? { mode: "x-api-key", apiKey: config.downstreamApiKey ?? "" }
          : { mode: "bearer", apiKey: config.downstreamApiKey ?? "" };

  return {
    id: "default",
    kind: "openai-compatible",
    baseUrl: config.downstreamBaseUrl,
    auth,
    extraHeaders: config.downstreamExtraHeaders,
    timeoutMs: config.downstreamTimeoutMs,
    models: [],
  };
};

const build = (): Map<string, Provider> => {
  const entries = config.providers.length > 0
    ? config.providers
    : [synthesizeLegacyProvider()].filter((x): x is ProviderConfig => x != null);

  const map = new Map<string, Provider>();
  for (const entry of entries) {
    if (!entry.id || typeof entry.id !== "string") continue;
    const factory = adapterFactories[entry.kind];
    if (!factory) continue;
    map.set(entry.id, factory(entry));
  }
  return map;
};

export const getRegistry = (): Map<string, Provider> => {
  if (!registry) registry = build();
  return registry;
};

export const getProvider = (id: string): Provider | undefined => {
  return getRegistry().get(id);
};

export const listProviders = (): Provider[] => {
  return Array.from(getRegistry().values());
};

// Test-only: rebuild the registry on next access so tests that mutate
// `config` see the new values.
export const __resetProviderRegistryForTests = (): void => {
  registry = null;
};
