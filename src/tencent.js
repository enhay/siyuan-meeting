"use strict";

const crypto = require("node:crypto");
const cloud = require("./cloud");

const ASR_HOST = "asr.cloud.tencent.com";

function isConfigured(config) {
  return /^[A-Za-z0-9_-]+$/.test(String(config?.secretId || "")) &&
    typeof config?.secretKey === "string" && Boolean(config.secretKey.trim()) &&
    !/[\r\n]/.test(config.secretKey);
}

function requireConfig(config) {
  if (!isConfigured(config)) {
    const message = "请先在会议设置中完善腾讯云配置";
    throw Object.assign(new Error(message), { code: "INVALID_CONFIGURATION", userMessage: message });
  }
}

function queryString(params) {
  return Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
}

function signature(secretKey, source) {
  return crypto.createHmac("sha1", secretKey).update(source).digest("base64");
}

// Realtime engines selectable in the meeting settings; the large model is
// billed separately and has no free quota.
const REALTIME_ENGINES = { large: "16k_zh_en", general: "16k_zh" };

// https://cloud.tencent.com/document/product/1093/48982
// `now` is a Unix timestamp in seconds. Only the main window calls this function.
function signRealtimeUrl(config, { voiceId = crypto.randomUUID(), sampleRate = 16000, engine = "large",
  now = Math.floor(Date.now() / 1000) } = {}) {
  requireConfig(config);
  if (!/^\d+$/.test(String(config.appId || ""))) throw new Error("腾讯云账号信息尚未取得");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(voiceId) || !Number.isSafeInteger(now) || now < 0 ||
      Number(sampleRate) !== 16000 || !Object.hasOwn(REALTIME_ENGINES, engine)) {
    throw new Error("无法开始实时转写，请重新开始录音后再试");
  }
  const params = {
    engine_model_type: REALTIME_ENGINES[engine],
    expired: now + 3600,
    max_speak_time: 20000,
    needvad: 1,
    nonce: crypto.randomInt(1, 1000000000),
    secretid: config.secretId,
    timestamp: now,
    vad_silence_time: 600,
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

async function getAppId(config) {
  requireConfig(config);
  const result = await cloud.tcCall(config, "cam", "2019-01-16", "GetUserAppId", {});
  if (!Number.isSafeInteger(result.AppId) || result.AppId <= 0) throw cloud.failure("腾讯云未返回有效账号信息");
  return String(result.AppId);
}

async function submit(config, url, requestId, signal) {
  requireConfig(config);
  const result = await cloud.tcCall(config, "asr", "2019-06-14", "CreateRecTask", {
    EngineModelType: "16k_zh_en_2.0", ChannelNum: 1, ResTextFormat: 1,
    SourceType: 0, Url: url, SpeakerDiarization: 1,
  }, signal);
  if (!Number.isSafeInteger(result.Data?.TaskId)) throw cloud.failure("腾讯云未返回任务编号，请检查云端任务后再操作");
  return String(result.Data.TaskId);
}

function parseResult(data) {
  if (!Array.isArray(data?.ResultDetail) || (!data.ResultDetail.length && String(data.Result || "").trim())) throw cloud.failure("腾讯云返回的转写缺少分句，未覆盖已有文字");
  return data.ResultDetail.map((sentence) => {
    const { StartMs: startMs, EndMs: endMs, SpeakerId: speaker = 0, FinalSentence: text } = sentence;
    if (typeof text !== "string" || !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
        startMs < 0 || endMs < startMs || !Number.isInteger(speaker) || speaker < 0) {
      throw cloud.failure("腾讯云返回的转写分句无效，未覆盖已有文字");
    }
    return { startMs, endMs, speaker, channel: 0, text: text.trim(), speakerLabel: `说话人 ${speaker + 1}` };
  }).filter((sentence) => sentence.text);
}

async function query(config, taskId, signal) {
  if (!/^\d+$/.test(taskId)) throw cloud.failure("腾讯云任务编号无效");
  const result = await cloud.tcCall(config, "asr", "2019-06-14", "DescribeTaskStatus", { TaskId: Number(taskId) }, signal);
  if ([0, 1].includes(result.Data?.Status)) return null;
  if (result.Data?.Status === 3) throw cloud.failure("腾讯云识别失败，请检查服务额度及录音后重新识别", { terminal: true, requestId: result.RequestId });
  if (result.Data?.Status !== 2) throw cloud.failure("腾讯云返回了未知任务状态，未覆盖已有文字");
  return parseResult(result.Data);
}

module.exports = { ASR_HOST, isConfigured, signRealtimeUrl, serviceError, getAppId, submit, query, parseResult };
