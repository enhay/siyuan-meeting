"use strict";

const { Menu, Dialog, showMessage, openSetting, Protyle } = require("siyuan");
const api = require("./siyuan-api");
const { openImport } = require("./audio-import");
const { parseCosEndpoint } = require("./cloud");
const meetingStore = require("./meeting-store");
const { parseHotwords, effectiveHotwords, validateHotwords } = require("./hotwords");
const prompts = require("./prompts");
const { createTemplatePicker, createTemplateManager, openTemplateManager } = require("./template-ui");
const ai = require("./ai");
const { findTranscriptMatches, playbackSegments } = require("./transcript-view");
const {
  formatDuration,
  formatClock,
  formatClockSeconds,
  formatDateTime,
  formatDate,
  escapeHtml,
  sha256,
  debounce,
} = require("./util");

const SPEAKER_COLORS = 6;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const MEETING_VIEWS = ["summary", "notes", "transcript"];

function icon(name, className = "") {
  return `<svg class="meeting-icon ${className}" aria-hidden="true"><use href="#${name}"></use></svg>`;
}

function h(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const ICON_SQUARE_12 =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"/></svg>';
const ICON_PAUSE_12 =
  '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';
const ICON_PLAY_12 =
  '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.2c0-.8.9-1.3 1.6-.9l7 4.8c.6.4.6 1.3 0 1.7l-7 4.8c-.7.5-1.6 0-1.6-.9V3.2Z" fill="currentColor"/></svg>';
const ICON_SPINNER = '<span class="meeting-spinner" aria-hidden="true"></span>';

const RECORDING_ICON =
  '<span class="recording-icon"><span class="recording-icon__ping"></span><span class="recording-icon__dot"></span></span>';

function loadUiState(docId) {
  try {
    const value = JSON.parse(localStorage.getItem(`siyuan-meeting.ui.${docId}`) || "{}");
    // Migrate the old side-panel "recordings" view to the transcript view.
    const view = MEETING_VIEWS.includes(value.view)
      ? value.view
      : value.view === "recordings"
        ? "transcript"
        : "";
    return { view };
  } catch {
    return { view: "" };
  }
}

function saveUiState(docId, ui) {
  try {
    localStorage.setItem(`siyuan-meeting.ui.${docId}`, JSON.stringify({ view: ui.view }));
  } catch {
    // storage may be unavailable
  }
}

function recordingTitle(index) {
  return index <= 1 ? `录音 ${Math.max(1, index)}` : `补录 ${index}`;
}

function recordingRange(recording) {
  if (recording.source === "import") return recording.originalName || "导入录音";
  const start = recording.startedAt ? new Date(recording.startedAt) : new Date();
  let end = new Date(start.getTime() + Number(recording.seconds || 0) * 1000);
  const events = Array.isArray(recording.events) ? recording.events : [];
  for (const event of events) {
    if (!event.at) continue;
    const at = new Date(event.at);
    if (!Number.isNaN(at.getTime()) && at.getTime() > end.getTime()) end = at;
  }
  return `${formatClock(start)}–${formatClock(end)}`;
}

/**
 * Translate an audio-relative position into wall-clock time. Pauses and
 * reconnect gaps are not part of the WAV, so the transcription's actual time
 * must add them back rather than pretending the recording was continuous.
 */
function actualTimeFor(recording, startMs) {
  const base = recording.startedAt ? new Date(recording.startedAt).getTime() : NaN;
  if (!Number.isFinite(base)) return "";
  const events = Array.isArray(recording.events) ? recording.events : [];
  let offset = 0;
  let openPauseAt = null;
  let openPauseElapsed = 0;
  for (const event of events) {
    const at = event.at ? new Date(event.at).getTime() : NaN;
    if (!Number.isFinite(at)) continue;
    if (event.type === "pause" || event.type === "gap") {
      openPauseAt = at;
      openPauseElapsed = Number(event.elapsedMs || 0);
    } else if (event.type === "resume" && openPauseAt !== null) {
      if (Number(startMs || 0) >= openPauseElapsed) offset += Math.max(0, at - openPauseAt);
      openPauseAt = null;
    }
  }
  return formatClockSeconds(base + Number(startMs || 0) + offset);
}

function statusLabel(status, phase = "") {
  const phases = { checking: "准备中", confirming: "待确认", preparing: "准备中", uploading: "发送中", recognizing: "等待结果", saving: "保存中", submitting: "提交中", cleaning: "清理中" };
  if (phases[phase]) return phases[phase];
  switch (status) {
    case "uploading":
      return "上传中";
    case "recording":
      return "实时转写中";
    case "incomplete":
      return "转写未完成";
    case "processing":
      return "识别中";
    case "done":
      return "已转写";
    case "failed":
      return "转写失败";
    default:
      return "未转写";
  }
}

function transcriptStatus(recording, transcriptSegments, manager, meetingId) {
  const live = manager?.statusFor(meetingId, recording.recordingId) || {};
  const status = live.status || recording.transcriptionStatus || "";
  if (recording.transcriptionIssue === "configuration-required" && (!live.status || live.status === "incomplete" && !live.progress)) return "";
  if (status) return status;
  return "";
}

function transcriptionTask(state, recording) {
  const request = state.transcriptionRequests.get(recording.recordingId);
  const live = state.plugin.transcription.statusFor(state.docId, recording.recordingId);
  const status = request ? request.error ? "failed" : "processing"
    : transcriptStatus(recording, state.transcript, state.plugin.transcription, state.docId);
  return {
    status,
    phase: request?.phase || live.progress?.phase || status,
    error: request ? request.error || "" : live.error || (recording.transcriptionIssue !== "configuration-required" ? recording.transcriptionError : "") || "",
    progress: live.progress,
    running: Boolean(request && !request.error) || state.plugin.transcription.isRunning(recording.recordingId),
  };
}

function transcriptionTaskText(task) {
  const messages = {
    checking: "正在检查录音与已有转写…",
    confirming: "等待你确认转写…",
    preparing: "正在准备录音…",
    uploading: "正在发送录音…",
    recognizing: "等待识别结果…",
    submitting: "正在提交识别任务…",
    cleaning: "文字已保存，正在删除云端临时录音…",
    saving: "识别已完成，正在保存文字…",
    done: "转写完成，文字已保存。",
  };
  const progress = task.progress;
  const range = progress?.rangeCount > 1 ? `第 ${progress.rangeIndex} / ${progress.rangeCount} 处缺口 · ` : "";
  const parts = progress?.partCount > 1 ? `已识别 ${progress.completedParts} / ${progress.partCount} 部分 · ` : "";
  return `${range}${parts}${task.error || messages[task.phase] || statusLabel(task.status)}`;
}

function renderTranscriptionFeedback(state) {
  if (state.destroyed) return;
  renderViewStatus(state);
  if (resolveMeetingView(state) === "transcript") renderTranscriptView(state);
}

function safeMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let list = "";
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = "";
    }
  };
  const inline = (text) => {
    let value = escapeHtml(text);
    value = value.replace(/&lt;u&gt;/g, "<u>").replace(/&lt;\/u&gt;/g, "</u>");
    value = value.replace(/`([^`]+)`/g, "<code>$1</code>");
    value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    value = value.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    value = value.replace(/<u>([^<]+)<\/u>/g, "<u>$1</u>");
    value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    value = value.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    value = value.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return value;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, "");
    if (/^```/.test(line)) {
      closeList();
      flushParagraph();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(raw)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      flushParagraph();
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      flushParagraph();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      flushParagraph();
      out.push("<hr>");
      continue;
    }
    paragraph.push(line.trim());
  }
  closeList();
  flushParagraph();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function confirmDialog(title, message, confirmLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const dialog = new Dialog({
      title,
      width: "460px",
      destroyCallback: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
      content: `<div class="b3-dialog__content meeting-confirm">
        <p>${escapeHtml(message)}</p>
        <div class="meeting-confirm__actions">
          <button class="b3-button b3-button--cancel">取消</button>
          <button class="b3-button meeting-confirm__ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`,
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.destroy();
    };
    dialog.element.querySelector(".b3-button--cancel").onclick = () => finish(false);
    dialog.element.querySelector(".meeting-confirm__ok").onclick = () => finish(true);
    dialog.element.querySelector(".b3-dialog__close")?.addEventListener("click", () => finish(false));
  });
}

