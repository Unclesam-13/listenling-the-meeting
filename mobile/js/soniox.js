// Soniox 实时识别（WebSocket，浏览器直连）：中英混说、区分说话人、自动断句、实时翻译。
// 文档：https://soniox.com/docs/stt/rt/real-time-transcription
//       https://soniox.com/docs/stt/rt/real-time-translation
//
// 一段话（两个 <end> 之间）里，原文和译文都会陆续到达；遇到 <end> 时把这段话按说话人拆成若干行交出去。
// 译文偶尔会在 <end> 之后才到，就补到刚交出去的那一行上。

const URL_WS = "wss://stt-rt.soniox.com/transcribe-websocket";
const URL_TEMP_KEY = "https://api.soniox.com/v1/auth/temporary-api-key";
const END = new Set(["<end>", "<fin>"]);

export function translationConfig(mode) {
  if (mode === "two_way") return { type: "two_way", language_a: "zh", language_b: "en" };
  if (mode === "to_zh") return { type: "one_way", target_language: "zh" };
  if (mode === "to_en") return { type: "one_way", target_language: "en" };
  return null;
}

export class SonioxClient {
  /**
   * opts: { key, translate, terms[], context, onLine(line), onPartial(p), onLateTranslation(lineId, trans), onStatus(text), onError(msg) }
   * line: { id, spk, text, trans, lang }
   */
  constructor(opts) {
    this.o = opts;
    this.ws = null;
    this.queue = [];          // 断线期间缓存的音频（最多约 15 秒）
    this.closing = false;
    this.finished = null;
    this.retry = 0;
    this.authMode = "protocol"; // protocol | legacy
    this.seg = [];            // 当前这段话：[{spk, text, trans, lang}]
    this.partial = { text: "", trans: "", spk: null };
    this.lastLine = null;     // 最近交出去的一行（接收迟到的译文）
    this.lastLineAt = 0;
    this.seq = 0;
  }

  config() {
    const c = {
      model: "stt-rt-v5",
      audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
      language_hints: ["zh", "en"],
      enable_language_identification: true,
      enable_speaker_diarization: true,
      enable_endpoint_detection: true,
      max_endpoint_delay_ms: 1500,
      client_reference_id: "meeting-copilot-mobile",
    };
    const terms = (this.o.terms || []).filter(Boolean);
    if (terms.length || this.o.context) {
      c.context = {};
      if (terms.length) c.context.terms = terms;
      if (this.o.context) c.context.text = this.o.context;
    }
    const tr = translationConfig(this.o.translate);
    if (tr) c.translation = tr;
    return c;
  }

