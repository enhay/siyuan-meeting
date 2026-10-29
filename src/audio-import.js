"use strict";

const { Dialog, showMessage } = require("siyuan");
const api = require("./siyuan-api");
const store = require("./meeting-store");
const { randomUUID, isAssetPath, formatSeconds } = require("./util");

function audioFormat(name) {
  const format = String(name).split(".").pop().toLowerCase();
  if (!["m4a", "mp3", "wav"].includes(format)) throw new Error("请选择 M4A、MP3 或 WAV 录音文件");
  return format;
}

// Read container metadata without decoding hours of Apple Voice Memos into RAM.
async function m4aDuration(file) {
  async function scan(start, end, inMoov = false) {
    for (let offset = start; offset + 8 <= end;) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + 40, end)).arrayBuffer());
      const view = new DataView(bytes.buffer);
      const type = String.fromCharCode(...bytes.slice(4, 8));
      let size = view.getUint32(0), header = 8;
      if (size === 1) {
        if (bytes.length < 16) throw new Error("M4A 文件不完整");
        size = Number(view.getBigUint64(8));
        header = 16;
      } else if (size === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error("M4A 文件不完整");
      if (type === "moov" && !inMoov) return scan(offset + header, offset + size, true);
      if (type === "mvhd" && inMoov) {
        const data = new DataView(await file.slice(offset + header, offset + Math.min(size, header + 32)).arrayBuffer());
        if (!data.byteLength) throw new Error("M4A 时长信息无效");
        const version = data.getUint8(0);
        if (![0, 1].includes(version) || data.byteLength < (version ? 32 : 20)) throw new Error("M4A 时长信息无效");
        const scale = data.getUint32(version ? 20 : 12);
        const duration = version ? Number(data.getBigUint64(24)) : data.getUint32(16);
        const seconds = duration / scale;
        if (Number.isFinite(seconds) && seconds > 0) return seconds;
        throw new Error("M4A 时长信息无效");
      }
      offset += size;
    }
    throw new Error("无法读取 M4A 时长，请从语音备忘录重新导出录音");
  }
  return scan(0, file.size);
}

async function inspectAudio(file) {
  const format = audioFormat(file.name);
  if (!file.size) throw new Error("这份录音是空文件");
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = (start, end) => String.fromCharCode(...head.slice(start, end));
  const valid = format === "m4a" ? text(4, 8) === "ftyp"
    : format === "wav" ? text(0, 4) === "RIFF" && text(8, 12) === "WAVE"
      : text(0, 3) === "ID3" || (head[0] === 255 && (head[1] & 224) === 224);
  if (!valid) throw new Error("录音内容与扩展名不一致，请选择原始音频文件");
  if (format === "m4a") return { format, seconds: await m4aDuration(file) };
  const url = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  try {
    const seconds = await new Promise((resolve, reject) => {
      audio.preload = "metadata";
      audio.onloadedmetadata = () => Number.isFinite(audio.duration) && audio.duration > 0
        ? resolve(audio.duration) : reject(new Error("无法读取录音时长，请检查文件是否完整"));
      audio.onerror = () => reject(new Error("当前设备无法读取这份录音，请检查音频编码或在电脑上导入"));
      audio.src = url;
    });
    return { format, seconds };
  } finally {
    audio.onloadedmetadata = audio.onerror = null;
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

async function importRecording(meeting, ticket) {
  const current = await store.getMeeting(meeting.id);
  if (!current.isMeeting) throw new Error("请选择会议文档");
  if (["recording", "paused"].includes(current.status)) throw new Error("请结束这场会议的录音后再导入文件");
  if (!ticket.info) ticket.info = await inspectAudio(ticket.file);
  if (!ticket.recordingId) ticket.recordingId = randomUUID();
  if (!ticket.assetPath) {
    const form = new FormData();
    form.append("assetsDirPath", "assets/");
    form.append("files[]", ticket.file, ticket.file.name);
    const data = await api.post("/api/asset/upload", form);
    const asset = data?.succMap?.[ticket.file.name] || Object.values(data?.succMap || {})[0];
    if (!isAssetPath(asset)) throw new Error("录音上传未完成，请重试；原文件仍保留在设备上");
    ticket.assetPath = asset;
  }
  const { recordings } = await store.readRecordings(current);
  const existing = recordings.find((item) => item.recordingId === ticket.recordingId);
  const result = await store.appendRecording(current, {
    assetPath: ticket.assetPath, seconds: ticket.info.seconds,
    meta: { recordingId: ticket.recordingId, segmentNo: existing ? existing.index - 1 : recordings.length,
      source: "import", originalName: ticket.file.name, format: ticket.info.format,
      sampleRate: 0, channels: 0 },
  });
  await store.setSegmentCount(current.id, Math.max(recordings.length, result.index));
  if (!current.firstRecordedAt) await store.markFirstRecorded(current.id);
  await store.markStatus(current.id, "done");
  return result;
}

function openImport(meeting, onImported = () => {}) {
  const dialog = new Dialog({ title: "添加已有录音", width: "480px", content: `
    <div class="meeting-import">
      <p>支持 M4A、MP3、WAV，包括苹果「语音备忘录」导出的 M4A。保留原文件，导入后在电脑端转写。</p>
      <label>录音文件<input type="file" accept=".m4a,.mp3,.wav,audio/mp4,audio/mpeg,audio/wav"></label>
      <p role="status" aria-live="polite"></p>
      <button type="button" class="b3-button" disabled>添加到会议</button>
    </div>` });
  const root = dialog.element.querySelector(".meeting-import");
  const input = root.querySelector("input");
  const status = root.querySelector('[role="status"]');
  const button = root.querySelector("button");
  let ticket, busy = false;
  input.onchange = () => {
    ticket = input.files[0] ? { file: input.files[0] } : null;
    button.disabled = !ticket;
    status.textContent = "";
  };
  button.onclick = async () => {
    if (!ticket || busy) return;
    busy = true;
    button.disabled = input.disabled = true;
    status.textContent = "正在读取并保存录音，请保持思源在前台…";
    try {
      const result = await importRecording(meeting, ticket);
      dialog.destroy();
      showMessage(`录音已添加 · ${formatSeconds(result.seconds)}`);
      try { await onImported(result); }
      catch { showMessage("录音已保存，请重新打开会议刷新内容", 5000); }
    } catch (error) {
      status.textContent = error.message + (ticket.assetPath ? `。附件已保存：${ticket.assetPath}，可点击按钮重试归档。` : "");
    } finally {
      busy = false;
      button.disabled = input.disabled = false;
    }
  };
  return dialog;
}

module.exports = { audioFormat, m4aDuration, inspectAudio, importRecording, openImport };
