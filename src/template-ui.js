"use strict";

const { Dialog } = require("siyuan");
const { BUILTIN_TEMPLATES, getSummaryTemplate } = require("./summary-templates");

function node(tag, className, text = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function appendOptions(select, templates, selectedId) {
  for (const [name, custom] of [["内置模板", false], ["自定义模板", true]]) {
    const group = document.createElement("optgroup");
    group.label = name;
    for (const template of templates.filter((item) => !getSummaryTemplate(item.id) === custom)) {
      group.append(new Option(template.name, template.id, false, template.id === selectedId));
    }
    if (group.children.length) select.append(group);
  }
}

function createTemplatePicker({ store, selectedId, disabled = false, onSelect, onManage }) {
  const wrapper = node("div", "meeting-template-picker");
  const select = document.createElement("select");
  select.className = "meeting-summary-template";
  select.setAttribute("aria-label", "纪要模板");
  const templates = store.list();
  appendOptions(select, templates, selectedId);
  if (!store.get(selectedId)) {
    const missing = new Option("模板不可用，请重新选择", selectedId, true, true);
    missing.disabled = true;
    select.prepend(missing);
  }
  select.value = selectedId;
  select.disabled = disabled;
  select.onchange = () => onSelect(select.value);
  const manage = node("button", "meeting-link", "管理模板");
  manage.type = "button";
  manage.disabled = disabled;
  manage.onclick = onManage;
  wrapper.append(select, manage);
  return wrapper;
}

function createTemplateManager({ store, selectedId = "general", onUse, onClose, confirm }) {
  let currentId = store.get(selectedId)?.id || "general";
  let original = null;
  let busy = false;
  const element = node("div", "meeting-template-manager");
  element.innerHTML = `
      <div class="meeting-template-manager__toolbar">
        <select class="b3-select" aria-label="管理的模板" data-field="templates"></select>
        <button type="button" class="meeting-link" data-action="new">新建</button>
        <button type="button" class="meeting-link" data-action="copy">复制</button>
        <button type="button" class="meeting-link" data-action="delete">删除</button>
      </div>
      <label class="meeting-template-manager__field">模板名称<input class="b3-text-field" name="name" autocomplete="off"></label>
      <label class="meeting-template-manager__field">提示词<textarea class="b3-text-field" name="prompt" rows="4" placeholder="例如：重点整理已经确认的行动，保留负责人、期限和依赖。"></textarea></label>
      <label class="meeting-template-manager__field">Markdown 模板<textarea class="b3-text-field meeting-template-manager__markdown" name="markdown" rows="9" placeholder="## 讨论要点&#10;&#10;## 行动清单&#10;&#10;## 待确认问题"></textarea></label>
      <p class="meeting-settings__hint" data-field="hint"></p>
      <p class="meeting-inline-notice" data-field="notice"></p>
      <p class="meeting-template-manager__error" role="alert" data-field="error"></p>
      <div class="meeting-confirm__actions"><button type="button" class="b3-button b3-button--cancel" data-action="close">关闭</button><button type="button" class="b3-button" data-action="save"></button></div>
    `;
  const field = (name) => element.querySelector(`[data-field="${name}"]`);
  const action = (name) => element.querySelector(`[data-action="${name}"]`);
  const input = (name) => element.querySelector(`[name="${name}"]`);
  const values = () => ({ name: input("name").value, prompt: input("prompt").value, markdown: input("markdown").value });
  const dirty = () => !getSummaryTemplate(currentId) && (!currentId
    ? Object.values(values()).some((value) => value.trim())
    : JSON.stringify(values()) !== JSON.stringify(original));
  const allowDiscard = () => !dirty() || confirm("放弃模板修改", "当前模板的修改尚未保存。", "放弃修改");

  function render(template) {
    currentId = template.id || "";
    original = { name: template.name, prompt: template.prompt, markdown: template.markdown };
    const builtin = Boolean(getSummaryTemplate(currentId));
    const select = field("templates");
    select.replaceChildren();
    appendOptions(select, store.list(), currentId);
    if (!currentId) select.prepend(new Option("新建自定义模板", "", true, true));
    for (const name of ["name", "prompt", "markdown"]) {
      input(name).value = template[name];
      input(name).readOnly = builtin || !store.ready;
    }
    action("delete").hidden = builtin || !currentId;
    action("save").textContent = builtin ? "使用模板" : onUse ? "保存并使用" : "保存模板";
    action("save").hidden = builtin && !onUse;
    field("hint").textContent = builtin
      ? "内置模板可复制后修改。提示词规定整理要求，Markdown 模板定义输出结构。"
      : "提示词和 Markdown 模板至少填写一项。模板示例不作为会议事实；保存后不会自动生成纪要。";
    field("notice").textContent = "";
    field("error").textContent = store.error;
    setBusy(false);
    element.dataset.state = builtin ? "builtin" : "editing";
  }

  function setBusy(value) {
    busy = value;
    for (const control of element.querySelectorAll("input, textarea, select, button")) control.disabled = value;
    if (!value && !store.ready) {
      for (const name of ["save", "new", "copy", "delete"]) action(name).disabled = true;
    }
  }

  field("templates").onchange = async (event) => {
    const next = store.get(event.target.value);
    if (!next || busy) return;
    if (await allowDiscard()) render(next);
    else field("templates").value = currentId;
  };
  action("new").onclick = async () => {
    if (busy || !await allowDiscard()) return;
    render({ name: "", prompt: "", markdown: "" });
    input("name").focus();
  };
  action("copy").onclick = async () => {
    if (busy) return;
    const copy = values();
    // Copy the draft too, so creating a variant never discards unsaved edits.
    render({ ...copy, name: `${copy.name || "模板"}（副本）` });
    input("name").focus();
  };
  action("close").hidden = !onClose;
  action("close").onclick = async () => {
    if (!busy && await allowDiscard()) onClose();
  };
  action("save").onclick = async () => {
    if (busy) return;
    setBusy(true);
    field("error").textContent = "";
    element.dataset.state = "saving";
    try {
      let saved = store.get(currentId);
      if (!getSummaryTemplate(currentId)) {
        if (currentId && JSON.stringify(saved && { name: saved.name, prompt: saved.prompt, markdown: saved.markdown }) !== JSON.stringify(original)) {
          throw new Error("模板已在其他窗口变更，请重新选择后再编辑。");
        }
        saved = await store.save({ id: currentId, ...values() });
        // Meeting selection can fail after the template was saved. Retain its
        // identity so retrying uses that template rather than creating a copy.
        render(saved);
        setBusy(true);
      }
      if (onUse) {
        await onUse(saved.id);
        onClose();
      } else {
        render(saved);
        field("notice").textContent = "模板已保存。";
      }
      element.dataset.state = "saved";
    } catch (error) {
      field("error").textContent = error.message;
      element.dataset.state = "error";
    } finally {
      setBusy(false);
    }
  };
  action("delete").onclick = async () => {
    if (busy || !currentId) return;
    if (!await confirm("删除自定义模板", "已有纪要会保留。使用此模板的会议需要重新选择模板后才能生成。", "删除模板")) return;
    setBusy(true);
    try {
      await store.remove(currentId);
      render(BUILTIN_TEMPLATES[0]);
      field("notice").textContent = "模板已删除，已有纪要已保留。";
      element.dataset.state = "deleted";
    } catch (error) {
      field("error").textContent = error.message;
      element.dataset.state = "error";
    } finally {
      setBusy(false);
    }
  };
  render(store.get(currentId));
  return { element, canClose: async () => !busy && await allowDiscard() };
}

function openTemplateManager(options) {
  const dialog = new Dialog({
    title: "纪要模板", width: "720px", hideCloseIcon: true,
    content: '<div class="b3-dialog__content"></div>',
  });
  const manager = createTemplateManager({ ...options, onClose: () => dialog.destroy() });
  dialog.element.querySelector(".b3-dialog__content").append(manager.element);
  return dialog;
}

module.exports = { createTemplatePicker, createTemplateManager, openTemplateManager };
