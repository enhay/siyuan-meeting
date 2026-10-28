"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RealtimeTranscriber } = require("../capture/realtime.cjs");

test("a lost realtime acknowledgement becomes an audio-relative gap while pause time never enters the transcript", async () => {
  let now = 0, timerId = 0;
  const timers = new Map(), sockets = [], reports = [], sent = [];
  const originals = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval };
  Date.now = () => now;
  global.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; };
  global.setInterval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms, interval: ms }); return id; };
  global.clearTimeout = global.clearInterval = id => timers.delete(id);
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) {
      if (timer.interval) timer.at = now + timer.interval; else timers.delete(id);
      timer.fn();
    }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  class Socket {
    constructor() {
      this.readyState = 1; this.bufferedAmount = 0; this.endMs = 0; this.index = 0;
      sockets.push(this);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ code: 0 }) }));
    }
    send(data) {
      if (typeof data === "string") {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ code: 0, final: 1 }) }));
        return;
      }
      const start = this.endMs;
      this.endMs += data.byteLength / 32;
      sent.push({ at: now, duration: this.endMs - start });
      if (this === sockets[0]) return; // Connection loss before the first sentence is confirmed.
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ code: 0,
        result: { slice_type: 2, index: this.index++, start_time: start, end_time: this.endMs, voice_text_str: "确定句子" } }) }));
    }
    close() { this.readyState = 3; }
  }
  let realtime;
  try {
    realtime = new RealtimeTranscriber({ service: "tencent", sampleRate: 16000, channels: 1, enabled: true,
      configured: true, requestUrl: async () => "wss://synthetic", WebSocket: Socket,
      emit: report => reports.push(report) });
    realtime.push(new Float32Array(16000), 0);
    await advance(0); await advance(200);
    sockets[0].onerror();
    for (let i = 0; i < 12; i++) await advance(200);
    let paused = false;const pause = realtime.pause().then(() => { paused = true; });
    for (let i = 0; !paused && i < 50; i++) await advance(200);
    await pause;
    await advance(10000);
    realtime.resume();
    realtime.push(new Float32Array(16000), 1000);
    for (let i = 0; i < 8; i++) await advance(200);
    let ended = false;const finish = realtime.finish().then(() => { ended = true; });
    for (let i = 0; !ended && i < 50; i++) await advance(200);
    await finish;
    assert.deepEqual(reports.at(-1).gaps, [{ startMs: 0, endMs: 200, channel: 0 }]);
    const sentences = reports.flatMap(report => report.segments);
    assert.equal(sentences[0].startMs, 200);
    assert.equal(sentences.at(-1).endMs, 2000);
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= sent[i - 1].duration);
  } finally {
    realtime?.abort();
    Date.now = originals.now;
    for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) global[name] = originals[name];
  }
});

test("cleanup after a confirmed realtime finish preserves completion", async () => {
  const reports = [], audioPackets = [];
  class Socket {
    constructor() {
      this.readyState = 1;
      this.bufferedAmount = 0;
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ code: 0 }) }));
    }
    send(data) {
      if (typeof data !== "string") audioPackets.push(Buffer.from(data));
      const result = typeof data === "string"
        ? { code: 0, final: 1 }
        : { code: 0, result: { slice_type: 2, index: 0, start_time: 0, end_time: 200, voice_text_str: "确认内容" } };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(result) }));
    }
    close() { this.readyState = 3; }
  }
  const realtime = new RealtimeTranscriber({ service: "tencent", sampleRate: 16000, channels: 2,
    enabled: true, configured: true, requestUrl: async () => "wss://synthetic",
    WebSocket: Socket, emit: report => reports.push(report) });
  const samples = Float32Array.from({ length: 3200 * 2 }, (_, index) => index % 2 ? -0.2 : 0.6);
  realtime.push(samples, 0);
  await realtime.finish();
  assert.deepEqual(audioPackets.map((packet) => [packet.length, packet.readInt16LE(0)]), [[6400, 6553]]);
  assert.equal(reports.at(-1).status, "done");
  realtime.abort();
  assert.equal(reports.at(-1).status, "done");
  assert.deepEqual(reports.at(-1).gaps, []);
});

