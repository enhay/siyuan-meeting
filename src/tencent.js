"use strict";

const crypto = require("node:crypto");
const https = require("node:https");

const ASR_HOST = "asr.tencentcloudapi.com";
const ASR_SERVICE = "asr";
const ASR_VERSION = "2019-06-14";

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();

/**
 * Tencent Cloud API v3 signature (TC3-HMAC-SHA256).
 * https://cloud.tencent.com/document/api/1093/35640
 */
function buildAuthorization({ secretId, secretKey, host, service, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function request(action, config, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const authorization = buildAuthorization({
    secretId: config.secretId,
    secretKey: config.secretKey,
    host: ASR_HOST,
    service: ASR_SERVICE,
    payload: body,
    timestamp,
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: ASR_HOST,
        method: "POST",
        path: "/",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json; charset=utf-8",
          Host: ASR_HOST,
          "X-TC-Action": action,
          "X-TC-Version": ASR_VERSION,
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Region": config.region || "ap-shanghai",
        },
        timeout: config.timeout || 60000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            reject(new Error(`腾讯云返回内容无法解析（${response.statusCode}）`));
            return;
          }
          const result = parsed?.Response;
          if (!result) {
            reject(new Error(`腾讯云返回异常（${response.statusCode}）`));
            return;
          }
          if (result.Error) {
            reject(new Error(`腾讯云 ${result.Error.Code || ""}：${result.Error.Message || "请求失败"}`));
            return;
          }
          resolve(result);
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("腾讯云请求超时")));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function missingConfig(config) {
  if (!config?.secretId || !config?.secretKey) {
    throw new Error("请先在会议设置中填写腾讯云 SecretId 和 SecretKey");
  }
}

/**
 * Create a long-audio recognition task.
 * SourceType 1 = base64 data (5 MB limit), SourceType 0 = public URL.
 */
async function createRecTask(config) {
  missingConfig(config);
  const payload = {
    EngineModelType: config.engine || "16k_zh",
    ChannelNum: config.channels === 2 ? 2 : 1,
    ResTextFormat: 2,
    SourceType: config.sourceType === 0 ? 0 : 1,
    SpeakerDiarization: config.channels === 2 ? 0 : 1,
    SpeakerNumber: 0,
  };
  if (payload.SourceType === 0) {
    if (!config.url) throw new Error("缺少音频的可访问地址");
    payload.Url = config.url;
  } else {
    if (!Buffer.isBuffer(config.data)) throw new Error("缺少音频数据");
    if (config.data.length > 5 * 1024 * 1024) {
      throw new Error("音频超过 5 MB，腾讯云直传只支持 5 MB 以内；请配置可访问的音频地址");
    }
    payload.Data = config.data.toString("base64");
    payload.DataLen = config.data.length;
  }
  return request("CreateRecTask", config, payload);
}

async function describeTaskStatus(config, taskId) {
  missingConfig(config);
  if (!taskId) throw new Error("缺少转写任务编号");
  return request("DescribeTaskStatus", config, { TaskId: Number(taskId) });
}

/**
 * Parse the result payload, which Tencent sometimes returns as a JSON string.
 * Returns segments normalized for the plugin:
 *   { startMs, endMs, speaker, text, channel }
 */
function parseResult(result) {
  let detail = result;
  if (typeof detail === "string") {
    try {
      detail = JSON.parse(detail);
    } catch {
      return [];
    }
  }
  const sentences = Array.isArray(detail?.ResultDetail)
    ? detail.ResultDetail
    : Array.isArray(detail?.Result)
      ? detail.Result
      : [];

  return sentences
    .map((sentence) => {
      const text = String(
        sentence.FinalSentence ?? sentence.Sentence ?? sentence.Text ?? "",
      ).trim();
      if (!text) return null;
      const startMs = Number(sentence.StartMs ?? sentence.StartTime ?? 0);
      const endMs = Number(sentence.EndMs ?? sentence.EndTime ?? startMs);
      return {
        startMs: Number.isFinite(startMs) ? Math.max(0, startMs) : 0,
        endMs: Number.isFinite(endMs) ? Math.max(0, endMs) : 0,
        speaker: String(sentence.SpeakerId ?? sentence.Speaker ?? "").trim(),
        channel: Number(sentence.ChannelNum ?? sentence.Channel ?? 0) || 0,
        text,
      };
    })
    .filter(Boolean);
}

/** Choose a Tencent engine that matches the WAV sample rate. */
function engineForSampleRate(sampleRate) {
  if (Number(sampleRate) >= 16000) return "16k_zh";
  if (Number(sampleRate) >= 8000) return "8k_zh";
  throw new Error("录音采样率低于 8 kHz，无法使用腾讯云语音识别");
}

function normalizeStatus(response) {
  const status = Number(response?.Status);
  const statusText = String(response?.StatusStr || "");
  if (status === 2 || /success/i.test(statusText)) return "done";
  if (status === 3 || /fail/i.test(statusText)) return "failed";
  if (status === 1 || /processing|running/i.test(statusText)) return "processing";
  return "queued";
}

module.exports = {
  ASR_HOST,
  ASR_SERVICE,
  ASR_VERSION,
  buildAuthorization,
  createRecTask,
  describeTaskStatus,
  parseResult,
  engineForSampleRate,
  normalizeStatus,
};
