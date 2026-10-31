// PadLink Go's offline helper (service worker): keeps a copy of the app on the device, so it opens with no internet.
// The app's files are listed at publish time; a new version is fetched in the background and used once the teacher
// taps "Restart now" (or the app next opens fresh). Boards are not here: they live in the app's own device storage.
const VERSION = '2b357dbcf443';
const FILES = ['./', 'index.html', 'go.css', 'go.js', 'store.js', 'board-host.js', 'pair.html', 'pair.js', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'brand-symbol.png', 'brand-go.png', 'drive-return.js', 'update.js', 'engine.js', 'rich.js', 'rich.css', 'board.js', 'board.css', 'class.js', 'pcsettings.js', 'drive.js', 'drive.css', 'drive/return.html', 'pdfjs/LICENSE', 'pdfjs/pdf.min.mjs', 'pdfjs/pdf.worker.min.mjs', 'pdfjs/README.txt', 'pdfjs/standard_fonts/FoxitDingbats.pfb', 'pdfjs/standard_fonts/FoxitFixed.pfb', 'pdfjs/standard_fonts/FoxitFixedBold.pfb', 'pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb', 'pdfjs/standard_fonts/FoxitFixedItalic.pfb', 'pdfjs/standard_fonts/FoxitSerif.pfb', 'pdfjs/standard_fonts/FoxitSerifBold.pfb', 'pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb', 'pdfjs/standard_fonts/FoxitSerifItalic.pfb', 'pdfjs/standard_fonts/FoxitSymbol.pfb', 'pdfjs/standard_fonts/LiberationSans-Bold.ttf', 'pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf', 'pdfjs/standard_fonts/LiberationSans-Italic.ttf', 'pdfjs/standard_fonts/LiberationSans-Regular.ttf', 'pdfjs/standard_fonts/LICENSE_FOXIT', 'pdfjs/standard_fonts/LICENSE_LIBERATION', 'jsqr/jsQR.js', 'jsqr/LICENSE', 'jsqr/README.txt', 'board.html', 'pad.js', 'pad.css', 'control-host.js', 'control.html', 'teacher.js', 'teacher.css', 'grid-host.js', 'teacher.html', 'mark-host.js', 'mark.html'];
const CACHE = 'padlink-go-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('padlink-go-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'activate') self.skipWaiting(); });

// The app's own files from the copy on the device; anything else (nothing, today) from the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const hit = await cache.match(new URL(path, self.location.origin).href, { ignoreSearch: true });
    return hit || fetch(e.request);
  })());
});
