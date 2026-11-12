const CACHE_NAME = "nyumbafind-shell-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/styles.css",
  "/js/app.js",
  "/js/locations.js",
  "/favicon.ico",
  "/logo/icon.svg",
  "/logo/logo-header.svg",
  "/logo/logo-header-light.svg",
  "/logo/logo-large.svg",
  "/logo/logo-large-light.svg",
  "/logo/png/apple-touch-icon.png",
  "/logo/png/icon-192.png",
  "/logo/png/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("nyumbafind-shell-") && key !== CACHE_NAME).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(error => console.error("Service worker cache update failed:", error));
    }
    return response;
  }).catch(() => caches.match(request).then(cached => cached || (request.mode === "navigate" ? caches.match("/") : Response.error()))));
});
