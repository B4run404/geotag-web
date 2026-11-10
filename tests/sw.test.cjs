const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const SW = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor/SOURCES.json"), "utf8"));
const DEFAULT_SCOPE = "https://example.test/geotag-web/";
const urlOf = (request) => typeof request === "string" ? request : request.url;
const namespace = (scope) => `geotag:${encodeURIComponent(scope)}:`;
const offline = async () => { throw new TypeError("Network unavailable"); };
const tileURL = (x) => `https://tile.openstreetmap.de/8/${x}/0.png`;
const tileResponse = () => new Response("tile bytes", { headers: { "Content-Type": "image/png" } });

// Minimal in-memory Cache API; real Request/Response preserve cloning semantics.
// Hooks expose pending writes/deletes so tests can detect unawaited cleanup.
class MemoryCache {
  constructor() {
    this.entries = new Map();
    this.mutations = 0;
    this.peakMutations = 0;
    this.peakSize = 0;
    this.failPuts = 0;
  }

  async match(request) {
    return this.entries.get(urlOf(request))?.clone();
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async mutate(hook, operation) {
    this.mutations += 1;
    this.peakMutations = Math.max(this.peakMutations, this.mutations);
    try {
      await hook?.();
      const result = operation();
      this.peakSize = Math.max(this.peakSize, this.entries.size);
      return result;
    } finally {
      this.mutations -= 1;
    }
  }

  async put(request, response) {
    return this.mutate(() => this.beforePut?.(request), () => {
      if (this.failPuts > 0) {
        this.failPuts -= 1;
        throw new Error("QuotaExceededError");
      }
      this.entries.set(urlOf(request), response.clone());
    });
  }

  async delete(request) {
    return this.mutate(() => this.beforeDelete?.(request), () => this.entries.delete(urlOf(request)));
  }
}

class MemoryCacheStorage {
  constructor() {
    this.stores = new Map();
    this.deleted = [];
    this.failOpen = false;
  }

  async open(name) {
    if (this.failOpen) throw new Error("Storage unavailable");
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name) {
    this.deleted.push(name);
    return this.stores.delete(name);
  }

  view(fetcher) {
    return {
      keys: () => this.keys(),
      delete: (name) => this.delete(name),
      open: async (name) => {
        const cache = await this.open(name);
        return {
          match: (request) => cache.match(request),
          keys: () => cache.keys(),
          put: (request, response) => cache.put(request, response),
          delete: (request) => cache.delete(request),
          addAll: async (requests) => {
            const responses = await Promise.all(requests.map((request) => fetcher(request)));
            if (responses.some((response) => !response.ok || response.status === 206)) {
              throw new TypeError("Precache requires successful responses");
            }
            await Promise.all(requests.map((request, i) => cache.put(request, responses[i])));
          }
        };
      }
    };
  }
}

function harness(options = {}) {
  const scope = options.scope || DEFAULT_SCOPE;
  const storage = options.storage || new MemoryCacheStorage();
  const listeners = new Map();
  const calls = [];
  const counts = { skipWaiting: 0, claim: 0 };
  let network = options.network || (async (request) => new Response(`network:${request.url}`));
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return network(request);
  };
  const self = {
    registration: { scope, active: options.active ? {} : null },
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: async () => { counts.skipWaiting += 1; },
    clients: { claim: async () => { counts.claim += 1; } }
  };
  vm.runInNewContext(options.source || SW, {
    self, caches: storage.view(fetcher), fetch: fetcher, URL, Request, Response
  }, { filename: "sw.js" });

  return {
    scope, storage, calls, counts,
    setNetwork: (fn) => { network = fn; },
    async dispatch(type, data = {}) {
      const pending = [];
      listeners.get(type)({ ...data, waitUntil: (promise) => pending.push(promise) });
      await Promise.all(pending);
    },
    fetchEvent(input, init) {
      let response;
      const pending = [];
      listeners.get("fetch")({
        request: new Request(input, init),
        respondWith: (promise) => { response = Promise.resolve(promise); },
        waitUntil: (promise) => pending.push(promise)
      });
      return {
        handled: response !== undefined,
        response: response?.then(async (value) => {
          await Promise.all(pending);
          return value;
        })
      };
    }
  };
}

