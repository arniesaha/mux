import dotenv from "dotenv";

import type { ProviderConfig, ProviderKind } from "./providers/types.js";

dotenv.config();

const parseModelMap = (input: string | undefined): Record<string, string> => {
  return parseJsonMap(input);
};

const parseBoolean = (input: string | undefined, defaultValue: boolean): boolean => {
  if (input == null) return defaultValue;
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
};

const parseNumber = (input: string | undefined, defaultValue: number): number => {
  if (!input) return defaultValue;
  const parsed = Number(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
};

const parseNonNegativeInt = (input: string | undefined, defaultValue: number): number => {
  if (!input) return defaultValue;
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
};

const normalizeBaseUrl = (input: string | undefined): string | null => {
  if (!input?.trim()) return null;
  return input.replace(/\/+$/, "");
};

type DownstreamAuthMode = "none" | "bearer" | "x-api-key" | "passthrough";
type DownstreamMode = "openai-compatible" | "anthropic-sdk";

const parseDownstreamAuthMode = (input: string | undefined): DownstreamAuthMode => {
  const normalized = input?.trim().toLowerCase();

  if (normalized === "none") return "none";
  if (normalized === "x-api-key") return "x-api-key";
  if (normalized === "passthrough") return "passthrough";
  return "bearer";
};

const parseDownstreamMode = (input: string | undefined): DownstreamMode => {
  const normalized = input?.trim().toLowerCase();
  if (normalized === "anthropic-sdk") return "anthropic-sdk";
  return "openai-compatible";
};

const parseProviders = (input: string | undefined): ProviderConfig[] => {
  if (!input?.trim()) return [];
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [];
    const out: ProviderConfig[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== "string" || !r.id.trim()) continue;
      if (r.kind !== "openai-compatible" && r.kind !== "anthropic-sdk") continue;
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
        baseUrl:
          typeof r.baseUrl === "string" ? normalizeBaseUrl(r.baseUrl) : null,
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
  } catch {
    // fall back to empty registry; caller synthesizes a legacy entry
    return [];
  }
};

const parseJsonMap = (input: string | undefined): Record<string, string> => {
  if (!input) return {};

  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const entries = Object.entries(parsed).filter(
        ([k, v]) => typeof k === "string" && typeof v === "string",
      ) as Array<[string, string]>;
      return Object.fromEntries(entries);
    }
  } catch {
    // ignore invalid map and fall back to empty map
  }

  return {};
};

export const config = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? "development",
  defaultProvider: process.env.DEFAULT_PROVIDER ?? "openai-compatible",
  defaultBackendTarget:
    process.env.DEFAULT_BACKEND_TARGET ?? "mock://downstream-chat-completions",
  modelMap: parseModelMap(process.env.MODEL_MAP),
  anthropicModelMap: parseModelMap(process.env.ANTHROPIC_MODEL_MAP),
  downstreamMode: parseDownstreamMode(process.env.DOWNSTREAM_MODE),
  downstreamBaseUrl: normalizeBaseUrl(process.env.DOWNSTREAM_BASE_URL),
  downstreamApiKey: process.env.DOWNSTREAM_API_KEY,
  downstreamAuthMode: parseDownstreamAuthMode(process.env.DOWNSTREAM_AUTH_MODE),
  anthropicBaseUrl: normalizeBaseUrl(process.env.ANTHROPIC_BASE_URL),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicOauthToken: process.env.ANTHROPIC_OAUTH_TOKEN,
  downstreamTimeoutMs: parseNumber(process.env.DOWNSTREAM_TIMEOUT_MS, 30_000),
  downstreamExtraHeaders: parseJsonMap(process.env.DOWNSTREAM_EXTRA_HEADERS),
  downstreamMockFallbackEnabled: parseBoolean(
    process.env.DOWNSTREAM_MOCK_FALLBACK,
    process.env.NODE_ENV !== "production",
  ),
  agentweaveOtlpEndpoint: process.env.AGENTWEAVE_OTLP_ENDPOINT || null,
  agentweaveAgentId: process.env.AGENTWEAVE_AGENT_ID || "mux-router",
  providers: parseProviders(process.env.PROVIDERS),
  failoverMaxAttempts: parseNonNegativeInt(process.env.FAILOVER_MAX_ATTEMPTS, 1),
};
