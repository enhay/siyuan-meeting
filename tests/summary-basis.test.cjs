"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getSummaryTemplate } = require("../src/summary-templates");
const { buildMaterial, buildSummaryBasis, summaryChanges, buildSystemPrompt } = require("../src/prompts");

test("summary basis detects actual template and input changes, clears on revert, and excludes unselected transcripts", () => {
  const input = { title: "周会", meetingNotes: "周五复核", transcript: [{ recordingId: "one", startMs: 0, speaker: "我", text: "负责人待定" }] };
  const original = buildSummaryBasis(buildMaterial(input), getSummaryTemplate("general"));
  assert.deepEqual(summaryChanges(original, buildSummaryBasis(buildMaterial(input), getSummaryTemplate("actions"))), ["模板"]);
  assert.deepEqual(summaryChanges(original, buildSummaryBasis(buildMaterial({ ...input, meetingNotes: "周六复核" }), getSummaryTemplate("general"))), ["笔记"]);
  const revised = { ...input, transcript: [{ ...input.transcript[0], text: "负责人已确认" }] };
  assert.deepEqual(summaryChanges(original, buildSummaryBasis(buildMaterial(revised), getSummaryTemplate("general"))), ["转写"]);
  assert.deepEqual(summaryChanges(original, buildSummaryBasis(buildMaterial(input), getSummaryTemplate("general"))), []);
  const notesOnly = buildSummaryBasis(buildMaterial({ ...input, onlyNotes: true }), getSummaryTemplate("general"), { onlyNotes: true });
  assert.deepEqual(summaryChanges(notesOnly, buildSummaryBasis(buildMaterial({ ...revised, onlyNotes: true }), getSummaryTemplate("general"), { onlyNotes: true })), []);
  assert.deepEqual(summaryChanges(null, original), []);
});

test("selected built-in template changes the format instructions while retaining shared accuracy rules", () => {
  const general = buildSystemPrompt({ template: getSummaryTemplate("general") });
  const actions = buildSystemPrompt({ template: getSummaryTemplate("actions") });
  const decisions = buildSystemPrompt({ template: getSummaryTemplate("decisions") });
  assert.notEqual(general, actions);
  assert.notEqual(actions, decisions);
  for (const prompt of [general, actions, decisions]) {
    assert.ok(prompt.includes("不得补造"));
    assert.ok(prompt.includes("保留差异，不擅自裁决"));
  }
});
