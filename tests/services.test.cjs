const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const C = require("../core.js");
const source = fs.readFileSync(path.join(__dirname, "../services.js"), "utf8");

function createServices(fetch) {
  const browser = { GeoCore: C, OpenLocationCode: { encode: () => "6P58QRRW+F6" }, fetch, AbortController, DOMException, URLSearchParams, TextDecoder, Blob, setTimeout, clearTimeout };
  browser.window = browser;
  vm.runInNewContext(source, browser);
  return browser.GeoServices;
}

test("tile coverage is complete, bounded, and wraps the antimeridian", () => {
  const service = createServices();
  for (const [lat, lng] of [[-6.2, 106.8], [0, 0], [0, 180], [0, -180], [85, 40]]) {
    const tiles = service.tileLayout(lat, lng, 16);
    assert.ok(tiles.length >= 4 && tiles.length <= 9);
    assert.ok(tiles.every((tile) => tile.x >= 0 && tile.x < 65536 && tile.y >= 0 && tile.y < 65536));
    const minX = Math.min(...tiles.map((tile) => tile.dx));
    const maxX = Math.max(...tiles.map((tile) => tile.dx + 256));
    const minY = Math.min(...tiles.map((tile) => tile.dy));
    const maxY = Math.max(...tiles.map((tile) => tile.dy + 256));
    assert.ok(minX <= 0 && maxX >= 384 && minY <= 0 && maxY >= 384);
  }
  assert.equal(service.tileLayout(90, 0).length, 0);
  assert.equal(service.tileLayout(-90, 0).length, 0);
});

test("disabled network fields require no API calls and Plus Code stays available", async () => {
  let calls = 0;
  const service = createServices(async () => { calls++; throw new Error("no network"); });
  const info = await service.collect({ lat: -6.2, lng: 106.8 }, { showMap: false, showAddress: false, showWeather: false });
  assert.equal(info.plus, "6P58QRRW+F6");
  assert.equal(info.temp, null);
  assert.equal(info.address, null);
  assert.equal(calls, 0);
});

test("failed weather is not cached as a permanent error and valid zero is retained", async () => {
  let calls = 0;
  const service = createServices(async () => {
    calls++;
    if (calls === 1) return new Response("unavailable", { status: 503 });
    return Response.json({ current: { temperature_2m: 0 } });
  });
  const target = { lat: 1, lng: 1 }, settings = { showMap: false, showAddress: false, showWeather: true };
  assert.equal((await service.collect(target, settings)).temp, null);
  assert.equal((await service.collect(target, settings)).temp, 0);
  assert.equal((await service.collect(target, settings)).temp, 0);
  assert.equal(calls, 2);
});

test("aborted collection does not turn cancellation into an offline fallback", async () => {
  const service = createServices(async () => { throw new Error("must not run"); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.collect({ lat: 1, lng: 1 }, {}, { signal: controller.signal }), { name: "AbortError" });
});

test("editor and photo map share the new street-tile source and validated coordinates", () => {
  const service = createServices();
  assert.equal(service.tileUrl(16, 51088, 32808), "https://tile.openstreetmap.de/16/51088/32808.png");
  assert.match(service.mapStyle.credit, /OpenStreetMap.*FOSSGIS/);
  for (const coords of [[16, -1, 0], [16, 65536, 0], [20, 0, 0], [16.5, 0, 0]]) assert.throws(() => service.tileUrl(...coords), /tidak valid/);
});

test("tile loader rejects blocked PNGs, HTML, partial responses, and corrupt image bytes", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  let response;
  const service = createServices(async () => response.clone());
  for (const status of [403, 429, 206]) {
    response = new Response(bytes, { status, headers: { "Content-Type": "image/png" } });
    await assert.rejects(service.tileBlob(16, 51088, 32808), /HTTP/);
  }
  response = new Response("<h1>Access blocked</h1>", { headers: { "Content-Type": "text/html" } });
  await assert.rejects(service.tileBlob(16, 51088, 32808), /tidak mengembalikan gambar/);
  response = new Response("not png", { headers: { "Content-Type": "image/png" } });
  await assert.rejects(service.tileBlob(16, 51088, 32808), /tidak valid/);
  response = new Response(bytes, { headers: { "Content-Type": "image/png" } });
  assert.deepEqual(Buffer.from(await (await service.tileBlob(16, 51088, 32808)).arrayBuffer()), bytes);
});
