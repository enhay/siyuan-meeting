"use strict";

const crypto = require("node:crypto");
const api = require("./siyuan-api");
const {
  sha256,
  escapeIal,
  sqlString,
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
  recordingTask: "custom-recording-task",
  recordingTaskStatus: "custom-recording-task-status",
  recordingTaskAt: "custom-recording-task-at",
  recordingTaskError: "custom-recording-task-error",
  transcriptMeeting: "custom-transcript-meeting",
  transcriptRecording: "custom-transcript-recording",
  transcriptStart: "custom-transcript-start",
  transcriptEnd: "custom-transcript-end",
  transcriptSpeaker: "custom-transcript-speaker",
  transcriptChannel: "custom-transcript-channel",
  summaryVersion: "custom-summary-version",
  summaryGeneratedAt: "custom-summary-generated-at",
  summarySources: "custom-summary-sources",
  summaryFingerprint: "custom-summary-fingerprint",
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
  if (!isBlockId(docId)) throw new Error("会议文档编号无效");
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
  if (!isBlockId(docId)) throw new Error("会议文档编号无效");
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
  if (!isBlockId(docId)) throw new Error("会议文档编号无效");
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

async function ensureSummaryDoc(meeting, version = 1) {
  const title = version <= 1 ? "纪要" : `纪要（第 ${version} 版）`;
  const id = await api.createDoc({
    notebookId: meeting.notebookId,
    parentID: meeting.id,
    title,
    markdown: "",
  });
  await api.setBlockAttrs(id, {
    [ATTR.child]: "summary",
    [ATTR.parent]: meeting.id,
    [ATTR.summaryVersion]: String(version),
  });
  return { id, title, version };
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

async function appendRecording(meeting, { assetPath, meta, seconds, events = [] }) {
  if (!isAssetPath(assetPath)) throw new Error("录音资源路径无效，已保留本机文件");
  const transcriptId = await ensureTranscriptDoc(meeting);
  const recordingId = meta.recordingId || crypto.randomUUID();
  const index = Number(meta.segmentNo || 0) + 1;
  const attrs = {
    [ATTR.recordingId]: recordingId,
    [ATTR.recordingIndex]: String(index),
    [ATTR.recordingStarted]: meta.startedAt || new Date().toISOString(),
    [ATTR.recordingDuration]: String(Math.max(0, Number(seconds) || 0)),
    [ATTR.recordingSampleRate]: String(meta.sampleRate || 0),
    [ATTR.recordingChannels]: String(meta.channels || 1),
    [ATTR.recordingAsset]: assetPath || "",
    [ATTR.recordingEvents]: eventsToAttr(events),
  };
  if (meta.interrupted) attrs[ATTR.recordingInterrupted] = "1";
  const markdown = `<audio controls="controls" src="${escapeIal(assetPath)}"></audio>`;
  const ial = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeIal(value)}"`)
    .join(" ");
  // Keep every segment's audio block at the top of the transcript document.
  await api.prependMarkdownRaw(transcriptId, `${markdown}\n{: ${ial}}\n`);
  const rows = await api.sql(
    `SELECT b.id FROM blocks b
      JOIN attributes a ON a.block_id=b.id AND a.name=${sqlString(ATTR.recordingId)} AND a.value=${sqlString(recordingId)}
      WHERE b.parent_id=${sqlString(transcriptId)} LIMIT 1`,
  );
  return {
    blockId: rows[0]?.id || "",
    recordingId,
    index,
    transcriptId,
    seconds,
    assetPath,
    meta,
    events,
  };
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
        taskId: attrs[ATTR.recordingTask] || "",
        taskStatus: attrs[ATTR.recordingTaskStatus] || "",
        taskAt: attrs[ATTR.recordingTaskAt] || "",
        taskError: attrs[ATTR.recordingTaskError] || "",
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
        text: String(block.content || "").replace(/^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*[^：:]*[：:]\s*/u, ""),
      };
    })
    .filter((item) => item.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  return { transcriptId: transcript.id, segments };
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
  const speaker = Number(segment.speaker || 0) + 1;
  return `[${transcriptStamp(segment.startMs)}] 说话人 ${speaker}：${escapeMarkdownText(segment.text)}`;
}

async function deleteTranscriptFor(meeting, recordingId) {
  const transcript = await findChild(meeting.id, "transcript");
  if (!transcript) return;
  const rows = await api.sql(
    `SELECT b.id FROM blocks b
      JOIN attributes a ON a.block_id=b.id AND a.name=${sqlString(ATTR.transcriptRecording)} AND a.value=${sqlString(recordingId)}
      WHERE b.parent_id=${sqlString(transcript.id)}`,
  );
  await api.deleteBlocks(rows.map((row) => row.id));
}

