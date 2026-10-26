"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDuration,
  formatSeconds,
  defaultMeetingTitle,
  parseIal,
  escapeIal,
  escapeHtml,
  clamp,
  isBlockId,
  isAssetPath,
} = require("../src/util");

test("duration formatting matches the meeting timer rules", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(65_000), "01:05");
  assert.equal(formatDuration(3_600_000), "1:00:00");
  assert.equal(formatDuration(3_725_000), "1:02:05");
  assert.equal(formatDuration(0, { alwaysHours: true }), "0:00:00");
  assert.equal(formatSeconds(65), "01:05");
});

test("default title follows the design minute format", () => {
  const title = defaultMeetingTitle(new Date(2026, 9, 26, 14, 30, 59));
  assert.equal(title, "会议 2026-10-26 14:30");
});

test("IAL parsing and escaping round-trip", () => {
  const attrs = {
    "custom-recording-id": "abc-123",
    "custom-recording-events": JSON.stringify([{ type: "pause", at: "2026-10-26T14:30:00Z" }]),
    "custom-note": 'a "quoted" & value\nnext line',
  };
  const ial = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeIal(value)}"`)
    .join(" ");
  const parsed = parseIal(ial.replaceAll("{", "&#123;").replaceAll("}", "&#125;"));
  assert.equal(parsed["custom-recording-id"], attrs["custom-recording-id"]);
  assert.deepEqual(JSON.parse(parsed["custom-recording-events"]), JSON.parse(attrs["custom-recording-events"]));
  assert.equal(parsed["custom-note"], attrs["custom-note"]);
});

test("HTML escaping covers user-visible text", () => {
  assert.equal(escapeHtml('<img src=x onerror="a">'), "&lt;img src=x onerror=&quot;a&quot;&gt;");
});

test("clamp keeps floating bar geometry inside the work area", () => {
  assert.equal(clamp(-10, 0, 100), 0);
  assert.equal(clamp(110, 0, 100), 100);
  assert.equal(clamp(50, 0, 100), 50);
});

test("block ids and archived asset paths are validated before use", () => {
  assert.equal(isBlockId("20261026135318-8vni2st"), true);
  assert.equal(isBlockId("../../data"), false);
  assert.equal(isBlockId("20261026135318-8VNI2ST"), false);

  assert.equal(isAssetPath("assets/meeting-20261026.wav"), true);
  assert.equal(isAssetPath("assets/sub/meeting-20261026.wav"), true);
  assert.equal(isAssetPath("assets/meeting.wav?box=20261026135318-8vni2st"), true);
  assert.equal(isAssetPath("file:///C:/secret.wav"), false);
  assert.equal(isAssetPath("../assets/secret.wav"), false);
  assert.equal(isAssetPath("assets/../secret.wav"), false);
  assert.equal(isAssetPath("assets/%2e%2e/secret.wav"), false);
  assert.equal(isAssetPath('assets/a"b.wav'), false);
  assert.equal(isAssetPath("assets/meeting.mp3"), false);
});
