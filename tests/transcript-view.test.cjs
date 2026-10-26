"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findTranscriptMatches, playbackSegments } = require("../src/transcript-view");

test("transcript search treats punctuation literally and locates repeated matches without changing source text", () => {
  const segments = [{ blockId: "first", text: "复核 A+B，再复核 a+b。" }, { blockId: "second", text: "A+B 已完成" }];
  const matches = findTranscriptMatches(segments, "a+b");
  assert.deepEqual(matches, [
    { blockId: "first", start: 3, end: 6 },
    { blockId: "first", start: 11, end: 14 },
    { blockId: "second", start: 0, end: 3 },
  ]);
});

test("playback selects simultaneous channels in the selected recording and changes paragraphs at their boundary", () => {
  const segments = [
    { blockId: "me", recordingId: "online", startMs: 0, endMs: 1000 },
    { blockId: "them", recordingId: "online", startMs: 500, endMs: 1500 },
    { blockId: "next", recordingId: "online", startMs: 1000, endMs: 2000 },
    { blockId: "other-recording", recordingId: "offline", startMs: 0, endMs: 2000 },
    { blockId: "notice", recordingId: "online", startMs: 0, endMs: 2000, notice: true },
  ];
  assert.deepEqual(playbackSegments(segments, "online", 750).map((segment) => segment.blockId), ["me", "them"]);
  assert.deepEqual(playbackSegments(segments, "online", 1000).map((segment) => segment.blockId), ["them", "next"]);
});
