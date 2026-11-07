// 局域网同步服务：Mac 软件开会，手机扫码查看。
// - 手机打开 http://<电脑IP>:<端口>/remote.html?t=<令牌>
// - GET  /events?t=…  实时推送（Server-Sent Events）：先发一份完整状态（reset），之后是增量
// - POST /cmd?t=…     手机的操作：提问、开始、结束
// 令牌每次打开软件都会重新生成；没有令牌只能拿到页面文件（都是公开的网页代码），拿不到会议内容。
// 不依赖 Electron，便于单独测试：node desktop/test_remote_server.js
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};
// 手机页面只需要这些文件
const PUBLIC = [/^remote\.html$/, /^styles\.css$/, /^js\/(util|view|remote)\.js$/, /^vendor\/[\w.\-/]+$/, /^icons\/[\w.\-]+$/];
const MAX_LINES = 3000;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || a.address.startsWith("169.254.")) continue;
      // Wi-Fi / 有线优先（mac 上一般是 en0 / en1），虚拟网卡、VPN 放后面
      const score = /^en\d/.test(name) ? 0 : /^(eth|wlan|wl)/.test(name) ? 1 : /^(utun|bridge|vmnet|docker|veth|awdl|llw)/.test(name) ? 3 : 2;
      out.push({ address: a.address, score });
    }
  }
  return out.sort((x, y) => x.score - y.score).map(x => x.address);
}

class RemoteServer {
  /** opts: { web, onCommand(cmd), onClients(n), ports: [8765, …] } */
  constructor(opts) {
    this.o = opts;
    this.token = crypto.randomBytes(16).toString("base64url");
    this.clients = new Set();
    this.server = null;
    this.port = 0;
    this.state = { M: null, rec: { on: false, busy: false, started: 0 }, status: { text: "", bad: false }, live: {}, summarizing: false };
  }

  async start() {
    if (this.server) return this.info();
    const ports = this.o.ports || [8765, 8766, 8767, 8768, 0];
    for (const p of ports) {
      try { await this.listen(p); break; } catch (e) { if (p === ports.at(-1)) throw e; }
    }
    this.ping = setInterval(() => { for (const c of this.clients) c.write(": ping\n\n"); }, 20000);
    return this.info();
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch { /* ignore */ } }));
      srv.once("error", reject);
      srv.listen(port, this.o.host || "0.0.0.0", () => {
        srv.removeListener("error", reject);
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });
  }

  info() {
    const ips = this.o.addresses ? this.o.addresses() : lanAddresses();
    const urls = ips.map(ip => `http://${ip}:${this.port}/remote.html?t=${this.token}`);
    return { url: urls[0] || null, urls, port: this.port, clients: this.clients.size, error: urls.length ? null : "没有找到可用的网络。请确认电脑连上了 Wi-Fi，手机和电脑连同一个 Wi-Fi" };
  }

  stop() {
    clearInterval(this.ping);
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  authed(u) {
    const t = Buffer.from(u.searchParams.get("t") || "");
    const k = Buffer.from(this.token);
    return t.length === k.length && crypto.timingSafeEqual(t, k);
  }

  async handle(req, res) {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/" || p === "") {
      res.writeHead(302, { Location: `/remote.html${u.search}` }).end();
      return;
    }
    if (p === "/events") {
      if (!this.authed(u)) return void res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("链接已失效：请在电脑上的会议助手里重新扫码");
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 2000\n\n");
      this.send(res, "reset", this.state);
      this.clients.add(res);
      this.o.onClients?.(this.clients.size);
      req.on("close", () => { this.clients.delete(res); this.o.onClients?.(this.clients.size); });
      return;
    }
    if (p === "/cmd") {
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (!this.authed(u)) return void res.writeHead(403).end();
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 10000) return void res.writeHead(413).end(); }
      let cmd;
      try { cmd = JSON.parse(body); } catch { return void res.writeHead(400).end(); }
      if (!cmd || !["ask", "start", "stop", "hello"].includes(cmd.type)) return void res.writeHead(400).end();
      this.o.onCommand?.({ type: cmd.type, text: typeof cmd.text === "string" ? cmd.text.slice(0, 500) : undefined, choice: cmd.choice === "new" || cmd.choice === "continue" ? cmd.choice : undefined });
      return void res.writeHead(204).end();
    }
    // 页面文件
    const rel = decodeURIComponent(p).replace(/^\/+/, "");
    if (rel.includes("..") || !PUBLIC.some(r => r.test(rel))) return void res.writeHead(404).end("not found");
    const file = path.join(this.o.web, rel);
    try {
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404).end("not found");
    }
  }

  send(res, type, data) {
    const payload = JSON.stringify({ ...((type === "reset" || type === "meta") ? { now: Date.now() } : {}), data });
    res.write(`event: ${type}\ndata: ${payload}\n\n`);
  }

  // 电脑页面发来的变化：更新本地副本（给新连上的手机用），再转发给所有手机
  update(type, data) {
    const st = this.state;
    switch (type) {
      case "reset":
        this.state = { ...st, ...data, M: data?.M || null };
        if (this.state.M?.lines?.length > MAX_LINES) this.state.M.lines = this.state.M.lines.slice(-MAX_LINES);
        break;
      case "line":
        if (st.M) { st.M.lines.push(data); if (st.M.lines.length > MAX_LINES) st.M.lines.shift(); }
        break;
      case "line-upd": {
        const l = st.M?.lines.find(x => x.id === data?.id);
        if (l) l.trans = data.trans;
        break;
      }
      case "live": st.live = data || {}; break;
      case "answer":
        if (st.M && data?.id) {
          const i = st.M.answers.findIndex(a => a.id === data.id);
          if (i >= 0) st.M.answers[i] = data; else st.M.answers.push(data);
        }
        break;
      case "meta":
        if (st.M) Object.assign(st.M, { title: data.title, names: data.names, me: data.me, totalSec: data.totalSec, endedAt: data.endedAt });
        st.rec = data.rec; st.status = data.status;
        break;
      case "summary":
        if (st.M) st.M.summary = data.summary;
        st.summarizing = data.summarizing;
        break;
      default:
        return;
    }
    for (const c of this.clients) this.send(c, type, type === "reset" ? this.state : data);
  }
}

module.exports = { RemoteServer, lanAddresses };
