const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../../core.js");
const jpeg = fs.readFileSync(path.join(__dirname, "../fixtures/photo.jpg"));

async function setup(page, context) {
  await context.route(/^https:\/\/(?:.*\.)?(?:openstreetmap\.org|openstreetmap\.de|open-meteo\.com)\//, (route) => route.fulfill({ status: 503, body: "offline", headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.goto("/");
}

async function inputPhoto(page) {
  await page.locator("#fileInput").setInputFiles({ name: "fixture.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#batchCount")).toContainText("1 foto");
  await page.locator("#showMap").uncheck();
  await page.locator("#showAddress").uncheck();
  await page.locator("#latInput").fill("-6.2"); await page.locator("#lngInput").fill("106.8");
  await page.locator("#btnSetManual").click();
}

test("cancelling an async batch unlocks controls and preserves the previous output", async ({ page, context }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page, context); await inputPhoto(page);
  await page.locator("#btnApply").click();
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#resultPanel")).toBeVisible();
  const before = await page.locator("#resultInfo").textContent();
  await page.evaluate(() => {
    GeoServices.collect = (target, settings, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("cancel", "AbortError")); return; }
      signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), { once: true });
    });
  });
  await page.locator("#customTitle").fill("Pemrosesan berikutnya");
  await page.locator("#btnApply").click();
  await expect(page.locator("#operationProgress")).toBeVisible();
  await expect(page.locator("#stampToggle")).toBeDisabled();
  await expect(page.locator("#latInput")).toBeDisabled();
  await expect(page.locator("#btnAddFiles")).toBeDisabled();
  await page.locator("#btnCancel").click();
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#btnApply")).toBeEnabled();
  await expect(page.locator("#resultInfo")).toHaveText(before);
  await expect(page.locator("#resultStale")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a late GPS callback cannot overwrite a more recent manually chosen location", async ({ page, context }) => {
  await setup(page, context);
  await page.evaluate(() => { navigator.geolocation.getCurrentPosition = (resolve) => { window.completeGPS = resolve; }; });
  await page.locator("#btnMyLoc").click();
  await page.locator("#latInput").fill("12.5"); await page.locator("#lngInput").fill("-45.5");
  await page.locator("#btnSetManual").click();
  await page.evaluate(() => window.completeGPS({ coords: { latitude: 1, longitude: 2, accuracy: 20 }, timestamp: Date.now() }));
  await expect(page.locator("#latInput")).toHaveValue("12.500000");
  await expect(page.locator("#lngInput")).toHaveValue("-45.500000");
  await expect(page.locator("#locationSource")).toHaveText("MANUAL");
});

test("HTML image fallback renders photos when createImageBitmap is unavailable", async ({ page, context }) => {
  await page.addInitScript(() => { window.createImageBitmap = undefined; });
  await setup(page, context); await inputPhoto(page);
  await page.locator("#btnApply").click();
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator("#resultPanel")).toBeVisible();
  await expect(page.locator(".file-status.error")).toHaveCount(0);
});

test("a cancelled photo import can be retried with the identical file", async ({ page, context }) => {
  await setup(page, context);
  await page.evaluate(() => {
    const read = GeoCore.readMetadata;
    GeoCore.readMetadata = (file) => {
      GeoCore.readMetadata = read;
      return new Promise((resolve, reject) => { window.finishRead = () => read(file).then(resolve, reject); });
    };
  });
  // File chooser timestamps are fixed here to exercise the exact dedupe path.
  await page.evaluate(async (bytes) => {
    window.retryFile = new File([new Uint8Array(bytes)], "retry.jpg", { type: "image/jpeg", lastModified: 1000 });
    const transfer = new DataTransfer(); transfer.items.add(window.retryFile);
    document.getElementById("fileInput").files = transfer.files;
    document.getElementById("fileInput").dispatchEvent(new Event("change"));
  }, Array.from(jpeg));
  await expect(page.locator("#operationProgress")).toBeVisible();
  await page.locator("#btnCancel").click();
  await page.evaluate(() => window.finishRead());
  await expect(page.locator("#operationProgress")).toBeHidden();
  await expect(page.locator(".file-status.error")).toContainText("dibatalkan");
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(window.retryFile);
    document.getElementById("fileInput").files = transfer.files;
    document.getElementById("fileInput").dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#batchCount")).toContainText("1 foto dipilih");
  await expect(page.locator(".file-card")).toHaveCount(1);
  await expect(page.locator(".file-status.error")).toHaveCount(0);
});

