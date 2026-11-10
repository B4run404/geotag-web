# GeoTag — Stempel Foto GPS

PWA untuk iPhone dan desktop: tambahkan kartu peta, alamat, koordinat, dan waktu langsung ke foto, sekaligus menulis GPS EXIF. Tanpa akun, iklan, backend, atau build produksi.

## Pemakaian

Editor dibuka dengan dua pintu masuk:

- **Foto langsung** — membuka kamera perangkat (tombol kamera pada pemilih iOS). Begitu foto diambil, aplikasi otomatis mengambil GPS perangkat untuk foto baru tersebut; tinggal tekan **Buat foto**. GPS tidak diminta sebelum kamu memakai fitur ini atau menekan **Lokasi saya**.
- **Pilih gambar** — galeri/Files, bisa banyak foto sekaligus, atau seret ke editor. Lokasi diatur manual (peta, pencarian, koordinat, **Dari foto**).

1. Pilih foto dari galeri, ambil lewat **Kamera**, atau seret file ke editor.
2. Tentukan lokasi lewat **Lokasi saya**, **Dari foto**, pencarian tempat, pin peta, atau koordinat manual. Lokasi terpilih diterapkan ke seluruh batch.
3. Atur tema terang/gelap, posisi, ukuran, kepekatan, nama tempat, alamat, dan catatan. Centang informasi yang ingin terlihat.
4. Bandingkan **Asli / Stempel** di pratinjau. Ketuk perbesar untuk melihat lebih jelas.
5. Tekan **Buat foto**, lalu **Bagikan / simpan**, **Unduh JPEG**, atau **Semua (ZIP)**. Di share sheet iPhone, pilih Simpan Gambar atau Simpan ke File jika tersedia.

Foto asli tidak ditimpa. Pengaturan yang diubah setelah ekspor diberi penanda agar hasil lama tidak dianggap hasil terbaru. Batch bisa dibatalkan; hasil yang sudah selesai tetap tersedia.

Peta jalan memakai OpenStreetMap DE / FOSSGIS, bukan server tile OSM utama yang sebelumnya menampilkan "Access blocked". Sumber yang sama dipakai pada editor dan stempel. Kontrol +/−, skala meter, geser/pinch, dan tombol pusatkan ke pin tersedia. Respons 403/429/HTML tidak digambar sebagai tile; tombol **Muat ulang peta** tersedia jika pemuatan gagal.

Kartu stempel dirancang ringkas: judul, alamat, koordinat DMS, Plus Code, dan waktu dalam blok teks rapat, peta mini proporsional, serta metrik (ketinggian/akurasi/kecepatan/suhu) sebagai satu baris ikon + nilai tanpa label besar — sehingga kartu hanya menutup sebagian kecil foto pada orientasi apa pun. Di layar HP, editor otomatis menggulir ke pratinjau setelah foto dibaca dan setelah hasil selesai dibuat.

### Foto dan metadata

- JPEG, PNG, dan WebP didukung. HEIC diproses jika decoder browser mendukungnya; jika gagal, ekspor JPEG lewat Foto/Files terlebih dahulu. Konversi HEIC otomatis oleh pemilih foto **tidak dijamin**.
- Maksimum 20 foto, 35 MB per foto, 150 MB per batch. Header JPEG/PNG/WebP di atas 80 MP atau 32768 px per sisi ditolak sebelum decoding. Gambar diproses satu per satu; bitmap dan canvas dilepas setelah selesai.
- Hasil stempel selalu JPEG, maksimum sisi panjang 2048/3072/4096 px dan 12 megapiksel. Gambar kecil tidak diperbesar. PNG transparan memakai latar putih.
- Metadata standar EXIF JPEG dipertahankan sejauh dapat dibaca. Rendering menormalkan orientasi, memperbarui dimensi, dan membuang thumbnail/MakerNote lama. Metadata HEIC/PNG/WebP tidak diimpor.
- Nonaktifkan stempel untuk menulis GPS EXIF saja. Untuk JPEG, data piksel terkompresi tidak berubah. Penulisan koordinat mengganti keseluruhan GPS IFD agar ketinggian/kecepatan lama tidak tertinggal.
- **Hapus GPS EXIF** membuat salinan dari sumber asli. Ini bukan penghapus stempel yang sudah menyatu dengan piksel dan bukan penghapus semua jenis metadata (misalnya XMP).
- Waktu bawaan berasal dari `DateTimeOriginal` foto. Offset EXIF dipertahankan bila tersedia; zona waktu tidak ditebak. Jika tidak ada tanggal foto, dipakai waktu sesi perangkat, dengan sumber waktu ditampilkan di pratinjau. Waktu manual tersedia.
- Timestamp GPS ditulis jika ada waktu pengukuran GPS perangkat atau GPS asli foto, dalam UTC. Suhu berlabel **Kini**, bukan cuaca historis saat foto diambil. Sensor yang tidak tersedia tidak diisi angka rekaan.
- Aplikasi yang menerima file hasil dapat mengubah metadata; periksa informasi lokasi pada file yang benar-benar disimpan.

