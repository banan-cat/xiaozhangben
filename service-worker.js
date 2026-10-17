/* 小账本 Service Worker
 * 作用：首次打开后缓存全部文件，之后断网也能打开。
 * 更新版本：改了 index.html 之后，把下面的 v1 改成 v2、v3……再部署。
 */
const CACHE = 'xiaozhangben-v8';

const ASSETS = [
  './',
  './index.html',
  './js/data-safety.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 电脑备份接口不缓存，直接走网络
  if (new URL(req.url).pathname.indexOf('/api/') !== -1) return;

  // 页面导航：优先走网络拿最新版，断网时用缓存兜底
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 其他静态文件：缓存优先，没有再去网络
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res && res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
