/* wasm-vips resize worker */

let vipsReady = null;

try {
  importScripts("https://cdn.jsdelivr.net/npm/wasm-vips@0.0.16/lib/vips.js");
} catch (err) {
  postMessage({ type: "error-init", error: "Failed to load vips.js from CDN: " + err.message });
}

function initVips() {
  if (!vipsReady) {
    if (typeof Vips === "undefined") {
      vipsReady = Promise.reject(new Error("Vips global not found — importScripts may have failed"));
    } else {
      vipsReady = fetch("https://cdn.jsdelivr.net/npm/wasm-vips@0.0.16/lib/vips.wasm")
        .then(function (resp) {
          if (!resp.ok) throw new Error("Failed to fetch vips.wasm: " + resp.status);
          return resp.arrayBuffer();
        })
        .then(function (wasmBinary) {
          return Vips({ dynamicLibraries: [], wasmBinary: wasmBinary });
        })
        .then(function (v) {
          postMessage({ type: "ready" });
          return v;
        })
        .catch(function (err) {
          postMessage({ type: "error-init", error: "Vips init failed: " + err.message });
          throw err;
        });
    }
  }
  return vipsReady;
}

// Start loading immediately
initVips();

self.onmessage = async function (e) {
  const { id, inputBuffer, width, height, format, quality } = e.data;
  let vips;
  try {
    vips = await initVips();
  } catch (err) {
    postMessage({ type: "error", id, error: "Failed to load wasm-vips: " + err.message });
    return;
  }

  let resized = null;
  try {
    const inputData = new Uint8Array(inputBuffer);

    // Use thumbnailBuffer for efficient shrink-on-load (JPEG 2x/4x/8x shrink)
    resized = vips.Image.thumbnailBuffer(inputData, width, {
      height: height,
      // Do not preserve aspect ratio — use the exact dimensions the user asked for
      size: vips.Size.force,
    });

    // Determine save options
    let outputBytes;
    const ext = format === "image/png" ? ".png" : format === "image/webp" ? ".webp" : ".jpg";

    if (format === "image/png") {
      outputBytes = resized.writeToBuffer(ext, {
        compression: 6,
        keep: vips.ForeignKeep.icc,
      });
    } else if (format === "image/webp") {
      outputBytes = resized.writeToBuffer(ext, {
        Q: quality,
        effort: 4,
        keep: vips.ForeignKeep.icc,
      });
    } else {
      // JPEG
      outputBytes = resized.writeToBuffer(ext, {
        Q: quality,
        optimize_coding: true,
        keep: vips.ForeignKeep.icc,
      });
    }

    const resultBuffer = outputBytes.buffer.slice(
      outputBytes.byteOffset,
      outputBytes.byteOffset + outputBytes.byteLength
    );

    postMessage(
      { type: "result", id, buffer: resultBuffer, format },
      [resultBuffer]
    );
  } catch (err) {
    postMessage({ type: "error", id, error: err.message || String(err) });
  } finally {
    if (resized) resized.delete();
  }
};
