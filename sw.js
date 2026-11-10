// Bump versi bersama setiap rilis shell agar worker lama tetap memakai rilisnya.
const CACHE_VERSION = "v3.0.3";
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `geotag:${encodeURIComponent(SCOPE.href)}:`;
const SHELL = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const TILES = `${CACHE_PREFIX}tiles-${CACHE_VERSION}`;
const MAX_TILES = 100;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "core.js",
  "services.js",
  "stamp.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png",
  "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-icon-2x.png",
  "vendor/leaflet/images/marker-shadow.png",
  "vendor/leaflet/LICENSE",
  "vendor/piexif.js",
  "vendor/piexif.LICENSE.txt",
  "vendor/openlocationcode.js",
  "vendor/openlocationcode.LICENSE",
  "vendor/SOURCES.json"
];
const SHELL_URLS = new Set(SHELL_ASSETS.map((path) => new URL(path, SCOPE).href));
const LEGACY_CACHES = [
  "geotag-shell-v1", "geotag-shell-v2",
  "geotag-runtime-v1", "geotag-runtime-v2"
];
const LEGACY_URLS = new Set([
  "./", "index.html", "style.css", "app.js", "stamp.js",
  "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"
].map((path) => new URL(path, SCOPE).href));

let tileCacheQueue = Promise.resolve();

function cacheable(response) {
  return response && response.ok && response.status !== 206 &&
    response.type !== "opaque" && response.type !== "opaqueredirect";
}

async function precacheShell() {
  const cache = await caches.open(SHELL);
  // addAll bersifat atomik dan menolak respons gagal/opaque. Hindari HTTP cache
  // lama ketika menyiapkan rilis baru; seluruh dependensi harus tersedia dulu.
  await cache.addAll([...SHELL_URLS].map((url) => new Request(url, { cache: "reload" })));
}

async function removeObsoleteCaches() {
  const names = await caches.keys();
  await Promise.all(names.map(async (name) => {
    if (name.startsWith(CACHE_PREFIX)) {
      if (name !== SHELL && name !== TILES) await caches.delete(name);
      return;
    }
    if (!LEGACY_CACHES.includes(name)) return;

    const cache = await caches.open(name);
    const keys = await cache.keys();
    // Cache lama tidak memiliki namespace. Hapus hanya jika kedua penanda
    // aplikasi dan SEMUA key cocok persis dengan shell scope ini. Tile/CDN/API
    // lintas origin tidak membuktikan pemiliknya, jadi cache itu dipertahankan.
    const hasIndex = keys.some((key) => key.url === new URL("index.html", SCOPE).href);
    const hasApp = keys.some((key) => key.url === new URL("app.js", SCOPE).href);
    if (hasIndex && hasApp && keys.every((key) => LEGACY_URLS.has(key.url))) {
      await caches.delete(name);
    }
  }));
}

function withTileCache(task) {
  // Seluruh mutasi (termasuk eviction) diserialkan dan ditunggu fetch/activate.
  // Kegagalan storage tidak boleh merusak antrean atau respons jaringan.
  tileCacheQueue = tileCacheQueue.then(async () => {
    const cache = await caches.open(TILES);
    await task(cache);
  }).catch(() => {});
  return tileCacheQueue;
}

async function trimTiles(cache, limit = MAX_TILES) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) {
    await cache.delete(key);
  }
}

async function shellResponse(request, url) {
  let cache;
  try {
    cache = await caches.open(SHELL);
    const cached = await cache.match(url);
    if (cacheable(cached)) return cached;
  } catch {
    // CacheStorage bisa tidak tersedia; jaringan masih dapat melayani aplikasi.
  }

  try {
    const response = await fetch(request);
    if (cache && cacheable(response)) {
      await cache.put(url, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response("GeoTag belum tersedia offline. Hubungkan internet lalu muat ulang.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
}

function isMapTile(url) {
  return url.protocol === "https:" && !url.port && !url.search &&
    url.hostname === "tile.openstreetmap.de" &&
    /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
}

function cacheableTile(response) {
  return cacheable(response) && /^image\/(?:png|jpeg|webp)(?:;|$)/i.test(response.headers.get("Content-Type") || "");
}

function unavailableTile() {
  // Status gagal memungkinkan pembuat stempel mengenali tile yang tidak ada.
  // Body gambar juga memberi fallback pada elemen <img>; jangan simpan fallback.
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
    '<rect width="256" height="256" fill="#0b1220"/>' +
    '<path d="M0 64H256M0 128H256M0 192H256M64 0V256M128 0V256M192 0V256" stroke="#243146"/>' +
    '<text x="128" y="132" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#94a3b8">Peta offline</text></svg>',
    { status: 503, headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } }
  );
}

async function tileResponse(request) {
  try {
    const cache = await caches.open(TILES);
    const cached = await cache.match(request);
    if (cacheableTile(cached)) return cached;
    if (cached) await withTileCache((store) => store.delete(request));
  } catch {
    // Tetap coba jaringan jika cache ditolak atau penuh.
  }

  try {
    // Sumber peta mendukung CORS. Buat respons terbaca juga untuk <img> no-cors,
    // sehingga status sukses dapat diperiksa dan respons opaque tidak disimpan.
    const response = await fetch(new Request(request, { mode: "cors", credentials: "omit" }));
    if (!cacheableTile(response)) return unavailableTile();
    const copy = response.clone();
    await withTileCache(async (cache) => {
      // Sediakan ruang SEBELUM put agar jumlah entry tidak pernah lewat 100.
      await trimTiles(cache, MAX_TILES - 1);
      await cache.put(request, copy);
    });
    return response;
  } catch {
    return unavailableTile();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await removeObsoleteCaches();
    await withTileCache((cache) => trimTiles(cache));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin === SCOPE.origin) {
    const assetURL = new URL(url);
    assetURL.search = "";
    assetURL.hash = "";
    if (SHELL_URLS.has(assetURL.href)) {
      event.respondWith(shellResponse(event.request, assetURL.href));
      return;
    }
  }
  if (isMapTile(url)) event.respondWith(tileResponse(event.request));
  // API cuaca, Nominatim, dan URL lain mengikuti jaringan tanpa cache SW.
});
