"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "siyuan" ? {} : originalLoad.call(this, name, ...args);
};
const api = require("../src/siyuan-api");
const store = require("../src/meeting-store");
const { parseIal } = require("../src/util");
Module._load = originalLoad;

test("retrying summary metadata save preserves a single result and refuses to overwrite a later edit", async (t) => {
  const document = { id: "summary", content: "", attrs: {} };
  t.mock.method(api, "listChildDocs", async () => [{ id: document.id, attrs: document.attrs }]);
  t.mock.method(api, "getDocMarkdown", async () => document.content);
  t.mock.method(api, "sql", async () => []);
  t.mock.method(api, "appendMarkdown", async (_id, content) => { document.content += content; });
  let failMetadata = true;
  t.mock.method(api, "setBlockAttrs", async (_id, attrs) => {
    if (failMetadata) { failMetadata = false; throw new Error("save interrupted"); }
    document.attrs = { ...document.attrs, ...attrs };
  });
  const draft = { markdown: "周五复核，负责人待定。", sources: "会议笔记", receipt: {} };
  await assert.rejects(store.saveSummary({ id: "meeting" }, draft));
  await store.saveSummary({ id: "meeting" }, draft);
  assert.equal(document.content, "周五复核，负责人待定。");
  assert.equal(document.attrs[store.ATTR.summarySources], "会议笔记");
  document.content = "人工确认的纪要";
  await assert.rejects(store.saveSummary({ id: "meeting" }, draft));
  assert.equal(document.content, "人工确认的纪要");
});

test("renaming a speaker changes matching native labels while retaining emphasis, links and timing attributes", async (t) => {
  const attrs = { id: "sentence", [store.ATTR.transcriptMeeting]: "meeting", [store.ATTR.transcriptLabel]: "说话人 1", [store.ATTR.transcriptStart]: "1200" };
  const persisted = {
    attrs,
    markdown: '[00:00:01](siyuan://plugins/siyuan-meeting/seek) 说话人 1：**人工重点** [详情](https://example.com)\n{: id="sentence" custom-transcript-meeting="meeting" custom-transcript-label="说话人 1" custom-transcript-start="1200"}',
  };
  t.mock.method(api, "listChildDocs", async () => [{ id: "transcript" }]);
  t.mock.method(api, "listBlocksWithAttr", async () => [{ id: "sentence", attrs: persisted.attrs }]);
  t.mock.method(api, "getBlockAttrs", async () => persisted.attrs);
  t.mock.method(api, "post", async (endpoint, payload) => {
    if (endpoint.endsWith("getBlockKramdown")) return { kramdown: persisted.markdown };
    if (endpoint.endsWith("updateBlock")) {
      persisted.markdown = payload.data;
      persisted.attrs = parseIal(payload.data);
    }
  });
  await store.renameTranscriptSpeaker({ id: "meeting" }, "说话人 1", "主持人");
  assert.equal(persisted.attrs[store.ATTR.transcriptLabel], "主持人");
  assert.equal(persisted.attrs[store.ATTR.transcriptStart], "1200");
  assert.ok(persisted.markdown.includes("**人工重点**"));
  assert.ok(persisted.markdown.includes("[详情](https://example.com)"));
});
