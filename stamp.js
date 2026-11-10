"use strict";

// Renderer saja: decoding/orientasi milik GeoCore, metadata dan peta milik pemanggil.
window.GeoStamp = (() => {
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
  const CARD_WIDTH = 1000;
  const PAD = 22;
  const MAP_SIZE = 168;
  const MAP_GAP = 20;
  const PIN_GUTTER = 72;
  const SHADOW_SPACE = 14;
  const MAX_TEXT_LENGTH = 8192;
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const numberFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

  const palettes = {
    light: {
      card: "#ffffff", ink: "#172233", secondary: "#516074", muted: "#6a788b",
      line: "#e2e8ef", accent: "#e83f4c", accentSoft: "#fff0f2",
      badge: "#f0f4f8", map: "#edf2f6", grid: "#dce4ed"
    },
    dark: {
      card: "#141e2d", ink: "#f7f9fc", secondary: "#c4cfdd", muted: "#a0b0c4",
      line: "#354357", accent: "#ff5965", accentSoft: "#3b2734",
      badge: "#253449", map: "#202e40", grid: "#324359"
    }
  };

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function clamp(value, min, max, fallback) {
    return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  function positiveLimit(value, fallback) {
    return finite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
  }

  function options(settings) {
    const s = settings || {};
    return {
      enabled: s.enabled !== false,
      theme: s.theme === "dark" ? "dark" : "light",
      position: s.position === "top" ? "top" : "bottom",
      width: clamp(s.width, 60, 96, 94),
      opacity: clamp(s.opacity, 60, 100, 96),
      showMap: s.showMap !== false,
      showCoordinates: s.showCoordinates !== false,
      showAddress: s.showAddress !== false,
      showPlusCode: s.showPlusCode !== false,
      showDate: s.showDate !== false,
      showWeather: s.showWeather === true,
      showAltitude: s.showAltitude !== false,
      showAccuracy: s.showAccuracy !== false,
      title: s.title, address: s.address, note: s.note,
      quality: clamp(s.quality, 0, 1, 0.94),
      maxEdge: positiveLimit(s.maxEdge, 3072)
    };
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  // (x, tipY) adalah titik lokasi, bukan pusat kepala pin.
  function drawPin(ctx, x, tipY, height, color, outline = false) {
    const top = tipY - height;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, tipY);
    ctx.bezierCurveTo(x - height * 0.08, tipY - height * 0.13,
      x - height * 0.34, top + height * 0.56, x - height * 0.34, top + height * 0.34);
    ctx.bezierCurveTo(x - height * 0.34, top + height * 0.15, x - height * 0.19, top, x, top);
    ctx.bezierCurveTo(x + height * 0.19, top, x + height * 0.34, top + height * 0.15,
      x + height * 0.34, top + height * 0.34);
    ctx.bezierCurveTo(x + height * 0.34, top + height * 0.56,
      x + height * 0.08, tipY - height * 0.13, x, tipY);
    ctx.closePath();
    if (outline) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = height * 0.12;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, top + height * 0.34, height * 0.115, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawIcon(ctx, kind, x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (kind === "altitude") {
      ctx.moveTo(-10, 8); ctx.lineTo(-2, -8); ctx.lineTo(6, 8); ctx.closePath();
      ctx.moveTo(3, 2); ctx.lineTo(7, -4); ctx.lineTo(12, 8); ctx.lineTo(6, 8);
      ctx.moveTo(-5, -2); ctx.lineTo(-2, 0); ctx.lineTo(1, -2);
    } else if (kind === "accuracy") {
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.moveTo(-11, 0); ctx.lineTo(-5, 0);
      ctx.moveTo(5, 0); ctx.lineTo(11, 0);
      ctx.moveTo(0, -11); ctx.lineTo(0, -5);
      ctx.moveTo(0, 5); ctx.lineTo(0, 11);
      ctx.moveTo(2, 0); ctx.arc(0, 0, 2, 0, Math.PI * 2);
    } else if (kind === "speed") {
      ctx.arc(0, 2, 9, Math.PI * 0.82, Math.PI * 2.18);
      ctx.moveTo(-6, 8); ctx.lineTo(6, 8);
      ctx.moveTo(0, 3); ctx.lineTo(5, -4);
      ctx.moveTo(-6, -3); ctx.lineTo(-4, -1);
      ctx.moveTo(0, -7); ctx.lineTo(0, -5);
    } else if (kind === "weather") {
      ctx.moveTo(-3, 3); ctx.lineTo(-3, -7);
      ctx.bezierCurveTo(-3, -11, 3, -11, 3, -7);
      ctx.lineTo(3, 3); ctx.arc(0, 7, 5, -Math.PI * 0.3, Math.PI * 1.3);
      ctx.closePath();
      ctx.moveTo(0, -4); ctx.lineTo(0, 8);
      ctx.moveTo(6, -5); ctx.lineTo(9, -5);
      ctx.moveTo(6, -1); ctx.lineTo(8, -1);
    } else if (kind === "calendar") {
      roundRect(ctx, -9, -7, 18, 16, 3);
      ctx.moveTo(-9, -2); ctx.lineTo(9, -2);
      ctx.moveTo(-4, -10); ctx.lineTo(-4, -5);
      ctx.moveTo(4, -10); ctx.lineTo(4, -5);
      ctx.moveTo(-4, 3); ctx.lineTo(-1, 3);
      ctx.moveTo(3, 3); ctx.lineTo(4, 3);
    } else if (kind === "plus") {
      roundRect(ctx, -9, -9, 18, 18, 3);
      ctx.moveTo(-4, 0); ctx.lineTo(4, 0);
      ctx.moveTo(0, -4); ctx.lineTo(0, 4);
    } else if (kind === "note") {
      ctx.moveTo(-8, -6); ctx.lineTo(8, -6);
      ctx.moveTo(-8, 0); ctx.lineTo(8, 0);
      ctx.moveTo(-8, 6); ctx.lineTo(3, 6);
    } else if (kind === "unavailable") {
      roundRect(ctx, -9, -9, 18, 18, 4);
      ctx.moveTo(-4, -9); ctx.lineTo(-4, 1);
      ctx.moveTo(4, -1); ctx.lineTo(4, 9);
      ctx.moveTo(-12, 12); ctx.lineTo(12, -12);
    }
    ctx.stroke();
    ctx.restore();
  }

  function font(ctx, size, weight) {
    ctx.font = `${weight} ${size}px ${FONT}`;
  }

  function graphemes(text) {
    return segmenter
      ? Array.from(segmenter.segment(text), (part) => part.segment)
      : Array.from(text);
  }

  function cleanText(value) {
    if (typeof value !== "string") return "";
    const truncated = value.length > MAX_TEXT_LENGTH;
    let text = value.slice(0, MAX_TEXT_LENGTH)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/\s+/gu, " ").trim();
    if (truncated) {
      // Buang grapheme terakhir jika batas input memotong surrogate/ZWJ/combining mark.
      const parts = graphemes(text);
      parts.pop();
      text = `${parts.join("").trimEnd()}…`;
    }
    return text;
  }

  function fittingPrefix(ctx, parts, width, suffix = "") {
    let low = 0, high = parts.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(parts.slice(0, mid).join("") + suffix).width <= width) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  function wrapText(ctx, text, width, maxLines = 2) {
    let remaining = graphemes(text);
    const lines = [];
    for (let line = 0; line < maxLines && remaining.length; line++) {
      const whole = remaining.join("");
      if (ctx.measureText(whole).width <= width) {
        lines.push(whole);
        break;
      }
      if (line === maxLines - 1) {
        const count = fittingPrefix(ctx, remaining, width, "…");
        lines.push(`${remaining.slice(0, count).join("").trimEnd()}…`);
        break;
      }
      let count = fittingPrefix(ctx, remaining, width);
      if (!count) {
        lines.push("…");
        break;
      }
      // Utamakan batas kata; kata panjang/CJK tetap bisa dipenggal per grapheme.
      for (let i = count - 1; i > 0; i--) {
        if (remaining[i] === " ") {
          if (i >= count * 0.45) count = i;
          break;
        }
      }
      lines.push(remaining.slice(0, count).join("").trimEnd());
      remaining = remaining.slice(count);
      while (remaining[0] === " ") remaining.shift();
    }
    return lines;
  }

  // Metadata utuh: kecilkan font, jangan potong koordinat, Plus Code, atau tanggal.
  function fittedText(ctx, text, x, y, width, size, weight, color, align = "left") {
    font(ctx, size, weight);
    const measured = ctx.measureText(text).width;
    if (measured > width) font(ctx, size * width / measured, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y, width);
    return ctx.measureText(text).width;
  }

  function makeLayout(ctx, target, info, s) {
    const textX = PAD + (s.showMap ? MAP_SIZE + MAP_GAP : 0);
    const textWidth = CARD_WIDTH - PAD - PIN_GUTTER - textX;
    const rows = [];
    let textHeight = 0;

    function add(text, size, lineHeight, weight, color, gap = 0, icon = null, wrap = false) {
      if (!text) return;
      const available = textWidth - (icon ? 27 : 0);
      font(ctx, size, weight);
      const lines = wrap ? wrapText(ctx, text, available) : [text];
      if (rows.length) textHeight += gap;
      for (let i = 0; i < lines.length; i++) {
        rows.push({ text: lines[i], y: textHeight, size, lineHeight, weight, color,
          icon: i === 0 ? icon : null, inset: icon ? 27 : 0 });
        textHeight += lineHeight;
      }
    }

    const address = info.address || {};
    const title = s.showAddress
      ? cleanText(s.title) || cleanText(address.title) || "Lokasi foto" : "Lokasi foto";
    const detail = s.showAddress ? cleanText(s.address) || cleanText(address.detail) : "";
    add(title, 26, 30, 700, "ink", 0, null, true);
    add(detail, 17.5, 22, 400, "secondary", 4, null, true);

    let metadataGap = 9;
    if (s.showCoordinates) {
      const lat = window.GeoCore.formatDms(target.lat, "N", "S");
      const lng = window.GeoCore.formatDms(target.lng, "E", "W");
      add(`Lat ${lat}   Long ${lng}`, 18.5, 23, 600, "ink", metadataGap, "accuracy");
      metadataGap = 6;
    }
    const plus = s.showPlusCode ? cleanText(info.plus) : "";
    if (plus) {
      add(`Plus Code  ${plus}`, 17.5, 22, 500, "secondary", metadataGap, "plus");
      metadataGap = 6;
    }
    if (s.showDate && typeof info.date === "string" && info.date.length) {
      // Sudah diformat core: pertahankan string persis, termasuk zona waktu/sumbernya.
      add(info.date, 17.5, 22, 500, "ink", metadataGap, "calendar");
    }
    add(cleanText(s.note), 15.5, 19, 400, "secondary", 8, "note", true);

    const metrics = [];
    if (s.showAltitude && finite(target.alt)) {
      metrics.push({ icon: "altitude", value: `${numberFormat.format(target.alt)} m` });
    }
    if (s.showAccuracy && finite(target.accuracy) && target.accuracy >= 0) {
      metrics.push({ icon: "accuracy", value: `±${numberFormat.format(target.accuracy)} m` });
    }
    // Kecepatan Web Geolocation dalam m/s; tidak ada toggle kecepatan di kontrak.
    if (finite(target.speed) && target.speed >= 0 && finite(target.speed * 3.6)) {
      metrics.push({ icon: "speed", value: `${numberFormat.format(target.speed * 3.6)} km/j` });
    }
    if (s.showWeather && finite(info.temp)) {
      metrics.push({ icon: "weather", value: `Kini ${numberFormat.format(info.temp)}°C` });
    }

    const bodyHeight = Math.max(s.showMap ? MAP_SIZE : 118, textHeight);
    const footerY = PAD + bodyHeight + 13;
    const height = metrics.length ? footerY + 9 + 26 + 15 : PAD * 2 + bodyHeight;
    return { textX, textWidth, textHeight, rows, metrics, bodyHeight, footerY, height };
  }

  function drawMap(ctx, x, y, size, info, palette) {
    ctx.save();
    roundRect(ctx, x, y, size, size, 16);
    ctx.clip();
    ctx.fillStyle = palette.map;
    ctx.fillRect(x, y, size, size);
    let available = info.mapAvailable === true && info.map && info.map.width > 0 && info.map.height > 0;
    if (available) {
      try {
        ctx.drawImage(info.map, x, y, size, size);
      } catch {
        available = false;
      }
    }

    if (available) {
      const cx = x + size / 2, cy = y + size / 2;
      ctx.fillStyle = "rgba(232,63,76,0.16)";
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.fill();
      drawPin(ctx, cx, cy, 39, "#e83f4c", true);

      const attribution = cleanText(info.mapCredit) || "© OpenStreetMap · FOSSGIS";
      font(ctx, 13, 500);
      const badgeWidth = Math.min(size - 12, ctx.measureText(attribution).width + 13);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      roundRect(ctx, x + size - badgeWidth - 6, y + size - 26, badgeWidth, 20, 5);
      ctx.fill();
      fittedText(ctx, attribution, x + size - badgeWidth / 2 - 6, y + size - 16,
        badgeWidth - 10, 13, 500, "#344154", "center");
    } else {
      ctx.fillStyle = palette.map;
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let offset = 22; offset < size; offset += 29) {
        ctx.moveTo(x + offset, y); ctx.lineTo(x + offset, y + size);
        ctx.moveTo(x, y + offset); ctx.lineTo(x + size, y + offset);
      }
      ctx.stroke();
      ctx.fillStyle = palette.map;
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size * 0.4, 30, 0, Math.PI * 2);
      ctx.fill();
      drawIcon(ctx, "unavailable", x + size / 2, y + size * 0.4, 32, palette.muted);
      ctx.fillRect(x + 8, y + size * 0.61, size - 16, 29);
      fittedText(ctx, "Peta tidak tersedia", x + size / 2, y + size * 0.61 + 14,
        size - 24, 15, 500, palette.secondary, "center");
    }
    ctx.restore();
    roundRect(ctx, x, y, size, size, 16);
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function drawMetrics(ctx, layout, palette) {
    if (!layout.metrics.length) return;
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, layout.footerY);
    ctx.lineTo(CARD_WIDTH - PAD, layout.footerY);
    ctx.stroke();
    // Satu baris ringkas: ikon + nilai. Label besar memakan ruang kartu.
    const centerY = layout.footerY + 22;
    let x = PAD + 4;
    for (const metric of layout.metrics) {
      drawIcon(ctx, metric.icon, x + 8, centerY, 16, palette.muted);
      const width = fittedText(ctx, metric.value, x + 20, centerY, 150, 16.5, 600, palette.ink);
      x += 20 + width + 26;
    }
  }

  /** Sinkron; mengembalikan batas kartu dalam piksel gambar, atau null bila nonaktif. */
  function drawStamp(ctx, width, height, target, info, settings) {
    const s = options(settings);
    if (!s.enabled || !target || !finite(target.lat) || !finite(target.lng)
      || !finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
    info = info || {};
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
      ctx.direction = "ltr";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const layout = makeLayout(ctx, target, info, s);
      const palette = palettes[s.theme];
      const margin = Math.min(width, height) * 0.025;
      // Unit layout tidak bergantung resolusi. Batas vertikal mencakup ruang bayangan.
      const scale = Math.min(width * (s.width / 100) / CARD_WIDTH,
        (height - margin * 2) / (layout.height + SHADOW_SPACE * 2));
      const stampWidth = CARD_WIDTH * scale, stampHeight = layout.height * scale;
      const x = (width - stampWidth) / 2;
      const inset = margin + SHADOW_SPACE * scale;
      const y = s.position === "top" ? inset : height - inset - stampHeight;
      ctx.translate(x, y);
      ctx.scale(scale, scale);

      ctx.save();
      // Opasitas hanya untuk permukaan kartu; teks dan peta tetap tajam/terbaca.
      ctx.globalAlpha = s.opacity / 100;
      ctx.fillStyle = palette.card;
      ctx.shadowColor = "rgba(8,18,34,0.24)";
      ctx.shadowBlur = 10 * scale;
      ctx.shadowOffsetY = 3 * scale;
      roundRect(ctx, 0, 0, CARD_WIDTH, layout.height, 22);
      ctx.fill();
      ctx.restore();
      roundRect(ctx, 0, 0, CARD_WIDTH, layout.height, 22);
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.clip();

      if (s.showMap) drawMap(ctx, PAD, PAD + (layout.bodyHeight - MAP_SIZE) / 2, MAP_SIZE, info, palette);
      const textTop = PAD + (layout.bodyHeight - layout.textHeight) / 2;
      for (const row of layout.rows) {
        const centerY = textTop + row.y + row.lineHeight / 2;
        if (row.icon) drawIcon(ctx, row.icon, layout.textX + 8, centerY, 17, palette.muted);
        fittedText(ctx, row.text, layout.textX + row.inset, centerY,
          layout.textWidth - row.inset, row.size, row.weight, palette[row.color]);
      }

      const pinX = CARD_WIDTH - PAD - 30;
      const pinY = PAD + layout.bodyHeight * 0.44;
      ctx.fillStyle = palette.accentSoft;
      ctx.beginPath();
      ctx.arc(pinX, pinY, 30, 0, Math.PI * 2);
      ctx.fill();
      drawPin(ctx, pinX, pinY + 22, 44, palette.accent);
      ctx.fillStyle = palette.badge;
      roundRect(ctx, pinX - 28, pinY + 40, 56, 18, 9);
      ctx.fill();
      fittedText(ctx, "GeoTag", pinX, pinY + 49, 52, 10.5, 700, palette.secondary, "center");
      drawMetrics(ctx, layout, palette);
      return { x, y, width: stampWidth, height: stampHeight };
    } finally {
      ctx.restore();
    }
  }

  /**
   * @param {Blob} file
   * @param {{lat:number,lng:number,alt?:number,accuracy?:number,speed?:number}|null} target
   * @returns {Promise<{blob:Blob,width:number,height:number,resized:boolean}>}
   */
  async function render(file, target, info, settings, limits = {}) {
    const s = options(settings);
    const core = window.GeoCore;
    if (!core || typeof core.decodeImage !== "function" || typeof core.fitDimensions !== "function") {
      throw new Error("GeoCore belum siap untuk merender foto.");
    }
    let decoded = null, canvas = null;
    try {
      decoded = await core.decodeImage(file);
      const maxEdge = positiveLimit(limits && limits.maxEdge, s.maxEdge);
      const maxPixels = positiveLimit(limits && limits.maxPixels, 12000000);
      const fitted = core.fitDimensions(decoded.width, decoded.height, maxEdge, maxPixels);
      const width = fitted.width, height = fitted.height;
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvas 2D tidak tersedia untuk merender foto.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // decodeImage sudah menerapkan orientasi; jangan rotasi atau membaca EXIF lagi.
      ctx.drawImage(decoded.image, 0, 0, width, height);
      if (s.enabled && target) drawStamp(ctx, width, height, target, info, s);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("Gagal membuat JPEG: Canvas mengembalikan blob kosong."));
        }, "image/jpeg", s.quality);
      });
      return { blob, width, height, resized: Boolean(fitted.resized) };
    } finally {
      try {
        if (decoded && typeof decoded.close === "function") decoded.close();
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }
  }

  return { render, drawStamp };
})();
