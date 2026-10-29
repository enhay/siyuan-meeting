"use strict";

const crypto = require("node:crypto");
const cloud = require("./cloud");
const { doubaoCorpus } = require("./hotwords");

const HOST = "openspeech.bytedance.com";
// https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket
// The key travels only in request headers, which the main window adds to the
// capture window's connection.
const REALTIME_URL = `wss://${HOST}/api/v3/sauc/bigmodel_async`;
const REALTIME_RESOURCE = "volc.seedasr.sauc.duration";
const FILE_RESOURCE = "volc.seedasr.auc";

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
    45000030: "豆包录音文件标准版 2.0 尚未开通，请在火山引擎控制台开通后重试",
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
function parseResult(result) {
  const utterances = result?.result?.utterances;
  if (!Array.isArray(utterances) || (!utterances.length && String(result.result.text || "").trim())) throw responseError("missing-result");
  const sentences = [];
  for (const utterance of utterances) {
    if (typeof utterance?.text !== "string") throw responseError("invalid-sentence");
    const text = utterance.text.trim();
    if (!text) continue;
    const startMs = Number(utterance.start_time ?? 0);
    const endMs = Number(utterance.end_time);
    const speaker = Number(utterance.additions?.speaker_id ?? 0);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs ||
        !Number.isInteger(speaker) || speaker < 0) throw responseError("invalid-timestamp");
    sentences.push({ startMs, endMs, speaker, channel: 0, text });
  }
  return sentences.map((sentence) => ({ ...sentence, speakerLabel: `说话人 ${sentence.speaker + 1}` }))
    .sort((a, b) => a.startMs - b.startMs);
}

async function fileRequest(config, action, requestId, body, signal) {
  requireConfig(config);
  const payload = JSON.stringify(body);
  const response = await cloud.request({ hostname: HOST, path: `/api/v3/auc/bigmodel/${action}`,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
      "X-Api-Key": config.apiKey.trim(), "X-Api-Resource-Id": FILE_RESOURCE,
      "X-Api-Request-Id": requestId, "X-Api-Sequence": "-1" }, body: payload, signal });
  const status = Number(response.headers["x-api-status-code"]);
  if (response.status !== 200 || ![20000000, 20000001, 20000002, 20000003].includes(status)) {
    throw Object.assign(serviceError(status, response.headers["x-tt-logid"]), {
      httpStatus: response.status, rejected: status >= 45000000 && status < 50000000,
      terminal: action === "query" && [45000002, 45000131, 45000132, 45000151].includes(status),
    });
  }
  return { status, body: response.text ? cloud.json(response) : {} };
}

async function submit(config, url, requestId, signal, hotwords = [], audio = { format: "wav", rate: 16000, bits: 16, channel: 1 }) {
  const result = await fileRequest(config, "submit", requestId, {
    user: { uid: "siyuan-meeting" }, audio: { url, ...audio },
    request: { model_name: "bigmodel", enable_itn: true, enable_punc: true,
      enable_speaker_info: true, show_utterances: true, ssd_version: "300", ...doubaoCorpus(hotwords) },
  }, signal);
  if (result.status !== 20000000 || typeof result.body.task_id !== "string" || !result.body.task_id) {
    throw cloud.failure("豆包未返回任务编号，请检查云端任务后再操作");
  }
  return result.body.task_id;
}

async function query(config, taskId, signal) {
  const result = await fileRequest(config, "query", taskId, {}, signal);
  if ([20000001, 20000002].includes(result.status)) return null;
  if (result.status === 20000003) return [];
  return parseResult(result.body);
}

module.exports = { REALTIME_URL, isConfigured, realtimeHeaders, serviceError, parseResult, submit, query };
