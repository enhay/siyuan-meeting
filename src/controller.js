"use strict";

const { EventEmitter } = require("node:events");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const remote = require("@electron/remote");
const meetingStore = require("./meeting-store");
const api = require("./siyuan-api");
const tencent = require("./tencent");
const { recover, finalizeInterrupted } = require("../capture/storage.cjs");
const { clamp, isBlockId, isAssetPath } = require("./util");

const FLOAT_WIDTH = 200;
const FLOAT_HEIGHT = 67;
const FLOAT_SCREEN_MARGIN = 8;
const ACTIVE_PHASES = new Set(["preparing", "recording", "paused"]);
const PREF_KEY = "siyuan-meeting.prefs";
const CURRENT_KEY = "siyuan-meeting.current";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

class MeetingController {
  constructor(plugin) {
    this.plugin = plugin;
    this.events = new EventEmitter();
    this.seekEmitter = new EventEmitter();
    this.pendingSeek = null;
    this.channel = `meeting-${crypto.randomUUID()}`;
    this.userData = remote.app.getPath("userData");
    const dataDir = window.siyuan?.config?.system?.dataDir || "";
    const workspaceKey = crypto
      .createHash("sha256")
      .update(dataDir || this.userData)
      .digest("hex")
      .slice(0, 16);
    this.storageRoot = path.join(this.userData, "siyuan-meeting", workspaceKey);
    this.preferencesPath = path.join(this.storageRoot, "preferences.json");
    this.recordingRoot = path.join(this.storageRoot, "recordings");
    this.peaksRoot = path.join(this.storageRoot, "peaks");
    this.pendingArchivePath = path.join(this.storageRoot, "pending-archives.json");
    this.capture = null;
    this.captureReady = null;
    this.resolveCaptureReady = null;
    this.floatWin = null;
    this.floatShouldShow = false;
    this.floatMoved = false;
    this.floatTimer = null;
    this.savedTimer = null;
    this.retryTimer = null;
    this.devices = [];
    this.devicesResolve = null;
    this.devicesTimer = null;
    this.archiving = false;
    this.realtimeWrite = Promise.resolve();
    this.savingPromise = null;
    this.shuttingDown = false;
    this.stopTimer = null;
    this.pendingRecoveries = [];
    this.dismissedRecoveries = new Set();
    this.suspendPending = false;
    this.systemNotice = "";
    this.state = {
      phase: "idle",
      meeting: null,
      elapsedMs: 0,
      levels: [0, 0],
      peaks: [0, 0],
      error: "",
      needsAttention: "",
      notice: "",
      realtimeNotice: "",
      realtimeEnabled: false,
      realtimeConfigured: false,
      saveFailed: false,
      savingStage: "",
      savedAt: 0,
      online: false,
      deviceId: "",
      devices: [],
      hasStore: false,
      hasFrames: false,
      recordingId: "",
      lastSaved: null,
      pendingRecoveries: 0,
    };
    this.prefs = {
      mode: "offline",
      deviceId: "",
      opacity: 0.9,
      notebookId: "",
      tencentAppId: "",
      realtimeTranscription: true,
      autoTranscribe: false,
    };
    this.ipcListener = (event, message) => this.onIpc(event, message);
    remote.ipcMain.on(this.channel, this.ipcListener);
    this.onDisplayChange = () => this.positionFloat();
    remote.screen.on("display-removed", this.onDisplayChange);
    remote.screen.on("display-metrics-changed", this.onDisplayChange);
    this.onPowerSuspend = () => this.handleSuspend();
    this.onPowerResume = () => this.handleResume();
    try {
      this.powerMonitor = remote.powerMonitor;
      this.powerMonitor?.on?.("suspend", this.onPowerSuspend);
      this.powerMonitor?.on?.("resume", this.onPowerResume);
    } catch {
      // powerMonitor is optional; continuous fsync still protects the file.
    }
  }

  handleSuspend() {
    if (this.state.phase === "recording") {
      this.suspendPending = true;
      this.systemNotice = "系统休眠，正在暂停录音…";
      this.state.notice = this.systemNotice;
      this.emit();
      void this.pause().catch(() => {});
    } else if (this.state.phase === "preparing") {
      this.systemNotice = "系统休眠，已取消正在进行的录音准备";
      this.state.notice = this.systemNotice;
      this.emit();
      void this.stop().catch(() => {});
    }
  }

  handleResume() {
    if (this.state.phase === "paused") {
      this.suspendPending = false;
      this.systemNotice = "系统已从休眠恢复；录音仍暂停，请检查设备后点击继续。";
      this.state.notice = this.systemNotice;
    } else if (this.state.phase === "recording") {
      this.systemNotice = "系统休眠期间录音可能中断；请重新连接或结束录音。";
      this.state.notice = this.systemNotice;
      this.state.needsAttention = this.systemNotice;
    }
    this.emit();
  }

