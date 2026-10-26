"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { signRealtimeUrl, parseFlashResult, engineForSampleRate } = require("../src/tencent");

test("realtime signs the sorted request URL, with encoded signature and no secret key", () => {
  const config = { appId: "12345", secretId: "AKIDEXAMPLE", secretKey: "test-secret" };
  const address = signRealtimeUrl(config, { voiceId: "meeting-voice", sampleRate: 16000, now: 1793000000 });
  const url = new URL(address);
  const signature = url.searchParams.get("signature");
  url.searchParams.delete("signature");
  const source = `${url.host}${url.pathname}?${url.searchParams.toString()}`;
  assert.equal(signature, crypto.createHmac("sha1", config.secretKey).update(source).digest("base64"));
  assert.equal(url.searchParams.get("voice_format"), "1");
  assert.equal(url.searchParams.get("engine_model_type"), "16k_zh");
});

test("flash results retain channel identity and sentence timestamps", () => {
  const result = { flash_result: [
    { channel_id: 0, sentence_list: [{ text: "我确认预算", start_time: 10, end_time: 500, speaker_id: 0 }] },
    { channel_id: 1, sentence_list: [{ text: "还未确定", start_time: 600, end_time: 900, speaker_id: 2 }] },
  ] };
  assert.deepEqual(parseFlashResult(result, 2), [
    { startMs: 10, endMs: 500, speaker: 0, channel: 0, text: "我确认预算", speakerLabel: "我" },
    { startMs: 600, endMs: 900, speaker: 2, channel: 1, text: "还未确定", speakerLabel: "其他参会者" },
  ]);
  assert.equal(engineForSampleRate(16000), "16k_zh");
  assert.equal(engineForSampleRate(8000), "8k_zh");
});
