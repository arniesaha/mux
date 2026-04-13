import { config } from "./config.js";
import type { ChatCompletionsRequest, RouteDecision } from "./types.js";

const containsAny = (text: string, cues: string[]): boolean => {
  const lower = text.toLowerCase();
  return cues.some((cue) => lower.includes(cue));
};

const containsEscalationCue = (text: string): boolean => {
  const cues = ["deep", "complex", "reason", "step-by-step", "analyze", "hard"];
  return containsAny(text, cues);
};

const containsMaxCodingCue = (text: string): boolean => {
  const cues = [
    "code",
    "coding",
    "debug",
    "bug",
    "stack trace",
    "error",
    "typescript",
    "javascript",
    "python",
    "fix this",
    "refactor",
    "troubleshoot",
    "terminal",
    "cli",
  ];
  return containsAny(text, cues);
};

const containsMaxDeepReasoningCue = (text: string): boolean => {
  const cues = [
    "deep",
    "complex",
    "tradeoff",
    "trade-off",
    "long-term",
    "strategy",
    "architecture",
    "step-by-step",
    "reason",
    "analyze",
    "plan",
    "roadmap",
  ];
  return containsAny(text, cues);
};

const isAnthropicModel = (model: string): boolean => {
  return model.toLowerCase().startsWith("claude-");
};

const isMaxRuntime = (runtime: string | undefined): boolean => {
  if (!runtime) return false;
  const normalized = runtime.toLowerCase();
  return normalized === "max" || normalized === "agent-max" || normalized === "pi-mono" || normalized === "pimono";
};

const isSimplePrompt = (req: ChatCompletionsRequest): boolean => {
  // Single user message, no tools, short content → Haiku-eligible
  if (req.tools && req.tools.length > 0) return false;
  if (req.messages.length > 2) return false; // allow 1 system + 1 user at most
  const userMessages = req.messages.filter((m) => m.role === "user");
  if (userMessages.length !== 1) return false;
  const content = userMessages[0].content;
  const textLength = typeof content === "string" ? content.length : JSON.stringify(content).length;
  return textLength < 200;
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

    if (isMaxRuntime(req.runtime)) {
      const transcript = req.messages.map((m) => m.content).join("\n");

      if (containsMaxDeepReasoningCue(transcript)) {
        return {
          requestedModel,
          resolvedModel: "claude-opus-4-6",
          routeReason: "heuristic:max_anthropic_deep_reasoning",
          provider: config.defaultProvider,
          backendTarget: config.defaultBackendTarget,
        };
      }

      if (containsMaxCodingCue(transcript)) {
        return {
          requestedModel,
          resolvedModel: "claude-sonnet-4-6",
          routeReason: "heuristic:max_anthropic_coding",
          provider: config.defaultProvider,
          backendTarget: config.defaultBackendTarget,
        };
      }

      if (isSimplePrompt(req)) {
        return {
          requestedModel,
          resolvedModel: "claude-haiku-4-5-20251001",
          routeReason: "heuristic:max_anthropic_haiku_simple",
          provider: config.defaultProvider,
          backendTarget: config.defaultBackendTarget,
        };
      }

      return {
        requestedModel,
        resolvedModel: "claude-sonnet-4-6",
        routeReason: "heuristic:max_anthropic_lightweight",
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
