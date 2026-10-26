const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function atomicWrite(file, data) {
  const temporary = file + ".tmp";
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function wav(samples, sampleRate, channels) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      ![1, 2].includes(channels) || samples.length % channels) throw new Error("无效的音频格式");
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return data;
}

class RecordingStore {
  constructor(root, sampleRate, channels) {
    this.dir = path.join(root, crypto.randomUUID());
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.meta = { version: 1, startedAt: new Date().toISOString(), sampleRate, channels,
      phase: "recording", frames: 0 };
    this.save();
    this.file = path.join(this.dir, "audio.wav");
    this.fd = fs.openSync(this.file, "wx+", 0o600);
    fs.writeFileSync(this.fd, wav(new Float32Array(), sampleRate, channels));
    fs.fsyncSync(this.fd);
  }
  save() { atomicWrite(path.join(this.dir, "recording.json"), JSON.stringify(this.meta)); }
  append(samples, wallStart) {
    const pcm = wav(samples, this.meta.sampleRate, this.meta.channels).subarray(44);
    const offset = 44 + this.meta.frames * this.meta.channels * 2;
    if (offset + pcm.length - 8 > 0xffffffff) throw new Error("本段已达到 WAV 文件大小上限，请结束后另建录音段");
    let written = 0;
    while (written < pcm.length) written += fs.writeSync(this.fd, pcm, written, pcm.length - written, offset + written);
    fs.fsyncSync(this.fd);
    fs.appendFileSync(path.join(this.dir, "timeline.jsonl"), JSON.stringify({
      wallStart, frames: samples.length / this.meta.channels, offsetFrames: this.meta.frames,
    }) + "\n");
    this.meta.frames += samples.length / this.meta.channels;
    this.save();
  }
  phase(phase) {
    if (phase === "saved") {
      this.meta.frames = repairHeader(this.fd, this.meta);
    }
    this.meta.phase = phase; this.save();
    if (phase === "saved") {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

function repairHeader(fd, meta) {
  const bytes = fs.fstatSync(fd).size - 44;
  const aligned = bytes - bytes % (meta.channels * 2);
  if (aligned < 0 || aligned + 36 > 0xffffffff) throw new Error("音频文件长度无效，保留原文件等待处理");
  const header = wav(new Float32Array(), meta.sampleRate, meta.channels);
  header.writeUInt32LE(aligned + 36, 4);
  header.writeUInt32LE(aligned, 40);
  fs.writeSync(fd, header, 0, 44, 0);
  fs.ftruncateSync(fd, aligned + 44);
  fs.fsyncSync(fd);
  return aligned / (meta.channels * 2);
}

function finalizeInterrupted(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "recording.json"), "utf8"));
  const fd = fs.openSync(path.join(dir, "audio.wav"), "r+");
  try { meta.frames = repairHeader(fd, meta); } finally { fs.closeSync(fd); }
  meta.phase = "saved";
  meta.interrupted = true;
  atomicWrite(path.join(dir, "recording.json"), JSON.stringify(meta));
}

function recover(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(entry => {
    const dir = path.join(root, entry.name);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "recording.json"), "utf8")); }
    catch (error) { return { dir, error: error.message }; }
    const file = path.join(dir, "audio.wav");
    try {
      const bytes = fs.statSync(file).size - 44;
      if (bytes < 0) throw new Error("音频文件头不完整");
      const frames = Math.floor(bytes / (2 * meta.channels));
      return { dir, file, meta, seconds: frames / meta.sampleRate };
    } catch (error) { return { dir, meta, error: error.message }; }
  });
}

module.exports = { RecordingStore, recover, finalizeInterrupted, wav };
