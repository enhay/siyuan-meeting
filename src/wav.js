"use strict";

const fs = require("node:fs");

// Tencent flash ASR accepts at most 100 MB and two hours per request.
const MAX_FILE_BYTES = 100000000;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
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

/** Produce complete WAV requests, keeping offsets on the original audio timeline. */
async function* wavParts(file, { startMs = 0, endMs, channel = null, signal } = {}) {
  checkAbort(signal);
  const info = readWavInfo(file);
  const end = endMs === undefined ? info.durationMs : Number(endMs);
  const start = Number(startMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
      start > info.durationMs || end > info.durationMs + 1 / info.sampleRate * 1000 ||
      (channel !== null && (!Number.isInteger(channel) || channel < 0 || channel >= info.channels))) {
    throw new Error("所选转写时段无效，请重新选择录音后再试");
  }
  const outputChannels = channel === null ? info.channels : 1;
  const outputAlign = outputChannels * 2;
  const framesPerPart = Math.min(
    Math.floor((MAX_FILE_BYTES - HEADER_BYTES) / outputAlign),
    MAX_DURATION_SECONDS * info.sampleRate,
  );
  const firstFrame = Math.round(start / 1000 * info.sampleRate);
  const finalFrame = Math.min(info.frames, Math.round(end / 1000 * info.sampleRate));
  const partCount = Math.ceil((finalFrame - firstFrame) / framesPerPart);
  const handle = await fs.promises.open(file, "r");
  try {
    let partIndex = 0;
    for (let frame = firstFrame; frame < finalFrame; frame += framesPerPart) {
      checkAbort(signal);
      const frames = Math.min(framesPerPart, finalFrame - frame);
      const data = Buffer.allocUnsafe(HEADER_BYTES + frames * outputAlign);
      wavHeader({ frames, channels: outputChannels, sampleRate: info.sampleRate }).copy(data);
      // A channel-only gap must not upload or bill the other channel. Read the
      // source in bounded blocks instead of allocating a second full request.
      const framesPerRead = Math.floor(1024 * 1024 / info.blockAlign);
      const source = Buffer.allocUnsafe(Math.min(frames, framesPerRead) * info.blockAlign);
      for (let consumed = 0; consumed < frames;) {
        checkAbort(signal);
        const count = Math.min(framesPerRead, frames - consumed);
        const bytes = count * info.blockAlign;
        let read = 0;
        while (read < bytes) {
          const result = await handle.read(source, read, bytes - read,
            info.dataOffset + (frame + consumed) * info.blockAlign + read);
          if (!result.bytesRead) throw invalidAudio();
          read += result.bytesRead;
        }
        if (channel === null) {
          source.copy(data, HEADER_BYTES + consumed * outputAlign, 0, bytes);
        } else {
          for (let index = 0; index < count; index++) {
            data.writeInt16LE(source.readInt16LE(index * info.blockAlign + channel * 2),
              HEADER_BYTES + (consumed + index) * 2);
          }
        }
        consumed += count;
      }
      checkAbort(signal);
      yield { data, startMs: frame * 1000 / info.sampleRate,
        endMs: (frame + frames) * 1000 / info.sampleRate, channel, partIndex: partIndex++, partCount,
        channels: outputChannels, sampleRate: info.sampleRate };
    }
  } finally {
    await handle.close();
  }
}

module.exports = { MAX_FILE_BYTES, MAX_DURATION_SECONDS, readWavInfo, wavParts, wavHeader };