## Pasang di iPhone

Aplikasi harus dipublikasikan lewat HTTPS untuk GPS, service worker, dan berbagi file.

1. Unggah seluruh aset produksi di bawah ke GitHub Pages, Cloudflare Pages (Direct Upload), atau hosting statis HTTPS.
2. Buka URL-nya di **Safari**.
3. **Bagikan → Tambahkan ke Layar Utama → Tambah**.
4. Buka GeoTag dari ikon. Izinkan lokasi ketika menekan **Lokasi saya**.

Jika memakai GitHub Pages: unggah aset ke root repo → **Settings → Pages → Deploy from a branch → main / (root)**. Path relatif mendukung subfolder seperti `/geotag-web/`.

### Aset produksi — semuanya harus ikut diunggah

```text
index.html
style.css
app.js
core.js
services.js
stamp.js
sw.js
manifest.webmanifest
icons/                 (3 ikon PNG)
vendor/                (seluruh isi, termasuk images, lisensi, SOURCES.json)
```

`node_modules/`, `tests/`, `test-results/`, dan konfigurasi pengembangan tidak diperlukan di hosting. Tidak ada CDN script atau font saat runtime.

## Offline dan penyimpanan

- Tunggu status **Editor siap digunakan offline** sebelum memutus internet. Shell, renderer, EXIF, dan Plus Code tersedia lokal setelah pemasangan worker berhasil.
- Koordinat manual dan alamat yang diketik sendiri tetap bekerja offline. Peta yang belum tersimpan, pencarian alamat, dan cuaca memerlukan internet. Peta yang hilang diberi label, bukan diganti peta rekaan.
- Maksimum 100 tile peta disimpan oleh service worker. Hasil alamat dan cuaca hanya dicache sementara dalam memori dengan masa berlaku; cuaca tidak disimpan permanen.
- Foto dan hasil ekspor hanya berada dalam sesi/tab. Simpan hasil sebelum menutup atau memperbarui aplikasi. Hanya preferensi tampilan disimpan di `localStorage`, bukan foto, koordinat, atau teks pribadi.
- Foto tidak diunggah. FOSSGIS (`tile.openstreetmap.de`) menerima permintaan tile, Nominatim menerima kueri/koordinat, dan Open-Meteo menerima koordinat jika suhu diaktifkan. Tidak ada analitik.
- PWA ini tidak merekam GPS di background saat iOS menangguhkan aplikasi.

### Pembaruan

Naikkan `CACHE_VERSION` di `sw.js` setiap merilis perubahan aset. Versi baru menunggu di background; tombol **Perbarui** mengaktifkannya setelah hasil disimpan. Cache aplikasi lain pada origin yang sama tidak dihapus.

Rilis 3.0.1 mengganti sumber peta dan membuang cache tile rilis 3.0.0 saat worker baru aktif. Setelah mengunggah ulang, buka aplikasi dan tekan **Perbarui**. Tidak perlu menghapus foto atau semua data browser.

Migrasi dari versi lama v1/v2: bila antarmuka lama masih muncul, tutup semua tab/jendela GeoTag lalu buka lagi setelah mengunggah seluruh aset. Versi lama belum memiliki tombol pembaruan.

## Pengembangan dan pengujian

Node 24+ untuk server dan tes; aplikasi produksi tidak memerlukan Node.

```powershell
npm.cmd ci
npm.cmd start
```

Buka `http://127.0.0.1:4173` di komputer. Server development hanya mendengarkan loopback secara default. Akses HTTP alamat LAN dari iPhone tidak setara dengan HTTPS; pakai hosting HTTPS untuk pengujian GPS/PWA di perangkat.

```powershell
npm.cmd run check
npm.cmd test
npx.cmd playwright install webkit
npm.cmd run test:browser
```

Tes browser memakai Chrome yang terpasang dan WebKit dengan profil iPhone 13, menggunakan profil browser terisolasi. Server tes dimulai/dihentikan oleh Playwright. Tes end-to-end memakai respons peta/alamat sintetis untuk hasil berulang, bukan mengirim foto ke layanan eksternal. Ini tidak menggantikan uji share sheet dan izin pada iPhone fisik.

- `tests/core.test.cjs`: validasi file/koordinat, EXIF JPEG nyata, orientasi, timestamp UTC, tanggal, batas resolusi, ZIP/CRC.
- `tests/sw.test.cjs`: precache, integritas vendor, isolasi scope, update waiting worker, kegagalan jaringan/storage, batas cache tile.
- `tests/browser/`: unggah → pratinjau → ekspor, tema, batch ZIP, JPEG/PNG, error, geolokasi, dan WebKit responsif.

Dependensi runtime vendored: Leaflet 1.9.4, piexifjs 1.0.6, Open Location Code tag 1.0.4. Versi, URL upstream, SHA-256, dan lisensi dicatat di `vendor/SOURCES.json`.
