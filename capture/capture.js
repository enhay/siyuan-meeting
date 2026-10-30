"use strict";

const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { RecordingStore } = require("./storage.cjs");
const { RealtimeTranscriber } = require("./realtime.cjs");
const crypto = require("node:crypto");

const channel = new URLSearchParams(location.search).get("channel");
const CAPTURE_RATE = 16000;
const SAMPLE_TIMEOUT = 15000;

let phase = "idle";
let store = null;
let realtime = null;
const signRequests = new Map();
let context = null;
let processor = null;
let streams = [];
let sources = [];
let online = false;
let busy = false;
let nextWallStart = 0;
let flushResolve = null;
let sampleTimer = null;
let operation = null;
let pendingAction = null;
let options = null;
let lastLevels = [0, 0];
let lastPeaks = [0, 0];
let errorMessage = "";
let needsAttention = "";
let noticeMessage = "";
let silentSystemChunks = 0;
const ended = [false, false];

function send(message) {
  ipcRenderer.send(channel, message);
}

function requestRealtimeUrl(audioChannel) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      signRequests.delete(requestId);
      reject(new Error("实时转写连接未能建立"));
    }, 6000);
    signRequests.set(requestId, { resolve, reject, timer });
    send({ type: "realtime-sign", requestId, recordingId: store?.recordingId, audioChannel });
  });
}

ipcRenderer.on(channel, (_event, message) => {
  if (message?.type === "realtime-persisted") {
    if (!store || message.recordingId !== store.recordingId) return;
    const throughMs = Number(message.throughMs);
    if (!Number.isFinite(throughMs) || throughMs < Number(store.meta.realtimeThroughMs || 0) ||
        throughMs > elapsedMs() || !Array.isArray(message.gaps)) return;
    store.meta.realtimeGaps = message.gaps;
    store.meta.realtimeStatus = message.status;
    store.meta.realtimeError = message.error || "";
    store.meta.realtimeThroughMs = throughMs;
    // The next audio append or phase change persists this acknowledgment.
    // Do not overwrite the host's archive marker after the audio file closes.
    return;
  }
  if (message?.type === "realtime-rejected") {
    if (store && message.recordingId === store.recordingId) realtime?.reject(String(message.error || ""));
    return;
  }
  if (message?.type !== "realtime-signed") return;
  const pending = signRequests.get(message.requestId);
  if (!pending) return;
  signRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.url) pending.resolve(message.url);
  else pending.reject(new Error("实时转写连接未能建立"));
});

function realtimeUpdate(update) {
  if (!store) return;
  send({ type: "realtime", recordingId: store.recordingId, throughMs: elapsedMs(), meta: {
    recordingId: store.recordingId, startedAt: store.meta.startedAt,
    segmentNo: store.meta.segmentNo, sampleRate: store.meta.sampleRate,
    channels: store.meta.channels, realtimeEnabled: store.meta.realtimeEnabled,
    hotwords: store.meta.hotwords,
  }, ...update });
}

function elapsedMs() {
  return store ? (store.meta.frames / store.meta.sampleRate) * 1000 : 0;
}

function sendState() {
  send({
    type: "state",
    phase,
    elapsedMs: elapsedMs(),
    levels: lastLevels,
    peaks: lastPeaks,
    error: errorMessage,
    needsAttention,
    notice: noticeMessage,
    hasStore: Boolean(store),
    hasFrames: Boolean(store && store.meta.frames > 0),
    recordingId: store?.recordingId || "",
  });
}