  async init() {
    let legacy = {};
    try {
      legacy = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    } catch {
      // A browser preference is migrated only when it can be read.
    }
    const stored = { ...legacy, ...readJson(this.preferencesPath, {}) };
    for (const key of Object.keys(this.prefs)) {
      if (Object.hasOwn(stored, key)) this.prefs[key] = stored[key];
    }
    try {
      writeJson(this.preferencesPath, this.prefs);
      localStorage.removeItem(PREF_KEY);
    } catch {
      // Keep the legacy preference until its local replacement is saved.
    }
    this.state.online = this.prefs.mode === "online";
    this.state.deviceId = this.prefs.deviceId || "";
    this.refreshRecoveries({ emit: false });
    this.emit();
    // Do not await network or recovery work during plugin load.
    this.retryTimer = setTimeout(() => {
      void this.retryPendingArchives();
    }, 1500);
  }

  subscribe(listener) {
    this.events.on("state", listener);
    listener(this.snapshot());
    return () => this.events.off("state", listener);
  }

  setPrefs(patch) {
    const next = { ...this.prefs, ...patch };
    writeJson(this.preferencesPath, next);
    this.prefs = next;
    if (!this.isBusy()) {
      if (patch.mode) this.state.online = patch.mode === "online";
      if (typeof patch.deviceId === "string") this.state.deviceId = patch.deviceId;
    }
    this.emit();
  }

  getPrefs() {
    return { ...this.prefs };
  }

  snapshot() {
    const elapsed = this.computeElapsed();
    return {
      ...this.state,
      elapsedMs: elapsed,
      devices: this.devices.slice(),
      pendingRecoveries: this.pendingRecoveries.length,
    };
  }

  computeElapsed() {
    if (this.state.phase === "recording" && this.lastTickAt) {
      return Math.max(this.state.elapsedMs, this.state.elapsedMs + (Date.now() - this.lastTickAt));
    }
    return this.state.elapsedMs;
  }

  emit() {
    const snapshot = this.snapshot();
    this.events.emit("state", snapshot);
    try {
      this.plugin.refreshTopBar(snapshot);
    } catch {
      // topbar may not exist yet
    }
    this.updateFloat(snapshot);
  }

  isActive() {
    return ACTIVE_PHASES.has(this.state.phase);
  }

  /**
   * Busy means the client must not start a second meeting recording. An error
   * with already-written audio still owns the recorder until the user saves or
   * discards that segment.
   */
  isBusy() {
    return (
      this.isActive() ||
      this.state.phase === "saving" ||
      (this.state.phase === "error" && (this.state.hasStore || this.state.hasFrames))
    );
  }

  async createMeeting({ title, notebookId } = {}) {
    const available = api.notebooks();
    const requested = notebookId || this.prefs.notebookId;
    const notebook =
      available.find((item) => item.id === requested)?.id ||
      api.currentNotebookId() ||
      available[0]?.id;
    if (!notebook) throw new Error("请先在思源中创建或打开一个笔记本");
    const meeting = await meetingStore.createMeeting({
      title,
      notebookId: notebook,
      mode: this.prefs.mode,
    });
    this.prefs.notebookId = notebook;
    this.setPrefs({});
    this.selectMeeting(meeting);
    this.plugin.openMeetingTab(meeting.id, meeting.title);
    return meeting;
  }

  selectMeeting(meeting) {
    // Keep the recording target stable when the user browses other meetings
    // while a recording is active. The active meeting owns the archive.
    this.selectedMeeting = meeting;
    if (!this.isBusy() || this.state.meeting?.id === meeting?.id) {
      this.state.meeting = meeting;
    }
    try {
      localStorage.setItem(CURRENT_KEY, meeting?.id || "");
    } catch {
      // storage may be unavailable
    }
    this.emit();
  }

  async openMeeting(docId) {
    const meeting = await meetingStore.getMeeting(docId);
    this.selectMeeting(meeting);
    this.plugin.openMeetingTab(meeting.id, meeting.title);
    return meeting;
  }

  requestSeek({ docId, recordingId, startMs }) {
    if (!isBlockId(docId) || !recordingId) return;
    this.pendingSeek = { docId, recordingId, startMs: Number(startMs || 0) };
    this.seekEmitter.emit("seek", this.pendingSeek);
    this.plugin.openMeetingTab(docId, this.selectedMeeting?.id === docId ? this.selectedMeeting.title : "会议");
  }

  consumeSeek(docId) {
    if (this.pendingSeek?.docId !== docId) return null;
    const seek = this.pendingSeek;
    this.pendingSeek = null;
    return seek;
  }

