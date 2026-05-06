import express from "express";
import pino from "pino";

import { config } from "./config.js";
import {
  callDownstream,
  callResponsesDownstream,
  DownstreamNotConfiguredError,
  DownstreamRequestError,
  streamDownstream,
  streamResponsesDownstream,
  type DownstreamRequestContext,
} from "./downstream.js";
import { resolveRoute } from "./policy.js";
import "./providers/index.js";
import { withTracedRequest, setSpanAttrs } from "./tracing.js";
import type {
  ChatCompletionsRequest,
  ChatMessage,
  RequestProtocol,
  ResponsesRequest,
} from "./types.js";

const logger = pino({
  level: config.nodeEnv === "development" ? "debug" : "info",
});

const extractRuntime = (body: { runtime?: string }, req: express.Request): string => {
  return body.runtime || req.header("x-runtime") || "unknown";
};

const extractAgentweaveHeaders = (req: express.Request): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string" && key.startsWith("x-agentweave-")) {
      headers[key] = value;
    }
  }
  return headers;
};

const buildDownstreamContext = (req: express.Request): DownstreamRequestContext => ({
  incomingAuthorizationHeader: req.header("authorization") ?? undefined,
  agentweaveHeaders: extractAgentweaveHeaders(req),
});

const extractTextFromUnknown = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractTextFromUnknown);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  if (typeof record.text === "string") out.push(record.text);
  if (typeof record.content === "string") out.push(record.content);
  if (Array.isArray(record.content)) out.push(...record.content.flatMap(extractTextFromUnknown));
  if (record.input != null) out.push(...extractTextFromUnknown(record.input));
  return out;
};

const buildPromptPreviewForChat = (messages: ChatMessage[]): string => {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return "";
  return extractTextFromUnknown(lastUserMsg.content).join(" ").slice(0, 200);
};

const buildPromptPreviewForResponses = (input: ResponsesRequest["input"]): string => {
  if (input == null) return "";
  const items = Array.isArray(input) ? input : [input];
  return items.flatMap((item) => extractTextFromUnknown(item)).join(" ").slice(0, 200);
};

const normalizeResponsesInputToMessages = (input: ResponsesRequest["input"]): ChatMessage[] => {
  if (input == null) return [{ role: "user", content: "" }];
  const items = Array.isArray(input) ? input : [input];
  const content = items
    .map((item) => {
      if (typeof item === "string") return item;
      const record = item as Record<string, unknown>;
      if (typeof record.role === "string" && typeof record.content === "string") {
        return record.content;
      }
      return extractTextFromUnknown(item).join(" ");
    })
    .filter(Boolean)
    .join("\n");
  return [{ role: "user", content }];
};

const logRouteDecision = (params: {
  protocol: RequestProtocol;
  runtime: string;
  route: ReturnType<typeof resolveRoute>;
  callerAgentId?: string;
  promptPreview: string;
  messageCount?: number;
  inputItemCount?: number;
}) => {
  const { protocol, runtime, route, callerAgentId, promptPreview, messageCount, inputItemCount } = params;
  const tracedPromptPreview = config.tracePromptPreviewEnabled
    ? promptPreview
    : config.tracePromptPreviewRedactedValue;

  setSpanAttrs({
    "prov.route.protocol": protocol,
    "prov.route.requested_model": route.requestedModel,
    "prov.route.resolved_model": route.resolvedModel,
    "prov.route.reason": route.routeReason,
    "prov.route.runtime": runtime,
    "prov.route.provider_id": route.providerId,
    "prov.llm.model": route.resolvedModel,
    "prov.llm.prompt_preview": tracedPromptPreview,
    ...(typeof messageCount === "number" ? { "prov.route.message_count": messageCount } : {}),
    ...(typeof inputItemCount === "number" ? { "prov.route.input_item_count": inputItemCount } : {}),
    ...(callerAgentId ? { "prov.agent.id": callerAgentId } : {}),
  });

  logger.info({
    event: "mux.route_decision",
    protocol,
    runtime,
    requestedModel: route.requestedModel,
    resolvedModel: route.resolvedModel,
    routeReason: route.routeReason,
    provider: route.provider,
    providerId: route.providerId,
    backendTarget: route.backendTarget,
    downstreamMode: config.downstreamMode,
  });
};

