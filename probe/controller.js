const { ipcRenderer } = require("electron");
const { pathToFileURL } = require("url");
const fs = require("fs");
const path = require("path");
const { RecordingStore, recover, finalizeInterrupted } = require("./storage.cjs");
const params = new URLSearchParams(location.search);
const channel = params.get("channel");
const root = params.get("storage");
const $ = id => document.getElementById(id);
let phase = "idle", store, context, processor, streams = [], sources = [];
let online, busy = false, nextWallStart, flushResolve, signalTimer;
let seen = [false, false];
let operation;
const labels = { idle: "未开始", preparing: "请播放合成声音并对麦克风试音", recording: "录音中",
  paused: "已暂停", saving: "正在保存", saved: "已保存至本机（尚未归档到思源）", error: "需要处理" };

function update() {
  const seconds = store ? store.meta.frames / store.meta.sampleRate : 0;
  const time = new Date(seconds * 1000).toISOString().slice(11, 19);
  const label = labels[phase] + " · " + time;
  $("status").textContent = label;
  $("status").dataset.state = phase;
  $("start").disabled = busy || (store && !["idle", "saved"].includes(phase));
  $("pause").disabled = busy || !["recording", "paused"].includes(phase);
  $("pause").textContent = phase === "paused" ? "继续" : "暂停";
  $("stop").disabled = busy || !store || ["idle", "saved"].includes(phase);
  $("online").disabled = $("microphone").disabled = busy || (store && !["idle", "saved"].includes(phase));
  $("saved").textContent = store ? `已持久保存 ${seconds.toFixed(1)} 秒 · ${store.dir}` : "";
  ipcRenderer.send(channel, { type: "state", phase, label });
}

function fail(error) {
  $("error").textContent = error.message;
  phase = "error";
  update();
}

async function devices() {
  const selected = $("microphone").value;
  const list = await navigator.mediaDevices.enumerateDevices();
  $("microphone").replaceChildren(new Option("系统默认麦克风", ""));
  list.filter(device => device.kind === "audioinput").forEach((device, index) =>
    $("microphone").add(new Option(device.label || `麦克风 ${index + 1}`, device.deviceId)));
  $("microphone").value = selected;
}

async function openStreams() {
  // Request display capture directly in the user's click, before awaiting microphone access.
  if (online) {
    const system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    streams.push(system);
    if (!system.getAudioTracks().length) throw new Error("电脑声音没有音轨；不能降级为仅麦克风");
  }
  const deviceId = $("microphone").value;
  const mic = await navigator.mediaDevices.getUserMedia({ audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  } });
  streams.unshift(mic);
  for (const [index, stream] of streams.entries()) {
    stream.getAudioTracks().forEach(track => {
      track.onended = () => fail(new Error(`${index ? "电脑声音" : "麦克风"}已断开，其他已打开的音轨仍在保存；请结束后重新开始`));
      track.onmute = () => { $("error").textContent = `${index ? "电脑声音" : "麦克风"}暂时无数据，请检查设备`; };
    });
  }
}

async function connect() {
  context = new AudioContext({ sampleRate: 48000 });
  await context.audioWorklet.addModule("pcm-worklet.js");
  await context.resume();
  const channels = online ? 2 : 1;
  if (!store) store = new RecordingStore(root, context.sampleRate, channels);
  if (store.meta.sampleRate !== context.sampleRate) throw new Error("采样率发生变化，请结束本段后重新开始");
  const merger = context.createChannelMerger(channels);
  sources = streams.map((stream, index) => {
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    source.connect(merger, 0, index);
    return source;
  });
  processor = new AudioWorkletNode(context, "pcm-capture", { numberOfInputs: 1,
    numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { channels } });
  const mute = context.createGain();
  mute.gain.value = 0;
  merger.connect(processor); processor.connect(mute); mute.connect(context.destination);
  nextWallStart = Date.now();
  seen = [false, !online];
  processor.port.onmessage = ({ data }) => {
    if (data.flushed) { flushResolve?.(); flushResolve = undefined; return; }
    if (data.error) {
      stopTracks(); void context.suspend(); fail(new Error(data.error)); return;
    }
    if (!data.samples || phase === "saved") return;
    try {
      store.append(data.samples, nextWallStart);
      processor.port.postMessage("ack");
      nextWallStart += data.samples.length / channels / context.sampleRate * 1000;
      data.peaks.forEach((peak, index) => { if (peak > 0) seen[index] = true; });
      $("micLevel").value = data.peaks[0]; $("systemLevel").value = data.peaks[1];
      if (seen.every(Boolean) && phase === "preparing") {
        clearTimeout(signalTimer); phase = "recording";
      }
      update();
    } catch (error) {
      // Continuing after a disk error would accumulate an unbounded queue of unsaved audio.
      stopTracks();
      void context.suspend();
      fail(error);
    }
  };
  signalTimer = setTimeout(() => {
    if (!seen.every(Boolean)) {
      stopTracks();
      void context.suspend();
      fail(new Error(`未检测到${!seen[0] ? "麦克风" : "电脑声音"}真实信号，已停止采集。请结束本段并检查设备；不能把有音轨视为采集成功。`));
    }
  }, 15000);
}

