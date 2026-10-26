"use strict";

const zlib = require("node:zlib");

// The service accepts audio at its original rate. Keep at most one allowed
// packet-gap worth of unsent audio; longer outages are repaired from the WAV.
const PACKET_MS = 200;
const BUFFER_MS = 6000;
const FINISH_MS = 3000;
// Final sentences reach the meeting document in batches; captions are live.
const FLUSH_MS = 10000;
// Account-level rejections do not recover within one recording segment.
const TENCENT_ACCOUNT_ERRORS = {
  4002: "腾讯云验证未通过，实时转写没有进行；录音仍在保存，请检查会议设置中的配置和电脑时间。",
  4003: "腾讯云实时语音识别尚未开通，实时转写没有进行；录音仍在保存，结束后可以补齐转写。",
  4004: "腾讯云实时转写额度已用完，实时转写没有进行；录音仍在保存，结束后可以补齐转写。",
  4005: "腾讯云账户已欠费，实时转写没有进行；录音仍在保存，结束后可以补齐转写。",
};
const LARGE_ENGINE_HINT = "腾讯云大模型实时识别未开通或额度不足，实时转写没有进行；录音仍在保存，可在会议设置中改用通用引擎。";
const DOUBAO_ACCOUNT_ERRORS = {
  45000010: "豆包验证未通过，实时转写没有进行；录音仍在保存，请检查会议设置中的 API Key。",
  45000030: "豆包流式语音识别 2.0 尚未开通按小时计费，实时转写没有进行；录音仍在保存，结束后可以补齐转写。",
  45000292: "豆包实时转写额度不足，实时转写没有进行；录音仍在保存，结束后可以补齐转写。",
};
const TEMPORARY_ERROR = "实时转写暂时不可用，录音仍在保存；结束后可以补齐转写。";

// Each service turns its wire format into the same events: `ack` (the session
// accepts audio), `partial`/`final` sentences relative to the session start,
// `done` after the end of audio, or `error` with `account` set when
// reconnecting cannot help.
const PROTOCOLS = {
  tencent: {
    open() {},
    audio(data) { return data; },
    end() { return JSON.stringify({ type: "end" }); },
    parse(raw, channel) {
      const data = JSON.parse(raw);
      const code = Number(data.code);
      if (code !== 0) {
        const account = Object.hasOwn(TENCENT_ACCOUNT_ERRORS, code);
        return [{ error: !account ? TEMPORARY_ERROR
          : channel.owner.engine === "large" && code !== 4002 ? LARGE_ENGINE_HINT : TENCENT_ACCOUNT_ERRORS[code], account }];
      }
      const events = [{ ack: true }];
      const result = data.result;
      const index = Number(result?.index);
      if (result && index > channel.lastIndex) {
        const text = String(result.voice_text_str || "").trim();
        if ([0, 1].includes(Number(result.slice_type))) events.push({ partial: text });
        if (Number(result.slice_type) === 2) {
          channel.lastIndex = index;
          events.push({ final: { start: Number(result.start_time), end: Number(result.end_time), text, speaker: null } });
        }
      }
      if (Number(data.final) === 1) events.push({ done: true });
      return events;
    },
  },
  // Binary frames: 4-byte header, optional sequence, payload size, gzip payload.
  doubao: {
    frame(type, flags, serialization, payload) {
      const body = zlib.gzipSync(payload);
      const frame = Buffer.alloc(8 + body.length);
      frame.set([0x11, (type << 4) | flags, (serialization << 4) | 1, 0]);
      frame.writeUInt32BE(body.length, 4);
      body.copy(frame, 8);
      return frame;
    },
    open(socket, channel) {
      const speakers = channel.owner.channels === 1 || channel.channel === 1;
      socket.send(this.frame(1, 0, 1, JSON.stringify({
        user: { uid: "siyuan-meeting" },
        audio: { format: "pcm", codec: "raw", rate: channel.owner.sampleRate, bits: 16, channel: 1 },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: true,
          result_type: "single", end_window_size: 600, ...(speakers ? { enable_speaker_info: true } : {}) },
      })));
    },
    audio(data) { return this.frame(2, 0, 0, Buffer.from(data)); },
    end() { return this.frame(2, 2, 0, Buffer.alloc(0)); },
    parse(raw) {
      const buffer = Buffer.from(raw);
      const type = buffer[1] >> 4;
      const flags = buffer[1] & 15;
      if (type === 15) {
        const code = buffer.readUInt32BE(4);
        const account = String(code).startsWith("45");
        return [{ error: DOUBAO_ACCOUNT_ERRORS[code]
          || (account ? "豆包无法处理实时转写请求，实时转写没有进行；录音仍在保存，结束后可以补齐转写。" : TEMPORARY_ERROR), account }];
      }
      if (type !== 9) throw new Error("unexpected frame");
      const offset = flags & 1 ? 8 : 4;
      const size = buffer.readUInt32BE(offset);
      let payload = buffer.subarray(offset + 4, offset + 4 + size);
      if ((buffer[2] & 15) === 1) payload = zlib.gunzipSync(payload);
      const data = payload.length ? JSON.parse(payload.toString("utf8")) : {};
      const events = [{ ack: true }];
      for (const utterance of data.result?.utterances || []) {
        const text = String(utterance.text || "").trim();
        if (!utterance.definite) events.push({ partial: text });
        else {
          const speaker = Number(utterance.additions?.speaker_id);
          // Zero-valued fields are omitted by the service.
          events.push({ final: { start: Number(utterance.start_time ?? 0), end: Number(utterance.end_time), text,
            speaker: Number.isInteger(speaker) && speaker >= 0 ? speaker : null } });
        }
      }
      if ((flags & 2) === 2) events.push({ done: true });
      return events;
    },
  },
};

