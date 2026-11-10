/* global GeoCore, OpenLocationCode */
"use strict";

window.GeoServices = (() => {
  // Satu sumber untuk peta interaktif dan peta yang digambar ke foto.
  const mapStyle = Object.freeze({
    template: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · <a href="https://www.fossgis.de/" target="_blank" rel="noopener">FOSSGIS</a>',
    credit: "© OpenStreetMap · FOSSGIS"
  });
  const memory = new Map();
  const maps = new Map();
  let nominatimQueue = Promise.resolve();
  let lastGeocoderStart = 0;

  function abortError() { return new DOMException("Proses dibatalkan.", "AbortError"); }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const abort = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { if (signal) signal.removeEventListener("abort", abort); resolve(); }, ms);
      if (signal) signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function fetchWithTimeout(url, signal, timeout = 8500) {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, mode: "cors", credentials: "omit" });
      if (!response.ok || response.status === 206) throw new Error(`Layanan merespons HTTP ${response.status}.`);
      // Baca body dalam batas waktu yang sama; respons header saja belum cukup.
      return { bytes: await response.arrayBuffer(), type: response.headers.get("Content-Type") || "" };
    } catch (error) {
      if (signal && signal.aborted) throw abortError();
      if (error.name === "AbortError") throw new Error("Layanan terlalu lama merespons.");
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
    }
  }

  function cached(key) {
    const entry = memory.get(key);
    if (!entry || Date.now() > entry.until) { memory.delete(key); return null; }
    return entry.value;
  }

  function remember(key, value, ttl) {
    if (memory.size >= 40) memory.delete(memory.keys().next().value);
    memory.set(key, { value, until: Date.now() + ttl });
    return value;
  }

  async function json(url, signal) {
    const response = await fetchWithTimeout(url, signal);
    return JSON.parse(new TextDecoder().decode(response.bytes));
  }

  function geocoder(url, signal) {
    const job = nominatimQueue.catch(() => {}).then(async () => {
      checkAbort(signal);
      const remaining = 1100 - (Date.now() - lastGeocoderStart);
      if (remaining > 0) await wait(remaining, signal);
      checkAbort(signal);
      lastGeocoderStart = Date.now();
      return json(url, signal);
    });
    nominatimQueue = job.catch(() => {});
    return job;
  }

  function addressFromResult(data) {
    const address = data.address || {};
    const city = address.city || address.town || address.village || address.municipality || address.county || "";
    const street = [address.road || address.pedestrian || address.neighbourhood, address.house_number].filter(Boolean).join(" ");
    const title = [street || data.name, city].filter(Boolean).join(", ") || (data.display_name || "").split(",")[0];
    const detail = [address.suburb || address.city_district, address.state, address.postcode, address.country].filter(Boolean).join(", ") || data.display_name || "";
    return { title, detail };
  }

  async function reverse(target, signal) {
    const key = `address:${target.lat.toFixed(6)},${target.lng.toFixed(6)}`;
    const existing = cached(key);
    if (existing) return existing;
    const query = new URLSearchParams({ format: "jsonv2", lat: target.lat, lon: target.lng, zoom: "18", "accept-language": "id" });
    const data = await geocoder(`https://nominatim.openstreetmap.org/reverse?${query}`, signal);
    if (data.error || !data.display_name) throw new Error("Alamat tidak ditemukan.");
    return remember(key, addressFromResult(data), 3600000);
  }

  async function search(text, signal) {
    const q = text.trim();
    if (!q) return [];
    const key = `search:${q.toLowerCase()}`;
    const existing = cached(key);
    if (existing) return existing;
    const query = new URLSearchParams({ format: "jsonv2", q, limit: "5", addressdetails: "1", "accept-language": "id" });
    const data = await geocoder(`https://nominatim.openstreetmap.org/search?${query}`, signal);
    if (!Array.isArray(data)) throw new Error("Hasil pencarian tidak valid.");
    return remember(key, data.map((result) => ({ lat: Number(result.lat), lng: Number(result.lon), label: result.display_name, address: addressFromResult(result) })).filter(GeoCore.validTarget), 3600000);
  }

  async function weather(target, signal) {
    const key = `weather:${target.lat.toFixed(3)},${target.lng.toFixed(3)}`;
    const existing = cached(key);
    if (existing) return existing.temp;
    const query = new URLSearchParams({ latitude: target.lat, longitude: target.lng, current: "temperature_2m" });
    const data = await json(`https://api.open-meteo.com/v1/forecast?${query}`, signal);
    const temp = data.current && data.current.temperature_2m;
    if (!GeoCore.finite(temp)) throw new Error("Suhu tidak tersedia.");
    remember(key, { temp }, 600000);
    return temp;
  }

  function tileLayout(lat, lng, zoom = 16, span = 384) {
    if (!GeoCore.validTarget({ lat, lng }) || Math.abs(lat) > 85.05112878) return [];
    const count = 2 ** zoom;
    const latitude = lat * Math.PI / 180;
    const centerX = (lng + 180) / 360 * count * 256;
    const centerY = (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * count * 256;
    const left = centerX - span / 2, top = centerY - span / 2;
    const tiles = [];
    for (let x = Math.floor(left / 256); x <= Math.floor((left + span - 1) / 256); x++) {
      for (let y = Math.floor(top / 256); y <= Math.floor((top + span - 1) / 256); y++) {
        if (y < 0 || y >= count) continue;
        tiles.push({ x: ((x % count) + count) % count, y, zoom, dx: x * 256 - left, dy: y * 256 - top });
      }
    }
    return tiles;
  }

  function tileUrl(zoom, x, y) {
    if (![zoom, x, y].every(Number.isInteger) || zoom < 0 || zoom > mapStyle.maxNativeZoom || x < 0 || x >= 2 ** zoom || y < 0 || y >= 2 ** zoom) throw new Error("Koordinat tile tidak valid.");
    return mapStyle.template.replace("{z}", zoom).replace("{x}", x).replace("{y}", y);
  }

  async function tileBlob(zoom, x, y, signal) {
    const response = await fetchWithTimeout(tileUrl(zoom, x, y), signal, 8500);
    if (!/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(response.type)) throw new Error("Layanan peta tidak mengembalikan gambar.");
    if (!["image/png", "image/jpeg", "image/webp"].includes(GeoCore.sniffType(new Uint8Array(response.bytes)))) throw new Error("Data tile peta tidak valid.");
    return new Blob([response.bytes], { type: response.type });
  }

  async function miniMap(target, zoom, signal) {
    const key = `${target.lat.toFixed(6)},${target.lng.toFixed(6)},${zoom}`;
    if (maps.has(key)) return { map: maps.get(key), mapAvailable: true };
    const tiles = tileLayout(target.lat, target.lng, zoom);
    if (!tiles.length) return { map: null, mapAvailable: false };
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e6ecef";
    context.fillRect(0, 0, 512, 512);
    const scale = 512 / 384;
    const loaded = await Promise.all(tiles.map(async (tile) => {
      let decoded;
      try {
        decoded = await GeoCore.decodeImage(await tileBlob(tile.zoom, tile.x, tile.y, signal));
        checkAbort(signal);
        context.drawImage(decoded.image, tile.dx * scale, tile.dy * scale, 256 * scale, 256 * scale);
        return true;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        return false;
      } finally { if (decoded) decoded.close(); }
    }));
    const available = loaded.every(Boolean);
    if (available) {
      if (maps.size >= 6) maps.delete(maps.keys().next().value);
      maps.set(key, canvas);
    }
    return { map: canvas, mapAvailable: available };
  }

  async function collect(target, settings, { signal, knownAddress } = {}) {
    checkAbort(signal);
    const warnings = [];
    const attempt = async (task, fallback, message) => {
      try { return await task(); }
      catch (error) { if (error.name === "AbortError") throw error; warnings.push(message); return fallback; }
    };
    const [address, temp, mapResult] = await Promise.all([
      settings.showAddress && !(settings.title && settings.address)
        ? knownAddress || attempt(() => reverse(target, signal), null, "Alamat belum tersedia; kamu bisa mengisinya manual.") : null,
      settings.showWeather ? attempt(() => weather(target, signal), null, "Suhu terkini belum tersedia.") : null,
      settings.showMap ? attempt(() => miniMap(target, Number(settings.mapZoom) || 16, signal), { map: null, mapAvailable: false }, "Peta belum tersedia.") : { map: null, mapAvailable: false }
    ]);
    if (settings.showMap && !mapResult.mapAvailable && !warnings.includes("Peta belum tersedia.")) warnings.push("Peta belum tersedia lengkap; koordinat tetap bisa digunakan.");
    checkAbort(signal);
    return { address, temp, ...mapResult, mapCredit: mapStyle.credit, plus: OpenLocationCode.encode(target.lat, target.lng, 10), warnings };
  }

  return { search, collect, tileLayout, tileUrl, tileBlob, mapStyle };
})();