async function namedCache(h, kind) {
  const names = await h.storage.keys();
  const name = names.findLast((value) => value.startsWith(`${namespace(h.scope)}${kind}-`));
  assert.ok(name, `Expected a ${kind} cache for ${h.scope}`);
  return { name, cache: await h.storage.open(name) };
}

async function seed(storage, name, urls) {
  const cache = await storage.open(name);
  for (const url of urls) await cache.put(url, new Response(`seed:${url}`));
  return cache;
}

test("vendor assets retain pinned upstream bytes and license files", () => {
  assert.equal(SOURCES.packages.leaflet.version, "1.9.4");
  assert.equal(SOURCES.packages.piexifjs.version, "1.0.6");
  assert.equal(SOURCES.packages["open-location-code"].tag, "1.0.4");
  assert.equal(SOURCES.packages["open-location-code"].commit, "2c7115db77a3c4cdd396cdeaddc4ab676216b448");
  assert.equal(SOURCES.packages["qrcode-generator"].version, "1.4.4");
  for (const file of SOURCES.files) {
    const bytes = fs.readFileSync(path.join(ROOT, file.path));
    const digest = createHash("sha256").update(bytes).digest("base64");
    assert.equal(`sha256-${digest}`, file.integrity, file.path);
    assert.match(file.url, /@(?:1\.9\.4|1\.0\.6|1\.4\.4)\/|\/2c7115db77a3c4cdd396cdeaddc4ab676216b448\/|\/master\/LICENSE$/);
  }
  for (const entry of Object.values(SOURCES.packages)) {
    assert.ok(fs.statSync(path.join(ROOT, entry.licensePath)).size > 1000, entry.licensePath);
  }
});

