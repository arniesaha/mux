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

type StreamToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function streamChatCompletion(res: express.Response, completion: {
  id: string;
  created: number;
  model: string;
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: StreamToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}) {
  const msg = completion.choices?.[0]?.message;
  const text = typeof msg?.content === "string" ? msg.content : "";
  const toolCalls = msg?.tool_calls;
  const finishReason = completion.choices?.[0]?.finish_reason ?? "stop";

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const writeChunk = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Emit one delta chunk containing both content and tool_calls. OpenAI
  // stream consumers read tool_calls off the delta and accumulate them — a
  // single chunk with the full shape is accepted by pi-ai and friends.
  const delta: Record<string, unknown> = {
    role: "assistant",
  };
  if (text.length > 0) {
    delta.content = text;
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    delta.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: tc.type,
      function: tc.function,
    }));
  }

  writeChunk({
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
      },
    ],
  });

  // Emit final stop chunk.
  writeChunk({
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  });

  if (completion.usage) {
    writeChunk({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [],
      usage: completion.usage,
    });
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

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
        const downstreamContext: DownstreamRequestContext = {
          incomingAuthorizationHeader: req.header("authorization") ?? undefined,
        };

        if (routedBody.stream && config.downstreamMode === "anthropic-sdk") {
          await streamDownstream(routedBody, route, res);
          return;
        }

        const downstream = await callDownstream(routedBody, route, downstreamContext);

        if (routedBody.stream) {
          streamChatCompletion(res, downstream);
          return;
        }

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
