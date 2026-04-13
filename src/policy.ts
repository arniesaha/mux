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
    // Task-oriented verbs — these signal real work, not simple queries
    "implement",
    "build",
    "create",
    "write",
    "deploy",
    "update",
    "modify",
    "change",
    "configure",
    "setup",
    "set up",
    "migrate",
    "test",
    "review",
    "merge",
    "release",
    "feature",
    "issue",
    "ticket",
    "pick up",
    "work on",
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
  // Short last user message with no complexity cues → Haiku-eligible.
  // Tools may be present (Max always sends its full toolset) but Haiku
  // can handle them and won't invoke them for trivial prompts.
  const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return false;
  const content = lastUserMsg.content;
  const textLength = typeof content === "string" ? content.length : JSON.stringify(content).length;
  return textLength < 80;
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
      // Only check the LAST user message for routing cues — system prompts
      // and conversation history contain keywords that falsely escalate.
      const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
      const transcript = lastUserMsg
        ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
        : "";

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

  const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
  const lastUserText = lastUserMsg
    ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
    : "";
  const escalation = containsEscalationCue(lastUserText);

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
