const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../../core.js");
const jpeg = fs.readFileSync(path.join(__dirname, "../fixtures/photo.jpg"));
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const input = (name = "photo.jpg", buffer = jpeg, mimeType = "image/jpeg") => ({ name, buffer, mimeType });

async function mockServices(context, unavailable = false) {
  await context.route("https://tile.openstreetmap.de/**", (route) => route.fulfill({ status: unavailable ? 503 : 200, contentType: "image/png", body: tile, headers: { "Access-Control-Allow-Origin": "*" } }));
  await context.route("https://nominatim.openstreetmap.org/**", (route) => {
    if (unavailable) return route.fulfill({ status: 503, body: "offline", headers: { "Access-Control-Allow-Origin": "*" } });
    const url = new URL(route.request().url());
    const place = { lat: "-6.2088", lon: "106.8456", name: "Taman Kota", display_name: "Jalan Merdeka 17, Jakarta, Indonesia", address: { road: "Jalan Merdeka", house_number: "17", city: "Jakarta", state: "DKI Jakarta", country: "Indonesia" } };
    return route.fulfill({ json: url.pathname.endsWith("search") ? [place] : place, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await context.route("https://api.open-meteo.com/**", (route) => route.fulfill({ json: { current: { temperature_2m: 29.2 } }, headers: { "Access-Control-Allow-Origin": "*" } }));
}

async function addPhoto(page, value = input()) {
  await page.locator("#fileInput").setInputFiles(value);
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#batchCount")).toContainText("foto dipilih");
}

async function chooseLocation(page) {
  await page.locator("#latInput").fill("-6,2088");
  await page.locator("#lngInput").fill("106.8456");
  await page.locator("#btnSetManual").click();
  await expect(page.locator("#locationSource")).toHaveText("MANUAL");
}

async function exportPhoto(page) {
  await page.locator("#btnApply").click();
  await expect(page.locator("#resultPanel")).toBeVisible();
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#previewBadge")).toHaveText("HASIL");
  const pending = page.waitForEvent("download");
  await page.locator("#btnDownload").click();
  const download = await pending;
  return { download, bytes: fs.readFileSync(await download.path()) };
}

test.beforeEach(async ({ context }) => { await mockServices(context); });

test("responsive editor starts without JS errors or horizontal overflow", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Setiap foto");
  await expect(page.locator("#btnApply")).toBeDisabled();
  await expect(page.locator("#emptyPreview")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("editor-empty.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("preview, theme editing, full-screen, GPS export and original pixel separation", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await addPhoto(page);
  await chooseLocation(page);
  await page.locator("#customTitle").fill("Kunjungan Lapangan");
  await page.locator("#customAddress").fill("Jalan Merdeka 17, Jakarta, Indonesia");
  await page.locator("#customNote").fill("Dokumentasi proyek");
  await expect(page.locator("#previewLoader")).toBeHidden();
  await page.locator('input[name="stampTheme"][value="dark"]').check();
  await page.locator("#stampPos").selectOption("top");
  const { bytes, download } = await exportPhoto(page);
  expect(download.suggestedFilename()).toBe("photo_geotag.jpg");
  const metadata = await C.readMetadata(new Blob([bytes]));
  expect(metadata.gps.lat).toBe(-6.2088);
  expect(metadata.gps.lng).toBe(106.8456);
  expect(metadata.exif["0th"][274]).toBe(1);
  expect(bytes.equals(jpeg)).toBe(false);
  await page.locator("#btnExpand").click();
  await expect(page.locator("#imageDialog")).toBeVisible();
  await page.locator("#btnCloseImage").click();
  await page.locator("#btnViewOriginal").click();
  await expect(page.locator("#previewBadge")).toHaveText("ASLI");
  await page.locator("#btnViewStamp").click();
  await expect(page.locator("#previewBadge")).toHaveText("HASIL");
  await page.screenshot({ path: testInfo.outputPath("editor-result.png"), fullPage: true });
  await page.locator("#customNote").fill("Catatan baru");
  await expect(page.locator("#resultStale")).toBeVisible();
  expect(errors).toEqual([]);
});

test("JPEG EXIF-only write and strip preserve original scan and orientation", async ({ page }) => {
  const exif = C.emptyExif(); exif["0th"][274] = 6; exif.Exif[36867] = "2024:02:29 07:30:12";
  const rotated = Buffer.from(await (await C.replaceExif(new Blob([jpeg]), C.buildExif(exif, { lat: 1, lng: 2 }))).arrayBuffer());
  await page.goto("/");
  await addPhoto(page, input("rotated.jpg", rotated));
  await expect(page.locator("#locationSource")).toHaveText("GPS FOTO");
  await page.locator("#stampToggle").uncheck();
  const { bytes } = await exportPhoto(page);
  const metadata = await C.readMetadata(new Blob([bytes]));
  expect(metadata.exif["0th"][274]).toBe(6);
  expect(metadata.exif.Exif[36867]).toBe("2024:02:29 07:30:12");
  const scan = (buffer) => buffer.subarray(C.jpegSegments(buffer).at(-1).end);
  expect(scan(bytes).equals(scan(rotated))).toBe(true);
  await page.locator("#stampToggle").check();
  await exportPhoto(page);
  await page.locator("#btnStrip").click();
  await expect(page.locator("#resultInfo")).toContainText("GPS EXIF dihapus");
  const pending = page.waitForEvent("download"); await page.locator("#btnDownload").click();
  const stripped = fs.readFileSync(await (await pending).path());
  const after = await C.readMetadata(new Blob([stripped]));
  expect(after.gps).toBeNull(); expect(after.exif["0th"][274]).toBe(6);
  expect(scan(stripped).equals(scan(rotated))).toBe(true);
});

test("invalid coordinates and files do not erase existing photos", async ({ page }) => {
  await page.goto("/"); await addPhoto(page);
  await page.locator("#latInput").fill("-6junk");
  await page.locator("#lngInput").fill("106"); await page.locator("#btnSetManual").click();
  await expect(page.locator("#coordLabel")).toContainText("tidak valid");
  await expect(page.locator("#btnApply")).toBeDisabled();
  await page.locator("#fileInput").setInputFiles(input("bad.jpg", Buffer.from("not jpeg")));
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator(".file-card")).toHaveCount(2);
  await expect(page.locator(".file-status.error")).toContainText("Pilih JPEG");
  await page.locator("#fileInput").setInputFiles([]);
  await expect(page.locator(".file-card")).toHaveCount(2);
  await page.locator('[aria-label="Hapus bad.jpg dari daftar"]').click();
  await expect(page.locator(".file-card")).toHaveCount(1);
});

test("batch ZIP contains every output and presets persist without personal text", async ({ page }) => {
  await page.goto("/");
  await addPhoto(page, [input("one.jpg"), input("two.jpg")]);
  await chooseLocation(page);
  await page.locator("#customTitle").fill("Tidak disimpan permanen");
  await page.locator('input[name="stampTheme"][value="dark"]').check();
  await page.locator("#btnApply").click();
  await expect(page.locator("#batchHint")).toContainText("2 hasil");
  await expect(page.locator("#operationProgress")).toBeHidden();
  const pending = page.waitForEvent("download"); await page.locator("#btnZip").click();
  const zip = fs.readFileSync(await (await pending).path());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.readUInt16LE(zip.length - 12)).toBe(2);
  await page.reload();
  await expect(page.locator('input[name="stampTheme"][value="dark"]')).toBeChecked();
  await expect(page.locator("#customTitle")).toHaveValue("");
  await expect(page.locator(".file-card")).toHaveCount(0);
});

test("offline services degrade to a usable stamp without fabricated weather", async ({ page, context }) => {
  await mockServices(context, true);
  await page.goto("/"); await addPhoto(page); await chooseLocation(page);
  await expect(page.locator("#infoWarning")).toBeVisible();
  const { bytes } = await exportPhoto(page);
  expect((await C.readMetadata(new Blob([bytes]))).gps.lat).toBe(-6.2088);
  await expect(page.locator("#infoWarning")).toContainText("Peta belum tersedia");
});

test("PNG is converted, panorama stamp stays inside image, and DMS is not truncated", async ({ page }) => {
  await page.goto("/");
  const generated = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 2400; canvas.height = 220;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#72885f"; ctx.fillRect(0, 0, 2400, 220);
    const target = { lat: -89.999999, lng: -179.999999, alt: 0, accuracy: 0 };
    const seen = [];
    const text = ctx.fillText.bind(ctx); ctx.fillText = (str, ...args) => { seen.push(str); text(str, ...args); };
    const settings = { enabled: true, theme: "light", width: 96, opacity: 96, position: "bottom", showMap: true, showAddress: true, showCoordinates: true, showPlusCode: true, showDate: true, showAltitude: true, showAccuracy: true };
    const box = GeoStamp.drawStamp(ctx, 2400, 220, target, { address: { title: "Lokasi panorama sangat panjang 🌏 日本語 Indonesia".repeat(5), detail: "Detail alamat panjang ".repeat(10) }, plus: "6P58QRRW+F6", date: "07/11/2026 10:12:30 GMT+07:00", map: null, mapAvailable: false }, settings);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { box, texts: seen, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
  expect(generated.box.x).toBeGreaterThanOrEqual(0); expect(generated.box.y).toBeGreaterThanOrEqual(0);
  expect(generated.box.y + generated.box.height).toBeLessThanOrEqual(220.01);
  expect(generated.box.x + generated.box.width).toBeLessThanOrEqual(2400.01);
  expect(generated.texts.join(" ")).toContain("180°");
  await addPhoto(page, input("panorama.png", Buffer.from(generated.bytes), "image/png"));
  await chooseLocation(page);
  const { bytes } = await exportPhoto(page);
  expect(bytes[0]).toBe(255); expect(bytes[1]).toBe(216);
  const metadata = await C.readMetadata(new Blob([bytes]));
  expect(metadata.exif.Exif[40962]).toBe(2400);
  expect(metadata.exif.Exif[40963]).toBe(220);
});

test("direct camera capture imports the photo and pulls device GPS automatically", async ({ page, context, browserName }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const position = { coords: { latitude: -6.1754, longitude: 106.8272, accuracy: 9, altitude: null, speed: null }, timestamp: Date.now() };
  if (browserName === "chromium") {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.1754, longitude: 106.8272, accuracy: 9 });
  } else {
    await page.addInitScript((position) => {
      navigator.geolocation.getCurrentPosition = (resolve) => resolve(position);
    }, position);
  }
  await page.goto("/");
  await expect(page.locator(".entry-camera")).toBeVisible();
  await page.locator("#cameraInput").setInputFiles(input("kamera.jpg"));
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#batchCount")).toContainText("1 foto");
  await expect(page.locator("#locationSource")).toHaveText("GPS PERANGKAT");
  await expect(page.locator("#coordLabel")).toContainText("±9 m");
  // Stempel pratinjau langsung memakai GPS perangkat yang baru diambil.
  await expect(page.locator("#previewBadge")).toHaveText("DRAF", { timeout: 15000 });
  expect(errors).toEqual([]);
});

test("search results and GPS permission errors stay actionable", async ({ page, context, browserName }) => {
  await page.goto("/");
  await page.locator("#searchBox").fill("Taman Kota"); await page.locator("#btnSearch").click();
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.locator(".search-result").click();
  await expect(page.locator("#locationSource")).toHaveText("PENCARIAN");
  if (browserName === "chromium") {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.2, longitude: 106.8, accuracy: 15 });
    await page.locator("#btnMyLoc").click();
    await expect(page.locator("#locationSource")).toHaveText("GPS PERANGKAT");
    await expect(page.locator("#coordLabel")).toContainText("±15 m");
  } else {
    await page.evaluate(() => { navigator.geolocation.getCurrentPosition = (resolve, reject) => reject({ code: 1 }); });
    await page.locator("#btnMyLoc").click();
    await expect(page.locator("#coordLabel")).toContainText("Izin lokasi ditolak");
    await expect(page.locator("#btnMyLoc")).toBeEnabled();
  }
});
