"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === "siyuan") return {};
  return originalLoad.call(this, name, ...args);
};
const store = require("../src/meeting-store");
const tencent = require("../src/tencent");
const { TranscriptionManager } = require("../src/transcription");
Module._load = originalLoad;

test("retry after task-id persistence failure resumes the accepted cloud task", async () => {
  const memory = new Map();
  global.localStorage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const oldUpdate = store.updateRecordingTask, oldCreate = tencent.createRecTask;
  let submissions = 0, writes = 0, persisted;
  try {
    tencent.createRecTask = async () => ({ TaskId: String(++submissions) });
    store.updateRecordingTask = async (_meeting, _recording, taskId, status) => {
      if (++writes === 1) throw new Error("block write failed");
      persisted = { taskId, status };
    };
    const manager = new TranscriptionManager({ controller: { getPrefs: () => ({}) } });
    manager.config = () => ({ secretId: "synthetic", secretKey: "synthetic" });
    manager.sourceFor = async () => ({ sourceType: 1, data: Buffer.alloc(0) });
    const polled = [];
    manager.poll = async (_meeting, _recording, taskId) => polled.push(taskId);
    const recording = { recordingId: "synthetic-recording", sampleRate: 16000, channels: 1 };
    await manager.start({ id: "meeting" }, recording);
    assert.equal(persisted.taskId, "1");
    await manager.start({ id: "meeting" }, recording);
    assert.deepEqual(polled, ["1"]);
    assert.equal(persisted.taskId, "1");
    assert.equal(submissions, 1);
  } finally {
    store.updateRecordingTask = oldUpdate;
    tencent.createRecTask = oldCreate;
    delete global.localStorage;
  }
});
