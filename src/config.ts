import dotenv from "dotenv";

dotenv.config();

const parseModelMap = (input: string | undefined): Record<string, string> => {
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

const normalizeBaseUrl = (input: string | undefined): string | null => {
  if (!input?.trim()) return null;
  return input.replace(/\/+$/, "");
};

export const config = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? "development",
  defaultProvider: process.env.DEFAULT_PROVIDER ?? "openai-compatible",
  defaultBackendTarget:
    process.env.DEFAULT_BACKEND_TARGET ?? "mock://downstream-chat-completions",
  modelMap: parseModelMap(process.env.MODEL_MAP),
  downstreamBaseUrl: normalizeBaseUrl(process.env.DOWNSTREAM_BASE_URL),
  downstreamApiKey: process.env.DOWNSTREAM_API_KEY,
  downstreamTimeoutMs: parseNumber(process.env.DOWNSTREAM_TIMEOUT_MS, 30_000),
  downstreamMockFallbackEnabled: parseBoolean(
    process.env.DOWNSTREAM_MOCK_FALLBACK,
    process.env.NODE_ENV !== "production",
  ),
};
