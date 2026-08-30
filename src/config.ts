import dotenv from "dotenv";

import type { ProviderConfig, ProviderKind } from "./providers/types.js";
import type { RequestProtocol, RoutingRule } from "./types.js";

// Skip loading .env during test runs so the vitest suite stays hermetic.
// Tests that require specific env values set them on process.env themselves.
if (process.env.VITEST !== "true") {
  dotenv.config();
}

type DownstreamAuthMode = "none" | "bearer" | "x-api-key" | "passthrough";
type DownstreamMode = "openai-compatible" | "anthropic-sdk";

type ParseErrorCode =
  | "invalid_number"
  | "invalid_non_negative_int"
  | "invalid_boolean"
  | "invalid_json"
  | "invalid_json_type"
  | "invalid_enum"
  | "invalid_provider";

type ParseError = {
  env: string;
  message: string;
  code: ParseErrorCode;
};

const parseErrors: ParseError[] = [];

const addParseError = (env: string, message: string, code: ParseErrorCode): void => {
  parseErrors.push({ env, message, code });
};

const parseModelMap = (input: string | undefined, env: string): Record<string, string> => {
  return parseJsonMap(input, env);
};

const parseBoolean = (
  input: string | undefined,
  defaultValue: boolean,
  env: string,
): boolean => {
  if (input == null) return defaultValue;
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  addParseError(
    env,
    `expected boolean-like value (true/false/1/0/yes/no/on/off), got '${input}'`,
    "invalid_boolean",
  );
  return defaultValue;
};

const parseNumber = (input: string | undefined, defaultValue: number, env: string): number => {
  if (!input) return defaultValue;
  const parsed = Number(input);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  addParseError(env, `expected a positive number, got '${input}'`, "invalid_number");
  return defaultValue;
};

