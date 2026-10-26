"use strict";

const { ipcRenderer } = require("electron");
const channel = new URLSearchParams(location.search).get("channel");
const body = document.body;
const envelope = document.getElementById("envelope");
const stop = document.getElementById("stop");
const stopContent = document.getElementById("stop-content");
const timer = document.getElementById("timer");
const pause = document.getElementById("pause");
const open = document.getElementById("open");
const message = document.getElementById("message");
const captions = document.getElementById("captions");
const captionToggle = document.getElementById("caption-toggle");
const STICK_COUNT = 5;
const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';
const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.2c0-.8.9-1.3 1.6-.9l7 4.8c.6.4.6 1.3 0 1.7l-7 4.8c-.7.5-1.6 0-1.6-.9V3.2Z" fill="currentColor"/></svg>';
const OPEN_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.8 8.2M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CAPTION_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 7h4M10 7h1.5M4.5 9.8h1.5M7.5 9.8h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const WARNING_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.8v4.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="13.9" r="0.9" fill="currentColor"/></svg>';

let state = {
  phase: "idle",
  elapsedMs: 0,
  levels: [0, 0],
  error: "",
  needsAttention: "",
  dark: false,
  opacity: 0.9,
  saveFailed: false,
  captions: { available: false, visible: false, online: false, notice: "" },
};
// Captions are display-only: the last few final sentences plus each audio
// channel's sentence still being recognised.
let finals = [];
let interim = new Map();
let stickParams = [];
let stopMode = "";
let stopPaused = false;
let sticksElement = null;

