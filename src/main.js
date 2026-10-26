"use strict";

const { Plugin, Menu, showMessage, openTab } = require("siyuan");
const { ICONS } = require("./icons");
const { MeetingController } = require("./controller");
const { TranscriptionManager } = require("./transcription");
const { SummaryTemplateStore } = require("./summary-templates");
const ui = require("./ui");
const meetingStore = require("./meeting-store");
const api = require("./siyuan-api");
const { formatDuration, formatDate } = require("./util");

const TAB_MEETING = "meeting";
const TAB_ALL = "meetings";

module.exports = class MeetingPlugin extends Plugin {
  async onload() {
    this.addIcons(ICONS);
    this.controller = new MeetingController(this);
    this.transcription = new TranscriptionManager(this);
    await this.controller.init();
    this.summaryTemplates = new SummaryTemplateStore(this);
    await this.summaryTemplates.init();
    this.registerTabs();
    this.registerTopBar();
    this.registerCommands();
    this.registerTranscriptClicks();
    this.recentMeetings = [];
    void meetingStore
      .listMeetings(12)
      .then((items) => {
        this.recentMeetings = items;
      })
      .catch(() => {});
  }

  registerTabs() {
    const plugin = this;
    this.addTab({
      type: TAB_MEETING,
      init() {
        ui.mountMeetingTab(plugin, this);
      },
      destroy() {
        try {
          this.meetingCleanup?.();
        } catch (error) {
          console.error("[siyuan-meeting] tab cleanup failed", error);
        }
      },
    });
    this.addTab({
      type: TAB_ALL,
      init() {
        ui.mountAllMeetingsTab(plugin, this);
      },
      destroy() {
        try {
          this.meetingCleanup?.();
        } catch (error) {
          console.error("[siyuan-meeting] tab cleanup failed", error);
        }
      },
    });
  }

  registerTopBar() {
    const element = document.createElement("div");
    element.className = "toolbar__item ariaLabel meeting-topbar";
    element.id = `plugin_${encodeURIComponent(this.name)}_meeting`;
    element.setAttribute("aria-label", "会议录音");
    element.setAttribute("title", "会议录音");
    element.dataset.state = "idle";
    element.innerHTML = `<span class="meeting-topbar__glyph"><svg><use href="#iconMeetingMic"></use></svg></span>
      <span class="meeting-topbar__recording" aria-hidden="true"><span class="meeting-topbar__ping"></span><span class="meeting-topbar__dot"></span></span>
      <span class="meeting-topbar__badge" aria-hidden="true"></span>`;
    element.addEventListener("click", () => {
      void this.openMenu(element);
    });
    this.button = this.addTopBar({
      element,
      title: "会议录音",
      position: "right",
    });
    this.refreshTopBar(this.controller.snapshot());
  }

  registerCommands() {
    const plugin = this;
    try {
      this.addCommand({
        langKey: "newMeeting",
        hotkey: "",
        callback: () => {
          void plugin.controller
            .createMeeting({})
            .catch((error) => showMessage(error.message, 6000, "error"));
        },
      });
      this.addCommand({
        langKey: "allMeetings",
        hotkey: "",
        callback: () => plugin.openAllMeetingsTab(),
      });
    } catch {
      // Commands are optional; a missing i18n key must not disable the plugin.
    }
  }

  registerTranscriptClicks() {
    this.transcriptDocCache = new Map();
    this.onClickEditorContent = (event) => {
      const detail = event?.detail || event;
      const target = detail?.event?.target;
      const protyle = detail?.protyle;
      if (!target || !protyle) return;
      const link = target.closest?.('[data-type="a"], a');
      const href = link?.getAttribute("data-href") || link?.getAttribute("href");
      if (href !== "siyuan://plugins/siyuan-meeting/seek") return;
      detail.event.preventDefault?.();
      const rootId = protyle.block?.rootID || protyle.protyle?.block?.rootID;
      const blockElement = target.closest?.("[data-node-id]");
      const blockId = blockElement?.getAttribute("data-node-id");
      if (!rootId || !blockId) return;
      void (async () => {
        let isTranscript = this.transcriptDocCache.get(rootId);
        if (isTranscript === undefined) {
          const docAttrs = await api.getBlockAttrs(rootId);
          isTranscript = docAttrs["custom-meeting-child"] === "transcript";
          this.transcriptDocCache.set(rootId, isTranscript);
        }
        if (!isTranscript) return;
        const attrs = await api.getBlockAttrs(blockId);
        if (!attrs["custom-transcript-recording"]) return;
        const docId = attrs["custom-transcript-meeting"];
        if (!docId) return;
        this.controller.requestSeek({
          docId,
          recordingId: attrs["custom-transcript-recording"],
          startMs: Number(attrs["custom-transcript-start"] || 0),
        });
      })().catch(() => {});
    };
    this.eventBus.on("click-editorcontent", this.onClickEditorContent);
  }

  async openMenu(target) {
    let recent = [];
    try {
      recent = await meetingStore.listMeetings(8);
      this.recentMeetings = recent;
    } catch {
      recent = this.recentMeetings || [];
    }
    const snapshot = this.controller.snapshot();
    const menu = new Menu("meeting-topbar-menu");
    const active = snapshot.meeting;
    const phase = snapshot.phase;

    if (active && ["preparing", "recording", "paused", "saving", "error"].includes(phase)) {
      const status =
        phase === "paused"
          ? "已暂停"
          : phase === "saving"
            ? "正在保存"
            : phase === "error"
              ? "需要处理"
              : "录音中";
      menu.addItem({
        icon: "iconMeetingMic",
        label: `返回当前会议 · ${formatDuration(snapshot.elapsedMs)}（${status}）`,
        click: () => this.openMeetingTab(active.id, active.title),
      });
      menu.addSeparator();
    } else if (active) {
      menu.addItem({
        icon: "iconMeetingMic",
        label: `打开当前会议 · ${active.title}`,
        click: () => this.openMeetingTab(active.id, active.title),
      });
      menu.addSeparator();
    }

    menu.addItem({
      icon: "iconAdd",
      label: "新建会议",
      click: () => {
        void this.controller
          .createMeeting({})
          .catch((error) => showMessage(error.message, 7000, "error"));
      },
    });

    if (recent.length) {
      menu.addItem({
        icon: "iconMeetingCalendar",
        label: "最近会议",
        submenu: recent.map((item) => {
          const when = item.firstRecordedAt || item.startedAt || item.created;
          return {
            label: `${item.title}${when ? ` · ${formatDate(when)}` : ""}`,
            click: () => this.openMeetingTab(item.id, item.title),
          };
        }),
      });
    }
    menu.addItem({
      icon: "iconSearch",
      label: "全部会议…",
      click: () => this.openAllMeetingsTab(),
    });
    menu.addSeparator();
    menu.addItem({
      icon: "iconSettings",
      label: "设置",
      click: () => ui.openSettings(this),
    });
    const rect = target.getBoundingClientRect();
    menu.open({ x: Math.round(rect.right), y: Math.round(rect.bottom + 4) });
  }

  refreshTopBar(snapshot) {
    const button = this.button;
    if (!button) return;
    const phase = snapshot?.phase || "idle";
    button.dataset.state = phase;
    button.classList.toggle("is-recording", phase === "recording");
    button.classList.toggle(
      "has-recovery",
      Boolean(snapshot?.pendingRecoveries) &&
        !["preparing", "recording", "paused", "saving"].includes(phase),
    );
    const use = button.querySelector("use");
    if (use) {
      const showWarning =
        phase === "error" ||
        (snapshot?.pendingRecoveries && !["preparing", "recording", "paused", "saving"].includes(phase));
      use.setAttribute("href", showWarning ? "#iconMeetingWarning" : "#iconMeetingMic");
    }
    let label = "会议录音";
    if (phase === "preparing") label = "正在打开麦克风…";
    else if (phase === "recording") label = `录音中 · ${formatDuration(snapshot.elapsedMs)}`;
    else if (phase === "paused") label = `已暂停 · ${formatDuration(snapshot.elapsedMs)}`;
    else if (phase === "saving") label = "正在保存录音…";
    else if (phase === "error") label = snapshot.saveFailed ? "录音保存失败" : "录音需要处理";
    else if (phase === "saved") label = "录音已保存";
    else if (snapshot.pendingRecoveries) label = "有录音待恢复或归档";
    if (snapshot.meeting && phase === "recording") label += ` · ${snapshot.meeting.title}`;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }

  openMeetingTab(docId, title = "会议") {
    const opened = this.getOpenedTab?.() || {};
    const existing = (opened[TAB_MEETING] || []).find((model) => model.data?.id === docId);
    if (existing?.tab) {
      try {
        existing.tab.parent?.switchTab(existing.tab.headElement);
        return existing.tab;
      } catch {
        // fall through and open a new tab
      }
    }
    return openTab({
      app: this.app,
      custom: {
        id: this.name + TAB_MEETING,
        icon: "iconMeetingMic",
        title,
        data: { id: docId },
      },
    });
  }

  openAllMeetingsTab() {
    const opened = this.getOpenedTab?.() || {};
    const existing = (opened[TAB_ALL] || [])[0];
    if (existing?.tab) {
      try {
        existing.tab.parent?.switchTab(existing.tab.headElement);
        return existing.tab;
      } catch {
        // fall through
      }
    }
    return openTab({
      app: this.app,
      custom: {
        id: this.name + TAB_ALL,
        icon: "iconMeetingCalendar",
        title: "全部会议",
        data: {},
      },
    });
  }

  async onunload() {
    if (this.onClickEditorContent) {
      this.eventBus.off("click-editorcontent", this.onClickEditorContent);
    }
    try {
      this.transcription?.shutdown();
    } catch {
      // jobs may already be gone
    }
    try {
      await this.controller?.shutdown();
    } catch (error) {
      console.error("[siyuan-meeting] shutdown failed", error);
    }
  }
};
