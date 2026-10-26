"use strict";

function findTranscriptMatches(segments, query) {
  const text = String(query || "").trim();
  if (!text) return [];
  const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return segments.flatMap((segment) => Array.from(String(segment.text || "").matchAll(pattern), (match) => ({
    blockId: segment.blockId,
    start: match.index,
    end: match.index + match[0].length,
  })));
}

function playbackSegments(segments, recordingId, currentMs) {
  return segments.filter((segment) => !segment.notice && segment.recordingId === recordingId &&
    currentMs >= segment.startMs && currentMs < segment.endMs);
}

module.exports = { findTranscriptMatches, playbackSegments };
