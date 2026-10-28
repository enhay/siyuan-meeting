"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const cloud = require("./cloud");
const { EventEmitter } = require("node:events");
const api = require("./siyuan-api");
const meetingStore = require("./meeting-store");
const tencent = require("./tencent");
const doubao = require("./doubao");
const { effectiveHotwords, validateHotwords } = require("./hotwords");

const CLIENTS = { doubao, tencent };
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
    this.progress = new Map();
    this.closing = false;
    this.persistenceGaps = new Map();
    this.appIds = new Map();
    this.deviceId = globalThis.localStorage?.getItem("siyuan-meeting.device") || crypto.randomUUID();
    globalThis.localStorage?.setItem("siyuan-meeting.device", this.deviceId);
  }

  subscribe(listener) {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  notify(meeting, recordingId, status, error = "", progress = null, appended = []) {
    const key = `${meeting.id}:${recordingId}`;
    this.status.set(key, status);
    this.errors.set(key, error);
    this.progress.set(key, progress);
    this.events.emit("change", { meetingId: meeting.id, recordingId, status, error, progress, appended });
  }

  statusFor(meetingId, recordingId) {
    const key = `${meetingId}:${recordingId}`;
    return { status: this.status.get(key) || "", error: this.errors.get(key) || "", progress: this.progress.get(key) || null };
  }

  isRunning(recordingId) { return this.jobs.has(recordingId); }

  // One service serves both realtime and post-meeting transcription.
  service() {
    return this.plugin.controller.getPrefs().transcriptionService === "tencent" ? "tencent" : "doubao";
  }

  config(service = this.service()) {
    if (service === "doubao") return { service, apiKey: secret(this.plugin, "meeting.doubao.apiKey") };
    return {
      service,
      secretId: secret(this.plugin, "meeting.tencent.secretId"),
      secretKey: secret(this.plugin, "meeting.tencent.secretKey"),
    };
  }

  isConfigured(service = this.service()) {
    return CLIENTS[service].isConfigured(this.config(service));
  }

  cosConfig() {
    const prefs = this.plugin.controller.getPrefs();
    return { ...this.config("tencent"), ...cloud.parseCosEndpoint(prefs.cosEndpoint) };
  }

  isFileConfigured() {
    try { return this.isConfigured() && tencent.isConfigured(this.cosConfig()); }
    catch { return false; }
  }

  async realtimeConfig() {
    const config = this.config("tencent");
    const key = crypto.createHash("sha256").update(`${config.secretId}:${config.secretKey}`).digest("hex");
    if (!this.appIds.has(key)) {
      const promise = tencent.getAppId(config).catch((error) => { this.appIds.delete(key); throw error; });
      this.appIds.set(key, promise);
    }
    return { ...config, appId: await this.appIds.get(key) };
  }

  jobDirectory(meetingId, recordingId) {
    const key = crypto.createHash("sha256").update(`${meetingId}:${recordingId}`).digest("hex");
    return path.join(this.plugin.controller.storageRoot, "transcriptions", key);
  }

  readJob(meetingId, recordingId) {
    const file = path.join(this.jobDirectory(meetingId, recordingId), "job.json");
    try {
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      if (job.meetingId !== meetingId || job.recordingId !== recordingId ||
          !Object.hasOwn(CLIENTS, job.service) || !/^[a-f0-9-]{36}$/.test(job.id) || !Array.isArray(job.parts) ||
          job.parts.some((part, index) => part.key !== `siyuan-meeting/${job.id}/${index}.wav`)) throw new Error("invalid job");
      return job;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw cloud.failure("本机转写任务记录无法读取，已停止重新提交，请保留任务文件检查");
    }
  }

  saveJob(job) {
    const dir = this.jobDirectory(job.meetingId, job.recordingId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "job.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  pendingFor(meetingId, recordingId) {
    const job = this.readJob(meetingId, recordingId);
    return job ? { saved: Boolean(job.saved), failed: Boolean(job.failed), phase: job.phase, canDiscard: job.failed || job.parts.every((part) => part.stage === "done") } : null;
  }

  async cleanup(job, signal) {
    const config = { ...this.config("tencent"), bucket: job.bucket, region: job.region };
    for (const part of job.parts) {
      if (!part.deleted && part.stage !== "prepared") {
        await cloud.remove(config, part.key, signal);
        part.deleted = true;
        this.saveJob(job);
      }
    }
    fs.rmSync(this.jobDirectory(job.meetingId, job.recordingId), { recursive: true, force: true });
  }

  async setState(meeting, recordingId, status, error = "", patch = {}, { publish = true, progress = null, appended } = {}) {
    await meetingStore.updateRecordingTranscription(meeting, recordingId, {
      transcriptionIssue: "", ...patch, transcriptionStatus: status, transcriptionError: error,
    });
    if (publish) this.notify(meeting, recordingId, status, error, progress, appended);
  }

  async onRealtime(meeting, recordingId, message) {
    const key = `${meeting.id}:${recordingId}`;
    if (message.meta) await meetingStore.ensureRecording(meeting, { ...message.meta, recordingId, deviceId: this.deviceId });
    let appended = [];
    if (message.segments?.length) {
      try {
        appended = await meetingStore.writeTranscript(meeting, recordingId, message.segments, { append: true });
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
      transcriptionIssue: message.configurationRequired && !missing.length ? "configuration-required" : "",
      gaps, ...(message.meta ? { realtimeEnabled: Boolean(message.meta.realtimeEnabled) } : {}),
    }, { appended });
    return { gaps, status, error };
  }

  async start(meeting, recording, { gapsOnly = false, expectedFingerprint, resume = false, queryOnly = false } = {}) {
    if (!meeting?.id || !recording?.recordingId) throw new Error("没有可转写的录音");
    if (this.closing || this.jobs.has(recording.recordingId)) return;
    if (!recording.assetPath) throw new Error("录音保存完成后才能转写");
    let job = this.readJob(meeting.id, recording.recordingId);
    if (!resume && job && !job.failed && !job.saved) throw new Error("这段录音还有未完成任务，请先继续原任务，避免重复识别");
    const controller = new AbortController();
    const { signal } = controller;
    this.jobs.set(recording.recordingId, controller);
    let outcome = { status: "incomplete", error: "", progress: null };
    let progress = { phase: "preparing" };
    const publish = (phase, patch = {}) => {
      progress = { ...progress, ...patch, phase };
      this.notify(meeting, recording.recordingId, "processing", "", progress);
    };
    publish("preparing");
    try {
      if (job?.saved) {
        publish("cleaning");
        await this.setState(meeting, recording.recordingId, "done", "", { gaps: [], fileHotwords: (job.hotwords || []).join(" ") }, { publish: false });
        await this.cleanup(job, signal);
        outcome = { status: "done", error: "", progress: { phase: "done" } };
        if (resume) return;
        job = null;
      }
      if (job?.failed) {
        await this.cleanup(job, signal);
        job = null;
        if (resume) {
          outcome = { status: "incomplete", error: "原任务已结束，临时录音已清理；可重新识别整段", progress: null };
          await this.setState(meeting, recording.recordingId, outcome.status, outcome.error, {}, { publish: false });
          return;
        }
      }
      if (!job) {
        if (queryOnly) return;
        if (!this.isFileConfigured()) throw cloud.failure("请先在会议设置中配置转写服务和腾讯云 COS");
        const currentMeeting = await meetingStore.getMeeting(meeting.id);
        const service = this.service();
        const hotwords = validateHotwords(effectiveHotwords(this.plugin.controller.getPrefs().hotwords, currentMeeting), service);
        const absolute = await api.resolveAssetPath(recording.assetPath);
        if (!absolute) throw cloud.failure("录音尚未同步到本机，请同步后重试");
        const ranges = gapsOnly ? mergeGaps((recording.gaps || []).map((gap) => ({ ...gap, channel: 0 }))) : [{}];
        if (!ranges.length) {
          outcome = { status: recording.transcriptionStatus || "done", error: "", progress: null };
          return;
        }
        const cos = this.cosConfig();
        job = { id: crypto.randomUUID(), meetingId: meeting.id, recordingId: recording.recordingId,
          service, bucket: cos.bucket, region: cos.region, createdAt: Date.now(),
          hotwords,
          fingerprint: expectedFingerprint ?? await meetingStore.transcriptFingerprint(meeting, recording.recordingId),
          gapsOnly, phase: "preparing", parts: [] };
        this.saveJob(job);
        const dir = this.jobDirectory(meeting.id, recording.recordingId);
        for (const [index, range] of ranges.entries()) {
          for await (const part of wavParts(absolute, { ...range, signal, directory: dir, prefix: `range-${index}`,
            maxBytes: job.service === "doubao" ? 512000000 - 1 : 1000000000 })) {
            job.parts.push({ name: path.basename(part.file), startMs: part.startMs, endMs: part.endMs,
              key: `siyuan-meeting/${job.id}/${job.parts.length}.wav`, stage: "prepared", requestId: crypto.randomUUID() });
          }
        }
        job.phase = "ready";
        this.saveJob(job);
      }
      if (job.phase === "preparing") {
        job.failed = true;
        this.saveJob(job);
        throw cloud.failure("上次录音准备未完成，请重新识别整段");
      }
      if (job.phase === "saving") {
        const current = await meetingStore.transcriptFingerprint(meeting, recording.recordingId);
        if (current !== job.fingerprint) throw cloud.failure("上次保存结果时中断，文字已有变化；请先检查现有文字，再决定是否放弃本次结果");
        job.phase = "ready";
        this.saveJob(job);
      }
      const config = this.config(job.service);
      const cos = { ...this.config("tencent"), bucket: job.bucket, region: job.region };
      await this.setState(meeting, recording.recordingId, "processing", "", {}, { publish: false });
      publish("preparing", { partCount: job.parts.length, completedParts: job.parts.filter((part) => part.stage === "done").length });
      for (const part of job.parts) {
        if (part.stage === "done") continue;
        signal.throwIfAborted();
        if (part.stage === "submitting" && !part.taskId) {
          // A lost submit response cannot prove whether a billable task exists.
          if (Date.now() - part.submittedAt >= 24 * 3600 * 1000) {
            job.failed = true;
            this.saveJob(job);
          }
          throw cloud.failure("上次提交结果不确定，未自动再次计费；请核对云端调用。24 小时后可重新识别");
        }
        if (!part.taskId) {
          if (queryOnly) throw cloud.failure("上次任务尚未全部提交，点击「继续原任务」完成剩余部分");
          publish("uploading");
          if (!/^range-\d+-\d+\.wav$/.test(part.name)) throw cloud.failure("本机录音临时文件名无效");
          part.stage = "uploading";
          this.saveJob(job);
          await cloud.upload(cos, part.key, path.join(this.jobDirectory(meeting.id, recording.recordingId), part.name), signal);
          part.stage = "submitting";
          part.submittedAt = Date.now();
          this.saveJob(job);
          publish("submitting");
          try {
            part.taskId = await CLIENTS[job.service].submit(config, cloud.downloadUrl(cos, part.key), part.requestId, signal, job.hotwords);
          } catch (error) {
            if (error.rejected) { part.stage = "rejected"; job.failed = true; this.saveJob(job); }
            throw error;
          }
          part.stage = "submitted";
          this.saveJob(job);
          fs.rmSync(path.join(this.jobDirectory(meeting.id, recording.recordingId), part.name), { force: true });
        }
        publish("recognizing");
        while (true) {
          signal.throwIfAborted();
          if (job.service === "tencent" && Date.now() - part.submittedAt >= 24 * 3600 * 1000) {
            job.failed = true;
            this.saveJob(job);
            throw cloud.failure("云端任务已超过查询有效期，请重新识别整段");
          }
          let segments;
          try { segments = await CLIENTS[job.service].query(config, part.taskId, signal); }
          catch (error) {
            if (error.terminal) { job.failed = true; this.saveJob(job); }
            throw error;
          }
          if (segments !== null) {
            const duration = part.endMs - part.startMs;
            if (segments.some((segment) => segment.startMs > duration || segment.endMs > duration + 1000)) {
              throw cloud.failure("识别结果时间超出录音范围，未覆盖已有文字");
            }
            part.segments = segments.map((segment) => ({ ...segment, channel: 0,
              startMs: part.startMs + segment.startMs, endMs: Math.min(part.endMs, part.startMs + segment.endMs) }));
            part.stage = "done";
            this.saveJob(job);
            break;
          }
          await delay(5000, undefined, { signal });
        }
        publish("recognizing", { completedParts: job.parts.filter((part) => part.stage === "done").length });
      }
      const results = job.parts.flatMap((part, index) => [
        ...(index || job.gapsOnly ? [{ startMs: part.startMs, endMs: part.startMs, channel: 0, speaker: 0,
          speakerLabel: "说明", notice: true, text: "从这里开始单独转写，说话人编号重新开始。" }] : []), ...part.segments,
      ]);
      publish("saving");
      job.phase = "saving";
      this.saveJob(job);
      try {
        await meetingStore.writeTranscript(meeting, recording.recordingId, results, {
          append: job.gapsOnly, expectedFingerprint: job.fingerprint,
        });
      } catch (error) {
        // Retry saving only when the previous text is still exactly intact.
        const current = await meetingStore.transcriptFingerprint(meeting, recording.recordingId).catch(() => null);
        if (current === job.fingerprint) { job.phase = "ready"; this.saveJob(job); }
        throw error;
      }
      job.saved = true;
      job.phase = "cleaning";
      this.saveJob(job);
      await this.setState(meeting, recording.recordingId, "done", "", { gaps: [], fileHotwords: (job.hotwords || []).join(" ") }, { publish: false });
      this.persistenceGaps.delete(`${meeting.id}:${recording.recordingId}`);
      publish("cleaning");
      await this.cleanup(job, signal);
      outcome = { status: "done", error: "", progress: { ...progress, phase: "done" } };
    } catch (error) {
      this.plugin.controller.recordTranscriptionFailure({ meetingId: meeting.id, recordingId: recording.recordingId, phase: progress.phase, error });
      const message = signal.aborted ? "本机处理已停止；重开会议后可继续查询原任务"
        : error.code === "TRANSCRIPT_CHANGED" ? "识别期间文字被修改，已保留修改；请先处理原任务"
          : error.userMessage || "转写未完成，录音和已有文字已保留；可继续原任务";
      outcome = { status: job?.saved ? "done" : "incomplete", error: message,
        progress: { ...progress, phase: job?.saved ? "cleanup-failed" : "incomplete" } };
      await this.setState(meeting, recording.recordingId, outcome.status, message, {}, { publish: false }).catch(() => {});
    } finally {
      this.jobs.delete(recording.recordingId);
      this.notify(meeting, recording.recordingId, outcome.status, outcome.error, outcome.progress);
    }
  }

  async discard(meeting, recording) {
    if (this.isRunning(recording.recordingId)) return;
    const job = this.readJob(meeting.id, recording.recordingId);
    if (!job) return;
    // Only completed recognition can be discarded without cutting off a provider download.
    if (!job.parts.every((part) => part.stage === "done") && !job.failed) throw new Error("原任务尚未结束，请先继续原任务");
    await this.cleanup(job);
    await this.setState(meeting, recording.recordingId, job.saved ? "done" : "incomplete", "");
  }

  async afterRecording(meeting, recording) {
    if (this.closing || recording.interrupted) return;
    if (!this.isConfigured()) {
      await this.setState(meeting, recording.recordingId, "incomplete", "尚未配置转写服务，请打开会议设置", { transcriptionIssue: "configuration-required" });
      return;
    }
    if (recording.realtimeEnabled) {
      if (!recording.gaps?.length && recording.transcriptionStatus === "done") return;
      if (this.plugin.controller.getPrefs().autoFillGaps !== false && recording.gaps?.length) {
        return this.start(meeting, recording, { gapsOnly: true });
      }
    }
  }

  async resumePending(meeting) {
    if (!meeting?.id) return;
    const { recordings } = await meetingStore.readRecordings(meeting);
    for (const recording of recordings) {
      if (this.jobs.has(recording.recordingId)) continue;
      const pending = this.readJob(meeting.id, recording.recordingId);
      if (pending) {
        void this.start(meeting, recording, { resume: true, queryOnly: true }).catch(() => {});
        continue;
      }
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
