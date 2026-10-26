"use strict";

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.framesPerBuffer = Math.max(1, Math.round(sampleRate));
    this.buffer = new Float32Array(this.framesPerBuffer * this.channels);
    this.used = 0;
    this.frames = 0;
    this.peaks = new Array(this.channels).fill(0);
    this.sums = new Array(this.channels).fill(0);
    this.pending = false;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data === "ack") this.pending = false;
      if (data === "flush") {
        this.active = false;
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }

  flush() {
    if (!this.used) {
      this.port.postMessage({ flushedEmpty: true });
      return;
    }
    if (this.pending) {
      this.active = false;
      this.port.postMessage({
        error: "磁盘未及时接收音频，已停止采集；已写入部分仍可恢复",
      });
      return;
    }
    const samples = this.buffer.slice(0, this.used);
    const frames = this.frames;
    const peaks = this.peaks.slice();
    const rms = this.sums.map((sum) => Math.sqrt(Math.max(0, sum) / Math.max(1, frames)));
    this.port.postMessage({ samples, peaks, rms, frames }, [samples.buffer]);
    this.pending = true;
    this.used = 0;
    this.frames = 0;
    this.peaks = new Array(this.channels).fill(0);
    this.sums = new Array(this.channels).fill(0);
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    if (!input.length) return true;
    const length = input[0].length;
    for (let frame = 0; frame < length; frame++) {
      for (let channel = 0; channel < this.channels; channel++) {
        const value = input[channel]?.[frame] || 0;
        this.buffer[this.used++] = value;
        const absolute = Math.abs(value);
        if (absolute > this.peaks[channel]) this.peaks[channel] = absolute;
        this.sums[channel] += value * value;
      }
      this.frames++;
      if (this.used >= this.buffer.length) {
        this.flush();
        if (!this.active) return true;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
