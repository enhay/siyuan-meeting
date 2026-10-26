"use strict";

const crypto = require("node:crypto");
const api = require("./siyuan-api");
const {
  sha256,
  escapeIal,
  defaultMeetingTitle,
  isBlockId,
  isAssetPath,
} = require("./util");

const ATTR = {
  id: "custom-meeting-id",
  started: "custom-meeting-started",
  firstRecorded: "custom-meeting-first-recorded",
  status: "custom-meeting-status",
  mode: "custom-meeting-mode",
  segments: "custom-meeting-segments",
  preNotes: "custom-meeting-pre-notes",
  child: "custom-meeting-child",
  parent: "custom-meeting-parent",
  recordingId: "custom-recording-id",
  recordingIndex: "custom-recording-index",
  recordingStarted: "custom-recording-started",
  recordingDuration: "custom-recording-duration",
  recordingSampleRate: "custom-recording-sample-rate",
  recordingChannels: "custom-recording-channels",
  recordingAsset: "custom-recording-asset",
  recordingEvents: "custom-recording-events",
  recordingInterrupted: "custom-recording-interrupted",
  transcriptionStatus: "custom-recording-transcription-status",
  transcriptionError: "custom-recording-transcription-error",
  transcriptionIssue: "custom-recording-transcription-issue",
  transcriptionGaps: "custom-recording-transcription-gaps",
  transcriptionFingerprint: "custom-recording-transcription-fingerprint",
  realtimeEnabled: "custom-recording-realtime-enabled",
  recordingDevice: "custom-recording-device",
  transcriptMeeting: "custom-transcript-meeting",
  transcriptRecording: "custom-transcript-recording",
  transcriptStart: "custom-transcript-start",
  transcriptEnd: "custom-transcript-end",
  transcriptSpeaker: "custom-transcript-speaker",
  transcriptChannel: "custom-transcript-channel",
  transcriptLabel: "custom-transcript-label",
  transcriptNotice: "custom-transcript-notice",
  summaryGeneratedAt: "custom-summary-generated-at",
  summarySources: "custom-summary-sources",
  summaryFingerprint: "custom-summary-fingerprint",
  summaryTemplate: "custom-meeting-summary-template",
  summaryBasis: "custom-summary-basis",
};

const MEETING_STATUS = {
  draft: "draft",
  recording: "recording",
  paused: "paused",
  done: "done",
};

function meetingFrom(row, attrs = {}) {
  return {
    id: row.id,
    title: row.content,
    notebookId: row.box,
    hpath: row.hpath || "",
    meetingId: attrs[ATTR.id] || "",
    startedAt: attrs[ATTR.started] || "",
    firstRecordedAt: attrs[ATTR.firstRecorded] || "",
    status: attrs[ATTR.status] || "",
    mode: attrs[ATTR.mode] || "offline",
    segments: Number(attrs[ATTR.segments] || 0) || 0,
    preNotes: attrs[ATTR.preNotes] || "",
    isMeeting: Boolean(attrs[ATTR.id]),
    summaryTemplate: attrs[ATTR.summaryTemplate] || "general",
  };
}

async function createMeeting({ title, notebookId, mode = "offline" }) {
  const meetingId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const finalTitle = String(title || "").trim() || defaultMeetingTitle(new Date());
  const docId = await api.createDoc({ notebookId, title: finalTitle, markdown: "" });
  await api.setBlockAttrs(docId, {
    [ATTR.id]: meetingId,
    [ATTR.started]: startedAt,
    [ATTR.status]: MEETING_STATUS.draft,
    [ATTR.mode]: mode,
    [ATTR.segments]: "0",
  });
  const meta = await api.getDocMeta(docId);
  return meetingFrom(
    {
      ...(meta || {}),
      id: docId,
      content: meta?.content || finalTitle,
      box: meta?.box || notebookId,
    },
    {
      [ATTR.id]: meetingId,
      [ATTR.started]: startedAt,
      [ATTR.status]: MEETING_STATUS.draft,
      [ATTR.mode]: mode,
      [ATTR.segments]: "0",
    },
  );
}

