"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../core.js");
const piexif = require("../vendor/piexif.js");
const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/photo.jpg"));
const original = () => new Blob([jpeg], { type: "image/jpeg" });
const target = { lat: -6.2088, lng: 106.8456, alt: -23.7, accuracy: 6, speed: 0 };

test("coordinates reject empty, partial, non-finite, and out-of-range input", () => {
  for (const input of ["", " ", "6abc", "1e2", "NaN", "Infinity", "1,2,3", "91", "-91", null, undefined]) assert.equal(C.parseCoordinate(input, -90, 90), null, String(input));
  assert.equal(C.parseCoordinate(" −6,208800 ", -90, 90), -6.2088);
  assert.equal(C.parseCoordinate("0", -90, 90), 0);
  assert.equal(C.parseCoordinate("+180", -180, 180), 180);
  assert.equal(C.parseCoordinate("-.5", -90, 90), -0.5);
});

test("DMS round-trips the equator, poles, antimeridian, and second rollovers", () => {
  for (const degrees of [0, 0.000001, -6.2088, 106.8456, 179.999999999, 90, -180, 12.999999999]) {
    const dms = C.degToDms(degrees);
    assert.ok(dms[1][0] < 60);
    assert.ok(dms[2][0] / dms[2][1] < 60);
    assert.ok(Math.abs(C.dmsToDeg(dms) - Math.abs(degrees)) < 1 / 36000000);
  }
  assert.equal(C.formatDms(12.9999999, "N", "S"), "13°00′0.0″N");
  assert.equal(C.dmsToDeg([[1, 0], [0, 1], [0, 1]]), null);
  assert.equal(C.dmsToDeg([[1, 1], [60, 1], [0, 1]]), null);
});

test("invalid GPS is ignored while real zero-valued measurements survive", () => {
  assert.equal(C.gpsFromExif({ GPS: { 2: [[1, 1]], 4: [[2, 1]] } }), null);
  const exif = C.buildExif({}, { lat: 0, lng: 0, alt: 0, speed: 0, accuracy: 0 });
  const gps = C.gpsFromExif(exif);
  assert.deepEqual([gps.lat, gps.lng, gps.alt, gps.speed, gps.accuracy], [0, 0, 0, 0, 0]);
});

test("writing GPS replaces all old location fields and never mutates source EXIF", () => {
  const source = C.emptyExif();
  source["0th"][274] = 6;
  source.Exif[36867] = "2024:02:29 07:30:12";
  source.GPS = { 6: [400, 1], 5: 0, 13: [90, 1], 12: "K", 29: "2020:01:01", 7: [[1, 1], [0, 1], [0, 1]] };
  const snapshot = JSON.stringify(source);
  const write = C.buildExif(source, { lat: 20, lng: -70 });
  for (const tag of [5, 6, 7, 12, 13, 29]) assert.equal(write.GPS[tag], undefined);
  assert.equal(write["0th"][274], 6);
  const rendered = C.buildExif(source, target, { dimensions: { width: 200, height: 320 } });
  assert.equal(rendered["0th"][274], 1);
  assert.equal(rendered.Exif[40962], 200);
  assert.equal(rendered.Exif[40963], 320);
  assert.equal(rendered.thumbnail, null);
  const stripped = C.buildExif(source, null, { mode: "strip" });
  assert.deepEqual(stripped.GPS, {});
  assert.equal(stripped["0th"][274], 6);
  assert.equal(JSON.stringify(source), snapshot);
});

test("GPS measurement timestamps use UTC, not the device timezone or export time", () => {
  const stamp = Date.parse("2026-11-07T23:59:34Z");
  const exif = C.buildExif({}, { ...target, timestamp: stamp });
  assert.equal(exif.GPS[29], "2026:11:07");
  assert.deepEqual(exif.GPS[7], [[23, 1], [59, 1], [34, 1]]);
  assert.equal(C.buildExif({}, target).GPS[29], undefined);
});

test("using a photo's GPS preserves its valid original measurement time", async () => {
  const timestamp = Date.parse("2024-02-29T23:59:12.500Z");
  const first = await C.replaceExif(original(), C.buildExif({}, { ...target, timestamp }));
  const source = await C.readMetadata(first);
  assert.equal(source.gps.timestamp, timestamp);
  const next = await C.replaceExif(first, C.buildExif(source.exif, source.gps));
  assert.equal((await C.readMetadata(next)).gps.timestamp, timestamp);
  const invalid = C.buildExif({}, target);
  invalid.GPS[29] = "2023:02:29"; invalid.GPS[7] = [[12, 1], [0, 1], [0, 1]];
  assert.equal(C.gpsFromExif(invalid).timestamp, null);
  invalid.GPS[29] = "2024:02:29"; invalid.GPS[7] = [[24, 1], [0, 1], [0, 1]];
  assert.equal(C.gpsFromExif(invalid).timestamp, null);
});

test("real JPEG GPS write/read/strip preserves compressed scan bytes", async () => {
  const source = C.emptyExif();
  source.Exif[36867] = "2026:10:12 09:13:02";
  source["0th"][271] = "Fixture camera";
  const written = await C.replaceExif(original(), C.buildExif(source, target));
  const read = await C.readMetadata(written);
  assert.equal(read.gps.lat, target.lat);
  assert.equal(read.gps.lng, target.lng);
  assert.equal(read.gps.alt, -23.7);
  assert.equal(read.exif.Exif[36867], source.Exif[36867]);
  assert.equal(read.exif["0th"][271], "Fixture camera");
  const scan = (bytes) => bytes.subarray(C.jpegSegments(bytes).at(-1).end);
  assert.deepEqual(scan(Buffer.from(await written.arrayBuffer())), scan(jpeg));
  const stripped = await C.replaceExif(written, C.buildExif(read.exif, null, { mode: "strip" }));
  assert.equal((await C.readMetadata(stripped)).gps, null);
  assert.deepEqual(scan(Buffer.from(await stripped.arrayBuffer())), scan(jpeg));
});

