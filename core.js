/* global piexif */
"use strict";

// Logika yang sama dipakai browser dan tes Node; foto asli tidak pernah dimutasi.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./vendor/piexif.js"));
  else root.GeoCore = factory(root.piexif);
})(typeof globalThis !== "undefined" ? globalThis : this, function (exifLib) {
  const MAX_FILE_BYTES = 35 * 1024 * 1024;
  const MAX_BATCH_BYTES = 150 * 1024 * 1024;
  const MAX_FILES = 20;
  const MAX_INPUT_PIXELS = 80000000;
  const emptyExif = () => ({ "0th": {}, Exif: {}, GPS: {}, Interop: {}, "1st": {}, thumbnail: null });
  const cloneExif = (exif) => Object.assign(emptyExif(), JSON.parse(JSON.stringify(exif || {})));
  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const pad2 = (n) => String(n).padStart(2, "0");

  // piexif 1.0.6 mendahului tag zona waktu EXIF 2.31.
  for (const [id, name] of [[36880, "OffsetTime"], [36881, "OffsetTimeOriginal"], [36882, "OffsetTimeDigitized"]]) {
    exifLib.TAGS.Exif[id] = { name, type: "Ascii" };
  }

  function parseCoordinate(input, min, max) {
    const value = String(input).trim().replace(/\u2212/g, "-").replace(",", ".");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
    const n = Number(value);
    return finite(n) && n >= min && n <= max ? round6(n) : null;
  }

  function validTarget(target) {
    return !!target && finite(target.lat) && finite(target.lng) && Math.abs(target.lat) <= 90 && Math.abs(target.lng) <= 180;
  }

  function degToDms(degrees) {
    // Bulatkan jumlah detik dahulu, sehingga tidak pernah menghasilkan 60 detik.
    const ticks = Math.round(Math.abs(degrees) * 3600 * 10000);
    return [[Math.floor(ticks / 36000000), 1], [Math.floor(ticks / 600000) % 60, 1], [ticks % 600000, 10000]];
  }

  function dmsToDeg(dms) {
    if (!Array.isArray(dms) || dms.length !== 3 || dms.some((p) => !Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1]) || p[0] < 0 || p[1] <= 0)) return null;
    const values = dms.map((p) => p[0] / p[1]);
    if (values[1] >= 60 || values[2] >= 60) return null;
    return values[0] + values[1] / 60 + values[2] / 3600;
  }

  function formatDms(degrees, positive, negative) {
    const ticks = Math.round(Math.abs(degrees) * 36000);
    const d = Math.floor(ticks / 36000);
    const m = Math.floor(ticks / 600) % 60;
    const s = ((ticks % 600) / 10).toFixed(1);
    return `${d}°${pad2(m)}′${s}″${degrees < 0 ? negative : positive}`;
  }

  function formatCoord(lat, lng) {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  }

  function ratio(pair) {
    return Array.isArray(pair) && finite(pair[0]) && finite(pair[1]) && pair[1] > 0 ? pair[0] / pair[1] : null;
  }

  function gpsTimestamp(gps) {
    const date = /^(\d{4}):(\d{2}):(\d{2})\x00?$/.exec(gps[29] || "");
    if (!date || !validDateParts([...date.slice(1), 0, 0, 0]) || !Array.isArray(gps[7]) || gps[7].length !== 3) return null;
    const time = gps[7].map(ratio);
    if (time.some((n) => n === null || n < 0) || time[0] >= 24 || time[1] >= 60 || time[2] >= 60) return null;
    return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) + Math.round((time[0] * 3600 + time[1] * 60 + time[2]) * 1000);
  }

  function gpsFromExif(exif) {
    const gps = (exif || {}).GPS || {};
    let lat = dmsToDeg(gps[2]);
    let lng = dmsToDeg(gps[4]);
    if (lat === null || lng === null || !["N", "S"].includes(gps[1]) || !["E", "W"].includes(gps[3])) return null;
    if (gps[1] === "S") lat = -lat;
    if (gps[3] === "W") lng = -lng;
    if (!validTarget({ lat, lng })) return null;
    let alt = ratio(gps[6]);
    if (alt !== null && gps[5] === 1) alt = -alt;
    let speed = ratio(gps[13]);
    if (speed !== null) speed = gps[12] === "K" ? speed / 3.6 : gps[12] === "M" ? speed * 0.44704 : gps[12] === "N" ? speed * 0.514444 : null;
    return { lat: round6(lat), lng: round6(lng), alt, speed, accuracy: ratio(gps[31]), timestamp: gpsTimestamp(gps), source: "photo" };
  }

  function bytesToBinary(bytes) {
    let result = "";
    for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return result;
  }

  function binaryToBytes(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function sniffType(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytesToBinary(bytes.subarray(1, 8)) === "PNG\r\n\x1a\n") return "image/png";
    if (bytesToBinary(bytes.subarray(0, 4)) === "RIFF" && bytesToBinary(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    if (bytesToBinary(bytes.subarray(4, 8)) === "ftyp" && /heic|heix|hevc|hevx|mif1|msf1/.test(bytesToBinary(bytes.subarray(8, 32)))) return "image/heic";
    return null;
  }

  function jpegSegments(bytes) {
    if (sniffType(bytes) !== "image/jpeg") throw new Error("File ini bukan JPEG yang valid.");
    const segments = [];
    let offset = 2;
    while (offset < bytes.length) {
      const start = offset;
      if (bytes[offset++] !== 0xff) throw new Error("Struktur JPEG rusak.");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error("Header JPEG terpotong.");
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) throw new Error("Segmen JPEG terpotong.");
      if (marker === 0xda) return segments;
      segments.push({ start, end: offset + length, payload: offset + 2, marker });
      offset += length;
    }
    throw new Error("Data gambar JPEG tidak ditemukan.");
  }

  function isExifSegment(bytes, segment) {
    return segment.marker === 0xe1 && bytesToBinary(bytes.subarray(segment.payload, segment.payload + 6)) === "Exif\x00\x00";
  }

  function imageDimensions(bytes, type, segments = []) {
    const u16 = (i) => bytes[i] * 256 + bytes[i + 1];
    const le24 = (i) => bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536;
    if (type === "image/jpeg") {
      const frame = segments.find((part) => [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(part.marker));
      if (frame && frame.end >= frame.payload + 5) return { width: u16(frame.payload + 3), height: u16(frame.payload + 1) };
    }
    if (type === "image/png" && bytes.length >= 24) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === "image/webp" && bytes.length >= 30) {
      const kind = bytesToBinary(bytes.subarray(12, 16));
      if (kind === "VP8X") return { width: le24(24) + 1, height: le24(27) + 1 };
      if (kind === "VP8 ") return { width: (bytes[26] + bytes[27] * 256) & 16383, height: (bytes[28] + bytes[29] * 256) & 16383 };
      if (kind === "VP8L" && bytes[20] === 0x2f) return { width: 1 + (bytes[21] | ((bytes[22] & 63) << 8)), height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 15) << 10)) };
    }
    return null;
  }

  async function readMetadata(file) {
    if (!file.size) throw new Error("File kosong.");
    if (file.size > MAX_FILE_BYTES) throw new Error("Maksimum ukuran per foto 35 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffType(bytes);
    if (!type) throw new Error("Pilih JPEG, PNG, WebP, atau HEIC yang didukung browser.");
    const segments = type === "image/jpeg" ? jpegSegments(bytes) : [];
    const dimensions = imageDimensions(bytes, type, segments);
    if (dimensions && (dimensions.width * dimensions.height > MAX_INPUT_PIXELS || Math.max(dimensions.width, dimensions.height) > 32768)) throw new Error("Resolusi foto terlalu besar. Perkecil ke maksimum 80 MP / 32768 px per sisi sebelum dipilih.");
    let exif = emptyExif();
    let warning = "";
    if (type === "image/jpeg") {
      const segment = segments.find((part) => isExifSegment(bytes, part));
      if (segment) {
        try { exif = exifLib.load(bytesToBinary(bytes.subarray(segment.payload, segment.end))); }
        catch { warning = "Metadata asli rusak; metadata baru akan dibuat saat ekspor."; }
      }
    } else if (type === "image/heic") {
      warning = "HEIC akan diubah ke JPEG; metadata asli HEIC tidak dibaca.";
    }
    return { type, exif, gps: gpsFromExif(exif), warning, dimensions };
  }

  function buildExif(original, target, options = {}) {
    const exif = cloneExif(original);
    exif.GPS = {};
    if (options.mode !== "strip") {
      if (!validTarget(target)) throw new Error("Pilih koordinat yang valid terlebih dahulu.");
      const gps = exif.GPS;
      gps[0] = [2, 3, 0, 0];
      gps[1] = target.lat < 0 ? "S" : "N";
      gps[2] = degToDms(target.lat);
      gps[3] = target.lng < 0 ? "W" : "E";
      gps[4] = degToDms(target.lng);
      gps[18] = "WGS-84";
      if (finite(target.alt)) { gps[5] = target.alt < 0 ? 1 : 0; gps[6] = [Math.round(Math.abs(target.alt) * 100), 100]; }
      if (finite(target.speed) && target.speed >= 0) { gps[12] = "K"; gps[13] = [Math.round(target.speed * 3600), 1000]; }
      if (finite(target.accuracy) && target.accuracy >= 0) gps[31] = [Math.round(target.accuracy * 100), 100];
      // Timestamp GPS adalah waktu pengukuran, bukan waktu foto atau zona lokal.
      if (finite(target.timestamp)) {
        const date = new Date(target.timestamp);
        if (Number.isFinite(date.getTime())) {
          gps[29] = `${date.getUTCFullYear()}:${pad2(date.getUTCMonth() + 1)}:${pad2(date.getUTCDate())}`;
          gps[7] = [[date.getUTCHours(), 1], [date.getUTCMinutes(), 1], date.getUTCMilliseconds() ? [date.getUTCSeconds() * 1000 + date.getUTCMilliseconds(), 1000] : [date.getUTCSeconds(), 1]];
        }
      }
    }
    // Thumbnail lama bisa menampilkan stempel/lokasi yang berbeda dari hasil.
    exif["1st"] = {};
    exif.thumbnail = null;
    if (options.dimensions) {
      const { width, height } = options.dimensions;
      exif["0th"][274] = 1;
      exif["0th"][256] = width;
      exif["0th"][257] = height;
      exif.Exif[40962] = width;
      exif.Exif[40963] = height;
      exif.Exif[40961] = 1; // Canvas mengekspor sRGB.
      delete exif.Exif[37500]; // MakerNote berisi offset spesifik file asli.
      exif.Interop = {};
    }
    return exif;
  }

  async function replaceExif(file, exif) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const segments = jpegSegments(bytes);
    const payload = binaryToBytes(exifLib.dump(exif));
    if (payload.length > 65533) throw new Error("Metadata terlalu besar untuk satu segmen EXIF JPEG.");
    const length = payload.length + 2;
    const parts = [bytes.subarray(0, 2), new Uint8Array([0xff, 0xe1, length >> 8, length & 255]), payload];
    let offset = 2;
    for (const segment of segments) {
      if (!isExifSegment(bytes, segment)) continue;
      parts.push(bytes.subarray(offset, segment.start));
      offset = segment.end;
    }
    parts.push(bytes.subarray(offset));
    return new Blob(parts, { type: "image/jpeg" });
  }

  function fitDimensions(width, height, maxEdge = 3072, maxPixels = 12000000) {
    if (![width, height, maxEdge, maxPixels].every((n) => finite(n) && n > 0)) throw new Error("Ukuran gambar tidak valid.");
    const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    return { width: w, height: h, resized: w !== width || h !== height };
  }

  async function decodeImage(blob) {
    if (typeof createImageBitmap === "function") {
      try {
        const image = await createImageBitmap(blob, { imageOrientation: "from-image" });
        return { image, width: image.width, height: image.height, close: () => image.close() };
      } catch { /* Safari/HEIC: lanjut ke decoder <img>. */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("Gambar tidak dapat dibuka. Untuk HEIC, ekspor sebagai JPEG dari Foto/Files lalu pilih kembali."));
        image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("Gambar tidak mempunyai ukuran yang valid.");
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ""; URL.revokeObjectURL(url); } };
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  }

  function validDateParts(parts) {
    const [year, month, day, hour, minute, second] = parts.map(Number);
    if (year < 1900 || year > 9999) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  }

  function formatLocalDate(date) {
    const offset = -date.getTimezoneOffset();
    const zone = `GMT${offset < 0 ? "-" : "+"}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${zone}`;
  }

  function photoTime(exif, mode = "photo", custom = "", now = new Date()) {
    if (mode === "custom") {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(custom);
      if (!match || !validDateParts([...match.slice(1, 6), match[6] || "00"])) throw new Error("Isi tanggal dan waktu manual yang valid.");
      const date = new Date(custom);
      if (!Number.isFinite(date.getTime())) throw new Error("Waktu manual tidak valid.");
      return { text: formatLocalDate(date), source: "Waktu manual · zona perangkat" };
    }
    if (mode === "photo") {
      const tags = (exif || {}).Exif || {};
      const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})\x00?$/.exec(tags[36867] || "");
      if (match && validDateParts(match.slice(1))) {
        const [, y, m, d, h, min, s] = match;
        const rawOffset = String(tags[36881] || "").replace(/\x00$/, "");
        const hasOffset = /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(rawOffset);
        return { text: `${d}/${m}/${y} ${h}:${min}:${s}${hasOffset ? ` GMT${rawOffset}` : ""}`, source: hasOffset ? "Waktu pengambilan foto" : "Waktu foto · zona waktu tidak tersimpan" };
      }
    }
    return { text: formatLocalDate(now), source: mode === "photo" ? "Tanggal foto tidak tersedia · memakai waktu sesi" : "Waktu sesi · zona perangkat" };
  }

  function outputName(name, suffix = "_geotag") {
    const stem = String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, "").replace(/[\x00-\x1f<>:"|?*]/g, "_").slice(0, 160) || "foto";
    return `${stem}${suffix}.jpg`;
  }

  function formatBytes(bytes) {
    return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  // ZIP store: JPEG sudah terkompresi, jadi tidak perlu dependency kompresi.
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function makeZip(files) {
    const parts = [], directory = [], names = new Set();
    const encoder = new TextEncoder();
    let offset = 0;
    for (const file of files) {
      let name = outputName(file.name, "");
      const original = name;
      let counter = 2;
      while (names.has(name)) name = original.replace(/\.jpg$/, `_${counter++}.jpg`);
      names.add(name);
      const encoded = encoder.encode(name);
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      const crc = crc32(bytes);
      const local = new Uint8Array(30 + encoded.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x800, true);
      view.setUint16(12, 0x21, true); // DOS 1980-01-01, pas tanpa waktu foto.
      view.setUint32(14, crc, true);
      view.setUint32(18, bytes.length, true);
      view.setUint32(22, bytes.length, true);
      view.setUint16(26, encoded.length, true);
      local.set(encoded, 30);
      parts.push(local, file.blob);
      const central = new Uint8Array(46 + encoded.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      central.set(local.subarray(6, 28), 8);
      cv.setUint32(42, offset, true);
      central.set(encoded, 46);
      directory.push(central);
      offset += local.length + file.blob.size;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, directory.reduce((sum, part) => sum + part.length, 0), true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], { type: "application/zip" });
  }

  return { MAX_FILE_BYTES, MAX_BATCH_BYTES, MAX_FILES, MAX_INPUT_PIXELS, emptyExif, cloneExif, finite, round6, clamp, parseCoordinate, validTarget, degToDms, dmsToDeg, formatDms, formatCoord, gpsFromExif, bytesToBinary, binaryToBytes, sniffType, jpegSegments, imageDimensions, readMetadata, buildExif, replaceExif, fitDimensions, decodeImage, photoTime, outputName, formatBytes, crc32, makeZip };
});
