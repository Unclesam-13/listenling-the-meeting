// 会议助手 Mac 版外壳：把 mobile/ 里的网页版装进一个独立窗口。
// - 网页文件打包在软件里（app://meeting/），不经过浏览器、不需要联网加载页面
// - 允许使用麦克风（第一次会弹出系统授权）
// - 放开各家接口的跨域限制：DeepSeek、Jev 等不支持网页直接调用的接口，在 Mac 软件里也能用
// - 页面里有 window.mcDesktop，据此显示「录音（Mac）」设置：同时录麦克风和会议软件的声音（BlackHole）
//
// 开发时：cd desktop && npm install && npm start
// 自检：  会议助手.app/Contents/MacOS/MeetingCopilot --selftest
const { app, BrowserWindow, Menu, protocol, session, shell, ipcMain, dialog, nativeTheme } = require("electron");
const fs = require("fs");
const path = require("path");
const { RemoteServer } = require("./remote-server");

const SCHEME = "app";
const HOST = "meeting";
const ORIGIN = `${SCHEME}://${HOST}`;
const SELFTEST = process.argv.includes("--selftest");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
const WEB = path.resolve(argValue("--web") || path.join(process.resourcesPath, "web"));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

if (!SELFTEST && !app.requestSingleInstanceLock()) app.quit();

