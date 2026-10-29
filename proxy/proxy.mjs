#!/usr/bin/env node
/**
 * Command Code -> OpenAI-compatible proxy (for OpenCode)
 *
 * Why this exists: Command Code's $1 "Go" plan is blocked from the official
 * /provider/v1 endpoints, but the internal /alpha/generate endpoint (what their
 * own CLI uses) is not plan-gated. That endpoint speaks a custom envelope and
 * returns newline-delimited JSON, so it needs translating.
 *
 * Differences from the stock proxies:
 *   - forwards `reasoning-delta` events as OpenAI `reasoning_content`
 *     (stock proxies drop them, so you never see the model think)
 *   - keeps a stable tool-call index across a response (stock ones reset it)
 *   - reports `environment: "linux"` instead of "windows"
 *   - pins `x-command-code-version` to the installed CLI, not a stale constant
 *   - emits usage in the final stream chunk
 *
 * Env:
 *   PORT                     default 55990
 *   COMMAND_CODE_VERSION     default: auto-detect (npm registry, then `cmd --version`)
 *   COMMAND_CODE_TOKEN       optional fallback when the client sends no Authorization
 *   COMMAND_CODE_TOKEN_FILE  default /root/cc-proxy/token
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 55990);
const HOST_UPSTREAM = "api.commandcode.ai";
const UPSTREAM_PATH = "/alpha/generate";
const TOKEN_FILE = process.env.COMMAND_CODE_TOKEN_FILE || "/root/cc-proxy/token";

/* ---------------------------------------------------------------- version -- */

function detectVersion() {
  if (process.env.COMMAND_CODE_VERSION) return process.env.COMMAND_CODE_VERSION;
  try {
    const v = execFileSync("npm", ["view", "command-code", "version"], {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {}
  try {
    const v = execFileSync("cmd", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const m = v.match(/\d+\.\d+\.\d+/);
    if (m) return m[0];
  } catch {}
  return "1.88.0";
}

const CC_VERSION = detectVersion();
const agent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 600_000 });

/* ------------------------------------------------------------------ utils -- */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function log(...a) {
  process.stdout.write(`[${new Date().toISOString()}] ${a.join(" ")}\n`);
}

function readFallbackToken() {
  if (process.env.COMMAND_CODE_TOKEN) return process.env.COMMAND_CODE_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const textOf = (c) => {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(textOf).join("");
  if (typeof c === "object") {
    for (const k of ["text", "content", "output_text", "input_text", "refusal"]) {
      if (typeof c[k] === "string") return c[k];
    }
  }
  return "";
};

/* ------------------------------------------------ OpenAI -> Command Code -- */

function toModelMessages(messages) {
  const toolNames = new Map();
  for (const m of messages) {
    for (const tc of m.tool_calls || []) {
      if (tc.id && tc.function?.name) toolNames.set(tc.id, tc.function.name);
    }
  }

  const out = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;

    if (m.role === "tool") {
      const value = textOf(m.content);
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id,
            toolName: toolNames.get(m.tool_call_id) || m.name || "unknown",
            output: {
              type: value.startsWith("Error:") ? "error-text" : "text",
              value,
            },
          },
        ],
      });
      continue;
    }

    const parts = [];
    // Command Code requires the model's own reasoning to be echoed back on every
    // prior assistant message. Drop it and the next turn fails with:
    //   Missing required parameter: 'messages[N].reasoning_content'
    const reasoning = m.reasoning_content ?? m.reasoning ?? m.reasoning_text;
    if (m.role === "assistant" && typeof reasoning === "string") {
      parts.push({ type: "reasoning", text: reasoning });
    }

    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const txt = textOf(m.content);
      if (txt) parts.push({ type: "text", text: txt });
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = { arguments: tc.function?.arguments || "" };
        }
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function?.name,
          input,
        });
      }
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
          parts.push({ type: "text", text: p.text ?? "" });
        } else if (p.type === "image_url") {
          const url = p.image_url?.url || p.image_url;
          if (typeof url === "string" && url.startsWith("data:")) {
            const [meta, b64] = url.split(",");
            parts.push({
              type: "image",
              image: b64,
              mediaType: meta.slice(5).split(";")[0] || "image/png",
            });
          }
        }
      }
      if (parts.length === 0) parts.push({ type: "text", text: "" });
    } else {
      parts.push({ type: "text", text: textOf(m.content) });
    }

    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: parts });
  }
  return out;
}

