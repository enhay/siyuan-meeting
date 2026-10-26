"use strict";

// The service accepts audio at its original rate. Keep at most one allowed
// packet-gap worth of unsent audio; longer outages are repaired from the WAV.
const PACKET_MS = 200;
const BUFFER_MS = 6000;
const FINISH_MS = 3000;

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
    this.ending = false;
    this.sentEnd = 0;
    this.confirmedEnd = 0;
    this.base = null;
    this.lastIndex = -1;
    this.retryAt = 0;
    this.nextSendAt = 0;
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
      this.socket = socket;
      this.ready = false;
      this.base = null;
      this.lastIndex = -1;
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          const data = JSON.parse(event.data);
          if (Number(data.code) !== 0) {
            this.owner.notice("实时转写暂时不可用，录音仍在保存；结束后可以补齐转写。");
            this.disconnect();
            return;
          }
          this.ready = true;
          if (this.owner.connections.every((connection) => connection === this || connection.ready)) {
            this.owner.error = "";
          }
          const result = data.result;
          if (Number(result?.slice_type) === 2 && this.base !== null && Number(result.index) > this.lastIndex) {
            const start = Number(result.start_time);
            const end = Number(result.end_time);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > this.sentEnd - this.base + 1000) {
              this.disconnect();
              return;
            }
            this.lastIndex = Number(result.index);
            this.confirmedEnd = Math.max(this.confirmedEnd, Math.min(this.sentEnd, this.base + end));
            const text = String(result.voice_text_str || "").trim();
            this.owner.report(text ? [{
              startMs: this.base + start,
              endMs: Math.min(this.sentEnd, this.base + end),
              speaker: 0,
              channel: this.channel,
              speakerLabel: this.owner.channels === 2 ? (this.channel === 0 ? "我" : "其他参会者") : "说话人 1",
              text,
            }] : []);
          }
          if (Number(data.final) === 1) {
            this.confirmedEnd = this.sentEnd;
            this.disconnect(false);
            this.finishResolve?.();
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
      if (Date.now() >= this.retryAt) void this.connect();
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
      this.socket.send(packet.data);
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
        try { this.socket.send(JSON.stringify({ type: "end" })); } catch { this.finishResolve(); }
      });
    }
    for (const gap of this.pending()) this.owner.gap(gap.startMs, gap.endMs, gap.channel);
    this.queue = [];
    this.disconnect();
    this.finishResolve = null;
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
  constructor({ sampleRate, channels, enabled, configured, requestUrl, emit, WebSocket: Socket = globalThis.WebSocket }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.enabled = enabled;
    this.configured = configured;
    this.requestUrl = requestUrl;
    this.emit = emit;
    this.WebSocket = Socket;
    this.gaps = [];
    this.error = enabled && !configured ? "尚未配置腾讯云，实时转写没有进行；录音仍在保存，可在会议设置中配置。" : "";
    this.lastReport = 0;
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
    this.error = error;
    this.report();
  }

  snapshotGaps() {
    return mergeGaps([...this.gaps, ...this.connections.flatMap((connection) => connection.pending())]);
  }

  report(segments = [], final = false) {
    this.lastReport = Date.now();
    const gaps = this.snapshotGaps();
    this.emit({
      segments,
      gaps,
      status: !this.enabled ? "none"
        : !this.configured ? "incomplete"
          : final ? (!gaps.length && this.channels === 2 ? "done" : "incomplete") : "recording",
      error: this.error,
      final,
    });
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
    if (Date.now() - this.lastReport >= 1000) this.report();
  }

  async pause() {
    await Promise.all(this.connections.map((connection) => connection.finish()));
    this.connections = [];
    this.report();
  }

  async finish() {
    await this.pause();
    this.finished = true;
    this.report([], true);
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
    this.report([], true);
  }
}

module.exports = { RealtimeTranscriber, mergeGaps };