// ---------------- 本地网页 ----------------
async function serveFile(request) {
  const u = new URL(request.url);
  if (u.host !== HOST) return new Response("not found", { status: 404 });
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  let file = path.normalize(path.join(WEB, rel));
  if (file !== WEB && !file.startsWith(WEB + path.sep)) return new Response("forbidden", { status: 403 });
  try {
    if ((await fs.promises.stat(file)).isDirectory()) file = path.join(file, "index.html");
    const body = request.method === "HEAD" ? null : await fs.promises.readFile(file);
    return new Response(body, {
      status: 200,
      headers: { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// ---------------- 接口跨域 ----------------
// 网页从 app://meeting 直接调用各家 API。有的服务商（DeepSeek、Jev 等）不返回允许跨域的响应头，
// 在浏览器里会被拦下；这里给 https 接口的响应补上，只对这个软件自己的窗口生效。
function allowCors(ses) {
  ses.webRequest.onHeadersReceived({ urls: ["https://*/*"] }, (d, cb) => {
    if (d.resourceType === "mainFrame" || d.resourceType === "subFrame") return cb({});
    const h = {};
    for (const [k, v] of Object.entries(d.responseHeaders || {})) if (!/^access-control-/i.test(k)) h[k] = v;
    h["Access-Control-Allow-Origin"] = [ORIGIN];
    h["Access-Control-Allow-Methods"] = ["GET, POST, PUT, PATCH, DELETE, OPTIONS"];
    h["Access-Control-Allow-Headers"] = ["*, Authorization"];
    h["Access-Control-Expose-Headers"] = ["*"];
    h["Access-Control-Max-Age"] = ["600"];
    const out = { responseHeaders: h };
    if (d.method === "OPTIONS" && (d.statusCode < 200 || d.statusCode >= 300)) out.statusLine = "HTTP/1.1 204 No Content";
    cb(out);
  });
}

function allowMic(ses) {
  const ok = new Set(["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen", "speaker-selection", "notifications"]);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (permission === "media") return cb(!(details.mediaTypes || []).includes("video")); // 只要声音，不要摄像头
    cb(ok.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ok.has(permission) || permission === "media");
}

// ---------------- 手机同步 ----------------
// 第一次点「手机」才启动局域网服务（避免一打开软件就弹出"是否允许传入网络连接"）
let remote = null;
function sendToPage(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
async function startRemote() {
  if (!remote) {
    remote = new RemoteServer({
      web: WEB,
      onCommand: (cmd) => sendToPage("mc:remote", cmd),
      onClients: (n) => sendToPage("mc:remote-clients", n),
    });
    try {
      await remote.start();
    } catch (e) {
      remote = null;
      return { error: `无法启动手机同步：${e.message}` };
    }
    sendToPage("mc:remote", { type: "hello" }); // 让页面发一份完整状态
  }
  return remote.info();
}
ipcMain.handle("mc:remote-start", () => startRemote());
ipcMain.on("mc:sync", (_e, type, data) => remote?.update(type, data));

// ---------------- 窗口 ----------------
let win = null;

function openUrl(url) {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
}

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1040, height: 820, minWidth: 380, minHeight: 560, show: false,
    title: "会议助手",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161614" : "#f6f4ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      // 会议软件盖住窗口时也要照常识别、判断提问
      backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required",
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) { wc.loadURL(url); return { action: "deny" }; }
    openUrl(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); openUrl(url); }
  });
  if (show) win.once("ready-to-show", () => win.show());

  // 正在录音时关闭窗口：先确认，避免误关
  let confirmed = false;
  win.on("close", async (e) => {
    if (confirmed || SELFTEST) return;
    e.preventDefault();
    let recording = false;
    try { recording = await wc.executeJavaScript("!!(window.__mc && window.__mc.rec && window.__mc.rec.on)"); } catch { /* ignore */ }
    if (recording) {
      const r = await dialog.showMessageBox(win, {
        type: "warning", buttons: ["结束并关闭", "取消"], defaultId: 1, cancelId: 1,
        message: "正在录音", detail: "关闭窗口会结束这场会议的录音。要关闭吗？",
      });
      if (r.response !== 0) return;
      try { await wc.executeJavaScript("document.getElementById('recBtn').click(); new Promise(r => setTimeout(r, 2500))"); } catch { /* ignore */ }
    }
    confirmed = true;
    win.close();
  });
  win.on("closed", () => (win = null));
  wc.on("did-finish-load", () => { if (remote) sendToPage("mc:remote-clients", remote.clients.size); });
  wc.loadURL(`${ORIGIN}/index.html`);
  return win;
}

function go(page) {
  if (!win) createWindow();
  win.webContents.loadURL(`${ORIGIN}/${page}`);
  win.show();
}

function blackholeHelp() {
  dialog.showMessageBox(win, {
    type: "info", buttons: ["下载 BlackHole", "好的"], defaultId: 1, cancelId: 1,
    message: "录到会议软件里对方的声音",
    detail: [
      "1. 安装免费的 BlackHole 2ch（点下面的按钮打开下载页）",
      "2. 打开「应用程序 → 实用工具 → 音频 MIDI 设置」",
      "3. 左下角「+」→「创建多输出设备」，勾选你的耳机/扬声器和 BlackHole 2ch；耳机设为「主设备」，BlackHole 勾选「漂移校正」",
      "4. 在 Zoom / Teams / 腾讯会议的音频设置里，把「扬声器」选成这个多输出设备",
      "5. 回到会议助手：设置 →「录音（Mac）」→「会议软件里对方的声音」选 BlackHole 2ch",
      "",
      "建议戴耳机开会，否则对方的声音会漏进麦克风，被识别成你说的话。",
    ].join("\n"),
  }).then((r) => { if (r.response === 0) shell.openExternal("https://existential.audio/blackhole/"); });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu", label: "会议助手" }] : []),
    { role: "editMenu", label: "编辑" },
    {
      label: "功能",
      submenu: [
        { label: "会议助手", accelerator: "CmdOrCtrl+1", click: () => go("index.html") },
        { label: "同声传译", accelerator: "CmdOrCtrl+2", click: () => go("interpret/") },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新加载" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    { role: "windowMenu", label: "窗口" },
    {
      role: "help", label: "帮助",
      submenu: [
        { label: "录会议声音的设置方法（BlackHole）", click: blackholeHelp },
        { label: "项目主页", click: () => shell.openExternal("https://github.com/Unclesam-13/listenling-the-meeting") },
      ],
    },
  ]));
}