function mountMeetingTab(plugin, tab) {
  const docId = String(tab.data?.id || "");
  const root = document.createElement("div");
  root.className = "meeting-page";
  root.dataset.phase = "idle";
  const viewId = `${plugin.name}-${docId}`;
  root.innerHTML = `
    <header class="meeting-header">
      <div class="meeting-view-switcher meeting-switcher" role="tablist" aria-label="会议视图">
        <button type="button" role="tab" id="${viewId}-summary-tab" aria-controls="${viewId}-summary-panel" data-view="summary" aria-selected="false">纪要</button>
        <button type="button" role="tab" id="${viewId}-notes-tab" aria-controls="${viewId}-notes-panel" data-view="notes" aria-selected="true">笔记</button>
        <button type="button" role="tab" id="${viewId}-transcript-tab" aria-controls="${viewId}-transcript-panel" data-view="transcript" aria-selected="false">转写</button>
      </div>
      <div class="meeting-crumb">
        <span class="meeting-crumb__icon">${icon("iconMeetingCalendar")}</span>
        <input class="meeting-title" aria-label="会议标题" spellcheck="false" autocomplete="off">
      </div>
      <div class="meeting-header__spacer"></div>
      <div class="meeting-header__actions">
        <button class="meeting-btn meeting-btn--outline" data-action="import-audio">添加已有录音</button>
        <button class="meeting-btn meeting-btn--outline meeting-open-doc" data-action="open-doc">在思源文档中打开</button>
        <button class="meeting-icon-btn" data-action="more" aria-label="更多操作" title="更多">${icon("iconMeetingMore")}</button>
      </div>
      <div class="meeting-controlbar">
        <div class="meeting-controlbar__setup">
          <details class="meeting-recording-options"><summary aria-label="录音设置">录音设置</summary><div class="meeting-recording-options__panel">
          <div class="meeting-mode" role="group" aria-label="录音模式">
            <button type="button" data-mode="offline">线下</button>
            <button type="button" data-mode="online">线上</button>
          </div>
          <span class="meeting-device">
            <select class="meeting-device__select" data-field="mic" aria-label="麦克风设备"></select>
            <span class="meeting-device__chevron">${icon("iconMeetingChevron")}</span>
          </span>
          <button class="meeting-icon-btn meeting-device__refresh" data-action="refresh-devices" aria-label="刷新麦克风列表" title="刷新麦克风列表">${icon("iconMeetingRefresh")}</button>
          <p class="meeting-recording-options__note" data-field="source"></p>
          <p class="meeting-recording-options__note" data-field="online-tip">线上录音会同时录下电脑播放的声音，请使用耳机，避免外放声音被重复录入。</p>
          </div></details>
          <button class="meeting-btn meeting-btn--start" data-action="start">
            ${RECORDING_ICON}
            <span data-field="start-label">开始录音</span>
          </button>
        </div>
        <div class="meeting-controlbar__live">
          <span class="meeting-live">
            <span class="meeting-live__dot"></span>
            <span class="meeting-timer" data-field="timer" role="timer">00:00</span>
            <span class="meeting-live__state" data-field="live-state"></span>
            <span class="meeting-levels" data-field="levels" hidden>
              <meter class="meeting-level meeting-level--mic" min="0" max="1" value="0" data-field="mic-level" title="麦克风" aria-label="麦克风音量"></meter>
              <meter class="meeting-level meeting-level--speaker" min="0" max="1" value="0" data-field="speaker-level" title="电脑声音" aria-label="电脑声音音量"></meter>
            </span>
          </span>
          <button class="meeting-btn meeting-btn--outline" data-action="pause">
            <span class="meeting-btn__icon" data-field="pause-icon"></span>
            <span data-field="pause-label">暂停</span>
          </button>
          <button class="meeting-btn meeting-btn--danger" data-action="stop">
            <span class="meeting-btn__icon meeting-btn__icon--danger" data-field="stop-icon"></span>
            <span data-field="stop-label">结束</span>
          </button>
        </div>
      </div>
    </header>
    <div class="meeting-hotwords" data-field="hotwords"></div>
    <div class="meeting-hint" data-field="hint"></div>
    <div class="meeting-banners" data-field="banners"></div>
    <div class="meeting-body">
      <div class="meeting-editor" data-field="editor" role="tabpanel" id="${viewId}-notes-panel" aria-labelledby="${viewId}-notes-tab"></div>
      <section class="meeting-view meeting-view--summary" data-view-content="summary" role="tabpanel" id="${viewId}-summary-panel" aria-labelledby="${viewId}-summary-tab" hidden></section>
      <section class="meeting-view meeting-view--transcript" data-view-content="transcript" role="tabpanel" id="${viewId}-transcript-panel" aria-labelledby="${viewId}-transcript-tab" hidden>
        <div class="meeting-transcript-tools">
          <label class="meeting-search meeting-transcript-search">${icon("iconMeetingSearch")}<input type="search" data-field="transcript-search" aria-label="搜索转写内容" placeholder="搜索转写内容"></label>
          <span class="meeting-search-count" data-field="search-count" role="status" aria-live="polite"></span>
          <button type="button" class="meeting-icon-btn" data-action="previous-match" aria-label="上一处匹配" title="上一处（Shift+Enter）">↑</button>
          <button type="button" class="meeting-icon-btn" data-action="next-match" aria-label="下一处匹配" title="下一处（Enter）">↓</button>
          <button type="button" class="meeting-btn" data-action="follow" aria-pressed="true">跟随播放</button>
          <button type="button" class="meeting-btn" data-action="edit-transcript">编辑转写</button>
        </div>
        <div class="meeting-player-section" data-section="player"></div>
        <div class="meeting-transcript-reader" data-field="transcript-reader" tabindex="0" aria-label="转写阅读区">
          <div class="meeting-recordings-section" data-section="recordings"></div>
          <div class="meeting-transcript-section" data-section="transcript"></div>
        </div>
        <div class="meeting-transcript-native-editor" data-field="transcript-editor" hidden></div>
      </section>
    </div>`;
  tab.element.replaceChildren(root);

  const field = (name) => root.querySelector(`[data-field="${name}"]`);
  const action = (name) => root.querySelector(`[data-action="${name}"]`);
  const titleInput = root.querySelector(".meeting-title");
  const editorElement = field("editor");
  const ui = loadUiState(docId);

  const state = {
    docId,
    tab,
    root,
    plugin,
    controller: plugin.controller,
    meeting: null,
    recordings: [],
    transcript: [],
    transcriptionRequests: new Map(),
    summaries: [],
    summaryDocId: "",
    summaryContent: "",
    summaryGenerating: false,
    summarySaving: false,
    summaryStream: "",
    summaryDraft: null,
    summaryError: "",
    summaryNotice: "",
    summaryOnlyNotes: false,
    summarySelectedIds: null,
    summaryTemplateId: "general",
    summaryTemplateSaving: false,
    summaryBasisInitialized: "",
    summaryAbort: null,
    material: null,
    materialDirty: true,
    selectedRecordingId: "",
    transcriptEditing: false,
    transcriptProtyle: null,
    transcriptQuery: "",
    transcriptMatches: [],
    activeMatch: -1,
    followPlayback: true,
    followLive: true,
    transcriptRows: [],
    playbackKey: "",
    transcriptScrollTop: 0,
    peaks: null,
    playbackRate: 1,
    audio: new Audio(),
    ui,
    snapshot: plugin.controller.snapshot(),
    devices: [],
    micDeviceId: "",
    mode: plugin.controller.getPrefs().mode || "offline",
    protyle: null,
    summaryProtyle: null,
    summaryEditorId: "",
    summaryEditorElement: null,
    destroyed: false,
    timers: new Set(),
    cleanups: [],
    lastSavedKey: "",
  };
  state.audio.preload = "metadata";
  state.micDeviceId = plugin.controller.getPrefs().deviceId || "";

  const cleanupFns = [];
  const onCleanup = (fn) => cleanupFns.push(fn);
  // SiYuan calls custom-tab update after a sync merge or native doc reload.
  const refreshSyncedMeeting = debounce(async () => {
    if (state.destroyed || !state.meeting) return;
    try {
      await Promise.all(tab.editors.map((editor) => editor.flushPendingTransactions()));
      if (state.destroyed) return;
      await refreshAll(state);
      if (state.destroyed) return;
      for (const editor of tab.editors) editor.reload(false);
    } catch (error) {
      if (!state.destroyed) showMessage(`刷新会议数据失败：${error.message}`, 6000, "error");
    }
  }, 300);
  tab.meetingRefresh = refreshSyncedMeeting;
  onCleanup(() => {
    refreshSyncedMeeting.cancel();
    delete tab.meetingRefresh;
    tab.editors = [];
  });

  const rerenderChrome = () => renderChrome(state, field, action);
  const unsubscribe = plugin.controller.subscribe((snapshot) => {
    if (state.destroyed) return;
    const previous = state.snapshot;
    state.snapshot = snapshot;
    if (snapshot.meeting?.id === docId && state.meeting && snapshot.meeting.firstRecordedAt) {
      state.meeting.firstRecordedAt = snapshot.meeting.firstRecordedAt;
    }
    rerenderChrome();
    if (state.meeting && previous.phase !== snapshot.phase) {
      renderMeetingView(state);
    }
    if (
      snapshot.phase === "saved" &&
      snapshot.lastSaved?.meetingDocId === docId &&
      snapshot.savedAt !== previous.savedAt
    ) {
      void refreshAfterSave(state);
    }
    if (snapshot.pendingRecoveries !== previous.pendingRecoveries) {
      renderBanners(state);
    }
  });
  onCleanup(unsubscribe);

  const onSeek = (seek) => {
    if (state.destroyed || seek?.docId !== docId || !state.meeting) return;
    plugin.controller.consumeSeek(docId);
    void applySeekToMeeting(state, seek).catch((error) =>
      showMessage(`定位录音失败：${error.message}`, 5000, "error"),
    );
  };
  plugin.controller.seekEmitter.on("seek", onSeek);
  onCleanup(() => plugin.controller.seekEmitter.off("seek", onSeek));

  const unsubscribeTranscription = plugin.transcription.subscribe((event) => {
    if (state.destroyed || event.meetingId !== docId) return;
    const recording = state.recordings.find((item) => item.recordingId === event.recordingId);
    if (recording) {
      recording.transcriptionStatus = event.status;
      recording.transcriptionError = event.error || "";
    }
    renderTranscriptionFeedback(state);
    if (event.status === "processing") return;
    // Realtime batches carry their written rows; the whole transcript is
    // reread only when the recording segment's state settles.
    if (event.status === "recording" && recording) {
      if (!event.appended?.length) return;
      const known = new Set(state.transcript.map((item) => item.blockId));
      state.transcript = [...state.transcript, ...event.appended.filter((item) => !known.has(item.blockId))]
        .sort((a, b) => a.startMs - b.startMs);
      state.materialDirty = true;
      if (resolveMeetingView(state) === "transcript" && !state.transcriptEditing) renderTranscriptView(state);
      if (resolveMeetingView(state) === "summary") void safeRefreshMaterial(state);
      renderViewStatus(state);
      return;
    }
    state.materialDirty = true;
    void Promise.all([refreshRecordings(state), refreshTranscript(state)]).then(() => {
      if (state.destroyed) return;
      if (resolveMeetingView(state) === "transcript") renderTranscriptView(state);
      if (resolveMeetingView(state) === "summary") void safeRefreshMaterial(state);
    }).catch((error) => showMessage(`刷新转写失败：${error.message}`, 5000, "error"));
  });
  onCleanup(unsubscribeTranscription);
  onCleanup(plugin.summaryTemplates.subscribe(() => {
    if (!state.destroyed) renderSummary(state);
  }));

  const refreshTitleFromServer = debounce(async () => {
    if (state.destroyed || !state.meeting) return;
    if (document.activeElement === titleInput) return;
    try {
      const info = await api.getBlockInfo(docId);
      const title = String(info?.rootTitle || info?.title || "").trim();
      if (!title || title === state.meeting.title) return;
      state.meeting.title = title;
      titleInput.value = title;
      state.tab.tab?.updateTitle?.(title);
      state.controller.noteMeetingTitle(docId, title);
      state.materialDirty = true;
    } catch {
      // A rename in another tab may race with indexing; the next ws event retries.
    }
  }, 400);
  onCleanup(() => refreshTitleFromServer.cancel());

  const onWs = (event) => {
    if (state.destroyed) return;
    const payload = event?.detail || event;
    if (!payload) return;
    const cmd = payload.cmd || payload.command;
    if (cmd === "rename") {
      const title = payload.data?.title;
      const renamedId = payload.data?.id;
      if ((!renamedId || renamedId === docId) && title && state.meeting) {
        state.meeting.title = title;
        if (document.activeElement !== titleInput) titleInput.value = title;
        state.tab.tab?.updateTitle?.(title);
        state.controller.noteMeetingTitle(docId, title);
      }
      // Some rename events do not carry the title/id; verify against the doc.
      if (!renamedId || renamedId === docId) refreshTitleFromServer();
    }
    if (cmd === "transactions") {
      markMaterialDirty();
      refreshNativeTranscript();
    }
  };
  plugin.eventBus.on("ws-main", onWs);
  onCleanup(() => plugin.eventBus.off("ws-main", onWs));

  titleInput.addEventListener("change", () => void renameFromInput(state, titleInput));
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      titleInput.blur();
    }
    if (event.key === "Escape") {
      titleInput.value = state.meeting?.title || "";
      titleInput.blur();
    }
  });

  root.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      plugin.controller.setPrefs({ mode: state.mode });
      renderChrome(state, field, action);
    });
  });

  field("mic").addEventListener("change", () => {
    state.micDeviceId = field("mic").value;
    plugin.controller.setPrefs({ deviceId: state.micDeviceId });
  });
  action("refresh-devices").addEventListener("click", () => void loadDevices(state, field));

  action("import-audio").addEventListener("click", () => {
    if (!state.meeting?.isMeeting) return;
    const dialog = openImport(state.meeting, () => refreshAll(state));
    onCleanup(() => dialog.destroy());
  });
  action("start").addEventListener("click", () => void startFromMeeting(state));
  action("pause").addEventListener("click", () => void togglePause(state));
  action("stop").addEventListener("click", () => void stopMeeting(state));
  action("more").addEventListener("click", () => openMoreMenu(state));
  const reader = field("transcript-reader");
  reader.addEventListener("scroll", () => {
    if (reader.scrollTop < state.transcriptScrollTop - 1) {
      if (isLiveTranscript(state)) state.followLive = false;
      else state.followPlayback = false;
      renderTranscriptTools(state);
    }
    state.transcriptScrollTop = reader.scrollTop;
  });
  field("transcript-search").addEventListener("input", (event) => {
    state.transcriptQuery = event.target.value;
    state.activeMatch = -1;
    if (state.transcriptQuery.trim()) state.followPlayback = state.followLive = false;
    renderTranscript(state);
    navigateTranscriptMatch(state, 0);
  });
  field("transcript-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateTranscriptMatch(state, event.shiftKey ? -1 : 1);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.target.value = state.transcriptQuery = "";
      renderTranscript(state);
      reader.focus();
    }
  });
  action("previous-match").onclick = () => navigateTranscriptMatch(state, -1);
  action("next-match").onclick = () => navigateTranscriptMatch(state, 1);
  action("follow").onclick = () => {
    const live = isLiveTranscript(state);
    if (live) state.followLive = !state.followLive;
    else state.followPlayback = !state.followPlayback;
    state.playbackKey = "";
    renderTranscriptTools(state);
    if (live && state.followLive) scrollTranscriptTo(state, reader.scrollHeight);
    else updatePlaybackTranscript(state);
  };
  action("edit-transcript").onclick = () => void toggleTranscriptEditor(state);
  root.addEventListener("keydown", (event) => {
    if (resolveMeetingView(state) !== "transcript" || state.transcriptEditing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      field("transcript-search").focus();
      field("transcript-search").select();
    } else if (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !event.target.closest('button, input, select, textarea, summary, a, [contenteditable="true"]') &&
        !isLiveTranscript(state) && state.audio.getAttribute("src")) {
      event.preventDefault();
      if (state.audio.paused) void playAudio(state);
      else state.audio.pause();
    }
  });
  action("open-doc").addEventListener("click", () => {
    void api.openDoc(plugin.app, docId).catch((error) => showMessage(error.message, 5000, "error"));
  });
  root.querySelectorAll(".meeting-view-switcher [data-view]").forEach((button) => {
    button.addEventListener("click", () => setMeetingView(state, button.dataset.view));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(root.querySelectorAll(".meeting-view-switcher [data-view]"));
      const index = tabs.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setMeetingView(state, tabs[next].dataset.view);
      tabs[next].focus();
    });
  });

  state.audio.addEventListener("timeupdate", () => updatePlayer(state));
  state.audio.addEventListener("play", () => updatePlayer(state));
  state.audio.addEventListener("pause", () => updatePlayer(state));
  state.audio.addEventListener("ended", () => updatePlayer(state));
  state.audio.addEventListener("loadedmetadata", () => updatePlayer(state));
  state.audio.addEventListener("error", () => {
    if (state.audio.getAttribute("src")) {
      showMessage("无法播放这段录音，资源可能尚未同步到本机", 5000, "error");
    }
  });

  const markMaterialDirty = debounce(() => {
    if (state.destroyed) return;
    state.materialDirty = true;
    if (resolveMeetingView(state) === "summary") {
      state.materialDirty = false;
      void safeRefreshMaterial(state);
    }
  }, 500);
  const refreshNativeTranscript = debounce(() => {
    if (state.destroyed || !state.meeting || state.transcriptEditing) return;
    void refreshTranscript(state).catch((error) => showMessage(`刷新转写失败：${error.message}`, 5000, "error"));
  }, 500);
  onCleanup(() => refreshNativeTranscript.cancel());

  void initialize();

  async function initialize() {
    try {
      state.meeting = await meetingStore.getMeeting(docId);
      state.summaryTemplateId = state.meeting.summaryTemplate || "general";
      plugin.controller.selectMeeting(state.meeting);
      titleInput.value = state.meeting.title || "";
      tab.tab?.updateTitle?.(state.meeting.title || "");
      if (!state.meeting.isMeeting) {
        showMessage("这篇文档没有会议属性，录音功能不可用", 6000, "error");
      }
      state.protyle = new Protyle(plugin.app, editorElement, {
        blockId: docId,
        mode: "wysiwyg",
        action: ["cb-get-all"],
        render: {
          background: false,
          title: false,
          gutter: true,
          breadcrumb: false,
          scroll: true,
        },
      });
      registerMeetingEditors(state);
      const wysiwyg = state.protyle?.protyle?.wysiwyg?.element;
      if (wysiwyg) {
        wysiwyg.classList.add("meeting-notes-editor");
        wysiwyg.addEventListener("input", markMaterialDirty);
        onCleanup(() => wysiwyg.removeEventListener("input", markMaterialDirty));
      }
      await Promise.all([
        refreshRecordings(state),
        refreshTranscript(state),
        refreshSummaries(state),
      ]);
      await safeRefreshMaterial(state);
      await loadDevices(state, field);
      renderChrome(state, field, action);
      renderMeetingView(state);
      renderBanners(state);
      await plugin.transcription.resumePending(state.meeting);
      const pendingSeek = plugin.controller.consumeSeek(docId);
      if (pendingSeek) {
        await applySeekToMeeting(state, pendingSeek).catch((error) =>
          showMessage(`定位录音失败：${error.message}`, 5000, "error"),
        );
      }
    } catch (error) {
      showMessage(`打开会议失败：${error.message}`, 8000, "error");
      renderFatal(state, error);
    }
  }

  function destroy() {
    state.destroyed = true;
    cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore cleanup errors
      }
    });
    clearTimeout(state.searchTimer);
    state.waveObserver?.disconnect();
    try {
      state.audio.pause();
      state.audio.src = "";
    } catch {
      // ignore
    }
    state.summaryAbort?.abort();
    clearTimeout(state.streamTimer);
    try {
      state.summaryProtyle?.destroy();
      state.transcriptProtyle?.destroy();
      state.protyle?.destroy();
    } catch {
      // editor may already be destroyed by SiYuan
    }
  }

  tab.meetingCleanup = destroy;
  return destroy;
}

async function renameFromInput(state, input) {
  const title = input.value.trim();
  if (!title) {
    input.value = state.meeting?.title || "";
    return;
  }
  if (title === state.meeting?.title) return;
  try {
    const next = await state.controller.renameMeeting(state.docId, title);
    state.meeting.title = next;
    state.tab.tab?.updateTitle?.(next);
  } catch (error) {
    input.value = state.meeting?.title || "";
    showMessage(`重命名失败：${error.message}`, 6000, "error");
  }
}

async function loadDevices(state, field) {
  const select = field("mic");
  const devices = await state.controller.getDevices(true);
  state.devices = devices;
  select.replaceChildren(new Option("系统默认麦克风", ""));
  devices.forEach((device, index) => {
    select.add(new Option(device.label || `麦克风 ${index + 1}`, device.deviceId));
  });
  if (state.micDeviceId && !devices.some((item) => item.deviceId === state.micDeviceId)) {
    state.micDeviceId = "";
  }
  select.value = state.micDeviceId;
}

async function startFromMeeting(state) {
  if (state.controller.isBusy()) {
    showMessage("已有会议在录音", 4000, "error");
    return;
  }
  try {
    await state.controller.startRecording({
      docId: state.docId,
      online: state.mode === "online",
      deviceId: state.micDeviceId,
    });
  } catch (error) {
    showMessage(error.message, 7000, "error");
  }
}

async function togglePause(state) {
  try {
    if (state.snapshot.phase === "paused") await state.controller.resume();
    else await state.controller.pause();
  } catch (error) {
    showMessage(error.message, 6000, "error");
  }
}

async function stopMeeting(state) {
  try {
    await state.controller.stop();
  } catch (error) {
    showMessage(error.message, 6000, "error");
  }
}

