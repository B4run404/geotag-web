"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };
http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, relative);
    const safe = path.relative(root, file);
    if (safe.startsWith("..") || path.isAbsolute(safe) || /(^|[\\/])(?:\.|node_modules|tests)/.test(safe)) {
      response.writeHead(403).end("Forbidden"); return;
    }
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404).end("Not found"); return; }
      response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      if (request.method === "HEAD") response.end();
      else fs.createReadStream(file).on("error", () => response.destroy()).pipe(response);
    });
  } catch { response.writeHead(400).end("Bad request"); }
}).listen(port, host, () => console.log(`GeoTag: http://${host}:${port}`));