async function getMeeting(docId) {
  if (!isBlockId(docId)) throw new Error("无法找到这场会议，请从会议菜单重新打开");
  let row = await api.getDocMeta(docId);
  if (!row) {
    // SQL can lag right after createDocWithMd. The block tree is available
    // immediately, so use it as a fallback instead of claiming the new doc is
    // missing or deleted.
    try {
      const info = await api.getBlockInfo(docId);
      if (info) {
        row = {
          id: docId,
          content: info.rootTitle || "会议",
          box: info.box || "",
          hpath: info.path || "",
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
        };
      }
    } catch {
      // fall through to the error below
    }
  }
  if (!row) throw new Error("会议文档不存在或已删除");
  let attrs = await api.getBlockAttrs(docId);
  for (let attempt = 0; attempt < 5 && !attrs["custom-meeting-id"]; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    attrs = await api.getBlockAttrs(docId);
  }
  return meetingFrom(row, attrs);
}

async function listMeetings(limit = 200) {
  return api.listMeetingDocs(limit);
}

async function markStatus(docId, status) {
  await api.setBlockAttrs(docId, { [ATTR.status]: status });
}

async function setMode(docId, mode) {
  await api.setBlockAttrs(docId, { [ATTR.mode]: mode });
}

async function setSegmentCount(docId, count) {
  await api.setBlockAttrs(docId, { [ATTR.segments]: String(count) });
}

async function markFirstRecorded(docId) {
  if (!isBlockId(docId)) throw new Error("无法找到这场会议，请从会议菜单重新打开");
  const now = new Date().toISOString();
  await api.setBlockAttrs(docId, { [ATTR.firstRecorded]: now });
  return now;
}

async function savePreNotes(docId, markdown) {
  const value = String(markdown || "");
  await api.setBlockAttrs(docId, { [ATTR.preNotes]: value });
  return value;
}

async function renameMeeting(docId, title) {
  if (!isBlockId(docId)) throw new Error("无法找到这场会议，请从会议菜单重新打开");
  return api.renameDoc(docId, title);
}

async function findChild(parentID, kind) {
  const children = await api.listChildDocs(parentID, kind);
  return children[0] || null;
}

async function ensureTranscriptDoc(meeting) {
  const existing = await findChild(meeting.id, "transcript");
  if (existing) return existing.id;
  const title = "转写";
  const id = await api.createDoc({
    notebookId: meeting.notebookId,
    parentID: meeting.id,
    title,
    markdown: "",
  });
  await api.setBlockAttrs(id, {
    [ATTR.child]: "transcript",
    [ATTR.parent]: meeting.id,
  });
  return id;
}

async function ensureSummaryDoc(meeting) {
  const title = "纪要";
  const id = await api.createDoc({
    notebookId: meeting.notebookId,
    parentID: meeting.id,
    title,
    markdown: "",
  });
  await api.setBlockAttrs(id, {
    [ATTR.child]: "summary",
    [ATTR.parent]: meeting.id,
  });
  return { id, title };
}

function eventsToAttr(events) {
  if (!Array.isArray(events) || !events.length) return "";
  try {
    return JSON.stringify(events.slice(-200));
  } catch {
    return "";
  }
}

