"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { parseHotwords, effectiveHotwords, doubaoCorpus } = require("../src/hotwords");

// Protect bulk paste when the text editor or its delimiters change.
test("hotword paste splits whitespace and punctuation, drops empty terms and preserves unique word spelling", () => {
  assert.deepEqual(parseHotwords(" 星河，晓岚; ASR\t星河\n‘新项目’ / 云芽租、ASR。 "), ["星河", "晓岚", "ASR", "新项目", "云芽租"]);
});

// Protect per-meeting removal when global vocabulary changes later.
test("meeting additions precede inherited words and exclusions never mutate the global vocabulary", () => {
  const globalWords = ["星河", "云芽租"];
  const meeting = { hotwords: ["晓岚", "星河"], excludedHotwords: ["云芽租"] };
  assert.deepEqual(effectiveHotwords(globalWords, meeting), ["晓岚", "星河"]);
  assert.deepEqual(effectiveHotwords([...globalWords, "新产品"], meeting), ["晓岚", "星河", "新产品"]);
  assert.deepEqual(effectiveHotwords(globalWords, { ...meeting, useGlobalHotwords: false, hotwords: ["晓岚"] }), ["晓岚"]);
  assert.deepEqual(globalWords, ["星河", "云芽租"]);
});

// Protect Chinese URL signing and request serialization when adapters change.
test("both providers carry hotwords in their file requests and Tencent signs unescaped realtime words", async (t) => {
  const cloud = require("../src/cloud");
  const tencent = require("../src/tencent");
  const doubao = require("../src/doubao");
  const words = ["星河", "晓岚"];
  const config = { appId: "12345", secretId: "AKIDEXAMPLE", secretKey: "test-secret" };
  const url = new URL(tencent.signRealtimeUrl(config, { hotwords: words }));
  const signature = url.searchParams.get("signature");
  url.searchParams.delete("signature");
  const source = `${url.host}${url.pathname}?${[...url.searchParams].map(([key, value]) => `${key}=${value}`).join("&")}`;
  assert.equal(signature, crypto.createHmac("sha1", config.secretKey).update(source).digest("base64"));
  assert.deepEqual(url.searchParams.get("hotword_list").split(",").map((item) => item.split("|")[0]), words);
  let tencentBody, doubaoBody;
  t.mock.method(cloud, "tcCall", async (_config, _product, _version, _action, body) => {
    tencentBody = body; return { Data: { TaskId: 123 } };
  });
  t.mock.method(cloud, "request", async ({ body }) => {
    doubaoBody = JSON.parse(body);
    return { status: 200, headers: { "x-api-status-code": "20000000" }, text: '{"task_id":"task"}' };
  });
  await tencent.submit(config, "https://example.invalid/audio.wav", "request", undefined, words);
  await doubao.submit({ apiKey: "test-key" }, "https://example.invalid/audio.wav", "request", undefined, words);
  assert.equal(tencentBody.HotwordList, url.searchParams.get("hotword_list"));
  assert.deepEqual(JSON.parse(doubaoBody.request.corpus.context).hotwords, words.map((word) => ({ word })));
  assert.deepEqual(doubaoBody.request.corpus, doubaoCorpus(words).corpus);
});
