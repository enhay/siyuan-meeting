"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
  RecordingStore,
  recover,
  finalizeInterrupted,
  downsample,
} = require("../capture/storage.cjs");

test("process termination recovers appended PCM without trusting the stale header", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-capture-"));
  try {
    const child = spawn(process.execPath, [
      "-e",
      `
      const { RecordingStore } = require(process.argv[1]);
      const store = new RecordingStore({
        root: process.argv[2], sampleRate: 16000, channels: 2,
        meta: { meetingId: "meeting-1", docId: "doc-1", segmentNo: 0, recordingId: "rec-1" },
      });
      const samples = new Float32Array(16000 * 2);
      for (let i = 0; i < samples.length; i += 2) {
        samples[i] = 0.5; samples[i + 1] = -0.25;
      }
      store.append(samples, 1000, [0.5, 0.25]);
      store.addEvent({ type: "pause", elapsedMs: 1000 });
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
      `,
      path.join(__dirname, "..", "capture", "storage.cjs"),
      root,
    ]);
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const [recording] = recover(root);
    assert.equal(recording.meta.phase, "recording");
    assert.equal(recording.meta.meetingId, "meeting-1");
    assert.equal(recording.meta.recordingId, "rec-1");
    assert.equal(recording.seconds, 1);
    assert.equal(recording.meta.events[0].type, "pause");

    finalizeInterrupted(recording.dir);
    const data = fs.readFileSync(recording.file);
    assert.equal(data.readUInt32LE(4), data.length - 8);
    assert.equal(data.readUInt16LE(22), 2);
    assert.equal(data.readUInt32LE(24), 16000);
    assert.equal(data.readInt16LE(44), 16384);
    assert.equal(data.readInt16LE(46), -8192);
    assert.equal(JSON.parse(fs.readFileSync(path.join(recording.dir, "recording.json"))).interrupted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("peaks are downsampled by bucket maximum, not by averaging away a spike", () => {
  const points = [
    [0.1, 0.2],
    [0.9, 0.3],
    [0.2, 0.8],
    [0.05, 0.1],
  ];
  const result = downsample(points, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0][0], 0.9);
  assert.equal(result[1][1], 0.8);
});

test("a completed store writes peaks and closes its file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-complete-"));
  try {
    const store = new RecordingStore({
      root,
      sampleRate: 8000,
      channels: 1,
      meta: { meetingId: "m", docId: "d", recordingId: "r" },
    });
    store.append(new Float32Array(8000).fill(0.1), 1000, [0.1, 0]);
    store.phase("saved");
    const [recording] = recover(root);
    assert.equal(recording.meta.phase, "saved");
    assert.ok(recording.peaks);
    assert.equal(recording.peaks.points.length, 1);
    assert.equal(recording.seconds, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