const parseNonNegativeInt = (
  input: string | undefined,
  defaultValue: number,
  env: string,
): number => {
  if (!input) return defaultValue;
  const parsed = Number.parseInt(input, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  addParseError(env, `expected a non-negative integer, got '${input}'`, "invalid_non_negative_int");
  return defaultValue;
};

const normalizeBaseUrl = (input: string | undefined): string | null => {
  if (!input?.trim()) return null;
  return input.replace(/\/+$/, "");
};

const parseDownstreamAuthMode = (input: string | undefined): DownstreamAuthMode => {
  const normalized = input?.trim().toLowerCase();

  if (normalized == null || normalized === "") return "bearer";
  if (normalized === "none") return "none";
  if (normalized === "x-api-key") return "x-api-key";
  if (normalized === "passthrough") return "passthrough";
  if (normalized === "bearer") return "bearer";

  addParseError(
    "DOWNSTREAM_AUTH_MODE",
    `expected one of none|bearer|x-api-key|passthrough, got '${input}'`,
    "invalid_enum",
  );
  return "bearer";
};

const parseDownstreamMode = (input: string | undefined): DownstreamMode => {
  const normalized = input?.trim().toLowerCase();
  if (normalized == null || normalized === "") return "openai-compatible";
  if (normalized === "anthropic-sdk") return "anthropic-sdk";
  if (normalized === "openai-compatible") return "openai-compatible";

  addParseError(
    "DOWNSTREAM_MODE",
    `expected one of openai-compatible|anthropic-sdk, got '${input}'`,
    "invalid_enum",
  );
  return "openai-compatible";
};

const isRequestProtocol = (v: unknown): v is RequestProtocol =>
  v === "chat_completions" || v === "responses";

const parseProtocols = (
  input: unknown,
  defaultValue: RequestProtocol[],
  env: string,
): RequestProtocol[] => {
  if (!Array.isArray(input)) {
    addParseError(env, "expected an array of protocols", "invalid_json_type");
    return defaultValue;
  }
  const out = input.filter(isRequestProtocol);
  if (out.length === 0) {
    addParseError(env, "must include at least one supported protocol", "invalid_provider");
    return defaultValue;
  }
  if (out.length !== input.length) {
    addParseError(
      env,
      "contains unsupported protocol(s); allowed values are chat_completions,responses",
      "invalid_provider",
    );
  }
  return out;
};

const parseProtocolsCsv = (
  input: string | undefined,
  defaultValue: RequestProtocol[],
): RequestProtocol[] => {
  if (!input?.trim()) return defaultValue;
  const tokens = input.split(",").map((s) => s.trim()).filter(Boolean);
  const out = tokens.filter(isRequestProtocol);
  if (out.length === 0) {
    addParseError(
      "DOWNSTREAM_PROTOCOLS",
      `must include at least one supported protocol (chat_completions,responses), got '${input}'`,
      "invalid_enum",
    );
    return defaultValue;
  }
  if (out.length !== tokens.length) {
    addParseError(
      "DOWNSTREAM_PROTOCOLS",
      `contains unsupported protocol(s), got '${input}'`,
      "invalid_enum",
    );
  }
  return out;
};

const parseProviders = (input: string | undefined): ProviderConfig[] => {
  if (!input?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    addParseError("PROVIDERS", "must be valid JSON", "invalid_json");
    return [];
  }

  if (!Array.isArray(parsed)) {
    addParseError("PROVIDERS", "must be a JSON array", "invalid_json_type");
    return [];
  }

  const out: ProviderConfig[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const raw = parsed[i];
    if (!raw || typeof raw !== "object") {
      addParseError("PROVIDERS", `entry[${i}] must be an object`, "invalid_provider");
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim()) {
      addParseError("PROVIDERS", `entry[${i}].id must be a non-empty string`, "invalid_provider");
      continue;
    }
    if (r.kind !== "openai-compatible" && r.kind !== "anthropic-sdk") {
      addParseError(
        "PROVIDERS",
        `entry[${i}].kind must be 'openai-compatible' or 'anthropic-sdk'`,
        "invalid_provider",
      );
      continue;
    }
    const kind = r.kind as ProviderKind;
    const models = Array.isArray(r.models)
      ? (r.models as Array<Record<string, unknown>>)
          .filter((m) => m && typeof m.id === "string")
          .map((m) => ({
            id: m.id as string,
            costInputUsdPerMTok:
              typeof m.costInputUsdPerMTok === "number" ? m.costInputUsdPerMTok : undefined,
            costOutputUsdPerMTok:
              typeof m.costOutputUsdPerMTok === "number" ? m.costOutputUsdPerMTok : undefined,
          }))
      : [];
    const auth =
      r.auth && typeof r.auth === "object"
        ? (r.auth as ProviderConfig["auth"])
        : ({ mode: "none" } as ProviderConfig["auth"]);
    out.push({
      id: r.id,
      kind,
      protocols:
        r.protocols === undefined
          ? ["chat_completions"]
          : parseProtocols(r.protocols, ["chat_completions"], `PROVIDERS[${i}].protocols`),
      baseUrl: typeof r.baseUrl === "string" ? normalizeBaseUrl(r.baseUrl) : null,
      auth,
      extraHeaders:
        r.extraHeaders && typeof r.extraHeaders === "object"
          ? (r.extraHeaders as Record<string, string>)
          : undefined,
      timeoutMs: typeof r.timeoutMs === "number" ? r.timeoutMs : undefined,
      models,
    });
  }
  return out;
};

const toStringArray = (value: unknown): string[] | undefined => {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return out.length > 0 ? out : undefined;
};

const parseRoutingRules = (input: string | undefined): RoutingRule[] => {
  if (!input?.trim()) return [];
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      addParseError("ROUTING_RULES", "must be a JSON array", "invalid_json_type");
      return [];
    }
    const out: RoutingRule[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const raw = parsed[i];
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "string" || !r.id.trim()) continue;
      if (typeof r.resolvedModel !== "string" || !r.resolvedModel.trim()) continue;
      out.push({
        id: r.id.trim(),
        protocols: parseProtocols(r.protocols, ["chat_completions"], `ROUTING_RULES[${i}].protocols`),
        runtime: Array.isArray(r.runtime) ? toStringArray(r.runtime) : typeof r.runtime === "string" ? r.runtime.trim() : undefined,
        requestedModel: Array.isArray(r.requestedModel)
          ? toStringArray(r.requestedModel)
          : typeof r.requestedModel === "string"
            ? r.requestedModel.trim()
            : undefined,
        promptIncludesAny: toStringArray(r.promptIncludesAny),
        maxPromptLength: typeof r.maxPromptLength === "number" && r.maxPromptLength > 0 ? r.maxPromptLength : undefined,
        resolvedModel: r.resolvedModel.trim(),
        routeReason: typeof r.routeReason === "string" && r.routeReason.trim() ? r.routeReason.trim() : undefined,
      });
    }
    return out;
  } catch {
    addParseError("ROUTING_RULES", "must be valid JSON", "invalid_json");
    return [];
  }
};

