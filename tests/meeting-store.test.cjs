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