function mulberry32(seed) {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStickParams() {
  const mid = (STICK_COUNT - 1) / 2;
  stickParams = [];
  for (let index = 0; index < STICK_COUNT; index++) {
    const distance = Math.abs(index - mid) / mid;
    const base = 50 + 50 * (1 - distance);
    const random = mulberry32((index + 1) * 10007);
    const speed = 4 + random() * 3;
    const phase = random() * Math.PI * 2;
    const duration = (Math.PI * 2) / speed;
    const delay = -(phase / (Math.PI * 2)) * duration;
    stickParams.push({ maxScale: Math.max(0.25, Math.min(1, base / 100)), duration, delay });
  }
}

function renderStopContent(amplitude, { flat = false, warning = false, paused = false } = {}) {
  const mode = warning ? "warning" : flat || amplitude <= 0 ? "flat" : "sticks";
  const clamped = Math.max(0, Math.min(1, amplitude));
  const scale = 0.2 + 0.8 * clamped;

  // Rebuilding the sticks every second would restart their CSS animation.
  // Only switch the DOM on a mode change; otherwise just update the envelope.
  if (mode !== stopMode || (mode === "flat" && paused !== stopPaused)) {
    stopMode = mode;
    stopPaused = paused;
    sticksElement = null;
    if (mode === "warning") {
      stopContent.innerHTML = `<span class="warning" aria-hidden="true">${WARNING_ICON}</span>`;
      return;
    }
    if (mode === "flat") {
      stopContent.innerHTML = `<div class="sticks is-flat${paused ? " is-paused" : ""}"><div class="flat-line"></div></div>`;
      return;
    }
    const slots = stickParams
      .map(
        (item) =>
          `<div class="stick-slot" style="transform:scaleY(${item.maxScale})"><div class="stick" style="animation-duration:${item.duration.toFixed(2)}s;animation-delay:${item.delay.toFixed(2)}s"></div></div>`,
      )
      .join("");
    stopContent.innerHTML = `<div class="sticks" style="transform:scaleY(${scale.toFixed(3)})">${slots}</div>`;
    sticksElement = stopContent.querySelector(".sticks");
    return;
  }

  if (mode === "sticks" && sticksElement) {
    sticksElement.style.transform = `scaleY(${scale.toFixed(3)})`;
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function applyColors() {
  const opacity = Math.min(0.95, Math.max(0.35, Number(state.opacity) || 0.9));
  const dark = Boolean(state.dark);
  const content = dark ? "rgb(255, 255, 255)" : "rgb(31, 28, 26)";
  const rgb = dark ? "110, 112, 102" : "219, 217, 209";
  const root = document.documentElement.style;
  root.setProperty("--bar-surface", `rgba(${rgb}, ${opacity * 0.82})`);
  root.setProperty("--bar-envelope-surface", `rgba(${rgb}, ${Math.min(opacity * 1.08, 0.95)})`);
  root.setProperty("--bar-content", content);
  root.setProperty("--bar-handle", dark ? "rgba(255, 255, 255, 0.48)" : "rgba(31, 28, 26, 0.36)");
  root.setProperty("--bar-stroke", dark ? "rgba(255, 255, 255, 0.14)" : "rgba(31, 28, 26, 0.12)");
  root.setProperty("--bar-control-fill", dark ? "rgba(255, 255, 255, 0.08)" : "rgba(31, 28, 26, 0.07)");
  root.setProperty("--bar-control-fill-strong", dark ? "rgba(255, 255, 255, 0.14)" : "rgba(31, 28, 26, 0.12)");
  root.setProperty("--bar-accent", "rgb(255, 51, 77)");
  root.setProperty("--bar-error", "rgb(255, 64, 61)");
}

function renderCaptions() {
  const { available, visible, notice } = state.captions || {};
  body.classList.toggle("has-caption-toggle", Boolean(available));
  body.classList.toggle("has-captions", Boolean(visible));
  captionToggle.hidden = !available;
  const label = visible ? "隐藏字幕" : "显示字幕";
  captionToggle.setAttribute("aria-label", label);
  captionToggle.title = label;
  captionToggle.setAttribute("aria-pressed", visible ? "true" : "false");
  if (!available) {
    finals = [];
    interim = new Map();
  }
  if (!visible) {
    captions.replaceChildren();
    return;
  }
  const lines = [...finals, ...[...interim.keys()].sort().map((key) => ({ ...interim.get(key), pending: true }))];
  if (!lines.length) {
    const line = document.createElement("p");
    line.className = "caption is-pending";
    line.textContent = notice || "正在聆听…";
    captions.replaceChildren(line);
    return;
  }
  captions.replaceChildren(...lines.map((item) => {
    const line = document.createElement("p");
    line.className = item.pending ? "caption is-pending" : "caption";
    line.textContent = item.label ? `${item.label}：${item.text}` : item.text;
    return line;
  }));
}

function onCaption(caption) {
  if (!state.captions?.available) return;
  const key = Number(caption.channel) || 0;
  interim.delete(key);
  if (caption.final) {
    if (caption.text) finals = [...finals, { label: caption.label, text: caption.text }].slice(-3);
  } else if (caption.text) {
    interim.set(key, { label: caption.label, text: caption.text });
  }
  renderCaptions();
}

function render() {
  const phase = state.phase || "idle";
  renderCaptions();
  body.dataset.phase = phase;
  applyColors();
  body.classList.toggle("is-saving", phase === "saving");
  body.classList.toggle("is-saved", phase === "saved");
  body.classList.toggle("is-save-failed", Boolean(state.saveFailed));

  if (phase === "saving") {
    message.replaceChildren(document.createTextNode("正在保存…"));
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = "隐藏";
    hide.title = "隐藏浮条；归档仍会继续";
    hide.onclick = () => ipcRenderer.send(channel, { type: "hide" });
    message.append(hide);
    return;
  }
  if (phase === "saved") {
    message.replaceChildren(document.createTextNode("✓ 已保存"));
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = "隐藏";
    hide.title = "隐藏浮条";
    hide.onclick = () => ipcRenderer.send(channel, { type: "hide" });
    message.append(hide);
    return;
  }
  if (state.saveFailed) {
    message.replaceChildren(document.createTextNode("保存失败"));
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "打开会议";
    button.onclick = () => ipcRenderer.send(channel, { type: "open" });
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = "隐藏";
    hide.title = "隐藏浮条；录音仍保存在本机，可在会议页重试归档";
    hide.onclick = () => ipcRenderer.send(channel, { type: "hide" });
    message.append(button, hide);
    return;
  }

  timer.textContent = formatDuration(state.elapsedMs);
  const warning = phase === "error" || Boolean(state.needsAttention);
  const amplitude =
    phase === "recording"
      ? Math.min(1, Math.hypot(Number(state.levels?.[0] || 0), Number(state.levels?.[1] || 0)) * 6)
      : 0;
  renderStopContent(amplitude, {
    flat: phase !== "recording",
    warning,
    paused: phase === "paused",
  });

  const paused = phase === "paused";
  if (pause.dataset.kind !== (paused ? "play" : "pause")) {
    pause.dataset.kind = paused ? "play" : "pause";
    pause.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  }
  const pauseLabel = paused ? "继续录音" : "暂停录音";
  pause.setAttribute("aria-label", pauseLabel);
  pause.title = pauseLabel;
  pause.disabled = !["recording", "paused"].includes(phase);
  stop.disabled = phase === "saving";
  stop.setAttribute(
    "aria-label",
    warning
      ? `${state.needsAttention || state.error || "录音需要处理"}；结束录音`
      : "结束录音",
  );
  stop.title = warning
    ? `${state.needsAttention || state.error || "录音需要处理"}；点击结束并保存，或打开会议查看。`
    : "结束录音";
}

envelope.addEventListener("mouseenter", () => body.classList.add("is-hovered"));
envelope.addEventListener("mouseleave", () => body.classList.remove("is-hovered"));

pause.addEventListener("click", () => {
  ipcRenderer.send(channel, { type: state.phase === "paused" ? "resume" : "pause" });
});
stop.addEventListener("click", () => {
  ipcRenderer.send(channel, { type: "stop" });
});
open.addEventListener("click", () => ipcRenderer.send(channel, { type: "open" }));
captionToggle.addEventListener("click", () => {
  ipcRenderer.send(channel, { type: "captions", visible: !state.captions?.visible });
});

ipcRenderer.on(channel, (_, next) => {
  if (next?.caption) {
    onCaption(next.caption);
    return;
  }
  state = { ...state, ...(next || {}) };
  render();
});

buildStickParams();
open.innerHTML = OPEN_ICON;
captionToggle.innerHTML = CAPTION_ICON;
render();
