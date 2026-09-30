/* Proctor Register service worker — offline support + instant loads.
   Bump CACHE_VERSION whenever the PRECACHE list below changes shape
   (files added or renamed). Ordinary content edits do not need a bump:
   pages are network-first and other assets refresh in the background. */
const CACHE_VERSION = "pr-v5";
const PRECACHE = [
  "index.html", "home.html", "students.html", "student.html",
  "add-student.html", "upload.html", "more.html", "scan.html",
  "manifest.webmanifest", "css/style.css",
  "js/config.js", "js/ui.js", "js/db.js", "js/excel.js",
  "js/scan-parse.js", "js/page-login.js", "js/page-home.js",
  "js/page-students.js", "js/page-student.js", "js/page-upload.js",
  "js/page-add-student.js", "js/page-more.js", "js/page-scan.js",
  "vendor/supabase.js", "vendor/xlsx.full.min.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/fccu-logo.png",
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
  if (url.origin !== location.origin) return; /* Supabase API goes straight to the network */

  if (url.pathname.endsWith(".html") || url.pathname.endsWith("/")) {
    /* pages: network first so deploys land immediately, cache for offline */
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() =>
          /* offline: fall back to the saved copy, ignoring things like
             ?id=… so profile links work without a connection too */
          caches.match(e.request, { ignoreSearch: true }).then((hit) =>
            hit || (url.pathname.endsWith("/")
              ? caches.match("home.html")
              : Promise.reject(new Error("offline")))
          )
        )
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