test("text still being recognised reaches captions but never the persisted transcript", async () => {
  const reports = [], captions = [];
  class Socket {
    constructor() {
      this.readyState = 1;
      this.bufferedAmount = 0;
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ code: 0 }) }));
    }
    send(data) {
      const results = typeof data === "string" ? [{ code: 0, final: 1 }] : [
        { code: 0, result: { slice_type: 1, index: 0, start_time: 0, end_time: 100, voice_text_str: "预算" } },
        { code: 0, result: { slice_type: 2, index: 0, start_time: 0, end_time: 200, voice_text_str: "预算已确认" } },
      ];
      for (const result of results) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(result) }));
    }
    close() { this.readyState = 3; }
  }
  const realtime = new RealtimeTranscriber({ service: "tencent", sampleRate: 16000, channels: 1, enabled: true, configured: true,
    requestUrl: async () => "wss://synthetic", WebSocket: Socket,
    emit: report => reports.push(report), caption: caption => captions.push(caption) });
  realtime.push(new Float32Array(3200), 0);
  await realtime.finish();
  assert.deepEqual(reports.flatMap(report => report.segments).map(segment => segment.text), ["预算已确认"]);
  assert.deepEqual(captions.map(caption => [caption.text, caption.final]), [["预算", false], ["预算已确认", true]]);
});

test("doubao frames become audio-relative sentences with speakers even when the service omits a zero start time", async () => {
  const zlib = require("node:zlib");
  const reply = (flags, sequence, payload) => {
    const body = zlib.gzipSync(JSON.stringify(payload));
    const head = Buffer.alloc(sequence === null ? 8 : 12);
    head.set([0x11, 0x90 | flags, 0x11, 0]);
    if (sequence !== null) head.writeInt32BE(sequence, 4);
    head.writeUInt32BE(body.length, head.length - 4);
    const frame = Buffer.concat([head, body]);
    return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length);
  };
  const reports = [], captions = [];
  let sentRequest;
  class Socket {
    constructor() {
      this.readyState = 1;
      this.bufferedAmount = 0;
      queueMicrotask(() => this.onopen?.());
    }
    send(frame) {
      const type = frame[1] >> 4, flags = frame[1] & 15;
      if (type === 1) sentRequest = JSON.parse(zlib.gunzipSync(frame.subarray(8)).toString());
      // Shapes observed from the live service on 2026-10-26.
      const replies = type === 1 ? [reply(0, null, { result: { text: "" } })]
        : flags === 2 ? [reply(3, 3, { audio_info: { duration: 200 }, result: { text: "" } })]
          : [reply(1, 1, { result: { utterances: [{ definite: false, end_time: 100, text: "预算" }] } }),
            reply(1, 2, { result: { utterances: [{ definite: true, end_time: 180, text: "预算已确认。", additions: { speaker_id: "1" } }] } })];
      for (const data of replies) queueMicrotask(() => this.onmessage?.({ data }));
    }
    close() { this.readyState = 3; }
  }
  const realtime = new RealtimeTranscriber({ service: "doubao", sampleRate: 16000, channels: 1, enabled: true,
    ...require("../src/hotwords").doubaoCorpus(["星河"]),
    configured: true, requestUrl: async () => "wss://synthetic", WebSocket: Socket,
    emit: report => reports.push(report), caption: caption => captions.push(caption) });
  realtime.push(new Float32Array(3200), 500);
  await realtime.finish();
  assert.deepEqual(reports.flatMap(report => report.segments).map(({ startMs, endMs, speakerLabel, text }) => ({ startMs, endMs, speakerLabel, text })),
    [{ startMs: 500, endMs: 680, speakerLabel: "说话人 2", text: "预算已确认。" }]);
  assert.deepEqual(captions.map(caption => [caption.text, caption.final]), [["预算", false], ["预算已确认。", true]]);
  assert.equal(reports.at(-1).status, "done");
  assert.deepEqual(JSON.parse(sentRequest.request.corpus.context).hotwords, [{ word: "星河" }]);
  assert.deepEqual(reports.at(-1).gaps, []);
});