function fail(error, { keepStore = true } = {}) {
  const reasons = {
    ENOSPC: "磁盘空间不足，录音已停止；请腾出空间后保存已录部分",
    EACCES: "无法写入录音文件，请检查文件夹权限后保存已录部分",
    EPERM: "无法写入录音文件，请检查文件夹权限后保存已录部分",
    NotAllowedError: process.platform === "darwin"
      ? "录音权限未获允许，请在 macOS 系统设置的隐私与安全性中允许思源访问麦克风；线上录音还需要屏幕与系统音频录制权限。授权后重新打开思源再试。"
      : "录音权限未获允许，请在系统设置中允许麦克风和电脑声音访问后重试",
    NotFoundError: "找不到录音设备，请连接麦克风后重试",
    NotReadableError: "无法读取录音设备，请检查设备是否被占用后重试",
  };
  errorMessage = reasons[error?.code] || reasons[error?.name] ||
    (error?.code || error?.name && error.name !== "Error"
      ? "录音未能继续，请检查设备和可用磁盘空间；已保存的部分仍可恢复"
      : error?.message || "录音未能继续，已保存的部分仍可恢复");
  realtime?.abort();
  stopTracks();
  if (context) {
    void context.close().catch(() => {});
    context = null;
    processor = null;
    sources = [];
  }
  if (!keepStore || !store) {
    phase = "error";
  } else {
    phase = errorMessage ? "error" : phase;
    if (store.meta.frames > 0) {
      try {
        store.addEvent({ type: "error", message: errorMessage });
      } catch {
        // the local file is still the source of truth
      }
    }
  }
  sendState();
}

async function devices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  let index = 0;
  return list
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || `麦克风 ${++index}`,
    }));
}

async function openStreams() {
  const next = [];
  try {
    if (online) {
      // Called directly from the click / executeJavaScript user gesture. Do not
      // await anything before getDisplayMedia.
      const system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!system.getAudioTracks().length) {
        for (const track of system.getTracks()) track.stop();
        throw new Error("无法录制电脑声音，请检查系统权限后重试。");
      }
      for (const video of system.getVideoTracks()) video.stop();
      next.push(system);
    }
    const deviceId = options?.deviceId || "";
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    next.unshift(mic);

    for (const [index, stream] of next.entries()) {
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          ended[index] = true;
          const name = index === 0 ? "麦克风" : "电脑声音";
          needsAttention = `${name}已断开；另一路仍在保存，可重新连接或结束录音`;
          sendState();
          if (ended[0] && (ended[1] || !online)) {
            fail(new Error("所有声音输入都已断开，请结束录音以保存已录部分"), { keepStore: true });
          }
        };
        track.onmute = () => {
          needsAttention = `${index === 0 ? "麦克风" : "电脑声音"}暂时无数据，请检查设备`;
          sendState();
        };
        track.onunmute = () => {
          needsAttention = "";
          sendState();
        };
      }
    }
    streams = next;
    ended.fill(false);
  } catch (error) {
    for (const stream of next) {
      for (const track of stream.getTracks()) track.stop();
    }
    throw error;
  }
}

function stopTracks() {
  clearTimeout(sampleTimer);
  sampleTimer = null;
  for (const stream of streams) {
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    }
  }
  streams = [];
}

