"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === "siyuan") return {};
  return originalLoad.call(this, name, ...args);
};
const store = require("../src/meeting-store");
const { TranscriptionManager } = require("../src/transcription");
Module._load = originalLoad;

test("restart marks interrupted local requests incomplete without submitting or changing another device", async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-restart-"));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const manager = new TranscriptionManager({ controller: { storageRoot, getPrefs: () => ({}) } });
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

test("post-recording policy fills only realtime gaps and leaves full recognition to the user", async () => {
  const prefs = { autoFillGaps: false };
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
  prefs.autoFillGaps = true;
  await manager.afterRecording(meeting, offline);
  await manager.afterRecording(meeting, online);
  await manager.afterRecording(meeting, disabled);
  assert.deepEqual(jobs, [{ id: "online", gapsOnly: true }]);
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
  const manager = new TranscriptionManager({ controller: { storageRoot: dir, getPrefs: () => ({ transcriptionService: "tencent", cosEndpoint: "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com" }), recordTranscriptionFailure() {} } });
  manager.isConfigured = () => true;
  manager.isFileConfigured = () => true;
  const cloud = require("../src/cloud");
  t.mock.method(cloud, "upload", async () => {});
  t.mock.method(cloud, "downloadUrl", () => "https://synthetic.invalid/audio.wav");
  t.mock.method(cloud, "remove", async () => {});
  t.mock.method(tencent, "submit", async () => "12345");
  const events = [], persisted = {};
  manager.subscribe((event) => events.push({ ...event, running: manager.isRunning(recording.recordingId) }));
  t.mock.method(api, "resolveAssetPath", () => asset.promise);
  t.mock.method(store, "transcriptFingerprint", async () => "original");
  t.mock.method(store, "updateRecordingTranscription", async (_meeting, _id, patch) => Object.assign(persisted, patch));
  t.mock.method(store, "writeTranscript", async () => { writing.resolve(); await saving.promise; });
  t.mock.method(tencent, "query", async () => {
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
  assert.deepEqual(waiting.progress, { phase: "recognizing", partCount: 1, completedParts: 0 });
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
  t.mock.method(tencent, "submit", async () => { throw error; });
  await manager.start(meeting, recording);
  assert.equal(persisted.transcriptionStatus, "incomplete");
  assert.equal(events.at(-1).status, "incomplete");
  assert.equal(events.at(-1).error, error.userMessage);
  assert.equal(events.at(-1).running, false);
});

test("restart queries the submitted task and retries COS cleanup without resubmitting or rewriting saved text", async (t) => {
  const cloud = require("../src/cloud");
  const api = require("../src/siyuan-api");
  const tencent = require("../src/tencent");
  const { wavHeader } = require("../src/wav");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-cloud-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "source.wav");
  const source = Buffer.concat([wavHeader({ frames: 1600, channels: 2, sampleRate: 16000 }), Buffer.alloc(6400)]);
  fs.writeFileSync(file, source);
  const plugin = { controller: { storageRoot: root, recordTranscriptionFailure() {}, getPrefs: () => ({ transcriptionService: "tencent", cosEndpoint: "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com" }) } };
  const create = () => { const manager = new TranscriptionManager(plugin); manager.isFileConfigured = () => true; return manager; };
  const meeting = { id: "meeting" }, recording = { recordingId: "audio", assetPath: "assets/source.wav", channels: 2 };
  const calls = [], persisted = {};
  t.mock.method(api, "resolveAssetPath", async () => file);
  t.mock.method(store, "transcriptFingerprint", async () => "old");
  t.mock.method(store, "updateRecordingTranscription", async (_m, _r, patch) => Object.assign(persisted, patch));
  t.mock.method(cloud, "upload", async (_c, _key, audio) => {
    assert.equal(require("../src/wav").readWavInfo(audio).channels, 1);
  });
  t.mock.method(cloud, "downloadUrl", () => "https://synthetic.invalid/audio.wav");
  t.mock.method(tencent, "submit", async () => { calls.push("submit"); return "1245"; });
  t.mock.method(tencent, "query", async () => { throw cloud.failure("连接中断"); });
  t.mock.method(store, "writeTranscript", async () => { calls.push("save"); });
  t.mock.method(cloud, "remove", async () => { throw cloud.failure("清理失败"); });
  let manager = create();
  await manager.start(meeting, recording);
  assert.equal(manager.readJob(meeting.id, recording.recordingId).parts[0].taskId, "1245");
  assert.equal(persisted.transcriptionStatus, "incomplete");
  manager = create();
  t.mock.method(tencent, "query", async (_c, id) => {
    calls.push(`query:${id}`);
    return [{ startMs: 0, endMs: 100, channel: 0, speaker: 1, text: "预算确认", speakerLabel: "说话人 2" }];
  });
  await manager.start(meeting, recording, { resume: true, queryOnly: true });
  assert.equal(persisted.transcriptionStatus, "done");
  assert.equal(manager.readJob(meeting.id, recording.recordingId).saved, true);
  assert.equal(manager.statusFor(meeting.id, recording.recordingId).progress.phase, "cleanup-failed");
  t.mock.method(cloud, "remove", async () => { calls.push("delete"); });
  manager = create();
  await manager.start(meeting, recording, { resume: true, queryOnly: true });
  assert.deepEqual(calls, ["submit", "query:1245", "save", "delete"]);
  assert.equal(manager.readJob(meeting.id, recording.recordingId), null);
  assert.equal(persisted.transcriptionError, "");
  assert.deepEqual(fs.readFileSync(file), source);
});

test("a lost submit response stays uncertain and reopening never resubmits audio", async (t) => {
  const cloud = require("../src/cloud");
  const api = require("../src/siyuan-api");
  const tencent = require("../src/tencent");
  const { wavHeader } = require("../src/wav");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-unknown-submit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "source.wav");
  fs.writeFileSync(file, Buffer.concat([wavHeader({ frames: 1600, channels: 1, sampleRate: 16000 }), Buffer.alloc(3200)]));
  const manager = new TranscriptionManager({ controller: { storageRoot: root, recordTranscriptionFailure() {}, getPrefs: () => ({ transcriptionService: "tencent", cosEndpoint: "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com" }) } });
  manager.isFileConfigured = () => true;
  const meeting = { id: "meeting" }, recording = { recordingId: "audio", assetPath: "assets/source.wav" };
  t.mock.method(api, "resolveAssetPath", async () => file);
  t.mock.method(store, "transcriptFingerprint", async () => "old");
  t.mock.method(store, "updateRecordingTranscription", async () => {});
  t.mock.method(cloud, "upload", async () => {});
  t.mock.method(cloud, "downloadUrl", () => "https://synthetic.invalid/audio.wav");
  t.mock.method(tencent, "submit", async () => { throw cloud.failure("连接中断"); });
  await manager.start(meeting, recording);
  t.mock.method(tencent, "submit", async () => assert.fail("must not repeat an uncertain billable request"));
  t.mock.method(cloud, "remove", async () => assert.fail("must not delete audio while its recognition outcome is unknown"));
  await manager.start(meeting, recording, { resume: true, queryOnly: true });
  assert.equal(manager.readJob(meeting.id, recording.recordingId).parts[0].stage, "submitting");
  assert.equal(manager.statusFor(meeting.id, recording.recordingId).status, "incomplete");
});

test("saved recognition results survive a document outage without a second recognition request", async (t) => {
  const cloud = require("../src/cloud");
  const api = require("../src/siyuan-api");
  const tencent = require("../src/tencent");
  const { wavHeader } = require("../src/wav");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-save-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "source.wav");
  fs.writeFileSync(file, Buffer.concat([wavHeader({ frames: 1600, channels: 1, sampleRate: 16000 }), Buffer.alloc(3200)]));
  const manager = new TranscriptionManager({ controller: { storageRoot: root, recordTranscriptionFailure() {}, getPrefs: () => ({ transcriptionService: "tencent", cosEndpoint: "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com" }) } });
  manager.isFileConfigured = () => true;
  const meeting = { id: "meeting" }, recording = { recordingId: "audio", assetPath: "assets/source.wav" };
  t.mock.method(api, "resolveAssetPath", async () => file);
  t.mock.method(store, "transcriptFingerprint", async () => "old");
  t.mock.method(store, "updateRecordingTranscription", async () => {});
  t.mock.method(cloud, "upload", async () => {});
  t.mock.method(cloud, "downloadUrl", () => "https://synthetic.invalid/audio.wav");
  t.mock.method(tencent, "submit", async () => "12345");
  const segments = [{ startMs: 0, endMs: 100, channel: 0, speaker: 0, text: "确认内容" }];
  t.mock.method(tencent, "query", async () => segments);
  t.mock.method(store, "writeTranscript", async () => { throw new Error("document offline"); });
  t.mock.method(cloud, "remove", async () => assert.fail("must retain audio until text is saved"));
  await manager.start(meeting, recording);
  assert.deepEqual(manager.readJob(meeting.id, recording.recordingId).parts[0].segments, segments);
  t.mock.method(tencent, "submit", async () => assert.fail("already recognized"));
  t.mock.method(tencent, "query", async () => assert.fail("result is local"));
  let saved;
  t.mock.method(store, "writeTranscript", async (_m, _r, result) => { saved = result; });
  t.mock.method(cloud, "remove", async () => {});
  await manager.start(meeting, recording, { resume: true, queryOnly: true });
  assert.deepEqual(saved, segments);
  assert.equal(manager.statusFor(meeting.id, recording.recordingId).status, "done");
});

test("realtime AppId is discovered once per credential and refreshed after changing credentials", async (t) => {
  const tencent = require("../src/tencent");
  let key = "first-secret";
  const manager = new TranscriptionManager({ controller: { getPrefs: () => ({}) },
    getSecret: (name) => name === "meeting.tencent.secretId" ? "AKIDSYNTHETIC" : key });
  const seen = [];
  t.mock.method(tencent, "getAppId", async (config) => { seen.push(config.secretKey); return config.secretKey === "first-secret" ? "12345" : "67890"; });
  const [first, second] = await Promise.all([manager.realtimeConfig(), manager.realtimeConfig()]);
  assert.equal(first.appId, "12345");
  assert.equal(second.appId, "12345");
  key = "second-secret";
  assert.equal((await manager.realtimeConfig()).appId, "67890");
  assert.deepEqual(seen, ["first-secret", "second-secret"]);
});
