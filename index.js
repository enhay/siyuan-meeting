const { Plugin, Menu } = require("siyuan");

module.exports = class MeetingProbe extends Plugin {
  onload() {
    this.addIcons('<symbol id="iconMeetingProbe" viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm-7-4v1a7 7 0 0 0 6 6.93V22h2v-3.07A7 7 0 0 0 19 12v-1h-2v1a5 5 0 0 1-10 0v-1Z"/></symbol>');
    this.button = this.addTopBar({
      icon: "iconMeetingProbe", title: "会议录音验证", position: "right",
      callback: () => {
        const menu = new Menu("meeting-probe-menu");
        menu.addItem({ label: "打开录音验证", click: () => this.openProbe() });
        menu.open({ x: this.button.getBoundingClientRect().right, y: 32 });
      },
    });
  }

  openProbe() {
    if (this.capture && !this.capture.isDestroyed()) {
      this.capture.show();
      return;
    }
    const remote = require("@electron/remote");
    const { BrowserWindow, session, desktopCapturer, ipcMain, screen, app } = remote;
    const path = require("path");
    const { pathToFileURL } = require("url");
    const crypto = require("crypto");
    const root = path.join(window.siyuan.config.system.dataDir, "plugins", this.name, "probe");
    const page = pathToFileURL(path.join(root, "index.html")).href;
    const floatPage = pathToFileURL(path.join(root, "float.html")).href;
    const channel = `meeting-${crypto.randomUUID()}`;
    // A nonpersistent, private session never changes the host's media handlers.
    const isolated = session.fromPartition(channel);
    const capture = this.capture = new BrowserWindow({
      width: 760, height: 680, show: false, title: "会议录音验证",
      webPreferences: { session: isolated, nodeIntegration: true, contextIsolation: false,
        sandbox: false, backgroundThrottling: false },
    });
    const bar = this.bar = new BrowserWindow({
      width: 300, height: 46, show: false, frame: false, transparent: true,
      resizable: false, focusable: false, skipTaskbar: true, hasShadow: false,
      webPreferences: { session: isolated, nodeIntegration: true, contextIsolation: false,
        sandbox: false, backgroundThrottling: false },
    });
    const isCapture = (contents) => contents?.id === capture.webContents.id;
    isolated.setPermissionCheckHandler((contents, permission, origin, details) =>
      isCapture(contents) && permission === "media" && details?.isMainFrame === true);
    isolated.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(isCapture(contents) && permission === "media" && details.isMainFrame === true));
    isolated.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (request.frame !== capture.webContents.mainFrame || !request.userGesture ||
            !request.frame.url.startsWith(page + "?") || !request.audioRequested) {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: {width: 0, height: 0} });
        if (!sources.length) throw new Error("没有可采集的屏幕");
        callback({ video: sources[0], audio: "loopback" });
      } catch (error) {
        capture.webContents.send(channel, { type: "error", message: error.message });
        callback({});
      }
    });
    for (const win of [capture, bar]) {
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", event => event.preventDefault());
      win.on("close", event => { event.preventDefault(); win.hide(); });
    }
    const place = () => {
      const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      bar.setBounds({ x: Math.round(work.x + (work.width - 300) / 2),
        y: work.y + work.height - 54, width: 300, height: 46 });
    };
    place();
    bar.setAlwaysOnTop(true, "floating");
    bar.setContentProtection(true);
    const onDisplay = () => place();
    screen.on("display-removed", onDisplay);
    screen.on("display-metrics-changed", onDisplay);
    const listener = (event, message) => {
      if (event.sender.id === capture.webContents.id && message?.type === "state") {
        bar.webContents.send(channel, message);
        this.button.setAttribute("aria-label", message.label);
        this.button.dataset.state = message.phase;
        this.button.style.color = message.phase === "recording" ? "#ff334d" : "";
        if (["preparing", "recording", "paused", "error", "saving"].includes(message.phase)) bar.showInactive();
        else bar.hide();
      } else if (event.sender.id === bar.webContents.id && ["pause", "resume", "stop", "open"].includes(message?.type)) {
        if (message.type === "open") capture.show();
        else if (message.type === "resume") {
          void capture.webContents.executeJavaScript("window.resumeRecording()", true);
        } else capture.webContents.send(channel, message);
      }
    };
    ipcMain.on(channel, listener);
    this.cleanup = () => {
      ipcMain.removeListener(channel, listener);
      screen.removeListener("display-removed", onDisplay);
      screen.removeListener("display-metrics-changed", onDisplay);
      isolated.setDisplayMediaRequestHandler(null);
      isolated.setPermissionCheckHandler(null);
      isolated.setPermissionRequestHandler(null);
      if (!bar.isDestroyed()) bar.destroy();
    };
    capture.on("closed", () => this.cleanup?.());
    bar.loadURL(floatPage + "?channel=" + encodeURIComponent(channel));
    capture.loadURL(page + "?" + new URLSearchParams({ channel,
      storage: path.join(app.getPath("userData"), "meeting-probe-continuous"),
    }).toString());
    capture.once("ready-to-show", () => capture.show());
  }

  async onunload() {
    if (this.capture && !this.capture.isDestroyed()) {
      try { await this.capture.webContents.executeJavaScript("window.finishRecording()"); }
      finally { this.capture.destroy(); }
    }
    this.cleanup?.();
  }
};
