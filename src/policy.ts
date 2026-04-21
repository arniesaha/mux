import { config } from "./config.js";
import { listProviders } from "./providers/registry.js";
import type { Provider } from "./providers/types.js";
import type { ChatCompletionsRequest, RouteDecision } from "./types.js";

type ProviderSelection = {
  providerId: string;
  fallbacks: string[]; // cost-ordered, primary excluded
  costWeighted: boolean;
};

// Rank the registered providers that declare the given model by combined
// input+output cost. The cheapest becomes the primary; the rest form the
// failover chain. When only one provider matches, fallbacks is empty.
const selectProviderForModel = (
  resolvedModel: string,
  providers: Provider[],
): ProviderSelection | null => {
  const candidates = providers.filter((p) =>
    p.models.some((m) => m.id === resolvedModel),
  );
  if (candidates.length === 0) return null;

  const cost = (p: Provider): number => {
    const model = p.models.find((m) => m.id === resolvedModel);
    if (!model) return Number.POSITIVE_INFINITY;
    const inCost = model.costInputUsdPerMTok ?? Number.POSITIVE_INFINITY;
    const outCost = model.costOutputUsdPerMTok ?? Number.POSITIVE_INFINITY;
    return inCost + outCost;
  };

  const sorted = [...candidates].sort((a, b) => cost(a) - cost(b));
  return {
    providerId: sorted[0]!.id,
    fallbacks: sorted.slice(1).map((p) => p.id),
    costWeighted: sorted.length > 1,
  };
};

// Resolve providerId + fallback chain + final routeReason. Any single provider
// registered for the model wins without mutating reason; multiple → cheapest
// wins and reason gains +cost_weighted. No match → "default" (the dispatcher's
// mock-fallback or a legacy synthesized provider picks it up).
const applyProviderSelection = (
  decision: Omit<RouteDecision, "providerId" | "fallbackProviderIds">,
  providers?: Provider[],
): RouteDecision => {
  const pool = providers ?? listProviders();
  const selection = selectProviderForModel(decision.resolvedModel, pool);
  if (!selection) {
    return { ...decision, providerId: "default", fallbackProviderIds: [] };
  }
  return {
    ...decision,
    providerId: selection.providerId,
    fallbackProviderIds: selection.fallbacks,
    routeReason: selection.costWeighted
      ? `${decision.routeReason}+cost_weighted`
      : decision.routeReason,
  };
};

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

export const resolveRoute = (
  req: ChatCompletionsRequest,
  providers?: Provider[],
): RouteDecision => {
  const requestedModel = req.model;
  const finalize = (
    decision: Omit<RouteDecision, "providerId" | "fallbackProviderIds">,
  ): RouteDecision => applyProviderSelection(decision, providers);

  if (isAnthropicModel(requestedModel)) {
    const anthropicMapped = config.anthropicModelMap[requestedModel];
    if (anthropicMapped) {
      return finalize({
        requestedModel,
        resolvedModel: anthropicMapped,
        routeReason: "config:anthropic_model_map_override",
        provider: config.defaultProvider,
        backendTarget: config.defaultBackendTarget,
      });
    }

    if (isMaxRuntime(req.runtime)) {
      // Only check the LAST user message for routing cues — system prompts
      // and conversation history contain keywords that falsely escalate.
      const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
      const transcript = lastUserMsg
        ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
        : "";

      if (containsMaxDeepReasoningCue(transcript)) {
        return finalize({
          requestedModel,
          resolvedModel: "claude-opus-4-6",
          routeReason: "heuristic:max_anthropic_deep_reasoning",
          provider: config.defaultProvider,
          backendTarget: config.defaultBackendTarget,
        });
      }

      if (containsMaxCodingCue(transcript)) {
        return finalize({
          requestedModel,
          resolvedModel: "claude-sonnet-4-6",
          routeReason: "heuristic:max_anthropic_coding",
          provider: config.defaultProvider,
          backendTarget: config.defaultBackendTarget,
        });
      }

      if (isSimplePrompt(req)) {
        return finalize({
          requestedModel,
          resolvedModel: "claude-haiku-4-5-20251001",
          routeReason: "heuristic:max_anthropic_haiku_simple",
          provider: config.defaultProvider,
          backendTarget: config.defaultBackendTarget,
        });
      }

      return finalize({
        requestedModel,
        resolvedModel: "claude-sonnet-4-6",
        routeReason: "heuristic:max_anthropic_lightweight",
        provider: config.defaultProvider,
        backendTarget: config.defaultBackendTarget,
      });
    }
  }

  const mapped = config.modelMap[requestedModel];
  if (mapped) {
    return finalize({
      requestedModel,
      resolvedModel: mapped,
      routeReason: "config:model_map_override",
      provider: config.defaultProvider,
      backendTarget: config.defaultBackendTarget,
    });
  }

  const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
  const lastUserText = lastUserMsg
    ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
    : "";
  const escalation = containsEscalationCue(lastUserText);

  if (requestedModel === "gpt-4o" && !escalation) {
    return finalize({
      requestedModel,
      resolvedModel: "gpt-4o-mini",
      routeReason: "heuristic:downgrade_simple_prompt",
      provider: config.defaultProvider,
      backendTarget: config.defaultBackendTarget,
    });
  }

  return finalize({
    requestedModel,
    resolvedModel: requestedModel,
    routeReason: escalation ? "heuristic:keep_strong_model" : "default:passthrough",
    provider: config.defaultProvider,
    backendTarget: config.defaultBackendTarget,
  });
};
