const { test, expect } = require("@playwright/test");

// Kartu stempel harus tetap ringkas: teks utuh, tetapi tinggi kartu kecil
// relatif terhadap foto, dan metrik tampil sebagai ikon + nilai tanpa label besar.
const fullSettings = {
  enabled: true, theme: "light", width: 94, opacity: 96, position: "bottom",
  showMap: true, showAddress: true, showCoordinates: true, showPlusCode: true,
  showDate: true, showAltitude: true, showAccuracy: true
};
const fullInfo = {
  address: { title: "Jalan Merdeka 17, Jakarta", detail: "Menteng, DKI Jakarta, Indonesia" },
  plus: "6P58QRRW+F6",
  date: "07/11/2026 10:12:30 GMT+07:00",
  map: null, mapAvailable: false, mapCredit: "© OpenStreetMap · FOSSGIS"
};

test("compact stamp keeps full text inside a low card on every orientation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(({ settings, info }) => {
    const seen = [];
    const boxes = {};
    for (const [name, width, height] of [["landscape", 1200, 800], ["portrait", 800, 1200], ["square", 1000, 1000]]) {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      const text = ctx.fillText.bind(ctx);
      ctx.fillText = (str, ...args) => { seen.push(str); text(str, ...args); };
      const target = { lat: -6.2088, lng: 106.8456, alt: 128, accuracy: 12, speed: 0 };
      boxes[name] = GeoStamp.drawStamp(ctx, width, height, target, info, settings);
    }
    return { boxes, seen };
  }, { settings: fullSettings, info: fullInfo });

  expect(result.boxes.landscape).not.toBeNull();
  expect(result.boxes.portrait).not.toBeNull();
  expect(result.boxes.square).not.toBeNull();
  expect(result.boxes.landscape.height / 800).toBeLessThanOrEqual(0.40);
  expect(result.boxes.portrait.height / 1200).toBeLessThanOrEqual(0.40);
  expect(result.boxes.square.height / 1000).toBeLessThanOrEqual(0.40);

  const text = result.seen.join(" ");
  expect(text).toContain("Jalan Merdeka 17, Jakarta");
  expect(text).toContain("Lat 6°12′31.7″S");
  expect(text).toContain("Plus Code  6P58QRRW+F6");
  expect(text).toContain("07/11/2026 10:12:30 GMT+07:00");
  expect(text).toContain("128 m");
  expect(text).toContain("±12 m");
  expect(text).toContain("Peta tidak tersedia");
  // Label huruf besar versi lama memakan ruang kartu; metrik kini ikon + nilai.
  expect(text).not.toContain("KETINGGIAN");
  expect(text).not.toContain("AKURASI");
  expect(text).not.toContain("KECEPATAN");
});

test("QR panel encodes the exact map location as scannable modules", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1800; canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    const target = { lat: -6.2088, lng: 106.8456 };
    const modules = [];
    const original = ctx.fillRect.bind(ctx);
    ctx.fillRect = (x, y, width, height) => { if (width < 8 && height < 8) modules.push(x); original(x, y, width, height); };
    const box = GeoStamp.drawStamp(ctx, 1800, 1200, target, { map: null, mapAvailable: false, mapCredit: "" }, { enabled: true, theme: "dark", showMap: false, showQR: true, showAddress: false, showCoordinates: true, showPlusCode: false, showDate: false, showAltitude: false, showAccuracy: false });
    const qr = qrcode(0, "M");
    qr.addData(`https://maps.google.com/?q=${target.lat.toFixed(6)},${target.lng.toFixed(6)}`);
    qr.make();
    let dark = 0;
    for (let row = 0; row < qr.getModuleCount(); row++) {
      for (let col = 0; col < qr.getModuleCount(); col++) if (qr.isDark(row, col)) dark++;
    }
    return { box, drawn: modules.length, dark, count: qr.getModuleCount(), rightEdge: modules.length ? Math.max(...modules) : 0 };
  });
  expect(result.box).not.toBeNull();
  expect(result.count).toBe(33);
  // Jumlah modul yang digambar persis sama dengan matriks QR untuk URL lokasi ini.
  expect(result.drawn).toBe(result.dark);
  // Koordinat dalam ruang kartu (lebar 1000): blok QR 810..978 — sisi kanan kartu.
  expect(result.rightEdge).toBeGreaterThan(900);
  expect(result.rightEdge).toBeLessThan(990);
  // Kartu tetap di dalam gambar.
  expect(result.box.x + result.box.width).toBeLessThanOrEqual(1800.01);
  expect(result.box.y + result.box.height).toBeLessThanOrEqual(1200.01);
});

test("metrics without footer stay within the card when toggles are combined", async ({ page }) => {
  await page.goto("/");
  const boxes = await page.evaluate(({ fullSettings, fullInfo }) => {
    const cases = [
      [{ ...fullSettings, showMap: false }, { lat: 1, lng: 2, alt: -5, accuracy: 0, speed: 40 }],
      [{ ...fullSettings, showAddress: false, showCoordinates: false, showPlusCode: false, showDate: false }, { lat: 1, lng: 2 }],
      [{ ...fullSettings, showAltitude: false, showAccuracy: false }, { lat: 1, lng: 2, alt: 5, accuracy: 5 }]
    ];
    return cases.map(([settings, target]) => {
      const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
      const ctx = canvas.getContext("2d");
      const box = GeoStamp.drawStamp(ctx, 600, 400, target, { ...fullInfo, map: null, mapAvailable: false }, settings);
      return { box, pixels: ctx.getImageData(0, 0, 600, 400).data.some((value) => value !== 0) };
    });
  }, { fullSettings, fullInfo });
  for (const { box, pixels } of boxes) {
    expect(box).not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(400.01);
    expect(pixels).toBe(true);
  }
});
