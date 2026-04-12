import { config } from "./config.js";

type SpanLike = {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: Error): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
};

type WithSpanFn = <T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: SpanLike) => T | Promise<T>,
) => T | Promise<T>;

let enabled = false;
let _withSpan: WithSpanFn | null = null;

// Current active span in the request scope — set by withTracedRequest/withLlmSpan.
// This avoids needing @opentelemetry/api's trace.getActiveSpan().
let _activeSpan: SpanLike | null = null;

export const tracingEnabled = () => enabled;

export const initTracing = async () => {
  if (!config.agentweaveOtlpEndpoint) return;

  try {
    const sdk = await import("agentweave-sdk");
    sdk.AgentWeaveConfig.setup({
      agentId: config.agentweaveAgentId,
      otlpEndpoint: config.agentweaveOtlpEndpoint,
    });
    _withSpan = sdk.withSpan as WithSpanFn;
    enabled = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[mux/tracing] Failed to initialise AgentWeave SDK:", err);
  }
};

export const setSpanAttrs = (attrs: Record<string, string | number | boolean | null | undefined>) => {
  if (!enabled || !_activeSpan) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) _activeSpan.setAttribute(k, v);
  }
};

export const withTracedRequest = async <T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!enabled || !_withSpan) return fn();

  return _withSpan(`agent.${name}`, {
    "prov.activity.type": "agent_turn",
    "prov.agent.id": config.agentweaveAgentId,
    "prov.wasAssociatedWith": config.agentweaveAgentId,
  }, async (span) => {
    const prevSpan = _activeSpan;
    _activeSpan = span;
    try {
      return await fn();
    } finally {
      _activeSpan = prevSpan;
    }
  }) as Promise<T>;
};

export const withLlmSpan = async <T>(
  provider: string,
  model: string,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!enabled || !_withSpan) return fn();

  return _withSpan(`llm.${model}`, {
    "prov.activity.type": "llm_call",
    "prov.llm.provider": provider,
    "prov.llm.model": model,
    "prov.agent.id": config.agentweaveAgentId,
    "prov.wasAssociatedWith": config.agentweaveAgentId,
  }, async (span) => {
    const prevSpan = _activeSpan;
    _activeSpan = span;
    try {
      return await fn();
    } finally {
      _activeSpan = prevSpan;
    }
  }) as Promise<T>;
};
