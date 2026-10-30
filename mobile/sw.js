// 离线缓存：先用网络（保证拿到最新版本），断网时用缓存，所以添加到主屏幕后没网也能打开查看会议记录
const CACHE = "mc-v1";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "icons/icon-192.png",
  "js/app.js", "js/util.js", "js/store.js", "js/audio.js", "js/soniox.js", "js/llm.js", "js/intent.js", "js/kb.js", "js/brain.js", "js/indexer.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // 各家 API 请求不经过缓存
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