function speakerLabel(owner, channel, speaker) {
  if (owner.channels === 2) {
    if (channel === 0) return "我";
    return speaker > 0 ? `其他参会者 ${speaker + 1}` : "其他参会者";
  }
  return speaker === null ? "说话人" : `说话人 ${speaker + 1}`;
}

function mergeGaps(gaps) {
  const result = [];
  for (const gap of gaps.filter((item) => item.endMs > item.startMs)
    .sort((a, b) => a.channel - b.channel || a.startMs - b.startMs)) {
    const last = result[result.length - 1];
    if (last && last.channel === gap.channel && gap.startMs <= last.endMs + 0.1) {
      last.endMs = Math.max(last.endMs, gap.endMs);
    } else result.push({ ...gap });
  }
  return result;
}

class RealtimeChannel {
  constructor(owner, channel) {
    this.owner = owner;
    this.channel = channel;
    this.queue = [];
    this.socket = null;
    this.connecting = false;
    this.ready = false;
    this.closed = false;
    this.rejected = false;
    this.ending = false;
    this.sentEnd = 0;
    this.confirmedEnd = 0;
    this.base = null;
    this.lastIndex = -1;
    this.retryAt = 0;
    this.nextSendAt = 0;
    this.sessions = 0;
    this.timer = setInterval(() => this.tick(), 20);
  }

  push(packet) {
    this.queue.push(packet);
    let dropped = false;
    while (this.queue.length && this.queue[this.queue.length - 1].endMs - this.queue[0].startMs > BUFFER_MS) {
      const first = this.queue.shift();
      this.owner.gap(first.startMs, first.endMs, this.channel);
      dropped = true;
    }
    if (dropped && this.base !== null) this.disconnect();
    void this.tick();
  }