test("all Leaflet CSS images and retina/default marker assets are local PNGs", () => {
  const css = fs.readFileSync(path.join(ROOT, "vendor/leaflet/leaflet.css"), "utf8");
  const images = new Set(["images/marker-icon-2x.png", "images/marker-shadow.png"]);
  for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
    const target = match[1].replace(/["']/g, "").trim();
    if (!target.startsWith("#")) images.add(target);
  }
  assert.equal(images.size, 5);
  for (const image of images) {
    assert.match(image, /^images\/[\w-]+\.png$/);
    const bytes = fs.readFileSync(path.join(ROOT, "vendor/leaflet", image));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", image);
  }
});

test("vendor classic scripts expose working L, piexif, and OpenLocationCode browser globals", () => {
  const browser = {
    navigator: { userAgent: "GeoTag browser-global test", platform: "Win32" },
    screen: { deviceXDPI: 96, logicalXDPI: 96 },
    document: {
      documentElement: { style: {} },
      createElement: (tag) => ({ style: {}, ...(tag === "canvas" ? { getContext: () => ({}) } : {}) }),
      addEventListener() {},
      removeEventListener() {}
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout, clearTimeout, atob, btoa
  };
  browser.window = browser;
  browser.self = browser;
  const context = vm.createContext(browser);
  for (const file of ["vendor/leaflet/leaflet.js", "vendor/piexif.js", "vendor/openlocationcode.js", "vendor/qrcode.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  assert.equal(browser.L.version, "1.9.4");
  assert.equal(browser.L.point(3, 4).distanceTo([0, 0]), 5);
  assert.equal(browser.L.Icon.Default.prototype.options.iconRetinaUrl, "marker-icon-2x.png");
  assert.equal(typeof browser.L.map, "function");
  const { piexif, OpenLocationCode } = browser;
  const exif = piexif.dump({ "0th": { [piexif.ImageIFD.Software]: "GeoTag" }, GPS: { [piexif.GPSIFD.GPSLatitudeRef]: "S" } });
  assert.equal(piexif.load(exif)["0th"][piexif.ImageIFD.Software], "GeoTag");
  assert.equal(piexif.load(exif).GPS[piexif.GPSIFD.GPSLatitudeRef], "S");
  assert.equal(typeof piexif.insert, "function");
  assert.equal(typeof piexif.remove, "function");
  assert.equal(OpenLocationCode.encode(47.36559, 8.524997, 10), "8FVC9G8F+6X");
  assert.equal(OpenLocationCode.isFull("8FVC9G8F+6X"), true);
  assert.equal(typeof browser.qrcode, "function");
  const qr = browser.qrcode(0, "M");
  qr.addData("https://maps.google.com/?q=-6.208800,106.845600");
  qr.make();
  assert.equal(qr.getModuleCount(), 33);
  assert.ok(qr.isDark(4, 4));
});

test("install precaches the complete local runtime before first offline activation", async () => {
  const h = harness();
  await h.dispatch("install");
  const { cache } = await namedCache(h, "shell");
  const required = [
    "./", "index.html", "style.css", "core.js", "services.js", "stamp.js", "app.js",
    "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
    "vendor/SOURCES.json", ...SOURCES.files.map((file) => file.path)
  ];
  const cachedURLs = new Set((await cache.keys()).map((request) => request.url));
  assert.equal(cachedURLs.size, required.length);
  for (const file of required) assert.ok(cachedURLs.has(new URL(file, h.scope).href), file);
  assert.ok(h.calls.every((request) => request.cache === "reload"));
  assert.ok(h.calls.every((request) => request.url.startsWith(h.scope)));
  assert.equal(h.counts.skipWaiting, 0);
  assert.equal(h.counts.claim, 0);

  h.setNetwork(offline);
  await h.dispatch("activate");
  assert.equal(h.counts.claim, 1);
  const networkCount = h.calls.length;
  for (const file of required) {
    const url = new URL(file, h.scope).href;
    const response = await h.fetchEvent(url).response;
    assert.equal(response.status, 200, file);
    assert.equal(await response.text(), `network:${url}`, file);
  }
  const start = await h.fetchEvent(`${h.scope}?source=homescreen`).response;
  assert.equal(start.status, 200);
  assert.equal(h.calls.length, networkCount);
});

test("a missing precache asset rejects installation without skipping the waiting worker", async () => {
  const h = harness({ active: true, network: async (request) => new Response("asset", {
    status: request.url.endsWith("services.js") ? 404 : 200
  }) });
  await assert.rejects(h.dispatch("install"), /Precache/);
  const { cache } = await namedCache(h, "shell");
  assert.equal((await cache.keys()).length, 0);
  assert.equal(h.counts.skipWaiting, 0);
  assert.equal(h.counts.claim, 0);
});

test("upgrades remain waiting until the app sends SKIP_WAITING", async () => {
  const h = harness({ active: true });
  await h.dispatch("install");
  assert.equal(h.counts.skipWaiting, 0);
  await h.dispatch("message", { data: null });
  await h.dispatch("message", { data: { type: "UPDATE" } });
  assert.equal(h.counts.skipWaiting, 0);
  await h.dispatch("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(h.counts.skipWaiting, 1);
});

test("installing a new release leaves the active shell intact until activation", async () => {
  const storage = new MemoryCacheStorage();
  const oldSource = SW.replace(/const CACHE_VERSION = "[^"]+";/, 'const CACHE_VERSION = "previous";');
  assert.notEqual(oldSource, SW);
  const old = harness({ storage, source: oldSource, network: async () => new Response("old release") });
  await old.dispatch("install");
  await old.dispatch("activate");
  const { name: oldName } = await namedCache(old, "shell");
  const next = harness({ storage, active: true, network: async () => new Response("new release") });
  await next.dispatch("install");
  assert.equal(next.counts.skipWaiting, 0);
  assert.ok((await storage.keys()).includes(oldName));
  assert.equal(await (await old.fetchEvent(`${old.scope}app.js`).response).text(), "old release");
  await next.dispatch("message", { data: { type: "SKIP_WAITING" } });
  await next.dispatch("activate");
  assert.ok(!(await storage.keys()).includes(oldName));
  assert.equal(await (await next.fetchEvent(`${next.scope}app.js`).response).text(), "new release");
});

test("cache cleanup isolates root and nested registrations and unrelated apps", async () => {
  const storage = new MemoryCacheStorage();
  const root = harness({ storage, scope: "https://example.test/" });
  const nested = harness({ storage });
  await root.dispatch("install");
  await nested.dispatch("install");
  const { name: rootName } = await namedCache(root, "shell");
  const { name: nestedName } = await namedCache(nested, "shell");
  assert.notEqual(rootName, nestedName);
  const rootOld = `${namespace(root.scope)}shell-old`;
  const nestedOld = `${namespace(nested.scope)}tiles-old`;
  await seed(storage, rootOld, [`${root.scope}app.js`]);
  await seed(storage, nestedOld, [tileURL(1)]);
  await seed(storage, "another-pwa-v9", [`${nested.scope}app.js`]);

  await root.dispatch("activate");
  assert.deepEqual(new Set(storage.deleted), new Set([rootOld]));
  assert.ok((await storage.keys()).includes(nestedName));
  assert.ok((await storage.keys()).includes(nestedOld));
  await nested.dispatch("activate");
  assert.deepEqual(new Set(storage.deleted), new Set([rootOld, nestedOld]));
  assert.ok((await storage.keys()).includes(rootName));
  assert.ok((await storage.keys()).includes("another-pwa-v9"));
});

test("legacy cleanup requires exact scoped shell markers and rejects mixed ownership", async () => {
  const h = harness({ scope: "https://example.test/" });
  const own = [`${h.scope}index.html`, `${h.scope}app.js`];
  await seed(h.storage, "geotag-shell-v2", own);
  await seed(h.storage, "geotag-runtime-v2", own);
  await seed(h.storage, "geotag-shell-v1", [...own, `${h.scope}another-app/index.html`]);
  await seed(h.storage, "geotag-runtime-v1", [...own, tileURL(1)]);
  await seed(h.storage, "geotag-shell-v99", own);
  await h.dispatch("install");
  await h.dispatch("activate");
  assert.deepEqual(new Set(h.storage.deleted), new Set(["geotag-shell-v2", "geotag-runtime-v2"]));
});

test("a nested registration preserves legacy caches belonging to the origin root", async () => {
  const h = harness();
  await seed(h.storage, "geotag-shell-v2", ["https://example.test/index.html", "https://example.test/app.js"]);
  await h.dispatch("install");
  await h.dispatch("activate");
  assert.ok((await h.storage.keys()).includes("geotag-shell-v2"));
});

test("shell fetches use only this release's cache and stay cache-first", async () => {
  const h = harness();
  const url = `${h.scope}app.js`;
  await seed(h.storage, "foreign-cache", [url]);
  await h.dispatch("install");
  const count = h.calls.length;
  h.setNetwork(async () => new Response("new server release"));
  const response = await h.fetchEvent(`${url}?v=future`).response;
  assert.equal(await response.text(), `network:${url}`);
  assert.equal(h.calls.length, count);
});

test("shell misses cache successes but never HTTP errors or partial responses", async () => {
  const h = harness();
  const url = `${h.scope}core.js`;
  for (const status of [404, 500, 206]) {
    h.setNetwork(async () => new Response("bad asset", { status }));
    assert.equal((await h.fetchEvent(url).response).status, status);
    assert.equal((await (await namedCache(h, "shell")).cache.keys()).length, 0);
  }
  h.setNetwork(async () => new Response("working asset"));
  assert.equal((await h.fetchEvent(url).response).status, 200);
  h.setNetwork(offline);
  assert.equal(await (await h.fetchEvent(url).response).text(), "working asset");
  const missing = await h.fetchEvent(`${h.scope}services.js`).response;
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get("Cache-Control"), "no-store");
});

test("storage failure still permits successful shell and tile network responses", async () => {
  const h = harness({ network: async () => new Response("online", { headers: { "Content-Type": "image/png" } }) });
  h.storage.failOpen = true;
  for (const url of [`${h.scope}app.js`, tileURL(1)]) {
    assert.equal(await (await h.fetchEvent(url).response).text(), "online");
  }
  h.setNetwork(offline);
  assert.equal((await h.fetchEvent(`${h.scope}app.js`).response).status, 503);
  assert.equal((await h.fetchEvent(tileURL(1)).response).status, 503);
});

test("API, unknown asset, non-GET, and lookalike tile requests bypass SW caching", async () => {
  const h = harness();
  for (const url of [
    "https://nominatim.openstreetmap.org/search?q=Jakarta&format=json",
    "https://nominatim.openstreetmap.org/reverse?lat=-6.2&lon=106.8",
    "https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://another.test/geotag-web/app.js",
    "https://example.test/another-app/app.js",
    `${h.scope}unknown.json`, `${h.scope}sw.js`,
    "https://tile.openstreetmap.org.evil.test/1/0/0.png",
    "https://tile.openstreetmap.org:444/1/0/0.png",
    "http://tile.openstreetmap.org/1/0/0.png",
    "https://tile.openstreetmap.org/1/0/0.png?search=secret",
    "https://tile.openstreetmap.org/search?q=Jakarta",
    "https://tile.openstreetmap.de.evil.test/1/0/0.png",
    "https://tile.openstreetmap.de:444/1/0/0.png",
    "http://tile.openstreetmap.de/1/0/0.png",
    "https://tile.openstreetmap.de/1/0/0.png?search=secret",
    "https://tile.openstreetmap.de/search?q=Jakarta",
    "https://tile.openstreetmap.org/1/0/0.png"
  ]) assert.equal(h.fetchEvent(url).handled, false, url);
  assert.equal(h.fetchEvent(`${h.scope}app.js`, { method: "POST" }).handled, false);
  assert.equal(h.fetchEvent(tileURL(1), { method: "HEAD" }).handled, false);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.storage.keys()).length, 0);
});

test("street-map images use readable CORS responses and cached tiles work offline", async () => {
  const h = harness({ network: async () => tileResponse() });
  assert.equal((await h.fetchEvent(tileURL(1), { mode: "no-cors" }).response).status, 200);
  assert.ok(h.calls.every((request) => request.mode === "cors" && request.credentials === "omit"));
  const networkCount = h.calls.length;
  h.setNetwork(offline);
  assert.equal(await (await h.fetchEvent(tileURL(1)).response).text(), "tile bytes");
  assert.equal(h.calls.length, networkCount);
  const missing = await h.fetchEvent(tileURL(2)).response;
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get("Cache-Control"), "no-store");
  assert.equal(missing.headers.get("Content-Type"), "image/svg+xml");
  assert.match(await missing.text(), /Peta offline/);
  assert.equal((await (await namedCache(h, "tiles")).cache.keys()).length, 1);
});

test("failed, opaque, and partial tile responses cannot poison the tile cache", async () => {
  const h = harness();
  for (const status of [403, 404, 429, 500]) {
    h.setNetwork(async () => new Response("failed tile", { status }));
    assert.equal((await h.fetchEvent(tileURL(status)).response).status, 503);
  }
  h.setNetwork(async () => {
    const response = Response.error();
    Object.defineProperty(response, "type", { value: "opaque" });
    return response;
  });
  assert.equal((await h.fetchEvent(tileURL(3)).response).status, 503);
  h.setNetwork(async () => new Response("partial tile", { status: 206 }));
  assert.equal((await h.fetchEvent(tileURL(4)).response).status, 503);
  h.setNetwork(async () => new Response("<html>Access blocked</html>", { headers: { "Content-Type": "text/html" } }));
  assert.equal((await h.fetchEvent(tileURL(5)).response).status, 503);
  assert.equal((await (await namedCache(h, "tiles")).cache.keys()).length, 0);
});

test("activating the map fix discards old blocked tiles without touching other apps", async () => {
  const h = harness();
  const oldName = `${namespace(h.scope)}tiles-v3.0.0`;
  await seed(h.storage, oldName, ["https://tile.openstreetmap.org/16/32808/51088.png"]);
  await seed(h.storage, "other-application", ["https://tile.openstreetmap.org/16/32808/51088.png"]);
  await h.dispatch("install");
  await h.dispatch("activate");
  assert.ok(!(await h.storage.keys()).includes(oldName));
  assert.ok((await h.storage.keys()).includes("other-application"));
  assert.equal(h.fetchEvent("https://tile.openstreetmap.org/16/32808/51088.png").handled, false);
});

test("concurrent tile requests serialize eviction and never exceed 100 entries", async () => {
  const h = harness({ network: async () => tileResponse() });
  const responses = await Promise.all(Array.from({ length: 140 }, (_, i) => h.fetchEvent(tileURL(i)).response));
  assert.ok(responses.every((response) => response.status === 200));
  const { cache } = await namedCache(h, "tiles");
  assert.equal((await cache.keys()).length, 100);
  assert.equal(cache.peakSize, 100);
  assert.equal(cache.peakMutations, 1);
  assert.equal(await cache.match(tileURL(0)), undefined);
  assert.ok(await cache.match(tileURL(139)));
});

test("tile fetch lifetime waits for eviction and subsequent queued writes", async (t) => {
  const h = harness({ network: async () => tileResponse() });
  await h.fetchEvent(tileURL(0)).response;
  const { cache } = await namedCache(h, "tiles");
  for (let i = 1; i < 100; i += 1) await cache.put(tileURL(i), tileResponse());
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  cache.beforeDelete = async () => { entered.resolve(); await release.promise; };
  let completed = false;
  const first = h.fetchEvent(tileURL(100)).response.then((value) => { completed = true; return value; });
  const second = h.fetchEvent(tileURL(101)).response;
  await entered.promise;
  assert.equal(completed, false);
  assert.equal((await cache.keys()).length, 100);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal((await cache.keys()).length, 100);
  assert.equal(cache.peakMutations, 1);
  assert.equal(cache.peakSize, 100);
});

test("a rejected tile cache write does not break later queued requests", async () => {
  const h = harness({ network: async () => tileResponse() });
  await h.fetchEvent(tileURL(0)).response;
  const { cache } = await namedCache(h, "tiles");
  cache.failPuts = 1;
  assert.equal((await h.fetchEvent(tileURL(1)).response).status, 200);
  assert.equal(await cache.match(tileURL(1)), undefined);
  assert.equal((await h.fetchEvent(tileURL(2)).response).status, 200);
  assert.ok(await cache.match(tileURL(2)));
});

test("activation awaits trimming an oversized tile cache before claiming clients", async (t) => {
  const h = harness({ network: async () => tileResponse() });
  await h.dispatch("install");
  await h.fetchEvent(tileURL(0)).response;
  const { cache } = await namedCache(h, "tiles");
  for (let i = 1; i < 103; i += 1) await cache.put(tileURL(i), tileResponse());
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  cache.beforeDelete = async () => { entered.resolve(); await release.promise; };
  const activation = h.dispatch("activate");
  await entered.promise;
  assert.equal(h.counts.claim, 0);
  release.resolve();
  await activation;
  assert.equal((await cache.keys()).length, 100);
  assert.equal(h.counts.claim, 1);
});
