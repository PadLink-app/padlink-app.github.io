// PadLink Go's boards on this device (IndexedDB: the app's own storage, which other sites and apps can't read), and
// .padlink board files: the same format PadLink saves on the PC. Shared by the boards list (go.js) and the whiteboard's
// stand-in (board-host.js). Nothing here sends anything anywhere.
window.GoStore = (() => {
  'use strict';

  const MAX_FILE = 400 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

  // The connection to the device's storage, opened once and kept. iPadOS (WebKit) sometimes breaks it, often after the
  // app sat in the background: then everything fails with "An internal error was encountered in the Indexed Database
  // server" until it's opened afresh. So a broken one is dropped and opened again, and the work tried again.
  let dbp = null;
  function db() {
    dbp = dbp || new Promise((resolve, reject) => {
      // Version 2: each board's pictures in their own records ('images', key "boardId|pictureId"), not inside the board:
      // iPadOS's storage fails on very large records (a board with many slides) and the list no longer loads every
      // picture of every board. Boards saved before keep theirs inside until they're saved again (or tidied, below).
      // Version 3: a small summary of each board ('meta': name, page count, thumbnail, dates, sent) for the list, so it
      // never has to read every board's pages and drawings just to show their names.
      const open = indexedDB.open('padlink-go', 3);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains('boards')) d.createObjectStore('boards', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      open.onsuccess = () => {
        const d = open.result;
        d.onclose = () => { if (dbp && dbp.conn === d) dbp = null; }; // closed by the browser: open afresh next time
        d.onversionchange = () => { d.close(); if (dbp && dbp.conn === d) dbp = null; };
        if (dbp) dbp.conn = d;
        resolve(d);
      };
      // Blocked: an older copy of PadLink Go (another tab, or the one before an update) still has it open. It closes
      // its connection when asked (onversionchange), so this goes on by itself; only if it doesn't, after a while, say so.
      let waited = 0;
      open.onblocked = () => { waited = waited || setTimeout(() => { dbp = null; reject(new Error('Storage is busy in another copy of PadLink Go. Close PadLink Go everywhere (swipe it away), then open it again.')); }, 10000); };
      const done = open.onsuccess;
      open.onsuccess = () => { clearTimeout(waited); done(); };
      open.onerror = () => { clearTimeout(waited); dbp = null; reject(open.error); };
    });
    return dbp;
  }
  /** The storage broke underneath (WebKit's internal error, a closed connection): worth a fresh connection and a retry. */
  const broken = (e) => !!e && (e.name === 'UnknownError' || e.name === 'InvalidStateError' || /internal error|connection.*clos|database.*clos/i.test(String(e.message || e)));
  function reopen() {
    const old = dbp && dbp.conn;
    dbp = null;
    try { if (old) old.close(); } catch { /* already gone */ }
  }
  async function tx(mode, fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await tx1(mode, fn); } catch (e) {
        if (attempt >= 3 || !broken(e)) throw e;
        reopen();
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  async function tx1(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      let t;
      try { t = d.transaction(['boards', 'images', 'meta'], mode); } catch (e) { reject(e); return; }
      let result;
      Promise.resolve(fn(t.objectStore('boards'), t.objectStore('images'), t.objectStore('meta'))).then((r) => { result = r; }, (e) => { try { t.abort(); } catch { /* done */ } reject(e); });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage refused the change (the device may be full).'));
    });
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const picsOf = (id) => IDBKeyRange.bound(id + '|', id + '|\uffff');
  /** Every board, without its pictures (the list: names, pages, thumbnails). getBoard has them. Read one board at a
   *  time, not all at once: boards saved before version 2 still have every picture inside, and one read of all of them
   *  can be more than iPadOS's storage will hand over (then nothing showed). A board that can't be read is left out
   *  and its id listed in list.unreadable, so the list still shows the others. */
  async function allBoards() {
    const ids = await tx('readonly', (s) => req(s.getAllKeys()));
    const list = [], unreadable = [];
    for (const id of ids) {
      try {
        const b = await tx('readonly', (s) => req(s.get(id)));
        if (!b) continue;
        if (b.images) { const { images, ...rest } = b; list.push(rest); } else list.push(b);
      } catch (e) { console.warn('Board', id, e); unreadable.push(id); }
    }
    list.unreadable = unreadable;
    return list;
  }
  /** A board's summary for the list: everything but its pages and pictures, and how many pages it has. */
  const summary = (b) => { const { state, images, ...m } = b; m.pages = state && Array.isArray(state.pages) ? state.pages.length : 0; return m; };

  /** The boards list: each board's summary (small: no pages, drawings or pictures), newest first is the caller's.
   *  A board without one yet (saved before version 3) is read once, on its own, and gets one. Ids that can't be read
   *  are in list.unreadable. Much faster than allBoards with many boards. */
  async function boardList() {
    const [metas, ids] = await tx('readonly', (s, im, m) => Promise.all([req(m.getAll()), req(s.getAllKeys())]));
    const have = new Map(metas.map((x) => [x.id, x]));
    const list = [], unreadable = [], stray = [];
    for (const id of ids) {
      if (have.has(id)) { list.push(have.get(id)); have.delete(id); continue; }
      try {
        const sum = await tx('readwrite', (s, im, m) => req(s.get(id)).then((b) => { if (!b) return null; const x = summary(b); m.put(x); return x; }));
        if (sum) list.push(sum);
      } catch (e) { console.warn('Board', id, e); unreadable.push(id); }
    }
    for (const id of have.keys()) stray.push(id); // a summary whose board is gone
    if (stray.length) tx('readwrite', (s, im, m) => { for (const id of stray) m.delete(id); }).catch(() => {});
    list.unreadable = unreadable;
    return list;
  }

  /** How much this app keeps on the device, in MB (or null). */
  async function usedMB() {
    try { const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; return est && est.usage ? est.usage / 1048576 : null; } catch { return null; }
  }
  /** A board with its pictures (from their own records, or inside it for a board saved before). */
  const getBoard = (id) => tx('readonly', (s, im) => new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const b = r.result;
      if (!b || b.images) { resolve(b); return; }
      const images = {};
      const c = im.openCursor(picsOf(id));
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) { images[String(cur.primaryKey).slice(id.length + 1)] = cur.value; cur.continue(); return; }
        b.images = images;
        resolve(b);
      };
    };
  }));
  /** Saves a board: its pictures each in their own record, only the new ones written (a picture never changes).
   *  A board without `images` (one from allBoards) keeps the pictures it has. */
  const putBoard = (b) => tx('readwrite', (s, im, mt) => new Promise((resolve, reject) => {
    const { images, ...rec } = b;
    const write = (pics) => {
      s.put(rec);
      mt.put(summary(rec));
      if (!pics) { resolve(); return; }
      const k = im.getAllKeys(picsOf(b.id));
      k.onerror = () => reject(k.error);
      k.onsuccess = () => {
        const had = new Set(k.result);
        for (const [pid, url] of Object.entries(pics)) {
          const key = b.id + '|' + pid;
          if (!had.delete(key)) im.put(url, key);
        }
        for (const key of had) im.delete(key); // pictures no longer in the board
        resolve();
      };
    };
    if (images) { write(images); return; }
    const old = s.get(b.id); // (saved before version 2, pictures inside: they move to their own records now)
    old.onerror = () => reject(old.error);
    old.onsuccess = () => write((old.result && old.result.images) || null);
  }));
  const deleteBoard = (id) => tx('readwrite', (s, im, m) => { s.delete(id); im.delete(picsOf(id)); m.delete(id); });

  /** An autosave from the whiteboard: the board's pages, and only its new pictures (it sends each picture once). Reads
   *  just the board's own record (for its dates and Sent), never its pictures: saving stays as quick with 300 slides as
   *  with 3. Returns false when there's no such board yet (then the caller makes it with putBoard). */
  const saveBoard = ({ id, name, state, thumb }, newImages) => tx('readwrite', (s, im, m) => new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const old = r.result;
      if (!old) { resolve(false); return; }
      const { images: inside, ...was } = old;
      const rec = { ...was, name, state, modified: Date.now(), thumb: thumb || was.thumb || null };
      for (const [pid, url] of Object.entries({ ...(inside || {}), ...(newImages || {}) })) im.put(url, id + '|' + pid); // (a board from before version 2: its pictures move out now)
      s.put(rec);
      m.put(summary(rec));
      resolve(true);
    };
  }));

  /** Changes a board's own record (name, Sent, dates) without reading or writing its pictures. fn changes it in place.
   *  Resolves to the changed record, or null when there's no such board. */
  const patchBoard = (id, fn) => tx('readwrite', (s, im, m) => req(s.get(id)).then((b) => {
    if (!b) return null;
    fn(b);
    s.put(b);
    m.put(summary(b));
    return b;
  }));

  /** The picture ids a board's pages use (pictures, pictures in groups, a page's PDF or slide). */
  function picturesUsed(state) {
    const out = new Set();
    const walk = (it) => { if (!it) return; if (it.type === 'image' && it.img != null) out.add(String(it.img)); else if (it.type === 'group') (it.items || []).forEach(walk); };
    for (const p of (state && state.pages) || []) { if (p.doc && p.doc.img != null) out.add(String(p.doc.img)); (p.items || []).forEach(walk); }
    return out;
  }

  /** Pictures a board no longer uses (deleted from its pages) are taken out of storage. Only when the board is opened
   *  (never while it's being changed: undo can bring a picture back during that time). */
  const prunePictures = (id) => tx('readwrite', (s, im) => new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const b = r.result;
      if (!b || b.images || !b.state) { resolve(0); return; } // (pictures still inside: tidy first)
      const used = picturesUsed(b.state);
      const k = im.getAllKeys(picsOf(id));
      k.onerror = () => reject(k.error);
      k.onsuccess = () => {
        let n = 0;
        for (const key of k.result) if (!used.has(String(key).slice(id.length + 1))) { im.delete(key); n++; }
        resolve(n);
      };
    };
  }));
  /** Boards saved before version 2 (pictures inside): moved to their own records, one board at a time, in the
   *  background. One that fails stays as it was (the change is all or nothing) and is tried again next time. */
  let tidying = false;
  async function tidy() {
    if (tidying) return;
    tidying = true;
    try {
      const ids = await tx('readonly', (s) => new Promise((resolve, reject) => {
        const found = [];
        const c = s.openCursor();
        c.onerror = () => reject(c.error);
        c.onsuccess = () => { const cur = c.result; if (!cur) { resolve(found); return; } if (cur.value && cur.value.images) found.push(cur.value.id); cur.continue(); };
      }));
      for (const id of ids) {
        try { const b = await getBoard(id); if (b) await putBoard(b); } catch (e) { console.warn('Tidy', id, e); /* next time */ }
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch { /* next time */ } finally { tidying = false; }
  }

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

  return { allBoards, boardList, saveBoard, patchBoard, prunePictures, picturesUsed, usedMB, getBoard, putBoard, deleteBoard, tidy, keepStorage, newId, readBoardFile, boardFile, shareFile, drivePut, driveTake };
})();