  async connect() {
    if (this.connecting || this.closed || this.socket || !this.queue.length) return;
    this.connecting = true;
    try {
      const url = await this.owner.requestUrl(this.channel);
      if (this.closed || this.ending && !this.queue.length) return;
      const socket = new this.owner.WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      this.ready = false;
      this.base = null;
      this.lastIndex = -1;
      this.sessionSpoke = false;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        try { this.owner.protocol.open(socket, this); } catch { this.disconnect(); }
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          for (const item of this.owner.protocol.parse(event.data, this)) {
            if (this.socket !== socket) return;
            if (item.error) {
              this.rejected = item.account;
              this.owner.notice(item.error);
              this.disconnect();
              return;
            }
            if (item.ack && !this.ready) {
              this.ready = true;
              this.sessions++;
              if (this.owner.connections.every((connection) => connection === this || connection.ready)) {
                this.owner.error = "";
              }
            }
            const label = this.owner.channels === 2 ? (this.channel === 0 ? "我" : "其他参会者") : "";
            if (typeof item.partial === "string" && this.base !== null) {
              this.owner.caption({ channel: this.channel, label, text: item.partial, final: false });
            }
            if (item.final && this.base !== null) {
              const { start, end, text, speaker } = item.final;
              if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > this.sentEnd - this.base + 1000) {
                this.disconnect();
                return;
              }
              this.confirmedEnd = Math.max(this.confirmedEnd, Math.min(this.sentEnd, this.base + end));
              if (text) {
                // Speaker numbers only hold within one service session.
                if (speaker !== null && !this.sessionSpoke && this.sessions > 1 && this.spoke) {
                  this.owner.sentences.push({ startMs: this.base + start, endMs: this.base + start, speaker: 0,
                    channel: this.channel, speakerLabel: "说明", notice: true,
                    text: "实时转写在这里重新连接，说话人编号重新开始。" });
                }
                this.sessionSpoke = this.spoke = true;
                this.owner.sentences.push({
                  startMs: this.base + start,
                  endMs: Math.min(this.sentEnd, this.base + end),
                  speaker: speaker ?? 0,
                  channel: this.channel,
                  speakerLabel: speakerLabel(this.owner, this.channel, speaker),
                  text,
                });
              }
              this.owner.caption({ channel: this.channel, label, text, final: true });
            }
            if (item.done) {
              this.confirmedEnd = this.sentEnd;
              this.disconnect(false);
              this.finishResolve?.();
              return;
            }
          }
        } catch {
          this.owner.notice("实时转写返回内容无法读取，录音仍在保存；结束后可以补齐转写。");
          this.disconnect();
        }
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        this.owner.notice("实时转写连接中断，录音仍在保存；结束后可以补齐转写。");
        this.disconnect();
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.owner.notice("实时转写连接中断，录音仍在保存；结束后可以补齐转写。");
          this.disconnect();
        }
      };
      // A connection that never completes the service handshake must not hold
      // the bounded audio queue forever.
      this.handshakeTimer = setTimeout(() => {
        if (this.socket === socket && !this.ready) {
          this.owner.notice("实时转写连接未能建立，录音仍在保存；结束后可以补齐转写。");
          this.disconnect();
        }
      }, BUFFER_MS);
    } catch {
      this.owner.notice("实时转写连接失败，录音仍在保存；结束后可以补齐转写。");
      this.retryAt = Date.now() + 1000;
    } finally {
      this.connecting = false;
    }
  }

  disconnect(unconfirmed = true) {
    clearTimeout(this.handshakeTimer);
    if (unconfirmed && this.base !== null) this.owner.gap(this.confirmedEnd, this.sentEnd, this.channel);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.base = null;
    this.retryAt = Date.now() + 1000;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* already closed */ }
    }
  }

  async tick() {
    if (this.closed || Date.now() < this.nextSendAt) return;
    if (!this.socket) {
      if (!this.rejected && Date.now() >= this.retryAt) void this.connect();
      return;
    }
    if (!this.ready || this.socket.readyState !== 1 || !this.queue.length || this.socket.bufferedAmount) return;
    const packet = this.queue.shift();
    if (this.base === null) {
      this.base = packet.startMs;
      this.sentEnd = packet.startMs;
      this.confirmedEnd = packet.startMs;
    }
    if (Math.abs(packet.startMs - this.sentEnd) > 0.1) {
      this.queue.unshift(packet);
      this.disconnect();
      return;
    }
    try {
      this.socket.send(this.owner.protocol.audio(packet.data));
      this.sentEnd = packet.endMs;
      this.nextSendAt = Date.now() + packet.endMs - packet.startMs;
    } catch {
      this.queue.unshift(packet);
      this.disconnect();
    }
  }

  pending() {
    const gaps = [];
    if (this.base !== null && this.sentEnd > this.confirmedEnd) {
      gaps.push({ startMs: this.confirmedEnd, endMs: this.sentEnd, channel: this.channel });
    }
    if (this.queue.length) gaps.push({
      startMs: this.queue[0].startMs,
      endMs: this.queue[this.queue.length - 1].endMs,
      channel: this.channel,
    });
    return gaps;
  }

  async finish() {
    this.ending = true;
    const deadline = Date.now() + BUFFER_MS;
    while (this.queue.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    this.closed = true;
    clearInterval(this.timer);
    if (this.socket?.readyState === 1 && this.ready && this.base !== null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, FINISH_MS);
        this.finishResolve = () => { clearTimeout(timer); resolve(); };
        try { this.socket.send(this.owner.protocol.end()); } catch { this.finishResolve(); }
      });
    }
    for (const gap of this.pending()) this.owner.gap(gap.startMs, gap.endMs, gap.channel);
    this.queue = [];
    this.disconnect();
    this.finishResolve = null;
  }

  reject(error) {
    this.rejected = true;
    this.owner.notice(error);
    this.disconnect();
  }

  abort() {
    this.closed = true;
    clearInterval(this.timer);
    for (const gap of this.pending()) this.owner.gap(gap.startMs, gap.endMs, gap.channel);
    this.queue = [];
    this.disconnect();
    this.finishResolve?.();
  }
}