function buildEnvelope(body) {
  const messages = body.messages || [];
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map(textOf)
    .filter(Boolean)
    .join("\n\n");

  const tools = (body.tools || [])
    .map((t) => {
      const fn = t.function || t;
      if (!fn?.name) return null;
      return {
        name: fn.name,
        description: fn.description || "",
        input_schema: fn.parameters || { type: "object", properties: {} },
      };
    })
    .filter(Boolean);

  const params = {
    model: body.model,
    messages: toModelMessages(messages),
    stream: true, // upstream rejects stream:false
  };
  if (system) params.system = system;
  if (tools.length) params.tools = tools;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens) params.max_tokens = maxTokens;
  if (typeof body.temperature === "number") params.temperature = body.temperature;

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: "linux",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "main",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "standard",
    params,
  };
}

/* ------------------------------------------------------------ translation -- */

function makeEmitter(res, model) {
  const id = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  const toolIndex = new Map(); // command-code tool id -> OpenAI index
  const seenToolCall = new Set();

  const chunk = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const write = (obj) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS,
      });
    }
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const ensureRole = () => {
    if (roleSent) return;
    roleSent = true;
    write(chunk({ role: "assistant", content: "" }));
  };

  return {
    id,
    created,
    ensureRole,
    write,
    chunk,
    toolIndex,
    seenToolCall,
    /** returns next stable index for a tool id */
    indexFor(tid) {
      if (!toolIndex.has(tid)) toolIndex.set(tid, toolIndex.size);
      return toolIndex.get(tid);
    },
  };
}

function translateStream(upstream, res, model) {
  const em = makeEmitter(res, model);
  let buf = "";
  let finishReason = null;
  let usage = null;
  let sawError = null;
  let reasoningChars = 0;
  let textChars = 0;
  let toolCount = 0;
  const t0 = Date.now();

  const handle = (evt) => {
    switch (evt.type) {
      case "reasoning-start":
        em.ensureRole();
        break;

      case "reasoning-delta":
        if (!evt.text) break;
        reasoningChars += evt.text.length;
        em.write(em.chunk({ reasoning_content: evt.text }));
        break;

      case "reasoning-end":
        break;

      case "text-start":
        em.ensureRole();
        break;

      case "text-delta":
        if (!evt.text) break;
        textChars += evt.text.length;
        em.ensureRole();
        em.write(em.chunk({ content: evt.text }));
        break;

      case "text-end":
        break;

      case "tool-input-start": {
        em.ensureRole();
        const idx = em.indexFor(evt.id);
        toolCount = Math.max(toolCount, idx + 1);
        em.write(
          em.chunk({
            tool_calls: [
              {
                index: idx,
                id: evt.id,
                type: "function",
                function: { name: evt.toolName, arguments: "" },
              },
            ],
          }),
        );
        break;
      }

      case "tool-input-delta": {
        const idx = em.indexFor(evt.id);
        em.write(
          em.chunk({
            tool_calls: [{ index: idx, function: { arguments: evt.delta || "" } }],
          }),
        );
        break;
      }

      case "tool-input-end":
        break;

      case "tool-call": {
        const tid = evt.toolCallId ?? evt.id;
        // the streaming tool-input-* events already emitted this call
        if (em.toolIndex.has(tid)) {
          em.seenToolCall.add(tid);
          break;
        }
        const idx = em.indexFor(tid);
        toolCount = Math.max(toolCount, idx + 1);
        em.ensureRole();
        em.write(
          em.chunk({
            tool_calls: [
              {
                index: idx,
                id: tid,
                type: "function",
                function: {
                  name: evt.toolName,
                  arguments: JSON.stringify(evt.input ?? {}),
                },
              },
            ],
          }),
        );
        break;
      }

      case "finish-step":
        usage = evt.usage || usage;
        finishReason = evt.finishReason || finishReason;
        break;

      case "finish":
        usage = evt.totalUsage || usage;
        finishReason = evt.finishReason || finishReason;
        break;

      case "error":
        sawError =
          evt.error?.message || (typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error));
        break;
    }
  };

  upstream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  });

  upstream.on("end", () => {
    if (buf.trim()) {
      try {
        handle(JSON.parse(buf.trim()));
      } catch {}
    }

    if (sawError) {
      em.write({
        error: { message: sawError, type: "upstream_error" },
      });
      res.write("data: [DONE]\n\n");
      res.end();
      log(`[error] ${model} | ${sawError}`);
      return;
    }

    const reason =
      toolCount > 0 || /tool/i.test(finishReason || "") ? "tool_calls" : "stop";

    em.write(em.chunk({}, reason));

    if (usage) {
      em.write({
        id: em.id,
        object: "chat.completion.chunk",
        created: em.created,
        model,
        choices: [],
        usage: {
          prompt_tokens: usage.inputTokens ?? usage.prompt_tokens ?? 0,
          completion_tokens: usage.outputTokens ?? usage.completion_tokens ?? 0,
          total_tokens:
            usage.totalTokens ??
            (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          prompt_tokens_details: {
            cached_tokens: usage.cachedInputTokens ?? 0,
          },
          completion_tokens_details: {
            reasoning_tokens:
              usage.reasoningTokens ??
              usage.outputTokenDetails?.reasoningTokens ??
              0,
          },
        },
      });
    }

    res.write("data: [DONE]\n\n");
    res.end();
    log(
      `[done] ${model} | ${textChars} text / ${reasoningChars} reasoning / ${toolCount} tools | ${reason} | ${Date.now() - t0}ms`,
    );
  });

  upstream.on("error", (err) => {
    log(`[error] ${model} | stream: ${err.message}`);
    if (!res.writableEnded) res.end();
  });
}

