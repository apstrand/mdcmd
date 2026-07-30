// Minimal service worker to make the web build installable as a PWA.
// It caches the static app shell; all Dropbox API traffic goes to the network.
//
// Strategy:
//   - Navigations (the HTML document) are NETWORK-FIRST. The document must always
//     reflect the latest deploy, because it references content-hashed asset URLs
//     (e.g. /assets/index-<hash>.js). Serving a stale cached document points at
//     asset hashes that no longer exist on the server -> white screen + missing
//     assets on soft reload. We only fall back to the cached shell when offline.
//   - Hashed assets are CACHE-FIRST. Their URLs change on every content change,
//     so a cached copy is always safe (immutable).
const CACHE = "mdcmd-shell-v2";

self.addEventListener("install", () => {
  // Activate this SW immediately so fixes reach users on the next load.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Never touch API calls (Dropbox, auth, etc.) — always hit the network.
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  // Network-first for navigations so we always load the current app shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for same-origin static (content-hashed) assets.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
    )
  );
});