async function writeTranscript(meeting, recordingId, segments) {
  const transcriptId = await ensureTranscriptDoc(meeting);
  await deleteTranscriptFor(meeting, recordingId);
  const list = [...segments].sort((a, b) => a.startMs - b.startMs);
  // Write paragraphs in batches: a two-hour meeting can produce thousands of
  // sentences, and one request per sentence would make transcription crawl.
  const batchSize = 200;
  for (let offset = 0; offset < list.length; offset += batchSize) {
    const batch = list.slice(offset, offset + batchSize);
    const data = batch
      .map((segment) => {
        const attrs = {
          [ATTR.transcriptMeeting]: meeting.id,
          [ATTR.transcriptRecording]: recordingId,
          [ATTR.transcriptStart]: String(Math.max(0, Math.floor(segment.startMs || 0))),
          [ATTR.transcriptEnd]: String(Math.max(0, Math.floor(segment.endMs || 0))),
          [ATTR.transcriptSpeaker]: String(Number(segment.speaker || 0) || 0),
        };
        if (segment.channel !== undefined && segment.channel !== null && segment.channel !== "") {
          attrs[ATTR.transcriptChannel] = String(segment.channel);
        }
        const ial = Object.entries(attrs)
          .map(([key, value]) => `${key}="${escapeIal(value)}"`)
          .join(" ");
        return `${transcriptLine(segment)}\n{: ${ial}}`;
      })
      .join("\n\n");
    await api.appendMarkdownRaw(transcriptId, data);
  }
  return transcriptId;
}

async function updateRecordingTask(meeting, recordingId, taskId, status, error = "") {
  const { recordings } = await readRecordings(meeting);
  const target = recordings.find((item) => item.recordingId === recordingId);
  if (!target?.blockId) throw new Error("找不到对应的录音段");
  const attrs = {
    [ATTR.recordingTaskStatus]: String(status || ""),
    [ATTR.recordingTaskAt]: new Date().toISOString(),
    [ATTR.recordingTaskError]: String(error || ""),
  };
  // A status-only update must not erase a task id that was already persisted.
  if (taskId) attrs[ATTR.recordingTask] = String(taskId);
  await api.setBlockAttrs(target.blockId, attrs);
}

async function readSummaries(meeting) {
  const children = await api.listChildDocs(meeting.id, "summary");
  return children
    .map((child) => ({
      id: child.id,
      title: child.title,
      version: Number(child.attrs[ATTR.summaryVersion] || 1) || 1,
      generatedAt: child.attrs[ATTR.summaryGeneratedAt] || "",
      sources: child.attrs[ATTR.summarySources] || "",
      fingerprint: child.attrs[ATTR.summaryFingerprint] || "",
    }))
    .sort((a, b) => a.version - b.version);
}

async function readSummaryContent(docId) {
  return api.getDocMarkdown(docId);
}

async function saveSummary(meeting, { markdown, sources = "", generatedAt = new Date().toISOString(), forceNew = false }) {
  const content = String(markdown || "").trim();
  if (!content) throw new Error("纪要内容为空，未写入文档");
  const summaries = await readSummaries(meeting);
  const latest = summaries[summaries.length - 1] || null;
  const currentContent = latest ? (await readSummaryContent(latest.id)).trim() : "";
  const currentHash = latest ? sha256(currentContent) : "";
  const edited =
    Boolean(latest) &&
    (!latest.fingerprint || currentHash !== latest.fingerprint);

  let target;
  let replaced = false;
  let oldBlocks = [];
  if (!latest || forceNew || edited) {
    const version = latest ? latest.version + 1 : 1;
    target = await ensureSummaryDoc(meeting, version);
  } else {
    target = { id: latest.id, title: latest.title, version: latest.version };
    // Capture the old block ids and append the new content first. If the
    // append fails, the previous summary is still intact.
    oldBlocks = (
      await api.sql(`SELECT id FROM blocks WHERE parent_id=${sqlString(target.id)}`)
    ).map((row) => row.id);
    replaced = true;
  }

  await api.appendMarkdown(target.id, content);
  if (oldBlocks.length) await api.deleteBlocks(oldBlocks);
  const persisted = (await readSummaryContent(target.id)).trim();
  const fingerprint = sha256(persisted);
  await api.setBlockAttrs(target.id, {
    [ATTR.child]: "summary",
    [ATTR.parent]: meeting.id,
    [ATTR.summaryVersion]: String(target.version),
    [ATTR.summaryGeneratedAt]: generatedAt,
    [ATTR.summarySources]: sources,
    [ATTR.summaryFingerprint]: fingerprint,
  });

  return {
    docId: target.id,
    version: target.version,
    replaced,
    editedPrevious: edited,
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
  appendRecording,
  readRecordings,
  readTranscript,
  writeTranscript,
  updateRecordingTask,
  readSummaries,
  readSummaryContent,
  saveSummary,
  transcriptLine,
  parseEvents,
};
