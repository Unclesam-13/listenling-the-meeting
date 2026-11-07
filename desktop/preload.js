// 告诉网页"现在是在 Mac 软件里"：网页据此显示「录音（Mac）」设置（选麦克风和 BlackHole）。
const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("mc:info") || {};
contextBridge.exposeInMainWorld("mcDesktop", Object.freeze({
  platform: info.platform,
  version: info.version,
  openExternal: (url) => ipcRenderer.send("mc:open", String(url)),
  // 手机同步
  remote: () => ipcRenderer.invoke("mc:remote-start"),
  sync: (type, data) => ipcRenderer.send("mc:sync", type, data),
  onRemote: (cb) => ipcRenderer.on("mc:remote", (_e, cmd) => cb(cmd)),
  onRemoteClients: (cb) => ipcRenderer.on("mc:remote-clients", (_e, n) => cb(n)),
}));
