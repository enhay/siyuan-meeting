"use strict";

const { Menu, Dialog, showMessage, openSetting, Protyle } = require("siyuan");
const api = require("./siyuan-api");
const meetingStore = require("./meeting-store");
const prompts = require("./prompts");
const ai = require("./ai");
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

function statusLabel(status) {
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
  if (status) return status;
  return "";
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
    <div class="meeting-hint" data-field="hint"></div>
    <div class="meeting-banners" data-field="banners"></div>
    <div class="meeting-body">
      <div class="meeting-editor" data-field="editor" role="tabpanel" id="${viewId}-notes-panel" aria-labelledby="${viewId}-notes-tab"></div>
      <section class="meeting-view meeting-view--summary" data-view-content="summary" role="tabpanel" id="${viewId}-summary-panel" aria-labelledby="${viewId}-summary-tab" hidden></section>
      <section class="meeting-view meeting-view--transcript" data-view-content="transcript" role="tabpanel" id="${viewId}-transcript-panel" aria-labelledby="${viewId}-transcript-tab" hidden>
        <div class="meeting-recordings-section" data-section="recordings"></div>
        <div class="meeting-transcript-section" data-section="transcript"></div>
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
    summaries: [],
    summaryDocId: "",
    summaryContent: "",
    summaryGenerating: false,
    summarySaving: false,
    summaryStream: "",
    summaryError: "",
    summaryNotice: "",
    summaryOnlyNotes: false,
    summarySelectedIds: null,
    summaryAbort: null,
    material: null,
    materialDirty: true,
    selectedRecordingId: "",
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
    const recordingsSection = state.root.querySelector('[data-section="recordings"]');
    if (recordingsSection) renderRecordings(state, recordingsSection);
    state.materialDirty = true;
    void Promise.all([refreshRecordings(state), refreshTranscript(state)]).then(() => {
      if (resolveMeetingView(state) === "transcript") renderTranscriptView(state);
      if (resolveMeetingView(state) === "summary") void safeRefreshMaterial(state);
    }).catch(() => {});
  });
  onCleanup(unsubscribeTranscription);

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

  action("start").addEventListener("click", () => void startFromMeeting(state));
  action("pause").addEventListener("click", () => void togglePause(state));
  action("stop").addEventListener("click", () => void stopMeeting(state));
  action("more").addEventListener("click", () => openMoreMenu(state));
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
  state.audio.addEventListener("error", () => {
    if (state.audio.getAttribute("src")) {
      showMessage("无法播放这段录音，资源可能尚未同步到本机", 5000, "error");
    }
  });

  const markMaterialDirty = debounce(() => {
    if (state.destroyed) return;
    state.materialDirty = true;
    if (resolveMeetingView(state) === "summary" &&
        !state.summaryEditorElement?.contains(document.activeElement)) {
      state.materialDirty = false;
      void safeRefreshMaterial(state);
    }
  }, 500);

  void initialize();

  async function initialize() {
    try {
      state.meeting = await meetingStore.getMeeting(docId);
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
  action("start").disabled = Boolean(anotherActive) || state.meeting?.isMeeting === false;
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
    phase === "paused" ? "已暂停" : phase === "saving" ? "正在保存" : phase === "error" ? "需要处理" : "";

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
  } else if (phase === "preparing" && activeHere) {
    hint = "正在打开麦克风并检查真实信号。线上模式不会在电脑声音失败时悄悄降级。";
  } else if (phase === "recording") {
    const online = activeHere ? snapshot.online : state.mode === "online";
    hint = snapshot.notice
      ? snapshot.notice
      : online
        ? "正在录制麦克风与电脑声音。请使用耳机，避免外放串音。"
        : "正在录制麦克风。切换视图或关闭会议页不会结束录音。";
  } else if (phase === "paused") {
    hint = snapshot.notice || "已暂停采集，计时冻结。继续后仍属于同一段录音。";
  } else if (phase === "saving") {
    hint = "正在处理最后一批数据并归档，请勿重复结束。";
  } else if (phase === "error" && activeHere) {
    hint = snapshot.saveFailed
      ? "音频仍保存在本机，归档失败不会丢弃已录内容。"
      : "采集需要处理；已写入的部分不会丢弃。";
  } else if (
    (phase === "saved" || phase === "idle") &&
    activeHere &&
    state.recordings.length
  ) {
    const count = Math.max(state.meeting?.segments || 0, state.recordings.length);
    const total = state.recordings.reduce((sum, item) => sum + Number(item.seconds || 0), 0);
    hint = `${phase === "saved" ? "已保存" : "已有"} · ${count} 段录音 · 总时长 ${formatDuration(
      total * 1000,
      { alwaysHours: total >= 3600 },
    )}`;
    if (phase === "idle") hint += "。点击「补录」在原会议下继续";
  } else if ((activeHere ? snapshot.online : state.mode === "online")) {
    hint = "线上模式会同时录麦克风和电脑播放的声音。请使用耳机，避免外放声音被麦克风重复录入。";
  } else {
    hint = "点击开始后才采集声音。计时只累计实际录音时间，不含暂停。";
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

  if (snapshot.realtimeNotice && snapshot.meeting?.id === state.docId) {
    const banner = h("div", "meeting-banner");
    banner.append(h("span", "", snapshot.realtimeNotice));
    const settings = h("button", "meeting-banner__action", "会议设置");
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
  if (recordings) {
    recordings.hidden = active;
    if (!active) renderRecordings(state, recordings);
    else state.audio.pause();
  }
  if (transcript) renderTranscript(state, transcript);
}

async function applySeekToMeeting(state, seek) {
  if (!state.recordings.some((item) => item.recordingId === seek.recordingId)) {
    await refreshRecordings(state);
  }
  if (!state.recordings.some((item) => item.recordingId === seek.recordingId)) return;
  state.selectedRecordingId = seek.recordingId;
  state.ui.view = "transcript";
  saveUiState(state.docId, state.ui);
  renderMeetingView(state);
  const play = () => {
    try {
      state.audio.currentTime = Math.max(0, Number(seek.startMs || 0) / 1000);
      void state.audio.play();
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
  if (section) renderRecordings(state, section);
}

async function refreshTranscript(state) {
  const { segments } = await meetingStore.readTranscript(state.meeting);
  state.transcript = segments;
  const section = state.root.querySelector('[data-section="transcript"]');
  if (section) renderTranscript(state, section);
}

async function refreshSummaries(state) {
  state.summaries = await meetingStore.readSummaries(state.meeting);
  const latest = state.summaries[0];
  if (latest) {
    state.summaryDocId = latest.id;
    state.summaryContent = await meetingStore.readSummaryContent(latest.id);
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
  const notes = await api.getDocMarkdown(state.docId);
  const selected = state.summarySelectedIds
    ? new Set(state.summarySelectedIds)
    : null;
  const transcript = state.transcript
    .filter((segment) => !selected || selected.has(segment.recordingId))
    .map((segment) => ({
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
  section.replaceChildren();
  const header = h("div", "meeting-view-header");
  header.innerHTML = `<span class="meeting-view-title">录音段</span><span class="meeting-view-count">${state.recordings.length}</span>`;
  section.append(header);

  if (!state.recordings.length) {
    state.player = null;
    section.append(
      emptyState(
        "iconMeetingMic",
        "还没有录音",
        "点击「开始录音」后，这段录音会出现在这里，并持续写入本机。",
      ),
    );
    return;
  }

  const list = h("div", "meeting-segments");
  for (const recording of state.recordings) {
    list.append(segmentCard(state, recording));
  }
  section.append(list);

  const selected = state.recordings.find((item) => item.recordingId === state.selectedRecordingId);
  if (selected) section.prepend(playerView(state, selected));
}

function segmentCard(state, recording) {
  const card = h("div", "meeting-segment");
  card.dataset.recordingId = recording.recordingId;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.classList.toggle("is-selected", recording.recordingId === state.selectedRecordingId);
  card.setAttribute("aria-pressed", String(recording.recordingId === state.selectedRecordingId));

  const status = transcriptStatus(
    recording,
    state.transcript,
    state.plugin.transcription,
    state.docId,
  );
  const top = h("div", "meeting-segment__top");
  const title = h("span", "meeting-segment__title", recordingTitle(recording.index));
  const badge = h("span", `meeting-segment__badge status-${status || "none"}`, statusLabel(status));
  const liveStatus = state.plugin.transcription.statusFor(state.docId, recording.recordingId);
  badge.title = liveStatus.error || recording.transcriptionError || "";
  top.append(title, badge);

  const meta = h(
    "div",
    "meeting-segment__meta",
    `${recordingRange(recording)} · ${formatDuration(Number(recording.seconds || 0) * 1000, {
      alwaysHours: Number(recording.seconds || 0) >= 3600,
    })}`,
  );
  if (recording.interrupted) {
    meta.append(h("span", "meeting-segment__notice", "中断后恢复"));
  }
  if (!recording.assetPath) {
    const warning = h("span", "meeting-segment__warn", "未归档");
    meta.append(warning);
  }

  const actions = h("div", "meeting-segment__actions");
  const button = h("button", "meeting-btn meeting-btn--small", "");
  const running = state.plugin.transcription.isRunning(recording.recordingId);
  const hasText = state.transcript.some((item) => item.recordingId === recording.recordingId);
  const fillGaps = recording.channels === 2 && recording.realtimeEnabled && recording.gaps?.length > 0;
  button.textContent = running ? "正在转写" : fillGaps ? "补齐缺口" : hasText || status === "done" ? "重新转写" : "转写";
  button.disabled = running || !recording.assetPath;
  button.title = running ? "关闭思源或断网会中断转写，之后需手动重试" : "使用腾讯云转写服务";
  button.onclick = (event) => {
    event.stopPropagation();
    void startTranscription(state, recording, { gapsOnly: fillGaps });
  };
  if (fillGaps && hasText) {
    const redo = h("button", "meeting-link", "重新转写整段");
    redo.disabled = running || !recording.assetPath;
    redo.onclick = (event) => {
      event.stopPropagation();
      void startTranscription(state, recording);
    };
    actions.append(redo);
  }
  actions.append(button);
  card.append(top, meta, actions);
  const select = () => {
    state.selectedRecordingId = recording.recordingId;
    renderRecordings(state);
  };
  card.addEventListener("click", select);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
  return card;
}

async function startTranscription(state, recording, { gapsOnly = false } = {}) {
  try {
    if (!state.plugin.transcription.isConfigured()) {
      openSettings(state.plugin);
      return;
    }
    const { recordings } = await meetingStore.readRecordings(state.meeting);
    recording = recordings.find((item) => item.recordingId === recording.recordingId) || recording;
    const { segments } = await meetingStore.readTranscript(state.meeting);
    const hasText = segments.some((item) => item.recordingId === recording.recordingId);
    const fingerprint = await meetingStore.transcriptFingerprint(state.meeting, recording.recordingId);
    if (!gapsOnly && (hasText || recording.transcriptionStatus === "done")) {
      const edited = !recording.transcriptionFingerprint || fingerprint !== recording.transcriptionFingerprint;
      const accepted = await confirmDialog("重新转写", edited
        ? "这段转写已被修改。重新转写会再次计费并替换现有转写，你的修改会丢失。"
        : "重新转写会再次计费，并替换这段录音的现有转写。", "重新转写");
      if (!accepted) return;
    } else if (recording.transcriptionStatus === "incomplete" && !gapsOnly) {
      if (!await confirmDialog("重试转写", "上次转写未完成。重新提交可能再次计费，是否继续？", "继续转写")) return;
    }
    await state.plugin.transcription.start(state.meeting, recording, { gapsOnly, expectedFingerprint: fingerprint });
  } catch (error) {
    showMessage(error.message, 7000, "error");
  }
}

function playerView(state, recording) {
  const wrapper = h("div", "meeting-player");
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
    if (state.audio.paused) void state.audio.play();
    else state.audio.pause();
  };
  row.append(play);

  const wave = h("div", "meeting-player__wave");
  const canvas = document.createElement("canvas");
  canvas.className = "meeting-waveform";
  canvas.setAttribute("aria-label", "录音波形，可点击定位");
  wave.append(canvas);
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
  state.player = { play, canvas, times, marks, recording };
  wrapper.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openPlayerMenu(state, event, recording);
  });

  requestAnimationFrame(() => {
    layoutWaveform(state);
    updatePlayer(state);
  });
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

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (Number.isFinite(state.audio.duration) && state.audio.duration > 0) {
      state.audio.currentTime = fraction * state.audio.duration;
      updatePlayer(state);
    }
  });

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
  drawWaveform(state, progress);
}

function renderTranscript(state, section = state.root.querySelector('[data-section="transcript"]')) {
  if (!section) return;
  section.replaceChildren();
  const header = h("div", "meeting-view-header");
  header.innerHTML = `<span class="meeting-view-title">转写</span><span class="meeting-view-count">${state.transcript.length}</span>`;
  const open = h("button", "meeting-link", "打开转写文档");
  open.onclick = () => openChildDoc(state, "transcript");
  header.append(open);
  section.append(header);

  const pending = state.recordings.filter((recording) =>
    ["processing"].includes(
      transcriptStatus(recording, state.transcript, state.plugin.transcription, state.docId),
    ),
  );
  if (pending.length) {
    const notice = h("div", "meeting-transcript-notice");
    const list = h("div", "meeting-transcript-notice__list");
    list.append(
      h(
        "div",
        "meeting-transcript-notice__title",
        `${pending.length} 段录音正在转写`,
      ),
    );
    for (const recording of pending) {
      const status = transcriptStatus(
        recording,
        state.transcript,
        state.plugin.transcription,
        state.docId,
      );
      list.append(
        h(
          "div",
          "meeting-transcript-notice__row",
          `${recordingTitle(recording.index)} · ${statusLabel(status)}`,
        ),
      );
    }
    const hint = h(
      "div",
      "meeting-transcript-notice__hint",
      "请保持思源打开并保持联网；中断后需手动重试，可能再次计费。",
    );
    list.append(hint);
    notice.append(icon("iconMeetingTranscript"), list);
    section.append(notice);
  }

  if (!state.plugin.transcription.isConfigured()) {
    const notice = h("div", "meeting-transcript-notice");
    notice.append(h("span", "", "尚未配置腾讯云转写服务，录音仍可正常保存。"));
    const settings = h("button", "meeting-link", "会议设置");
    settings.onclick = () => openSettings(state.plugin);
    notice.append(settings);
    section.append(notice);
  }
  for (const recording of state.recordings) {
    if (recording.gaps?.length) {
      const ranges = recording.gaps.map((gap) => `${formatDuration(gap.startMs)}–${formatDuration(gap.endMs)}${recording.channels === 2 ? (gap.channel === 0 ? "（我）" : "（其他参会者）") : ""}`).join("、");
      section.append(h("p", "meeting-transcript-notice", `${recordingTitle(recording.index)} 尚未转写：${ranges}`));
    }
    if (recording.transcriptionError) section.append(h("p", "meeting-transcript-notice", `${recordingTitle(recording.index)}：${recording.transcriptionError}`));
  }

  if (!state.transcript.length) {
    section.append(
      emptyState(
        "iconMeetingTranscript",
        "尚无转写",
        "选择上方录音段并点击「转写」，使用已配置的腾讯云服务。",
      ),
    );
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
      const seek = h(
        "button",
        "meeting-transcript-time",
        formatDuration(segment.startMs),
      );
      seek.type = "button";
      const actual = actualTimeFor(recording, segment.startMs);
      seek.title = `${actual ? `${actual} · ` : ""}点击回听`;
      seek.onclick = () => {
        state.selectedRecordingId = recording.recordingId;
        state.ui.view = "transcript";
        saveUiState(state.docId, state.ui);
        renderMeetingView(state);
        const audio = state.audio;
        const play = () => {
          audio.currentTime = Math.max(0, Number(segment.startMs || 0) / 1000);
          void audio.play();
        };
        if (audio.readyState > 0) play();
        else audio.addEventListener("loadedmetadata", play, { once: true });
      };
      const body = h("div", "meeting-transcript-body");
      const speaker = h(
        "span",
        `meeting-transcript-speaker speaker-${Number(segment.speaker || 0) % SPEAKER_COLORS}`,
        segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`,
      );
      const text = h("span", "meeting-transcript-text", segment.text);
      body.append(speaker, text);
      row.append(seek, body);
      group.append(row);
    }
    section.append(group);
  }
}

function renderSummary(state) {
  const section = state.root.querySelector('[data-view-content="summary"]');
  if (!section) return;
  // Keep the native editor alive through material refreshes; replacing it
  // while typing would lose focus and pending edits.
  state.summaryEditorElement?.remove();
  section.replaceChildren();
  const header = h("div", "meeting-view-header");
  header.innerHTML = `<span class="meeting-view-title">纪要</span>`;
  section.append(header);

  if (state.summaryGenerating) {
    renderSummaryStreaming(state, section);
    return;
  }

  if (state.summaryError) {
    const error = h("div", "meeting-summary-state");
    error.innerHTML = `${icon("iconMeetingWarning", "meeting-summary-state__icon")}
      <p class="meeting-summary-state__title">纪要生成失败</p>
      <p class="meeting-summary-state__text">${escapeHtml(state.summaryError)}</p>`;
    const retry = h("button", "meeting-btn", "重试");
    retry.onclick = () => void generateSummary(state, {});
    error.append(retry);
    appendSummaryScope(state, error);
    const settings = h("button", "meeting-link", "打开思源 AI 设置");
    settings.onclick = () => openSetting(state.plugin.app);
    error.append(settings);
    section.append(error);
    return;
  }

  const latest = state.summaries[0];
  const hasContent = Boolean(latest);
  if (!hasContent && !ai.isConfigured()) {
    section.append(configError(state));
    return;
  }
  const budget = prompts.contextCharacterBudget(ai.getEditingModel()?.model);
  const material = state.material;
  const overBudget = Boolean(budget && material && material.characters > budget);

  if (!hasContent) {
    if (!budget) {
      section.append(capacityError(state, material?.characters || 0, 0));
      return;
    }
    if (overBudget) {
      section.append(capacityError(state, material.characters, budget));
      return;
    }
    const empty = h("div", "meeting-summary-state");
    empty.innerHTML = `${icon("iconMeetingSparkle", "meeting-summary-state__icon")}
      <p class="meeting-summary-state__title">生成会议纪要</p>
      <p class="meeting-summary-state__text">${summaryMaterialText(state)}</p>`;
    const generate = h("button", "meeting-btn meeting-btn--primary", "生成纪要");
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
    `${latest.generatedAt ? `生成于 ${formatClock(latest.generatedAt)}` : "已生成"}${latest.sources ? ` · ${latest.sources}` : ""}`,
  );
  const actions = h("div", "meeting-summary-actions");
  const regenerate = h("button", "meeting-link", "重新生成");
  regenerate.onclick = () => void regenerateSummary(state);
  const open = h("button", "meeting-link", "打开纪要文档");
  open.onclick = () => openChildDoc(state, "summary", latest.id);
  actions.append(regenerate, open);
  meta.append(metaText, actions);
  section.append(meta);
  if (state.summaryNotice) {
    section.append(h("p", "meeting-summary-state__notice", state.summaryNotice));
  }
  if (state.summaryEditorId !== latest.id) {
    state.summaryProtyle?.destroy();
    state.summaryProtyle = null;
    state.summaryEditorElement = h("div", "meeting-summary-editor");
    state.summaryEditorId = latest.id;
  }
  section.append(state.summaryEditorElement);
  if (!state.summaryProtyle) {
    state.summaryProtyle = new Protyle(state.plugin.app, state.summaryEditorElement, {
      blockId: latest.id,
      mode: "wysiwyg",
      action: ["cb-get-all"],
      render: { background: false, title: false, gutter: true, breadcrumb: false, scroll: true },
    });
  } else {
    state.summaryProtyle.resize?.();
  }
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
    const warning = h("div", "meeting-summary-scope__note");
    warning.append(h("p", "", "以下录音尚未转写完整，缺少的内容不会进入纪要："));
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
  const card = h("div", "meeting-summary-state");
  card.innerHTML = `${icon("iconMeetingWarning", "meeting-summary-state__icon")}
    <p class="meeting-summary-state__title">尚未配置 AI</p>
    <p class="meeting-summary-state__text">纪要使用思源设置中的 AI 模型。配置模型后即可使用本场笔记与转写生成纪要。</p>`;
  const open = h("button", "meeting-btn", "打开思源设置");
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
    <p class="meeting-summary-state__title">${budget ? "材料超出模型容量" : "尚不清楚模型能处理多少内容"}</p>
    <p class="meeting-summary-state__text">${budget
      ? `当前材料约 ${characters} 字，超过所用模型约 ${budget} 字的处理范围。请选择较少的录音段，或只用笔记生成。`
      : "请在思源 AI 设置中填写所选模型的上下文容量，再生成纪要。"}</p>`;
  if (!budget) {
    const settings = h("button", "meeting-btn", "打开思源设置");
    settings.onclick = () => openSetting(state.plugin.app);
    card.append(settings);
    return card;
  }
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
  if (state.summaryGenerating) return;
  if (!state.meeting?.isMeeting) {
    state.summaryError = "这篇文档不是会议文档，无法生成纪要";
    renderSummary(state);
    return;
  }
  if (!ai.isConfigured()) {
    state.summaryError = "尚未配置 AI 模型";
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
  try {
    await refreshRecordings(state);
    await refreshTranscript(state);
    await refreshSummaries(state);
    if (state.summaries.length > 1) {
      throw new Error("这场会议中有多份旧纪要。请先在思源中保留一份，再重新生成。");
    }
    await refreshMaterial(state);
    const resolved = JSON.parse(JSON.stringify(ai.getEditingModel()));
    const budget = prompts.contextCharacterBudget(resolved?.model);
    if (!budget) {
      throw new Error("尚不清楚所选模型能处理多少内容。请在思源 AI 设置中填写模型的上下文容量，再生成纪要。");
    }
    const system = prompts.buildSystemPrompt({ date: new Date() });
    const user = state.material.userPrompt;
    const characters = prompts.countNormalizedCharacters(`${system}\n${user}`);
    if (characters > budget) {
      throw new Error(
        `本次内容约 ${characters} 字，超过所选模型约 ${budget} 字的处理范围。请只用笔记或选择较少的录音段。`,
      );
    }
    const sources = summarySourceText(state);
    const incomplete = incompleteSummaryRecordings(state);
    const existing = state.summaries[0];
    const expectedFingerprint = existing ? sha256(state.summaryContent.trim()) : "";
    const edited = Boolean(existing && (!existing.fingerprint || existing.fingerprint !== expectedFingerprint));
    const warnings = [];
    if (existing) {
      warnings.push(edited
        ? "当前纪要已被修改。重新生成会替换这份纪要，你的修改将丢失。"
        : "重新生成会替换这份纪要。");
    }
    if (incomplete.length) {
      warnings.push(`以下内容不会完整进入本次纪要：${incomplete.join("；")}。`);
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
    state.summarySaving = true;
    renderSummary(state);
    const saved = await meetingStore.saveSummary(state.meeting, {
      markdown: text,
      sources,
      generatedAt,
      expectedFingerprint,
    });
    state.summaries = await meetingStore.readSummaries(state.meeting);
    if (!state.summaries.some((item) => item.id === saved.docId)) {
      state.summaries.push({ id: saved.docId, generatedAt, sources, fingerprint: saved.fingerprint });
    }
    state.summaryDocId = saved.docId;
    state.summaryContent = saved.content;
    state.summaryNotice = saved.replaced ? "已替换纪要" : "";
    state.summaryStream = "";
  } catch (error) {
    if (state.summarySaving) {
      state.summaryError = error.message;
    } else if (abort.signal.aborted || String(error.message).includes("已取消")) {
      state.summaryNotice = "已取消生成，未写入任何内容";
    } else {
      state.summaryError = error.message;
    }
  } finally {
    state.summaryGenerating = false;
    state.summarySaving = false;
    state.summaryAbort = null;
    renderSummary(state);
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
    click: () => void refreshAll(state),
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

function openSettings(plugin) {
  const prefs = plugin.controller.getPrefs();
  const notebooks = api.notebooks();
  const hasSecretId = Boolean(plugin.getSecret?.("meeting.tencent.secretId"));
  const hasSecretKey = Boolean(plugin.getSecret?.("meeting.tencent.secretKey"));
  const content = `
    <div class="b3-dialog__content meeting-settings">
      <section>
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
      <section>
        <h3>腾讯云转写</h3>
        <p class="meeting-settings__hint">密钥仅保存在本机。转写时会将录音发送给你配置的腾讯云服务；密钥留空表示不修改。</p>
        <label class="meeting-settings__row"><span>AppId</span>
          <input class="b3-text-field" name="appId" value="${escapeHtml(prefs.tencentAppId || "")}" autocomplete="off">
        </label>
        <label class="meeting-settings__row"><span>SecretId</span>
          <input class="b3-text-field" type="password" name="secretId" placeholder="${hasSecretId ? "已保存，留空不修改" : "填写 SecretId"}" autocomplete="off">
        </label>
        <label class="meeting-settings__row"><span>SecretKey</span>
          <input class="b3-text-field" type="password" name="secretKey" placeholder="${hasSecretKey ? "已保存，留空不修改" : "填写 SecretKey"}" autocomplete="off">
        </label>
        <label class="meeting-settings__row"><span>实时转写</span>
          <input type="checkbox" name="realtime"${prefs.realtimeTranscription !== false ? " checked" : ""}>
        </label>
        <p class="meeting-settings__hint">从下一段录音开始生效。线下会议开启后，结束时会再次转写整段以区分说话人，两次识别分别计费。</p>
        <label class="meeting-settings__row"><span>结束后自动转写</span>
          <input type="checkbox" name="autoTranscribe"${prefs.autoTranscribe ? " checked" : ""}>
        </label>
        <p class="meeting-settings__hint">线上实时转写只补齐缺口；关闭实时转写时，结束后转写整段。</p>
      </section>
      <section>
        <h3>AI 纪要</h3>
        <p class="meeting-settings__hint">纪要使用思源设置中的 AI 模型；本插件不保存模型密钥。</p>
        <button class="b3-button b3-button--outline" type="button" data-action="open-ai">打开思源设置</button>
      </section>
    </div>
    <div class="b3-dialog__action meeting-settings__actions">
      <button class="b3-button b3-button--cancel">取消</button>
      <button class="b3-button b3-button--text" data-action="save">保存</button>
    </div>`;
  const dialog = new Dialog({ title: "会议录音设置", width: "600px", content });
  const element = dialog.element;
  const value = (name) => element.querySelector(`[name="${name}"]`)?.value || "";
  element.querySelector('[data-field="opacity-value"]').textContent = `${value("opacity")}%`;
  element.querySelector('[name="opacity"]').addEventListener("input", (event) => {
    element.querySelector('[data-field="opacity-value"]').textContent = `${event.target.value}%`;
  });
  element.querySelector('[data-action="open-ai"]').onclick = () => {
    try {
      openSetting(plugin.app);
    } catch {
      showMessage("请打开思源设置 → AI", 5000);
    }
  };
  element.querySelector(".b3-button--cancel").onclick = () => dialog.destroy();
  element.querySelector('[data-action="save"]').onclick = async () => {
    const save = element.querySelector('[data-action="save"]');
    save.disabled = true;
    try {
      const secretId = value("secretId").trim();
      const secretKey = value("secretKey").trim();
      await api.writeSecrets([
        { name: "meeting.tencent.secretId", value: secretId },
        { name: "meeting.tencent.secretKey", value: secretKey },
      ]);
      plugin.controller.setPrefs({
        notebookId: value("notebook"),
        mode: value("mode"),
        opacity: Number(value("opacity")) / 100,
        tencentAppId: value("appId").trim(),
        realtimeTranscription: element.querySelector('[name="realtime"]').checked,
        autoTranscribe: element.querySelector('[name="autoTranscribe"]').checked,
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
