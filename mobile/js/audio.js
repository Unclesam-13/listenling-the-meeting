// 手机麦克风 -> 16kHz 16bit 单声道 PCM（每 100ms 一块），交给识别服务。
// 使用 AudioWorklet 在音频线程里降采样，iOS 14.5+ / 安卓 Chrome 都支持。

const WORKLET = `
class PCM16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;   // 输入采样率 / 16000
    this.pos = 0;                      // 下一个输出样本在输入流中的位置（小数）
    this.prev = 0;                     // 上一块最后一个样本，用于跨块插值
    this.out = new Int16Array(1600);   // 100ms
    this.n = 0;
    this.level = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const len = ch.length, half = Math.floor(this.ratio / 2);
    // 把上一块的最后一个样本看成 x[-1]，在 x[i] 和 x[i+1] 之间取值
    while (this.pos < len - 1) {
      const i = Math.floor(this.pos), f = this.pos - i;
      let v;
      if (this.ratio >= 2) {        // 48k / 44.1k -> 16k：取附近几个样本的平均，顺便滤掉高频
        let s = 0, c = 0;
        for (let k = Math.max(0, i - half); k <= Math.min(len - 1, i + half); k++) { s += ch[k]; c++; }
        v = c ? s / c : 0;
      } else {                      // 其他采样率：线性插值
        const a = i < 0 ? this.prev : ch[i];
        v = a + (ch[i + 1] - a) * f;
      }
      v = Math.max(-1, Math.min(1, v));
      this.level = Math.max(this.level * 0.995, Math.abs(v));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer, level: this.level }, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= len;
    this.prev = ch[len - 1];
    return true;
  }
}
registerProcessor("pcm16", PCM16);
`;

export class Mic {
  constructor(onPCM, onLevel) {
    this.onPCM = onPCM;
    this.onLevel = onLevel || (() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }

  // iOS 要求在用户点击时创建音频环境：ctx 由点击处理函数提前同步创建后传进来
  async start(ctx) {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error("这个浏览器不支持录音。iPhone 请用 Safari（iOS 14.5 以上）打开，安卓请用 Chrome 打开");
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = ctx || new AC();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm16");
    this.node.port.onmessage = (e) => { this.onPCM(e.data.pcm); this.onLevel(e.data.level); };
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // 接到输出才能保证 worklet 持续运行，但不发出声音
    src.connect(this.node).connect(mute).connect(this.ctx.destination);
    return this.stream.getAudioTracks()[0]?.label || "麦克风";
  }

  async resume() {
    if (this.ctx && this.ctx.state !== "running") {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
  }

  get alive() {
    return !!this.stream && this.stream.getAudioTracks().some(t => t.readyState === "live");
  }

  stop() {
    try { this.node?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach(t => t.stop());
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = this.stream = this.node = null;
  }
}
