/* Proctor Register service worker — offline support + instant loads.
   Bump CACHE_VERSION when you deploy changed assets. */
const CACHE_VERSION = "pr-v1";
const PRECACHE = [
  "home.html", "css/style.css",
  "js/ui.js", "js/db.js", "js/excel.js",
  "js/page-home.js", "js/page-students.js", "js/page-student.js",
  "js/page-upload.js", "js/page-add-student.js", "js/page-more.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; /* CDN + Supabase go straight to the network */

  if (url.pathname.endsWith(".html") || url.pathname.endsWith("/")) {
    /* pages: network first so deploys land immediately, cache for offline */
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  /* assets: cache first, refresh in the background */
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});