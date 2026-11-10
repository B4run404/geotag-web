const { test, expect } = require("@playwright/test");
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const source = "https://tile.openstreetmap.de/**";

test("street map loads through checked tiles and has zoom, scale, and recenter controls", async ({ page, context }) => {
  const errors = [], tileRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("tile.openstreetmap")) tileRequests.push(request.url()); });
  await context.route(source, (route) => route.fulfill({ contentType: "image/png", body: tile, headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.goto("/");
  await expect.poll(() => page.locator("#map .leaflet-tile-loaded:not(.map-tile-unavailable)").count()).toBeGreaterThan(0);
  await expect(page.locator("#mapNotice")).toBeHidden();
  await expect(page.locator(".leaflet-control-scale")).toBeVisible();
  await page.locator("#latInput").fill("-0.223228"); await page.locator("#lngInput").fill("100.634409");
  await page.locator("#btnSetManual").click();
  await expect(page.locator("#btnMapCenter")).toBeEnabled();
  await page.locator(".leaflet-control-zoom-in").click();
  await page.locator("#btnMapCenter").click();
  await expect.poll(async () => {
    const pin = await page.locator(".map-pin").boundingBox(), map = await page.locator("#map").boundingBox();
    return Math.abs(pin.x + 15 - (map.x + map.width / 2)) + Math.abs(pin.y + 38 - (map.y + map.height / 2));
  }).toBeLessThan(3);
  expect(tileRequests.length).toBeGreaterThan(0);
  expect(tileRequests.every((url) => url.startsWith("https://tile.openstreetmap.de/"))).toBe(true);
  expect(errors).toEqual([]);
});

test("a 403 PNG is never displayed as a map tile and retry recovers without reloading photos", async ({ page, context }) => {
  let blocked = true;
  await context.route(source, (route) => route.fulfill({ status: blocked ? 403 : 200, contentType: "image/png", body: tile, headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.goto("/");
  await expect(page.locator("#mapNotice")).toBeVisible();
  await expect.poll(() => page.locator(".map-tile-unavailable").count()).toBeGreaterThan(0);
  expect(await page.locator(".map-tile-unavailable").evaluateAll((images) => images.every((image) => !image.getAttribute("src") && getComputedStyle(image).visibility === "hidden"))).toBe(true);
  blocked = false;
  await page.locator("#btnMapRetry").click();
  await expect(page.locator("#mapNotice")).toBeHidden();
  await expect.poll(() => page.locator("#map .leaflet-tile-loaded:not(.map-tile-unavailable)").count()).toBeGreaterThan(0);
  await expect(page.locator(".map-tile-unavailable")).toHaveCount(0);
});

test("photo mini-map uses the same provider and is readable by Canvas", async ({ page, context }) => {
  const urls = [];
  await context.route(source, (route) => {
    urls.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: tile, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const info = await GeoServices.collect({ lat: -0.223228, lng: 100.634409 }, { showMap: true, showAddress: false, showWeather: false, mapZoom: 16 });
    return { available: info.mapAvailable, credit: info.mapCredit, png: info.map.toDataURL("image/png"), width: info.map.width, height: info.map.height };
  });
  expect(result.available).toBe(true);
  expect(result.credit).toContain("FOSSGIS");
  expect(result.png).toMatch(/^data:image\/png;base64,/);
  expect(result.width).toBe(512); expect(result.height).toBe(512);
  expect(urls.some((url) => url.includes("/16/"))).toBe(true);
});
