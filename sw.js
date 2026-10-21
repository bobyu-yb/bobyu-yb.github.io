/* 数学人生 PWA — Service Worker：app-shell 预缓存 + 离线优先 + 受控更新 */
var CACHE = "lifemath-v1.11.5";
var PRECACHE = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./compute.js",
    "./labels.js",
    "./aliases.js",
    "./manifest.webmanifest",
    "./cards.json",
    "./compute-spec.json",
    "./meta.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-maskable-512.png",
    "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    })
  );
  // 安装后立即激活：配合下方 clients.claim 实现无缝换版，避免「发现新版本」点刷新无反应 /
  // 旧版 app.js 被缓存导致修复无法下发的死锁。换版对用户在读页面会更主动，但保证不卡死。
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      // 只保留「当前版本 + 最近一个旧版本」。
      // 若换版瞬间就把旧缓存全删，正在运行的旧页面请求数据会命中
      // 「旧缓存已删 / 新缓存未就绪」的窗口而失败，表现为只有顶栏底栏、
      // 列表与搜索框都不渲染（用户以为搜索框没反应）。保留一版可消除该窗口。
      var stale = names.filter(function (n) { return n !== CACHE; }).sort();
      stale.pop(); // 留下排序最后的那个（最近的一版旧缓存）
      return Promise.all(stale.map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return resp;
      }).catch(function () {
        // 导航请求兜底：离线且未缓存时回退到 app shell
        if (req.mode === "navigate") return caches.match("./index.html");
        return new Response("", { status: 504, statusText: "offline" });
      });
    })
  );
});
