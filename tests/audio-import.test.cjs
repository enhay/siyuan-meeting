"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "siyuan" ? {} : load.call(this, name, ...args);
};
const { inspectAudio, importRecording } = require("../src/audio-import");
const api = require("../src/siyuan-api");
const store = require("../src/meeting-store");
const { parseIal } = require("../src/util");
Module._load = load;

function atom(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, data]);
}
function m4a(version = 0) {
  const header = Buffer.alloc(version ? 32 : 20);
  header[0] = version;
  header.writeUInt32BE(48000, version ? 20 : 12);
  if (version) header.writeBigUInt64BE(288000000n, 24);
  else header.writeUInt32BE(288000000, 16);
  return new File([atom("ftyp", Buffer.from("M4A \0\0\0\0")), atom("moov", atom("mvhd", header))], "语音备忘录.m4a");
}

// A later decode-based importer must not allocate the PCM for long Apple recordings.
test("M4A duration comes from versioned movie metadata and rejects truncated containers", async () => {
  for (const version of [0, 1]) assert.deepEqual(await inspectAudio(m4a(version)), { format: "m4a", seconds: 6000 });
  const file = m4a();
  await assert.rejects(inspectAudio(new File([await file.slice(0, file.size - 1).arrayBuffer()], file.name)));
  await assert.rejects(inspectAudio(new File(["not audio"], file.name)));
});

// Changes to recording serialization must keep imported originals usable after syncing.
test("import preserves uploaded bytes and reads back source, duration and original filename", async (t) => {
  const id = "20261029100000-abcdefg";
  const meetingAttrs = { [store.ATTR.id]: "meeting", [store.ATTR.status]: "draft" };
  const blocks = new Map();
  let uploaded;
  t.mock.method(api, "getDocMeta", async () => ({ id, content: "会议", box: "notebook" }));
  t.mock.method(api, "getBlockAttrs", async (blockId) => blockId === id ? meetingAttrs : blocks.get(blockId));
  t.mock.method(api, "setBlockAttrs", async (blockId, patch) => Object.assign(blockId === id ? meetingAttrs : blocks.get(blockId), patch));
  t.mock.method(api, "listChildDocs", async () => [{ id: "20261029100100-abcdefg" }]);
  t.mock.method(api, "listBlocksWithAttr", async () => [...blocks].map(([blockId, attrs]) => ({ id: blockId, attrs })));
  t.mock.method(api, "prependMarkdownRaw", async (_id, text) => {
    const attrs = parseIal(text);
    blocks.set(attrs.id, attrs);
  });
  t.mock.method(api, "post", async (endpoint, body) => {
    if (endpoint === "/api/asset/upload") {
      uploaded = new Uint8Array(await body.get("files[]").arrayBuffer());
      return { succMap: { "语音备忘录.m4a": "assets/语音备忘录.m4a" } };
    }
    return null;
  });
  const file = m4a();
  const ticket = { file };
  await importRecording({ id }, ticket);
  // A retry after the final meeting-attribute write must reuse the same recording.
  await importRecording({ id }, ticket);
  const { recordings } = await store.readRecordings({ id });
  assert.deepEqual(recordings.map(({ source, format, seconds, sampleRate, channels, assetPath, originalName, transcriptionStatus }) =>
    ({ source, format, seconds, sampleRate, channels, assetPath, originalName, transcriptionStatus })), [{
    source: "import", format: "m4a", seconds: 6000, sampleRate: 0, channels: 0,
    assetPath: "assets/语音备忘录.m4a", originalName: file.name, transcriptionStatus: "idle",
  }]);
  assert.equal(recordings[0].startedAt, "");
  assert.deepEqual(uploaded, new Uint8Array(await file.arrayBuffer()));
});
