"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cloud = require("../src/cloud");
const tencent = require("../src/tencent");
const doubao = require("../src/doubao");

test("file adapters submit mono standard models and distinguish queued results from successful silence", async (t) => {
  const config = { secretId: "AKIDSYNTHETIC", secretKey: "synthetic-key", apiKey: "synthetic-api-key" };
  const requests = [];
  t.mock.method(cloud, "tcCall", async (_config, service, version, action, body) => {
    requests.push({ service, version, action, body });
    return action === "GetUserAppId" ? { AppId: 12345 } : action === "CreateRecTask" ? { Data: { TaskId: 6789 } } : { Data: { Status: 0 } };
  });
  assert.equal(await tencent.getAppId(config), "12345");
  assert.equal(await tencent.submit(config, "https://synthetic.invalid/audio.wav", "request"), "6789");
  assert.deepEqual(requests[1].body, { EngineModelType: "16k_zh_en_2.0", ChannelNum: 1, ResTextFormat: 1, SourceType: 0, Url: "https://synthetic.invalid/audio.wav", SpeakerDiarization: 1 });
  assert.equal(await tencent.query(config, "6789"), null);
  let status = "20000000";
  t.mock.method(cloud, "request", async (request) => {
    requests.push(request);
    return { status: 200, headers: { "x-api-status-code": status }, text: JSON.stringify({ task_id: "task-123" }) };
  });
  assert.equal(await doubao.submit(config, "https://synthetic.invalid/audio.wav", "request-1"), "task-123");
  const request = requests.at(-1);
  assert.equal(request.headers["X-Api-Resource-Id"], "volc.seedasr.auc");
  assert.deepEqual(JSON.parse(request.body).request, { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_speaker_info: true, show_utterances: true, ssd_version: "300" });
  status = "20000002";
  assert.equal(await doubao.query(config, "task-123"), null);
  assert.equal(requests.at(-1).headers["X-Api-Request-Id"], "task-123");
  status = "20000003";
  assert.deepEqual(await doubao.query(config, "task-123"), []);
  assert.throws(() => doubao.parseResult({ result: { text: "有正文却缺少分句", utterances: [] } }), { code: "INVALID_RESPONSE" });
});

test("a COS default endpoint supplies bucket and region without permitting arbitrary request hosts", () => {
  assert.deepEqual(cloud.parseCosEndpoint("https://meeting-1250000000.cos.ap-shanghai.myqcloud.com/"), {
    bucket: "meeting-1250000000", region: "ap-shanghai",
  });
  assert.deepEqual(cloud.parseCosEndpoint("meeting-1250000000.cos.ap-nanjing.myqcloud.com"), {
    bucket: "meeting-1250000000", region: "ap-nanjing",
  });
  for (const endpoint of ["https://example.com", "http://meeting-1250000000.cos.ap-shanghai.myqcloud.com",
    "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com.evil.invalid",
    "https://user:secret@meeting-1250000000.cos.ap-shanghai.myqcloud.com/",
    "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com/audio.wav?signature=example"]) {
    assert.throws(() => cloud.parseCosEndpoint(endpoint));
  }
});