const parseJsonMap = (input: string | undefined, env: string): Record<string, string> => {
  if (!input) return {};

  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      addParseError(env, "must be a JSON object map", "invalid_json_type");
      return {};
    }
    const entries = Object.entries(parsed).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string",
    ) as Array<[string, string]>;
    if (entries.length !== Object.keys(parsed).length) {
      addParseError(env, "all map values must be strings", "invalid_json_type");
    }
    return Object.fromEntries(entries);
  } catch {
    addParseError(env, "must be valid JSON", "invalid_json");
    return {};
  }
};

const buildStartupValidationErrors = (cfg: typeof config): string[] => {
  const errors = parseErrors.map((e) => `${e.env}: ${e.message}`);

  if (!Number.isFinite(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    errors.push(`PORT: expected a valid TCP port (1-65535), got '${process.env.PORT ?? ""}'`);
  }

  if (cfg.downstreamMode === "openai-compatible") {
    const hasProviders = cfg.providers.length > 0;
    const hasLegacyOpenAiPath =
      Boolean(cfg.downstreamBaseUrl) || cfg.downstreamMockFallbackEnabled;
    if (!hasProviders && !hasLegacyOpenAiPath) {
      errors.push(
        "Config incomplete: DOWNSTREAM_MODE=openai-compatible requires one of: " +
          "(a) PROVIDERS with at least one openai-compatible provider, or " +
          "(b) DOWNSTREAM_BASE_URL set, or " +
          "(c) DOWNSTREAM_MOCK_FALLBACK=true.",
      );
    }

    if (cfg.downstreamAuthMode === "bearer" || cfg.downstreamAuthMode === "x-api-key") {
      if (!cfg.downstreamApiKey?.trim()) {
        errors.push(
          `DOWNSTREAM_API_KEY is required when DOWNSTREAM_AUTH_MODE=${cfg.downstreamAuthMode}.`,
        );
      }
    }
  }

  if (cfg.downstreamMode === "anthropic-sdk") {
    const hasProviders = cfg.providers.length > 0;
    const hasLegacyToken = Boolean(cfg.anthropicOauthToken?.trim() || cfg.anthropicApiKey?.trim());
    if (!hasProviders && !hasLegacyToken) {
      errors.push(
        "Config incomplete: DOWNSTREAM_MODE=anthropic-sdk requires one of: " +
          "(a) PROVIDERS with at least one anthropic-sdk provider, or " +
          "(b) ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY.",
      );
    }
  }

  if (cfg.downstreamProtocols.includes("responses")) {
    const providerProtocols = cfg.providers.flatMap((p) => p.protocols ?? ["chat_completions"]);
    const globalDeclaresResponses = cfg.downstreamProtocols.includes("responses");
    const anyProviderDeclaresResponses = providerProtocols.includes("responses");
    if (cfg.providers.length > 0 && globalDeclaresResponses && !anyProviderDeclaresResponses) {
      errors.push(
        "DOWNSTREAM_PROTOCOLS includes 'responses' but no provider in PROVIDERS declares the 'responses' protocol. " +
          "Add \"protocols\": [\"chat_completions\",\"responses\"] to a provider entry, or remove 'responses' from DOWNSTREAM_PROTOCOLS.",
      );
    }
  }

  return errors;
};

export const validateStartupConfig = (cfg: typeof config = config): void => {
  const errors = buildStartupValidationErrors(cfg);
  if (errors.length === 0) return;
  throw new Error(
    [
      "Invalid startup configuration:",
      ...errors.map((e) => `- ${e}`),
      "Fix your environment variables (see .env.example) and restart.",
    ].join("\n"),
  );
};

export const config = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? "development",
  defaultProvider: process.env.DEFAULT_PROVIDER ?? "openai-compatible",
  defaultBackendTarget:
    process.env.DEFAULT_BACKEND_TARGET ?? "mock://downstream-chat-completions",
  modelMap: parseModelMap(process.env.MODEL_MAP, "MODEL_MAP"),
  anthropicModelMap: parseModelMap(process.env.ANTHROPIC_MODEL_MAP, "ANTHROPIC_MODEL_MAP"),
  downstreamMode: parseDownstreamMode(process.env.DOWNSTREAM_MODE),
  downstreamBaseUrl: normalizeBaseUrl(process.env.DOWNSTREAM_BASE_URL),
  downstreamApiKey: process.env.DOWNSTREAM_API_KEY,
  downstreamAuthMode: parseDownstreamAuthMode(process.env.DOWNSTREAM_AUTH_MODE),
  anthropicBaseUrl: normalizeBaseUrl(process.env.ANTHROPIC_BASE_URL),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicOauthToken: process.env.ANTHROPIC_OAUTH_TOKEN,
  downstreamTimeoutMs: parseNumber(process.env.DOWNSTREAM_TIMEOUT_MS, 30_000, "DOWNSTREAM_TIMEOUT_MS"),
  downstreamExtraHeaders: parseJsonMap(process.env.DOWNSTREAM_EXTRA_HEADERS, "DOWNSTREAM_EXTRA_HEADERS"),
  downstreamProtocols: parseProtocolsCsv(process.env.DOWNSTREAM_PROTOCOLS, ["chat_completions"]),
  downstreamMockFallbackEnabled: parseBoolean(
    process.env.DOWNSTREAM_MOCK_FALLBACK,
    process.env.NODE_ENV !== "production",
    "DOWNSTREAM_MOCK_FALLBACK",
  ),
  agentweaveOtlpEndpoint: process.env.AGENTWEAVE_OTLP_ENDPOINT || null,
  agentweaveAgentId: process.env.AGENTWEAVE_AGENT_ID || "mux-router",
  tracePromptPreviewEnabled: parseBoolean(
    process.env.TRACE_PROMPT_PREVIEW_ENABLED,
    process.env.NODE_ENV !== "production",
    "TRACE_PROMPT_PREVIEW_ENABLED",
  ),
  tracePromptPreviewRedactedValue:
    process.env.TRACE_PROMPT_PREVIEW_REDACTED_VALUE || "[redacted]",
  providers: parseProviders(process.env.PROVIDERS),
  routingRules: parseRoutingRules(process.env.ROUTING_RULES),
  failoverMaxAttempts: parseNonNegativeInt(process.env.FAILOVER_MAX_ATTEMPTS, 1, "FAILOVER_MAX_ATTEMPTS"),
  // Inject Anthropic ephemeral prompt-cache breakpoints in the OpenAI →
  // Anthropic translator (system prompt, tools, history). On by default —
  // correctly-formed requests only benefit. Opt out with
  // MUX_ANTHROPIC_PROMPT_CACHE=false if a downstream edge case surfaces.
  anthropicPromptCacheEnabled: parseBoolean(
    process.env.MUX_ANTHROPIC_PROMPT_CACHE,
    true,
    "MUX_ANTHROPIC_PROMPT_CACHE",
  ),
};

