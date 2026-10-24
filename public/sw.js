/**
 * Minimal service worker — exists only so Chrome/Android considers this site
 * "installable" (that requires a registered service worker with a fetch
 * handler, on top of the manifest). It intentionally does no caching: every
 * request just passes straight through to the network, so API calls to
 * /api/rpc always get fresh data and are never served stale from a cache.
 */
self.addEventListener("install", (event) => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { self.clients.claim(); });
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
