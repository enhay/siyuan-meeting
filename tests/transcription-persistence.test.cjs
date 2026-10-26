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
const { TranscriptionManager } = require("../src/transcription");
Module._load = originalLoad;

test("restart marks interrupted local requests incomplete without submitting or changing another device", async () => {
  const manager = new TranscriptionManager({ controller: { getPrefs: () => ({}) } });
  const oldRead = store.readRecordings, oldUpdate = store.updateRecordingTranscription;
  const updates = [];
  try {
    store.readRecordings = async () => ({ recordings: [
      { recordingId: "mine", deviceId: manager.deviceId, transcriptionStatus: "processing" },
      { recordingId: "other", deviceId: "other-device", transcriptionStatus: "recording" },
    ] });
    store.updateRecordingTranscription = async (_meeting, id, patch) => updates.push({ id, status: patch.transcriptionStatus });
    manager.start = () => assert.fail("restart must never submit paid recognition");
    await manager.resumePending({ id: "meeting" });
    assert.deepEqual(updates, [{ id: "mine", status: "incomplete" }]);
  } finally { store.readRecordings = oldRead; store.updateRecordingTranscription = oldUpdate; }
});

test("post-recording policy distinguishes offline speakers, online gaps and disabled realtime", async () => {
  const prefs = { autoTranscribe: false };
  const manager = new TranscriptionManager({ controller: { getPrefs: () => prefs } });
  manager.isConfigured = () => true;
  const jobs = [];
  manager.start = async (_meeting, recording, options) => jobs.push({ id: recording.recordingId, gapsOnly: options?.gapsOnly || false });
  const meeting = { id: "meeting" };
  const offline = { recordingId: "offline", channels: 1, realtimeEnabled: true };
  const online = { recordingId: "online", channels: 2, realtimeEnabled: true, gaps: [{ channel: 1, startMs: 10, endMs: 20 }] };
  const disabled = { recordingId: "disabled", channels: 1, realtimeEnabled: false };
  await manager.afterRecording(meeting, offline);
  await manager.afterRecording(meeting, online);
  await manager.afterRecording(meeting, disabled);
  assert.deepEqual(jobs, [{ id: "offline", gapsOnly: false }]);
  prefs.autoTranscribe = true;
  await manager.afterRecording(meeting, online);
  await manager.afterRecording(meeting, disabled);
  assert.deepEqual(jobs.slice(1), [{ id: "online", gapsOnly: true }, { id: "disabled", gapsOnly: false }]);
});

test("configuration-only transcription state is distinguished from an actual failure on the persisted path", async (t) => {
  const { RealtimeTranscriber } = require("../capture/realtime.cjs");
  let report;
  const realtime = new RealtimeTranscriber({ sampleRate: 16000, channels: 1, enabled: true, configured: false, emit: (value) => { report = value; } });
  realtime.report();
  const persisted = {};
  t.mock.method(store, "updateRecordingTranscription", async (_meeting, _id, patch) => Object.assign(persisted, patch));
  const manager = new TranscriptionManager({ controller: { getPrefs: () => ({}) } });
  await manager.onRealtime({ id: "meeting" }, "recording", report);
  assert.equal(persisted.transcriptionIssue, "configuration-required");
  await manager.onRealtime({ id: "meeting" }, "recording", { status: "incomplete", error: "录音仍在保存，连接已中断", gaps: [] });
  assert.equal(persisted.transcriptionIssue, "");
  assert.equal(persisted.transcriptionStatus, "incomplete");
  assert.equal(persisted.transcriptionError, "录音仍在保存，连接已中断");
});
