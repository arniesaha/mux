import type { ProviderConfig } from "./types.js";

export const computeCostUsd = (
  cfg: ProviderConfig,
  resolvedModel: string,
  promptTokens: number,
  completionTokens: number,
): number => {
  const model = cfg.models.find((m) => m.id === resolvedModel);
  if (!model) return 0;
  const inPrice = model.costInputUsdPerMTok ?? 0;
  const outPrice = model.costOutputUsdPerMTok ?? 0;
  return (
    (promptTokens / 1_000_000) * inPrice +
    (completionTokens / 1_000_000) * outPrice
  );
};

export const resolveCallerAgentId = (context?: {
  agentweaveHeaders?: Record<string, string>;
}): string | undefined => {
  return context?.agentweaveHeaders?.["x-agentweave-agent-id"];
};
