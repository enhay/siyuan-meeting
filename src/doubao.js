"use strict";

const crypto = require("node:crypto");
const https = require("node:https");
const { isUploadableWav } = require("./wav");

const HOST = "openspeech.bytedance.com";
// https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket
// The key travels only in request headers, which the main window adds to the
// capture window's connection.
const REALTIME_URL = `wss://${HOST}/api/v3/sauc/bigmodel_async`;
const REALTIME_RESOURCE = "volc.seedasr.sauc.duration";
// https://www.volcengine.com/docs/6561/1631584
const FLASH_PATH = "/api/v3/auc/bigmodel/recognize/flash";
const FLASH_RESOURCE = "volc.bigasr.auc_turbo";

function isConfigured(config) {
  const apiKey = config?.apiKey;
  return typeof apiKey === "string" && /^[\x21-\x7e]+$/.test(apiKey.trim());
}

function requireConfig(config) {
  if (!isConfigured(config)) {
    const message = "请先在会议设置中填写豆包 API Key";
    throw Object.assign(new Error(message), { code: "INVALID_CONFIGURATION", userMessage: message });
  }
}

function realtimeHeaders(config) {
  requireConfig(config);
  return {
    "X-Api-Key": config.apiKey.trim(),
    "X-Api-Resource-Id": REALTIME_RESOURCE,
    "X-Api-Request-Id": crypto.randomUUID(),
    "X-Api-Connect-Id": crypto.randomUUID(),
  };
}

function serviceError(code, requestId = "") {
  const messages = {
    45000001: "豆包无法处理这次转写，请稍后手动重试",
    45000002: "这次提交的录音没有内容，请检查录音后重试",
    45000010: "豆包验证未通过，请检查会议设置中的 API Key",
    45000030: "豆包录音文件极速版尚未开通，请在火山引擎控制台开通后重试",
    45000151: "豆包无法读取这段录音，请检查录音能否正常播放后重试",
    45000292: "豆包转写额度不足，请补充额度后重试",
    55000031: "豆包当前繁忙，请稍后手动重试",
  };
  const error = new Error(messages[Number(code)] || "豆包暂时未能完成转写，请稍后手动重试");
  error.userMessage = error.message;
  error.serviceCode = Number(code) || 0;
  error.requestId = String(requestId || "");
  return error;
}

function responseError(responseIssue) {
  const message = "豆包返回的转写不完整，请稍后手动重试";
  return Object.assign(new Error(message), { code: "INVALID_RESPONSE", responseIssue, userMessage: message });
}

// The service omits zero-valued fields, so a missing start time means 0.
function parseFlashResult(result, channels = 1) {
  const utterances = result?.result?.utterances ?? [];
  if (!Array.isArray(utterances)) throw responseError("missing-result");
  const sentences = [];
  for (const utterance of utterances) {
    if (typeof utterance?.text !== "string") throw responseError("invalid-sentence");
    const text = utterance.text.trim();
    if (!text) continue;
    const startMs = Number(utterance.start_time ?? 0);
    const endMs = Number(utterance.end_time);
    const speaker = Number(utterance.additions?.speaker_id ?? 0);
    const channelId = Number(utterance.channel_id ?? utterance.additions?.channel_id ?? 1);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs ||
        !Number.isInteger(speaker) || speaker < 0 || !Number.isInteger(channelId) ||
        channelId < 1 || channelId > channels) {
      throw responseError("invalid-timestamp");
    }
    sentences.push({ startMs, endMs, speaker, channel: channelId - 1, text });
  }
  const others = new Set(sentences.filter((sentence) => sentence.channel === 1).map((sentence) => sentence.speaker));
  return sentences.map((sentence) => ({
    ...sentence,
    speakerLabel: channels === 2
      ? sentence.channel === 0 ? "我" : `其他参会者${others.size > 1 ? ` ${sentence.speaker + 1}` : ""}`
      : `说话人 ${sentence.speaker + 1}`,
  })).sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
}

function aborted() {
  const error = new Error("已取消转写");
  error.name = "AbortError";
  return error;
}