  // 先用长期 Key 换一个临时 Key（更安全）；如果这个接口不允许网页直接调用，就直接用长期 Key
  async authKey() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(URL_TEMP_KEY, {
        method: "POST", signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.o.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ usage_type: "transcribe_websocket", expires_in_seconds: 60, single_use: true }),
      });
      clearTimeout(t);
      if (r.ok) {
        const d = await r.json();
        const k = d.api_key || d.key || d.temporary_api_key;
        if (k) return k;
      } else if (r.status === 401 || r.status === 403) {
        throw new Error("Soniox API Key 无效，请在设置里检查");
      }
    } catch (e) {
      if (/无效/.test(e.message)) throw e;
    }
    return this.o.key;
  }

  async connect() {
    this.closing = false;
    const key = await this.authKey();
    return new Promise((resolve, reject) => {
      let opened = false, settled = false;
      const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
      let ws;
      try {
        ws = this.authMode === "protocol" ? new WebSocket(URL_WS, ["soniox-api-key", key]) : new WebSocket(URL_WS);
      } catch (e) {
        if (this.authMode === "protocol") { this.authMode = "legacy"; return this.connect().then(resolve, reject); }
        return done(e);
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        opened = true;
        const cfg = this.config();
        if (this.authMode === "legacy") cfg.api_key = key; // 旧方式（Soniox 支持到 2027-01-15）
        ws.send(JSON.stringify(cfg));
        this.retry = 0;
        this.o.onStatus?.("识别中");
        // 补发断线期间缓存的音频
        while (this.queue.length && ws.readyState === 1) ws.send(this.queue.shift());
        done();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.error_code) {
          const text = `${msg.error_code} ${msg.error_message || ""}`.trim();
          if ((msg.error_code === 401 || /auth/i.test(text)) && this.authMode === "protocol") {
            this.authMode = "legacy"; // 换旧的鉴权方式再试一次
            ws.onclose = null; try { ws.close(); } catch { /* ignore */ }
            this.connect().then(resolve, reject);
            settled = true;
            return;
          }
          this.o.onError?.(/401|auth/i.test(text) ? "Soniox API Key 无效，请在设置里检查" : `识别服务出错：${text}`);
          return;
        }
        this.handle(msg);
        if (msg.finished) this.finished?.();
      };
      ws.onerror = () => { /* 交给 onclose 处理 */ };
      ws.onclose = (ev) => {
        if (!opened && this.authMode === "protocol" && !settled) {
          this.authMode = "legacy";
          this.connect().then(resolve, reject);
          settled = true;
          return;
        }
        this.flush();
        this.finished?.();
        if (!opened) return done(new Error(`无法连接识别服务（${ev.code}）`));
        if (!this.closing) this.reconnect();
      };
    });
  }

  reconnect() {
    if (this.closing) return;
    const delay = Math.min(15000, 1000 * 2 ** this.retry++);
    this.o.onStatus?.(`连接中断，${Math.round(delay / 1000)} 秒后重连…`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.closing) return;
      this.connect().catch(e => { this.o.onStatus?.(`重连失败：${e.message}`); this.reconnect(); });
    }, delay);
  }

  // 应用从后台回来时调用：连接断了就马上重连
  ensure() {
    if (this.closing) return;
    if (!this.ws || this.ws.readyState > 1) { this.retry = 0; clearTimeout(this.reconnectTimer); this.connect().catch(() => this.reconnect()); }
  }

  send(pcm) {
    if (this.closing) return;
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(pcm);
    } else {
      this.queue.push(pcm);
      if (this.queue.length > 150) this.queue.shift();
    }
  }

  // 结束：通知服务端音频结束，等最后一句识别（和翻译）完成后断开，不再计费
  async finish(timeoutMs = 5000) {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        this.finished = () => { clearTimeout(t); resolve(); };
        try { ws.send(""); } catch { resolve(); }
      });
    }
    this.flush();
    try { ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.queue = [];
  }

  abort() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  // ---------------- 处理识别结果 ----------------
  handle(msg) {
    let pText = "", pTrans = "", pSpk = null;
    for (const t of msg.tokens || []) {
      const text = t.text || "";
      const isTrans = t.translation_status === "translation";
      if (t.is_final) {
        if (END.has(text)) { this.flush(); continue; }
        if (isTrans) this.addTranslation(text, t.speaker);
        else this.addOriginal(text, t.speaker, t.language);
      } else if (!END.has(text)) {
        if (isTrans) pTrans += text;
        else { pText += text; pSpk = t.speaker || pSpk; }
      }
    }
    const segText = this.seg.map(s => s.text).join("");
    const segTrans = this.seg.map(s => s.trans).join(" ");
    const spk = pSpk || this.seg.at(-1)?.spk || null;
    const p = { spk, text: (segText + pText).trim(), trans: (segTrans + " " + pTrans).trim() };
    if (p.text !== this.partial.text || p.trans !== this.partial.trans || p.spk !== this.partial.spk) {
      this.partial = p;
      this.o.onPartial?.(p);
    }
  }

  addOriginal(text, spk, lang) {
    const last = this.seg.at(-1);
    if (last && (!spk || !last.spk || spk === last.spk)) {
      last.text += text;
      if (spk && !last.spk) last.spk = spk;
      if (lang) last.lang = lang;
    } else {
      this.seg.push({ spk: spk || null, text, trans: "", lang: lang || null });
    }
  }

  addTranslation(text, spk) {
    if (!this.seg.length) {
      // 这段话已经交出去了，译文迟到：补到刚交出去的那一行
      if (this.lastLine && Date.now() - this.lastLineAt < 10000) {
        this.lastLine.trans = (this.lastLine.trans + text);
        this.o.onLateTranslation?.(this.lastLine.id, this.lastLine.trans.trim());
      }
      return;
    }
    let target = this.seg.at(-1);
    if (spk) {
      for (const s of this.seg) if (s.spk === spk && !s.transDone) { target = s; break; }
      // 已经开始翻译后面同一个人的话，前面的就算翻译完了
      for (const s of this.seg) { if (s === target) break; if (s.spk === spk) s.transDone = true; }
    }
    target.trans += text;
  }

  flush() {
    const segs = this.seg;
    this.seg = [];
    for (const s of segs) {
      const text = s.text.trim();
      if (!text) continue;
      const line = { id: `l${Date.now().toString(36)}${this.seq++}`, spk: s.spk, text, trans: s.trans.trim(), lang: s.lang };
      this.lastLine = line;
      this.lastLineAt = Date.now();
      this.o.onLine?.(line);
    }
    if (this.partial.text || this.partial.trans) {
      this.partial = { text: "", trans: "", spk: null };
      this.o.onPartial?.(this.partial);
    }
  }
}