  openCurrentMeeting() {
    const docId = this.state.meeting?.id;
    if (!docId) return;
    try {
      const win = remote.getCurrentWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch {
      // window may be gone
    }
    this.plugin.openMeetingTab(docId, this.state.meeting.title);
  }

  async renameMeeting(docId, title) {
    const next = await meetingStore.renameMeeting(docId, title);
    this.noteMeetingTitle(docId, next);
    return next;
  }

  /** Synchronize a title change made in another editor/tab. */
  noteMeetingTitle(docId, title) {
    if (!title) return;
    if (this.state.meeting?.id === docId && this.state.meeting.title !== title) {
      this.state.meeting = { ...this.state.meeting, title };
      this.emit();
    }
    if (this.selectedMeeting?.id === docId) {
      this.selectedMeeting = { ...this.selectedMeeting, title };
    }
  }

  async startRecording({ docId, online = false, deviceId = "" } = {}) {
    if (this.isBusy()) {
      throw new Error("已有会议在录音");
    }
    const doc = docId || this.state.meeting?.id;
    if (!doc) throw new Error("请先新建或打开一个会议");
    let meeting = await meetingStore.getMeeting(doc);
    if (!meeting.isMeeting) throw new Error("这篇文档不是会议文档");

    this.prefs.mode = online ? "online" : "offline";
    this.prefs.deviceId = deviceId;
    this.prefs.notebookId = meeting.notebookId;

    if (!meeting.segments) {
      try {
        const notes = await api.getDocMarkdown(meeting.id);
        try {
          // Keep the full snapshot locally; the synced attribute is bounded.
          localStorage.setItem(`siyuan-meeting.preNotes.${meeting.meetingId}`, notes);
        } catch {
          // storage may be unavailable
        }
        const saved = await meetingStore.savePreNotes(meeting.id, notes);
        meeting = { ...meeting, preNotes: saved };
      } catch {
        // A failed snapshot must not prevent the meeting from being recorded.
      }
    }

    this.setPrefs({});
    this.state.meeting = meeting;
    this.state.recordingId = crypto.randomUUID();
    this.state.realtimeNotice = "";
    this.state.realtimeEnabled = this.prefs.realtimeTranscription !== false;
    this.state.realtimeConfigured = this.plugin.transcription.isConfigured();
    this.state.phase = "preparing";
    this.state.error = "";
    this.state.needsAttention = "";
    this.state.notice = "";
    this.systemNotice = "";
    this.suspendPending = false;
    this.state.saveFailed = false;
    this.state.savingStage = "";
    this.state.lastSaved = null;
    this.state.elapsedMs = 0;
    this.state.levels = [0, 0];
    this.state.peaks = [0, 0];
    this.state.online = Boolean(online);
    this.state.deviceId = deviceId;
    this.state.hasStore = false;
    this.state.hasFrames = false;
    this.floatMoved = false;
    this.lastTickAt = 0;
    clearTimeout(this.floatTimer);
    clearTimeout(this.savedTimer);
    this.hideFloat();
    this.emit();
    await meetingStore.markStatus(meeting.id, "recording").catch(() => {});

    try {
      await this.ensureCapture();
      await this.execCapture(
        `window.meetingStart(${JSON.stringify({
          storage: path.join(this.recordingRoot, meeting.meetingId),
          online: Boolean(online),
          deviceId,
          realtime: {
            enabled: this.state.realtimeEnabled,
            configured: this.state.realtimeConfigured,
          },
          meta: {
            recordingId: this.state.recordingId,
            meetingId: meeting.meetingId,
            docId: meeting.id,
            segmentNo: meeting.segments || 0,
          },
        })})`,
      );
    } catch (error) {
      this.state.phase = "error";
      this.state.error = error.message;
      this.state.saveFailed = false;
      this.emit();
      throw error;
    }
  }

  async pause() {
    if (this.state.phase !== "recording") return;
    if (!this.suspendPending) {
      this.systemNotice = "";
      this.state.notice = "";
    }
    await this.ensureCapture();
    await this.execCapture("window.meetingPause()");
  }

  async resume() {
    if (this.state.phase !== "paused") return;
    this.systemNotice = "";
    this.suspendPending = false;
    this.state.notice = "";
    await this.ensureCapture();
    await this.execCapture("window.meetingResume()");
  }

  async stop() {
    if (this.state.phase === "saving") return;
    if (this.state.phase === "idle" || this.state.phase === "saved") {
      // A stale floating bar should still be dismissible even if its phase
      // already returned to idle/saved.
      this.hideFloat();
      this.emit();
      return;
    }
    if (!ACTIVE_PHASES.has(this.state.phase) && this.state.phase !== "error") {
      return;
    }
    if (this.state.phase === "error" && !this.state.hasStore && !this.state.hasFrames) {
      this.state.phase = "idle";
      this.state.error = "";
      this.state.needsAttention = "";
      this.state.notice = "";
      this.hideFloat();
      this.emit();
      return;
    }
    this.state.phase = "saving";
    this.state.savingStage = "正在处理最后一批数据…";
    this.emit();
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.state.phase === "saving" && !this.archiving) {
        this.state.phase = "error";
        this.state.saveFailed = true;
        this.state.error = "保存超时；已写入磁盘的部分保留在本机，请重试归档或检查录音文件。";
        this.emit();
      }
    }, 20000);
    try {
      await this.ensureCapture();
      await this.execCapture("window.meetingStop()");
    } catch (error) {
      clearTimeout(this.stopTimer);
      this.state.phase = "error";
      this.state.error = `结束录音失败：${error.message}`;
      this.state.saveFailed = true;
      this.emit();
    }
  }

  async reconnect() {
    if (!this.isActive()) return;
    await this.ensureCapture();
    await this.execCapture("window.meetingReconnect()");
  }

  async getDevices(force = false) {
    if (!force && this.devices.length) return this.devices.slice();
    try {
      await this.ensureCapture();
      const devicePromise = new Promise((resolve) => {
        this.devicesResolve = resolve;
        clearTimeout(this.devicesTimer);
        this.devicesTimer = setTimeout(() => {
          this.devicesResolve = null;
          resolve([]);
        }, 2500);
      });
      await this.execCapture("window.meetingDevices()");
      const devices = await devicePromise;
      this.devices = devices;
      this.state.devices = devices;
      this.emit();
      return devices.slice();
    } catch {
      this.devicesResolve = null;
      clearTimeout(this.devicesTimer);
      return [];
    }
  }

  async ensureCapture() {
    if (this.capture && !this.capture.isDestroyed()) {
      if (this.captureReady) await this.captureReady;
      return this.capture;
    }
    const { BrowserWindow, session, desktopCapturer } = remote;
    const dataDir = window.siyuan?.config?.system?.dataDir || "";
    const root = path.join(dataDir, "plugins", this.plugin.name, "capture");
    const page = pathToFileURL(path.join(root, "index.html")).href;
    const isolated = session.fromPartition(this.channel);
    const capture = new BrowserWindow({
      width: 2,
      height: 2,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session: isolated,
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.capture = capture;
    this.isolated = isolated;
    capture.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    capture.webContents.on("will-navigate", (event) => event.preventDefault());
    capture.on("close", (event) => {
      event.preventDefault();
      capture.hide();
    });
    capture.webContents.on("render-process-gone", () => {
      this.capture = null;
      this.captureReady = null;
      this.state.phase = "error";
      this.state.error = "录音进程意外退出；已写入磁盘的部分仍可恢复。请结束本段或重新加载插件。";
      this.state.needsAttention = this.state.error;
      this.refreshRecoveries({ emit: false });
      this.emit();
    });

    const isCapture = (contents) => contents?.id === capture.webContents.id;
    isolated.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        isCapture(contents) && permission === "media" && details?.isMainFrame === true,
    );
    isolated.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(isCapture(contents) && permission === "media" && details.isMainFrame === true),
    );
    isolated.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (
          request.frame !== capture.webContents.mainFrame ||
          !request.userGesture ||
          !request.audioRequested
        ) {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!sources.length) throw new Error("没有可采集的屏幕");
        callback({ video: sources[0], audio: "loopback" });
      } catch {
        this.onCaptureError(new Error(process.platform === "darwin"
          ? "无法获取电脑声音，请在 macOS 系统设置的隐私与安全性中检查思源的屏幕与系统音频录制权限后重试。"
          : "无法获取电脑声音，请检查系统录制权限后重试。"));
        callback({});
      }
    });

    this.captureReady = new Promise((resolve) => {
      this.resolveCaptureReady = resolve;
    });
    const url = `${page}?channel=${encodeURIComponent(this.channel)}`;
    try {
      await capture.loadURL(url);
      const ready = await Promise.race([
        this.captureReady.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
      ]);
      if (!ready) throw new Error("录音未能启动，请重新打开会议后重试");
    } catch (error) {
      this.capture = null;
      this.captureReady = null;
      if (!capture.isDestroyed()) capture.destroy();
      throw new Error("无法启动录音，请重新加载插件后重试");
    }
    return capture;
  }

  async execCapture(script) {
    const capture = await this.ensureCapture();
    return capture.webContents.executeJavaScript(script, true);
  }

  onCaptureError(error) {
    this.state.phase = "error";
    this.state.error = error.message;
    this.state.needsAttention = error.message;
    this.emit();
  }

  onIpc(event, message) {
    const senderId = event?.sender?.id;
    const idOf = (win) => {
      try {
        return win?.webContents?.id;
      } catch {
        return undefined;
      }
    };
    if (senderId && senderId === idOf(this.capture)) {
      if (message?.type === "realtime-sign") {
        const reply = { type: "realtime-signed", requestId: message.requestId };
        try {
          if (!this.isBusy() || message.recordingId !== this.state.recordingId ||
              ![0, 1].includes(message.audioChannel) || (!this.state.online && message.audioChannel !== 0)) return;
          reply.url = tencent.signRealtimeUrl(this.plugin.transcription.config(), {
            voiceId: crypto.randomUUID(), sampleRate: 16000,
          });
        } catch {
          reply.error = "实时转写暂时不可用，录音仍在保存。";
        }
        event.sender.send(this.channel, reply);
        return;
      }
      this.onCaptureMessage(message);
      return;
    }
    if (senderId && senderId === idOf(this.floatWin)) {
      this.onFloatMessage(message);
    }
  }

  onCaptureMessage(message) {
    if (!message) return;
    if (message.type === "ready") {
      this.resolveCaptureReady?.();
      this.resolveCaptureReady = null;
      return;
    }
    if (message.type === "devices") {
      this.devices = Array.isArray(message.devices) ? message.devices : [];
      this.state.devices = this.devices;
      this.devicesResolve?.(this.devices);
      this.devicesResolve = null;
      clearTimeout(this.devicesTimer);
      this.emit();
      return;
    }
    if (message.type === "realtime") {
      const meeting = this.state.meeting;
      if (!meeting || message.recordingId !== this.state.recordingId) return;
      this.state.realtimeNotice = message.error || "";
      const capture = this.capture;
      this.realtimeWrite = this.realtimeWrite.then(async () => {
        const persisted = await this.plugin.transcription.onRealtime(meeting, message.recordingId, message);
        if (persisted && Array.isArray(persisted.gaps) && capture && !capture.isDestroyed()) {
          capture.webContents.send(this.channel, {
            type: "realtime-persisted", recordingId: message.recordingId,
            throughMs: message.throughMs, gaps: persisted.gaps,
            status: persisted.status, error: persisted.error,
          });
        }
      }).catch(() => {
        this.state.realtimeNotice = "实时转写尚未全部写入会议文档，录音仍在保存；结束后可重新转写。";
        this.emit();
      });
      this.emit();
      return;
    }
    if (message.type === "saved") {
      clearTimeout(this.stopTimer);
      this.savingPromise = this.onSaved(message);
      return;
    }
    if (message.type === "empty") {
      clearTimeout(this.stopTimer);
      this.state.phase = "idle";
      this.state.savingStage = "";
      this.state.hasStore = false;
      this.state.hasFrames = false;
      this.state.error = "";
      this.state.needsAttention = "";
      this.hideFloat();
      this.emit();
      return;
    }
    if (message.type === "error") {
      this.onCaptureError(new Error(message.message || "录音失败"));
      return;
    }
    if (message.type === "state") {
      this.onCaptureState(message);
    }
  }

  onCaptureState(message) {
    // Do not let the capture page announce "saved" before the asset is archived.
    if (message.phase !== "saved") {
      this.state.phase = message.phase;
      this.lastTickAt = Date.now();
    }
    this.state.elapsedMs = Number(message.elapsedMs || 0);
    this.state.levels = Array.isArray(message.levels) ? message.levels : [0, 0];
    this.state.peaks = Array.isArray(message.peaks) ? message.peaks : [0, 0];
    if (message.error) {
      this.state.error = message.error;
    } else if (!this.state.saveFailed) {
      this.state.error = "";
    }
    this.state.needsAttention = message.needsAttention || "";
    if (message.phase === "paused" && this.suspendPending) {
      this.suspendPending = false;
      this.systemNotice = "系统休眠导致录音暂停，请检查设备后继续。";
    }
    this.state.notice = this.systemNotice || message.notice || "";
    this.state.hasStore = Boolean(message.hasStore);
    this.state.hasFrames = Boolean(message.hasFrames);
    this.state.recordingId = message.recordingId || this.state.recordingId;

    const phaseChanged = this.lastCapturePhase !== message.phase;
    this.lastCapturePhase = message.phase;
    if (message.phase === "recording" && this.state.meeting && !this.state.meeting.firstRecordedAt) {
      const firstRecordedAt = new Date().toISOString();
      this.state.meeting = { ...this.state.meeting, firstRecordedAt };
      void meetingStore.markFirstRecorded(this.state.meeting.id).catch(() => {});
    }
    if (message.phase === "recording" || message.phase === "paused") {
      this.showFloat();
      if (phaseChanged) {
        meetingStore
          .markStatus(this.state.meeting?.id, message.phase === "paused" ? "paused" : "recording")
          .catch(() => {});
      }
    }
    if (message.phase === "error" && (message.hasFrames || message.hasStore)) {
      this.showFloat();
    }
    this.emit();
  }

  async onSaved(message) {
    if (this.archiving) return;
    clearTimeout(this.stopTimer);
    this.archiving = true;
    clearTimeout(this.floatTimer);
    this.state.phase = "saving";
    this.state.savingStage = "正在归档音频…";
    this.emit();
    const meetingDocId = message.meta?.docId || this.state.meeting?.id || "";
    const meeting =
      this.state.meeting?.id === meetingDocId ? this.state.meeting : null;
    const payload = {
      file: message.file,
      meta: message.meta || {},
      seconds: Number(message.seconds || 0),
      events: message.events || [],
      meetingDocId,
    };
    if (payload.seconds < 0.1) {
      // A failed start can leave a valid but empty WAV. Do not create an empty
      // audio block or leave it in the recovery queue.
      if (message.file) this.markArchived(message.file);
      if (message.file) this.removePendingArchive(message.file);
      this.state.phase = "idle";
      this.state.savingStage = "";
      this.state.hasStore = false;
      this.state.hasFrames = false;
      this.state.error = "";
      this.hideFloat();
      this.archiving = false;
      this.emit();
      return;
    }
    if (message.peaks) this.savePeaks(payload.meta.recordingId, message.peaks);
    try {
      await this.realtimeWrite;
      const result = await this.archiveSegment(payload);
      this.state.phase = "saved";
      this.state.savingStage = "";
      this.state.saveFailed = false;
      this.state.error = "";
      this.state.needsAttention = "";
      this.state.notice = "";
      this.systemNotice = "";
      this.state.savedAt = Date.now();
      this.state.lastSaved = result;
      if (!this.shuttingDown && meeting) {
        void meetingStore.readRecordings(meeting).then(({ recordings }) => {
          const recording = recordings.find((item) => item.recordingId === payload.meta.recordingId);
          if (recording) return this.plugin.transcription.afterRecording(meeting, recording);
        }).catch(() => {
          this.state.realtimeNotice = "录音已保存，转写尚未完成；可在转写页手动继续。";
          this.emit();
        });
      }
      this.state.hasStore = false;
      this.state.hasFrames = false;
      if (meeting) {
        meeting.segments = result.index;
        this.state.meeting = { ...meeting, segments: result.index, status: "done" };
      }
      this.removePendingArchive(message.file);
      this.refreshRecoveries({ emit: false });
      this.floatTimer = setTimeout(() => this.hideFloat(), 3000);
      clearTimeout(this.savedTimer);
      this.savedTimer = setTimeout(() => {
        if (this.state.phase === "saved") {
          this.state.phase = "idle";
          this.state.savingStage = "";
          this.hideFloat();
          this.emit();
        }
      }, 3000);
      this.emit();
    } catch (error) {
      this.state.phase = "error";
      this.state.savingStage = "";
      this.state.saveFailed = true;
      this.state.error = `音频已保存在本机，但归档到思源失败：${error.message}`;
      this.state.lastSaved = {
        dir: message.dir,
        file: message.file,
        seconds: Number(message.seconds || 0),
        error: error.message,
      };
      this.addPendingArchive(payload, error.message);
      this.refreshRecoveries({ emit: false });
      this.showFloat();
      this.emit();
    } finally {
      this.archiving = false;
    }
  }

  async archiveSegment({ file, meta, seconds, events, meetingDocId }) {
    if (!meetingDocId) throw new Error("录音没有关联的会议文档");
    if (!isBlockId(meetingDocId)) throw new Error("无法找到录音关联的会议，请重新打开会议");
    const meeting = await meetingStore.getMeeting(meetingDocId);
    if (!meeting.isMeeting) throw new Error("这篇文档不是会议，请从会议菜单打开");
    // The local recording.json is the durable record. It may already contain
    // an archived asset from an earlier failed attempt.
    const diskMeta = this.recordingMeta(file);
    meta = { ...diskMeta, ...meta };
    const recordingId = meta.recordingId || path.basename(path.dirname(file)) || crypto.randomUUID();
    const existing = await meetingStore.readRecordings(meeting);
    const already = existing.recordings.find((item) => item.recordingId === recordingId);
    if (already?.assetPath) {
      // A retry after a crash may happen after the block was written but before
      // the local "archived" marker. Do not create a duplicate audio block.
      this.markArchived(file, already.assetPath || meta.asset);
      return {
        ...already,
        dir: path.dirname(file),
        file,
        assetPath: already.assetPath,
        seconds: Number(seconds || already.seconds || 0),
        meetingDocId: meeting.id,
      };
    }
    const baseName = path.basename(file);
    let assetPath = isAssetPath(meta.asset) ? meta.asset : "";
    if (!assetPath) {
      const succMap = await api.insertLocalAssets([file], meeting.id);
      assetPath = succMap[baseName] || Object.values(succMap)[0];
      if (!assetPath) throw new Error("思源未能保存录音，已保留本机文件");
      if (!isAssetPath(assetPath)) throw new Error("录音尚未保存到思源，已保留本机文件");
      try {
        this.persistRecordingMeta(file, { asset: assetPath });
      } catch {
        // The asset is usable even if the local audit file cannot be updated.
      }
    }
    const requestedSegment = Number.isFinite(Number(meta.segmentNo)) ? Number(meta.segmentNo) : 0;
    // Use the actual block count when the synced counter is stale, so two
    // segments can never share the same display index.
    const segmentNo = already ? Math.max(0, already.index - 1)
      : Math.max(requestedSegment, existing.recordings.length);
    const appended = await meetingStore.appendRecording(meeting, {
      assetPath,
      meta: { ...meta, recordingId, segmentNo, startedAt: meta.startedAt },
      seconds,
      events,
    });
    await meetingStore.setSegmentCount(meeting.id, appended.index);
    await meetingStore.markStatus(meeting.id, "done");
    this.markArchived(file, assetPath);
    return {
      ...appended,
      dir: path.dirname(file),
      file,
      assetPath,
      seconds,
      meetingDocId: meeting.id,
    };
  }

  recordingMeta(file) {
    return readJson(path.join(path.dirname(file), "recording.json"), null) || {};
  }

  persistRecordingMeta(file, patch) {
    const metaPath = path.join(path.dirname(file), "recording.json");
    const existing = readJson(metaPath, null);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    writeJson(metaPath, merged);
    return merged;
  }

  markArchived(file, assetPath = "") {
    try {
      const patch = { archived: true };
      if (isAssetPath(assetPath)) patch.asset = assetPath;
      this.persistRecordingMeta(file, patch);
    } catch {
      // the local audit trail is best effort
    }
  }

  savePeaks(recordingId, peaks) {
    if (!recordingId) return;
    try {
      writeJson(path.join(this.peaksRoot, `${recordingId}.json`), peaks);
    } catch {
      // peaks are a nicety; playback still works without them
    }
  }

  readPeaks(recording) {
    const candidates = [
      path.join(this.peaksRoot, `${recording.recordingId}.json`),
      path.join(recording.dir || "", "peaks.json"),
    ];
    for (const file of candidates) {
      const value = readJson(file, null);
      if (value?.points?.length) return value;
    }
    return null;
  }

  pendingArchives() {
    return readJson(this.pendingArchivePath, []);
  }

  addPendingArchive(payload, error) {
    const list = this.pendingArchives().filter((item) => item.file !== payload.file);
    list.push({ ...payload, error, at: new Date().toISOString() });
    try {
      writeJson(this.pendingArchivePath, list);
    } catch {
      // local audio remains the source of truth
    }
  }

  removePendingArchive(file) {
    const list = this.pendingArchives().filter((item) => item.file !== file);
    try {
      writeJson(this.pendingArchivePath, list);
    } catch {
      // ignore
    }
  }

  async retryPendingArchives() {
    const list = this.pendingArchives();
    if (!list.length) return;
    const keep = [];
    for (const item of list) {
      try {
        const result = await this.archiveSegment(item);
        if (this.state.meeting?.id === item.meetingDocId) {
          this.state.meeting = { ...this.state.meeting, segments: result.index, status: "done" };
        }
        if (!this.isBusy() && this.state.phase !== "saving") {
          this.state.phase = "saved";
          this.state.saveFailed = false;
          this.state.error = "";
          this.state.notice = "";
          this.systemNotice = "";
          this.state.lastSaved = result;
          clearTimeout(this.savedTimer);
          this.savedTimer = setTimeout(() => {
            if (this.state.phase === "saved") {
              this.state.phase = "idle";
              this.emit();
            }
          }, 3000);
        }
      } catch (error) {
        keep.push({ ...item, error: error.message });
      }
    }
    try {
      writeJson(this.pendingArchivePath, keep);
    } catch {
      // ignore
    }
    this.refreshRecoveries({ emit: false });
    this.emit();
  }

  activeRecordingDir() {
    if (!this.capture || this.capture.isDestroyed()) return "";
    if (!["preparing", "recording", "paused"].includes(this.state.phase)) return "";
    const meetingId = this.state.meeting?.meetingId;
    const recordingId = this.state.recordingId;
    if (!meetingId || !recordingId) return "";
    return path.join(this.recordingRoot, meetingId, recordingId);
  }

  scanRecoveries() {
    try {
      const activeDir = this.activeRecordingDir();
      const pendingFiles = new Set(
        this.pendingArchives().map((item) => (item.file ? path.resolve(item.file) : "")),
      );
      return recover(this.recordingRoot)
        .filter((item) => {
          if (!item.meta) return false;
          if (item.dir === activeDir) return false;
          if (this.dismissedRecoveries.has(item.dir)) return false;
          if (item.file && pendingFiles.has(path.resolve(item.file))) return false;
          return item.meta.phase !== "saved" || !item.meta.archived;
        })
        .map((item) => ({
          ...item,
          startedAt: item.meta.startedAt,
          seconds: Number(item.seconds || 0),
          interrupted: item.meta.phase !== "saved",
        }));
    } catch {
      return [];
    }
  }

  refreshRecoveries({ emit = true } = {}) {
    this.pendingRecoveries = this.scanRecoveries();
    this.state.pendingRecoveries = this.pendingRecoveries.length;
    if (emit) this.emit();
  }

  async recoverRecording(dir) {
    const item = this.pendingRecoveries.find((entry) => entry.dir === dir);
    if (!item) throw new Error("找不到待恢复的录音");
    if (item.meta?.phase !== "saved") finalizeInterrupted(dir);
    const repaired = recover(this.recordingRoot).find((entry) => entry.dir === dir);
    if (!repaired) throw new Error("恢复后无法读取录音文件");
    if (repaired.meta.realtimeEnabled) {
      const meeting = await meetingStore.getMeeting(repaired.meta.docId);
      const gaps = Array.isArray(repaired.meta.realtimeGaps) ? [...repaired.meta.realtimeGaps] : [];
      const through = Number(repaired.meta.realtimeThroughMs || 0);
      const endMs = repaired.seconds * 1000;
      if (endMs > through) {
        for (let channel = 0; channel < repaired.meta.channels; channel++) {
          gaps.push({ startMs: through, endMs, channel });
        }
      }
      await this.plugin.transcription.onRealtime(meeting, repaired.meta.recordingId, {
        meta: repaired.meta, gaps, status: "incomplete", final: true,
        error: "录音曾中断，转写可能不完整；请检查后手动补齐。",
      }).catch(() => {
        this.state.realtimeNotice = "已保留录音，转写恢复未完成；请手动重新转写。";
      });
    }
    const result = await this.archiveSegment({
      file: repaired.file,
      meta: { ...repaired.meta, interrupted: Boolean(item.interrupted) },
      seconds: repaired.seconds,
      events: repaired.meta.events || [],
      meetingDocId: repaired.meta.docId,
    });
    this.refreshRecoveries({ emit: false });
    if (!this.isBusy() && this.state.phase !== "saving") {
      this.state.phase = "saved";
      this.state.savedAt = Date.now();
      this.state.lastSaved = result;
      this.state.saveFailed = false;
      this.state.error = "";
      this.state.notice = "";
      this.systemNotice = "";
      clearTimeout(this.savedTimer);
      this.savedTimer = setTimeout(() => {
        if (this.state.phase === "saved") {
          this.state.phase = "idle";
          this.emit();
        }
      }, 3000);
    }
    this.emit();
    return result;
  }

  async dismissRecovery(dir) {
    this.dismissedRecoveries.add(dir);
    this.refreshRecoveries({ emit: false });
    this.emit();
  }

  // ---- floating bar -------------------------------------------------------

  ensureFloat() {
    if (this.floatWin && !this.floatWin.isDestroyed()) return this.floatWin;
    const { BrowserWindow } = remote;
    const win = new BrowserWindow({
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      width: FLOAT_WIDTH,
      height: FLOAT_HEIGHT,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.floatWin = win;
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    win.setIgnoreMouseEvents(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("did-finish-load", () => {
      if (this.floatShouldShow) this.showFloat();
      else this.updateFloat(this.snapshot());
    });
    win.on("close", (event) => {
      event.preventDefault();
      win.hide();
    });
    win.on("moved", () => {
      this.floatMoved = true;
    });
    const dataDir = window.siyuan?.config?.system?.dataDir || "";
    const page = pathToFileURL(path.join(dataDir, "plugins", this.plugin.name, "float", "index.html")).href;
    win.loadURL(`${page}?channel=${encodeURIComponent(this.channel)}`);
    return win;
  }

  isDark() {
    const appearance = window.siyuan?.config?.appearance;
    if (!appearance) return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
    if (appearance.modeOS) return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
    return Number(appearance.mode) === 1;
  }

  showFloat() {
    const win = this.ensureFloat();
    this.floatShouldShow = true;
    if (win.webContents.isLoading()) return;
    if (!win.isVisible()) {
      if (!this.floatMoved) this.positionFloat(true);
      win.showInactive();
    }
    win.setIgnoreMouseEvents(false);
    this.updateFloat(this.snapshot());
  }

  hideFloat() {
    this.floatShouldShow = false;
    if (this.floatWin && !this.floatWin.isDestroyed()) this.floatWin.hide();
  }

  positionFloat(defaultPosition = false) {
    const win = this.floatWin;
    if (!win || win.isDestroyed()) return;
    const { screen } = remote;
    let display;
    try {
      display = screen.getDisplayMatching(remote.getCurrentWindow().getBounds());
    } catch {
      display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    const work = display.workArea;
    const bounds = win.getBounds();
    const width = bounds.width || FLOAT_WIDTH;
    const height = bounds.height || FLOAT_HEIGHT;
    let x = bounds.x;
    let y = bounds.y;
    if (defaultPosition || !this.floatMoved) {
      x = Math.round(work.x + (work.width - width) / 2);
      // Anarlog anchors the whole window (including the reserved handle area)
      // SCREEN_MARGIN above the work area bottom.
      y = Math.round(work.y + work.height - height - FLOAT_SCREEN_MARGIN);
    }
    x = clamp(x, work.x, work.x + work.width - width);
    y = clamp(y, work.y, work.y + work.height - height);
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  }

  updateFloat(snapshot) {
    if (!this.floatWin || this.floatWin.isDestroyed()) return;
    const levels = snapshot.levels || [0, 0];
    this.floatWin.webContents.send(this.channel, {
      phase: snapshot.phase,
      elapsedMs: snapshot.elapsedMs,
      levels,
      error: snapshot.error,
      needsAttention: snapshot.needsAttention,
      saveFailed: snapshot.saveFailed,
      dark: this.isDark(),
      opacity: this.prefs.opacity,
    });
  }

  onFloatMessage(message) {
    if (!message) return;
    if (message.type === "hide") {
      this.hideFloat();
    } else if (message.type === "open") {
      this.openCurrentMeeting();
    } else if (message.type === "pause") {
      void this.pause();
    } else if (message.type === "resume") {
      void this.resume();
    } else if (message.type === "stop") {
      void this.stop();
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.floatTimer);
    clearTimeout(this.savedTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.devicesTimer);
    clearTimeout(this.stopTimer);
    if (this.capture && !this.capture.isDestroyed()) {
      if (this.state.phase === "recording" || this.state.phase === "paused" || this.state.phase === "preparing") {
        try {
          await this.execCapture("window.meetingStop()");
        } catch {
          // the continuously written file remains recoverable
        }
        await this.realtimeWrite;
        if (this.savingPromise) await this.savingPromise;
      }
      if (!this.capture.isDestroyed()) this.capture.destroy();
    }
    if (this.floatWin && !this.floatWin.isDestroyed()) this.floatWin.destroy();
    remote.ipcMain.removeListener(this.channel, this.ipcListener);
    remote.screen.removeListener("display-removed", this.onDisplayChange);
    remote.screen.removeListener("display-metrics-changed", this.onDisplayChange);
    try {
      this.powerMonitor?.removeListener?.("suspend", this.onPowerSuspend);
      this.powerMonitor?.removeListener?.("resume", this.onPowerResume);
    } catch {
      // powerMonitor may be unavailable
    }
    if (this.isolated) {
      try {
        this.isolated.setDisplayMediaRequestHandler(null);
        this.isolated.setPermissionCheckHandler(null);
        this.isolated.setPermissionRequestHandler(null);
      } catch {
        // session may already be destroyed
      }
    }
  }
}

module.exports = { MeetingController, ACTIVE_PHASES };
