"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const vm = require("node:vm");

function captureHarness(root, online) {
  const filename = path.join(__dirname, "..", "capture", "capture.js");
  const captureRequire = createRequire(filename);
  const messages = [], timers = new Map();
  let processor, now = 0, timerId = 0;
  const window = { addEventListener() {} };
  const node = () => ({ connect() {}, disconnect() {} });
  const stream = () => {
    const track = { stop() {} };
    return { getAudioTracks: () => [track], getTracks: () => [track], getVideoTracks: () => [] };
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    require: (name) => name === "electron"
      ? { ipcRenderer: { on() {}, send: (_channel, message) => messages.push(message) } }
      : captureRequire(name),
    process, URLSearchParams, location: { search: "?channel=test" }, window,
    navigator: { mediaDevices: {
      getUserMedia: async () => stream(), getDisplayMedia: async () => stream(), addEventListener() {},
    } },
    MediaStream: class {},
    AudioContext: class {
      sampleRate = 16000;
      audioWorklet = { addModule: async () => {} };
      async resume() {}
      async close() {}
      createChannelMerger() { return node(); }
      createMediaStreamSource() { return node(); }
      createGain() { return { ...node(), gain: {} }; }
    },
    AudioWorkletNode: class {
      constructor() {
        processor = this;
        this.port = { postMessage: (message) => {
          if (message === "flush") queueMicrotask(() => this.port.onmessage({ data: { flushed: true } }));
        } };
      }
      connect() {}
      disconnect() {}
    },
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  }, { filename });
  const channels = online ? 2 : 1;
  return {
    window,
    start: () => window.meetingStart({ online, storage: root, meta: { recordingId: "recording", segmentNo: 0 },
      realtime: { service: "tencent", enabled: false } }),
    state: () => messages.filter((message) => message.type === "state").at(-1),
    meta: () => JSON.parse(fs.readFileSync(path.join(root, "recording", "recording.json"), "utf8")),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    },
    chunk(mic = 0, system = 0) {
      const samples = new Float32Array(16000 * channels);
      for (let frame = 0; frame < 16000; frame++) {
        samples[frame * channels] = mic;
        if (online) samples[frame * channels + 1] = system;
      }
      processor.port.onmessage({ data: { samples, frames: 16000,
        peaks: [Math.abs(mic), Math.abs(system)], rms: [Math.abs(mic), Math.abs(system)] } });
      this.advance(1000);
    },
    emptyChunk() {
      processor.port.onmessage({ data: { samples: new Float32Array(), frames: 0, peaks: [0, 0], rms: [0, 0] } });
    },
  };
}

// Device verification must not reintroduce a speech/peak requirement into startup.
test("capture accepts silent PCM on start, resume and reconnect while still rejecting missing data", async () => {
  for (const online of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-silent-start-"));
    const capture = captureHarness(root, online);
    try {
      await capture.start();
      capture.chunk();
      assert.equal(capture.state().phase, "recording");
      for (let second = 1; second < 65; second++) capture.chunk();
      assert.equal(capture.state().phase, "recording");
      assert.equal(capture.meta().frames, 65 * 16000);
      capture.chunk(0.25);
      assert.equal(capture.state().phase, "recording");

      await capture.window.meetingPause();
      assert.equal(capture.meta().phase, "paused");
      await capture.window.meetingResume();
      for (let second = 0; second < 20; second++) capture.chunk();
      assert.equal(capture.state().phase, "recording");
      await capture.window.meetingReconnect();
      for (let second = 0; second < 20; second++) capture.chunk();
      assert.equal(capture.state().phase, "recording");
      capture.chunk(0.125, 0.25);
      await capture.window.meetingStop();

      const meta = capture.meta();
      assert.equal(meta.phase, "saved");
      assert.equal(meta.channels, online ? 2 : 1);
      assert.equal(meta.frames, 107 * 16000);
      const wav = fs.readFileSync(path.join(root, "recording", "audio.wav"));
      assert.equal(wav.readInt16LE(44), 0);
      const micOnlyOffset = 44 + 65 * 16000 * meta.channels * 2;
      assert.equal(wav.readInt16LE(micOnlyOffset), 8192);
      if (online) assert.equal(wav.readInt16LE(micOnlyOffset + 2), 0);
      const lastFrame = wav.length - meta.channels * 2;
      assert.equal(wav.readInt16LE(lastFrame), 4096);
      if (online) assert.equal(wav.readInt16LE(lastFrame + 2), 8192);
    } finally {
      await capture.window.meetingStop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-missing-data-"));
  const capture = captureHarness(root, true);
  try {
    await capture.start();
    capture.emptyChunk();
    capture.advance(20000);
    assert.equal(capture.state().phase, "error");
    assert.equal(capture.meta().frames, 0);
  } finally {
    await capture.window.meetingStop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
