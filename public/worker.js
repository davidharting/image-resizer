/* wasm-vips resize worker */

let vipsReady = null;

try {
  importScripts("vips.js");
} catch (err) {
  postMessage({ type: "error-init", error: "Failed to load vips.js: " + err.message });
}

function initVips() {
  if (!vipsReady) {
    if (typeof Vips === "undefined") {
      vipsReady = Promise.reject(new Error("Vips global not found — importScripts may have failed"));
    } else {
      vipsReady = Vips({
        dynamicLibraries: [],
        // Emscripten sets _scriptName = self.location.href inside workers,
        // which resolves to worker.js — not vips.js. The pthread sub-workers
        // would then load worker.js and hang. Point them to the correct file.
        mainScriptUrlOrBlob: new URL("vips.js", self.location.href).href,
      }).then(function (v) {
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

    // Keep ICC profile for accurate color rendering and EXIF for the
    // ColorSpace tag (0xA001) which tells viewers whether the image uses
    // sRGB, AdobeRGB, etc.  Without it some viewers assume sRGB and render
    // wide-gamut images with dull, washed-out colours.
    const keepFlags = vips.ForeignKeep.icc | vips.ForeignKeep.exif;

    if (format === "image/png") {
      outputBytes = resized.writeToBuffer(ext, {
        compression: 6,
        keep: keepFlags,
      });
    } else if (format === "image/webp") {
      outputBytes = resized.writeToBuffer(ext, {
        Q: quality,
        effort: 4,
        keep: keepFlags,
      });
    } else {
      // JPEG
      outputBytes = resized.writeToBuffer(ext, {
        Q: quality,
        optimize_coding: true,
        keep: keepFlags,
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