async function connect() {
  context = new AudioContext({ sampleRate: CAPTURE_RATE, latencyHint: "interactive" });
  await context.audioWorklet.addModule("pcm-worklet.js");
  await context.resume();
  if (context.sampleRate !== CAPTURE_RATE) {
    throw new Error(
      "当前设备无法按会议录音要求采集声音，请更换麦克风或检查系统声音设置。",
    );
  }
  try {
    fs.mkdirSync(options.storage, { recursive: true });
    fs.writeFileSync(
      path.join(options.storage, "host.json"),
      JSON.stringify(
        {
          versions: process.versions,
          platform: process.platform,
          checkedAt: new Date().toISOString(),
          sampleRate: context.sampleRate,
          channels: online ? 2 : 1,
          mediaDevices: Boolean(navigator.mediaDevices),
          audioWorklet: Boolean(window.AudioWorkletNode),
        },
        null,
        2,
      ),
    );
  } catch {
    // diagnostics are best effort and must never block recording
  }
  const channels = online ? 2 : 1;
  if (!store) {
    store = new RecordingStore({
      root: options.storage,
      sampleRate: context.sampleRate,
      channels,
      meta: { ...options.meta, startedAt: new Date().toISOString() },
    });
  }
  if (!realtime) {
    store.meta.realtimeEnabled = Boolean(options.realtime?.enabled);
    store.meta.realtimeGaps = [];
    store.meta.realtimeStatus = store.meta.realtimeEnabled ? "incomplete" : "none";
    store.meta.realtimeError = "";
    store.meta.realtimeThroughMs = 0;
    realtime = new RealtimeTranscriber({
      service: options.realtime?.service, sampleRate: store.meta.sampleRate, channels,
      enabled: Boolean(options.realtime?.enabled), configured: Boolean(options.realtime?.configured),
      engine: options.realtime?.engine, requestUrl: requestRealtimeUrl, emit: realtimeUpdate,
      corpus: options.realtime?.corpus,
      caption: (caption) => send({ type: "realtime-caption", recordingId: store?.recordingId, ...caption }),
    });
    realtime.report();
    store.save();
  } else {
    realtime.resume();
  }
  if (store.meta.channels !== channels) {
    throw new Error("录音设备的声音输入发生变化，请结束本段后重新开始");
  }
  if (store.meta.sampleRate !== context.sampleRate) {
    throw new Error("录音设备的声音设置发生变化，请结束本段后重新开始");
  }

  const merger = context.createChannelMerger(channels);
  sources = streams.map((stream, index) => {
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    source.connect(merger, 0, index);
    return source;
  });
  processor = new AudioWorkletNode(context, "pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { channels },
  });
  const mute = context.createGain();
  mute.gain.value = 0;
  merger.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  nextWallStart = Date.now();

  processor.port.onmessage = ({ data }) => {
    if (data.flushed || data.flushedEmpty) {
      flushResolve?.();
      flushResolve = null;
      return;
    }
    if (data.error) {
      fail(new Error(data.error));
      return;
    }
    if (!data.samples?.length) return;
    try {
      const audioStartMs = elapsedMs();
      store.append(data.samples, nextWallStart, [data.rms?.[0] || 0, data.rms?.[1] || 0]);
      // Network availability never owns recording or local-save success.
      try { realtime?.push(data.samples, audioStartMs); } catch {
        realtime?.abort();
      }
      processor.port.postMessage("ack");
      nextWallStart += (data.frames / context.sampleRate) * 1000;
      lastLevels = [data.rms?.[0] || 0, data.rms?.[1] || 0];
      lastPeaks = [data.peaks?.[0] || 0, data.peaks?.[1] || 0];
      // Silent PCM is valid recording data; startup must not wait for speech.
      if (phase === "preparing") {
        clearTimeout(sampleTimer);
        sampleTimer = null;
        phase = "recording";
        store.phase("recording");
        if (options.meta?.segmentNo === 0 && !options.meta?.resumed) {
          store.addEvent({ type: "start" });
        }
      }
      if (online && phase === "recording") {
        const silentMessage = "电脑声音长时间无信号，请确认会议声音正在播放";
        if (lastLevels[1] < 0.0005) {
          silentSystemChunks++;
          if (silentSystemChunks === 60) {
            // A meeting naturally contains silence, so this is a notice, not
            // an error and not a transition into an error state (design §6.2).
            noticeMessage = silentMessage;
            sendState();
          }
          if (silentSystemChunks > 60) silentSystemChunks = 61;
        } else {
          silentSystemChunks = 0;
          if (noticeMessage === silentMessage) noticeMessage = "";
        }
      }
      sendState();
    } catch (error) {
      fail(error);
    }
  };

  clearTimeout(sampleTimer);
  sampleTimer = setTimeout(() => {
    if (phase === "preparing") {
      fail(new Error("未收到录音数据，已停止采集。请检查设备后重新开始。"));
    }
  }, SAMPLE_TIMEOUT);
}

async function disconnect() {
  stopTracks();
  if (!context) return;
  if (processor) {
    for (const source of sources) {
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
    }
    await context.resume().catch(() => {});
    await new Promise((resolve) => {
      flushResolve = resolve;
      processor.port.postMessage("flush");
      setTimeout(resolve, 2000);
    });
    try {
      processor.disconnect();
    } catch {
      // already disconnected
    }
  }
  await context.close().catch(() => {});
  context = null;
  processor = null;
  sources = [];
}

