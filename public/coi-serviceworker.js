/*! coi-serviceworker v0.1.7 - Guido Zuidhof / nickelow, licensed under MIT */
/*
 * Adds Cross-Origin-Embedder-Policy and Cross-Origin-Opener-Policy headers
 * to all responses via a service worker, enabling SharedArrayBuffer without
 * requiring server-side header configuration.
 */
if (typeof window === "undefined") {
  // Service worker context
  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("fetch", function (event) {
    if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response.status === 0) return response;
        var headers = new Headers(response.headers);
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: headers,
        });
      })
    );
  });
} else {
  // Window context — register the service worker, then reload once active
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(window.document.currentScript.src).then(
      function (registration) {
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      },
      function (err) {
        console.error("COOP/COEP service worker failed to register:", err);
      }
    );
  }
}
