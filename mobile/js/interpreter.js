// 同声传译：OpenAI gpt-realtime-translate（语音进、翻译后的语音出），浏览器直接用 WebRTC 连接。
// 文档：https://developers.openai.com/api/docs/guides/realtime-translation
//
// 双向时开两路会话，都听同一个麦克风：
//   · 目标中文：别人说外语 -> 翻成中文读给我听（我说中文时模型不会重复翻译）
//   · 目标对方语言（默认英文）：我说中文 -> 翻成英文外放给对方听（对方说英文时不会重复翻译）
// 外放时，翻译出来的声音会被麦克风录回去：播放期间暂停收音（两路同传和字幕识别都暂停），播完自动恢复。

const SECRET_URL = "https://api.openai.com/v1/realtime/translations/client_secrets";
const CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
const MODEL = "gpt-realtime-translate";

export const OUTPUT_LANGS = {
  en: "English 英文", ja: "日本語 日文", ko: "한국어 韩文", fr: "Français 法文", de: "Deutsch 德文", es: "Español 西班牙文",
  pt: "Português 葡萄牙文", ru: "Русский 俄文", it: "Italiano 意大利文", hi: "हिन्दी 印地文", id: "Bahasa Indonesia 印尼文", vi: "Tiếng Việt 越南文",
};

class Channel {
  /**
   * 一路同传会话（一个目标语言）
   * opts: { key, lang, track, onText(text, final), onSource(text), onError(msg), onState(state) }
   */
  constructor(opts) {
    this.o = opts;
    this.pc = null;
    this.audio = null;
    this.level = 0;
    this.lastOutAt = 0;
    this.text = "";
    this.closed = false;
  }

  async start(audioCtx) {
    const { key, lang } = this.o;
    // 1) 用 OpenAI Key 换一个短期会话凭证
    let r;
    try {
      r = await fetch(SECRET_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: { model: MODEL, audio: { output: { language: lang } } } }),
      });
    } catch (e) {
      throw new Error("无法连接 OpenAI 同传服务（可能是网络问题，或 OpenAI 不允许手机网页直接创建同传会话）");
    }
    if (!r.ok) {
      let m = ""; try { m = (await r.json()).error?.message || ""; } catch { /* ignore */ }
      const hint = { 401: "OpenAI Key 无效", 403: "这个 Key 没有同传模型的权限", 429: "调用太频繁或额度用完" }[r.status] || "";
      throw new Error(`同传连接失败（${r.status}${hint ? " " + hint : ""}）${m ? "：" + m : ""}`);
    }
    const secret = (await r.json()).value;
    if (!secret) throw new Error("同传连接失败：没有拿到会话凭证");

    // 2) WebRTC：发送麦克风，接收翻译后的语音
    const PC = window.__mcFakeRTC || window.RTCPeerConnection; // 测试时可以换成模拟的连接
    if (!PC) throw new Error("这个浏览器不支持实时通话（WebRTC），无法同传");
    const pc = (this.pc = new PC());
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.playsInline = true;
    pc.ontrack = ({ streams }) => {
      this.audio.srcObject = streams[0];
      this.audio.play?.().catch(() => {});
      this.watchLevel(audioCtx, streams[0]);
    };
    pc.addTrack(this.o.track, new MediaStream([this.o.track]));
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = (ev) => { try { this.onEvent(JSON.parse(ev.data)); } catch { /* ignore */ } };
    this.dc = dc;
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      this.o.onState?.(st);
      if ((st === "failed" || st === "disconnected") && !this.closed) this.o.onError?.("同传连接中断");
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ans = await fetch(CALLS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!ans.ok) throw new Error(`同传连接失败（${ans.status}）`);
    await pc.setRemoteDescription({ type: "answer", sdp: await ans.text() });
  }

  onEvent(ev) {
    const t = ev.type || "";
    if (t === "session.output_transcript.delta" && ev.delta) {
      this.lastOutAt = Date.now();
      this.text += ev.delta;
      this.o.onText?.(this.text, false);
    } else if (t.startsWith("session.output_transcript") && /done|completed/.test(t)) {
      this.o.onText?.(ev.transcript || this.text, true);
      this.text = "";
    } else if (t === "session.output_audio.delta") {
      this.lastOutAt = Date.now();
    } else if (t === "session.input_transcript.delta" && ev.delta) {
      this.o.onSource?.(ev.delta);
    } else if (t === "error") {
      this.o.onError?.(`同传出错：${ev.error?.message || ev.message || "未知错误"}`);
    }
  }

  // 用音量判断"正在播放翻译"（外放防回声用）
  watchLevel(ctx, stream) {
    try {
      if (!ctx) return;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an); // 只分析，不重复播放
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        if (this.closed) return;
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        this.level = peak;
        if (peak > 0.02) this.lastOutAt = Date.now();
        this.raf = setTimeout(tick, 50);
      };
      tick();
    } catch { /* 部分浏览器不支持分析远端音频：用文字事件判断 */ }
  }

  get playing() { return Date.now() - this.lastOutAt < 600; }

  close() {
    this.closed = true;
    clearTimeout(this.raf);
    try { this.dc?.readyState === "open" && this.dc.send(JSON.stringify({ type: "session.close" })); } catch { /* ignore */ }
    setTimeout(() => {
      try { this.pc?.close(); } catch { /* ignore */ }
      try { this.o.track?.stop(); } catch { /* ignore */ }
    }, 800); // 给最后一句留一点时间
    if (this.audio) { this.audio.srcObject = null; }
  }
}

export class Interpreter {
  /**
   * opts: { key, mode: "to_me" | "two_way", otherLang, gate, micStream, audioCtx,
   *         onText({lang, text, final}), onGate(bool), onError(msg), onStatus(text) }
   */
  constructor(opts) {
    this.o = opts;
    this.channels = [];
    this.gated = false;
    this.timer = null;
  }

  async start() {
    const { mode, otherLang, micStream } = this.o;
    const plan = [{ lang: "zh", label: "→中文" }];
    if (mode === "two_way") plan.push({ lang: otherLang || "en", label: `→${(OUTPUT_LANGS[otherLang] || otherLang).split(" ").pop()}` });
    this.o.onStatus?.("同传连接中…");
    for (const p of plan) {
      const track = micStream.getAudioTracks()[0].clone();
      const ch = new Channel({
        key: this.o.key, lang: p.lang, track,
        onText: (text, final) => this.o.onText?.({ lang: p.lang, label: p.label, text, final }),
        onError: (m) => this.o.onError?.(m),
      });
      ch.label = p.label;
      this.channels.push(ch);
    }
    try {
      await Promise.all(this.channels.map(ch => ch.start(this.o.audioCtx)));
    } catch (e) {
      this.stop();
      throw e;
    }
    this.o.onStatus?.(`同传中（${plan.map(p => p.label).join(" / ")}）`);
    // 外放防回声：任何一路在播放翻译时，暂停收音
    this.timer = setInterval(() => {
      if (!this.o.gate) return this.setGate(false);
      this.setGate(this.channels.some(c => c.playing));
    }, 100);
  }

  setGate(on) {
    if (on === this.gated) return;
    this.gated = on;
    for (const c of this.channels) if (c.o.track) c.o.track.enabled = !on;
    this.o.onGate?.(on);
  }

  get playing() { return this.channels.some(c => c.playing); }

  stop() {
    clearInterval(this.timer);
    this.setGate(false);
    for (const c of this.channels) c.close();
    this.channels = [];
    this.o.onStatus?.("");
  }
}
