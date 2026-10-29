"use strict";

const { Dialog, Protyle, openMobileFileById, showMessage } = require("siyuan");
const api = require("./siyuan-api");
const store = require("./meeting-store");
const { openImport } = require("./audio-import");
const { formatSeconds, defaultMeetingTitle, isAssetPath } = require("./util");

function element(tag, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function installMobile(plugin) {
  let dialog = null, importDialog = null, generation = 0;
  const close = () => { dialog?.destroy(); dialog = null; };
  const report = (error) => showMessage(error.message, 6000, "error");
  const button = (text, handler) => {
    const node = element("button", text);
    node.type = "button";
    node.className = "b3-button b3-button--outline";
    node.onclick = () => Promise.resolve().then(handler).catch(report);
    return node;
  };
  const shell = (title) => {
    close();
    const token = ++generation;
    const cleanups = [];
    let current;
    current = new Dialog({ title, width: "640px", content: '<div class="meeting-mobile"></div>',
      destroyCallback: () => {
        for (const cleanup of cleanups) cleanup();
        current?.element.querySelectorAll("audio").forEach((audio) => { audio.pause(); audio.removeAttribute("src"); audio.load(); });
        if (token === generation) generation++;
      } });
    dialog = current;
    const root = dialog.element.querySelector(".meeting-mobile");
    return { root, active: () => token === generation, onClose: (cleanup) => cleanups.push(cleanup) };
  };
  const openDocument = (id) => {
    close();
    openMobileFileById(plugin.app, id);
  };
  async function detail(id) {
    const { root, active, onClose } = shell("会议");
    root.append(element("p", "正在读取会议…"));
    const meeting = await store.getMeeting(id);
    const [saved, transcript, summaries] = await Promise.all([
      store.readRecordings(meeting), store.findChild(id, "transcript"), store.readSummaries(meeting),
    ]);
    if (!active()) return;
    root.replaceChildren(element("h2", meeting.title));
    root.classList.add("meeting-mobile--detail");
    const nav = element("nav");
    nav.className = "meeting-mobile-tabs";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "会议内容");
    const content = element("div");
    content.className = "meeting-mobile-content";
    const tabs = [
      { key: "notes", label: "笔记", docs: [{ id: meeting.id, title: "笔记" }], empty: "" },
      { key: "transcript", label: "转写", docs: transcript ? [transcript] : [], empty: "尚无转写，可在电脑端转写后同步查看。" },
      { key: "summary", label: "纪要", docs: summaries, empty: "尚无纪要，可在电脑端生成后同步查看。" },
    ];
    const editors = [];
    onClose(() => editors.forEach((editor) => editor.destroy()));
    function selectTab(selected, focus = false) {
      for (const tab of tabs) {
        const selectedNow = tab === selected;
        tab.button.setAttribute("aria-selected", String(selectedNow));
        tab.button.tabIndex = selectedNow ? 0 : -1;
        tab.panel.hidden = !selectedNow;
      }
      if (focus) selected.button.focus();
      if (!selected.loaded) {
        selected.loaded = true;
        for (const doc of selected.docs) {
          if (selected.docs.length > 1) selected.panel.append(element("h3", doc.title));
          const edit = button("在原生文档中编辑", () => openDocument(doc.id));
          edit.className = "meeting-link meeting-mobile-edit";
          const reader = element("div");
          reader.className = "meeting-mobile-reader";
          selected.panel.append(edit, reader);
          const editor = new Protyle(plugin.app, reader, {
            blockId: doc.id, mode: "wysiwyg", action: ["cb-get-all"],
            render: { background: false, title: false, gutter: false, breadcrumb: false, scroll: true },
            after: (instance) => { if (active()) instance.disable(); },
          });
          editors.push(editor);
        }
        if (!selected.docs.length) {
          const hint = element("p", selected.empty);
          hint.className = "meeting-import-hint";
          selected.panel.append(hint);
        }
      }
    }
    for (const tab of tabs) {
      tab.button = button(tab.label, () => selectTab(tab));
      tab.button.id = `meeting-${generation}-${tab.key}-tab`;
      tab.button.setAttribute("role", "tab");
      tab.panel = element("section");
      tab.panel.id = `meeting-${generation}-${tab.key}-panel`;
      tab.panel.className = "meeting-mobile-panel";
      tab.panel.setAttribute("role", "tabpanel");
      tab.panel.setAttribute("aria-labelledby", tab.button.id);
      tab.button.setAttribute("aria-controls", tab.panel.id);
      nav.append(tab.button);
      content.append(tab.panel);
    }
    nav.addEventListener("keydown", (event) => {
      const index = tabs.findIndex((tab) => tab.button === event.target);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next], true);
    });
    content.addEventListener("click", (event) => {
      const link = event.target.closest('[data-href], a[href], [data-type~="block-ref"]');
      const href = link?.getAttribute("data-href") || link?.getAttribute("href")
        || (link?.getAttribute("data-id") ? `siyuan://blocks/${link.getAttribute("data-id")}` : "");
      const target = tabs.find((tab) => tab.docs.some((doc) => href === `siyuan://blocks/${doc.id}`));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      selectTab(target);
    }, true);
    root.append(nav, content);
    selectTab(tabs[0]);
    const recordings = element("details");
    recordings.className = "meeting-mobile-recordings";
    recordings.open = true;
    recordings.append(element("summary", `录音 · ${saved.recordings.length}`));
    root.append(recordings);
    const add = button("添加已有录音", () => {
      importDialog = openImport(meeting, () => active() ? detail(id) : undefined);
    });
    add.disabled = ["recording", "paused"].includes(meeting.status);
    const importHint = element("p", "M4A（含苹果录音）、MP3、WAV · 电脑端转写与生成纪要");
    importHint.className = "meeting-import-hint";
    recordings.append(add, importHint);
    if (add.disabled) recordings.append(element("p", "这场会议仍在录音，请结束后再添加文件。"));
    if (!saved.recordings.length) recordings.append(element("p", "还没有录音。"));
    for (const recording of saved.recordings) {
      const section = element("section");
      section.append(element("h3", recording.originalName || `录音 ${recording.index}`), element("p", formatSeconds(recording.seconds)));
      if (isAssetPath(recording.assetPath)) {
        const audio = element("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = `/${recording.assetPath}`;
        audio.setAttribute("aria-label", recording.originalName || `录音 ${recording.index}`);
        audio.onerror = () => showMessage("录音暂时无法播放，请确认附件已同步；若当前设备不支持其编码，可在原录音设备回听。", 6000, "error");
        audio.onplay = () => root.querySelectorAll("audio").forEach((other) => { if (other !== audio) other.pause(); });
        section.append(audio);
      } else section.append(element("p", "录音尚未归档。"));
      recordings.append(section);
    }
    const footer = element("footer");
    footer.className = "meeting-mobile-footer";
    footer.append(button("刷新会议", () => detail(id)), button("返回会议列表", list));
    root.append(footer);
  }
  function create() {
    const { root } = shell("新建会议");
    const titleLabel = element("label", "会议名称");
    const title = element("input");
    title.value = defaultMeetingTitle();
    titleLabel.append(title);
    const notebookLabel = element("label", "保存到笔记本");
    const notebook = element("select");
    for (const item of api.notebooks()) {
      const option = element("option", item.name);
      option.value = item.id;
      notebook.append(option);
    }
    notebook.value = api.currentNotebookId();
    notebookLabel.append(notebook);
    const submit = button("创建会议", async () => {
      submit.disabled = true;
      try {
        const meeting = await store.createMeeting({ title: title.value, notebookId: notebook.value });
        await detail(meeting.id);
      } finally { submit.disabled = false; }
    });
    root.append(titleLabel, notebookLabel, submit);
  }
  async function list() {
    const { root, active } = shell("会议");
    const search = element("input");
    search.type = "search";
    search.placeholder = "搜索会议";
    search.setAttribute("aria-label", "搜索会议标题");
    const content = element("div", "正在读取会议…");
    root.append(button("新建会议", create), search, content);
    const meetings = await store.listMeetings(500);
    if (!active()) return;
    const render = () => {
      content.replaceChildren();
      const visible = meetings.filter((meeting) => meeting.title.toLowerCase().includes(search.value.trim().toLowerCase()));
      for (const meeting of visible) content.append(button(meeting.title, () => detail(meeting.id)));
      if (!visible.length) content.append(element("p", meetings.length ? "没有匹配的会议" : "还没有会议，创建后即可添加已有录音。"));
    };
    search.oninput = render;
    render();
  }
  plugin.addTopBar({ icon: "iconMeetingMic", title: "会议", position: "right", callback: () => void list().catch(report) });
  return { destroy() { generation++; close(); importDialog?.destroy(); } };
}

module.exports = { installMobile };
