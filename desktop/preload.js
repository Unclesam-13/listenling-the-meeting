// 告诉网页"现在是在 Mac 软件里"：网页据此显示「录音（Mac）」设置（选麦克风和 BlackHole）。
const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("mc:info") || {};
contextBridge.exposeInMainWorld("mcDesktop", Object.freeze({
  platform: info.platform,
  version: info.version,
  openExternal: (url) => ipcRenderer.send("mc:open", String(url)),
}));
