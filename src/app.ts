import express from "express";
import pino from "pino";

import { config } from "./config.js";
import {
  callDownstream,
  DownstreamNotConfiguredError,
  DownstreamRequestError,
  type DownstreamRequestContext,
} from "./downstream.js";
import { resolveRoute } from "./policy.js";
import type { ChatCompletionsRequest } from "./types.js";

const logger = pino({
  level: config.nodeEnv === "development" ? "debug" : "info",
});

export const createApp = () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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

    const runtime = body.runtime || req.header("x-runtime") || "unknown";
    const route = resolveRoute(body);

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
      const downstreamContext: DownstreamRequestContext = {
        incomingAuthorizationHeader: req.header("authorization") ?? undefined,
      };

      const downstream = await callDownstream(body, route, downstreamContext);
      return res.status(200).json(downstream);
    } catch (error) {
      if (error instanceof DownstreamNotConfiguredError) {
        logger.warn({
          event: "mux.downstream_not_configured",
          runtime,
          message: error.message,
        });

        return res.status(503).json({
          error: {
            type: "service_unavailable",
            message: error.message,
          },
        });
      }

      if (error instanceof DownstreamRequestError) {
        logger.error({
          event: "mux.downstream_error",
          runtime,
          status: error.status,
          payload: error.payload,
        });

        return res.status(502).json({
          error: {
            type: "downstream_error",
            message: "Downstream request failed",
            status: error.status,
            details: error.payload,
          },
        });
      }

      logger.error({
        event: "mux.unhandled_error",
        runtime,
        err: error,
      });

      return res.status(500).json({
        error: {
          type: "internal_error",
          message: "Unexpected server error",
        },
      });
    }
  });

  return app;
};
