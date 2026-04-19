import express from "express";
import pino from "pino";

import { config } from "./config.js";
import {
  callDownstream,
  DownstreamNotConfiguredError,
  DownstreamRequestError,
  streamDownstream,
  type DownstreamRequestContext,
} from "./downstream.js";
import { resolveRoute } from "./policy.js";
import { withTracedRequest, setSpanAttrs } from "./tracing.js";
import type { ChatCompletionsRequest } from "./types.js";

const logger = pino({
  level: config.nodeEnv === "development" ? "debug" : "info",
});

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
      const runtime = body.runtime || req.header("x-runtime") || "unknown";
      const routedBody: ChatCompletionsRequest = { ...body, runtime };
      const route = resolveRoute(routedBody);

      // Extract a short prompt preview from the last user message for tracing
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === "user");
      const promptPreview = typeof lastUserMsg?.content === "string"
        ? lastUserMsg.content.slice(0, 200)
        : Array.isArray(lastUserMsg?.content)
          ? (lastUserMsg.content.find((b: any) => b.type === "text") as any)?.text?.slice(0, 200) ?? ""
          : "";

      setSpanAttrs({
        "prov.route.requested_model": route.requestedModel,
        "prov.route.resolved_model": route.resolvedModel,
        "prov.route.reason": route.routeReason,
        "prov.route.runtime": runtime,
        "prov.llm.prompt_preview": promptPreview,
        "prov.route.message_count": body.messages.length,
      });

      logger.info({
        event: "mux.route_decision",
        runtime,
        requestedModel: route.requestedModel,
        resolvedModel: route.resolvedModel,
        routeReason: route.routeReason,
        provider: route.provider,
        backendTarget: route.backendTarget,
        downstreamMode: config.downstreamMode,
      });

      try {
        // Forward any X-AgentWeave-* headers from the caller so the proxy
        // can attribute the call to the original agent/session.
        const agentweaveHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string" && key.startsWith("x-agentweave-")) {
            agentweaveHeaders[key] = value;
          }
        }

        const downstreamContext: DownstreamRequestContext = {
          incomingAuthorizationHeader: req.header("authorization") ?? undefined,
          agentweaveHeaders,
        };

        if (routedBody.stream) {
          await streamDownstream(routedBody, route, res, downstreamContext);
          return;
        }

        const downstream = await callDownstream(routedBody, route, downstreamContext);

        res.status(200).json(downstream);
      } catch (error) {
        if (error instanceof DownstreamNotConfiguredError) {
          logger.warn({
            event: "mux.downstream_not_configured",
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
          runtime,
          err: error,
        });

        res.status(500).json({
          error: {
            type: "internal_error",
            message: "Unexpected server error",
          },
        });
      }
    });
  });

  return app;
};
