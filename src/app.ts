import express from "express";
import pino from "pino";

import { config } from "./config.js";
import { callDownstream } from "./downstream.js";
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
    });

    const downstream = await callDownstream(body, route);
    return res.status(200).json(downstream);
  });

  return app;
};
