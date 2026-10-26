"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// A smoke test for module initialization. Real SiYuan provides these exports;
// this catches missing/renamed imports before the plugin is loaded in the host.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "siyuan") {
    return {
      Plugin: class Plugin {},
      Menu: class Menu {
        addItem() {}
        addSeparator() {}
        open() {}
      },
      Dialog: class Dialog {},
      Protyle: class Protyle {},
      showMessage() {},
      openSetting() {},
      openTab() {},
      getAllEditor() {
        return [];
      },
      async fetchSyncPost() {
        return { code: 0, data: null };
      },
    };
  }
  if (request === "@electron/remote") {
    return {
      app: { getPath: () => "/tmp" },
      ipcMain: { on() {}, removeListener() {} },
      screen: { on() {}, removeListener() {} },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

test("the generated index.js works with a plugin-scoped require", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const code = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const mockApi = {
    Plugin: class Plugin {},
    Menu: class Menu {},
    Dialog: class Dialog {},
    Protyle: class Protyle {},
    showMessage() {},
    openSetting() {},
    openTab() {},
    getAllEditor() {
      return [];
    },
    async fetchSyncPost() {
      return { code: 0, data: null };
    },
  };
  const mockRemote = {
    app: { getPath: () => "/tmp" },
    ipcMain: { on() {}, removeListener() {} },
    screen: { on() {}, removeListener() {} },
  };
  const hostRequire = (request) => {
    if (request === "siyuan") return mockApi;
    if (request === "@electron/remote") return mockRemote;
    return require(request);
  };
  const moduleObj = { exports: {} };
  const evaluate = new Function("require", "module", "exports", code);
  evaluate(hostRequire, moduleObj, moduleObj.exports);
  assert.equal(typeof moduleObj.exports, "function");
  assert.ok(moduleObj.exports.prototype instanceof mockApi.Plugin);
});

test("all runtime modules initialize with the SiYuan plugin API surface", () => {
  const modules = [
    "../src/util",
    "../src/prompts",
    "../src/icons",
    "../src/siyuan-api",
    "../src/ai",
    "../src/tencent",
    "../src/meeting-store",
    "../src/transcription",
    "../src/controller",
    "../src/ui",
    "../index",
  ];
  for (const name of modules) {
    const imported = require(name);
    assert.ok(imported, `${name} should export something`);
  }
  assert.equal(typeof require("../src/prompts").buildSystemPrompt, "function");
  assert.equal(typeof require("../src/controller").MeetingController, "function");
  assert.equal(typeof require("../src/ui").mountMeetingTab, "function");
  assert.equal(typeof require("../src/transcription").TranscriptionManager, "function");
  assert.equal(typeof require("../index"), "function");
});
