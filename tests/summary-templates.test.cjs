"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SummaryTemplateStore, BUILTIN_TEMPLATES } = require("../src/summary-templates");
const { buildMaterial, buildSummaryBasis, summaryChanges, buildSystemPrompt } = require("../src/prompts");

test("custom templates persist prompt and Markdown together, keep builtin templates intact, and survive reload", async () => {
  let saved;
  const plugin = { loadData: async () => saved, saveData: async (_file, items) => { saved = structuredClone(items); } };
  const store = new SummaryTemplateStore(plugin);
  await store.init();
  const custom = await store.save({ name: "项目复盘", prompt: "保留事实依据", markdown: "## 结果\n\n## 待确认" });
  assert.deepEqual(saved, [custom]);
  await assert.rejects(store.save({ ...custom, id: "general" }));
  await assert.rejects(store.remove("general"));
  const updated = await store.save({ ...custom, prompt: "区分事实与建议" });
  const reloaded = new SummaryTemplateStore(plugin);
  await reloaded.init();
  assert.deepEqual(reloaded.get(custom.id), updated);
  assert.deepEqual(reloaded.get("general"), BUILTIN_TEMPLATES[0]);
  await reloaded.remove(custom.id);
  assert.equal(reloaded.get(custom.id), null);
  assert.deepEqual(saved, []);
});

test("failed template reads and writes preserve saved templates rather than replacing them with defaults", async () => {
  let failWrite = false;
  let saved = [{ id: "custom-one", name: "项目复盘", prompt: "保留依据", markdown: "" }];
  const store = new SummaryTemplateStore({
    loadData: async () => saved,
    saveData: async (_file, items) => {
      if (failWrite) return { code: -1 };
      saved = items;
    },
  });
  await store.init();
  failWrite = true;
  await assert.rejects(store.save({ ...saved[0], prompt: "修改要求" }));
  assert.deepEqual(store.get("custom-one"), saved[0]);
  saved = { invalid: true };
  await store.init();
  assert.equal(store.ready, false);
  await assert.rejects(store.save({ name: "新模板", prompt: "要求", markdown: "" }));
  assert.deepEqual(saved, { invalid: true });
});

test("template basis tracks both editable inputs, clears on revert, and preserves template name at generation time", () => {
  const material = buildMaterial({ meetingNotes: "周五复核，负责人待定。" });
  const template = { id: "custom-review", name: "项目复盘", prompt: "保留依据", markdown: "## 结论" };
  const original = buildSummaryBasis(material, template);
  for (const changed of [{ ...template, prompt: "只整理行动" }, { ...template, markdown: "## 行动" }]) {
    assert.deepEqual(summaryChanges(original, buildSummaryBasis(material, changed)), ["模板"]);
    assert.notEqual(buildSystemPrompt({ template }), buildSystemPrompt({ template: changed }));
  }
  assert.deepEqual(summaryChanges(original, buildSummaryBasis(material, { ...template, name: "新名称" })), []);
  assert.equal(original.templateName, "项目复盘");
  assert.deepEqual(summaryChanges(original, buildSummaryBasis(material, template)), []);
});