function collectStream(upstream, res, model) {
  let buf = "";
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  const byId = new Map();
  let usage = null;
  let finishReason = null;
  let error = null;
  const created = Math.floor(Date.now() / 1000);
  const id = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);

  const handle = (evt) => {
    switch (evt.type) {
      case "reasoning-delta":
        reasoning += evt.text || "";
        break;
      case "text-delta":
        content += evt.text || "";
        break;
      case "tool-input-start": {
        const tc = { id: evt.id, type: "function", function: { name: evt.toolName, arguments: "" } };
        byId.set(evt.id, tc);
        toolCalls.push(tc);
        break;
      }
      case "tool-input-delta": {
        const tc = byId.get(evt.id);
        if (tc) tc.function.arguments += evt.delta || "";
        break;
      }
      case "tool-call": {
        const tid = evt.toolCallId ?? evt.id;
        if (byId.has(tid)) break;
        const tc = {
          id: tid,
          type: "function",
          function: { name: evt.toolName, arguments: JSON.stringify(evt.input ?? {}) },
        };
        byId.set(tid, tc);
        toolCalls.push(tc);
        break;
      }
      case "finish-step":
        usage = evt.usage || usage;
        finishReason = evt.finishReason || finishReason;
        break;
      case "finish":
        usage = evt.totalUsage || usage;
        finishReason = evt.finishReason || finishReason;
        break;
      case "error":
        error =
          evt.error?.message || (typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error));
        break;
    }
  };

  upstream.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {}
    }
  });

  upstream.on("end", () => {
    if (buf.trim()) {
      try {
        handle(JSON.parse(buf.trim()));
      } catch {}
    }
    if (error) {
      res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error, type: "upstream_error" } }));
      return;
    }

    const message = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) {
      message.tool_calls = toolCalls;
      if (!content) message.content = null;
    }

    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
          },
        ],
        usage: usage
          ? {
              prompt_tokens: usage.inputTokens ?? 0,
              completion_tokens: usage.outputTokens ?? 0,
              total_tokens: usage.totalTokens ?? 0,
              prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
              completion_tokens_details: {
                reasoning_tokens:
                  usage.reasoningTokens ??
                  usage.outputTokenDetails?.reasoningTokens ??
                  0,
              },
            }
          : undefined,
      }),
    );
  });

  upstream.on("error", (err) => {
    if (!res.writableEnded) {
      res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message, type: "upstream_error" } }));
    }
  });
}

