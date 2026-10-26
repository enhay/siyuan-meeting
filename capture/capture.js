"use strict";

const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { RecordingStore } = require("./storage.cjs");

const channel = new URLSearchParams(location.search).get("channel");
const CAPTURE_RATE = 16000;
const SIGNAL_TIMEOUT = 15000;

let phase = "idle";
let store = null;
let context = null;
let processor = null;
let streams = [];
let sources = [];
let online = false;
let busy = false;
let nextWallStart = 0;
let flushResolve = null;
let signalTimer = null;
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
  errorMessage = error?.message || String(error);
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
        throw new Error("电脑声音没有音轨；线上模式不会降级为仅麦克风。请检查系统音频权限。");
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
  clearTimeout(signalTimer);
  signalTimer = null;
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
      `当前设备无法以 ${CAPTURE_RATE} Hz 打开音频（实际 ${context.sampleRate} Hz）。请检查系统音频设备，避免录制无法直接交给腾讯云识别的文件。`,
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
  if (store.meta.channels !== channels) {
    throw new Error("录音声道数发生变化，请结束本段后重新开始");
  }
  if (store.meta.sampleRate !== context.sampleRate) {
    throw new Error("采样率发生变化，请结束本段后重新开始");
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
  cleared = [false, !online];

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
    if (!data.samples) return;
    try {
      store.append(data.samples, nextWallStart, [data.rms?.[0] || 0, data.rms?.[1] || 0]);
      processor.port.postMessage("ack");
      nextWallStart += (data.frames / context.sampleRate) * 1000;
      lastLevels = [data.rms?.[0] || 0, data.rms?.[1] || 0];
      lastPeaks = [data.peaks?.[0] || 0, data.peaks?.[1] || 0];
      if (lastPeaks[0] > 0) cleared[0] = true;
      if (lastPeaks[1] > 0) cleared[1] = true;
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
      if (phase === "preparing" && cleared.every(Boolean)) {
        clearTimeout(signalTimer);
        signalTimer = null;
        phase = "recording";
        store.phase("recording");
        if (options.meta?.segmentNo === 0 && !options.meta?.resumed) {
          store.addEvent({ type: "start" });
        }
      }
      sendState();
    } catch (error) {
      fail(error);
    }
  };

  clearTimeout(signalTimer);
  signalTimer = setTimeout(() => {
    if (!cleared.every(Boolean)) {
      stopTracks();
      fail(
        new Error(
          `未检测到${!cleared[0] ? "麦克风" : "电脑声音"}的真实信号，已停止采集。请检查设备后重新开始；不能把“有音轨”当作采集成功。`,
        ),
      );
    }
  }, SIGNAL_TIMEOUT);
}

let cleared = [false, false];

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
      phase = "paused";
      await disconnect();
      store.addEvent({ type: "pause", elapsedMs: elapsedMs() });
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

send({ type: "ready" });
