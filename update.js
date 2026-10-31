// PadLink Go: a new version, on the whiteboard and the control screen. iPadOS and iOS bring a Home Screen app back
// from the background without loading it again, so the browser's own check (when a page loads) can miss a new
// version for days. So: check when the screen loads and again each time the app comes back (at most once a minute),
// and offer "Restart now". A page can set window.goBeforeRestart (returns a promise) to save first.
(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  let lastCheck = 0;
  const offer = (w) => {
    if (!w || !navigator.serviceWorker.controller || document.getElementById('goUpdate')) return;
    if (!document.body) { addEventListener('DOMContentLoaded', () => offer(w), { once: true }); return; }
    const bar = document.createElement('div');
    bar.id = 'goUpdate';
    bar.style.cssText = 'position:fixed;z-index:70;left:50%;top:max(10px,env(safe-area-inset-top));transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100% - 24px);padding:8px 8px 8px 16px;border-radius:14px;background:#2f6bff;color:#fff;font:600 14.5px -apple-system,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)';
    bar.innerHTML = '<span>A new version of PadLink Go is ready.</span><button style="min-height:36px;padding:0 14px;border:0;border-radius:10px;background:#fff;color:#1e4fc2;font:inherit;cursor:pointer">Restart now</button><button aria-label="Later" style="min-height:36px;padding:0 10px;border:0;border-radius:10px;background:rgba(255,255,255,.18);color:#fff;font:inherit;cursor:pointer">Later</button>';
    const [now, later] = bar.querySelectorAll('button');
    now.addEventListener('click', async () => {
      now.disabled = true;
      try { if (window.goBeforeRestart) await window.goBeforeRestart(); } catch { /* restart anyway: the board saved as it went */ }
      reloading = true;
      w.postMessage('activate');
    });
    later.addEventListener('click', () => bar.remove());
    document.body.appendChild(bar);
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    const check = () => {
      if (Date.now() - lastCheck < 60000) return;
      lastCheck = Date.now();
      reg.update().then(() => offer(reg.waiting)).catch(() => { /* offline: next time */ });
    };
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    addEventListener('pageshow', (e) => { if (e.persisted) check(); });
    window.GoUpdate = { forget: () => { lastCheck = 0; } }; // for the tests: as if the last check was long ago
  }).catch(() => { /* no offline helper */ });
})();
