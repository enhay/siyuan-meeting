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

test("post-recording policy fills realtime gaps and transcribes whole recordings only without realtime", async () => {
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
  assert.deepEqual(jobs, []);
  prefs.autoTranscribe = true;
  await manager.afterRecording(meeting, offline);
  await manager.afterRecording(meeting, online);
  await manager.afterRecording(meeting, disabled);
  assert.deepEqual(jobs, [{ id: "online", gapsOnly: true }, { id: "disabled", gapsOnly: false }]);
});

test("configuration-only transcription state is distinguished from an actual failure on the persisted path", async (t) => {
  const { RealtimeTranscriber } = require("../capture/realtime.cjs");
  let report;
  const realtime = new RealtimeTranscriber({ service: "tencent", sampleRate: 16000, channels: 1, enabled: true, configured: false, emit: (value) => { report = value; } });
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

test("transcription acknowledges before IO, reports real work, and releases the job before publishing its saved or failed result", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const api = require("../src/siyuan-api");
  const tencent = require("../src/tencent");
  const { wavHeader } = require("../src/wav");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-progress-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "synthetic.wav");
  fs.writeFileSync(file, Buffer.concat([wavHeader({ frames: 1600, channels: 1, sampleRate: 16000 }), Buffer.alloc(3200)]));
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const asset = deferred(), recognition = deferred(), saving = deferred(), requested = deferred(), writing = deferred();
  const meeting = { id: "meeting" }, recording = { recordingId: "recording", assetPath: "assets/synthetic.wav", channels: 1 };
  const manager = new TranscriptionManager({ controller: { getPrefs: () => ({ transcriptionService: "tencent" }), recordTranscriptionFailure() {} } });
  manager.isConfigured = () => true;
  const events = [], persisted = {};
  manager.subscribe((event) => events.push({ ...event, running: manager.isRunning(recording.recordingId) }));
  t.mock.method(api, "resolveAssetPath", () => asset.promise);
  t.mock.method(store, "transcriptFingerprint", async () => "original");
  t.mock.method(store, "updateRecordingTranscription", async (_meeting, _id, patch) => Object.assign(persisted, patch));
  t.mock.method(store, "writeTranscript", async () => { writing.resolve(); await saving.promise; });
  t.mock.method(tencent, "flashRecognize", async (config) => {
    config.onUploadComplete();
    requested.resolve();
    await recognition.promise;
    return [{ startMs: 0, endMs: 100, speaker: 0, text: "合成结果" }];
  });
  const job = manager.start(meeting, recording);
  assert.equal(events[0].progress.phase, "preparing");
  assert.equal(events[0].running, true);
  asset.resolve(file);
  await requested.promise;
  const waiting = manager.statusFor(meeting.id, recording.recordingId);
  assert.equal(waiting.status, "processing");
  assert.deepEqual(waiting.progress, { phase: "recognizing", partIndex: 1, partCount: 1, completedParts: 0, rangeIndex: 1, rangeCount: 1 });
  recognition.resolve();
  await writing.promise;
  assert.equal(manager.statusFor(meeting.id, recording.recordingId).progress.phase, "saving");
  assert.equal(persisted.transcriptionStatus, "processing");
  saving.resolve();
  await job;
  assert.equal(persisted.transcriptionStatus, "done");
  assert.equal(events.at(-1).status, "done");
  assert.equal(events.at(-1).running, false);
  assert.equal(events.at(-1).progress.completedParts, 1);

  const error = tencent.serviceError(4004);
  t.mock.method(tencent, "flashRecognize", async () => { throw error; });
  await manager.start(meeting, recording);
  assert.equal(persisted.transcriptionStatus, "incomplete");
  assert.equal(events.at(-1).status, "incomplete");
  assert.equal(events.at(-1).error, error.userMessage);
  assert.equal(events.at(-1).running, false);
});
