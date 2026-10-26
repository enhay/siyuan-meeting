class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.buffer = new Float32Array(sampleRate * this.channels);
    this.used = 0;
    this.peaks = [0, 0];
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
    if (!this.used) return;
    if (this.pending) {
      this.active = false;
      this.port.postMessage({ error: "磁盘未及时接收音频，已停止采集；已写入部分仍可恢复" });
      return;
    }
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ samples, peaks: this.peaks }, [samples.buffer]);
    this.pending = true;
    this.used = 0;
    this.peaks = [0, 0];
  }
  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    if (!input.length) return true;
    for (let frame = 0; frame < input[0].length; frame++) {
      for (let channel = 0; channel < this.channels; channel++) {
        const value = input[channel]?.[frame] || 0;
        this.buffer[this.used++] = value;
        this.peaks[channel] = Math.max(this.peaks[channel], Math.abs(value));
      }
      if (this.used === this.buffer.length) {
        this.flush();
        if (!this.active) return true;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
