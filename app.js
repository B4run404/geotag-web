/* global L, GeoCore, GeoStamp, GeoServices */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  if (!window.GeoCore || !window.GeoStamp || !window.GeoServices) {
    $("fatalError").textContent = "Komponen aplikasi belum lengkap. Muat ulang, atau pastikan seluruh folder vendor ikut diunggah.";
    $("fatalError").hidden = false;
    return;
  }
  const C = GeoCore;
  const defaults = {
    enabled: true, theme: "light", position: "bottom", width: 94, opacity: 96,
    showMap: true, showCoordinates: true, showAddress: true, showPlusCode: true,
    showDate: true, showWeather: false, showAltitude: true, showAccuracy: true,
    mapZoom: 16, timeMode: "photo", quality: 0.94, maxEdge: 3072
  };
  const fields = {
    enabled: "stampToggle", position: "stampPos", width: "stampWidth", opacity: "stampOpacity",
    showMap: "showMap", showCoordinates: "showCoordinates", showAddress: "showAddress",
    showPlusCode: "showPlusCode", showDate: "showDate", showWeather: "showWeather",
    showAltitude: "showAltitude", showAccuracy: "showAccuracy", mapZoom: "mapZoom",
    timeMode: "timeMode", quality: "jpegQuality", maxEdge: "maxEdge"
  };
  const state = {
    files: [], selectedId: null, target: null, knownAddress: null, busy: false,
    operation: null, view: "stamp", sessionTime: new Date(), nextId: 1,
    locationToken: 0, locating: false, searchToken: 0, searchController: null,
    previewSequence: 0, previewController: null, previewUrl: null,
    common: null, registration: null, updating: false
  };
  let previewTimer, toastTimer, previewChain = Promise.resolve(), deferredInstall;
  let map, mapTiles, marker, accuracyCircle;

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $("toastText").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 11000 : 7000);
  }

  function settings() {
    const result = {};
    for (const [key, id] of Object.entries(fields)) {
      const input = $(id);
      result[key] = input.type === "checkbox" ? input.checked : typeof defaults[key] === "number" ? Number(input.value) : input.value;
    }
    result.theme = document.querySelector('input[name="stampTheme"]:checked').value;
    result.title = $("customTitle").value.trim();
    result.address = $("customAddress").value.trim();
    result.note = $("customNote").value.trim();
    result.customDate = $("customDate").value;
    return result;
  }

  function applyPreferences(values) {
    for (const [key, id] of Object.entries(fields)) {
      let value = values[key] ?? defaults[key];
      const input = $(id);
      if (input.type === "checkbox") input.checked = typeof value === "boolean" ? value : defaults[key];
      else {
        input.value = value;
        if (!input.value || (input.type === "range" && (!Number.isFinite(Number(value)) || Number(value) < Number(input.min) || Number(value) > Number(input.max)))) input.value = defaults[key];
      }
    }
    const theme = ["light", "dark"].includes(values.theme) ? values.theme : defaults.theme;
    document.querySelector(`input[name="stampTheme"][value="${theme}"]`).checked = true;
    // Teks personal, koordinat, foto, dan tanggal manual tidak disimpan permanen.
    if ($("timeMode").value === "custom" && !$("customDate").value) $("timeMode").value = "photo";
  }

  function savePreferences() {
    const values = settings();
    const saved = Object.fromEntries(Object.keys(defaults).map((key) => [key, values[key]]));
    try { localStorage.setItem("geotag:display:v3", JSON.stringify(saved)); } catch { /* Mode privat/penuh tetap dapat mengedit. */ }
  }

  function selected() { return state.files.find((item) => item.id === state.selectedId) || null; }
  function readyFiles() { return state.files.filter((item) => !item.error && !item.loading); }
  function results() { return state.files.filter((item) => item.result).map((item) => item.result); }
  function signature() { return JSON.stringify({ target: state.target, settings: settings(), address: state.knownAddress }); }

  function updateControls() {
    const list = readyFiles(), item = selected(), exported = results();
    const busy = state.busy;
    $("btnApply").disabled = busy || !list.length || !C.validTarget(state.target);
    $("btnApply").querySelector("span").textContent = busy ? "Memproses…" : list.length > 1 ? `Buat ${list.length} foto` : "Buat foto";
    $("btnStrip").disabled = busy || !list.length;
    $("btnZip").disabled = busy || !exported.length;
    $("btnShareAll").disabled = busy || !exported.length;
    $("btnShareAll").hidden = !(navigator.share && navigator.canShare && exported.length > 1);
    $("btnPhotoLoc").disabled = busy || !(item && item.gps);
    $("btnMapCenter").disabled = busy || !state.target;
    $("btnMapRetry").disabled = busy;
    $("btnMyLoc").disabled = busy || state.locating;
    $("btnSearch").disabled = busy || !!state.searchController;
    for (const id of ["btnAddFiles", "btnCamera", "btnClear", "fileInput", "cameraInput", "stampToggle", "searchBox", "latInput", "lngInput", "btnSetManual", "btnResetSettings", "maxEdge", "jpegQuality"]) $(id).disabled = busy;
    for (const button of $("fileList").querySelectorAll("button")) button.disabled = busy;
    $("stampOptions").disabled = busy || !$("stampToggle").checked;
    $("btnViewOriginal").disabled = busy || !item || !!item.error;
    $("btnViewStamp").disabled = busy || !item || !!item.error;
    $("btnExpand").disabled = busy || $("previewImage").hidden;
    $("btnShare").disabled = busy || !(item && item.result);
    $("btnDownload").disabled = busy || !(item && item.result);
    $("btnUpdate").disabled = busy;
    if (marker && marker.dragging) busy ? marker.dragging.disable() : marker.dragging.enable();
    $("widthValue").value = `${$("stampWidth").value}%`;
    $("opacityValue").value = `${$("stampOpacity").value}%`;
    $("customDateField").hidden = $("timeMode").value !== "custom";
    $("stampModeHint").textContent = $("stampToggle").checked ? "Stempel terlihat di gambar. GPS juga disimpan di metadata." : "Hanya GPS EXIF. Piksel JPEG asli tidak diubah.";
    $("btnClear").hidden = !state.files.length;
    $("dropZone").closest("section").classList.toggle("has-files", !!state.files.length);
    $("batchCount").textContent = list.length ? `${list.length} foto dipilih` : "Belum ada foto";
    $("batchHint").textContent = exported.length ? `${exported.length} hasil siap disimpan` : !list.length ? "Mulai dengan memilih foto" : state.target ? "Lokasi siap · buat foto untuk ekspor" : "Pilih lokasi terlebih dahulu";
    updateResultPanel();
  }

  function updateResultPanel() {
    const item = selected();
    $("resultPanel").hidden = !(item && item.result);
    if (!item || !item.result) return;
    const result = item.result;
    $("resultInfo").textContent = `${result.width} × ${result.height} px · ${C.formatBytes(result.blob.size)} · ${result.mode === "strip" ? "GPS EXIF dihapus" : "JPEG + GPS"}`;
    $("resultStale").hidden = result.signature === signature();
  }

  function renderFiles() {
    const fragment = document.createDocumentFragment();
    for (const item of state.files) {
      const card = document.createElement("div");
      card.className = "file-card" + (item.id === state.selectedId ? " is-selected" : "");
      card.dataset.id = String(item.id);
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "select-file";
      choose.setAttribute("aria-pressed", String(item.id === state.selectedId));
      choose.setAttribute("aria-label", `Lihat ${item.file.name}`);
      if (item.originalUrl) {
        const image = document.createElement("img");
        image.className = "file-thumb"; image.src = item.originalUrl; image.alt = "";
        choose.append(image);
      }
      const meta = document.createElement("span");
      meta.className = "file-meta";
      const name = document.createElement("span"); name.className = "file-name"; name.textContent = item.file.name;
      const sub = document.createElement("span"); sub.className = "file-sub";
      sub.textContent = `${C.formatBytes(item.file.size)}${item.width ? ` · ${item.width} × ${item.height}` : ""}${item.gps ? " · GPS asli" : ""}`;
      const status = document.createElement("span"); status.className = "file-status";
      status.textContent = item.error || item.processingError || (item.loading ? "Membaca foto…" : item.result ? "✓ Hasil siap" : "Siap diedit");
      status.classList.toggle("error", !!(item.error || item.processingError));
      meta.append(name, sub, status); choose.append(meta);
      choose.addEventListener("click", () => { if (state.busy) return; state.selectedId = item.id; state.view = "stamp"; renderFiles(); updateControls(); schedulePreview(0); });
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "icon-button file-remove";
      remove.setAttribute("aria-label", `Hapus ${item.file.name} dari daftar`);
      remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-x"/></svg>';
      remove.addEventListener("click", () => removeFile(item));
      choose.disabled = remove.disabled = state.busy;
      card.append(choose, remove); fragment.append(card);
    }
    $("fileList").replaceChildren(fragment);
  }

  function releaseItem(item) {
    if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
    if (item.result) URL.revokeObjectURL(item.result.url);
  }

  function removeFile(item) {
    if (state.busy) return;
    cancelPreview();
    releaseItem(item);
    state.files = state.files.filter((file) => file !== item);
    if (state.selectedId === item.id) state.selectedId = state.files[0]?.id || null;
    renderFiles(); updateControls(); schedulePreview(0);
  }

  function beginOperation(kind, label) {
    cancelPreview();
    state.searchToken++;
    if (state.searchController) state.searchController.abort();
    state.searchController = null;
    state.locationToken++; state.locating = false;
    state.busy = true;
    state.operation = { kind, controller: new AbortController() };
    $("operationProgress").hidden = false;
    $("btnCancel").disabled = kind === "zip";
    progress(0, label);
    updateControls();
    return state.operation.controller.signal;
  }

  function endOperation() {
    state.busy = false; state.operation = null;
    $("operationProgress").hidden = true;
    renderFiles(); updateControls(); schedulePreview(0);
  }

  function progress(value, label) {
    $("progressBar").value = value;
    $("progressLabel").textContent = label;
  }

  function checkAbort(signal) {
    if (signal.aborted) throw new DOMException("Proses dibatalkan.", "AbortError");
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Memori gambar tidak cukup. Coba foto yang lebih kecil.")), "image/jpeg", quality));
  }

  async function importFiles(fileList, source = "gallery") {
    if (state.busy || !fileList.length) return;
    const signal = beginOperation("import", "Membaca foto…");
    let added = 0, skipped = 0;
    try {
      await previewChain.catch(() => {});
      for (const file of fileList) {
        checkAbort(signal);
        const duplicate = state.files.find((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
        if (duplicate && !duplicate.error) { skipped++; continue; }
        if (duplicate) { releaseItem(duplicate); state.files = state.files.filter((item) => item !== duplicate); }
        if (state.files.length >= C.MAX_FILES || state.files.reduce((sum, item) => sum + item.file.size, 0) + file.size > C.MAX_BATCH_BYTES) {
          toast("Batas batch 20 foto atau 150 MB. Simpan hasil dan kosongkan daftar untuk melanjutkan.", true); break;
        }
        const item = { id: duplicate?.id || state.nextId++, file, loading: true, error: null, result: null };
        state.files.push(item);
        if (!state.selectedId) state.selectedId = item.id;
        renderFiles();
        let decoded, canvas;
        try {
          Object.assign(item, await C.readMetadata(file));
          checkAbort(signal);
          decoded = await C.decodeImage(file);
          item.width = decoded.width; item.height = decoded.height;
          const size = C.fitDimensions(decoded.width, decoded.height, 1200, 1600000);
          canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
          const context = canvas.getContext("2d");
          context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
          const blob = await canvasBlob(canvas, 0.88);
          checkAbort(signal);
          item.originalUrl = URL.createObjectURL(blob);
          added++;
        } catch (error) {
          item.error = error.name === "AbortError" ? "Pembacaan dibatalkan; pilih ulang untuk mencoba lagi." : error.message;
          if (error.name === "AbortError") throw error;
        } finally {
          item.loading = false;
          if (decoded) decoded.close();
          if (canvas) { canvas.width = 0; canvas.height = 0; }
          progress(Math.round(((fileList.indexOf(file) + 1) / fileList.length) * 100), `${fileList.indexOf(file) + 1}/${fileList.length} foto dibaca`);
          renderFiles();
        }
      }
      const firstGps = readyFiles().find((item) => item.gps);
      if (!state.target && firstGps) setTarget(firstGps.gps.lat, firstGps.gps.lng, { ...firstGps.gps, internal: true });
      if (selected()?.error) state.selectedId = readyFiles()[0]?.id || state.selectedId;
      if (added) toast(`${added} foto ditambahkan.${skipped ? ` ${skipped} duplikat dilewati.` : ""}`);
      else if (skipped) toast("Foto tersebut sudah ada di daftar.");
    } catch (error) {
      if (error.name !== "AbortError") toast(error.message, true);
      else toast("Pembacaan dihentikan. Foto yang sudah dibaca tetap tersedia.");
    } finally {
      endOperation();
      // "Foto langsung": foto barusan diambil, jadi GPS perangkat adalah
      // lokasi yang paling mungkin benar. Ambil otomatis bila belum ada target.
      if (source === "camera" && !state.target) locate();
      // Di layar HP pratinjau berada di bawah daftar foto; antar pengguna ke sana.
      const panel = $("previewPanel");
      if (added && panel && window.matchMedia("(max-width: 760px)").matches) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function initMap() {
    if (!window.L) { $("map").textContent = "Peta belum dimuat. Gunakan koordinat manual."; return; }
    map = L.map("map", { scrollWheelZoom: false, worldCopyJump: true, zoomControl: false }).setView([-2.5, 118], 4);
    map.attributionControl.setPrefix(false);
    L.control.zoom({ position: "bottomright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 90 }).addTo(map);

    // <img src=URL> dapat menampilkan body PNG dari respons 403. Ambil dengan
    // fetch dahulu agar gambar penolakan tidak pernah dipasang sebagai tile.
    const CheckedTiles = L.TileLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("img");
        tile.alt = ""; tile.setAttribute("role", "presentation");
        const controller = new AbortController();
        tile.cancelRequest = () => {
          controller.abort(); tile.onload = tile.onerror = null;
          if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl);
        };
        const fail = (error) => {
          if (controller.signal.aborted) return;
          tile.onload = tile.onerror = null;
          tile.removeAttribute("src");
          tile.classList.add("map-tile-unavailable");
          if (tile.objectUrl) { URL.revokeObjectURL(tile.objectUrl); tile.objectUrl = null; }
          done(error, tile);
        };
        GeoServices.tileBlob(coords.z, coords.x, coords.y, controller.signal).then((blob) => {
          if (controller.signal.aborted) return;
          tile.objectUrl = URL.createObjectURL(blob);
          tile.onload = () => {
            tile.onload = tile.onerror = null;
            done(null, tile);
            URL.revokeObjectURL(tile.objectUrl); tile.objectUrl = null;
          };
          tile.onerror = () => fail(new Error("Tile peta tidak dapat dibaca."));
          tile.src = tile.objectUrl;
        }).catch(fail);
        return tile;
      }
    });
    mapTiles = new CheckedTiles(GeoServices.mapStyle.template, {
      maxZoom: GeoServices.mapStyle.maxZoom, maxNativeZoom: GeoServices.mapStyle.maxNativeZoom,
      minZoom: 2, keepBuffer: 1, updateWhenIdle: true, attribution: GeoServices.mapStyle.attribution
    });
    mapTiles.on("tileunload", (event) => event.tile.cancelRequest?.());
    mapTiles.on("tileerror", () => { $("mapNotice").hidden = false; });
    mapTiles.on("loading", () => { $("mapNotice").hidden = true; });
    mapTiles.on("load", () => { $("mapNotice").hidden = !mapTiles.getContainer()?.querySelector(".map-tile-unavailable"); });
    mapTiles.addTo(map);
    marker = L.marker([0, 0], { draggable: true, title: "Geser untuk menentukan lokasi", icon: L.divIcon({
      className: "map-pin",
      html: '<svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M15 38C12 33 2 23 2 15a13 13 0 1 1 26 0c0 8-10 18-13 23Z" fill="#ed4658" stroke="white" stroke-width="2.5"/><circle cx="15" cy="15" r="5" fill="white"/></svg>',
      iconSize: [30, 40], iconAnchor: [15, 38]
    }) });
    const pick = (point) => {
      if (state.busy) return;
      const lng = ((point.lng + 180) % 360 + 360) % 360 - 180;
      setTarget(C.clamp(point.lat, -90, 90), lng, { source: "map", pan: false });
    };
    map.on("click", (event) => pick(event.latlng));
    marker.on("dragend", () => pick(marker.getLatLng()));
  }

  function retryMap() {
    if (!mapTiles || state.busy) return;
    $("mapNotice").hidden = true;
    mapTiles.redraw();
    state.common = null;
    schedulePreview(250);
  }

  function setTarget(lat, lng, options = {}) {
    if ((state.busy && !options.internal) || !C.validTarget({ lat, lng })) return;
    state.locationToken++; state.locating = false;
    state.searchToken++;
    if (state.searchController) state.searchController.abort();
    state.searchController = null;
    state.target = {
      lat: C.round6(lat), lng: C.round6(lng), alt: C.finite(options.alt) ? options.alt : null,
      speed: C.finite(options.speed) ? options.speed : null, accuracy: C.finite(options.accuracy) ? options.accuracy : null,
      timestamp: C.finite(options.timestamp) ? options.timestamp : null, source: options.source || "manual"
    };
    state.knownAddress = options.address || null;
    state.common = null;
    state.view = "stamp";
    $("latInput").value = state.target.lat.toFixed(6);
    $("lngInput").value = state.target.lng.toFixed(6);
    $("coordLabel").textContent = `${C.formatCoord(state.target.lat, state.target.lng)}${C.finite(state.target.accuracy) ? ` · akurasi ±${Math.round(state.target.accuracy)} m` : ""}`;
    const labels = { device: "GPS PERANGKAT", photo: "GPS FOTO", search: "PENCARIAN", map: "TITIK PETA", manual: "MANUAL" };
    $("locationSource").textContent = labels[state.target.source] || "LOKASI TERPILIH";
    $("searchResults").hidden = true;
    if (map) {
      marker.setLatLng([lat, lng]).addTo(map);
      if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
      if (C.finite(state.target.accuracy) && state.target.source === "device") accuracyCircle = L.circle([lat, lng], { radius: state.target.accuracy, color: "#188d7d", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      if (options.pan !== false) map.setView([lat, lng], 16);
    }
    updateControls(); schedulePreview(350);
  }

  function locate() {
    if (state.busy || state.locating) return;
    if (!window.isSecureContext) { toast("Lokasi perangkat memerlukan HTTPS. Input manual tetap dapat dipakai.", true); return; }
    if (!navigator.geolocation) { toast("Browser ini tidak mendukung lokasi perangkat.", true); return; }
    const token = ++state.locationToken;
    state.locating = true; updateControls();
    $("coordLabel").textContent = "Mencari posisi GPS…";
    navigator.geolocation.getCurrentPosition((position) => {
      if (token !== state.locationToken || state.busy) return;
      setTarget(position.coords.latitude, position.coords.longitude, { alt: position.coords.altitude, speed: position.coords.speed, accuracy: position.coords.accuracy, timestamp: position.timestamp, source: "device" });
    }, (error) => {
      if (token !== state.locationToken) return;
      state.locating = false;
      const messages = { 1: "Izin lokasi ditolak. Aktifkan izin lokasi untuk Safari atau isi koordinat manual.", 2: "GPS belum tersedia. Coba dekat jendela atau isi koordinat manual.", 3: "GPS belum merespons. Coba lagi." };
      $("coordLabel").textContent = messages[error.code] || "Gagal mengambil lokasi.";
      updateControls();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  }

  async function searchPlace(event) {
    event.preventDefault();
    if (state.busy) return;
    const text = $("searchBox").value.trim();
    if (!text) return;
    if (state.searchController) state.searchController.abort();
    const controller = new AbortController(), token = ++state.searchToken;
    state.searchController = controller;
    updateControls();
    $("coordLabel").textContent = "Mencari tempat…";
    $("searchResults").hidden = true;
    try {
      const matches = await GeoServices.search(text, controller.signal);
      if (state.busy || token !== state.searchToken) return;
      const fragment = document.createDocumentFragment();
      for (const result of matches) {
        const button = document.createElement("button");
        button.className = "search-result"; button.type = "button"; button.textContent = result.label;
        button.addEventListener("click", () => setTarget(result.lat, result.lng, { source: "search", address: result.address }));
        fragment.append(button);
      }
      $("searchResults").replaceChildren(fragment);
      $("searchResults").hidden = !matches.length;
      $("coordLabel").textContent = matches.length ? "Pilih salah satu hasil pencarian." : "Tempat tidak ditemukan. Coba nama yang lebih spesifik.";
    } catch (error) {
      if (error.name !== "AbortError" && token === state.searchToken) $("coordLabel").textContent = "Pencarian gagal. Periksa internet atau gunakan koordinat manual.";
    } finally {
      if (token === state.searchToken) { state.searchController = null; updateControls(); }
    }
  }

  function cancelPreview() {
    clearTimeout(previewTimer);
    state.previewSequence++;
    if (state.previewController) state.previewController.abort();
    state.previewController = null;
    $("previewLoader").hidden = true;
    $("previewStage").setAttribute("aria-busy", "false");
  }

  function releasePreview() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }

  function showImage(url, badge, item, dimensions) {
    $("previewImage").src = url;
    $("previewImage").hidden = false;
    $("emptyPreview").hidden = true;
    $("previewStage").classList.add("has-photo");
    $("previewBadge").hidden = false; $("previewBadge").textContent = badge;
    $("previewFilename").textContent = item.file.name;
    $("previewDimensions").textContent = `${dimensions?.width || item.width} × ${dimensions?.height || item.height} px`;
    $("btnExpand").disabled = state.busy;
  }

  function schedulePreview(delay = 250) {
    cancelPreview();
    if (state.busy) return;
    const sequence = state.previewSequence;
    previewTimer = setTimeout(() => {
      previewChain = previewChain.catch(() => {}).then(() => renderPreview(sequence));
    }, delay);
  }

  async function commonInfo(target, prefs, signal) {
    const key = JSON.stringify({ target, showMap: prefs.showMap, showWeather: prefs.showWeather, showAddress: prefs.showAddress, title: prefs.title, address: prefs.address, zoom: prefs.mapZoom, known: state.knownAddress });
    if (state.common && state.common.key === key && Date.now() - state.common.time < (state.common.info.warnings.length ? 2000 : 60000)) return state.common.info;
    const info = await GeoServices.collect(target, prefs, { signal, knownAddress: state.knownAddress });
    checkAbort(signal);
    state.common = { key, time: Date.now(), info };
    return info;
  }

  function infoForPhoto(item, prefs, info) {
    const time = C.photoTime(item.exif, prefs.showDate ? prefs.timeMode : "photo", prefs.customDate, state.sessionTime);
    return { ...info, date: time.text, timeSource: time.source };
  }

  async function renderPreview(sequence) {
    if (sequence !== state.previewSequence || state.busy) return;
    const item = selected(), prefs = settings();
    $("btnViewOriginal").setAttribute("aria-pressed", String(state.view === "original"));
    $("btnViewStamp").setAttribute("aria-pressed", String(state.view !== "original"));
    $("infoWarning").hidden = true;
    if (!item || item.error || !item.originalUrl) {
      $("previewImage").hidden = true; $("previewImage").removeAttribute("src");
      $("emptyPreview").hidden = false; $("previewBadge").hidden = true;
      $("previewStage").classList.remove("has-photo");
      $("previewFilename").textContent = item ? item.file.name : "Belum ada foto dipilih";
      $("previewDimensions").textContent = "JPEG OUTPUT";
      $("previewHint").textContent = item?.error || "Hasil diproses di perangkat, bukan diunggah ke server.";
      releasePreview(); updateControls(); return;
    }
    if (state.view === "original") {
      showImage(item.originalUrl, "ASLI", item);
      $("previewHint").textContent = item.warning || "Foto sumber. File asli tidak diubah.";
      releasePreview(); return;
    }
    if (item.result && item.result.signature === signature()) {
      showImage(item.result.url, "HASIL", item, item.result);
      $("previewHint").textContent = item.result.mode === "strip" ? "GPS EXIF dihapus dari salinan foto asli." : "Pratinjau file hasil yang siap diunduh.";
      $("infoWarning").textContent = item.result.warnings.join(" ");
      $("infoWarning").hidden = !item.result.warnings.length;
      releasePreview(); return;
    }
    showImage(item.originalUrl, prefs.enabled ? "DRAF" : "EXIF SAJA", item);
    releasePreview();
    if (!state.target || !prefs.enabled) {
      $("previewHint").textContent = !state.target ? "Pilih lokasi untuk melihat stempel pada foto ini." : item.type === "image/jpeg" ? "Tidak ada stempel visual; koordinat ditulis ke metadata GPS saat ekspor." : "Foto akan dikonversi ke JPEG dengan kualitas pilihanmu, tanpa stempel visual.";
      return;
    }
    const controller = new AbortController(); state.previewController = controller;
    $("previewLoader").hidden = false; $("previewStage").setAttribute("aria-busy", "true");
    try {
      if (prefs.showDate) C.photoTime(item.exif, prefs.timeMode, prefs.customDate, state.sessionTime);
      const info = infoForPhoto(item, prefs, await commonInfo({ ...state.target }, prefs, controller.signal));
      checkAbort(controller.signal);
      const rendered = await GeoStamp.render(item.file, { ...state.target }, info, prefs, { maxEdge: 1200, maxPixels: 1600000 });
      checkAbort(controller.signal);
      if (sequence !== state.previewSequence || state.busy) return;
      state.previewUrl = URL.createObjectURL(rendered.blob);
      showImage(state.previewUrl, "DRAF", item, C.fitDimensions(item.width, item.height, prefs.maxEdge));
      $("previewHint").textContent = `${prefs.showDate ? info.timeSource + " · " : ""}Pratinjau diperkecil; ekspor mengikuti kualitas pilihanmu.`;
      const warnings = [item.warning, ...info.warnings].filter(Boolean);
      $("infoWarning").textContent = warnings.join(" "); $("infoWarning").hidden = !warnings.length;
    } catch (error) {
      if (error.name !== "AbortError" && sequence === state.previewSequence) {
        $("infoWarning").textContent = error.message; $("infoWarning").hidden = false;
        $("previewHint").textContent = "Pratinjau belum selesai; foto asli ditampilkan.";
      }
    } finally {
      if (sequence === state.previewSequence) { $("previewLoader").hidden = true; $("previewStage").setAttribute("aria-busy", "false"); state.previewController = null; }
    }
  }

  async function processAll(mode) {
    if (state.busy || !readyFiles().length) return;
    const prefs = settings(), target = state.target ? { ...state.target } : null;
    if (mode !== "strip" && !C.validTarget(target)) { toast("Pilih lokasi terlebih dahulu.", true); return; }
    const files = [...readyFiles()], resultSignature = signature();
    const wantStamp = mode !== "strip" && prefs.enabled;
    if (wantStamp && prefs.showDate && prefs.timeMode === "custom") {
      try { C.photoTime({}, "custom", prefs.customDate); } catch (error) { toast(error.message, true); return; }
    }
    const signal = beginOperation("process", wantStamp ? "Menyiapkan data lokasi…" : "Menyiapkan foto…");
    let completed = 0, failed = 0;
    try {
      await previewChain.catch(() => {});
      checkAbort(signal);
      const info = wantStamp ? await commonInfo(target, prefs, signal) : null;
      for (let i = 0; i < files.length; i++) {
        checkAbort(signal);
        const item = files[i];
        progress(Math.round(i / files.length * 100), `${mode === "strip" ? "Menghapus GPS" : "Membuat foto"} ${i + 1}/${files.length}…`);
        try {
          let base = item.file, dimensions = null;
          if (wantStamp || item.type !== "image/jpeg") {
            const rendered = await GeoStamp.render(item.file, target, wantStamp ? infoForPhoto(item, prefs, info) : {}, { ...prefs, enabled: wantStamp });
            checkAbort(signal);
            base = rendered.blob;
            dimensions = { width: rendered.width, height: rendered.height };
          }
          const exif = C.buildExif(item.exif, target, { mode, dimensions });
          const blob = await C.replaceExif(base, exif);
          checkAbort(signal);
          const previous = item.result;
          item.result = {
            blob, url: URL.createObjectURL(blob), name: C.outputName(item.file.name, mode === "strip" ? "_nogps" : "_geotag"),
            width: dimensions?.width || item.width, height: dimensions?.height || item.height,
            target, mode, signature: resultSignature,
            warnings: [item.warning, ...(info?.warnings || [])].filter(Boolean)
          };
          item.processingError = null;
          if (previous) URL.revokeObjectURL(previous.url);
          completed++;
        } catch (error) {
          if (error.name === "AbortError") throw error;
          item.processingError = error.message; failed++;
        }
        renderFiles();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      progress(100, "Selesai");
      if (info && info.warnings.length) { $("infoWarning").textContent = info.warnings.join(" "); $("infoWarning").hidden = false; }
      toast(`${completed} foto siap disimpan.${failed ? ` ${failed} foto gagal; lihat pesan di daftar.` : ""}`, !!failed);
      if (completed && !selected()?.result) state.selectedId = state.files.find((item) => item.result)?.id;
      state.view = "stamp";
    } catch (error) {
      toast(error.name === "AbortError" ? `Proses dibatalkan. ${completed} hasil yang selesai tetap tersedia.` : error.message, error.name !== "AbortError");
    } finally {
      endOperation();
      // Hasil muncul di panel pratinjau; gulir ke sana di layar HP.
      const panel = $("previewPanel");
      if (completed && panel && window.matchMedia("(max-width: 760px)").matches) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function downloadUrl(url, name) {
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
  }

  function downloadSelected() {
    const result = selected()?.result;
    if (result) downloadUrl(result.url, result.name);
  }

  async function shareResults(batch = false) {
    const list = batch ? results() : [selected()?.result].filter(Boolean);
    if (!list.length || state.busy) return;
    const files = list.map((result) => new File([result.blob], result.name, { type: "image/jpeg" }));
    if (navigator.share && navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files }); }
      catch (error) { if (error.name !== "AbortError") toast("Bagikan belum berhasil. Gunakan tombol Unduh JPEG atau Semua (ZIP).", true); }
    } else if (batch) await downloadZip();
    else { downloadSelected(); toast("Hasil diunduh. Buka folder Unduhan untuk menyimpannya ke Foto."); }
  }

  async function downloadZip() {
    if (state.busy || !results().length) return;
    const list = results();
    beginOperation("zip", "Menyiapkan ZIP…");
    try {
      await previewChain.catch(() => {});
      const blob = await C.makeZip(list);
      const url = URL.createObjectURL(blob);
      downloadUrl(url, `GeoTag_${state.sessionTime.toISOString().slice(0, 10)}.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`${list.length} hasil dimasukkan ke ZIP.`);
    } catch (error) { toast(`ZIP gagal dibuat: ${error.message}`, true); }
    finally { endOperation(); }
  }

  function onSettingsChange() {
    if (state.busy) return;
    savePreferences(); state.view = "stamp";
    updateControls(); schedulePreview();
  }

  function updateConnection() {
    const offline = !navigator.onLine;
    $("connectionStatus").classList.toggle("is-offline", offline);
    $("connectionStatus").lastElementChild.textContent = offline ? "Offline" : "Online";
    state.common = null;
    if (!offline) schedulePreview(500);
  }

  async function installApp() {
    if (deferredInstall) {
      try { await deferredInstall.prompt(); await deferredInstall.userChoice; }
      finally { deferredInstall = null; }
    } else $("installDialog").showModal();
  }

  async function setupServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) { $("offlineState").textContent = "HTTPS diperlukan untuk mode offline"; return; }
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (state.updating) location.reload();
    });
    let readyTimer;
    try {
      const registration = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
      state.registration = registration;
      const showUpdate = () => { if (registration.waiting) $("updateNotice").hidden = false; };
      showUpdate();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (worker) worker.addEventListener("statechange", () => {
          if (worker.state === "redundant" && !registration.active) $("offlineState").textContent = "Aset offline belum lengkap; periksa koneksi lalu muat ulang";
          if (worker.state === "installed") {
            if (navigator.serviceWorker.controller) showUpdate();
            else $("offlineState").textContent = "Editor siap digunakan offline";
          }
        });
      });
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve, reject) => { readyTimer = setTimeout(() => reject(new Error("Offline setup timeout")), 20000); })
      ]);
      if (ready.active) $("offlineState").textContent = "Editor siap digunakan offline";
    } catch { $("offlineState").textContent = "Mode offline belum siap; periksa koneksi lalu muat ulang"; }
    finally { clearTimeout(readyTimer); }
  }

  $("btnAddFiles").addEventListener("click", () => $("fileInput").click());
  $("btnCamera").addEventListener("click", () => $("cameraInput").click());
  for (const [id, source] of [["fileInput", "gallery"], ["cameraInput", "camera"]]) $(id).addEventListener("change", () => {
    const files = Array.from($(id).files || []); $(id).value = "";
    if (files.length) void importFiles(files, source);
  });
  $("dropZone").addEventListener("dragover", (event) => { event.preventDefault(); if (!state.busy) $("dropZone").classList.add("is-dragging"); });
  $("dropZone").addEventListener("dragleave", (event) => { if (!$("dropZone").contains(event.relatedTarget)) $("dropZone").classList.remove("is-dragging"); });
  $("dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("dropZone").classList.remove("is-dragging"); if (!state.busy) void importFiles(Array.from(event.dataTransfer.files), "gallery"); });
  window.addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); });
  window.addEventListener("drop", (event) => event.preventDefault());
  $("btnClear").addEventListener("click", () => {
    if (state.busy) return;
    cancelPreview(); state.files.forEach(releaseItem); state.files = []; state.selectedId = null;
    renderFiles(); updateControls(); schedulePreview(0);
  });
  $("btnMyLoc").addEventListener("click", locate);
  $("btnMapCenter").addEventListener("click", () => { if (map && state.target && !state.busy) map.setView([state.target.lat, state.target.lng], 16); });
  $("btnMapRetry").addEventListener("click", retryMap);
  $("btnPhotoLoc").addEventListener("click", () => { const gps = selected()?.gps; if (gps) setTarget(gps.lat, gps.lng, gps); });
  $("searchForm").addEventListener("submit", (event) => void searchPlace(event));
  $("searchBox").addEventListener("input", () => {
    state.searchToken++;
    if (state.searchController) state.searchController.abort();
    state.searchController = null;
    $("searchResults").hidden = true;
    $("coordLabel").textContent = state.target ? C.formatCoord(state.target.lat, state.target.lng) : "Pilih titik yang akan ditulis ke semua foto.";
    updateControls();
  });
  $("coordinateForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const lat = C.parseCoordinate($("latInput").value, -90, 90), lng = C.parseCoordinate($("lngInput").value, -180, 180);
    if (lat === null || lng === null) { $("coordLabel").textContent = "Koordinat tidak valid. Latitude −90…90, longitude −180…180."; return; }
    setTarget(lat, lng);
  });
  for (const element of document.querySelectorAll(".settings-card input, .settings-card select, .settings-card textarea")) element.addEventListener("input", onSettingsChange);
  $("btnResetSettings").addEventListener("click", () => {
    applyPreferences(defaults);
    for (const id of ["customTitle", "customAddress", "customNote", "customDate"]) $(id).value = "";
    onSettingsChange(); toast("Tampilan stempel dikembalikan ke pengaturan awal.");
  });
  $("btnApply").addEventListener("click", () => void processAll("write"));
  $("btnStrip").addEventListener("click", () => void processAll("strip"));
  $("btnCancel").addEventListener("click", () => {
    if (state.operation) state.operation.controller.abort();
    $("btnCancel").disabled = true; $("progressLabel").textContent = "Menghentikan proses…";
  });
  $("btnViewOriginal").addEventListener("click", () => { state.view = "original"; schedulePreview(0); });
  $("btnViewStamp").addEventListener("click", () => { state.view = "stamp"; schedulePreview(0); });
  $("btnDownload").addEventListener("click", downloadSelected);
  $("btnShare").addEventListener("click", () => void shareResults());
  $("btnShareAll").addEventListener("click", () => void shareResults(true));
  $("btnZip").addEventListener("click", () => void downloadZip());
  $("btnExpand").addEventListener("click", () => { $("fullImage").src = $("previewImage").src; $("imageDialog").showModal(); });
  $("btnCloseImage").addEventListener("click", () => $("imageDialog").close());
  $("imageDialog").addEventListener("close", () => $("fullImage").removeAttribute("src"));
  $("btnInstall").addEventListener("click", () => void installApp());
  $("btnCloseInstall").addEventListener("click", () => $("installDialog").close());
  $("btnCloseToast").addEventListener("click", () => { $("toast").hidden = true; });
  $("btnUpdate").addEventListener("click", () => {
    if (!state.busy && state.registration?.waiting) { state.updating = true; state.registration.waiting.postMessage({ type: "SKIP_WAITING" }); }
  });
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; });
  window.addEventListener("appinstalled", () => { $("btnInstall").hidden = true; deferredInstall = null; });
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  window.addEventListener("beforeunload", (event) => {
    if (state.busy) { event.preventDefault(); event.returnValue = ""; }
  });
  try { applyPreferences(JSON.parse(localStorage.getItem("geotag:display:v3") || "{}")); }
  catch { applyPreferences(defaults); }
  if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) $("btnInstall").hidden = true;
  initMap(); updateConnection(); updateControls();
  void setupServiceWorker();
})();