class RealtimeTranscriber {
  constructor({ service, sampleRate, channels, enabled, configured, engine = "large", requestUrl, emit, caption = () => {},
    WebSocket: Socket = globalThis.WebSocket }) {
    if (!Object.hasOwn(PROTOCOLS, service)) throw new Error("unknown transcription service");
    this.protocol = PROTOCOLS[service];
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.enabled = enabled;
    this.configured = configured;
    this.engine = engine;
    this.requestUrl = requestUrl;
    this.emit = emit;
    this.caption = caption;
    this.WebSocket = Socket;
    this.gaps = [];
    this.sentences = [];
    this.error = enabled && !configured ? "尚未配置转写服务，实时转写没有进行；录音仍在保存，可在会议设置中配置。" : "";
    this.lastReport = 0;
    this.reported = "";
    this.finished = false;
    this.resume();
  }

  resume() {
    this.connections = this.enabled && this.configured
      ? Array.from({ length: this.channels }, (_, channel) => new RealtimeChannel(this, channel)) : [];
  }

  gap(startMs, endMs, channel) {
    if (endMs > startMs) this.gaps = mergeGaps([...this.gaps, { startMs, endMs, channel }]);
  }

  notice(error) {
    if (error === this.error) return;
    this.error = error;
    this.report();
  }

  snapshotGaps() {
    return mergeGaps([...this.gaps, ...this.connections.flatMap((connection) => connection.pending())]);
  }

  report(final = false) {
    this.lastReport = Date.now();
    const gaps = this.snapshotGaps();
    const update = {
      gaps,
      status: !this.enabled ? "none"
        : !this.configured ? "incomplete"
          : final ? (!gaps.length ? "done" : "incomplete") : "recording",
      error: this.error,
      configurationRequired: this.enabled && !this.configured,
      final,
    };
    const reported = JSON.stringify(update);
    if (!final && !this.sentences.length && reported === this.reported) return;
    this.reported = reported;
    this.emit({ segments: this.sentences.splice(0), ...update });
  }

  push(samples, startMs) {
    const frames = samples.length / this.channels;
    const endMs = startMs + frames / this.sampleRate * 1000;
    if (!this.enabled) return;
    if (!this.configured) {
      for (let channel = 0; channel < this.channels; channel++) this.gap(startMs, endMs, channel);
    } else {
      const packetFrames = Math.round(this.sampleRate * PACKET_MS / 1000);
      for (let offset = 0; offset < frames; offset += packetFrames) {
        const count = Math.min(packetFrames, frames - offset);
        for (let channel = 0; channel < this.channels; channel++) {
          const data = new ArrayBuffer(count * 2);
          const view = new DataView(data);
          for (let i = 0; i < count; i++) {
            const sample = Math.max(-1, Math.min(1, samples[(offset + i) * this.channels + channel]));
            view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
          }
          this.connections[channel]?.push({
            data,
            startMs: startMs + offset / this.sampleRate * 1000,
            endMs: startMs + (offset + count) / this.sampleRate * 1000,
          });
        }
      }
    }
    if (Date.now() - this.lastReport >= FLUSH_MS) this.report();
  }

  // The main window saw the service refuse the account during the handshake.
  reject(error) {
    for (const connection of this.connections) connection.reject(error);
  }

  async pause() {
    await Promise.all(this.connections.map((connection) => connection.finish()));
    this.connections = [];
    this.report();
  }

  async finish() {
    await this.pause();
    this.finished = true;
    this.report(true);
  }

  abort() {
    if (this.finished) return;
    this.finished = true;
    if (this.enabled) {
      this.configured = false;
      this.error = this.error || "实时转写已中断，录音仍可保存；结束后可以补齐转写。";
    }
    for (const connection of this.connections) connection.abort();
    this.connections = [];
    this.report(true);
  }
}

module.exports = { RealtimeTranscriber, mergeGaps };
