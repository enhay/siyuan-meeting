"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const api = require("./siyuan-api");
const meetingStore = require("./meeting-store");
const tencent = require("./tencent");
const { wavParts } = require("./wav");
const { mergeGaps } = require("../capture/realtime.cjs");

function secret(plugin, name) {
  return plugin.getSecret?.(name) || globalThis.window?.siyuan?.config?.secrets?.items?.find((item) => item?.name === name)?.value || "";
}

class TranscriptionManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.events = new EventEmitter();
    this.jobs = new Map();
    this.status = new Map();
    this.errors = new Map();
    this.closing = false;
    this.persistenceGaps = new Map();
    this.deviceId = globalThis.localStorage?.getItem("siyuan-meeting.device") || crypto.randomUUID();
    globalThis.localStorage?.setItem("siyuan-meeting.device", this.deviceId);
  }

  subscribe(listener) {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  notify(meeting, recordingId, status, error = "") {
    const key = `${meeting.id}:${recordingId}`;
    this.status.set(key, status);
    this.errors.set(key, error);
    this.events.emit("change", { meetingId: meeting.id, recordingId, status, error });
  }

  statusFor(meetingId, recordingId) {
    const key = `${meetingId}:${recordingId}`;
    return { status: this.status.get(key) || "", error: this.errors.get(key) || "" };
  }

  isRunning(recordingId) { return this.jobs.has(recordingId); }

  config() {
    return {
      appId: String(this.plugin.controller.getPrefs().tencentAppId || "").trim(),
      secretId: secret(this.plugin, "meeting.tencent.secretId"),
      secretKey: secret(this.plugin, "meeting.tencent.secretKey"),
    };
  }

  isConfigured() {
    const config = this.config();
    return tencent.isConfigured(config);
  }

  async setState(meeting, recordingId, status, error = "", patch = {}) {
    await meetingStore.updateRecordingTranscription(meeting, recordingId, {
      ...patch, transcriptionStatus: status, transcriptionError: error,
    });
    this.notify(meeting, recordingId, status, error);
  }

  async onRealtime(meeting, recordingId, message) {
    const key = `${meeting.id}:${recordingId}`;
    if (message.meta) await meetingStore.ensureRecording(meeting, { ...message.meta, recordingId, deviceId: this.deviceId });
    if (message.segments?.length) {
      try {
        await meetingStore.writeTranscript(meeting, recordingId, message.segments, { append: true });
      } catch {
        this.persistenceGaps.set(key, mergeGaps([
          ...(this.persistenceGaps.get(key) || []),
          ...message.segments.map(({ startMs, endMs, channel }) => ({ startMs, endMs, channel })),
        ]));
      }
    }
    const missing = this.persistenceGaps.get(key) || [];
    const gaps = mergeGaps([...(message.gaps || []), ...missing]);
    const status = message.final && missing.length ? "incomplete" : message.status || "recording";
    const error = missing.length ? "部分转写未能写入会议，录音仍已保存；结束后可补齐缺口" : message.error || "";
    await this.setState(meeting, recordingId, status, error, {
      gaps, ...(message.meta ? { realtimeEnabled: Boolean(message.meta.realtimeEnabled) } : {}),
    });
    return { gaps, status, error };
  }

  async start(meeting, recording, { gapsOnly = false, expectedFingerprint } = {}) {
    if (!meeting?.id || !recording?.recordingId) throw new Error("没有可转写的录音");
    if (this.closing || this.jobs.has(recording.recordingId)) return;
    if (!this.isConfigured()) throw new Error("请先在会议设置中配置腾讯云转写服务");
    if (!recording.assetPath) throw new Error("录音保存完成后才能转写");
    const controller = new AbortController();
    const { signal } = controller;
    this.jobs.set(recording.recordingId, controller);
    let persisted = false;
    try {
      const absolute = await api.resolveAssetPath(recording.assetPath);
      if (!absolute) throw new Error("录音尚未同步到本机，请同步后重试");
      const fingerprint = expectedFingerprint ?? await meetingStore.transcriptFingerprint(meeting, recording.recordingId);
      await this.setState(meeting, recording.recordingId, "processing");
      const results = [];
      const ranges = gapsOnly ? recording.gaps || [] : [{}];
      if (!ranges.length) {
        await this.setState(meeting, recording.recordingId, recording.transcriptionStatus || "incomplete");
        return;
      }
      let requestIndex = 0;
      for (const range of ranges) {
        for await (const part of wavParts(absolute, { ...range, signal })) {
          signal.throwIfAborted();
          const segments = await tencent.flashRecognize({
            ...this.config(), data: part.data, channels: part.channels,
            sampleRate: part.sampleRate, signal,
          });
          signal.throwIfAborted();
          const multipleSpeakers = new Set(segments.map((segment) => segment.speaker)).size > 1;
          for (const segment of segments) {
            const channel = range.channel ?? segment.channel;
            results.push({
              ...segment, channel,
              startMs: part.startMs + segment.startMs,
              endMs: Math.min(part.endMs, part.startMs + segment.endMs),
              speakerLabel: recording.channels === 2
                ? channel === 0 ? "我" : (part.channels === 2 ? segment.speakerLabel : `其他参会者${multipleSpeakers ? ` ${Number(segment.speaker || 0) + 1}` : ""}`)
                : segment.speakerLabel || `说话人 ${Number(segment.speaker || 0) + 1}`,
            });
          }
          if (requestIndex > 0 || gapsOnly) {
            results.push({ startMs: part.startMs, endMs: part.startMs, speaker: 0,
              channel: range.channel ?? 0, speakerLabel: "说明", notice: true,
              text: "从这里开始单独转写，说话人编号重新开始。" });
          }
          requestIndex++;
        }
      }
      signal.throwIfAborted();
      await meetingStore.writeTranscript(meeting, recording.recordingId, results, { append: gapsOnly, expectedFingerprint: fingerprint });
      persisted = true;
      await this.setState(meeting, recording.recordingId, "done", "", { gaps: [] });
      this.persistenceGaps.delete(`${meeting.id}:${recording.recordingId}`);
    } catch (error) {
      // Service messages are translated by the client. Raw transport failures
      // never become a user-facing error or a reason to resubmit automatically.
      const message = signal.aborted
        ? "转写已中断，录音和已有文字已保留；可手动重试"
        : error.userMessage || (error.code === "TRANSCRIPT_CHANGED"
          ? "转写文字在处理期间被修改，已保留修改，请确认后重新转写"
          : "这段转写未完成，录音和已有文字已保留；请检查网络与腾讯云设置后手动重试");
      await this.setState(meeting, recording.recordingId, "incomplete", persisted
        ? "文字已保存，但完成情况未能保存；请重新打开会议检查" : message).catch(() => {
        this.notify(meeting, recording.recordingId, "incomplete", message);
      });
    } finally {
      this.jobs.delete(recording.recordingId);
    }
  }

  async afterRecording(meeting, recording) {
    if (this.closing || recording.interrupted) return;
    if (!this.isConfigured()) {
      await this.setState(meeting, recording.recordingId, "incomplete", "尚未配置腾讯云转写服务，请打开会议设置");
      return;
    }
    if (recording.realtimeEnabled) {
      if (recording.channels === 1) return this.start(meeting, recording);
      if (!recording.gaps?.length && recording.transcriptionStatus === "done") return;
      if (this.plugin.controller.getPrefs().autoTranscribe && recording.gaps?.length) {
        return this.start(meeting, recording, { gapsOnly: true });
      }
    } else if (this.plugin.controller.getPrefs().autoTranscribe) {
      return this.start(meeting, recording);
    }
  }

  async resumePending(meeting) {
    if (!meeting?.id) return;
    const { recordings } = await meetingStore.readRecordings(meeting);
    for (const recording of recordings) {
      if (this.jobs.has(recording.recordingId)) continue;
      if (recording.deviceId !== this.deviceId) continue;
      const active = this.plugin.controller.snapshot?.();
      if (active?.recordingId === recording.recordingId && this.plugin.controller.isBusy()) continue;
      if (["recording", "processing"].includes(recording.transcriptionStatus)) {
        await this.setState(meeting, recording.recordingId, "incomplete", "上次转写未完成，可手动重试；不会自动再次计费");
      }
    }
  }

  cancel(recordingId) { this.jobs.get(recordingId)?.abort(); }
  shutdown() {
    this.closing = true;
    for (const job of this.jobs.values()) job.abort();
  }
}

module.exports = { TranscriptionManager };
