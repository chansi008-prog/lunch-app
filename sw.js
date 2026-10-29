// 오늘의 밥 서비스 워커: 앱 파일은 새 버전을 먼저 받고, 인터넷이 안 되면 저장본으로 연다.
// 날씨·카카오 요청은 건드리지 않는다 (항상 최신 값).
const VERSION = "lunch-v6";
const CORE = ["./", "index.html", "style.css", "app.js", "menus.js", "config.js", "manifest.json",
  "icons/icon-192-v2.png", "icons/icon-512-v2.png", "icons/apple-touch-icon-v2.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const key = e.request.mode === "navigate" ? "index.html" : e.request;
  e.respondWith(caches.open(VERSION).then(c =>
    // 브라우저 저장본(최대 10분)을 건너뛰고 서버에 새 파일이 있는지 매번 확인한다
    fetch(url.href, { cache: "no-cache" }).then(r => { if (r.ok) c.put(key, r.clone()); return r; })
      .catch(() => c.match(key).then(hit => hit || Response.error()))
  ));
});
