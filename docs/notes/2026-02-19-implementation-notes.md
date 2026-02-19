# Implementation Notes — Image Resizer

Date: 2026-02-19

## Overview

A fully client-side image resizer that runs in the browser with no server-side
processing. Users upload an image, pick target dimensions and output format
(PNG / JPEG / WebP), and get a resized file back. Everything happens locally —
image data never leaves the browser.

The resize engine is **libvips** compiled to WebAssembly via
[wasm-vips](https://github.com/kleisauke/wasm-vips). This gives us
Lanczos3 resampling (a high-quality windowed sinc filter), which is a
significant upgrade over the bilinear interpolation you get from the HTML
Canvas `drawImage()` API.

## Architecture

```
index.html        — single-page UI, all markup + styles + main-thread JS
worker.js         — Web Worker that loads and drives wasm-vips
vips.js           — Emscripten JS glue from wasm-vips (v0.0.16)
vips.wasm         — compiled libvips (~5.4 MB)
coi-serviceworker.js — enables SharedArrayBuffer via COOP/COEP headers
```

Everything lives in `public/`. There is no build step, no bundler, no
framework. You serve the directory with any static file server and it works.

### Data flow

1. User drops/selects an image file.
2. Main thread reads it as an `ArrayBuffer` (for the worker) and a data URL
   (for the preview thumbnail).
3. On resize, the `ArrayBuffer` is copied and transferred to the worker via
   `postMessage` with a `Transferable`.
4. The worker calls `vips.Image.thumbnailBuffer()` to decode + resize in one
   step (exploiting JPEG shrink-on-load for large downscales), then encodes
   the result with `writeToBuffer()`.
5. The encoded bytes are transferred back to the main thread, wrapped in a
   `Blob`, and displayed via `URL.createObjectURL()`.

### Why a Web Worker?

Compiling and running a 5.4 MB WASM module is CPU-intensive. Doing it on the
main thread would freeze the UI for several seconds during init and during
each resize. The worker keeps the page responsive.

## wasm-vips sourcing

The WASM files come from the **wasm-vips** npm package (v0.0.16):

```
npm pack wasm-vips@0.0.16
```

From the tarball we copied two files into `public/`:
- `lib/vips.js` — Emscripten JS glue (~89 KB)
- `lib/vips.wasm` — compiled libvips (~5.4 MB)

The package also ships optional codec modules (`vips-heif.wasm`,
`vips-jxl.wasm`, `vips-resvg.wasm`) for HEIF, JPEG XL, and SVG support.
We exclude these by passing `dynamicLibraries: []` when initializing the
module — the base `vips.wasm` already supports JPEG, PNG, WebP, TIFF, and
GIF, which covers our needs and avoids downloading ~8 MB of extra WASM.

### Why vendor locally instead of CDN?

Earlier iterations loaded `vips.js` and `vips.wasm` from the jsDelivr CDN.
This caused two problems:

1. **CORS + COEP conflicts.** wasm-vips uses pthreads, which require
   `SharedArrayBuffer`, which requires the page to be cross-origin isolated
   (COOP + COEP headers). CDN-hosted WASM fetches were blocked by COEP
   unless the CDN returned `Access-Control-Allow-Origin` and we used
   `credentialless` mode. This was fragile.

2. **`wasmBinary` / fetch path issues.** Emscripten's default WASM loading
   assumes the `.wasm` file is next to the `.js` file. When loaded from a
   CDN via `importScripts()` inside a worker, the relative path resolution
   broke. We tried pre-fetching the WASM and passing `wasmBinary`, which
   partially worked but added complexity.

Vendoring both files locally eliminates all of this. They sit next to
`worker.js` and load via simple relative paths.

## Cross-origin isolation (SharedArrayBuffer)

wasm-vips is compiled with Emscripten's pthread support, which uses
`SharedArrayBuffer` for shared memory between threads. Browsers only expose
`SharedArrayBuffer` when the page is **cross-origin isolated**, meaning the
response headers include:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Since this is a static site and we don't control server headers in all
deployment targets (e.g. GitHub Pages), we use **coi-serviceworker**
(`coi-serviceworker.js`). It's a service worker that intercepts all fetch
responses and injects the required COOP/COEP headers client-side.

On first visit, the service worker registers, then the page reloads so the
headers take effect. On subsequent visits, the SW is already active.

The version in this repo is a simplified/trimmed copy of
[coi-serviceworker](https://github.com/nickelow/coi-serviceworker) (v0.1.7).

## The pthread hang bug

The most subtle bug we hit: the app would get stuck at "Loading wasm-vips
engine..." indefinitely with no errors in the console.

**Root cause:** Emscripten's pthread implementation spawns sub-workers using
`new Worker(_scriptName, {name: "em-pthread"})`. Inside a worker context,
`_scriptName` is set to `self.location.href`, which resolves to `worker.js`
(our wrapper), not `vips.js` (the Emscripten module). The pthread sub-workers
would load `worker.js`, which doesn't contain the pthread slave init code
(`isPthread && Vips()`), so the threads never signalled back — causing the
module to hang forever waiting for them.

**Fix:** Pass `mainScriptUrlOrBlob` in the Vips init options to explicitly
point pthread workers at the correct file:

```js
vipsReady = Vips({
  dynamicLibraries: [],
  mainScriptUrlOrBlob: new URL("vips.js", self.location.href).href,
})
```

## EXIF handling

Two separate EXIF-related features:

### 1. EXIF display (read-only)

A hand-rolled EXIF parser in `index.html` reads the APP1/Exif segment from
JPEG files. It decodes IFD0, the Exif sub-IFD, and the GPS sub-IFD to
extract common tags (camera make/model, date, GPS coordinates, focal length,
etc.) and renders them in a comparison table.

### 2. Lossless EXIF stripping

The "Strip EXIF Only" button removes EXIF metadata from JPEGs at the binary
level — it parses JPEG segments and drops any APP1/Exif segments while
leaving all compressed image data untouched. This means zero generation loss
(every pixel stays bit-identical). Useful for removing GPS data before
sharing a photo without re-encoding.

For resized images, EXIF is automatically stripped by libvips — we pass
`keep: vips.ForeignKeep.icc` which preserves only the ICC color profile
and discards everything else.

## Resize approach

We use `vips.Image.thumbnailBuffer()` rather than a decode-then-resize
pipeline. `thumbnailBuffer` is smarter:

- For JPEG inputs, it uses libjpeg's built-in 2x/4x/8x shrink-on-load.
  If you're downscaling a 4000x3000 photo to 400x300, it tells the JPEG
  decoder to only decode at 1/8 resolution, then does a small Lanczos
  resize for the remainder. This is dramatically faster and uses far less
  memory.
- The `size: vips.Size.force` flag disables aspect ratio preservation,
  giving the user exact pixel dimensions.

### Output encoding options

| Format | Key settings |
|--------|-------------|
| PNG    | `compression: 6`, lossless, quality slider disabled |
| JPEG   | `Q: <quality>`, `optimize_coding: true` (optimized Huffman tables) |
| WebP   | `Q: <quality>`, `effort: 4` (encode speed/quality tradeoff) |

All formats use `keep: vips.ForeignKeep.icc` to preserve ICC profiles.

## File structure rationale

No build step was a deliberate choice. The entire app is four files in
`public/` plus the vendored WASM artifacts. This makes deployment trivial
(any static host works), keeps the mental model simple, and avoids bundler
configuration for what is fundamentally a single-page tool.

The tradeoff is that `index.html` is a large single file (~970 lines) with
inline styles and inline JS. For a tool of this scope, that's fine.
