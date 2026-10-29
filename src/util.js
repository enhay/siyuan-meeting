"use strict";

function randomUUID() {
  return globalThis.crypto.randomUUID();
}

const pad = (value, length = 2) => String(value).padStart(length, "0");

/** Format milliseconds as MM:SS, or H:MM:SS once the recording passes an hour. */
function formatDuration(ms, { alwaysHours = false } = {}) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours || alwaysHours
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function formatSeconds(seconds, options) {
  return formatDuration(Number(seconds || 0) * 1000, options);
}

function formatClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatClockSeconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDate(date)} ${formatClock(date)}`;
}

/** Default meeting title, matching the design: 会议 YYYY-MM-DD HH:mm. */
function defaultMeetingTitle(date = new Date()) {
  return `会议 ${formatDate(date)} ${formatClock(date)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escape a value for a SiYuan inline attribute list (IAL) entry. */
function escapeIal(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replace(/\r?\n/g, "&#10;");
}

function parseIal(ial) {
  const attributes = {};
  const source = String(ial || "");
  const pattern = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(source))) {
    attributes[match[1]] = match[2]
      .replaceAll("&quot;", '"')
      .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, digits) => {
        const value = digits[0].toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : Number(digits);
        return value <= 0x10ffff ? String.fromCodePoint(value) : entity;
      })
      .replaceAll("&amp;", "&");
  }
  return attributes;
}

function sha256(value) {
  return require("node:crypto").createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function debounce(fn, wait = 160) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shortId() {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

const BLOCK_ID_RE = /^\d{14}-[a-z0-9]{7}$/;

/** SiYuan block/document ids use the fixed timestamp-hash form. */
function isBlockId(value) {
  return BLOCK_ID_RE.test(String(value || ""));
}

/**
 * Assets returned by SiYuan must stay inside the assets namespace. Reject
 * file:// paths, absolute paths, quotes and traversal before they reach an
 * audio block or a file dialog.
 */
function isAssetPath(value) {
  const text = String(value || "");
  if (!text || text.includes("..") || text.includes("\\")) return false;
  if (/%2e|%2f|%5c/i.test(text)) return false;
  return /^assets\/[^"'<>\u0000]+\.(?:wav|mp3|m4a)(?:\?box=[A-Za-z0-9-]+)?$/i.test(text);
}

/** A single source of truth for the labels shown by every recording surface. */
const PHASE_LABELS = {
  idle: "未开始",
  preparing: "正在打开麦克风…",
  recording: "录音中",
  paused: "已暂停",
  saving: "正在保存…",
  saved: "已保存",
  error: "需要处理",
};

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || PHASE_LABELS.idle;
}

/** Compact bar wording, kept separate because the floating bar is tiny. */
function barPhaseLabel(phase) {
  if (phase === "preparing") return "正在打开…";
  if (phase === "recording") return "录音中";
  if (phase === "paused") return "已暂停";
  if (phase === "saving") return "正在保存…";
  if (phase === "saved") return "已保存";
  if (phase === "error") return "需要处理";
  return "";
}

module.exports = {
  randomUUID,
  pad,
  formatDuration,
  formatSeconds,
  formatClock,
  formatClockSeconds,
  formatDate,
  formatDateTime,
  defaultMeetingTitle,
  escapeHtml,
  escapeIal,
  parseIal,
  sha256,
  clamp,
  debounce,
  safeJson,
  shortId,
  sqlString,
  isBlockId,
  isAssetPath,
  phaseLabel,
  barPhaseLabel,
  PHASE_LABELS,
};