function renderChrome(state, field, action) {
  renderMeetingHotwords(state);
  const snapshot = state.snapshot || state.controller.snapshot();
  const phase = snapshot.phase || "idle";
  const activeHere = snapshot.meeting?.id === state.docId;
  state.root.dataset.theme = state.controller.isDark() ? "dark" : "light";
  const anotherActive = state.controller.isBusy() && !activeHere;
  state.root.dataset.phase = activeHere ? phase : anotherActive ? "blocked" : "idle";
  state.root.classList.toggle("is-active", activeHere && ["preparing", "recording", "paused", "saving", "error"].includes(phase));

  const live = activeHere && ["preparing", "recording", "paused", "saving", "error"].includes(phase);
  const setup = state.root.querySelector(".meeting-controlbar__setup");
  const liveBar = state.root.querySelector(".meeting-controlbar__live");
  setup.hidden = live;
  liveBar.hidden = !live;

  const hasSegments = Boolean(state.meeting?.segments) || state.recordings.length > 0;
  rootSetText(field("start-label"), hasSegments ? "补录" : "开始录音");
  action("start").disabled = Boolean(anotherActive) || Boolean(state.hotwordsSaving) || state.meeting?.isMeeting === false;
  action("start").title = anotherActive ? "已有其他会议在录音" : hasSegments ? "在原会议下新增录音段" : "开始录音";

  state.root.querySelectorAll("[data-mode]").forEach((button) => {
    const selected = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  // Live controls
  const timer = field("timer");
  if (timer) timer.textContent = formatDuration(snapshot.elapsedMs || 0);
  field("live-state").textContent =
    phase === "preparing" ? "正在准备" : phase === "paused" ? "已暂停" : phase === "saving" ? "正在保存" : phase === "error" ? "需要处理" : "";

  const pauseButton = action("pause");
  const stopButton = action("stop");
  const pauseIcon = pauseButton.querySelector('[data-field="pause-icon"]');
  const stopIcon = stopButton.querySelector('[data-field="stop-icon"]');
  const paused = phase === "paused";
  const pauseKind = paused ? "play" : "pause";
  if (pauseIcon && pauseIcon.dataset.kind !== pauseKind) {
    pauseIcon.dataset.kind = pauseKind;
    pauseIcon.innerHTML = paused ? ICON_PLAY_12 : ICON_PAUSE_12;
  }
  rootSetText(pauseButton.querySelector('[data-field="pause-label"]'), paused ? "继续" : "暂停");
  pauseButton.disabled = !["recording", "paused"].includes(phase);
  const stopKind = phase === "saving" ? "loading" : "square";
  if (stopIcon && stopIcon.dataset.kind !== stopKind) {
    stopIcon.dataset.kind = stopKind;
    stopIcon.innerHTML = stopKind === "loading" ? ICON_SPINNER : ICON_SQUARE_12;
  }
  rootSetText(
    stopButton.querySelector('[data-field="stop-label"]'),
    phase === "saving" ? "正在保存…" : "结束",
  );
  stopButton.disabled = phase === "saving";

  const online = live ? snapshot.online : state.mode === "online";
  const deviceId = live ? snapshot.deviceId : state.micDeviceId;
  const deviceName = state.devices.find((device) => device.deviceId === deviceId)?.label || "系统默认麦克风";
  rootSetText(field("source"), `${online ? "麦克风 + 电脑声音" : "仅麦克风"} · ${deviceName}`);
  const capturing = live && ["recording", "paused"].includes(phase);
  field("levels").hidden = !capturing;
  field("levels").title = field("source").textContent;
  field("online-tip").hidden = !online;
  if (!anotherActive) action("start").title += ` · ${field("source").textContent}${online ? "。请使用耳机，避免外放声音被重复录入" : ""}`;
  field("speaker-level").hidden = !online;
  field("mic-level").value = phase === "recording" ? Math.min(1, Math.max(0, Number(snapshot.levels?.[0] || 0)) * 6) : 0;
  field("speaker-level").value = phase === "recording" ? Math.min(1, Math.max(0, Number(snapshot.levels?.[1] || 0)) * 6) : 0;
  renderViewStatus(state);
  renderHint(state, field);
  renderBanners(state);
}

function rootSetText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function renderHint(state, field) {
  const snapshot = state.snapshot;
  const phase = snapshot.phase;
  const activeHere = snapshot.meeting?.id === state.docId;
  const anotherActive = state.controller.isBusy() && !activeHere;
  let hint = "";
  if (anotherActive) {
    hint = `已有会议在录音：${snapshot.meeting?.title || "其他会议"}`;
  } else if (phase === "recording" || phase === "paused") {
    // The control bar carries routine state; this row is for notices only.
    hint = snapshot.notice || "";
  } else if (phase === "error" && activeHere) {
    hint = snapshot.saveFailed
      ? "音频仍保存在本机，归档失败不会丢弃已录内容。"
      : "采集需要处理；已写入的部分不会丢弃。";
  }
  rootSetText(field("hint"), hint);
}

function renderBanners(state) {
  const container = state.root.querySelector('[data-field="banners"]');
  if (!container) return;
  const snapshot = state.snapshot;
  const recovery = state.controller.pendingRecoveries.find(
    (item) => item.meta?.docId === state.docId,
  );
  const signature = [
    recovery?.dir || "",
    recovery?.seconds || "",
    snapshot.saveFailed ? 1 : 0,
    snapshot.error || "",
    snapshot.needsAttention || "",
    snapshot.realtimeNotice || "",
    snapshot.hasStore ? 1 : 0,
    snapshot.phase || "",
  ].join("|");
  if (state.bannerSignature === signature) return;
  state.bannerSignature = signature;
  container.replaceChildren();

  if (snapshot.realtimeNotice && snapshot.meeting?.id === state.docId && state.plugin.transcription.isConfigured()) {
    const banner = h("div", "meeting-inline-notice");
    banner.append(h("span", "", snapshot.realtimeNotice));
    const settings = h("button", "meeting-link", "查看设置");
    settings.onclick = () => openSettings(state.plugin);
    banner.append(settings);
    container.append(banner);
  }

  if (recovery) {
    const banner = h("div", "meeting-banner meeting-banner--warning");
    const text = recovery.interrupted
      ? `上次录音在 ${formatClock(recovery.meta?.startedAt)} 意外中断，已保存 ${formatDuration(
          (recovery.seconds || 0) * 1000,
        )}。`
      : `上次录音已保存在本机但尚未归档（${formatDuration((recovery.seconds || 0) * 1000)}）。`;
    banner.innerHTML = `${icon("iconMeetingWarning")}<span>${escapeHtml(text)}</span>`;
    const save = h("button", "meeting-banner__action", "保存已录部分");
    save.onclick = async () => {
      save.disabled = true;
      try {
        await state.controller.recoverRecording(recovery.dir);
        await refreshAfterSave(state);
        showMessage("已恢复并归档上次录音", 4000);
      } catch (error) {
        showMessage(`恢复失败：${error.message}`, 7000, "error");
        save.disabled = false;
      }
    };
    const later = h("button", "meeting-banner__quiet", "稍后处理");
    later.onclick = () => void state.controller.dismissRecovery(recovery.dir);
    banner.append(save, later);
    container.append(banner);
  }

  if (snapshot.saveFailed && snapshot.meeting?.id === state.docId) {
    const banner = h("div", "meeting-banner meeting-banner--error");
    banner.innerHTML = `${icon("iconMeetingWarning")}<span>${escapeHtml(snapshot.error || "保存失败")}</span>`;
    const retry = h("button", "meeting-banner__action", "重试归档");
    retry.onclick = async () => {
      retry.disabled = true;
      await state.controller.retryPendingArchives();
      await refreshAfterSave(state);
      retry.disabled = false;
    };
    banner.append(retry);
    if (state.snapshot.lastSaved?.file) {
      const open = h("button", "meeting-banner__quiet", "在文件夹中显示");
      open.onclick = () => showLastSaved(state);
      banner.append(open);
    }
    container.append(banner);
  } else if (
    snapshot.needsAttention &&
    snapshot.meeting?.id === state.docId &&
    state.controller.isActive()
  ) {
    const banner = h("div", "meeting-banner meeting-banner--warning");
    banner.innerHTML = `${icon("iconMeetingWarning")}<span>${escapeHtml(
      snapshot.needsAttention,
    )}</span>`;
    const reconnect = h("button", "meeting-banner__action", "重新连接");
    reconnect.onclick = async () => {
      try {
        await state.controller.reconnect();
      } catch (error) {
        showMessage(error.message, 6000, "error");
      }
    };
    const stop = h("button", "meeting-banner__quiet", "结束并保存");
    stop.onclick = () => void stopMeeting(state);
    banner.append(reconnect, stop);
    container.append(banner);
  } else if (state.snapshot.error && state.snapshot.meeting?.id === state.docId && !state.snapshot.saveFailed) {
    const banner = h("div", "meeting-banner meeting-banner--error");
    banner.innerHTML = `${icon("iconMeetingWarning")}<span>${escapeHtml(state.snapshot.error)}</span>`;
    if (state.snapshot.hasStore && ["recording", "preparing"].includes(state.snapshot.phase)) {
      const reconnect = h("button", "meeting-banner__action", "重新连接");
      reconnect.onclick = async () => {
        try {
          await state.controller.reconnect();
        } catch (error) {
          showMessage(error.message, 6000, "error");
        }
      };
      const stop = h("button", "meeting-banner__quiet", "结束并保存");
      stop.onclick = () => void stopMeeting(state);
      banner.append(reconnect, stop);
    } else if (state.snapshot.hasStore) {
      const stop = h("button", "meeting-banner__action", "结束并保存");
      stop.onclick = () => void stopMeeting(state);
      banner.append(stop);
    } else {
      const close = h("button", "meeting-banner__quiet", "知道了");
      close.onclick = () => {
        state.snapshot = { ...state.snapshot, error: "", needsAttention: "" };
        renderBanners(state);
      };
      banner.append(close);
    }
    container.append(banner);
  }
}

function showLastSaved(state) {
  const saved = state.snapshot.lastSaved;
  const file = saved?.file;
  if (!file) return;
  try {
    const { shell } = require("@electron/remote");
    shell.showItemInFolder(file);
  } catch {
    showMessage(file, 6000);
  }
}

function defaultMeetingView(state) {
  const active =
    state.snapshot.meeting?.id === state.docId &&
    ["preparing", "recording", "paused", "saving"].includes(state.snapshot.phase);
  if (active) return "notes";
  return state.summaries.length ? "summary" : "notes";
}

function resolveMeetingView(state) {
  return MEETING_VIEWS.includes(state.ui.view) ? state.ui.view : defaultMeetingView(state);
}

function registerMeetingEditors(state) {
  state.tab.editors = [state.protyle, state.summaryProtyle, state.transcriptProtyle].filter(Boolean);
}

function setMeetingView(state, view) {
  if (!MEETING_VIEWS.includes(view)) return;
  state.ui.view = view;
  saveUiState(state.docId, state.ui);
  renderMeetingView(state);
}

function renderMeetingView(state) {
  if (state.destroyed) return;
  const view = resolveMeetingView(state);
  state.root.dataset.view = view;
  if (view !== "transcript") state.audio.pause();
  const editor = state.root.querySelector(".meeting-editor");
  const summary = state.root.querySelector('[data-view-content="summary"]');
  const transcript = state.root.querySelector('[data-view-content="transcript"]');
  if (editor) editor.hidden = view !== "notes";
  if (summary) summary.hidden = view !== "summary";
  if (transcript) transcript.hidden = view !== "transcript";
  state.root.querySelectorAll(".meeting-view-switcher [data-view]").forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  if (view === "notes") {
    requestAnimationFrame(() => {
      try {
        state.protyle?.resize?.();
      } catch {
        // the editor may have been disposed
      }
    });
    return;
  }
  if (view === "summary") {
    if (state.materialDirty) {
      state.materialDirty = false;
      void safeRefreshMaterial(state);
    } else {
      renderSummary(state);
    }
    return;
  }
  renderTranscriptView(state);
}

function renderTranscriptView(state) {
  const recordings = state.root.querySelector('[data-section="recordings"]');
  const transcript = state.root.querySelector('[data-section="transcript"]');
  const active = state.snapshot.meeting?.id === state.docId &&
    ["preparing", "recording", "paused", "saving"].includes(state.snapshot.phase);
  const player = state.root.querySelector('[data-section="player"]');
  if (player) player.hidden = active || state.transcriptEditing;
  if (recordings) {
    recordings.hidden = active;
    if (!active) renderRecordings(state, recordings);
    else state.audio.pause();
  }
  if (transcript) renderTranscript(state, transcript);
  renderTranscriptTools(state);
  state.transcriptProtyle?.resize?.();
}

async function applySeekToMeeting(state, seek) {
  if (isLiveTranscript(state)) {
    showMessage("本场录音结束保存后可回听", 3000);
    return;
  }
  if (!state.recordings.some((item) => item.recordingId === seek.recordingId)) {
    await refreshRecordings(state);
  }
  if (!state.recordings.some((item) => item.recordingId === seek.recordingId)) return;
  if (state.transcriptEditing) {
    state.transcriptEditing = false;
    state.materialDirty = true;
  }
  state.selectedRecordingId = seek.recordingId;
  state.ui.view = "transcript";
  saveUiState(state.docId, state.ui);
  renderMeetingView(state);
  const play = () => {
    if (state.destroyed || state.audio.dataset.recordingId !== seek.recordingId || isLiveTranscript(state)) return;
    try {
      state.audio.currentTime = Math.max(0, Number(seek.startMs || 0) / 1000);
      state.playbackKey = "";
      void playAudio(state);
    } catch {
      // the asset may not be playable on this device
    }
  };
  if (!state.audio.getAttribute("src")) return;
  if (state.audio.readyState > 0) play();
  else state.audio.addEventListener("loadedmetadata", play, { once: true });
}

async function refreshRecordings(state) {
  const { recordings } = await meetingStore.readRecordings(state.meeting);
  // The save result is authoritative while SiYuan's SQL index catches up.
  const saved = state.snapshot.lastSaved;
  if (saved?.meetingDocId === state.docId && saved.recordingId && saved.assetPath &&
      !recordings.some((item) => item.recordingId === saved.recordingId)) {
    recordings.push({ ...saved, startedAt: saved.meta?.startedAt || "",
      channels: saved.meta?.channels || 1, sampleRate: saved.meta?.sampleRate || 16000 });
    recordings.sort((a, b) => a.index - b.index);
  }
  state.recordings = recordings;
  state.meeting.segments = recordings.length;
  if (
    !state.selectedRecordingId ||
    !recordings.some((item) => item.recordingId === state.selectedRecordingId)
  ) {
    state.selectedRecordingId = recordings[recordings.length - 1]?.recordingId || "";
  }
  const section = state.root.querySelector('[data-section="recordings"]');
  if (section && !isLiveTranscript(state) && !state.transcriptEditing) renderRecordings(state, section);
  renderViewStatus(state);
}

async function refreshTranscript(state) {
  const { segments } = await meetingStore.readTranscript(state.meeting);
  state.transcript = segments;
  const section = state.root.querySelector('[data-section="transcript"]');
  if (section && resolveMeetingView(state) === "transcript" && !state.transcriptEditing) renderTranscript(state, section);
  renderViewStatus(state);
}

async function refreshSummaries(state) {
  state.summaries = await meetingStore.readSummaries(state.meeting);
  const latest = state.summaries[0];
  if (latest) {
    state.summaryDocId = latest.id;
    state.summaryContent = await meetingStore.readSummaryContent(latest.id);
    if (state.summaryBasisInitialized !== latest.id) {
      state.summaryBasisInitialized = latest.id;
      state.summaryOnlyNotes = Boolean(latest.basis?.onlyNotes);
      state.summarySelectedIds = Array.isArray(latest.basis?.recordingIds) ? latest.basis.recordingIds : null;
      state.materialDirty = true;
    }
  } else {
    state.summaryDocId = "";
    state.summaryContent = "";
  }
  renderSummary(state);
}

function safeRefreshMaterial(state) {
  return refreshMaterial(state).catch((error) => {
    state.summaryError = `读取纪要材料失败：${error.message}`;
    renderSummary(state);
  });
}

async function refreshMaterial(state) {
  const [notes, { segments }] = await Promise.all([
    meetingStore.readBodyMarkdown(state.docId), meetingStore.readTranscript(state.meeting),
  ]);
  if (state.destroyed) return;
  state.transcript = segments;
  const selected = state.summarySelectedIds
    ? new Set(state.summarySelectedIds)
    : null;
  const transcript = state.transcript
    .filter((segment) => !selected || selected.has(segment.recordingId))
    .map((segment) => ({
      recordingId: segment.recordingId,
      startMs: segment.startMs,
      speaker: segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`,
      text: segment.text,
    }));
  let preMeetingNotes = state.meeting?.preNotes || "";
  try {
    const local = localStorage.getItem(
      `siyuan-meeting.preNotes.${state.meeting?.meetingId}`,
    );
    if (local) preMeetingNotes = local;
  } catch {
    // storage may be unavailable
  }
  const liveMeeting =
    state.snapshot.meeting?.id === state.docId ? state.snapshot.meeting : null;
  state.material = prompts.buildMaterial({
    title: state.meeting?.title || "",
    startedAt:
      liveMeeting?.firstRecordedAt ||
      state.meeting?.firstRecordedAt ||
      state.meeting?.startedAt ||
      "",
    preMeetingNotes,
    meetingNotes: notes,
    transcript,
    onlyNotes: state.summaryOnlyNotes,
  });
  state.materialDirty = false;
  renderSummary(state);
}

async function refreshAfterSave(state) {
  if (!state.meeting) return;
  try {
    await Promise.all([refreshRecordings(state), refreshTranscript(state)]);
    await safeRefreshMaterial(state);
    renderChrome(
      state,
      (name) => state.root.querySelector(`[data-field="${name}"]`),
      (name) => state.root.querySelector(`[data-action="${name}"]`),
    );
    renderMeetingView(state);
  } catch (error) {
    showMessage(`刷新会议数据失败：${error.message}`, 6000, "error");
  }
}

function renderRecordings(state, section = state.root.querySelector('[data-section="recordings"]')) {
  if (!section) return;
  const playerSection = state.root.querySelector('[data-section="player"]');
  state.waveObserver?.disconnect();
  state.player = null;
  playerSection?.replaceChildren();
  section.replaceChildren();

  if (!state.recordings.length) {
    // The transcript empty state below speaks for an empty meeting.
    state.player = null;
    return;
  }

  const list = h("div", "meeting-segments");
  for (const recording of state.recordings) {
    list.append(segmentCard(state, recording));
  }
  section.append(list);

  const selected = state.recordings.find((item) => item.recordingId === state.selectedRecordingId);
  if (selected && playerSection && !isLiveTranscript(state) && !state.transcriptEditing) playerSection.append(playerView(state, selected));
}

function segmentCard(state, recording) {
  const card = h("div", "meeting-segment");
  card.dataset.recordingId = recording.recordingId;
  card.classList.toggle("is-selected", recording.recordingId === state.selectedRecordingId);
  const selectButton = h("button", "meeting-segment__select");
  selectButton.type = "button";
  selectButton.setAttribute("aria-pressed", String(recording.recordingId === state.selectedRecordingId));

  const task = transcriptionTask(state, recording);
  const status = task.status;
  card.dataset.state = status || "idle";
  card.dataset.phase = task.phase || "idle";
  const top = h("span", "meeting-segment__top");
  const title = h("span", "meeting-segment__title", recordingTitle(recording.index));
  const badge = h("span", `meeting-segment__badge status-${status || "none"}`, statusLabel(status, task.phase));
  badge.title = task.error;
  top.append(title, badge);
  if (recording.recordingId === state.selectedRecordingId) top.append(h("span", "meeting-segment__current", "当前选中"));

  const meta = h(
    "span",
    "meeting-segment__meta",
    `${recordingRange(recording)} · ` + formatDuration(Number(recording.seconds || 0) * 1000, {
      alwaysHours: Number(recording.seconds || 0) >= 3600,
    }),
  );
  selectButton.title = `${recordingTitle(recording.index)} · ${recordingRange(recording)}`;
  if (recording.interrupted) {
    meta.append(h("span", "meeting-segment__notice", "中断后恢复"));
  }
  if (recording.gaps?.length && state.plugin.transcription.isConfigured()) {
    const gaps = h("span", "meeting-segment__notice", "部分未转写");
    gaps.title = `尚未转写：${recording.gaps.map((gap) => `${formatDuration(gap.startMs)}–${formatDuration(gap.endMs)}`).join("、")}`;
    meta.append(gaps);
  }
  if (!recording.assetPath) {
    const warning = h("span", "meeting-segment__warn", "未归档");
    meta.append(warning);
  }

  const actions = h("div", "meeting-segment__actions");
  actions.hidden = recording.recordingId !== state.selectedRecordingId;
  const taskPending = state.plugin.transcription.pendingFor?.(state.docId, recording.recordingId);
  const button = h("button", "meeting-link", "");
  const running = task.running;
  const hasText = state.transcript.some((item) => item.recordingId === recording.recordingId);
  button.textContent = running ? `${statusLabel("processing", task.phase)}…`
    : hasText || status === "done" ? "重新识别整段" : "识别整段";
  button.disabled = running || !recording.assetPath || Boolean(taskPending && !taskPending.saved && !taskPending.failed);
  button.setAttribute("aria-busy", String(running));
  button.title = `${recordingTitle(recording.index)}：识别整段后替换该段转写`;
  button.onclick = (event) => {
    event.stopPropagation();
    void startTranscription(state, recording);
  };
  if (taskPending) {
    const resume = h("button", "meeting-link", taskPending.saved ? "重试清理云端录音" : taskPending.failed ? "清理失败任务" : "继续原任务");
    resume.disabled = running;
    resume.onclick = () => void continueTranscription(state, recording);
    actions.append(resume);
    if (taskPending.canDiscard && !taskPending.saved && !taskPending.failed) {
      const discard = h("button", "meeting-link", "保留现有文字，放弃本次结果");
      discard.disabled = running;
      discard.onclick = async () => {
        if (!await confirmDialog("放弃本次识别结果", "保留现有转写，清理本次任务及云端临时录音。", "放弃结果")) return;
        try { await state.plugin.transcription.discard(state.meeting, recording); renderRecordings(state); }
        catch (error) { showMessage(error.message, 6000, "error"); }
      };
      actions.append(discard);
    }
  }
  actions.append(button);
  selectButton.append(top, meta);
  card.append(selectButton, actions);
  selectButton.onclick = () => {
    state.selectedRecordingId = recording.recordingId;
    renderRecordings(state);
  };
  return card;
}

async function continueTranscription(state, recording) {
  state.transcriptionRequests.delete(recording.recordingId);
  try {
    await state.plugin.transcription.start(state.meeting, recording, { resume: true });
    await refreshRecordings(state);
    renderTranscriptionFeedback(state);
  } catch (error) { showMessage(error.message, 6000, "error"); }
}

async function startTranscription(state, recording) {
  const recordingId = recording.recordingId;
  const task = transcriptionTask(state, recording);
  if (task.running) return;
  if (!state.plugin.transcription.isFileConfigured()) {
    openSettings(state.plugin);
    return;
  }
  state.transcriptionRequests.set(recordingId, { phase: "checking" });
  renderTranscriptionFeedback(state);
  try {
    const { recordings } = await meetingStore.readRecordings(state.meeting);
    recording = recordings.find((item) => item.recordingId === recording.recordingId) || recording;
    const { segments } = await meetingStore.readTranscript(state.meeting);
    const hasText = segments.some((item) => item.recordingId === recording.recordingId);
    const fingerprint = await meetingStore.transcriptFingerprint(state.meeting, recording.recordingId);
    if (hasText || recording.transcriptionStatus === "done") {
      state.transcriptionRequests.set(recordingId, { phase: "confirming" });
      renderTranscriptionFeedback(state);
      const edited = !recording.transcriptionFingerprint || fingerprint !== recording.transcriptionFingerprint;
      const accepted = await confirmDialog("重新转写", edited
        ? "这段转写已被修改。重新识别整段会替换现有转写，你的修改会丢失。"
        : "重新识别整段会替换这段录音的现有转写。", "重新转写");
      if (!accepted) return;
    }
    if (state.destroyed) return;
    state.transcriptionRequests.delete(recordingId);
    await state.plugin.transcription.start(state.meeting, recording, { expectedFingerprint: fingerprint });
  } catch (error) {
    state.transcriptionRequests.set(recordingId, { phase: "failed", error: error.message });
  } finally {
    if (!state.transcriptionRequests.get(recordingId)?.error) state.transcriptionRequests.delete(recordingId);
    renderTranscriptionFeedback(state);
  }
}

function playerView(state, recording) {
  const wrapper = h("div", "meeting-player");
  wrapper.dataset.recordingId = recording.recordingId;
  wrapper.append(h("div", "meeting-player__title", `当前回听：${recordingTitle(recording.index)} · ${recordingRange(recording)}`));
  if (state.audio.dataset.recordingId !== recording.recordingId) {
    try {
      state.audio.pause();
    } catch {
      // ignore
    }
    state.audio.dataset.recordingId = recording.recordingId;
    if (recording.assetPath) {
      state.audio.src = `/${String(recording.assetPath).replace(/^\/+/, "")}`;
    } else {
      state.audio.removeAttribute("src");
      state.audio.load();
    }
    state.audio.playbackRate = state.playbackRate;
    state.peaks = state.controller.readPeaks(recording);
  }

  const row = h("div", "meeting-player__row");
  const play = h("button", "meeting-player__play");
  play.type = "button";
  play.setAttribute("aria-label", "播放录音");
  play.title = "播放 / 暂停";
  play.innerHTML = icon("iconMeetingPlay");
  play.onclick = () => {
    if (!state.audio.getAttribute("src")) return;
    if (state.audio.paused) void playAudio(state);
    else state.audio.pause();
  };
  row.append(play);

  const wave = h("div", "meeting-player__wave");
  const canvas = document.createElement("canvas");
  canvas.className = "meeting-waveform";
  canvas.setAttribute("aria-hidden", "true");
  wave.append(canvas);
  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "meeting-player__seek";
  seek.min = "0";
  seek.max = String(Math.max(1, Number(recording.seconds || 0) * 1000));
  seek.step = "100";
  seek.value = "0";
  seek.setAttribute("aria-label", "回听位置");
  seek.oninput = () => {
    state.audio.currentTime = Number(seek.value) / 1000;
    state.playbackKey = "";
    updatePlayer(state);
  };
  wave.append(seek);
  const marks = h("div", "meeting-wave-marks");
  wave.append(marks);
  row.append(wave);

  const meta = h("div", "meeting-player__meta");
  const times = h("span", "meeting-player__times", "00:00 / 00:00");
  const rate = document.createElement("select");
  rate.className = "meeting-player__rate";
  rate.setAttribute("aria-label", "播放速度");
  for (const value of PLAYBACK_RATES) {
    rate.add(new Option(`${value}x`, String(value), false, value === state.playbackRate));
  }
  rate.onchange = () => {
    state.playbackRate = Number(rate.value);
    state.audio.playbackRate = state.playbackRate;
  };
  meta.append(times, rate);
  row.append(meta);
  wrapper.append(row);
  state.player = { play, canvas, times, marks, recording, seek };
  wrapper.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openPlayerMenu(state, event, recording);
  });

  requestAnimationFrame(() => {
    layoutWaveform(state);
    updatePlayer(state);
  });
  state.waveObserver = new ResizeObserver(() => {
    if (state.player?.canvas !== canvas) return;
    layoutWaveform(state);
    updatePlayer(state);
  });
  state.waveObserver.observe(wave);
  return wrapper;
}

function openPlayerMenu(state, event, recording) {
  const menu = new Menu("meeting-player-menu");
  menu.addItem({
    label: state.audio.paused ? "播放" : "暂停",
    click: () => {
      if (state.audio.paused) void state.audio.play();
      else state.audio.pause();
    },
  });
  menu.addItem({
    label: "停止",
    click: () => {
      state.audio.pause();
      state.audio.currentTime = 0;
      updatePlayer(state);
    },
  });
  menu.addSeparator();
  menu.addItem({
    label: "在文件夹中显示",
    click: () => {
      void api
        .resolveAssetPath(recording.assetPath)
        .then((absolute) => {
          if (!absolute) throw new Error("无法解析资源路径");
          const { shell } = require("@electron/remote");
          shell.showItemInFolder(absolute);
        })
        .catch((error) => showMessage(error.message, 5000, "error"));
    },
  });
  menu.open({ x: event.clientX, y: event.clientY });
}

function layoutWaveform(state) {
  const player = state.player;
  if (!player) return;
  const { canvas, recording } = player;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(40, canvas.clientWidth || 220);
  const height = 24;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  drawWaveform(state, 0);

  const marks = player.marks;
  marks.replaceChildren();
  const events = Array.isArray(recording.events) ? recording.events : [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!["pause", "gap"].includes(event.type)) continue;
    const at = Number(event.elapsedMs || 0);
    const total = Math.max(1, Number(recording.seconds || 0) * 1000);
    const left = Math.min(100, Math.max(0, (at / total) * 100));
    const next = events.slice(index + 1).find((item) => item.type === "resume" || item.type === "start");
    const mark = h("span", "meeting-wave-mark");
    mark.style.left = `${left}%`;
    const label =
      event.type === "pause"
        ? `${formatClock(event.at)} 暂停${next ? `，${formatClock(next.at)} 继续` : ""}`
        : `${formatClock(event.at)} 重新连接`;
    mark.title = label;
    mark.setAttribute("aria-label", label);
    marks.append(mark);
  }
}

function drawWaveform(state, progress) {
  const player = state.player;
  if (!player) return;
  const { canvas } = player;
  const context = canvas.getContext("2d");
  if (!context) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const styles = getComputedStyle(canvas);
  const played = styles.getPropertyValue("--meeting-wave-played").trim() || "#5b5b57";
  const muted = styles.getPropertyValue("--meeting-wave-muted").trim() || "rgba(127,127,127,.3)";
  const points = state.peaks?.points || [];
  const bars = Math.max(1, Math.floor(width / 3));
  const barWidth = 2;
  const gap = 1;
  for (let index = 0; index < bars; index++) {
    const fraction = bars <= 1 ? 0 : index / (bars - 1);
    let value = 0;
    if (points.length) {
      const point = points[Math.min(points.length - 1, Math.round(fraction * (points.length - 1)))];
      value = Math.max(Number(point?.[0] || 0), Number(point?.[1] || 0));
    }
    const heightValue = Math.max(1.5, Math.min(1, value * 2.4) * (height - 4));
    const x = index * (barWidth + gap);
    const y = (height - heightValue) / 2;
    context.fillStyle = fraction <= progress ? played : muted;
    context.beginPath();
    context.roundRect(x, y, barWidth, heightValue, 1);
    context.fill();
  }
}

function updatePlayer(state) {
  const player = state.player;
  if (!player) return;
  const total = Number.isFinite(state.audio.duration) && state.audio.duration > 0
    ? state.audio.duration
    : Number(player.recording.seconds || 0);
  const current = Number(state.audio.currentTime || 0);
  const progress = total > 0 ? Math.min(1, current / total) : 0;
  const withHours = total >= 3600;
  player.times.textContent = `${formatDuration(current * 1000, { alwaysHours: withHours })} / ${formatDuration(
    total * 1000,
    { alwaysHours: withHours },
  )}`;
  const playing = !state.audio.paused;
  player.play.innerHTML = playing ? icon("iconMeetingPause") : icon("iconMeetingPlay");
  player.play.setAttribute("aria-label", playing ? "暂停录音" : "播放录音");
  player.seek.disabled = !state.audio.getAttribute("src") || total <= 0;
  player.seek.max = String(Math.max(1, total * 1000));
  player.seek.value = String(current * 1000);
  player.seek.setAttribute("aria-valuetext", `${formatDuration(current * 1000)} / ${formatDuration(total * 1000)}`);
  drawWaveform(state, progress);
  updatePlaybackTranscript(state);
}

async function playAudio(state) {
  try {
    await state.audio.play();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (!state.destroyed) showMessage("无法播放这段录音，请确认资源已同步到本机", 5000, "error");
  }
}

function isLiveTranscript(state) {
  return state.snapshot.meeting?.id === state.docId &&
    ["preparing", "recording", "paused", "saving"].includes(state.snapshot.phase);
}

function renderViewStatus(state) {
  const button = state.root.querySelector('[data-view="transcript"]');
  if (!button) return;
  const current = state.recordings.find((recording) => recording.recordingId === state.snapshot.recordingId);
  const tasks = state.recordings.map((recording) => transcriptionTask(state, recording));
  const status = isLiveTranscript(state)
    ? !state.snapshot.realtimeEnabled || !state.snapshot.realtimeConfigured ? "off"
      : state.snapshot.realtimeNotice || current?.transcriptionError ? "failed"
      : state.snapshot.phase === "paused" ? "paused" : "recording"
    : tasks.some((task) => task.running || task.status === "processing") ? "processing"
      : tasks.some((task) => ["failed", "incomplete"].includes(task.status)) ||
        state.recordings.some((recording) => recording.transcriptionIssue !== "configuration-required" && recording.gaps?.length) ? "failed"
        : current?.transcriptionIssue === "configuration-required" ? "idle" : current?.transcriptionStatus || "idle";
  button.dataset.state = status;
  button.title = status === "failed" ? "转写需要查看" : status === "processing" ? "正在转写" : status === "recording" ? "实时转写" : status === "off" ? "本段录音未进行实时转写" : status === "paused" ? "实时转写已暂停" : "转写";
  button.setAttribute("aria-label", button.title);
}

function renderTranscriptTools(state) {
  const editing = state.transcriptEditing;
  const live = isLiveTranscript(state);
  const find = (name) => state.root.querySelector(`[data-action="${name}"]`);
  state.root.querySelector('[data-field="transcript-reader"]').hidden = editing;
  state.root.querySelector('[data-field="transcript-editor"]').hidden = !editing;
  state.root.querySelector('[data-section="player"]').hidden = editing || live;
  state.root.querySelector('[data-field="transcript-search"]').disabled = editing;
  const edit = find("edit-transcript");
  edit.textContent = editing ? "完成编辑" : "编辑转写";
  edit.setAttribute("aria-pressed", String(editing));
  edit.disabled = !editing && !state.transcript.length;
  const count = state.transcriptMatches.length;
  const search = Boolean(state.transcriptQuery.trim());
  state.root.querySelector('[data-field="search-count"]').textContent = search ? `${count ? state.activeMatch + 1 : 0} / ${count}` : "";
  find("previous-match").disabled = find("next-match").disabled = editing || !count;
  const follow = find("follow");
  follow.textContent = live ? "跟随最新" : "跟随播放";
  follow.setAttribute("aria-pressed", String(live ? state.followLive : state.followPlayback));
  follow.disabled = editing || search;
  follow.title = search ? "清空搜索后可跟随" : live ? "向上阅读会暂停跟随，点击可恢复" : "播放时跟随当前段落，向上阅读会暂停跟随";
}

function scrollTranscriptTo(state, top) {
  const reader = state.root.querySelector('[data-field="transcript-reader"]');
  reader.scrollTop = Math.max(0, top);
  state.transcriptScrollTop = reader.scrollTop;
}

function revealTranscriptNode(state, node) {
  const reader = state.root.querySelector('[data-field="transcript-reader"]');
  const rect = node.getBoundingClientRect();
  const bounds = reader.getBoundingClientRect();
  if (rect.top >= bounds.top && rect.bottom <= bounds.bottom) return;
  scrollTranscriptTo(state, reader.scrollTop + rect.top - bounds.top - Math.max(0, (reader.clientHeight - rect.height) / 2));
}

function updatePlaybackTranscript(state) {
  const active = new Set(playbackSegments(state.transcript, state.audio.dataset.recordingId, state.audio.currentTime * 1000).map((segment) => segment.blockId));
  for (const row of state.transcriptRows) row.node.dataset.playbackCurrent = String(active.has(row.segment.blockId));
  const key = Array.from(active).join(":");
  if (key !== state.playbackKey && !state.audio.paused && state.followPlayback && !state.transcriptQuery.trim() &&
      resolveMeetingView(state) === "transcript" && !state.transcriptEditing) {
    const row = state.transcriptRows.find((item) => active.has(item.segment.blockId));
    if (row) revealTranscriptNode(state, row.node);
  }
  state.playbackKey = key;
}

function navigateTranscriptMatch(state, direction) {
  const matches = state.transcriptMatches;
  if (!matches.length) return;
  state.activeMatch = (Math.max(0, state.activeMatch) + direction + matches.length) % matches.length;
  const marks = state.root.querySelectorAll("[data-search-match]");
  marks.forEach((mark, index) => { mark.dataset.searchCurrent = String(index === state.activeMatch); });
  const node = marks[state.activeMatch];
  if (node) revealTranscriptNode(state, node);
  renderTranscriptTools(state);
}

async function toggleTranscriptEditor(state) {
  const button = state.root.querySelector('[data-action="edit-transcript"]');
  button.disabled = true;
  try {
    if (state.transcriptEditing) {
      await refreshTranscript(state);
      state.transcriptEditing = false;
      state.materialDirty = true;
    } else {
      const blockId = await meetingStore.ensureTranscriptDoc(state.meeting);
      if (state.destroyed) return;
      state.audio.pause();
      state.transcriptEditing = true;
      if (!state.transcriptProtyle) {
        state.transcriptProtyle = new Protyle(state.plugin.app, state.root.querySelector('[data-field="transcript-editor"]'), {
          blockId, mode: "wysiwyg", action: ["cb-get-all"],
          render: { background: false, title: false, gutter: true, breadcrumb: false, scroll: true },
        });
        registerMeetingEditors(state);
      }
    }
    renderTranscriptView(state);
  } catch (error) {
    showMessage(`切换转写编辑失败：${error.message}`, 5000, "error");
  } finally {
    renderTranscriptTools(state);
  }
}

function renderTranscript(state, section = state.root.querySelector('[data-section="transcript"]')) {
  if (!section) return;
  const reader = state.root.querySelector('[data-field="transcript-reader"]');
  const scrollTop = reader.scrollTop;
  const previousMatch = state.transcriptMatches[state.activeMatch];
  state.transcriptMatches = findTranscriptMatches(state.transcript, state.transcriptQuery);
  const matchesByBlock = new Map();
  state.transcriptMatches.forEach((match, index) => {
    if (!matchesByBlock.has(match.blockId)) matchesByBlock.set(match.blockId, []);
    matchesByBlock.get(match.blockId).push({ ...match, index });
  });
  const retained = previousMatch ? state.transcriptMatches.findIndex((match) => match.blockId === previousMatch.blockId && match.start === previousMatch.start) : -1;
  state.activeMatch = state.transcriptMatches.length ? Math.max(0, retained) : -1;
  state.transcriptRows = [];
  section.replaceChildren();
  const header = h("div", "meeting-view-header");
  header.innerHTML = `<span class="meeting-view-title">转写</span><span class="meeting-view-count">${state.transcript.length}</span>`;
  const open = h("button", "meeting-link", "打开转写文档");
  open.onclick = () => openChildDoc(state, "transcript");
  header.append(open);
  section.append(header);

  const live = isLiveTranscript(state);
  const configured = state.plugin.transcription.isConfigured();
  if (!configured) {
    const notice = h("div", "meeting-inline-notice", "配置转写服务后可使用转写，录音仍可正常保存。");
    notice.dataset.state = "configuration-required";
    const settings = h("button", "meeting-link", "去配置");
    settings.onclick = () => openSettings(state.plugin);
    notice.append(settings);
    section.append(notice);
  } else if (live) {
    // Normal live progress is carried by the tab state and the trailing
    // listening line; only conditions the user should know about get a row.
    const message = !state.snapshot.realtimeEnabled ? "本段录音未开启实时转写，结束保存后可以手动转写。"
      : !state.snapshot.realtimeConfigured ? "本段录音开始时尚未配置转写服务，录音仍在保存。可在会议设置中配置，下一段录音开始生效。"
      : state.snapshot.realtimeNotice || "";
    if (message) section.append(h("div", "meeting-inline-notice", message));
  }
  const listening = live && configured && state.snapshot.phase === "recording" &&
    state.snapshot.realtimeEnabled && state.snapshot.realtimeConfigured && !state.snapshot.realtimeNotice;
  const listeningLine = () => h("p", "meeting-transcript-listening meeting-pulse", "正在聆听…");

  const activeTasks = [];
  for (const recording of state.recordings) {
    const task = transcriptionTask(state, recording);
    const active = task.running || task.status === "processing";
    const failed = Boolean(task.error);
    if (active) activeTasks.push({ recording, task });
    if (!failed || active) continue;
    const feedback = h("div", "meeting-transcription-feedback");
    feedback.dataset.recordingId = recording.recordingId;
    feedback.dataset.state = task.status;
    feedback.dataset.phase = task.phase;
    feedback.setAttribute("role", "alert");
    feedback.append(h("span", "", `${recordingTitle(recording.index)} · ${transcriptionTaskText(task)}`));
    const pending = state.plugin.transcription.pendingFor?.(state.docId, recording.recordingId);
    const retry = h("button", "meeting-link", pending ? pending.saved ? "重试清理" : "继续原任务" : "重新识别整段");
    retry.onclick = () => pending ? void continueTranscription(state, recording) : void startTranscription(state, recording);
    feedback.append(retry);
    section.append(feedback);
  }
  const processing = activeTasks.length > 0;
  if (processing) {
    const status = h("span", "meeting-view-status");
    status.dataset.state = "processing";
    status.setAttribute("role", "status");
    status.setAttribute("aria-busy", "true");
    const text = activeTasks.length === 1
      ? `${recordingTitle(activeTasks[0].recording.index)} · ${transcriptionTaskText(activeTasks[0].task)}`
      : `正在转写 ${activeTasks.length} 段录音`;
    status.append(h("span", "meeting-view-status__text", text));
    status.title = activeTasks.map(({ recording, task }) => `${recordingTitle(recording.index)} · ${transcriptionTaskText(task)}`).join("\n");
    const parts = activeTasks.reduce((sum, { task }) => sum + (task.progress?.partCount > 1 ? task.progress.partCount : 0), 0);
    if (parts) {
      const progress = document.createElement("progress");
      progress.max = parts;
      progress.value = activeTasks.reduce((sum, { task }) => sum + (task.progress?.partCount > 1 ? task.progress.completedParts : 0), 0);
      progress.setAttribute("aria-label", "已识别的录音部分");
      status.append(progress);
    }
    header.insertBefore(status, open);
  }

  if (!state.transcript.length) {
    if (listening) section.append(listeningLine());
    if (!live) section.append(
      emptyState(
        "iconMeetingTranscript",
        "尚无转写",
        processing ? "完成后，转写文字会显示在这里。"
          : !state.recordings.length ? "开始录音后，转写文字会显示在这里。"
          : configured ? "选择录音后点击「转写」。" : "录音保存后，可在这里回听和转写。",
      ),
    );
    renderTranscriptTools(state);
    return;
  }

  const groups = new Map();
  for (const segment of state.transcript) {
    if (!groups.has(segment.recordingId)) groups.set(segment.recordingId, []);
    groups.get(segment.recordingId).push(segment);
  }
  for (const recording of state.recordings) {
    const segments = groups.get(recording.recordingId);
    if (!segments?.length) continue;
    const group = h("div", "meeting-transcript-group");
    const title = h("div", "meeting-transcript-group__title", recordingTitle(recording.index));
    title.append(h("span", "meeting-transcript-group__meta", recordingRange(recording)));
    group.append(title);
    for (const segment of segments) {
      const row = h("div", "meeting-transcript-row");
      row.dataset.blockId = segment.blockId;
      state.transcriptRows.push({ segment, node: row });
      const seek = h(
        "button",
        "meeting-transcript-time",
        formatDuration(segment.startMs),
      );
      seek.type = "button";
      const actual = actualTimeFor(recording, segment.startMs);
      seek.disabled = live || !recording.assetPath;
      seek.title = live ? "结束保存后可回听" : `${actual ? `${actual} · ` : ""}点击回听`;
      seek.onclick = () => {
        void applySeekToMeeting(state, { recordingId: recording.recordingId, startMs: segment.startMs });
      };
      const body = h("div", "meeting-transcript-body");
      const speaker = h(
        "button",
        `meeting-transcript-speaker speaker-${Number(segment.speaker || 0) % SPEAKER_COLORS}`,
        segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`,
      );
      speaker.type = "button";
      speaker.disabled = live || Boolean(segment.notice);
      speaker.title = "重命名本场会议中的同名标签";
      speaker.onclick = () => renameTranscriptSpeaker(state, segment);
      const text = h("span", "meeting-transcript-text");
      let offset = 0;
      for (const match of matchesByBlock.get(segment.blockId) || []) {
        text.append(document.createTextNode(segment.text.slice(offset, match.start)));
        const mark = h("mark", "", segment.text.slice(match.start, match.end));
        mark.dataset.searchMatch = String(match.index);
        mark.dataset.searchCurrent = String(match.index === state.activeMatch);
        text.append(mark);
        offset = match.end;
      }
      text.append(document.createTextNode(segment.text.slice(offset)));
      body.append(speaker, text);
      row.append(seek, body);
      group.append(row);
    }
    section.append(group);
  }
  if (listening) section.append(listeningLine());
  state.playbackKey = "";
  renderTranscriptTools(state);
  if (!state.transcriptEditing) {
    if (live && state.followLive && !state.transcriptQuery.trim()) scrollTranscriptTo(state, reader.scrollHeight);
    else scrollTranscriptTo(state, scrollTop);
    updatePlaybackTranscript(state);
  }
}

function renameTranscriptSpeaker(state, segment) {
  const label = segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`;
  const count = state.transcript.filter((item) => !item.notice && item.speakerLabel === label).length;
  const dialog = new Dialog({
    title: "重命名说话人", width: "440px",
    content: `<div class="b3-dialog__content meeting-rename-speaker">
      <p>修改本场会议中所有「${escapeHtml(label)}」标签，共 ${count} 处。请确认这些标签属于你要修改的说话人。</p>
      <label>新的名称 <input class="b3-text-field" aria-label="新的说话人名称" value="${escapeHtml(label)}"></label>
      <p data-field="error" role="alert"></p>
      <div class="meeting-confirm__actions"><button type="button" class="b3-button b3-button--cancel">取消</button><button type="button" class="b3-button" data-action="save">保存名称</button></div>
    </div>`,
  });
  const input = dialog.element.querySelector("input");
  const save = dialog.element.querySelector('[data-action="save"]');
  dialog.element.querySelector(".b3-button--cancel").onclick = () => dialog.destroy();
  const submit = async () => {
    if (save.disabled) return;
    save.disabled = true;
    try {
      await meetingStore.renameTranscriptSpeaker(state.meeting, label, input.value);
      state.materialDirty = true;
      await refreshTranscript(state);
      dialog.destroy();
    } catch (error) {
      dialog.element.querySelector('[data-field="error"]').textContent = error.message;
      await refreshTranscript(state).catch(() => {});
      save.disabled = false;
    }
  };
  save.onclick = () => void submit();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void submit(); }
  });
  input.focus();
  input.select();
}

function renderSummary(state) {
  if (state.destroyed) return;
  const section = state.root.querySelector('[data-view-content="summary"]');
  if (!section) return;
  const latest = state.summaries[0];
  const changes = latest && state.material ? prompts.summaryChanges(latest.basis, currentSummaryBasis(state)) : [];
  const selectedTemplate = state.plugin.summaryTemplates.get(state.summaryTemplateId);
  const templateUnavailable = !selectedTemplate;
  section.dataset.state = state.summaryError ? "error" : state.summaryGenerating || state.summarySaving ? "generating" : templateUnavailable ? "template-unavailable" : !latest ? "empty" : changes.length ? "outdated" : "current";
  const retainedEditor = state.summaryEditorElement;
  const summaryTab = state.root.querySelector('[data-view="summary"]');
  summaryTab.dataset.state = state.summaryError ? "failed" : state.summaryGenerating || state.summarySaving ? "processing" : "idle";
  summaryTab.setAttribute("aria-label", state.summaryError ? "纪要需要查看" : state.summarySaving ? "正在保存纪要" : state.summaryGenerating ? "正在生成纪要" : "纪要");
  // Keep the native editor alive through material refreshes; replacing it
  // while typing would lose focus and pending edits.
  for (const child of Array.from(section.children)) {
    if (child !== retainedEditor) child.remove();
  }
  if (retainedEditor) retainedEditor.hidden = Boolean(state.summaryGenerating || state.summarySaving || state.summaryError || !latest);
  const header = h("div", "meeting-view-header");
  header.innerHTML = `<span class="meeting-view-title">纪要</span>`;
  header.append(createTemplatePicker({
    store: state.plugin.summaryTemplates,
    selectedId: state.summaryTemplateId,
    disabled: Boolean(state.summaryGenerating || state.summarySaving || state.summaryTemplateSaving),
    onSelect: (id) => void selectSummaryTemplate(state, id).catch(() => {}),
    onManage: () => openTemplateManager({
      store: state.plugin.summaryTemplates, selectedId: state.summaryTemplateId,
      onUse: (id) => {
        if (state.destroyed) return;
        if (state.summaryGenerating || state.summarySaving) throw new Error("纪要正在生成或保存，请完成后再选择模板。");
        return selectSummaryTemplate(state, id);
      },
      confirm: confirmDialog,
    }),
  }));
  section.prepend(header);
  if (templateUnavailable) section.append(h("p", "meeting-inline-notice", state.plugin.summaryTemplates.error || "此模板已不可用，请重新选择模板后再生成。"));

  if (state.summaryGenerating || state.summarySaving) {
    renderSummaryStreaming(state, section);
    return;
  }

  if (state.summaryError) {
    const error = h("div", "meeting-summary-state");
    error.innerHTML = `${icon("iconMeetingWarning", "meeting-summary-state__icon")}
      <p class="meeting-summary-state__title">${state.summaryDraft ? "纪要尚未保存完成" : "纪要生成失败"}</p>
      <p class="meeting-summary-state__text">${escapeHtml(state.summaryError)}</p>`;
    error.setAttribute("role", "alert");
    const retry = h("button", "meeting-btn", state.summaryDraft ? "重试保存" : "重新生成");
    retry.onclick = () => void (state.summaryDraft ? retrySummarySave(state) : generateSummary(state));
    error.append(retry);
    if (state.summaryDraft) {
      const copy = h("button", "meeting-btn", "复制生成结果");
      copy.onclick = () => void copySummaryDraft(state);
      const check = h("button", "meeting-link", "查看纪要文档");
      check.onclick = () => openChildDoc(state, "summary");
      error.append(copy, check, h("p", "meeting-summary-state__text", "本页保留了本次生成结果。重试保存不会再次调用 AI，也不会覆盖之后的人工修改。"));
    }
    if (!state.summaryDraft) {
      appendSummaryScope(state, error);
      const settings = h("button", "meeting-link", "打开思源 AI 设置");
      settings.onclick = () => openSetting(state.plugin.app);
      error.append(settings);
    }
    section.append(error);
    if (state.summaryDraft) {
      const draft = h("div", "meeting-summary-content");
      draft.innerHTML = safeMarkdown(state.summaryDraft.markdown);
      section.append(draft);
    }
    return;
  }

  const hasContent = Boolean(latest);
  if (!hasContent && !ai.isConfigured()) {
    section.append(configError(state));
    return;
  }
  const budget = prompts.contextCharacterBudget(ai.getEditingModel()?.model);
  const material = state.material;
  const overBudget = Boolean(budget && material && material.characters > budget);

  if (!hasContent) {
    if (overBudget) {
      section.append(capacityError(state, material.characters, budget));
      return;
    }
    const empty = h("div", "meeting-summary-state");
    empty.innerHTML = `${icon("iconMeetingSparkle", "meeting-summary-state__icon")}
      <p class="meeting-summary-state__title">生成会议纪要</p>
      <p class="meeting-summary-state__text">${summaryMaterialText(state)}</p>`;
    const generate = h("button", "meeting-btn meeting-btn--primary", "生成纪要");
    generate.disabled = Boolean(state.summaryTemplateSaving || templateUnavailable);
    generate.onclick = () => void generateSummary(state, {});
    empty.append(generate);
    if (state.summaryNotice) empty.append(h("p", "meeting-summary-state__notice", state.summaryNotice));
    appendSummaryScope(state, empty);
    section.append(empty);
    return;
  }

  const meta = h("div", "meeting-summary-meta");
  const metaText = h(
    "span",
    "meeting-summary-meta__text",
    `${latest.generatedAt ? `生成于 ${formatClock(latest.generatedAt)}` : "已生成"}${latest.basis?.templateId ? ` · ${latest.basis.templateName || state.plugin.summaryTemplates.get(latest.basis.templateId)?.name || "自定义模板"}` : ""}${latest.sources ? ` · ${latest.sources}` : ""}`,
  );
  if (changes.length) {
    const outdated = h("span", "meeting-summary-meta__outdated", ` · ${changes.join("、")}已更新，重新生成后生效`);
    outdated.dataset.state = "outdated";
    metaText.append(outdated);
  }
  const actions = h("div", "meeting-summary-actions");
  // Scope only matters for the next generation, so it waits behind a toggle.
  const options = h("details", "meeting-summary-options");
  options.open = Boolean(state.summaryOptionsOpen);
  options.ontoggle = () => { state.summaryOptionsOpen = options.open; };
  const optionsToggle = h("summary", "meeting-link", "材料范围");
  if (incompleteSummaryRecordings(state).length) optionsToggle.dataset.state = "incomplete";
  const optionsPanel = h("div", "meeting-summary-options__panel");
  appendSummaryScope(state, optionsPanel);
  options.append(optionsToggle, optionsPanel);
  if (state.material) actions.append(options);
  const regenerate = h("button", "meeting-link", "重新生成");
  regenerate.disabled = Boolean(state.summaryTemplateSaving || templateUnavailable);
  regenerate.onclick = () => void regenerateSummary(state);
  const open = h("button", "meeting-link", "打开纪要文档");
  open.onclick = () => openChildDoc(state, "summary", latest.id);
  actions.append(regenerate, open);
  meta.append(metaText, actions);
  section.insertBefore(meta, retainedEditor?.parentNode === section ? retainedEditor : null);
  if (state.summaryNotice) {
    section.insertBefore(h("p", "meeting-summary-state__notice", state.summaryNotice), retainedEditor?.parentNode === section ? retainedEditor : null);
  }
  if (state.summaryEditorId !== latest.id) {
    state.summaryProtyle?.destroy();
    state.summaryEditorElement?.remove();
    state.summaryProtyle = null;
    state.summaryEditorElement = h("div", "meeting-summary-editor");
    state.summaryEditorId = latest.id;
  }
  state.summaryEditorElement.hidden = false;
  if (state.summaryEditorElement.parentNode !== section) section.append(state.summaryEditorElement);
  if (!state.summaryProtyle) {
    state.summaryProtyle = new Protyle(state.plugin.app, state.summaryEditorElement, {
      blockId: latest.id,
      mode: "wysiwyg",
      action: ["cb-get-all"],
      render: { background: false, title: false, gutter: true, breadcrumb: false, scroll: true },
    });
    registerMeetingEditors(state);
  } else {
    state.summaryProtyle.resize?.();
  }
}

async function selectSummaryTemplate(state, templateId) {
  if (state.summaryTemplateSaving) throw new Error("正在保存模板选择，请稍后重试。");
  const previous = state.summaryTemplateId;
  if (!state.plugin.summaryTemplates.get(templateId)) throw new Error("模板已不可用，请重新选择。");
  state.summaryTemplateId = templateId;
  state.summaryNotice = "";
  state.summaryTemplateSaving = true;
  renderSummary(state);
  try {
    await api.setBlockAttrs(state.docId, { [meetingStore.ATTR.summaryTemplate]: state.summaryTemplateId });
    state.meeting.summaryTemplate = state.summaryTemplateId;
  } catch (error) {
    state.summaryTemplateId = previous;
    state.summaryNotice = "模板选择未能保存，请重试。";
    throw new Error(state.summaryNotice);
  } finally {
    state.summaryTemplateSaving = false;
    renderSummary(state);
  }
}

function currentSummaryBasis(state) {
  const template = state.plugin.summaryTemplates.get(state.summaryTemplateId);
  if (!template) return null;
  return prompts.buildSummaryBasis(state.material, template, {
    onlyNotes: state.summaryOnlyNotes, recordingIds: state.summarySelectedIds,
  });
}

function summaryMaterialText(state) {
  const material = state.material;
  if (!material) return "正在读取笔记与转写…";
  if (state.summaryOnlyNotes) return `仅根据笔记生成，共约 ${material.characters} 字`;
  if (!material.transcriptSegments) return `暂无转写，仅根据笔记生成，共约 ${material.characters} 字`;
  return `将使用本场笔记与 ${material.transcriptSegments} 条转写，共约 ${material.characters} 字`;
}

function appendSummaryScope(state, container) {
  const material = state.material;
  if (!material) return;
  const scope = h("div", "meeting-summary-scope");
  const notesOnly = h("label", "meeting-summary-scope__item");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.summaryOnlyNotes;
  checkbox.onchange = () => {
    state.summaryOnlyNotes = checkbox.checked;
    if (checkbox.checked) state.summarySelectedIds = null;
    state.materialDirty = true;
    void safeRefreshMaterial(state);
  };
  notesOnly.append(checkbox, document.createTextNode("只用笔记"));
  scope.append(notesOnly);
  if (state.recordings.length > 1) {
    const pick = h("button", "meeting-link", "选择录音段");
    pick.onclick = () => openRecordingSelection(state);
    scope.append(pick);
  }
  if (state.summarySelectedIds) {
    scope.append(h("span", "meeting-summary-scope__note", `已选择 ${state.summarySelectedIds.length} 段录音`));
  }
  container.append(scope);
  const incomplete = incompleteSummaryRecordings(state);
  if (incomplete.length) {
    const warning = h("details", "meeting-summary-missing");
    warning.append(h("summary", "", `${incomplete.length} 份录音转写未完整，仅使用已有内容。`));
    const list = h("ul", "");
    incomplete.forEach((item) => list.append(h("li", "", item)));
    warning.append(list);
    container.append(warning);
  }
}

function incompleteSummaryRecordings(state) {
  if (state.summaryOnlyNotes) return [];
  const selected = state.summarySelectedIds ? new Set(state.summarySelectedIds) : null;
  const recordedText = new Set(state.transcript.map((segment) => segment.recordingId));
  const items = state.recordings
    .filter((recording) => !selected || selected.has(recording.recordingId))
    .filter((recording) => recording.transcriptionStatus !== "done" || recording.gaps?.length)
    .map((recording) => {
      const gaps = (recording.gaps || []).map((gap) =>
        `${formatDuration(gap.startMs)}–${formatDuration(gap.endMs)}`,
      );
      const reason = gaps.length
        ? `缺少 ${gaps.join("、")} 的转写`
        : recordedText.has(recording.recordingId) ? "转写尚未完成" : "尚无转写";
      return `${recordingTitle(recording.index)}：${reason}`;
    });
  if (state.snapshot.meeting?.id === state.docId &&
      ["preparing", "recording", "paused", "saving"].includes(state.snapshot.phase)) {
    items.push("当前录音尚未结束，只会使用本次生成前已保存的转写。");
  }
  return items;
}

function configError(state) {
  const card = h("div", "meeting-inline-notice", "配置思源 AI 后可生成纪要。");
  const open = h("button", "meeting-link", "去配置");
  open.onclick = () => {
    try {
      openSetting(state.plugin.app);
    } catch {
      showMessage("请打开思源设置 → AI 配置模型", 5000);
    }
  };
  card.append(open);
  return card;
}

function capacityError(state, characters, budget) {
  const card = h("div", "meeting-summary-state");
  card.innerHTML = `${icon("iconMeetingWarning", "meeting-summary-state__icon")}
    <p class="meeting-summary-state__title">材料超出模型容量</p>
    <p class="meeting-summary-state__text">当前材料约 ${characters} 字，超过所用模型约 ${budget} 字的处理范围。请选择较少的录音段，或只用笔记生成。</p>`;
  const notesOnly = h("button", "meeting-btn", "只用笔记");
  notesOnly.onclick = () => {
    state.summaryOnlyNotes = true;
    state.summarySelectedIds = null;
    void safeRefreshMaterial(state).then(() => renderSummary(state));
  };
  const pick = h("button", "meeting-btn meeting-btn--outline", "选择录音段");
  pick.onclick = () => openRecordingSelection(state);
  card.append(notesOnly, pick);
  return card;
}

function openRecordingSelection(state) {
  const selected = new Set(
    state.summarySelectedIds || state.recordings.map((item) => item.recordingId),
  );
  const content = document.createElement("div");
  content.className = "b3-dialog__content meeting-pick";
  const intro = h("p", "meeting-pick__intro", "选择要纳入纪要的录音段。未选择的录音不会发给模型。");
  content.append(intro);
  for (const recording of state.recordings) {
    const label = h("label", "meeting-pick__item");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(recording.recordingId);
    checkbox.dataset.recordingId = recording.recordingId;
    label.append(
      checkbox,
      document.createTextNode(
        `${recordingTitle(recording.index)} · ${recordingRange(recording)} · ${formatDuration(
          Number(recording.seconds || 0) * 1000,
        )}`,
      ),
    );
    content.append(label);
  }
  const actions = h("div", "meeting-confirm__actions");
  const cancel = h("button", "b3-button b3-button--cancel", "取消");
  const ok = h("button", "b3-button", "使用所选录音");
  actions.append(cancel, ok);
  content.append(actions);
  const dialog = new Dialog({ title: "选择录音段", width: "460px", content: content.outerHTML });
  dialog.element.querySelectorAll("input[data-recording-id]").forEach((checkbox) => {
    checkbox.onchange = () => {
      const id = checkbox.dataset.recordingId;
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
    };
  });
  const close = () => dialog.destroy();
  dialog.element.querySelector(".b3-button--cancel").onclick = close;
  dialog.element.querySelector(".b3-button:not(.b3-button--cancel)").onclick = () => {
    state.summarySelectedIds = Array.from(selected);
    state.summaryOnlyNotes = state.summarySelectedIds.length === 0;
    dialog.destroy();
    void safeRefreshMaterial(state).then(() => renderSummary(state));
  };
}

function renderSummaryStreaming(state, section) {
  const meta = h("div", "meeting-summary-meta");
  meta.append(h("span", "meeting-summary-meta__text", state.summarySaving ? "正在保存纪要…" : "正在整理会议内容…"));
  if (!state.summarySaving) {
    const cancel = h("button", "meeting-link", "取消");
    cancel.onclick = () => state.summaryAbort?.abort();
    meta.append(cancel);
  }
  section.append(meta);
  const content = h("div", "meeting-summary-content meeting-summary-content--streaming");
  if (state.summaryStream.trim()) {
    content.innerHTML = `${safeMarkdown(state.summaryStream)}<span class="meeting-caret" aria-hidden="true"></span>`;
  } else {
    content.innerHTML = `<p class="meeting-pulse">正在整理会议内容…</p>`;
  }
  section.append(content);
}

async function generateSummary(state) {
  if (state.summaryGenerating || state.summarySaving || state.summaryTemplateSaving) return;
  if (!state.meeting?.isMeeting) {
    state.summaryError = "这篇文档不是会议文档，无法生成纪要";
    renderSummary(state);
    return;
  }
  state.summaryGenerating = true;
  state.summaryError = "";
  state.summaryNotice = "";
  state.summaryStream = "";
  renderSummary(state);
  const abort = new AbortController();
  state.summaryAbort = abort;
  let phase = "preparing";
  try {
    // A meeting tab can outlive a settings update or synchronization. Resolve
    // once from the kernel, then freeze it for the entire generation.
    const { conf } = await api.post("/api/system/getConf");
    const resolved = JSON.parse(JSON.stringify(ai.getEditingModel(conf.ai || null)));
    if (!resolved) throw new Error("尚未配置 AI：请在思源设置中配置 AI 模型");
    await refreshRecordings(state);
    await refreshTranscript(state);
    await refreshSummaries(state);
    if (state.summaries.length > 1) {
      throw new Error("这场会议中有多份旧纪要。请先在思源中保留一份，再重新生成。");
    }
    await refreshMaterial(state);
    const budget = prompts.contextCharacterBudget(resolved?.model);
    const template = state.plugin.summaryTemplates.get(state.summaryTemplateId);
    if (!template) throw new Error("模板已不可用，请重新选择模板后再生成。");
    const system = prompts.buildSystemPrompt({ date: new Date(), template });
    const user = state.material.userPrompt;
    const basis = currentSummaryBasis(state);
    const characters = prompts.countNormalizedCharacters(`${system}\n${user}`);
    if (budget && characters > budget) {
      throw new Error(
        `本次内容约 ${characters} 字，超过所选模型约 ${budget} 字的处理范围。请只用笔记或选择较少的录音段。`,
      );
    }
    const sources = summarySourceText(state);
    const existing = state.summaries[0];
    const expectedFingerprint = existing ? sha256(state.summaryContent.trim()) : "";
    const edited = Boolean(existing && (!existing.fingerprint || existing.fingerprint !== expectedFingerprint));
    const warnings = [];
    if (existing) {
      warnings.push(edited
        ? "当前纪要已被修改。重新生成会替换这份纪要，你的修改将丢失。"
        : "重新生成会替换这份纪要。");
    }
    if (abort.signal.aborted) throw new Error("已取消生成");
    if (warnings.length) {
      const confirmed = await confirmDialog(
        existing ? "重新生成纪要" : "使用已有材料生成纪要",
        warnings.join("\n\n"),
        existing ? "替换纪要" : "使用已有材料生成",
      );
      if (!confirmed) {
        state.summaryNotice = "已取消生成，未修改纪要";
        return;
      }
    }
    if (abort.signal.aborted) throw new Error("已取消生成");
    const generatedAt = new Date().toISOString();
    phase = "generating";
    const text = await ai.streamSummary({
      system,
      user,
      resolved,
      signal: abort.signal,
      onDelta: (_delta, full) => {
        state.summaryStream = full;
        throttledStreamRender(state);
      },
    });
    if (abort.signal.aborted) throw new Error("已取消生成");
    state.summaryDraft = { markdown: text, sources, generatedAt, expectedFingerprint, basis, receipt: {} };
    state.summarySaving = true;
    renderSummary(state);
    await saveSummaryDraft(state);
  } catch (error) {
    if (state.summarySaving) {
      state.summaryError = error.message;
    } else if (abort.signal.aborted || String(error.message).includes("已取消")) {
      state.summaryNotice = "已取消生成，未写入任何内容";
    } else {
      state.summaryError = error.message;
      state.controller.recordSummaryFailure({ meetingId: state.docId, phase, error });
    }
  } finally {
    state.summaryGenerating = false;
    state.summarySaving = false;
    state.summaryAbort = null;
    renderSummary(state);
  }
}

async function saveSummaryDraft(state) {
  const draft = state.summaryDraft;
  const saved = await meetingStore.saveSummary(state.meeting, draft);
  state.summaries = [{ id: saved.docId, generatedAt: draft.generatedAt, sources: draft.sources, fingerprint: saved.fingerprint, basis: draft.basis }];
  state.summaryBasisInitialized = saved.docId;
  state.summaryDocId = saved.docId;
  state.summaryContent = saved.content;
  state.summaryNotice = "";
  state.summaryStream = "";
  state.summaryDraft = null;
  try {
    await refreshMaterial(state);
  } catch {
    state.materialDirty = true;
    state.summaryNotice = "材料状态未能刷新，重新打开会议页可更新。";
  }
}

async function retrySummarySave(state) {
  if (!state.summaryDraft || state.summarySaving || state.summaryGenerating) return;
  state.summarySaving = true;
  state.summaryError = "";
  state.summaryStream = state.summaryDraft.markdown;
  renderSummary(state);
  try {
    await saveSummaryDraft(state);
  } catch (error) {
    state.summaryError = error.message;
  } finally {
    state.summarySaving = false;
    renderSummary(state);
  }
}

async function copySummaryDraft(state) {
  try {
    await navigator.clipboard.writeText(state.summaryDraft.markdown);
    showMessage("生成结果已复制", 3000);
  } catch {
    showMessage("未能复制，请在下方选中生成结果后复制", 5000, "error");
  }
}

function throttledStreamRender(state) {
  if (state.streamTimer) return;
  state.streamTimer = setTimeout(() => {
    state.streamTimer = null;
    if (state.summaryGenerating) renderSummary(state);
  }, 80);
}

function summarySourceText(state) {
  if (state.summaryOnlyNotes) return "仅根据笔记生成";
  const withTranscript = new Set(state.transcript.map((segment) => segment.recordingId));
  const selected = state.summarySelectedIds
    ? new Set(state.summarySelectedIds)
    : null;
  const count = Array.from(withTranscript).filter((id) => !selected || selected.has(id)).length;
  return count ? `基于笔记与 ${count} 段转写` : "仅根据笔记生成";
}

async function regenerateSummary(state) {
  await generateSummary(state);
}

function openChildDoc(state, kind, docId = "") {
  const open = async () => {
    let target = docId;
    if (!target) {
      const child = await meetingStore.findChild(state.docId, kind);
      if (!child) throw new Error(kind === "transcript" ? "还没有转写文档" : "还没有纪要文档");
      target = child.id;
    }
    await api.openDoc(state.plugin.app, target);
  };
  void open().catch((error) => showMessage(error.message, 5000, "error"));
}

function emptyState(iconName, title, text) {
  const node = h("div", "meeting-empty");
  node.innerHTML = `${icon(iconName, "meeting-empty__icon")}
    <p class="meeting-empty__title">${escapeHtml(title)}</p>
    <p class="meeting-empty__text">${escapeHtml(text)}</p>`;
  return node;
}

function renderFatal(state, error) {
  const editor = state.root.querySelector('[data-field="editor"]');
  if (editor) {
    editor.replaceChildren(
      emptyState("iconMeetingWarning", "无法打开会议", error.message),
    );
  }
}

function openMoreMenu(state) {
  const button = state.root.querySelector('[data-action="more"]');
  const rect = button.getBoundingClientRect();
  const menu = new Menu("meeting-more");
  menu.addItem({
    icon: "iconFile",
    label: "在思源文档中打开",
    click: () => void api.openDoc(state.plugin.app, state.docId),
  });
  menu.addItem({
    icon: "iconMeetingTranscript",
    label: "打开转写文档",
    click: () => openChildDoc(state, "transcript"),
  });
  menu.addItem({
    icon: "iconMeetingSparkle",
    label: "打开纪要文档",
    click: () => openChildDoc(state, "summary"),
  });
  menu.addSeparator();
  menu.addItem({
    icon: "iconMeetingRefresh",
    label: "重新加载会议数据",
    click: () => state.tab.meetingRefresh(),
  });
  menu.addItem({
    icon: "iconMeetingSettings",
    label: "会议设置",
    click: () => openSettings(state.plugin),
  });
  menu.open({ x: Math.round(rect.right), y: Math.round(rect.bottom + 4) });
}

async function refreshAll(state) {
  try {
    state.meeting = await meetingStore.getMeeting(state.docId);
    await Promise.all([refreshRecordings(state), refreshTranscript(state), refreshSummaries(state)]);
    await refreshMaterial(state);
    renderChrome(state, (name) => state.root.querySelector(`[data-field="${name}"]`), (name) => state.root.querySelector(`[data-action="${name}"]`));
    renderMeetingView(state);
    state.tab.tab?.updateTitle?.(state.meeting.title || "");
  } catch (error) {
    showMessage(`刷新失败：${error.message}`, 6000, "error");
  }
}

// ---- settings -------------------------------------------------------------

function hotwordTag(word, remove) {
  const tag = h("span", "meeting-hotword", word);
  if (remove) {
    const button = h("button", "meeting-hotword__remove", "×");
    button.type = "button";
    button.setAttribute("aria-label", `本场不使用 ${word}`);
    button.title = "仅从本场会议移除";
    button.onclick = remove;
    tag.append(button);
  }
  return tag;
}

function hotwordServiceHint(service) {
  return service === "doubao"
    ? "豆包实时转写只使用前 100 tokens 内的热词，超出部分由服务端截断；请保留少量关键热词，本场补充优先。会后识别最多支持 5000 个词。"
    : "腾讯云合并后最多支持 128 个热词，单词最多 10 个汉字或 30 个英文字母。";
}

function createHotwordEditor(initial, service) {
  const element = h("div", "meeting-hotword-editor");
  const preview = h("div", "meeting-hotwords__tags");
  const input = h("textarea", "b3-text-field meeting-hotwords__input");
  input.setAttribute("aria-label", "常用热词");
  input.placeholder = "输入人名、产品名、专业术语，可一次粘贴多个";
  input.rows = 4;
  input.value = parseHotwords(initial).join("\n");
  input.hidden = true;
  const toggle = h("button", "meeting-link", "编辑");
  toggle.type = "button";
  const error = h("p", "meeting-hotwords__error");
  error.setAttribute("role", "alert");
  const render = () => {
    const words = parseHotwords(input.value);
    preview.replaceChildren(...words.map((word) => hotwordTag(word)));
    if (!words.length) preview.append(h("span", "meeting-hotwords__hint", "尚未添加常用热词"));
  };
  const read = () => validateHotwords(input.value, service());
  toggle.onclick = () => {
    if (!input.hidden) {
      try { input.value = read().join("\n"); } catch (failure) { error.textContent = failure.message; return; }
      render();
    }
    input.hidden = !input.hidden;
    preview.hidden = !input.hidden;
    toggle.textContent = input.hidden ? "编辑" : "预览";
    error.textContent = "";
    if (!input.hidden) input.focus();
  };
  render();
  element.append(preview, input, toggle,
    h("p", "meeting-settings__hint", "空格、换行及中英文标点会自动切分为多个词，重复词自动合并。保存后用于后续转写，不改变已有文字。"), error);
  return { element, read };
}

function renderMeetingHotwords(state) {
  const container = state.root.querySelector('[data-field="hotwords"]');
  if (!container || !state.meeting?.isMeeting || state.hotwordsSaving) return;
  const prefs = state.controller.getPrefs();
  const service = prefs.transcriptionService === "tencent" ? "tencent" : "doubao";
  const key = JSON.stringify([prefs.hotwords, state.meeting.hotwords, state.meeting.excludedHotwords,
    state.meeting.useGlobalHotwords, service]);
  if (state.hotwordsKey === key) return;
  state.hotwordsKey = key;
  container.replaceChildren();
  const tags = h("div", "meeting-hotwords__tags");
  tags.append(h("span", "meeting-hotwords__label", "本场热词"));
  const error = h("p", "meeting-hotwords__error");
  error.setAttribute("role", "alert");
  const save = async (change) => {
    if (state.hotwordsSaving) return;
    const restoreFocus = container.contains(document.activeElement);
    let savedChanges = false;
    state.hotwordsSaving = true;
    const start = state.root.querySelector('[data-action="start"]');
    start.disabled = true;
    container.setAttribute("aria-busy", "true");
    for (const control of container.querySelectorAll("button, input, textarea")) control.disabled = true;
    try {
      const current = await meetingStore.getMeeting(state.docId);
      const next = change(current);
      const globalWords = state.controller.getPrefs().hotwords;
      const previousWords = new Set(effectiveHotwords(globalWords, current));
      const nextWords = effectiveHotwords(globalWords, next);
      // Removing terms must remain possible after switching to a service with a smaller limit.
      if (nextWords.some((word) => !previousWords.has(word))) validateHotwords(nextWords, service);
      const saved = await meetingStore.saveHotwords(state.docId, next);
      Object.assign(state.meeting, saved);
      savedChanges = true;
      state.hotwordsKey = "";
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      state.hotwordsSaving = false;
      container.removeAttribute("aria-busy");
      for (const control of container.querySelectorAll("button, input, textarea")) control.disabled = false;
      renderMeetingHotwords(state);
      renderChrome(state, (name) => state.root.querySelector(`[data-field="${name}"]`),
        (name) => state.root.querySelector(`[data-action="${name}"]`));
      if (savedChanges && restoreFocus && !state.destroyed) container.querySelector(".meeting-hotword__add")?.focus();
    }
  };
  const words = effectiveHotwords(prefs.hotwords, state.meeting);
  try { validateHotwords(words, service); } catch (failure) { error.textContent = failure.message; }
  for (const word of words) tags.append(hotwordTag(word, () => void save((current) => ({
    ...current, hotwords: current.hotwords.filter((item) => item !== word),
    excludedHotwords: parseHotwords([...current.excludedHotwords, word]),
  }))));
  const add = h("button", "meeting-hotword meeting-hotword__add", "+");
  add.type = "button";
  add.setAttribute("aria-label", "添加本场热词");
  add.setAttribute("aria-expanded", "false");
  add.title = "添加本场热词";
  tags.append(add);
  const editor = h("div", "meeting-hotwords__add-editor");
  editor.hidden = true;
  const input = h("textarea", "b3-text-field meeting-hotwords__input");
  input.rows = 2;
  input.setAttribute("aria-label", "添加本场热词");
  input.placeholder = "可粘贴多个词，按空格、换行和标点自动切分";
  const confirm = h("button", "meeting-btn meeting-btn--outline", "添加");
  confirm.type = "button";
  const cancel = h("button", "meeting-link", "取消");
  cancel.type = "button";
  add.onclick = () => { editor.hidden = false; add.setAttribute("aria-expanded", "true"); input.focus(); };
  cancel.onclick = () => { editor.hidden = true; add.setAttribute("aria-expanded", "false"); input.value = ""; error.textContent = ""; add.focus(); };
  confirm.onclick = () => {
    const added = parseHotwords(input.value);
    if (!added.length) { input.focus(); return; }
    void save((current) => ({ ...current, hotwords: parseHotwords([...current.hotwords, ...added]),
      excludedHotwords: current.excludedHotwords.filter((word) => !added.includes(word)) }));
  };
  input.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); confirm.click(); }
  };
  editor.append(input, confirm, cancel);
  const options = h("details", "meeting-hotwords__options");
  options.append(h("summary", "", "使用说明与选项"));
  const label = h("label", "meeting-hotwords__global");
  const useGlobal = h("input");
  useGlobal.type = "checkbox";
  useGlobal.checked = state.meeting.useGlobalHotwords !== false;
  useGlobal.onchange = () => {
    const checked = useGlobal.checked;
    useGlobal.checked = state.meeting.useGlobalHotwords !== false;
    void save((current) => ({ ...current, useGlobalHotwords: checked }));
  };
  label.append(useGlobal, document.createTextNode("使用全局常用词"));
  const reset = h("button", "meeting-link", "恢复为全局词表");
  reset.type = "button";
  reset.onclick = () => void save((current) => ({ ...current, hotwords: [], excludedHotwords: [], useGlobalHotwords: true }));
  options.append(label, reset,
    h("p", "meeting-hotwords__hint", "× 和 + 仅调整本场会议。修改用于下一段录音或会后重新识别，不改变当前实时转写与已有文字。热词帮助识别，不保证命中。"),
    h("p", "meeting-hotwords__hint", hotwordServiceHint(service)));
  container.append(tags, editor, options, error);
}

function openSettings(plugin) {
  const prefs = plugin.controller.getPrefs();
  const notebooks = api.notebooks();
  const service = plugin.transcription.service();
  const hasApiKey = Boolean(plugin.getSecret?.("meeting.doubao.apiKey"));
  const hasSecretId = Boolean(plugin.getSecret?.("meeting.tencent.secretId"));
  const hasSecretKey = Boolean(plugin.getSecret?.("meeting.tencent.secretKey"));
  const categories = [
    ["recording", "会议与录音"],
    ["transcription", "语音转写"],
    ["cloud", "腾讯云与 COS"],
    ["summary", "AI 纪要"],
  ];
  const settingsId = `meeting-settings-${Date.now()}`;
  const panel = (key) => `role="tabpanel" id="${settingsId}-${key}" aria-labelledby="${settingsId}-tab-${key}" tabindex="0" data-settings-panel="${key}"${key === "recording" ? "" : " hidden"}`;
  const content = `
    <div class="meeting-settings">
      <nav class="meeting-settings__nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
        ${categories.map(([key, label], index) => `<button type="button" role="tab" id="${settingsId}-tab-${key}" aria-controls="${settingsId}-${key}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-settings-tab="${key}">${label}</button>`).join("")}
      </nav>
      <div class="meeting-settings__content">
      <section ${panel("recording")}>
        <h3>会议与录音</h3>
        <label class="meeting-settings__row"><span>新会议保存到</span>
          <select class="b3-select" name="notebook">${notebooks
            .map(
              (item) =>
                `<option value="${escapeHtml(item.id)}"${item.id === prefs.notebookId ? " selected" : ""}>${escapeHtml(item.name)}</option>`,
            )
            .join("")}</select>
        </label>
        <label class="meeting-settings__row"><span>默认模式</span>
          <select class="b3-select" name="mode">
            <option value="offline"${prefs.mode === "offline" ? " selected" : ""}>线下（仅麦克风）</option>
            <option value="online"${prefs.mode === "online" ? " selected" : ""}>线上（麦克风 + 电脑声音）</option>
          </select>
        </label>
        <label class="meeting-settings__row"><span>浮条不透明度</span>
          <input class="b3-slider" type="range" name="opacity" min="35" max="95" value="${Math.round((prefs.opacity || 0.9) * 100)}">
          <span class="meeting-settings__value" data-field="opacity-value">${Math.round((prefs.opacity || 0.9) * 100)}%</span>
        </label>
      </section>
      <section ${panel("transcription")}>
        <h3>转写</h3>
        <p class="meeting-settings__hint">密钥仅保存在本机。转写时会将录音发送给你选择的服务；密钥留空表示不修改。</p>
        <label class="meeting-settings__row"><span>转写服务</span>
          <select class="b3-select" name="service">
            <option value="doubao"${service === "doubao" ? " selected" : ""}>豆包</option>
            <option value="tencent"${service === "tencent" ? " selected" : ""}>腾讯云</option>
          </select>
        </label>
        <div class="meeting-settings__group" data-service="doubao"${service === "doubao" ? "" : " hidden"}>
          <label class="meeting-settings__row"><span>API Key</span>
            <input class="b3-text-field" type="password" name="apiKey" placeholder="${hasApiKey ? "已保存，留空不修改" : "填写 API Key"}" autocomplete="off">
          </label>
          <p class="meeting-settings__hint">需开通豆包流式语音识别 2.0 和录音文件识别标准版 2.0。</p>
        </div>
        <div class="meeting-settings__group" data-service="tencent"${service === "tencent" ? "" : " hidden"}>
          <label class="meeting-settings__row"><span>实时识别引擎</span>
            <select class="b3-select" name="realtimeEngine">
              <option value="large"${prefs.realtimeEngine !== "general" ? " selected" : ""}>大模型（更准确）</option>
              <option value="general"${prefs.realtimeEngine === "general" ? " selected" : ""}>通用</option>
            </select>
          </label>
          <p class="meeting-settings__hint">大模型在腾讯云单独计费、没有免费额度，需要先开通。腾讯云实时转写不区分说话人，会后使用录音文件大模型 2.0 识别。密钥需具备 ASR 和 GetUserAppId 权限，账号信息自动获取，无需填写 AppId。</p>
        </div>
        <label class="meeting-settings__row"><span>实时转写</span>
          <input type="checkbox" name="realtime"${prefs.realtimeTranscription !== false ? " checked" : ""}>
        </label>
        <p class="meeting-settings__hint">从下一段录音开始生效。线上会议混合为单声道识别，原录音保留双声道。</p>
        <label class="meeting-settings__row"><span>结束后自动补齐缺口</span>
          <input type="checkbox" name="autoFillGaps"${prefs.autoFillGaps !== false ? " checked" : ""}>
        </label>
        <p class="meeting-settings__hint">只补齐实时转写缺口；关闭实时转写时，由你手动识别整段。</p>
        <h3>常用热词</h3>
        <div data-field="hotword-editor"></div>
        <p class="meeting-settings__hint" data-field="hotword-service-hint"></p>
      </section>
      <section ${panel("cloud")}>
        <h3>腾讯云与 COS 临时录音</h3>
        <p class="meeting-settings__hint">COS 与腾讯语音共用以下密钥，只需填写一次。两家会后识别均使用私有 COS，密钥需具备指定桶临时目录的上传、下载和删除权限。</p>
          <label class="meeting-settings__row"><span>SecretId</span>
            <input class="b3-text-field" type="password" name="secretId" placeholder="${hasSecretId ? "已保存，留空不修改" : "填写 SecretId"}" autocomplete="off">
          </label>
          <label class="meeting-settings__row"><span>SecretKey</span>
            <input class="b3-text-field" type="password" name="secretKey" placeholder="${hasSecretKey ? "已保存，留空不修改" : "填写 SecretKey"}" autocomplete="off">
          </label>
        <label class="meeting-settings__row"><span>COS 存储桶地址</span>
          <input class="b3-text-field" name="cosEndpoint" value="${escapeHtml(prefs.cosEndpoint || "")}" placeholder="https://meeting-1250000000.cos.ap-shanghai.myqcloud.com">
        </label>
        <p class="meeting-settings__hint">从 COS 控制台复制存储桶默认域名，桶名和地域自动识别。请使用私有桶。</p>
        <p class="meeting-settings__hint">录音通过限时链接供识别服务读取，文字成功保存后删除 COS 临时录音，思源原录音保留。中断任务保留至继续处理；清理失败可重试。</p>
        <p class="meeting-settings__hint">计费：实时识别、会后识别分别按服务商规则收费；自动补齐只提交缺口，手动识别提交整段，会再次产生识别费用。COS 存储、请求及下载流量另计。继续查询原任务或重试清理不会新建识别任务。</p>
      </section>
      <section ${panel("summary")}>
        <h3>AI 纪要</h3>
        <p class="meeting-settings__hint">纪要使用思源设置中的 AI 模型；本插件不保存模型密钥。<button class="meeting-link" type="button" data-action="open-ai">打开思源设置</button></p>
        <div data-field="template-manager"></div>
      </section>
      </div>
    </div>
    <div class="b3-dialog__action meeting-settings__actions">
      <button class="b3-button b3-button--cancel">取消</button>
      <button class="b3-button b3-button--text" data-action="save">保存</button>
    </div>`;
  const dialog = new Dialog({ title: "会议录音设置", width: "800px", hideCloseIcon: true, content });
  const element = dialog.element;
  const tabs = Array.from(element.querySelectorAll("[data-settings-tab]"));
  const selectCategory = (tab) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const item of element.querySelectorAll("[data-settings-panel]")) {
      item.hidden = item.dataset.settingsPanel !== tab.dataset.settingsTab;
    }
    element.querySelector('.meeting-settings__actions [data-action="save"]').hidden = tab.dataset.settingsTab === "summary";
    element.querySelector(".meeting-settings__actions .b3-button--cancel").textContent = tab.dataset.settingsTab === "summary" ? "关闭" : "取消";
    element.querySelector(".meeting-settings__content").scrollTop = 0;
  };
  for (const tab of tabs) {
    tab.onclick = () => selectCategory(tab);
    tab.onkeydown = (event) => {
      const index = tabs.indexOf(tab);
      let next;
      if (event.key === "ArrowDown") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectCategory(tabs[next]);
      tabs[next].focus();
    };
  }
  const value = (name) => element.querySelector(`[name="${name}"]`)?.value || "";
  const hotwordEditor = createHotwordEditor(prefs.hotwords, () => value("service"));
  element.querySelector('[data-field="hotword-editor"]').append(hotwordEditor.element);
  element.querySelector('[data-field="hotword-service-hint"]').textContent = hotwordServiceHint(value("service"));
  element.querySelector('[data-field="opacity-value"]').textContent = `${value("opacity")}%`;
  element.querySelector('[name="opacity"]').addEventListener("input", (event) => {
    element.querySelector('[data-field="opacity-value"]').textContent = `${event.target.value}%`;
  });
  element.querySelector('[name="service"]').addEventListener("change", (event) => {
    element.querySelector('[data-field="hotword-service-hint"]').textContent = hotwordServiceHint(event.target.value);
    for (const group of element.querySelectorAll(".meeting-settings__group")) {
      group.hidden = group.dataset.service !== event.target.value;
    }
  });
  element.querySelector('[data-action="open-ai"]').onclick = () => {
    try {
      openSetting(plugin.app);
    } catch {
      showMessage("请打开思源设置 → AI", 5000);
    }
  };
  const templateManager = createTemplateManager({
    store: plugin.summaryTemplates, confirm: confirmDialog,
  });
  element.querySelector('[data-field="template-manager"]').append(templateManager.element);
  const actions = element.querySelector(".meeting-settings__actions");
  actions.querySelector(".b3-button--cancel").onclick = async () => {
    if (await templateManager.canClose()) dialog.destroy();
  };
  actions.querySelector('[data-action="save"]').onclick = async () => {
    if (!await templateManager.canClose()) return;
    const save = actions.querySelector('[data-action="save"]');
    save.disabled = true;
    try {
      const hotwords = hotwordEditor.read();
      if (value("cosEndpoint").trim()) parseCosEndpoint(value("cosEndpoint"));
      const secretId = value("secretId").trim();
      const secretKey = value("secretKey").trim();
      await api.writeSecrets([
        { name: "meeting.doubao.apiKey", value: value("apiKey").trim() },
        { name: "meeting.tencent.secretId", value: secretId },
        { name: "meeting.tencent.secretKey", value: secretKey },
      ]);
      plugin.controller.setPrefs({
        hotwords,
        notebookId: value("notebook"),
        mode: value("mode"),
        opacity: Number(value("opacity")) / 100,
        transcriptionService: value("service") === "tencent" ? "tencent" : "doubao",
        cosEndpoint: value("cosEndpoint").trim(),
        realtimeTranscription: element.querySelector('[name="realtime"]').checked,
        realtimeEngine: value("realtimeEngine") === "general" ? "general" : "large",
        autoFillGaps: element.querySelector('[name="autoFillGaps"]').checked,
      });
      showMessage("设置已保存", 3000);
      dialog.destroy();
    } catch (error) {
      showMessage(`保存设置失败：${error.message}`, 7000, "error");
      save.disabled = false;
    }
  };
}

// ---- all meetings ---------------------------------------------------------

function mountAllMeetingsTab(plugin, tab) {
  const root = h("div", "meeting-page meeting-all-page");
  root.innerHTML = `
    <header class="meeting-header">
      <div class="meeting-crumb">
        <span class="meeting-crumb__icon">${icon("iconMeetingCalendar")}</span>
        <span class="meeting-crumb__root">全部会议</span>
      </div>
      <div class="meeting-header__spacer"></div>
      <label class="meeting-search">
        ${icon("iconMeetingSearch")}
        <input class="meeting-search__input" placeholder="搜索会议标题" aria-label="搜索会议">
      </label>
      <button class="meeting-record-btn" data-action="new">
        ${icon("iconMeetingPlus")}<span>新建会议</span>
      </button>
    </header>
    <div class="meeting-all-body">
      <div class="meeting-all-list" data-field="list"></div>
    </div>`;
  tab.element.replaceChildren(root);
  const list = root.querySelector('[data-field="list"]');
  const search = root.querySelector(".meeting-search__input");
  let meetings = [];
  let destroyed = false;
  let liveKey = "";

  const render = () => {
    if (destroyed) return;
    const live = plugin.controller.snapshot();
    liveKey = `${live.meeting?.id || ""}:${live.phase}`;
    const query = search.value.trim().toLowerCase();
    const visible = meetings.filter((item) => !query || String(item.title).toLowerCase().includes(query));
    list.replaceChildren();
    if (!visible.length) {
      list.append(emptyState("iconMeetingCalendar", meetings.length ? "没有匹配的会议" : "还没有会议", meetings.length ? "换个关键词试试。" : "点击右上角「新建会议」开始。"));
      return;
    }
    for (const meeting of visible) {
      const row = h("button", "meeting-all-row");
      row.type = "button";
      const isLive =
        live.meeting?.id === meeting.id && ["recording", "paused"].includes(live.phase);
      row.innerHTML = `<span class="meeting-all-row__title">${escapeHtml(meeting.title)}</span>
        <span class="meeting-all-row__meta">${escapeHtml(
          meeting.firstRecordedAt
            ? formatDateTime(meeting.firstRecordedAt)
            : meeting.startedAt
              ? formatDateTime(meeting.startedAt)
              : formatDate(meeting.created),
        )}${meeting.segments ? ` · ${meeting.segments} 段录音` : ""}</span>
        <span class="meeting-all-row__state">${isLive ? (live.phase === "paused" ? "已暂停" : "录音中") : ""}</span>`;
      row.onclick = () => plugin.openMeetingTab(meeting.id, meeting.title);
      list.append(row);
    }
  };

  root.querySelector('[data-action="new"]').onclick = async () => {
    try {
      await plugin.controller.createMeeting({});
    } catch (error) {
      showMessage(error.message, 6000, "error");
    }
  };
  search.addEventListener("input", render);
  const unsubscribe = plugin.controller.subscribe((snapshot) => {
    if (destroyed) return;
    const key = `${snapshot.meeting?.id || ""}:${snapshot.phase}`;
    if (key !== liveKey) render();
  });
  void meetingStore
    .listMeetings(500)
    .then((items) => {
      meetings = items;
      render();
    })
    .catch((error) => {
      list.replaceChildren(emptyState("iconMeetingWarning", "读取会议失败", error.message));
    });

  const cleanup = () => {
    destroyed = true;
    unsubscribe();
  };
  tab.meetingCleanup = cleanup;
  return cleanup;
}

module.exports = {
  mountMeetingTab,
  mountAllMeetingsTab,
  openSettings,
  safeMarkdown,
};
