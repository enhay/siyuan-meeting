"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function aiConfig() {
  return window.siyuan?.config?.ai || null;
}

/**
 * Resolve the same model SiYuan uses for editor AI. Meeting summaries follow the
 * user's existing AI configuration instead of introducing a second provider list.
 */
function getEditingModel() {
  const ai = aiConfig();
  if (!ai || !Array.isArray(ai.providers)) return null;
  const editing = ai.editing?.modelId ? ai.editing : ai.agent || {};
  const modelId = String(editing.modelId || "").trim();
  if (!modelId) return null;

  for (const provider of ai.providers) {
    if (!provider || provider.enabled === false) continue;
    const model = (provider.models || []).find(
      (item) => item && item.enabled !== false && (item.id === modelId || item.name === modelId),
    );
    if (model) {
      return { provider, model, editing, ai };
    }
  }
  return null;
}

function isConfigured() {
  return Boolean(getEditingModel());
}

function joinEndpoint(baseURL, protocol) {
  const base = String(baseURL || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("AI 服务地址为空");
  const kind = String(protocol || "").toLowerCase();
  if (kind.includes("anthropic")) {
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  if (kind.includes("responses")) {
    return /\/v1$/i.test(base) ? `${base}/responses` : `${base}/v1/responses`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function requestHeaders(provider, protocol) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "SiYuan-Meeting/0.1.0",
    ...(provider.headers || {}),
  };
  const kind = String(protocol || "").toLowerCase();
  if (kind.includes("anthropic")) {
    headers["anthropic-version"] = "2023-06-01";
    if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function buildPayload({ provider, model, editing }, system, user, protocol) {
  const kind = String(protocol || "").toLowerCase();
  const modelName = model.name || model.id;
  const temperature = Number.isFinite(Number(editing.temperature)) ? Number(editing.temperature) : 0.3;
  const maxTokens = Number(editing.maxCompletionTokens) || 0;

  if (kind.includes("anthropic")) {
    return {
      model: modelName,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: maxTokens || 8192,
      temperature,
      stream: true,
    };
  }
  if (kind.includes("responses")) {
    return {
      model: modelName,
      instructions: system,
      input: user,
      temperature,
      ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
      stream: true,
    };
  }
  return {
    model: modelName,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream: true,
  };
}

function textFromOpenAIJson(data) {
  return data?.choices?.[0]?.message?.content || "";
}

function textFromAnthropicJson(data) {
  return (data?.content || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function textFromResponsesJson(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  return (data?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((block) => block?.type === "output_text")
    .map((block) => block.text)
    .join("");
}

/**
 * Make a streaming chat request with Node's http stack. The SiYuan renderer is
 * an http origin; Node avoids browser CORS while keeping provider credentials
 * inside the local process.
 */
function requestStream(urlString, headers, payload, { signal, onDelta } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const body = JSON.stringify(payload);
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 120000,
      },
      (response) => {
        const status = response.statusCode || 0;
        const contentType = String(response.headers["content-type"] || "");
        let buffer = "";
        let full = "";
        let truncated = false;
        const finish = () => {
          if (truncated) {
            const note =
              "\n\n> 注意：模型输出达到长度上限，纪要可能不完整。请重新生成，或只用笔记/选择部分录音段。";
            full += note;
            onDelta?.(note, full);
          }
          return full;
        };

        if (status < 200 || status >= 300) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let message = raw.slice(0, 1200);
            try {
              const parsed = JSON.parse(raw);
              message = parsed?.error?.message || parsed?.message || message;
            } catch {
              // keep the raw body
            }
            reject(new Error(`AI 请求失败（${status}）：${message}`));
          });
          response.on("error", reject);
          return;
        }

        const emit = (text) => {
          if (!text) return;
          full += text;
          onDelta?.(text, full);
        };

        if (contentType.includes("application/json")) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const text =
                textFromOpenAIJson(data) || textFromAnthropicJson(data) || textFromResponsesJson(data);
              truncated =
                data?.choices?.[0]?.finish_reason === "length" ||
                data?.stop_reason === "max_tokens" ||
                data?.status === "incomplete";
              emit(text);
              resolve(finish());
            } catch (error) {
              reject(new Error(`AI 返回内容无法解析：${error.message}`));
            }
          });
          response.on("error", reject);
          return;
        }

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line || !line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              emit(event.delta.text);
            } else if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") {
              truncated = true;
            } else if (event.type === "response.output_text.delta") {
              emit(event.delta);
            } else if (event.type === "response.completed" || event.type === "response.incomplete") {
              if (!full && event.response) emit(textFromResponsesJson(event.response));
              if (event.response?.status === "incomplete") truncated = true;
            } else {
              const choice = event.choices?.[0];
              if (choice?.finish_reason === "length") truncated = true;
              const text = choice?.delta?.content;
              if (typeof text === "string") emit(text);
            }
          }
        });
        response.on("end", () => resolve(finish()));
        response.on("error", reject);
      },
    );

    const abort = () => request.destroy(new Error("已取消生成"));
    signal?.addEventListener("abort", abort, { once: true });
    request.on("timeout", () => request.destroy(new Error("AI 请求超时")));
    request.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    request.on("close", () => signal?.removeEventListener("abort", abort));
    request.write(body);
    request.end();
  });
}

async function kernelCompletion(system, user, { signal, onDelta } = {}) {
  if (signal?.aborted) throw new Error("已取消生成");
  const send = async (msg) => {
    const response = await fetch("/api/ai/chatGPT", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg }),
      signal,
    });
    if (!response.ok) throw new Error(`AI 请求失败（${response.status}）`);
    const data = await response.json();
    if (data.code !== 0) throw new Error(data.msg || "AI 请求失败");
    return String(data.data || "");
  };
  // The kernel's editor endpoint keeps a conversation cache. Clear it so a
  // meeting summary cannot inherit an unrelated editor conversation.
  try {
    await send("Clear context");
  } catch {
    // A clear failure should not hide the real request error.
  }
  const text = await send(`${system}\n\n${user}`);
  if (!text.trim()) throw new Error("AI 没有返回内容，请检查思源 AI 配置");
  onDelta?.(text, text);
  return text;
}

/**
 * Stream a summary. Returns the complete text. Callers are responsible for
 * persisting the result only after this promise resolves.
 */
async function streamSummary({ system, user, signal, onDelta }) {
  const resolved = getEditingModel();
  if (!resolved) throw new Error("尚未配置 AI：请在思源设置中配置 AI 模型");
  const { provider, editing } = resolved;
  const protocol = String(provider.protocol || "").toLowerCase();
  const authType = String(provider.authType || "").toLowerCase();

  const supportedProtocol =
    !protocol ||
    protocol.includes("anthropic") ||
    protocol.includes("responses") ||
    protocol.includes("openai") ||
    protocol.includes("chat-completions");
  if (authType === "chatgpt" || !supportedProtocol) {
    return kernelCompletion(system, user, { signal, onDelta });
  }

  const endpoint = joinEndpoint(provider.baseURL, protocol);
  const headers = requestHeaders(provider, protocol);
  const payload = buildPayload(resolved, system, user, protocol);
  const text = await requestStream(endpoint, headers, payload, { signal, onDelta });
  if (!text.trim()) throw new Error("AI 没有返回内容");
  return text;
}

module.exports = {
  aiConfig,
  getEditingModel,
  isConfigured,
  streamSummary,
  joinEndpoint,
  buildPayload,
};
