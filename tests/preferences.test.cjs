"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-preferences-"));
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === "siyuan") return {};
  if (name === "@electron/remote") return {
    app: { getPath: () => root }, ipcMain: { on() {} }, screen: { on() {} },
  };
  return load.call(this, name, ...args);
};
const { MeetingController } = require("../src/controller");
Module._load = load;

test("device preference migration keeps browser choices and local service configuration without retaining the legacy key", async () => {
  const values = new Map([["siyuan-meeting.prefs", JSON.stringify({ mode: "online", opacity: 0.6, deviceId: "selected-mic" })]]);
  global.localStorage = { getItem: (key) => values.get(key), removeItem: (key) => values.delete(key) };
  global.window = { siyuan: { config: { system: { dataDir: "/synthetic/workspace/data" } } } };
  const controller = new MeetingController({});
  try {
    fs.mkdirSync(controller.storageRoot, { recursive: true });
    fs.writeFileSync(controller.preferencesPath, JSON.stringify({ cosEndpoint: "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com" }));
    await controller.init();
    clearTimeout(controller.retryTimer);
    const saved = JSON.parse(fs.readFileSync(controller.preferencesPath, "utf8"));
    assert.equal(saved.cosEndpoint, "https://meeting-1250000000.cos.ap-shanghai.myqcloud.com");
    assert.equal(saved.mode, "online");
    assert.equal(saved.deviceId, "selected-mic");
    assert.equal(saved.opacity, 0.6);
    assert.equal(values.has("siyuan-meeting.prefs"), false);
    controller.setPrefs({ opacity: 0.8 });
    assert.equal(JSON.parse(fs.readFileSync(controller.preferencesPath, "utf8")).opacity, 0.8);
  } finally {
    clearTimeout(controller.retryTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transcription diagnostics persist only allowed failure fields, excluding secrets, request content and error messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-diagnostics-"));
  const controller = Object.create(MeetingController.prototype);
  controller.storageRoot = dir;
  try {
    const error = Object.assign(new Error("private transcript and synthetic secret"), {
      code: "ECONNRESET", httpStatus: 502, responseBytes: 80,
      requestId: "8141f188-56cf-42b8-86d3-e26236ec2641",
      request: { headers: { Authorization: "synthetic secret" }, body: "private audio" },
      response: { text: "private transcript" },
    });
    controller.recordTranscriptionFailure({ meetingId: "meeting", recordingId: "recording", phase: "recognizing", error });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "transcription-errors.jsonl"), "utf8"));
    const { at, ...fields } = saved;
    assert.ok(Number.isFinite(Date.parse(at)));
    assert.deepEqual(fields, {
      meetingId: "meeting", recordingId: "recording", phase: "recognizing", errorName: "Error",
      code: "ECONNRESET", serviceCode: null, httpStatus: 502, responseBytes: 80,
      requestId: error.requestId, responseIssue: "",
    });
    controller.recordSummaryFailure({ meetingId: "meeting", phase: "generating", error: Object.assign(error, { httpStatus: 403, category: "permission", serviceCode: "private user material" }) });
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary-errors.jsonl"), "utf8"));
    assert.deepEqual({ ...summary, at: null }, { at: null, meetingId: "meeting", phase: "generating", httpStatus: 403, category: "permission", serviceCode: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
