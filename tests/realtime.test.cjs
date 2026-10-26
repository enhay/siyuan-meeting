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
    realtime = new RealtimeTranscriber({ sampleRate: 16000, channels: 1, enabled: true,
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
