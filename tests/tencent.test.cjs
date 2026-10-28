"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { signRealtimeUrl, parseResult } = require("../src/tencent");

test("realtime signs the sorted request URL, with encoded signature and no secret key", () => {
  const config = { appId: "12345", secretId: "AKIDEXAMPLE", secretKey: "test-secret" };
  const address = signRealtimeUrl(config, { voiceId: "meeting-voice", sampleRate: 16000, now: 1793000000 });
  const url = new URL(address);
  const signature = url.searchParams.get("signature");
  url.searchParams.delete("signature");
  const source = `${url.host}${url.pathname}?${url.searchParams.toString()}`;
  assert.equal(signature, crypto.createHmac("sha1", config.secretKey).update(source).digest("base64"));
  assert.equal(url.searchParams.get("voice_format"), "1");
  assert.equal(url.searchParams.get("engine_model_type"), "16k_zh_en");
  const general = new URL(signRealtimeUrl(config, { voiceId: "meeting-voice", engine: "general", now: 1793000000 }));
  assert.equal(general.searchParams.get("engine_model_type"), "16k_zh");
});

test("standard recognition retains sentence timestamps and model speaker identity", () => {
  assert.deepEqual(parseResult({ ResultDetail: [
    { FinalSentence: "我确认预算", StartMs: 10, EndMs: 500, SpeakerId: 0 },
    { FinalSentence: "还未确定", StartMs: 600, EndMs: 900, SpeakerId: 2 },
  ] }), [
    { startMs: 10, endMs: 500, speaker: 0, channel: 0, text: "我确认预算", speakerLabel: "说话人 1" },
    { startMs: 600, endMs: 900, speaker: 2, channel: 0, text: "还未确定", speakerLabel: "说话人 3" },
  ]);
  assert.throws(() => parseResult({}), { userMessage: "腾讯云返回的转写缺少分句，未覆盖已有文字" });
});
