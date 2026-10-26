"use strict";

const crypto = require("node:crypto");
const https = require("node:https");
const { MAX_FILE_BYTES, MAX_DURATION_SECONDS } = require("./wav");

const ASR_HOST = "asr.cloud.tencent.com";

function isConfigured(config) {
  return /^\d+$/.test(String(config?.appId || "")) &&
    /^[A-Za-z0-9_-]+$/.test(String(config?.secretId || "")) &&
    typeof config?.secretKey === "string" && Boolean(config.secretKey.trim()) &&
    !/[\r\n]/.test(config.secretKey);
}

function requireConfig(config) {
  if (!isConfigured(config)) throw new Error("请先在会议设置中完善腾讯云配置");
}

function engineForSampleRate(sampleRate) {
  if (Number(sampleRate) === 16000) return "16k_zh";
  if (Number(sampleRate) === 8000) return "8k_zh";
  throw new Error("这份录音暂不支持转写，请使用会议录音功能保存的原始录音");
}

function queryString(params) {
  return Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
}

function signature(secretKey, source) {
  return crypto.createHmac("sha1", secretKey).update(source).digest("base64");
}

// https://cloud.tencent.com/document/product/1093/48982
// `now` is a Unix timestamp in seconds. Only the main window calls this function.
function signRealtimeUrl(config, { voiceId = crypto.randomUUID(), sampleRate = 16000,
  now = Math.floor(Date.now() / 1000) } = {}) {
  requireConfig(config);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(voiceId) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("无法开始实时转写，请重新开始录音后再试");
  }
  const params = {
    engine_model_type: engineForSampleRate(sampleRate),
    expired: now + 3600,
    needvad: 1,
    nonce: crypto.randomInt(1, 1000000000),
    secretid: config.secretId,
    timestamp: now,
    voice_format: 1,
    voice_id: voiceId,
  };
  const source = `${ASR_HOST}/asr/v2/${config.appId}?${queryString(params)}`;
  return `wss://${source}&signature=${encodeURIComponent(signature(config.secretKey, source))}`;
}

function serviceError(code, requestId = "") {
  const messages = {
    4001: "腾讯云无法处理这次转写，请检查录音后手动重试",
    4002: "腾讯云验证未通过，请检查会议设置中的配置和电脑时间",
    4003: "腾讯云语音识别尚未开通，请在腾讯云控制台开通后重试",
    4004: "腾讯云转写额度已用完，请补充额度后重试",
    4005: "腾讯云账户已欠费，请充值后重试",
    4006: "腾讯云当前转写过多，请稍后手动重试",
    4007: "腾讯云无法读取这段录音，请检查录音能否正常播放后重试",
    4008: "音频上传中断，请检查网络后手动重试",
    4009: "转写连接已断开，请检查网络后手动重试",
    4011: "这次提交的录音过大，请重新选择录音时段后重试",
    4012: "这次提交的录音没有内容，请检查录音后重试",
    6001: "腾讯云服务地区与当前网络不匹配，请检查代理或账户所属地区",
  };
  const error = new Error(messages[Number(code)] || "腾讯云暂时未能完成转写，请稍后手动重试");
  error.userMessage = error.message;
  error.serviceCode = Number(code);
  error.requestId = String(requestId || "");
  return error;
}

function parseFlashResult(result, channels = 1) {
  if (!Array.isArray(result?.flash_result)) {
    throw new Error("腾讯云返回的转写不完整，请稍后手动重试");
  }
  const segments = [];
  for (const track of result.flash_result) {
    const channel = track.channel_id;
    if (!Number.isInteger(channel) || channel < 0 || channel >= channels ||
        !Array.isArray(track.sentence_list)) {
      throw new Error("腾讯云返回的转写不完整，请稍后手动重试");
    }
    const speakers = new Set(track.sentence_list.filter((sentence) => String(sentence.text || "").trim())
      .map((sentence) => Number(sentence.speaker_id ?? 0)));
    for (const sentence of track.sentence_list) {
      if (typeof sentence.text !== "string") {
        throw new Error("腾讯云返回的转写不完整，请稍后手动重试");
      }
      const text = sentence.text.trim();
      if (!text) continue;
      const startMs = sentence.start_time;
      const endMs = sentence.end_time;
      const speaker = sentence.speaker_id ?? 0;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs ||
          !Number.isInteger(speaker) || speaker < 0) {
        throw new Error("腾讯云返回的转写不完整，请稍后手动重试");
      }
      const speakerLabel = channels === 2
        ? channel === 0 ? "我" : `其他参会者${speakers.size > 1 ? ` ${speaker + 1}` : ""}`
        : `说话人 ${speaker + 1}`;
      segments.push({ startMs, endMs, speaker, channel, text, speakerLabel });
    }
  }
  return segments.sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
}

