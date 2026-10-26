"use strict";

const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

const TEMPLATE_FILE = "summary-templates.json";
const BUILTIN_TEMPLATES = [
  {
    id: "general", name: "通用纪要",
    prompt: "按实际讨论主题详细整理讨论要点、明确决定、行动项和待确认问题，覆盖有信息量的主题、理由与例子。保留有用的上下文，材料未涉及的部分不设空小节。",
    markdown: "## 讨论要点\n按主题整理讨论与依据。\n\n## 明确决定\n\n## 行动项\n\n## 待确认问题",
  },
  {
    id: "actions", name: "行动清单",
    prompt: "优先整理明确的行动项，逐项说明要做什么、明确的负责人和期限、相关依赖或待确认事项。负责人或期限缺失时写待确认。将尚未形成承诺的建议单列，不混入已确认任务。",
    markdown: "## 已确认行动\n| 行动 | 负责人 | 期限 | 依赖或待确认 |\n| --- | --- | --- | --- |\n\n## 尚未确认的建议",
  },
  {
    id: "decisions", name: "决策记录",
    prompt: "围绕实际决策整理问题、讨论过的选项与依据、已确认的决定、明确的后续行动和仍未解决的问题。区分决定、提议和待确认内容，没有形成决定时如实说明。",
    markdown: "## 决策问题\n\n## 选项与依据\n\n## 已确认决定\n\n## 后续行动\n\n## 待确认问题",
  },
].map((template) => Object.freeze(template));
Object.freeze(BUILTIN_TEMPLATES);

function getSummaryTemplate(id = "general", templates = BUILTIN_TEMPLATES) {
  return templates.find((template) => template.id === id) || null;
}

function validateTemplate(value) {
  if (!value || typeof value !== "object" ||
      !["name", "prompt", "markdown"].every((key) => typeof value[key] === "string")) {
    throw new Error("请填写模板名称、提示词或 Markdown 模板。");
  }
  const template = { name: value.name.trim(), prompt: value.prompt.trim(), markdown: value.markdown.trim() };
  if (!template.name) throw new Error("请填写模板名称。");
  if (!template.prompt && !template.markdown) throw new Error("请填写提示词或 Markdown 模板。");
  return template;
}

class SummaryTemplateStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.custom = [];
    this.events = new EventEmitter();
    this.error = "";
    this.ready = false;
    this.saving = false;
  }

  async init() {
    try {
      const saved = await this.plugin.loadData(TEMPLATE_FILE);
      const items = saved == null || saved === "" ? [] : saved;
      if (!Array.isArray(items)) throw new Error("invalid template data");
      const ids = new Set(BUILTIN_TEMPLATES.map((item) => item.id));
      this.custom = items.map((item) => {
        if (typeof item?.id !== "string" || !item.id.startsWith("custom-") || ids.has(item.id)) throw new Error("invalid template id");
        ids.add(item.id);
        return { id: item.id, ...validateTemplate(item) };
      });
      this.ready = true;
      this.error = "";
    } catch {
      this.ready = false;
      this.error = "自定义模板未能读取，请重新加载插件后重试。";
    }
  }

  list() {
    return [...BUILTIN_TEMPLATES, ...this.custom].map((item) => ({ ...item }));
  }

  get(id) {
    return getSummaryTemplate(id, this.list());
  }

  subscribe(listener) {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  async save(value) {
    this.assertReady();
    const id = value.id || `custom-${randomUUID()}`;
    if (getSummaryTemplate(id)) throw new Error("请复制内置模板后再修改。");
    if (value.id && !this.custom.some((item) => item.id === id)) throw new Error("模板已删除，请重新选择。");
    const template = { id, ...validateTemplate(value) };
    const next = this.custom.filter((item) => item.id !== id);
    const index = this.custom.findIndex((item) => item.id === id);
    next.splice(index < 0 ? next.length : index, 0, template);
    await this.persist(next);
    return { ...template };
  }

  async remove(id) {
    this.assertReady();
    if (getSummaryTemplate(id)) throw new Error("内置模板不能删除。");
    await this.persist(this.custom.filter((item) => item.id !== id));
  }

  assertReady() {
    if (!this.ready) throw new Error(this.error || "模板尚未读取完成。");
  }

  async persist(items) {
    // Settings and a meeting can each have a template editor open. Do not let
    // overlapping writes replace the other editor's newly saved collection.
    if (this.saving) throw new Error("另一个窗口正在保存模板，请稍后重试。");
    this.saving = true;
    try {
      const response = await this.plugin.saveData(TEMPLATE_FILE, items);
      if (response?.code) throw new Error("模板未能保存，请重试。");
      this.custom = items;
    } finally {
      this.saving = false;
    }
    this.events.emit("change");
  }
}

module.exports = { BUILTIN_TEMPLATES, getSummaryTemplate, SummaryTemplateStore, validateTemplate };