/* ----------------------------------------------------------------- models -- */

const MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-pro",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K3",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.3",
  "Qwen/Qwen3.8-Max",
  "MiniMaxAI/MiniMax-M3",
  "stepfun/Step-3.7-Flash",
  "stepfun/Step-5-Preview",
  "xai/grok-4.5",
  "gpt-5.6-luna",
  "tencent/hy3-paid",
  "tencent/hy4-preview",
  "thinkingmachines/inkling",
  "nvidia/nemotron-3-ultra-550b-a55b",
  // free on every plan — cost 0 credits
  "reflection/beam:free",
  "stealth/glyph-cluster:free",
  "poolside/laguna-s-2.1-free",
];

/* ----------------------------------------------------------------- server -- */

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", version: CC_VERSION }));
  }

  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        object: "list",
        data: MODELS.map((m) => ({ id: m, object: "model", owned_by: "command-code" })),
      }),
    );
  }

  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "POST /v1/chat/completions" }));
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 32 * 1024 * 1024) req.destroy();
  });

  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
    }

    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const fileToken = readFallbackToken();
    // Prefer the token file: clients (OpenCode) cache the apiKey at startup, so a
    // stale client header would silently keep using a revoked key.
    const token = fileToken || auth;
    log(
      `[auth] source=${fileToken ? "file" : "client"} client=${!auth ? "none" : auth === token ? "ok" : "differs"}`,
    );
    if (!token) {
      res.writeHead(401, { ...CORS, "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: { message: "no Command Code key (Authorization header or token file)" },
        }),
      );
    }

    const model = body.model || "deepseek/deepseek-v4.1-flash";
    const wantStream = body.stream === true;
    const includeUsage = body.stream_options?.include_usage !== false;

    let payload;
    try {
      payload = JSON.stringify(buildEnvelope(body));
    } catch (err) {
      res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `translate: ${err.message}` } }));
    }

    const t0 = Date.now();
    log(`[req] ${model} | ${wantStream ? "stream" : "sync"} | ${raw.length}B`);

    const up = https.request(
      {
        hostname: HOST_UPSTREAM,
        path: UPSTREAM_PATH,
        method: "POST",
        agent,
        timeout: 600_000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
          "x-command-code-version": CC_VERSION,
          "x-cli-environment": "production",
          "x-session-id": randomUUID(),
          Accept: "text/event-stream",
        },
      },
      (upRes) => {
        if (upRes.statusCode >= 400) {
          let errBody = "";
          upRes.on("data", (c) => (errBody += c));
          upRes.on("end", () => {
            log(`[upstream] ${upRes.statusCode} | ${model}`);
            res.writeHead(upRes.statusCode, { ...CORS, "Content-Type": "application/json" });
            res.end(errBody || JSON.stringify({ error: { message: "upstream error" } }));
          });
          return;
        }
        log(`[upstream] ${upRes.statusCode} OK | ${model} | ${Date.now() - t0}ms`);
        if (wantStream) translateStream(upRes, res, model);
        else collectStream(upRes, res, model);
      },
    );

    up.on("timeout", () => {
      up.destroy(new Error("upstream timeout"));
    });

    up.on("error", (err) => {
      log(`[error] ${model} | ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "upstream_error" } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    up.write(payload);
    up.end();
  });
});

server.timeout = 0;
server.keepAliveTimeout = 120_000;
server.listen(PORT, "127.0.0.1", () => {
  log(`Command Code proxy listening on http://127.0.0.1:${PORT}`);
  log(`upstream: https://${HOST_UPSTREAM}${UPSTREAM_PATH} | x-command-code-version: ${CC_VERSION}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} - shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
