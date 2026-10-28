"use strict";

const fs = require("node:fs");

const path = require("node:path");
const HEADER_BYTES = 44;

function invalidAudio() {
  return new Error("录音文件不完整或无法读取，请重新归档录音后再试");
}

function readExact(fd, buffer, position) {
  let used = 0;
  while (used < buffer.length) {
    const count = fs.readSync(fd, buffer, used, buffer.length - used, position + used);
    if (!count) throw invalidAudio();
    used += count;
  }
  return buffer;
}

function readWavInfo(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < HEADER_BYTES) throw invalidAudio();
    const root = readExact(fd, Buffer.alloc(12), 0);
    if (root.toString("ascii", 0, 4) !== "RIFF" || root.toString("ascii", 8, 12) !== "WAVE") {
      throw invalidAudio();
    }
    const limit = root.readUInt32LE(4) + 8;
    if (limit > stat.size || limit < HEADER_BYTES) throw invalidAudio();
    let format = null;
    let dataOffset = null;
    let dataBytes = 0;
    for (let offset = 12; offset + 8 <= limit;) {
      const chunk = readExact(fd, Buffer.alloc(8), offset);
      const name = chunk.toString("ascii", 0, 4);
      const bytes = chunk.readUInt32LE(4);
      if (offset + 8 + bytes > limit) throw invalidAudio();
      if (name === "fmt ") {
        if (format || bytes < 16) throw invalidAudio();
        const value = readExact(fd, Buffer.alloc(16), offset + 8);
        format = {
          encoding: value.readUInt16LE(0),
          channels: value.readUInt16LE(2),
          sampleRate: value.readUInt32LE(4),
          byteRate: value.readUInt32LE(8),
          blockAlign: value.readUInt16LE(12),
          bitsPerSample: value.readUInt16LE(14),
        };
      } else if (name === "data") {
        if (dataOffset !== null) throw invalidAudio();
        dataOffset = offset + 8;
        dataBytes = bytes;
      }
      offset += 8 + bytes + (bytes % 2);
    }
    if (!format || dataOffset === null || !dataBytes) throw invalidAudio();
    const { encoding, channels, sampleRate, byteRate, blockAlign, bitsPerSample } = format;
    if (encoding !== 1 || bitsPerSample !== 16 || ![1, 2].includes(channels) ||
        ![8000, 16000].includes(sampleRate) || blockAlign !== channels * 2 ||
        byteRate !== sampleRate * blockAlign || dataBytes % blockAlign) {
      throw new Error("这份录音暂不支持转写，请使用会议录音功能保存的原始录音");
    }
    const frames = dataBytes / blockAlign;
    return { channels, sampleRate, blockAlign, dataOffset, dataBytes, frames,
      durationMs: frames * 1000 / sampleRate };
  } finally {
    fs.closeSync(fd);
  }
}

function wavHeader({ frames, channels, sampleRate }) {
  const dataBytes = frames * channels * 2;
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error("已取消转写");
    error.name = "AbortError";
    throw error;
  }
}

/** Write mono requests incrementally; the archived source is never changed. */
async function* wavParts(file, { startMs = 0, endMs, signal, directory, prefix = "part", maxBytes, maxSeconds = 5 * 3600 } = {}) {
  checkAbort(signal);
  const info = readWavInfo(file);
  if (info.sampleRate !== 16000) throw new Error("请使用会议插件保存的 16 kHz 原录音进行识别");
  const end = endMs === undefined ? info.durationMs : Number(endMs);
  const start = Number(startMs);
  if (!directory || !/^[a-z0-9-]+$/.test(prefix) || !Number.isSafeInteger(maxBytes) || maxBytes <= HEADER_BYTES ||
      !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
      start > info.durationMs || end > info.durationMs + 1 / info.sampleRate * 1000) {
    throw new Error("所选转写时段无效，请重新选择录音后再试");
  }
  const framesPerPart = Math.min(Math.floor((maxBytes - HEADER_BYTES) / 2), maxSeconds * info.sampleRate);
  const firstFrame = Math.round(start / 1000 * info.sampleRate);
  const finalFrame = Math.min(info.frames, Math.round(end / 1000 * info.sampleRate));
  const partCount = Math.ceil((finalFrame - firstFrame) / framesPerPart);
  const handle = await fs.promises.open(file, "r");
  try {
    let partIndex = 0;
    for (let frame = firstFrame; frame < finalFrame; frame += framesPerPart) {
      checkAbort(signal);
      const frames = Math.min(framesPerPart, finalFrame - frame);
      const output = path.join(directory, `${prefix}-${partIndex}.wav`);
      const target = await fs.promises.open(output, "w", 0o600);
      try {
        await target.writeFile(wavHeader({ frames, channels: 1, sampleRate: info.sampleRate }));
        const framesPerRead = Math.floor(1024 * 1024 / info.blockAlign);
        const source = Buffer.allocUnsafe(Math.min(frames, framesPerRead) * info.blockAlign);
        const mono = Buffer.allocUnsafe(Math.min(frames, framesPerRead) * 2);
        for (let consumed = 0; consumed < frames;) {
          checkAbort(signal);
          const count = Math.min(framesPerRead, frames - consumed);
          const bytes = count * info.blockAlign;
          let read = 0;
          while (read < bytes) {
            const result = await handle.read(source, read, bytes - read, info.dataOffset + (frame + consumed) * info.blockAlign + read);
            if (!result.bytesRead) throw invalidAudio();
            read += result.bytesRead;
          }
          for (let index = 0; index < count; index++) {
            const left = source.readInt16LE(index * info.blockAlign);
            const sample = info.channels === 1 ? left : Math.round((left + source.readInt16LE(index * info.blockAlign + 2)) / 2);
            mono.writeInt16LE(sample, index * 2);
          }
          await target.writeFile(mono.subarray(0, count * 2));
          consumed += count;
        }
      } finally { await target.close(); }
      yield { file: output, startMs: frame * 1000 / info.sampleRate, endMs: (frame + frames) * 1000 / info.sampleRate,
        partIndex: partIndex++, partCount, channels: 1, sampleRate: info.sampleRate };
    }
  } finally { await handle.close(); }
}

module.exports = { readWavInfo, wavParts, wavHeader };