test("replacing metadata avoids duplicate EXIF and retains non-EXIF APP1 data", async () => {
  const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0<metadata>fixture</metadata>");
  const xmpHeader = Buffer.from([255, 225, (xmp.length + 2) >> 8, (xmp.length + 2) & 255]);
  const image = new Blob([jpeg.subarray(0, 2), xmpHeader, xmp, jpeg.subarray(2)]);
  const first = await C.replaceExif(image, C.buildExif({}, target));
  const second = await C.replaceExif(first, C.buildExif({}, { lat: 12, lng: 13 }));
  const bytes = Buffer.from(await second.arrayBuffer());
  assert.equal(bytes.toString("binary").split("Exif\0\0").length - 1, 1);
  assert.ok(bytes.includes(xmp));
  assert.equal((await C.readMetadata(second)).gps.lat, 12);
});

test("JPEG contents are validated independently of MIME or extension", async () => {
  assert.equal((await C.readMetadata(new Blob([jpeg], { type: "text/plain" }))).type, "image/jpeg");
  await assert.rejects(C.readMetadata(new Blob(["not an image"], { type: "image/jpeg" })), /Pilih JPEG/);
  await assert.rejects(C.readMetadata(new Blob()), /kosong/);
  await assert.rejects(C.readMetadata(new Blob([Buffer.from([255, 216, 255, 225, 0, 50, 1])])), /terpotong/);
  await assert.rejects(C.readMetadata({ size: C.MAX_FILE_BYTES + 1 }), /35 MB/);
});

test("malformed EXIF is surfaced instead of being claimed as fully preserved", async () => {
  const payload = Buffer.from("Exif\0\0broken");
  const blob = new Blob([jpeg.subarray(0, 2), Buffer.from([255, 225, 0, payload.length + 2]), payload, jpeg.subarray(2)]);
  const result = await C.readMetadata(blob);
  assert.match(result.warning, /Metadata asli rusak/);
  assert.equal(result.gps, null);
});

test("render size is bounded without upscaling small or panoramic photos", () => {
  for (const [width, height] of [[12000, 9000], [4032, 3024], [40000, 100], [100, 40000], [320, 200]]) {
    const fitted = C.fitDimensions(width, height, 4096, 12000000);
    assert.ok(fitted.width <= 4096 && fitted.height <= 4096);
    assert.ok(fitted.width * fitted.height <= 12000000);
    assert.ok(fitted.width <= width && fitted.height <= height);
  }
  assert.deepEqual(C.fitDimensions(320, 200), { width: 320, height: 200, resized: false });
  assert.throws(() => C.fitDimensions(0, 1), /Ukuran/);
});

test("oversized raster headers are rejected before the browser allocates a bitmap", async () => {
  const metadata = await C.readMetadata(original());
  assert.deepEqual(metadata.dimensions, { width: 320, height: 200 });
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header);
  header.writeUInt32BE(50000, 16); header.writeUInt32BE(50000, 20);
  await assert.rejects(C.readMetadata(new Blob([header], { type: "image/png" })), /Resolusi foto terlalu besar/);
});

test("original photo dates preserve known offsets and do not invent an unknown timezone", () => {
  const exif = { Exif: { 36867: "2024:02:29 07:30:12" } };
  assert.equal(C.photoTime(exif).text, "29/02/2024 07:30:12");
  assert.match(C.photoTime(exif).source, /tidak tersimpan/);
  exif.Exif[36881] = "+05:30";
  const reloaded = piexif.load(piexif.dump(exif));
  assert.equal(C.photoTime(reloaded).text, "29/02/2024 07:30:12 GMT+05:30");
  exif.Exif[36867] = "2023:02:29 07:30:12";
  assert.match(C.photoTime(exif, "photo", "", new Date("2026-11-07T00:00:00Z")).source, /tidak tersedia/);
  assert.throws(() => C.photoTime({}, "custom", "2023-02-29T12:00"), /valid/);
  assert.throws(() => C.photoTime({}, "custom", ""), /valid/);
  assert.match(C.photoTime({}, "custom", "2024-02-29T12:00").text, /29\/02\/2024 12:00:00 GMT/);
});

test("ZIP contains intact JPEG bytes, UTF-8 filenames, valid CRCs, and unique names", async () => {
  const zip = Buffer.from(await (await C.makeZip([{ name: "é.jpg", blob: original() }, { name: "é.jpg", blob: original() }])).arrayBuffer());
  let offset = 0;
  const names = [];
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 6), 0x800);
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26);
    names.push(zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"));
    const data = zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    assert.deepEqual(data, jpeg);
    assert.equal(zip.readUInt32LE(offset + 14), C.crc32(data));
    offset += 30 + nameLength + size;
  }
  assert.deepEqual(names, ["é.jpg", "é_2.jpg"]);
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  assert.equal(zip.readUInt32LE(zip.length - 6), offset);
  assert.equal(C.crc32(Buffer.from("123456789")), 0xcbf43926);
});
