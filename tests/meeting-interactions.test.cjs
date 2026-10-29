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
const { parseIal, sha256 } = require("../src/util");
Module._load = originalLoad;

test("retrying summary metadata save preserves a single result and refuses to overwrite a later edit", async (t) => {
  const document = { id: "summary", content: "", attrs: {} };
  t.mock.method(api, "listBlocksWithAttr", async () => []);
  t.mock.method(api, "listChildDocs", async () => [{ id: document.id, attrs: document.attrs }]);
  t.mock.method(api, "getDocMarkdown", async () => document.content);
  t.mock.method(api, "post", async (endpoint) => {
    assert.equal(endpoint, "/api/block/getChildBlocks");
    return [];
  });
  t.mock.method(api, "appendMarkdown", async (_id, content) => { document.content += content; });
  let failMetadata = true;
  t.mock.method(api, "setBlockAttrs", async (_id, attrs) => {
    if (failMetadata) { failMetadata = false; throw new Error("save interrupted"); }
    document.attrs = { ...document.attrs, ...attrs };
  });
  const basis = { templateId: "actions", template: "template-hash", notes: "notes-hash", transcript: "transcript-hash", onlyNotes: false, recordingIds: null };
  const draft = { markdown: "周五复核，负责人待定。", sources: "会议笔记", basis, receipt: {} };
  await assert.rejects(store.saveSummary({ id: "meeting" }, draft));
  await store.saveSummary({ id: "meeting" }, draft);
  assert.equal(document.content, "周五复核，负责人待定。");
  assert.equal(document.attrs[store.ATTR.summarySources], "会议笔记");
  assert.deepEqual(JSON.parse(document.attrs[store.ATTR.summaryBasis]), basis);
  document.content = "人工确认的纪要";
  await assert.rejects(store.saveSummary({ id: "meeting" }, draft));
  assert.equal(document.content, "人工确认的纪要");
});

test("replacing a synced summary uses native blocks when the SQL index still has the previous revision", async (t) => {
  const navigation = { id: "navigation", markdown: "((20261029100000-abcdefg '返回会议'))", attrs: { [store.ATTR.navigation]: "parent" } };
  let blocks = [navigation, { id: "old-summary-block", markdown: "原纪要", content: "原纪要" }];
  t.mock.method(api, "listBlocksWithAttr", async () => [navigation]);
  let attrs = {};
  t.mock.method(api, "listChildDocs", async () => [{ id: "summary", attrs }]);
  t.mock.method(api, "sql", async () => []);
  t.mock.method(api, "getDocMarkdown", async () => blocks.map((block) => block.markdown).join("\n"));
  t.mock.method(api, "post", async (endpoint) => {
    assert.equal(endpoint, "/api/block/getChildBlocks");
    return structuredClone(blocks);
  });
  t.mock.method(api, "appendMarkdown", async (_id, markdown) => {
    blocks.push({ id: "new-summary-block", markdown, content: markdown });
  });
  t.mock.method(api, "deleteBlocks", async (ids) => { blocks = blocks.filter((block) => !ids.includes(block.id)); });
  t.mock.method(api, "setBlockAttrs", async (_id, patch) => { attrs = { ...attrs, ...patch }; });
  const saved = await store.saveSummary({ id: "meeting" }, { markdown: "更新后的纪要", expectedFingerprint: sha256("原纪要") });
  assert.equal(saved.content, "更新后的纪要");
  assert.deepEqual(blocks.find((block) => block.id === navigation.id), navigation);
  assert.equal(attrs[store.ATTR.summaryFingerprint], sha256("更新后的纪要"));
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