const handleAppError = (
  error: unknown,
  runtime: string,
  res: express.Response,
  protocol: RequestProtocol,
): void => {
  if (error instanceof DownstreamNotConfiguredError) {
    logger.warn({
      event: "mux.downstream_not_configured",
      protocol,
      runtime,
      message: error.message,
    });

    res.status(503).json({
      error: {
        type: "service_unavailable",
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof DownstreamRequestError) {
    logger.error({
      event: "mux.downstream_error",
      protocol,
      runtime,
      status: error.status,
      payload: error.payload,
    });

    res.status(502).json({
      error: {
        type: "downstream_error",
        message: "Downstream request failed",
        status: error.status,
        details: error.payload,
      },
    });
    return;
  }

  logger.error({
    event: "mux.unhandled_error",
    protocol,
    runtime,
    err: error,
  });

  res.status(500).json({
    error: {
      type: "internal_error",
      message: "Unexpected server error",
    },
  });
};

export const createApp = () => {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "mux", env: config.nodeEnv });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const body = req.body as ChatCompletionsRequest;

    if (!body?.model || !Array.isArray(body?.messages)) {
      return res.status(400).json({
        error: {
          message: "Invalid payload: model and messages[] are required",
          type: "invalid_request_error",
        },
      });
    }

    await withTracedRequest("mux", async () => {
      const runtime = extractRuntime(body, req);
      const routedBody: ChatCompletionsRequest = { ...body, runtime, protocol: "chat_completions" };
      const route = resolveRoute(routedBody);
      const callerAgentId = req.header("x-agentweave-agent-id") ?? undefined;
      const promptPreview = buildPromptPreviewForChat(body.messages);

      logRouteDecision({
        protocol: "chat_completions",
        runtime,
        route,
        callerAgentId,
        promptPreview,
        messageCount: body.messages.length,
      });

      try {
        const downstreamContext = buildDownstreamContext(req);
        if (routedBody.stream) {
          await streamDownstream(routedBody, route, res, downstreamContext);
          return;
        }

        const downstream = await callDownstream(routedBody, route, downstreamContext);
        res.status(200).json(downstream);
      } catch (error) {
        handleAppError(error, runtime, res, "chat_completions");
      }
    });
  });

  app.post("/v1/responses", async (req, res) => {
    const body = req.body as ResponsesRequest;

    if (!body?.model) {
      return res.status(400).json({
        error: {
          message: "Invalid payload: model is required",
          type: "invalid_request_error",
        },
      });
    }

    await withTracedRequest("mux", async () => {
      const runtime = extractRuntime(body, req);
      const routedBody: ResponsesRequest = { ...body, runtime };
      // Synthetic ChatCompletionsRequest used only for routing/policy
      // decisions. Not forwarded downstream — the responses adapter sends
      // `routedBody` (the original ResponsesRequest) verbatim.
      const routingRequest: ChatCompletionsRequest = {
        model: body.model,
        messages: normalizeResponsesInputToMessages(body.input),
        stream: body.stream,
        runtime,
        protocol: "responses",
      };
      const route = resolveRoute(routingRequest);
      const callerAgentId = req.header("x-agentweave-agent-id") ?? undefined;
      const inputItems = body.input == null ? 0 : Array.isArray(body.input) ? body.input.length : 1;
      const promptPreview = buildPromptPreviewForResponses(body.input);

      logRouteDecision({
        protocol: "responses",
        runtime,
        route,
        callerAgentId,
        promptPreview,
        inputItemCount: inputItems,
      });

      try {
        const downstreamContext = buildDownstreamContext(req);
        if (routedBody.stream) {
          await streamResponsesDownstream(routedBody, route, res, downstreamContext);
          return;
        }

        const downstream = await callResponsesDownstream(routedBody, route, downstreamContext);
        res.status(200).json(downstream);
      } catch (error) {
        handleAppError(error, runtime, res, "responses");
      }
    });
  });

  return app;
};