function stopTracks() {
  clearTimeout(signalTimer);
  for (const stream of streams) for (const track of stream.getTracks()) {
    track.onended = null; track.onmute = null; track.stop();
  }
  streams = [];
}

async function disconnect() {
  stopTracks();
  if (!context) return;
  if (processor) {
    sources.forEach(source => source.disconnect());
    await context.resume();
    await new Promise(resolve => { flushResolve = resolve; processor.port.postMessage("flush"); });
    processor.disconnect();
  }
  await context.close();
  context = processor = undefined;
  sources = [];
}

function act(action) {
  if (busy) return operation;
  operation = perform(action);
  return operation;
}

async function perform(action) {
  if (busy) return;
  busy = true;
  try {
    if (action === "start" && (!store || ["idle", "saved"].includes(phase))) {
      store = undefined; online = $("online").checked; phase = "preparing";
      $("error").textContent = ""; update();
      await openStreams(); await connect();
    } else if (action === "pause" && phase === "recording") {
      await disconnect(); store.phase("paused"); phase = "paused";
    } else if (action === "resume" && phase === "paused") {
      phase = "preparing"; update(); await openStreams(); await connect(); store.phase("recording");
    } else if (action === "stop" && store && phase !== "saved") {
      phase = "saving"; update(); await disconnect(); store.phase("saved"); phase = "saved"; renderSaved();
    }
  } catch (error) {
    stopTracks();
    if (context) { await context.close(); context = processor = undefined; }
    fail(error);
  } finally { busy = false; update(); }
}

function renderSaved() {
  $("recordings").replaceChildren();
  for (const item of recover(root)) {
    const section = document.createElement("section");
    const description = document.createElement("p");
    description.textContent = item.error ? `${item.dir}：${item.error}` :
      `${item.meta.startedAt} · ${item.seconds.toFixed(1)} 秒 · ${item.meta.phase === "saved" ? "已保存" : "中断或尚未结束，可回听已写入部分"}`;
    section.append(description);
    if (!item.error && item.meta.phase === "saved") {
      const player = document.createElement("audio"); player.controls = true;
      player.src = pathToFileURL(item.file).href;
      section.append(player);
    } else if (!item.error && item.dir !== store?.dir) {
      const button = document.createElement("button");
      button.textContent = "恢复已保存的音频";
      button.onclick = () => {
        try { finalizeInterrupted(item.dir); renderSaved(); }
        catch (error) { $("error").textContent = error.message; }
      };
      section.append(button);
    }
    $("recordings").append(section);
  }
}

$("start").onclick = () => act("start");
$("pause").onclick = () => act(phase === "paused" ? "resume" : "pause");
$("stop").onclick = () => act("stop");
$("devices").onclick = () => devices().catch(fail);
$("refresh").onclick = renderSaved;
ipcRenderer.on(channel, (_, message) => {
  if (message.type === "error") fail(new Error(message.message));
  else if (["pause", "resume", "stop"].includes(message.type)) void act(message.type);
});
window.finishRecording = async () => { await operation; await act("stop"); };
window.resumeRecording = () => act("resume");
navigator.mediaDevices.addEventListener("devicechange", () => {
  if (["recording", "preparing"].includes(phase)) $("error").textContent = "设备列表已变化，请确认两路声音仍正常";
});
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "host.json"), JSON.stringify({ versions: process.versions,
  platform: process.platform, checkedAt: new Date().toISOString(),
  mediaDevices: !!navigator.mediaDevices, audioWorklet: !!window.AudioWorkletNode }, null, 2));
renderSaved(); update(); void devices().catch(fail);
