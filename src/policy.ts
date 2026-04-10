import { config } from "./config.js";
import type { ChatCompletionsRequest, RouteDecision } from "./types.js";

const containsEscalationCue = (text: string): boolean => {
  const cues = ["deep", "complex", "reason", "step-by-step", "analyze", "hard"];
  const lower = text.toLowerCase();
  return cues.some((cue) => lower.includes(cue));
};

const isAnthropicModel = (model: string): boolean => {
  return model.toLowerCase().startsWith("claude-");
};

export const resolveRoute = (req: ChatCompletionsRequest): RouteDecision => {
  const requestedModel = req.model;

  if (isAnthropicModel(requestedModel)) {
    const anthropicMapped = config.anthropicModelMap[requestedModel];
    if (anthropicMapped) {
      return {
        requestedModel,
        resolvedModel: anthropicMapped,
        routeReason: "config:anthropic_model_map_override",
        provider: config.defaultProvider,
        backendTarget: config.defaultBackendTarget,
      };
    }
  }

  const mapped = config.modelMap[requestedModel];
  if (mapped) {
    return {
      requestedModel,
      resolvedModel: mapped,
      routeReason: "config:model_map_override",
      provider: config.defaultProvider,
      backendTarget: config.defaultBackendTarget,
    };
  }

  const transcript = req.messages.map((m) => m.content).join("\n");
  const escalation = containsEscalationCue(transcript);

  if (requestedModel === "gpt-4o" && !escalation) {
    return {
      requestedModel,
      resolvedModel: "gpt-4o-mini",
      routeReason: "heuristic:downgrade_simple_prompt",
      provider: config.defaultProvider,
      backendTarget: config.defaultBackendTarget,
    };
  }

  return {
    requestedModel,
    resolvedModel: requestedModel,
    routeReason: escalation ? "heuristic:keep_strong_model" : "default:passthrough",
    provider: config.defaultProvider,
    backendTarget: config.defaultBackendTarget,
  };
};
