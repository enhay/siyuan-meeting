"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Simulate the window right after createDocWithMd: SQL has no row yet, but the
// block tree and block attributes are already available.
let sqlRows = [];
let blockInfo = null;
let blockAttrs = {};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "siyuan") {
    return {
      fetchSyncPost: async (url) => {
        if (url.endsWith("/query/sql")) return { code: 0, data: sqlRows };
        if (url.endsWith("/block/getBlockInfo")) {
          return blockInfo
            ? { code: 0, data: blockInfo }
            : { code: -1, msg: "not found" };
        }
        if (url.endsWith("/attr/getBlockAttrs")) return { code: 0, data: blockAttrs };
        return { code: 0, data: null };
      },
      openTab() {},
      getAllEditor() {
        return [];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const meetingStore = require("../src/meeting-store");

// Protect meeting-only vocabulary when metadata serialization changes.
test("meeting hotword choices survive reopening without changing unrelated attributes", async (t) => {
  const api = require("../src/siyuan-api");
  const attrs = { [meetingStore.ATTR.id]: "meeting-hotwords", [meetingStore.ATTR.mode]: "online" };
  const id = "20261028135318-8vni2st";
  t.mock.method(api, "getDocMeta", async () => ({ id, content: "会议", box: "notebook" }));
  t.mock.method(api, "getBlockAttrs", async () => ({ ...attrs }));
  t.mock.method(api, "setBlockAttrs", async (_id, patch) => Object.assign(attrs, patch));
  await meetingStore.saveHotwords(id, { hotwords: "星河，晓岚 星河", excludedHotwords: ["云芽租"], useGlobalHotwords: false });
  const reopened = await meetingStore.getMeeting(id);
  assert.deepEqual(reopened.hotwords, ["星河", "晓岚"]);
  assert.deepEqual(reopened.excludedHotwords, ["云芽租"]);
  assert.equal(reopened.useGlobalHotwords, false);
  assert.equal(reopened.mode, "online");
});

test("a newly created meeting falls back to block info while SQL catches up", async () => {
  sqlRows = [];
  blockInfo = { rootTitle: "会议 2026-10-26 14:30", box: "20261026135318-8vni2st", path: "/会议" };
  blockAttrs = {
    "custom-meeting-id": "meeting-1",
    "custom-meeting-started": "2026-10-26T14:30:00.000Z",
    "custom-meeting-status": "draft",
    "custom-meeting-mode": "online",
    "custom-meeting-segments": "0",
  };
  const meeting = await meetingStore.getMeeting("20261026135318-8vni2st");
  assert.equal(meeting.id, "20261026135318-8vni2st");
  assert.equal(meeting.title, "会议 2026-10-26 14:30");
  assert.equal(meeting.notebookId, "20261026135318-8vni2st");
  assert.equal(meeting.meetingId, "meeting-1");
  assert.equal(meeting.isMeeting, true);
  assert.equal(meeting.mode, "online");
});

// A future change to notebook selection must not scatter new meetings at the root.
test("new meetings share the selected notebook meeting directory while keeping notes on the meeting document", async (t) => {
  const api = require("../src/siyuan-api");
  const directoryId = "20261029100000-abcdefg";
  const meetingId = "20261029100100-abcdefg";
  const writes = [];
  let directory = [];
  t.mock.method(api, "sql", async () => directory);
  t.mock.method(api, "createDoc", async (payload) => {
    writes.push(payload);
    if (payload.title === "会议") { directory = [{ id: directoryId }]; return directoryId; }
    return meetingId;
  });
  t.mock.method(api, "setBlockAttrs", async () => {});
  t.mock.method(api, "getDocMeta", async () => ({ id: meetingId, box: "notebook", content: "评审" }));
  await meetingStore.createMeeting({ title: "评审", notebookId: "notebook" });
  await meetingStore.createMeeting({ title: "复盘", notebookId: "notebook" });
  assert.deepEqual(writes, [
    { notebookId: "notebook", title: "会议", markdown: "" },
    { notebookId: "notebook", parentID: directoryId, title: "评审", markdown: "" },
    { notebookId: "notebook", parentID: directoryId, title: "复盘", markdown: "" },
  ]);
});

// New child-document creation must preserve links in both native reading directions.
test("creating transcript and summary children persists native references back to the meeting and excludes navigation from notes", async (t) => {
  const api = require("../src/siyuan-api");
  const { parseIal } = require("../src/util");
  const parent = "20261029100000-abcdefg";
  const transcript = "20261029100100-abcdefg";
  const summary = "20261029100200-abcdefg";
  const docs = new Map([[parent, [{ id: "note", markdown: "**保留原始笔记**" }]]]);
  const children = [];
  t.mock.method(api, "listChildDocs", async (_id, kind) => children.filter((child) => child.attrs[meetingStore.ATTR.child] === kind));
  t.mock.method(api, "createDoc", async ({ title, parentID }) => {
    assert.equal(parentID, parent);
    const id = title === "转写" ? transcript : summary;
    docs.set(id, []);
    return id;
  });
  t.mock.method(api, "setBlockAttrs", async (id, attrs) => children.push({ id, attrs }));
  t.mock.method(api, "listBlocksWithAttr", async (id, attr) => docs.get(id).filter((block) => block.attrs?.[attr]));
  t.mock.method(api, "prependMarkdownRaw", async (id, markdown) => {
    docs.get(id).unshift({ id: `nav-${id}-${docs.get(id).length}`, markdown, attrs: parseIal(markdown) });
  });
  t.mock.method(api, "post", async (_endpoint, { id }) => docs.get(id));
  const meeting = { id: parent, notebookId: "notebook" };
  assert.equal(await meetingStore.ensureTranscriptDoc(meeting), transcript);
  await meetingStore.ensureSummaryDoc(meeting);
  assert.equal(await meetingStore.ensureTranscriptDoc(meeting), transcript);
  assert.deepEqual(docs.get(parent).filter((block) => block.attrs).map((block) => block.markdown), [
    `((` + summary + ` '纪要'))\n{: custom-meeting-navigation="summary"}\n`,
    `((` + transcript + ` '转写'))\n{: custom-meeting-navigation="transcript"}\n`,
  ]);
  for (const id of [transcript, summary]) {
    assert.equal(docs.get(id)[0].markdown, `((` + parent + ` '返回会议'))\n{: custom-meeting-navigation="parent"}\n`);
  }
  assert.equal(await meetingStore.readBodyMarkdown(parent), "**保留原始笔记**");
});