ipcMain.on("mc:info", (e) => { e.returnValue = { platform: process.platform, version: app.getVersion() }; });
ipcMain.on("mc:open", (_e, url) => openUrl(url));

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => remote?.stop()); // 关闭窗口即退出，不在后台继续录音或计费
app.on("activate", () => { if (!win) createWindow(); });

app.whenReady().then(async () => {
  protocol.handle(SCHEME, serveFile);
  allowCors(session.defaultSession);
  allowMic(session.defaultSession);
  if (SELFTEST) return selftest();
  buildMenu();
  createWindow();
});

// ---------------- 自检（打包后在云端 Mac 上运行） ----------------
async function selftest() {
  const result = { web: WEB, ok: false, checks: {}, errors: [] };
  const finish = (code) => { console.log("SELFTEST " + JSON.stringify(result, null, 1)); app.exit(code); };
  setTimeout(() => { result.errors.push("超时"); finish(1); }, 60000);
  try {
    const w = createWindow({ show: false });
    w.webContents.on("console-message", (...a) => {
      const ev = a[0] && typeof a[0] === "object" && "message" in a[0] ? a[0] : { level: a[1], message: a[2] };
      if (ev.level === 3 || ev.level === "error") result.errors.push(ev.message);
    });
    await new Promise((r) => w.webContents.once("did-finish-load", r));
    await new Promise((r) => setTimeout(r, 2000));
    const page = await w.webContents.executeJavaScript(`(async () => {
      const get = async (u) => { try { const r = await fetch(u); return r.ok; } catch (e) { return false; } };
      return {
        desktop: !!window.mcDesktop && document.body.classList.contains("desktop") && !document.getElementById("desktopAudio").hidden,
        app: !!(window.__mc && window.__mc.kb),
        recBtn: !!document.getElementById("recBtn"),
        vendor: (await get("vendor/marked.umd.js")) && (await get("vendor/katex/katex.min.js")) && (await get("vendor/pdf.min.js")) && (await get("vendor/mammoth.browser.min.js")),
        interpret: await get("interpret/"),
        traversal: !(await get("../package.json")),
        mic: typeof AudioWorkletNode === "function" && !!navigator.mediaDevices,
      };
    })()`);
    Object.assign(result.checks, page);
    // 跨域：用无效 Key 调接口，能拿到 HTTP 状态码（而不是被浏览器拦下）就说明放开成功。需要联网，失败只记录不判定
    result.network = await w.webContents.executeJavaScript(`(async () => {
      const t = async (url, init) => { try { const r = await fetch(url, init); return r.status; } catch (e) { return String(e.message || e); } };
      return {
        deepseek: await t("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: "Bearer bad", "Content-Type": "application/json" }, body: "{}" }),
        openai: await t("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer bad" } }),
      };
    })()`);
    // 手机同步：启动局域网服务，用电脑自己访问手机页面和推送
    const info = await startRemote();
    result.checks.remote = !!(remote && remote.port);
    if (remote) {
      const get = (u) => new Promise((ok) => require("http").get(u, (r) => { r.resume(); ok(r.statusCode); }).on("error", () => ok(0)));
      const base = `http://127.0.0.1:${remote.port}`;
      result.checks.remotePage = (await get(`${base}/remote.html`)) === 200 && (await get(`${base}/js/remote.js`)) === 200;
      result.checks.remoteAuth = (await get(`${base}/events?t=bad`)) === 403 && (await get(`${base}/index.html`)) === 404;
      result.checks.qrLib = await w.webContents.executeJavaScript(`fetch("vendor/qrcode.js").then(r => r.ok, () => false)`);
      result.remote = { url: info.url ? info.url.replace(/t=.*/, "t=…") : null, error: info.error };
    }
    result.ok = Object.values(result.checks).every(Boolean) && result.errors.length === 0;
    finish(result.ok ? 0 : 1);
  } catch (e) {
    result.errors.push(String(e && e.stack || e));
    finish(1);
  }
}
