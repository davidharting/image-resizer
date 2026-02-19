#!/usr/bin/env node
// Minimal static file server with cross-origin isolation headers
// Required for SharedArrayBuffer (used by wasm-vips)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

http
  .createServer(function (req, res) {
    var urlPath = req.url.split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";
    var filePath = path.join(PUBLIC, urlPath);

    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, function (err, data) {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      var ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // These two headers enable SharedArrayBuffer (required by wasm-vips).
        // "credentialless" allows loading CDN resources (jsdelivr) without
        // requiring them to set Cross-Origin-Resource-Policy headers.
        "Cross-Origin-Embedder-Policy": "credentialless",
        "Cross-Origin-Opener-Policy": "same-origin",
      });
      res.end(data);
    });
  })
  .listen(PORT, function () {
    console.log("Serving public/ at http://localhost:" + PORT);
  });
