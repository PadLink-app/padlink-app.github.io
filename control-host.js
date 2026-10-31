// PadLink Go (stage 8): the control screen. It's the iPad's own PadLink page (pad.js, the same as the PC serves), told
// which paired PC to control: that PC's Remote mode link and this device's key for it, from PadLink Go's storage.
// Loaded before pad.js. Without a PC that this device may control, it goes back to the boards list.
(() => {
  'use strict';
  const KEY = 'padlink-go.pc';
  const PCS_KEY = 'padlink-go.pcs';
  let pc = null;
  try { pc = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* storage unavailable */ }
  const back = (why) => {
    try { if (why) sessionStorage.setItem('padlink-go.back', why); sessionStorage.setItem('padlink-go.stay', '1'); } catch { /* fine */ }
    location.replace('./');
  };
  if (!pc || !pc.url || !pc.key || !pc.control) { back('unpaired'); return; }
  const saved = (v, remove = false) => {
    try {
      const got = JSON.parse(localStorage.getItem(PCS_KEY) || '[]');
      const all = Array.isArray(got) ? got.filter((p) => p && p.url && p.key && p.url !== v.url) : [];
      if (!remove) all.unshift(v);
      localStorage.setItem(PCS_KEY, JSON.stringify(all));
    } catch { /* private mode */ }
  };
  const save = (v) => {
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ }
    saved(v);
  };
  window.PADLINK_HOST = {
    base: pc.url,
    deviceKey: pc.key,
    name: pc.name,
    saveKey(key) { pc.key = key; save(pc); },
    // Forgotten on the PC: this key no longer works for anything, so PadLink Go lets go of this PC.
    forget() {
      try { localStorage.removeItem(KEY); } catch { /* fine */ }
      saved(pc, true);
    },
    back,
  };

  // A new version of PadLink Go: update.js offers Restart now here too (checked again each time the app comes back).

  // Prepared boards not on the PC yet: a note at the bottom, once, that leads back to them (stage 8e).
  addEventListener('load', async () => {
    if (!window.GoStore) return;
    let n = 0;
    // Not on this PC yet (each paired PC keeps its own Sent; older boards' Sent counts for it)
    const at = (b) => (!b.sent ? 0 : !b.sent.to ? b.sent.at : b.sent.to[pc.url] || 0);
    try { n = (await GoStore.allBoards()).filter((b) => !at(b) || b.modified > at(b)).length; } catch { return; }
    if (!n) return;
    const note = document.createElement('button');
    note.id = 'goUnsent';
    note.textContent = `${n} prepared board${n === 1 ? '' : 's'} not on the PC yet · Your boards ›`;
    note.style.cssText = 'position:fixed;z-index:60;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100% - 32px);min-height:44px;padding:0 18px;border:0;border-radius:14px;background:#1d2433;color:#fff;font:600 15px -apple-system,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)';
    note.addEventListener('click', () => back());
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 12000);
  });
})();
