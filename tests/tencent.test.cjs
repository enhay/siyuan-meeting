"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAuthorization,
  parseResult,
  engineForSampleRate,
  normalizeStatus,
} = require("../src/tencent");

test("TC3 authorization has the documented shape and is deterministic", () => {
  const input = {
    secretId: "AKIDEXAMPLE",
    secretKey: "SECRETEXAMPLE",
    host: "asr.tencentcloudapi.com",
    service: "asr",
    payload: JSON.stringify({ EngineModelType: "16k_zh" }),
    timestamp: 1551113065,
  };
  const first = buildAuthorization(input);
  const second = buildAuthorization(input);
  assert.equal(first, second);
  assert.match(
    first,
    /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2019-02-25\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
  );
});

test("result parsing accepts both object and JSON-string results", () => {
  const detail = {
    ResultDetail: [
      { FinalSentence: "第一句", StartMs: 0, EndMs: 1000, SpeakerId: 0, ChannelNum: 1 },
      { FinalSentence: "第二句", StartMs: 1200, EndMs: 2000, SpeakerId: 1, ChannelNum: 2 },
    ],
  };
  for (const value of [detail, JSON.stringify(detail)]) {
    const segments = parseResult(value);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].text, "第一句");
    assert.equal(segments[1].startMs, 1200);
    assert.equal(segments[1].speaker, "1");
  }
  assert.deepEqual(parseResult("not json"), []);
});

test("engine choice follows the recording sample rate", () => {
  assert.equal(engineForSampleRate(16000), "16k_zh");
  assert.equal(engineForSampleRate(48000), "16k_zh");
  assert.equal(engineForSampleRate(8000), "8k_zh");
  assert.throws(() => engineForSampleRate(4000), /8 kHz/);
});

test("task status normalization covers waiting, running, success and failure", () => {
  assert.equal(normalizeStatus({ Status: 0 }), "queued");
  assert.equal(normalizeStatus({ Status: 1 }), "processing");
  assert.equal(normalizeStatus({ Status: 2 }), "done");
  assert.equal(normalizeStatus({ Status: 3 }), "failed");
  assert.equal(normalizeStatus({ StatusStr: "success" }), "done");
});