function aborted() {
  const error = new Error("已取消转写");
  error.name = "AbortError";
  return error;
}

// https://cloud.tencent.com/document/product/1093/52097
async function flashRecognize(config) {
  requireConfig(config);
  const { data, signal } = config;
  const channels = Number(config.channels);
  const sampleRate = Number(config.sampleRate);
  const engine = engineForSampleRate(sampleRate);
  if (!Buffer.isBuffer(data) || data.length <= 44 || data.length > MAX_FILE_BYTES ||
      ![1, 2].includes(channels) || data.toString("ascii", 0, 4) !== "RIFF" ||
      data.toString("ascii", 8, 12) !== "WAVE" || data.toString("ascii", 12, 16) !== "fmt " ||
      data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 ||
      data.readUInt16LE(22) !== channels || data.readUInt32LE(24) !== sampleRate ||
      data.readUInt32LE(28) !== sampleRate * channels * 2 || data.readUInt16LE(32) !== channels * 2 ||
      data.readUInt16LE(34) !== 16 || data.toString("ascii", 36, 40) !== "data" ||
      data.readUInt32LE(40) !== data.length - 44 || data.readUInt32LE(4) !== data.length - 8 ||
      (data.length - 44) % (channels * 2) ||
      (data.length - 44) / (sampleRate * channels * 2) > MAX_DURATION_SECONDS) {
    throw new Error("这段录音无法直接转写，请检查录音后重试");
  }
  if (signal?.aborted) throw aborted();
  const params = {
    engine_type: engine,
    first_channel_only: channels === 2 ? 0 : 1,
    secretid: config.secretId,
    speaker_diarization: 1,
    timestamp: Math.floor(Date.now() / 1000),
    voice_format: "wav",
  };
  const path = `/asr/flash/v1/${config.appId}?${queryString(params)}`;
  const authorization = signature(config.secretKey, `POST${ASR_HOST}${path}`);
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
      hostname: ASR_HOST, path, method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/octet-stream",
        "Content-Length": data.length },
      // A synchronous upload can take minutes on a meeting participant's connection.
      // Stop a stalled connection without resubmitting a billable request.
      timeout: 10 * 60 * 1000,
    }, (response) => {
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        // Bound untrusted response data independently of the audio upload size.
        if (received > 16 * 1024 * 1024) {
          finish(new Error("腾讯云返回的转写无法处理，请稍后手动重试"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("aborted", () => finish(new Error("转写连接已断开，请检查网络后手动重试")));
      response.on("error", () => finish(new Error("转写连接已断开，请检查网络后手动重试")));
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (result.code !== 0) throw serviceError(result.code, result.request_id);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error("腾讯云暂时未能完成转写，请稍后手动重试");
          }
          finish(null, parseFlashResult(result, channels));
        } catch (error) {
          finish(error instanceof SyntaxError
            ? new Error("腾讯云返回的转写不完整，请稍后手动重试") : error);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      finish(new Error("转写等待时间过长，请检查网络后手动重试"));
    });
    request.on("error", () => finish(signal?.aborted ? aborted()
      : new Error("转写连接未完成，请检查网络后手动重试")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else request.end(data);
  });
}

module.exports = { ASR_HOST, isConfigured, engineForSampleRate, signRealtimeUrl,
  serviceError, parseFlashResult, flashRecognize };
