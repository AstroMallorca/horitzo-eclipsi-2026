const CACHE_NAME = "horitzo-eclipsi-2026-v4";

const CACHE_FILES = [
  "./",
  "./index.html",
  "./visor.html",
  "./manifest.webmanifest",

  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",

  "./js/astronomy.browser.min.js",

  "./data/horizon_profiles/perfil_demo.json"
];

// Instal·lació (NO petar si un recurs falla)
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
      CACHE_FILES.map((url) => cache.add(url))
    );

    // Log d'avís (opcional)
    const failed = results
      .map((r, i) => ({ r, url: CACHE_FILES[i] }))
      .filter(x => x.r.status === "rejected");

    if (failed.length) {
      // eslint-disable-next-line no-console
      console.warn("SW: alguns fitxers no s'han pogut cachejar:", failed.map(f => f.url));
    }

    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
    self.clients.claim();
  })());
});

// Estratègia: cache-first amb fallback a network
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      // Guarda només si és OK i mateix origen
      if (fresh && fresh.ok && new URL(req.url).origin === location.origin) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (e) {
      // Si no hi ha xarxa i no hi ha cache, deixa que falli “normal”
      throw e;
    }
  })());
});
