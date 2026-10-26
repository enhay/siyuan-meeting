"use strict";

const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const api = require("./siyuan-api");
const meetingStore = require("./meeting-store");
const tencent = require("./tencent");

const POLL_INTERVAL = 5000;
const MAX_POLL_MS = 45 * 60 * 1000;

function secret(plugin, name) {
  try {
    const value = plugin.getSecret?.(name);
    if (value) return value;
  } catch {
    // fall through to the config snapshot
  }
  return (
    window.siyuan?.config?.secrets?.items?.find((item) => item?.name === name)?.value || ""
  );
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

class TranscriptionManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.events = new EventEmitter();
    this.jobs = new Map();
    this.status = new Map();
    this.errors = new Map();
  }

  subscribe(listener) {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  notify(meeting, recordingId, status, error = "") {
    const key = `${meeting?.id || ""}:${recordingId}`;
    this.status.set(key, status);
    this.errors.set(key, error);
    this.events.emit("change", { meetingId: meeting?.id, recordingId, status, error });
  }

  statusFor(meetingId, recordingId) {
    const key = `${meetingId}:${recordingId}`;
    return { status: this.status.get(key) || "", error: this.errors.get(key) || "" };
  }

  isRunning(recordingId) {
    return this.jobs.has(recordingId);
  }

  config() {
    return {
      secretId: secret(this.plugin, "meeting.tencent.secretId"),
      secretKey: secret(this.plugin, "meeting.tencent.secretKey"),
      region: "ap-shanghai",
    };
  }

  async sourceFor(recording) {
    if (!recording.assetPath) throw new Error("这段录音还没有归档到思源资源，无法转写");
    const base = String(this.plugin.controller.getPrefs().publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (base) {
      return {
        sourceType: 0,
        url: `${base}/${String(recording.assetPath).replace(/^\/+/, "")}`,
      };
    }
    const absolute = await api.resolveAssetPath(recording.assetPath);
    if (!absolute) throw new Error("无法解析录音文件位置");
    const stat = fs.statSync(absolute);
    if (stat.size > 5 * 1024 * 1024) {
      throw new Error(
        "这段录音超过腾讯云 5 MB 直传上限。请在会议设置中填写可访问的音频地址前缀，或改用较短录音。",
      );
    }
    return { sourceType: 1, data: fs.readFileSync(absolute) };
  }

  async start(meeting, recording) {
    if (!meeting?.id || !recording?.recordingId) throw new Error("没有可转写的录音段");
    if (this.jobs.has(recording.recordingId)) return;
    const config = this.config();
    if (!config.secretId || !config.secretKey) {
      throw new Error("请先在会议设置中填写腾讯云 SecretId 和 SecretKey");
    }
    const controller = new AbortController();
    this.jobs.set(recording.recordingId, controller);
    const taskKey = `siyuan-meeting.tencentTask.${recording.recordingId}`;
    let activeTaskId = ["done", "failed"].includes(recording.taskStatus)
      ? "" : recording.taskId || localStorage.getItem(taskKey) || "";
    try {
      // A task id already accepted by Tencent must be polled, never submitted
      // again. This also covers a restart before resumePending runs.
      if (activeTaskId) {
        this.notify(meeting, recording.recordingId, recording.taskStatus);
        await meetingStore.updateRecordingTask(meeting, recording.recordingId, activeTaskId, "processing");
        await this.poll(meeting, recording.recordingId, activeTaskId, controller.signal);
        return;
      }
      this.notify(meeting, recording.recordingId, "uploading");
      const source = await this.sourceFor(recording);
      const sampleRate = Number(recording.sampleRate || 16000);
      const preferred = String(this.plugin.controller.getPrefs().engine || "");
      const compatible =
        (preferred.startsWith("16k") && sampleRate >= 16000) ||
        (preferred.startsWith("8k") && sampleRate >= 8000);
      const engine = compatible ? preferred : tencent.engineForSampleRate(sampleRate);
      const created = await tencent.createRecTask({
        ...config,
        engine,
        channels: recording.channels === 2 ? 2 : 1,
        ...source,
      });
      const taskId = String(created?.TaskId || "");
      if (!taskId) throw new Error("腾讯云没有返回任务编号");
      activeTaskId = taskId;
      // Keep the accepted id across a failed block write and an app restart.
      localStorage.setItem(taskKey, taskId);
      await meetingStore.updateRecordingTask(meeting, recording.recordingId, taskId, "queued");
      this.notify(meeting, recording.recordingId, "queued");
      await this.poll(meeting, recording.recordingId, taskId, controller.signal);
    } catch (error) {
      if (String(error.message) !== "已取消") {
        if (activeTaskId && error.retryable !== false) {
          // The task is still valid. A query timeout or network failure must
          // not turn into a new billable submission on "retry".
          await meetingStore
            .updateRecordingTask(meeting, recording.recordingId, activeTaskId, "processing", error.message)
            .catch(() => {});
          this.notify(meeting, recording.recordingId, "processing", error.message);
        } else {
          await meetingStore
            .updateRecordingTask(meeting, recording.recordingId, "", "failed", error.message)
            .catch(() => {});
          this.notify(meeting, recording.recordingId, "failed", error.message);
        }
      }
    } finally {
      this.jobs.delete(recording.recordingId);
    }
  }

  async poll(meeting, recordingId, taskId, signal, startedAt = Date.now()) {
    const config = this.config();
    while (!signal.aborted) {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        throw new Error("转写查询超时；任务编号已保存，稍后可以继续查询");
      }
      const response = await tencent.describeTaskStatus(config, taskId);
      const status = tencent.normalizeStatus(response);
      if (status === "done") {
        const segments = tencent.parseResult(response.Result);
        if (!segments.length) {
          const error = new Error("转写完成但没有识别到文字");
          error.retryable = false;
          throw error;
        }
        await meetingStore.writeTranscript(meeting, recordingId, segments);
        await meetingStore.updateRecordingTask(meeting, recordingId, taskId, "done");
        this.notify(meeting, recordingId, "done");
        return;
      }
      if (status === "failed") {
        const message =
          response?.Error?.Message || response?.StatusStr || "腾讯云转写失败";
        await meetingStore.updateRecordingTask(meeting, recordingId, taskId, "failed");
        this.notify(meeting, recordingId, "failed", message);
        return;
      }
      await meetingStore.updateRecordingTask(meeting, recordingId, taskId, status);
      this.notify(meeting, recordingId, status);
      await sleep(POLL_INTERVAL, signal);
    }
    throw new Error("已取消");
  }

  cancel(recordingId) {
    this.jobs.get(recordingId)?.abort();
    this.jobs.delete(recordingId);
  }

  /**
   * Picking up a completed task after restart must not create a second billable
   * task. Only tasks that already have an id are polled.
   */
  resumePending(meeting) {
    if (!meeting?.id) return;
    const controller = this.config();
    if (!controller.secretId || !controller.secretKey) return;
    void meetingStore
      .readRecordings(meeting)
      .then(({ recordings }) => {
        for (const recording of recordings) {
          if (
            recording.taskId &&
            ["queued", "processing"].includes(recording.taskStatus) &&
            !this.jobs.has(recording.recordingId)
          ) {
            const abort = new AbortController();
            this.jobs.set(recording.recordingId, abort);
            this.notify(meeting, recording.recordingId, recording.taskStatus);
            void this.poll(meeting, recording.recordingId, recording.taskId, abort.signal)
              .catch((error) => {
                if (String(error.message) !== "已取消") {
                  this.notify(meeting, recording.recordingId, "failed", error.message);
                }
              })
              .finally(() => this.jobs.delete(recording.recordingId));
          }
        }
      })
      .catch(() => {});
  }
}

module.exports = { TranscriptionManager };