function parseEvents(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Recording ids are known before audio archival. Keep the block id returned by
// the write so live sentence batches do not depend on the SQL index catching up.
const recordingBlocks = new Map();

async function ensureRecording(meeting, meta) {
  const key = `${meeting.id}:${meta.recordingId}`;
  if (recordingBlocks.has(key)) return recordingBlocks.get(key);
  const { recordings } = await readRecordings(meeting);
  const existing = recordings.find((item) => item.recordingId === meta.recordingId);
  if (existing) {
    recordingBlocks.set(key, existing.blockId);
    return existing.blockId;
  }
  const transcriptId = await ensureTranscriptDoc(meeting);
  const id = new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + crypto.randomBytes(4).toString("hex").slice(0, 7);
  const attrs = {
    id,
    [ATTR.recordingId]: meta.recordingId,
    [ATTR.recordingIndex]: String(Number(meta.segmentNo || 0) + 1),
    [ATTR.recordingStarted]: meta.startedAt || new Date().toISOString(),
    [ATTR.recordingSampleRate]: String(meta.sampleRate || 16000),
    [ATTR.recordingChannels]: String(meta.channels || 1),
    [ATTR.realtimeEnabled]: meta.realtimeEnabled ? "1" : "0",
    [ATTR.recordingDevice]: meta.deviceId || "",
    [ATTR.transcriptionStatus]: "recording",
  };
  const ial = Object.entries(attrs).map(([key, value]) => `${key}="${escapeIal(value)}"`).join(" ");
  await api.prependMarkdownRaw(transcriptId, `录音正在保存，结束后可回听。\n{: ${ial}}\n`);
  recordingBlocks.set(key, id);
  return id;
}

async function appendRecording(meeting, { assetPath, meta, seconds, events = [] }) {
  if (!isAssetPath(assetPath)) throw new Error("录音尚未保存到思源，已保留本机文件");
  const recordingId = meta.recordingId || crypto.randomUUID();
  const blockId = await ensureRecording(meeting, { ...meta, recordingId });
  const savedAttrs = await api.getBlockAttrs(blockId);
  await api.post("/api/block/updateBlock", {
    id: blockId, dataType: "markdown",
    data: `<audio controls="controls" src="${escapeIal(assetPath)}"></audio>`,
  });
  await api.setBlockAttrs(blockId, {
    ...savedAttrs,
    [ATTR.recordingId]: recordingId,
    [ATTR.recordingAsset]: assetPath,
    [ATTR.recordingDuration]: String(Math.max(0, Number(seconds) || 0)),
    [ATTR.recordingEvents]: eventsToAttr(events),
    [ATTR.recordingInterrupted]: meta.interrupted ? "1" : "0",
    ...(meta.interrupted ? { [ATTR.transcriptionStatus]: "incomplete", [ATTR.transcriptionError]: "录音意外中断，转写可能不完整，可手动重新转写" } : {}),
  });
  return { blockId, recordingId, index: Number(meta.segmentNo || 0) + 1,
    transcriptId: await ensureTranscriptDoc(meeting), seconds, assetPath, meta, events };
}

async function readRecordings(meeting) {
  const transcript = await findChild(meeting.id, "transcript");
  if (!transcript) return { transcriptId: "", recordings: [] };
  const blocks = await api.listBlocksWithAttr(transcript.id, ATTR.recordingId);
  const recordings = blocks
    .map((block) => {
      const attrs = block.attrs;
      return {
        blockId: block.id,
        transcriptId: transcript.id,
        recordingId: attrs[ATTR.recordingId] || "",
        index: Number(attrs[ATTR.recordingIndex] || 0) || 0,
        startedAt: attrs[ATTR.recordingStarted] || "",
        seconds: Number(attrs[ATTR.recordingDuration] || 0) || 0,
        sampleRate: Number(attrs[ATTR.recordingSampleRate] || 0) || 0,
        channels: Number(attrs[ATTR.recordingChannels] || 1) || 1,
        assetPath: isAssetPath(attrs[ATTR.recordingAsset]) ? attrs[ATTR.recordingAsset] : "",
        interrupted: attrs[ATTR.recordingInterrupted] === "1",
        events: parseEvents(attrs[ATTR.recordingEvents]),
        transcriptionStatus: attrs[ATTR.transcriptionStatus] || "",
        transcriptionError: attrs[ATTR.transcriptionError] || "",
        transcriptionIssue: attrs[ATTR.transcriptionIssue] || "",
        transcriptionFingerprint: attrs[ATTR.transcriptionFingerprint] || "",
        gaps: parseEvents(attrs[ATTR.transcriptionGaps]),
        realtimeEnabled: attrs[ATTR.realtimeEnabled] === "1",
        deviceId: attrs[ATTR.recordingDevice] || "",
      };
    })
    .filter((item) => item.recordingId)
    .sort((a, b) => a.index - b.index);
  return { transcriptId: transcript.id, recordings };
}

async function readTranscript(meeting) {
  const transcript = await findChild(meeting.id, "transcript");
  if (!transcript) return { transcriptId: "", segments: [] };
  const blocks = await api.listBlocksWithAttr(transcript.id, ATTR.transcriptStart);
  const segments = blocks
    .map((block) => {
      const attrs = block.attrs;
      return {
        blockId: block.id,
        recordingId: attrs[ATTR.transcriptRecording] || "",
        startMs: Number(attrs[ATTR.transcriptStart] || 0) || 0,
        endMs: Number(attrs[ATTR.transcriptEnd] || 0) || 0,
        speaker: Number(attrs[ATTR.transcriptSpeaker] || 0) || 0,
        channel: Number(attrs[ATTR.transcriptChannel] || 0) || 0,
        speakerLabel: attrs[ATTR.transcriptLabel] || `说话人 ${Number(attrs[ATTR.transcriptSpeaker] || 0) + 1}`,
        notice: attrs[ATTR.transcriptNotice] === "1",
        text: String(block.content || "").replace(/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?(?:\s+siyuan:\/\/plugins\/siyuan-meeting\/seek)?\s*[^：:]*[：:]\s*/u, ""),
      };
    })
    .filter((item) => item.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  return { transcriptId: transcript.id, segments };
}

async function renameTranscriptSpeaker(meeting, oldLabel, nextLabel) {
  const label = String(nextLabel || "").trim();
  if (!label || /[\r\n：:]/u.test(label)) throw new Error("名称不能为空，也不能包含换行或冒号");
  if (label === oldLabel) return;
  const transcript = await findChild(meeting.id, "transcript");
  if (!transcript) throw new Error("还没有转写内容");
  const blocks = (await api.listBlocksWithAttr(transcript.id, ATTR.transcriptLabel))
    .filter((block) => block.attrs[ATTR.transcriptLabel] === oldLabel && block.attrs[ATTR.transcriptNotice] !== "1");
  for (const block of blocks) {
    const source = await api.post("/api/block/getBlockKramdown", { id: block.id });
    const attrs = await api.getBlockAttrs(block.id);
    if (attrs[ATTR.transcriptLabel] !== oldLabel || attrs[ATTR.transcriptMeeting] !== meeting.id) {
      throw new Error("转写在改名期间发生了修改，已停止改名。请检查后重试。");
    }
    const raw = String(source.kramdown || "");
    const prefix = /^(\[[^\n]+?\]\(siyuan:\/\/plugins\/siyuan-meeting\/seek\)\s+)([^\n]*?)([：:])/u;
    const match = prefix.exec(raw);
    if (!match || match[2] !== escapeMarkdownText(oldLabel)) {
      throw new Error("部分说话人标签已在文档中修改，请在编辑转写中检查后再改名。");
    }
    // Rewrite just the label and its attribute in the native source. Rebuilding
    // the paragraph from plain text would erase manual emphasis and links.
    const data = raw.replace(prefix, (_all, stamp, _old, colon) => `${stamp}${escapeMarkdownText(label)}${colon}`)
      .replace(/(\n\{:[^\n]*custom-transcript-label=")[^"]*(")/u, (_all, before, after) => `${before}${escapeIal(label)}${after}`);
    const current = await api.post("/api/block/getBlockKramdown", { id: block.id });
    if (current.kramdown !== raw) throw new Error("转写在改名期间发生了修改，已停止改名。请检查后重试。");
    await api.post("/api/block/updateBlock", { id: block.id, dataType: "markdown", data });
  }
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

function transcriptStamp(startMs) {
  const total = Math.max(0, Math.floor(Number(startMs || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function transcriptLine(segment) {
  const label = segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`;
  return `[${transcriptStamp(segment.startMs)}](siyuan://plugins/siyuan-meeting/seek) ${escapeMarkdownText(label)}：${escapeMarkdownText(segment.text)}`;
}

async function transcriptBlocks(meeting, recordingId) {
  const transcript = await findChild(meeting.id, "transcript");
  if (!transcript) return [];
  const blocks = await api.listBlocksWithAttr(transcript.id, ATTR.transcriptRecording);
  return blocks.filter((block) => block.attrs[ATTR.transcriptRecording] === recordingId);
}

function blocksFingerprint(blocks) {
  return sha256(JSON.stringify(blocks.map((block) => [block.id, block.markdown || block.content || ""]).sort((a, b) => a[0].localeCompare(b[0]))));
}

async function transcriptFingerprint(meeting, recordingId) {
  return blocksFingerprint(await transcriptBlocks(meeting, recordingId));
}

async function writeTranscript(meeting, recordingId, segments, { append = false, expectedFingerprint } = {}) {
  const transcriptId = await ensureTranscriptDoc(meeting);
  const previous = await transcriptBlocks(meeting, recordingId);
  const { recordings } = await readRecordings(meeting);
  const savedFingerprint = recordings.find((item) => item.recordingId === recordingId)?.transcriptionFingerprint;
  const preserveEditedFingerprint = append && previous.length && (!savedFingerprint || savedFingerprint !== blocksFingerprint(previous));
  if (expectedFingerprint !== undefined && blocksFingerprint(previous) !== expectedFingerprint) {
    const error = new Error("转写文字已被修改，已保留修改");
    error.code = "TRANSCRIPT_CHANGED";
    throw error;
  }
  const list = [...segments].sort((a, b) => a.startMs - b.startMs);
  const addedIds = [];
  try {
    for (let offset = 0; offset < list.length; offset += 200) {
      const data = list.slice(offset, offset + 200).map((segment) => {
        const id = new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + crypto.randomBytes(4).toString("hex").slice(0, 7);
        addedIds.push(id);
        const attrs = {
          id,
          [ATTR.transcriptMeeting]: meeting.id,
          [ATTR.transcriptRecording]: recordingId,
          [ATTR.transcriptStart]: String(Math.max(0, Math.floor(segment.startMs || 0))),
          [ATTR.transcriptEnd]: String(Math.max(0, Math.floor(segment.endMs || 0))),
          [ATTR.transcriptSpeaker]: String(Number(segment.speaker || 0)),
          [ATTR.transcriptChannel]: String(Number(segment.channel || 0)),
          [ATTR.transcriptLabel]: segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`,
          [ATTR.transcriptNotice]: segment.notice ? "1" : "0",
        };
        const ial = Object.entries(attrs).map(([key, value]) => `${key}="${escapeIal(value)}"`).join(" ");
        return `${transcriptLine(segment)}\n{: ${ial}}`;
      }).join("\n\n");
      await api.appendMarkdownRaw(transcriptId, data);
    }
  } catch (error) {
    await api.deleteBlocks(addedIds).catch(() => {});
    throw error;
  }
  if (!append) {
    // Check the exact old blocks again before removing them: the native editor
    // stays editable while a long recognition request is in progress.
    const oldIds = new Set(previous.map((block) => block.id));
    const current = (await transcriptBlocks(meeting, recordingId)).filter((block) => oldIds.has(block.id));
    if (blocksFingerprint(current) !== blocksFingerprint(previous)) {
      await api.deleteBlocks(addedIds);
      const error = new Error("转写文字已被修改，已保留修改");
      error.code = "TRANSCRIPT_CHANGED";
      throw error;
    }
    await api.deleteBlocks(previous.map((block) => block.id));
  }
  // A generated fingerprint lets the confirmation distinguish edited text.
  if (!preserveEditedFingerprint) {
    await updateRecordingTranscription(meeting, recordingId, {
      transcriptionFingerprint: await transcriptFingerprint(meeting, recordingId),
    });
  }
  return transcriptId;
}

async function updateRecordingTranscription(meeting, recordingId, patch) {
  const key = `${meeting.id}:${recordingId}`;
  let blockId = recordingBlocks.get(key);
  if (!blockId) {
    const { recordings } = await readRecordings(meeting);
    blockId = recordings.find((item) => item.recordingId === recordingId)?.blockId;
  }
  if (!blockId) throw new Error("找不到对应的录音，请重新打开会议");
  const fields = {
    transcriptionStatus: ATTR.transcriptionStatus,
    transcriptionError: ATTR.transcriptionError,
    transcriptionIssue: ATTR.transcriptionIssue,
    transcriptionFingerprint: ATTR.transcriptionFingerprint,
    gaps: ATTR.transcriptionGaps,
    realtimeEnabled: ATTR.realtimeEnabled,
  };
  const attrs = {};
  for (const [name, value] of Object.entries(patch)) {
    if (!fields[name]) continue;
    attrs[fields[name]] = name === "gaps" ? JSON.stringify(value)
      : name === "realtimeEnabled" ? (value ? "1" : "0") : String(value || "");
  }
  await api.setBlockAttrs(blockId, attrs);
}

async function readSummaries(meeting) {
  const children = await api.listChildDocs(meeting.id, "summary");
  return children
    .map((child) => ({
      id: child.id,
      title: child.title,
      generatedAt: child.attrs[ATTR.summaryGeneratedAt] || "",
      sources: child.attrs[ATTR.summarySources] || "",
      fingerprint: child.attrs[ATTR.summaryFingerprint] || "",
      basis: readSummaryBasis(child.attrs[ATTR.summaryBasis]),
    }));
}

function readSummaryBasis(value) {
  try {
    const basis = JSON.parse(value || "null");
    return basis && typeof basis === "object" && !Array.isArray(basis) ? basis : null;
  } catch {
    return null;
  }
}

async function readSummaryContent(docId) {
  return api.getDocMarkdown(docId);
}

async function saveSummary(meeting, { markdown, sources = "", generatedAt = new Date().toISOString(), expectedFingerprint = "", receipt = {}, basis = null }) {
  const content = String(markdown || "").trim();
  if (!content) throw new Error("纪要内容为空，未写入文档");
  const summaries = await readSummaries(meeting);
  if (summaries.length > 1) {
    throw new Error("这场会议中有多份旧纪要。请先在思源中保留一份，再重新生成。");
  }
  const latest = summaries[0] || null;
  const currentContent = latest ? (await readSummaryContent(latest.id)).trim() : "";
  const currentHash = latest ? sha256(currentContent) : "";
  const metadata = {
    [ATTR.child]: "summary",
    [ATTR.parent]: meeting.id,
    [ATTR.summaryGeneratedAt]: generatedAt,
    [ATTR.summarySources]: sources,
    [ATTR.summaryBasis]: basis ? JSON.stringify(basis) : "",
  };
  // A metadata write or the subsequent UI refresh can fail after the content
  // was saved. A retry must not append that content a second time.
  if (receipt.docId) {
    if (latest?.id !== receipt.docId || currentHash !== receipt.fingerprint) {
      throw new Error("纪要已被修改，未覆盖原文。请检查纪要文档，或复制本次生成结果。");
    }
    await api.setBlockAttrs(latest.id, { ...metadata, [ATTR.summaryFingerprint]: currentHash });
    return { ...receipt, content: currentContent, sources, generatedAt };
  }
  // Native editors remain usable while the model is generating. Do not erase
  // edits made after the user confirmed the replacement.
  const hasCurrentContent = Boolean(currentContent.replace(/\u200d/g, "").trim());
  if ((latest && currentHash !== expectedFingerprint && (hasCurrentContent || expectedFingerprint)) || (!latest && expectedFingerprint)) {
    throw new Error("纪要已发生修改或已有部分结果，未覆盖原文。请检查纪要文档，或复制本次生成结果。");
  }

  let target;
  let replaced = false;
  let oldBlocks = [];
  if (!latest) {
    target = await ensureSummaryDoc(meeting);
  } else {
    target = { id: latest.id, title: latest.title };
    // Capture the old block ids and append the new content first. If the
    // append fails, the previous summary is still intact.
    oldBlocks = await api.post("/api/block/getChildBlocks", { id: target.id });
    replaced = true;
  }

  await api.appendMarkdown(target.id, content);
  if (oldBlocks.length) {
    const currentBlocks = await api.post("/api/block/getChildBlocks", { id: target.id });
    const oldIds = new Set(oldBlocks.map((block) => block.id));
    const currentOld = currentBlocks.filter((block) => oldIds.has(block.id));
    if (blocksFingerprint(currentOld) !== blocksFingerprint(oldBlocks)) {
      // The new draft may remain beside the edits; never delete a user's edit
      // merely to make a partially completed replacement look successful.
      throw new Error("纪要在保存期间被修改，已保留修改和新生成的内容，请检查纪要文档。");
    }
    await api.deleteBlocks(oldBlocks.map((block) => block.id));
  }
  const persisted = (await readSummaryContent(target.id)).trim();
  const fingerprint = sha256(persisted);
  Object.assign(receipt, { docId: target.id, replaced, fingerprint });
  await api.setBlockAttrs(target.id, {
    ...metadata,
    [ATTR.summaryFingerprint]: fingerprint,
  });

  return {
    docId: target.id,
    replaced,
    content: persisted,
    generatedAt,
    sources,
    fingerprint,
  };
}

module.exports = {
  ATTR,
  MEETING_STATUS,
  createMeeting,
  getMeeting,
  listMeetings,
  markStatus,
  setMode,
  setSegmentCount,
  markFirstRecorded,
  savePreNotes,
  renameMeeting,
  findChild,
  ensureTranscriptDoc,
  ensureSummaryDoc,
  ensureRecording,
  appendRecording,
  readRecordings,
  readTranscript,
  renameTranscriptSpeaker,
  writeTranscript,
  transcriptFingerprint,
  updateRecordingTranscription,
  readSummaries,
  readSummaryContent,
  saveSummary,
  transcriptLine,
  parseEvents,
};
