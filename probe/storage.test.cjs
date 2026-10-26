const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { recover, finalizeInterrupted } = require("./storage.cjs");

// A later codec/container change must preserve recovery without the stop callback.
test("process termination recovers the appended PCM file without trusting the stale header", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-recovery-"));
  try {
    const child = spawn(process.execPath, ["-e", `
      const { RecordingStore } = require(process.argv[1]);
      const store = new RecordingStore(process.argv[2], 48000, 2);
      const samples = new Float32Array(96000);
      for (let i = 0; i < samples.length; i += 2) {
        samples[i] = .5; samples[i + 1] = -.25;
      }
      store.append(samples, 1000);
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `, path.join(__dirname, "storage.cjs"), root]);
    await once(child.stdout, "data");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const [recording] = recover(root);
    assert.equal(recording.meta.phase, "recording");
    assert.equal(recording.seconds, 1);
    finalizeInterrupted(recording.dir);
    const data = fs.readFileSync(recording.file);
    assert.equal(data.readUInt32LE(4), data.length - 8);
    assert.equal(data.readUInt16LE(22), 2);
    assert.equal(data.readUInt32LE(24), 48000);
    assert.equal(data.readInt16LE(44), 16384);
    assert.equal(data.readInt16LE(46), -8192);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