test("a late search response cannot replace the selected-location status", async ({ page, context }) => {
  await setup(page, context);
  await page.evaluate(() => {
    GeoServices.search = () => new Promise((resolve) => {
      window.finishSearch = () => resolve([{ lat: 1, lng: 2, label: "Hasil lama" }]);
    });
  });
  await page.locator("#searchBox").fill("lokasi pertama"); await page.locator("#btnSearch").click();
  await page.locator("#latInput").fill("-6.2"); await page.locator("#lngInput").fill("106.8");
  await page.locator("#btnSetManual").click();
  await page.evaluate(() => window.finishSearch());
  await expect(page.locator("#coordLabel")).toHaveText("-6.200000, 106.800000");
  await expect(page.locator("#searchResults")).toBeHidden();
  await expect(page.locator("#btnSearch")).toBeEnabled();
  await expect(page.locator("#latInput")).toHaveAttribute("inputmode", "text");
});

test("PNG export quality remains adjustable with the visual stamp disabled", async ({ page, context }) => {
  await setup(page, context);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 4000; canvas.height = 200;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#718090"; ctx.fillRect(0, 0, 4000, 200);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator("#fileInput").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(png) });
  await expect(page.locator("#operationProgress")).toBeHidden();
  await page.locator("#latInput").fill("0"); await page.locator("#lngInput").fill("0"); await page.locator("#btnSetManual").click();
  await page.locator("#stampToggle").uncheck();
  await page.locator("#exportOptions summary").click();
  await expect(page.locator("#maxEdge")).toBeEnabled();
  await expect(page.locator("#jpegQuality")).toBeEnabled();
  await page.locator("#maxEdge").selectOption("2048");
  await page.locator("#jpegQuality").selectOption("0.85");
  await page.locator("#btnApply").click();
  await expect(page.locator("#resultInfo")).toContainText("2048 × 102 px");
});

test("mobile preview auto-scroll works after import and export", async ({ page, context }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page, context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#fileInput").setInputFiles({ name: "auto.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#operationProgress")).toBeHidden();
  // Ukur posisi panel setelah daftar foto tampil, lalu pastikan auto-scroll mendarat tepat.
  const expectedScroll = () => page.evaluate(() => {
    const top = document.getElementById("previewPanel").getBoundingClientRect().top + window.scrollY;
    return Math.abs(window.scrollY - Math.max(0, top - 16));
  });
  await expect.poll(expectedScroll).toBeLessThan(24);
  await page.locator("#showMap").uncheck();
  await page.locator("#showAddress").uncheck();
  await page.locator("#latInput").fill("-6.2"); await page.locator("#lngInput").fill("106.8");
  await page.locator("#btnSetManual").click();
  await page.locator("#btnApply").click();
  await expect(page.locator("#resultPanel")).toBeVisible();
  await expect.poll(expectedScroll).toBeLessThan(24);
  expect(errors).toEqual([]);
});

test.describe("installed offline shell", () => {
  test.use({ serviceWorkers: "allow" });

  test("a complete reload and JPEG export work with the network disconnected", async ({ page, context }) => {
    await setup(page, context);
    await expect(page.locator("#offlineState")).toContainText("siap digunakan offline");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toContainText("Offline");
    await inputPhoto(page);
    await page.locator("#btnApply").click();
    await expect(page.locator("#operationProgress")).toBeHidden();
    await expect(page.locator("#resultPanel")).toBeVisible();
    const pending = page.waitForEvent("download"); await page.locator("#btnDownload").click();
    const data = fs.readFileSync(await (await pending).path());
    expect((await C.readMetadata(new Blob([data]))).gps.lat).toBe(-6.2);
    const stored = await page.evaluate(async () => {
      const names = await caches.keys();
      const shell = await caches.open(names.find((name) => name.includes("shell-")));
      return (await shell.keys()).map((request) => request.url);
    });
    expect(stored.some((url) => url.endsWith("/vendor/openlocationcode.js"))).toBe(true);
    expect(stored.some((url) => url.endsWith("/stamp.js"))).toBe(true);
  });
});
