// PadLink Go's boards on this device (IndexedDB: the app's own storage, which other sites and apps can't read), and
// .padlink board files: the same format PadLink saves on the PC. Shared by the boards list (go.js) and the whiteboard's
// stand-in (board-host.js). Nothing here sends anything anywhere.
window.GoStore = (() => {
  'use strict';

  const MAX_FILE = 400 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

  let dbp = null;
  function db() {
    dbp = dbp || new Promise((resolve, reject) => {
      const open = indexedDB.open('padlink-go', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('boards', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('boards', mode);
      let result;
      Promise.resolve(fn(t.objectStore('boards'))).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage refused the change (the device may be full).'));
    });
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const allBoards = () => tx('readonly', (s) => req(s.getAll()));
  const getBoard = (id) => tx('readonly', (s) => req(s.get(id)));
  const putBoard = (b) => tx('readwrite', (s) => { s.put(b); });
  const deleteBoard = (id) => tx('readwrite', (s) => { s.delete(id); });

  /** Ask the device to keep this app's storage (not cleared when space runs low). */
  let persistAsked = false;
  async function keepStorage() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    try { await navigator.storage.persist(); } catch { /* not offered: Home Screen apps keep their storage anyway */ }
  }

  const newId = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const isImageUrl = (u) => {
    if (typeof u !== 'string' || !u.startsWith('data:')) return false;
    const comma = u.indexOf(','), head = u.slice(5, comma);
    return comma > 0 && head.endsWith(';base64') && IMAGE_TYPES.has(head.slice(0, -7).toLowerCase());
  };

  /** A board from a .padlink file (gzip-compressed or plain JSON), checked like the PC checks it; or an Error saying why not. */
  async function readBoardFile(file) {
    if (file.size > MAX_FILE) throw new Error(`That file is too big to be a PadLink board (${Math.round(file.size / 1048576)} MB).`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    try {
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else text = new TextDecoder().decode(bytes);
    } catch { throw new Error('That file is damaged: it can’t be unpacked.'); }
    let doc;
    try { doc = JSON.parse(text); } catch { throw new Error('That isn’t a PadLink board file (or it’s damaged).'); }
    if (!doc || typeof doc !== 'object' || doc.padlink !== 'board' || !(doc.version >= 1)) throw new Error('That isn’t a PadLink board file.');
    if (doc.version > 1) throw new Error('That board was saved by a newer PadLink. Update PadLink Go (close and reopen it), then try again.');
    const pages = doc.state && doc.state.pages;
    if (!Array.isArray(pages) || !pages.length || pages.some((p) => !p || typeof p !== 'object')) throw new Error('That board file has no pages (it may be damaged).');
    const name = String(doc.name || '').trim().slice(0, 80) || 'Board';
    const images = {};
    for (const [id, url] of Object.entries(doc.images || {})) if (/^\d+$/.test(id) && isImageUrl(url)) images[String(Number(id))] = url;
    return {
      name,
      state: { pages, cur: Math.min(Math.max(0, doc.state.cur | 0), pages.length - 1) },
      images,
      thumb: isImageUrl(doc.thumb) ? doc.thumb : null,
    };
  }

  /** A board as a .padlink file (gzip-compressed JSON). */
  async function boardFile(b) {
    const json = JSON.stringify({ padlink: 'board', version: 1, name: b.name, saved: new Date().toISOString(), state: b.state, images: b.images || {}, thumb: b.thumb || null });
    const blob = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const clean = b.name.replace(/[\\/:*?"<>|]/g, ' ').trim().replace(/\.+$/, '').slice(0, 80) || 'Board';
    return new File([blob], clean + '.padlink', { type: 'application/octet-stream' });
  }

  /** Hand a file to the device's share sheet (Files, AirDrop, Drive, email); a download where there isn't one. */
  async function shareFile(file, title) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title }); return; }
      catch (e) {
        if (e && e.name === 'AbortError') return;
        // Safari opens the share sheet only straight from a tap, and a big board takes a moment to pack: one more tap.
        if (e && e.name === 'NotAllowedError') { readyToShare(file, title); return; }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  /** "Ready to share" with a Share button: the share sheet opens from that tap. */
  function readyToShare(file, title) {
    document.querySelector('.go-share')?.remove();
    const bar = document.createElement('div');
    bar.className = 'go-share';
    bar.setAttribute('role', 'dialog');
    bar.style.cssText = 'position:fixed;z-index:100;left:50%;bottom:max(24px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100% - 32px);padding:10px 10px 10px 18px;border-radius:16px;background:#1d2433;color:#fff;font:15px/1.3 -apple-system,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3)';
    const text = document.createElement('span');
    text.textContent = `“${file.name}” is ready.`;
    const share = document.createElement('button');
    share.textContent = 'Share';
    share.style.cssText = 'min-height:44px;padding:0 18px;border:0;border-radius:12px;background:#2f6bff;color:#fff;font:inherit;font-weight:700';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = 'min-width:44px;min-height:44px;border:0;background:none;color:#fff;font:inherit';
    share.onclick = () => { bar.remove(); navigator.share({ files: [file], title }).catch(() => {}); };
    close.onclick = () => bar.remove();
    bar.append(text, share, close);
    document.body.appendChild(bar);
  }

  // A file just brought in from Google Drive, on its way from the return page (drive/return.html) to the board: kept
  // in its own small storage for that moment only (taken = deleted).
  function driveDb() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('padlink-go-drive', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  async function drivePut(rec) {
    const d = await driveDb();
    await new Promise((resolve, reject) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(rec, 'next'); t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    d.close();
  }
  async function driveTake() {
    const d = await driveDb();
    const rec = await new Promise((resolve, reject) => {
      const t = d.transaction('files', 'readwrite');
      const st = t.objectStore('files');
      let got = null;
      st.get('next').onsuccess = (e) => { got = e.target.result || null; st.delete('next'); };
      t.oncomplete = () => resolve(got);
      t.onerror = () => reject(t.error);
    });
    d.close();
    return rec;
  }

  return { allBoards, getBoard, putBoard, deleteBoard, keepStorage, newId, readBoardFile, boardFile, shareFile, drivePut, driveTake };
})();