function act(action, nextOptions) {
  if (busy) {
    // A stop clicked while the microphone is still opening must run after the
    // start settles, not be dropped and leave the UI stuck in "saving".
    pendingAction = { action, options: nextOptions };
    return operation;
  }
  operation = perform(action, nextOptions);
  return operation;
}

async function perform(action, nextOptions) {
  if (busy) return;
  busy = true;
  try {
    if (action === "start") {
      if (store && !["saved", "idle"].includes(phase)) {
        throw new Error("已有录音段尚未结束");
      }
      options = { ...nextOptions, meta: { ...(nextOptions?.meta || {}) } };
      online = Boolean(options.online);
      realtime?.abort();
      realtime = null;
      store = null;
      lastLevels = [0, 0];
      lastPeaks = [0, 0];
      errorMessage = "";
      needsAttention = "";
      noticeMessage = "";
      silentSystemChunks = 0;
      phase = "preparing";
      sendState();
      await openStreams();
      await connect();
      sendState();
    } else if (action === "pause") {
      if (!["recording", "preparing"].includes(phase) || !store) return;
      const pauseStartedAt = new Date().toISOString();
      phase = "paused";
      lastLevels = [0, 0];
      sendState();
      await disconnect();
      store.addEvent({ type: "pause", elapsedMs: elapsedMs(), at: pauseStartedAt });
      await realtime?.pause();
      store.phase("paused");
      lastLevels = [0, 0];
      sendState();
    } else if (action === "resume") {
      if (phase !== "paused" || !store) return;
      phase = "preparing";
      errorMessage = "";
      noticeMessage = "";
      sendState();
      await openStreams();
      await connect();
      store.addEvent({ type: "resume", elapsedMs: elapsedMs() });
      store.phase("recording");
      sendState();
    } else if (action === "reconnect") {
      if (!["recording", "preparing", "paused"].includes(phase) || !store) return;
      const wasPaused = phase === "paused";
      phase = "preparing";
      needsAttention = "";
      noticeMessage = "";
      errorMessage = "";
      silentSystemChunks = 0;
      sendState();
      await disconnect();
      await realtime?.pause();
      if (wasPaused) {
        phase = "paused";
        sendState();
        return;
      }
      store.addEvent({ type: "gap", elapsedMs: elapsedMs() });
      await openStreams();
      await connect();
      store.addEvent({ type: "resume", elapsedMs: elapsedMs() });
      sendState();
    } else if (action === "stop") {
      if (!store || phase === "saved") {
        if (!store) {
          phase = "idle";
          sendState();
          send({ type: "empty" });
        }
        return;
      }
      phase = "saving";
      sendState();
      await disconnect();
      await realtime?.finish();
      store.addEvent({ type: "stop", elapsedMs: elapsedMs() });
      store.phase("saved");
      const seconds = store.meta.frames / store.meta.sampleRate;
      const points = store.writePeaks();
      phase = "saved";
      sendState();
      send({
        type: "saved",
        dir: store.dir,
        file: store.file,
        meta: store.meta,
        seconds,
        peaks: {
          version: 1,
          duration: seconds,
          channels: store.meta.channels,
          points,
        },
        events: store.meta.events,
      });
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    sendState();
    if (pendingAction) {
      const next = pendingAction;
      pendingAction = null;
      setTimeout(() => void act(next.action, next.options), 0);
    }
  }
}

window.meetingStart = (nextOptions) => act("start", nextOptions);
window.meetingPause = () => act("pause");
window.meetingResume = () => act("resume");
window.meetingStop = () => act("stop");
window.meetingReconnect = () => act("reconnect");
window.meetingDevices = () => devices().then((list) => send({ type: "devices", devices: list })).catch((error) => send({ type: "devices", devices: [], error: error.message }));

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (["recording", "preparing"].includes(phase)) {
    needsAttention = "设备列表已变化，请确认两路声音仍正常";
    sendState();
  }
});

window.addEventListener("beforeunload", () => {
  realtime?.abort();
  for (const pending of signRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("录音已结束"));
  }
  signRequests.clear();
});

send({ type: "ready" });
