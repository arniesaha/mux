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

export const config = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? "development",
  defaultProvider: process.env.DEFAULT_PROVIDER ?? "openai-compatible",
  defaultBackendTarget:
    process.env.DEFAULT_BACKEND_TARGET ?? "mock://downstream-chat-completions",
  modelMap: parseModelMap(process.env.MODEL_MAP),
};