async function flashRecognize(config) {
  requireConfig(config);
  const { data, signal } = config;
  const channels = Number(config.channels);
  const sampleRate = Number(config.sampleRate);
  if (!isUploadableWav(data, channels, sampleRate)) {
    const message = "这段录音无法直接转写，请检查录音后重试";
    throw Object.assign(new Error(message), { code: "INVALID_AUDIO", userMessage: message });
  }
  if (signal?.aborted) throw aborted();
  // The audio is streamed as base64 inside the JSON body so a 100 MB part never
  // exists twice in memory as a string.
  const prefix = Buffer.from('{"user":{"uid":"siyuan-meeting"},"audio":{"format":"wav","data":"');
  const suffix = Buffer.from(`"},"request":${JSON.stringify({
    model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: true,
    enable_speaker_info: true, ...(channels === 2 ? { enable_channel_split: true } : {}),
  })}}`);
  const encodedBytes = Math.ceil(data.length / 3) * 4;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      request?.destroy();
      finish(aborted());
    };
    request = https.request({
      hostname: HOST, path: FLASH_PATH, method: "POST",
      headers: {
        "Content-Type": "application/json", "Content-Length": prefix.length + encodedBytes + suffix.length,
        "X-Api-Key": config.apiKey.trim(), "X-Api-Resource-Id": FLASH_RESOURCE,
        "X-Api-Request-Id": crypto.randomUUID(), "X-Api-Sequence": "-1",
      },
      // A synchronous upload can take minutes on a meeting participant's connection.
      // Stop a stalled connection without resubmitting a billable request.
      timeout: 10 * 60 * 1000,
    }, (response) => {
      const chunks = [];
      let received = 0;
      const status = Number(response.headers["x-api-status-code"]);
      const requestId = response.headers["x-tt-logid"] || "";
      response.on("data", (chunk) => {
        received += chunk.length;
        // Bound untrusted response data independently of the audio upload size.
        if (received > 16 * 1024 * 1024) {
          finish(new Error("豆包返回的转写无法处理，请稍后手动重试"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      const responseFailure = (code) => {
        const message = "转写连接已断开，请检查网络后手动重试";
        finish(Object.assign(new Error(message), { code, userMessage: message, httpStatus: response.statusCode, responseBytes: received }));
      };
      response.on("aborted", () => responseFailure("ECONNRESET"));
      response.on("error", (cause) => responseFailure(cause.code));
      response.on("end", () => {
        try {
          if (status === 20000003) {
            finish(null, []);
            return;
          }
          if (status !== 20000000) throw serviceError(status, requestId);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw Object.assign(new Error("豆包暂时未能完成转写，请稍后手动重试"), { responseIssue: "http-error" });
          }
          finish(null, parseFlashResult(JSON.parse(Buffer.concat(chunks).toString("utf8")), channels));
        } catch (error) {
          const failure = error instanceof SyntaxError ? responseError("invalid-json") : error;
          failure.httpStatus = response.statusCode;
          failure.responseBytes = received;
          failure.requestId ||= String(requestId);
          finish(failure);
        }
      });
    });
    request.on("timeout", () => {
      const message = "转写等待时间过长，请检查网络后手动重试";
      finish(Object.assign(new Error(message), { code: "ETIMEDOUT", userMessage: message }));
      request.destroy();
    });
    request.on("error", (cause) => {
      const message = "转写连接未完成，请检查网络后手动重试";
      finish(signal?.aborted ? aborted() : Object.assign(new Error(message), { code: cause.code, userMessage: message }));
    });
    request.on("finish", () => {
      if (!settled && !signal?.aborted) config.onUploadComplete?.();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    void (async () => {
      const write = (chunk) => new Promise((done) => {
        if (request.write(chunk)) done();
        else request.once("drain", done);
      });
      await write(prefix);
      // Multiples of three bytes encode without padding until the final chunk.
      for (let offset = 0; offset < data.length && !settled; offset += 3 * 1024 * 1024) {
        await write(data.toString("base64", offset, Math.min(data.length, offset + 3 * 1024 * 1024)));
      }
      if (!settled) request.end(suffix);
    })();
  });
}

module.exports = { REALTIME_URL, isConfigured, realtimeHeaders, serviceError, parseFlashResult, flashRecognize };
