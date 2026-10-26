"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function atomicWrite(file, data) {
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function wav(samples, sampleRate, channels) {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    ![1, 2].includes(channels) ||
    samples.length % channels
  ) {
    throw new Error("无效的音频格式");
  }
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return data;
}

function repairHeader(fd, meta) {
  const bytes = fs.fstatSync(fd).size - 44;
  const aligned = bytes - (bytes % (meta.channels * 2));
  if (aligned < 0 || aligned + 36 > 0xffffffff) {
    throw new Error("音频文件长度无效，保留原文件等待处理");
  }
  const header = wav(new Float32Array(), meta.sampleRate, meta.channels);
  header.writeUInt32LE(aligned + 36, 4);
  header.writeUInt32LE(aligned, 40);
  fs.writeSync(fd, header, 0, 44, 0);
  fs.ftruncateSync(fd, aligned + 44);
  fs.fsyncSync(fd);
  return aligned / (meta.channels * 2);
}

class RecordingStore {
  constructor({ root, sampleRate, channels, meta = {} }) {
    this.root = root;
    this.recordingId = meta.recordingId || crypto.randomUUID();
    this.dir = path.join(root, this.recordingId);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.meta = {
      version: 2,
      recordingId: this.recordingId,
      meetingId: meta.meetingId || "",
      docId: meta.docId || "",
      segmentNo: Number(meta.segmentNo || 0) || 0,
      startedAt: meta.startedAt || new Date().toISOString(),
      sampleRate,
      channels,
      phase: "recording",
      frames: 0,
      events: [],
    };
    this.levels = [];
    this.save();
    this.file = path.join(this.dir, "audio.wav");
    this.fd = fs.openSync(this.file, "wx+", 0o600);
    fs.writeFileSync(this.fd, wav(new Float32Array(), sampleRate, channels));
    fs.fsyncSync(this.fd);
    this.timelinePath = path.join(this.dir, "timeline.jsonl");
  }

  save() {
    atomicWrite(path.join(this.dir, "recording.json"), JSON.stringify(this.meta));
  }

  append(samples, wallStart, levels = null) {
    const pcm = wav(samples, this.meta.sampleRate, this.meta.channels).subarray(44);
    const offset = 44 + this.meta.frames * this.meta.channels * 2;
    if (offset + pcm.length - 8 > 0xffffffff) {
      throw new Error("这段录音已达到保存上限，请结束后补录");
    }
    let written = 0;
    while (written < pcm.length) {
      written += fs.writeSync(this.fd, pcm, written, pcm.length - written, offset + written);
    }
    fs.fsyncSync(this.fd);
    fs.appendFileSync(
      this.timelinePath,
      `${JSON.stringify({
        wallStart,
        frames: samples.length / this.meta.channels,
        offsetFrames: this.meta.frames,
      })}\n`,
    );
    if (Array.isArray(levels)) this.levels.push(levels);
    this.meta.frames += samples.length / this.meta.channels;
    this.save();
    // Persist a downsampled waveform regularly so a hard kill loses at most
    // half a minute of preview, while the PCM itself is already on disk.
    if (this.levels.length > 0 && this.levels.length % 30 === 0) {
      this.writePeaks();
    }
  }

  addEvent(event) {
    this.meta.events.push({ ...event, at: event.at || new Date().toISOString() });
    if (this.meta.events.length > 500) this.meta.events = this.meta.events.slice(-500);
    this.save();
  }

  writePeaks() {
    const points = this.levels.length
      ? downsample(this.levels, 3000)
      : [];
    atomicWrite(
      path.join(this.dir, "peaks.json"),
      JSON.stringify({
        version: 1,
        duration: this.meta.frames / this.meta.sampleRate,
        channels: this.meta.channels,
        points,
      }),
    );
    return points;
  }

  phase(phase) {
    if (phase === "saved") {
      this.meta.frames = repairHeader(this.fd, this.meta);
      this.meta.endedAt = new Date().toISOString();
      this.writePeaks();
    }
    this.meta.phase = phase;
    this.save();
    if (phase === "saved" && this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

function downsample(points, target) {
  if (points.length <= target) return points.map(([a, b]) => [round(a), round(b)]);
  const bucket = points.length / target;
  const out = [];
  for (let index = 0; index < target; index++) {
    const start = Math.floor(index * bucket);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucket));
    let mic = 0;
    let system = 0;
    for (let cursor = start; cursor < end && cursor < points.length; cursor++) {
      mic = Math.max(mic, Number(points[cursor][0]) || 0);
      system = Math.max(system, Number(points[cursor][1]) || 0);
    }
    out.push([round(mic), round(system)]);
  }
  return out;
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function readRecording(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "recording.json"), "utf8"));
  const file = path.join(dir, "audio.wav");
  let peaks = null;
  try {
    peaks = JSON.parse(fs.readFileSync(path.join(dir, "peaks.json"), "utf8"));
  } catch {
    // peaks are optional; a crashed recording may not have written them
  }
  try {
    const bytes = fs.statSync(file).size - 44;
    if (bytes < 0) throw new Error("录音文件不完整，已保留原文件");
    const frames = Math.floor(bytes / (2 * meta.channels));
    return { dir, file, meta, peaks, seconds: frames / meta.sampleRate };
  } catch (error) {
    return { dir, meta, peaks, error: error.message };
  }
}

function walk(root, depth = 0) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, "recording.json"))) {
      out.push(dir);
    } else if (depth < 2) {
      out.push(...walk(dir, depth + 1));
    }
  }
  return out;
}

function recover(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return walk(root)
    .map((dir) => {
      try {
        return readRecording(dir);
      } catch (error) {
        return { dir, error: error.message, meta: null };
      }
    })
    .sort((a, b) => String(a.meta?.startedAt || "").localeCompare(String(b.meta?.startedAt || "")));
}

function finalizeInterrupted(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "recording.json"), "utf8"));
  const fd = fs.openSync(path.join(dir, "audio.wav"), "r+");
  try {
    meta.frames = repairHeader(fd, meta);
  } finally {
    fs.closeSync(fd);
  }
  meta.phase = "saved";
  meta.interrupted = true;
  meta.endedAt = new Date().toISOString();
  atomicWrite(path.join(dir, "recording.json"), JSON.stringify(meta));
  return meta;
}

module.exports = {
  RecordingStore,
  recover,
  finalizeInterrupted,
  readRecording,
  wav,
  downsample,
};
