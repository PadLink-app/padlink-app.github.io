// The page the PC's QR code opens when it's scanned with the Camera (in Safari). PadLink Go itself reads the same code
// with its own camera, so this page only says how to get PadLink Go, and offers the other ways: copying the link (to
// paste in PadLink Go) or the PC's own PadLink page. It sends nothing.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  addEventListener('hashchange', () => location.reload()); // another pairing link opened in this tab
  // This page holds nothing to lose, so a newer PadLink Go is used at once (not after "Restart now"): otherwise Safari
  // shows the copy kept on the iPad from last time, old logo and all, until every PadLink Go tab is closed.
  if ('serviceWorker' in navigator) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const use = (w) => { if (w && navigator.serviceWorker.controller) w.postMessage('activate'); };
      use(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') use(w); });
      });
      reg.update().catch(() => { /* offline */ });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => { /* offline */ }); });
    }).catch(() => { /* fine */ });
  }
  const p = new URLSearchParams(location.hash.slice(1)).get('p') || '';
  let info = null;
  try {
    info = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
  } catch { /* not a pairing link */ }
  const ok = !!(info && typeof info.u === 'string' && typeof info.c === 'string');
  $('#good').hidden = !ok;
  $('#bad').hidden = ok;
  if (!ok) return;
  // Added to the Home Screen from this page and opened from there: this is PadLink Go now, so connect.
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) { location.replace('./#pair=' + p); return; }
  if (typeof info.n === 'string' && info.n) $('#pcName').textContent = 'Connect this iPad to ' + info.n.slice(0, 40);
  // The PC's own page: Remote mode's address with the PC page's code (only an https devtunnels address).
  if (typeof info.t === 'string' && /^[A-Z0-9]{4,16}$/i.test(info.t) && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.devtunnels\.ms$/i.test(info.u)) {
    $('#pcPage').href = info.u + '/?t=' + encodeURIComponent(info.t);
    $('#pcPageRow').hidden = false;
  }
  $('#copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); }
    catch {
      const box = document.createElement('textarea');
      box.value = location.href;
      document.body.appendChild(box);
      box.select();
      document.execCommand('copy');
      box.remove();
    }
    $('#copied').hidden = false;
  });
})();
