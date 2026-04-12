import { trace, context, type Span, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { config } from "./config.js";

let enabled = false;

export const tracingEnabled = () => enabled;

export const initTracing = async () => {
  if (!config.agentweaveOtlpEndpoint) return;

  try {
    const { AgentWeaveConfig } = await import("agentweave-sdk");
    AgentWeaveConfig.setup({
      agentId: config.agentweaveAgentId,
      otlpEndpoint: config.agentweaveOtlpEndpoint,
    });
    enabled = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[mux/tracing] Failed to initialise AgentWeave SDK:", err);
  }
};

const getTracer = () => trace.getTracer("mux");

export const setSpanAttrs = (attrs: Record<string, string | number | boolean | null | undefined>) => {
  if (!enabled) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) span.setAttribute(k, v);
  }
};

export const withTracedRequest = async <T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!enabled) return fn();

  const tracer = getTracer();
  const span = tracer.startSpan(`agent.${name}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "prov.activity.type": "agent_turn",
      "prov.agent.id": config.agentweaveAgentId,
      "prov.wasAssociatedWith": config.agentweaveAgentId,
    },
  }, context.active());

  const ctx = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(ctx, fn);
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
};

export const withLlmSpan = async <T>(
  provider: string,
  model: string,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!enabled) return fn();

  const tracer = getTracer();
  const span = tracer.startSpan(`llm.${model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "prov.activity.type": "llm_call",
      "prov.llm.provider": provider,
      "prov.llm.model": model,
      "prov.agent.id": config.agentweaveAgentId,
      "prov.wasAssociatedWith": config.agentweaveAgentId,
    },
  }, context.active());

  const ctx = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(ctx, fn);
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
};
