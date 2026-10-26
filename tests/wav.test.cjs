"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { wavHeader, wavParts, readWavInfo } = require("../src/wav");

test("oversized stereo WAV requests cover all original frames and gap uploads contain only the selected channel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-wav-"));
  try {
    const file = path.join(dir, "synthetic.wav");
    const frames = 16000 * 1800;
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, wavHeader({ frames, channels: 2, sampleRate: 16000 }));
    fs.ftruncateSync(fd, 44 + frames * 4);
    const signal = Buffer.alloc(4);
    signal.writeInt16LE(1234, 0); signal.writeInt16LE(-5678, 2);
    fs.writeSync(fd, signal, 0, 4, 44 + 16000 * 4);
    fs.closeSync(fd);
    const intervals = [];
    for await (const part of wavParts(file)) {
      assert.ok(part.data.length <= 100000000);
      assert.equal(part.data.readUInt32LE(40), part.data.length - 44);
      assert.equal(part.partIndex, intervals.length);
      intervals.push([part.startMs, part.endMs, part.partCount]);
    }
    assert.equal(intervals[0][0], 0);
    assert.equal(intervals.at(-1)[1], readWavInfo(file).durationMs);
    assert.ok(intervals.every((part) => part[2] === intervals.length));
    for (let i = 1; i < intervals.length; i++) assert.equal(intervals[i - 1][1], intervals[i][0]);
    for await (const gap of wavParts(file, { startMs: 1000, endMs: 1000.0625, channel: 1 })) {
      assert.equal(gap.data.readUInt16LE(22), 1);
      assert.equal(gap.data.readInt16LE(44), -5678);
      assert.equal(gap.data.readUInt32LE(40), 2);
      assert.equal(gap.startMs, 1000);
      assert.equal(gap.endMs, 1000.0625);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
