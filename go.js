// PadLink Go: prepare whiteboards on the iPad or iPhone, anywhere, even offline. This is the boards list; a board opens
// in the whiteboard (board.html, the same one as on the PC) and saves itself on this device (store.js). Boards move as
// .padlink board files: the same format PadLink saves on the PC. Nothing is sent anywhere by this page.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const S = window.GoStore;
  const W = PadEngine.W, H = PadEngine.H;
  const defaultName = () => 'Board · ' + new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const openBoard = (id) => { location.href = 'board.html?b=' + encodeURIComponent(id); };

  /** A small picture of the first page, for a board file that came without one. */
  async function makeThumb(b) {
    try {
      const imgs = new Map();
      await Promise.all(Object.entries(b.images || {}).map(([id, url]) => new Promise((done) => {
        const img = new Image();
        img.onload = img.onerror = done;
        img.src = url;
        imgs.set(Number(id), img);
      })));
      const p = b.state.pages[0];
      const c = document.createElement('canvas');
      c.width = 400; c.height = 225;
      const ctx = c.getContext('2d');
      ctx.setTransform(400 / W, 0, 0, 400 / W, 0, 0);
      PadEngine.configure({ image: (id) => imgs.get(id) || null });
      PadEngine.renderPage(ctx, { bg: p.bg || 'white', h: p.h || H, doc: p.doc, items: p.items || [] });
      return c.toDataURL('image/jpeg', 0.75);
    } catch { return null; }
  }

  // ---------- the list ----------
  const fmtDate = (t) => { const d = new Date(t); return d.toLocaleDateString([], d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }); };
  const BLANK = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#fff"/></svg>');

  async function render() {
    const list = (await S.allBoards()).sort((a, b) => b.modified - a.modified);
    $('#empty').hidden = list.length > 0;
    const grid = $('#boards');
    grid.textContent = '';
    for (const b of list) {
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.id = b.id;
      const pages = b.state.pages.length;
      card.innerHTML = '<img class="thumb" alt=""><div class="info"><span class="name"></span><span class="meta"></span><span class="badge"></span><button class="more" aria-label="More">…</button></div><button class="open" aria-label="Open"></button>';
      card.querySelector('.thumb').src = b.thumb || BLANK;
      card.querySelector('.name').textContent = b.name;
      card.querySelector('.meta').textContent = `${pages} page${pages === 1 ? '' : 's'} · ${fmtDate(b.modified)}`;
      const badge = card.querySelector('.badge');
      const at = sentAt(b), changed = !!at && b.modified > at;
      badge.textContent = !b.sent ? 'Not sent yet' : !at ? `Sent to ${b.sent.pc || 'another PC'}, not this one` : changed ? 'Changed since sent' : b.sent.fromPc ? 'From the PC' : `Sent ✓ ${fmtDate(at)}`;
      badge.classList.toggle('sent', !!at && !changed);
      card.querySelector('.open').addEventListener('click', () => openBoard(b.id));
      card.querySelector('.more').addEventListener('click', (e) => openMenu(b.id, e.currentTarget));
      grid.appendChild(card);
    }
    const unsent = list.filter(unsentHere).length;
    // Boards that only exist here for a while: a nudge to send them, or keep a file (the device is their only copy).
    const stale = list.filter((b) => unsentHere(b) && Date.now() - b.modified > 14 * 86400000).length;
    const staleEl = $('#stale');
    staleEl.hidden = !stale;
    if (stale) staleEl.textContent = `${stale === 1 ? 'One board hasn’t' : stale + ' boards haven’t'} been sent for over two weeks. ${stale === 1 ? 'It lives' : 'They live'} only on this device: send ${stale === 1 ? 'it' : 'them'} to your PC, or keep a copy with Share as a file.`;
    let used = '';
    try { const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; if (est && est.usage) used = ` · ${(est.usage / 1048576).toFixed(1)} MB used on this device`; } catch { /* no estimate */ }
    $('#pcBtn').textContent = pc ? (pc.control ? pc.name : `Sends to ${pc.name}`) : 'Connect to your PC';
    $('#controlPc').hidden = !(pc && pc.control);
    $('#fromPc').hidden = !(pc && pc.control);
    $('#sendAll').hidden = !pc || !unsent;
    $('#sendAll').textContent = unsent > 1 ? `Send ${unsent} to PC` : 'Send to PC';
    $('#storage').textContent = list.length ? `${list.length} board${list.length === 1 ? '' : 's'}${unsent ? ` · ${unsent} not sent yet` : ''}${used}` : '';
  }

  // ---------- dialogs ----------
  function ask({ title, text = '', value = null, ok = 'OK', danger = false, cancel = true }) {
    return new Promise((resolve) => {
      const dlg = $('#dialog'), input = $('#dialogInput'), okBtn = $('#dialogOk');
      $('#dialogTitle').textContent = title;
      $('#dialogText').textContent = text;
      input.hidden = value === null;
      input.value = value || '';
      okBtn.textContent = ok;
      okBtn.classList.toggle('danger', danger);
      $('#dialogCancel').hidden = !cancel;
      dlg.hidden = false;
      if (value !== null) setTimeout(() => { input.focus(); input.select(); }, 50);
      const done = (answer) => { dlg.hidden = true; $('#dialogForm').onsubmit = null; $('#dialogCancel').onclick = null; resolve(answer); };
      $('#dialogForm').onsubmit = (e) => { e.preventDefault(); done(value === null ? true : input.value.trim()); };
      $('#dialogCancel').onclick = () => done(null);
    });
  }
  let toastTimer = 0;
  function toast(text, ms = 3500) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- actions ----------
  async function newBoard() {
    const name = await ask({ title: 'New board', text: 'Give it a name you’ll recognise in class.', value: defaultName(), ok: 'Create' });
    if (!name) return;
    const now = Date.now();
    const b = { id: S.newId(), name: name.slice(0, 80), created: now, modified: now, state: { pages: [{ bg: 'white', h: H, doc: null, items: [] }], cur: 0 }, images: {}, thumb: null, sent: null };
    await S.putBoard(b);
    S.keepStorage();
    openBoard(b.id);
  }

  async function importFile(file) {
    try {
      const got = await S.readBoardFile(file);
      const now = Date.now();
      const b = { id: S.newId(), name: got.name, created: now, modified: now, state: got.state, images: got.images, thumb: got.thumb, sent: null };
      if (!b.thumb) b.thumb = await makeThumb(b);
      await S.putBoard(b);
      S.keepStorage();
      await render();
      toast(`Opened “${b.name}” (${b.state.pages.length} page${b.state.pages.length === 1 ? '' : 's'}). It’s saved on this device.`);
    } catch (e) {
      await ask({ title: 'Can’t open that file', text: e.message || String(e), ok: 'OK', cancel: false });
    }
  }

  async function act(action, id) {
    const b = await S.getBoard(id);
    if (!b) return;
    if (action === 'send') send([id]);
    else if (action === 'openpc') send([id], true);
    else if (action === 'open') openBoard(id);
    else if (action === 'rename') {
      const name = await ask({ title: 'Rename board', value: b.name, ok: 'Rename' });
      if (!name) return;
      b.name = name.slice(0, 80);
      b.modified = Date.now();
      await S.putBoard(b);
      await render();
    } else if (action === 'duplicate') {
      const now = Date.now();
      const copy = { ...structuredClone(b), id: S.newId(), name: (b.name + ' (copy)').slice(0, 80), created: now, modified: now, sent: null };
      await S.putBoard(copy);
      await render();
      toast(`Made a copy: “${copy.name}”.`);
    } else if (action === 'share') await S.shareFile(await S.boardFile(b), b.name);
    else if (action === 'delete') {
      const sure = await ask({ title: `Delete “${b.name}”?`, text: b.sent ? 'It was sent to a PC, so that copy stays there.' : 'It hasn’t been sent anywhere: this is the only copy. It can’t be undone.', ok: 'Delete', danger: true });
      if (!sure) return;
      await S.deleteBoard(id);
      await render();
    }
  }

  let menuFor = null;
  function openMenu(id, from) {
    const menu = $('#menu');
    menuFor = id;
    menu.querySelector('[data-act="openpc"]').hidden = !(pc && pc.control);
    menu.hidden = false;
    const r = from.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8))}px`;
  }
  for (const btn of document.querySelectorAll('#menu button')) btn.addEventListener('click', () => { $('#menu').hidden = true; if (menuFor) act(btn.dataset.act, menuFor); });
  document.addEventListener('pointerdown', (e) => { const m = $('#menu'); if (!m.hidden && !m.contains(e.target) && !e.target.closest('.more')) m.hidden = true; }, true);

  // ---------- the classroom PC: pairing (once) and sending ----------
  // Boards go only to a PC paired here (its Remote mode link, and a key that PC gave this device when someone at it
  // clicked Allow). The key can only deliver boards to that PC's Boards list.
  const PC_KEY = 'padlink-go.pc';
  const PCS_KEY = 'padlink-go.pcs';
  const validPc = (v) => !!(v && v.url && v.key);
  const loadPc = () => { try { const v = JSON.parse(localStorage.getItem(PC_KEY) || 'null'); return validPc(v) ? v : null; } catch { return null; } };
  const loadPcs = () => {
    try {
      const all = JSON.parse(localStorage.getItem(PCS_KEY) || '[]');
      return Array.isArray(all) ? all.filter(validPc) : [];
    } catch { return []; }
  };
  let pc = loadPc();
  let pcs = loadPcs();
  // Before multiple-PC support, only the current PC was stored. Keep it as the first remembered PC.
  if (pc && !pcs.some((v) => v.url === pc.url)) pcs.unshift(pc);
  function persistPcs() {
    try {
      if (pc) localStorage.setItem(PC_KEY, JSON.stringify(pc)); else localStorage.removeItem(PC_KEY);
      localStorage.setItem(PCS_KEY, JSON.stringify(pcs));
    } catch { /* private mode */ }
  }
  function usePc(v) {
    pc = v;
    const at = pcs.findIndex((p) => p.url === v.url);
    if (at >= 0) pcs.splice(at, 1);
    pcs.unshift(v);
    persistPcs();
  }
  function savePc(v) {
    if (v) { usePc(v); return; }
    if (pc) pcs = pcs.filter((p) => p.url !== pc.url);
    pc = null;
    persistPcs();
  }
  persistPcs();
  const deviceName = () => (/iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad|Macintosh/.test(navigator.userAgent) ? 'iPad' : 'Device');
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname); // the tests: a PC on this computer

  /** The pairing link (copied from the page the PC's QR code opens): the PC's Remote mode link, a one-time code, its name. */
  function readPairing(text) {
    const m = /(?:[#&?]|^)(?:p|pair)=([A-Za-z0-9_-]+)/.exec(String(text || '').trim());
    if (!m) return null;
    try {
      const info = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
      const url = String(info.u || '').replace(/\/+$/, '');
      const okUrl = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.devtunnels\.ms$/i.test(url) || (local && /^http:\/\/127\.0\.0\.1:\d+$/.test(url));
      if (!okUrl || typeof info.c !== 'string' || !/^[A-Z0-9]{6,16}$/i.test(info.c)) return null;
      return { url, code: info.c, name: String(info.n || 'your PC').slice(0, 40) };
    } catch { return null; }
  }

  class PcError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
  async function call(url, path, body, key) {
    let res;
    try {
      res = await fetch(url + path, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify(body),
      });
    } catch { throw new PcError('unreachable', 'unreachable'); }
    let data = null;
    try { data = await res.json(); } catch { /* no answer body */ }
    if (res.status === 401) throw new PcError('unpaired', 'unpaired');
    if (!res.ok) throw new PcError(String(res.status), (data && data.error) || String(res.status));
    return data;
  }
  const pcName = () => (pc ? pc.name : 'your PC');
  // When a board was last sent to the PC in use (with several PCs paired, each keeps its own). Boards sent before
  // that was kept (no `to`) count as sent to it.
  const sentAt = (b) => (!b.sent ? 0 : !pc || !b.sent.to ? b.sent.at : b.sent.to[pc.url] || 0);
  const unsentHere = (b) => { const at = sentAt(b); return !at || b.modified > at; };
  function explain(e) {
    if (e.kind === 'unreachable') return `Can’t reach ${pcName()}. Check it’s on with PadLink running and Remote mode on, then try again. Nothing is lost: your boards stay here.`;
    if (e.kind === 'unpaired') return `${pcName()} no longer knows this device (it was forgotten there). Connect again: tap “Connect to your PC” at the top.`;
    if (e.kind === '429') return 'Too many tries: wait a minute, then try again.';
    if (e.kind === '413') return 'That board has too many pictures to send in one go.';
    return 'The PC refused that (' + e.message + '). Try again; if it keeps happening, update PadLink on the PC.';
  }

  // The pairing window
  const pairEl = $('#pairDialog');
  function pairView(which, msg = '', good = false) {
    for (const id of ['pairStart', 'pairWait', 'pairDone']) $('#' + id).hidden = id !== which;
    const m = $('#pairMsg');
    m.textContent = msg;
    m.hidden = !msg;
    m.classList.toggle('good', good);
  }
  function openPair() {
    $('#pairInput').value = '';
    if (pc) {
      $('#pairDoneTitle').textContent = pc.control ? `Paired with ${pc.name}` : `Sends to ${pc.name}`;
      $('#pairDoneText').textContent = `Paired ${fmtDate(pc.at)}. ${pc.control ? 'PadLink Go controls this PC and sends it boards' : 'Boards go to the Boards list of PadLink\'s whiteboard on that PC'}, through its Remote mode link. ${pc.control ? '' : 'To control this PC from here too, connect to it again. '}`;
      pairView('pairDone');
    } else {
      pairView('pairStart');
      renderSavedPcs();
    }
    $('#pairControl').hidden = !(pc && pc.control);
    $('#autoControlRow').hidden = !(pc && pc.control);
    $('#autoControl').checked = autoControl();
    pairEl.hidden = false;
  }
  let pairing = 0; // a pairing in progress (its number: closing the window stops it)
  async function pair(text) {
    const info = readPairing(text);
    if (!info) { pairView('pairStart', 'That isn’t a PadLink pairing link. Tap Scan the PC’s code and point at the QR code in PadLink’s window (Remote mode on).'); return; }
    const mine = ++pairing;
    pairView('pairStart', `Asking ${info.name}…`, true);
    try {
      const start = await call(info.url, '/go/pair', { code: info.code, name: deviceName(), want: 'control' });
      if (mine !== pairing) return;
      $('#pairPin').textContent = start.pin;
      pairView('pairWait');
      for (let i = 0; i < 12 && mine === pairing; i++) {
        const w = await call(info.url, '/go/pair/wait', { wait: start.wait });
        if (mine !== pairing) return;
        if (w.status === 'waiting') continue;
        if (w.status === 'allowed') {
          savePc({ url: info.url, key: w.key, name: w.pc || info.name, at: Date.now(), control: !!w.control, version: w.version || '' });
          await render();
          openPair();
          $('#autoControlRow').hidden = !w.control;
          $('#autoControl').checked = autoControl();
          pairView('pairDone', w.control ? `Paired with ${pcName()} ✓ Tap Control the PC whenever you want to control it.` : `Paired with ${pcName()}. Tap Send to PC on a board (or Send to PC at the top for all of them).`, true);
          return;
        }
        pairView('pairStart', w.status === 'declined' ? 'The PC said Not now. Try again with a new code.' : w.status === 'blocked' ? 'The PC blocked this device for a few minutes.' : 'Nobody clicked Allow in time. On the PC, tap New code, then copy and paste again.');
        return;
      }
      pairView('pairStart', 'Nobody clicked Allow in time. On the PC, tap New code, then copy and paste again.');
    } catch (e) {
      if (mine !== pairing) return;
      pairView('pairStart', e.kind === '403' ? 'That code didn’t work: it works once, for 10 minutes. On the PC, tap New code, then copy and paste again.' : e.kind === 'unreachable' ? `Can’t reach ${info.name}. Is PadLink running there with Remote mode on?` : explain(e));
    }
  }
  $('#pcBtn').addEventListener('click', openPair);
  $('#pairClose').addEventListener('click', () => { pairing++; stopScan(); pairEl.hidden = true; });
  $('#pairControl').addEventListener('click', () => { pairEl.hidden = true; openControl(false); });
  $('#pairAnother').addEventListener('click', () => {
    pairing++;
    stopScan();
    pairView('pairStart');
    renderSavedPcs();
  });

  function renderSavedPcs() {
    const box = $('#pairSaved'), list = $('#pairSavedList');
    const saved = pcs.filter((p) => !pc || p.url !== pc.url);
    box.hidden = saved.length === 0;
    list.innerHTML = '';
    for (const savedPc of saved) {
      const b = document.createElement('button');
      b.className = 'btn';
      const name = document.createElement('b');
      name.textContent = savedPc.name || 'PC';
      const detail = document.createElement('small');
      detail.textContent = `Paired ${fmtDate(savedPc.at)} · Tap to use this PC`;
      b.append(name, detail);
      b.addEventListener('click', async () => {
        usePc(savedPc);
        await render();
        openPair();
      });
      list.appendChild(b);
    }
  }

  // Scanning the PC's QR code with this device's camera (stage 9): jsQR (in jsqr/, on this site) reads it here.
  let scanStream = null, scanTimer = 0;
  function stopScan() {
    clearTimeout(scanTimer);
    if (scanStream) for (const t of scanStream.getTracks()) t.stop();
    scanStream = null;
    $('#scanVideo').srcObject = null;
    $('#scanBox').hidden = true;
    $('#pairScan').hidden = false;
  }
  async function startScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.jsQR) {
      pairView('pairStart', 'This device can’t scan here. Use “Have a pairing link instead?” below.');
      return;
    }
    try { scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
    catch (e) {
      pairView('pairStart', e && e.name === 'NotAllowedError'
        ? 'PadLink Go needs the camera to scan the PC’s code. Tap Scan again and choose Allow (if it doesn’t ask: Settings → Apps → Safari → Camera → Ask).'
        : 'The camera isn’t available right now.');
      return;
    }
    const video = $('#scanVideo');
    video.srcObject = scanStream;
    $('#scanBox').hidden = false;
    $('#pairScan').hidden = true;
    $('#scanHint').textContent = 'Point at the QR code in PadLink’s window';
    try { await video.play(); } catch { /* it plays once it can */ }
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const look = () => {
      if (!scanStream) return;
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        const k = Math.min(1, 800 / Math.max(w, h));
        canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        const found = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (found && found.data) {
          if (readPairing(found.data)) { stopScan(); pair(found.data); return; }
          $('#scanHint').textContent = 'That’s not PadLink’s code. Point at the QR code in PadLink’s window on the PC.';
        }
      }
      scanTimer = setTimeout(look, 150);
    };
    look();
  }
  $('#pairScan').addEventListener('click', startScan);
  $('#pairPaste').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* not allowed: the box below works too */ }
    if (!text) { pairView('pairStart', 'Nothing to paste yet. Copy the link first (step 2), or long-press the box and tap Paste.'); $('#pairInput').focus(); return; }
    pair(text);
  });
  $('#pairInput').addEventListener('input', (e) => { if (readPairing(e.target.value)) pair(e.target.value); });
  $('#pairCheck').addEventListener('click', async () => {
    try { const r = await call(pc.url, '/go/check', {}, pc.key); pairView('pairDone', `Connected to ${r.pc || pcName()} ✓`, true); }
    catch (e) {
      const message = explain(e);
      if (e.kind === 'unpaired') { savePc(null); render(); }
      pairView(e.kind === 'unpaired' ? 'pairStart' : 'pairDone', message);
      if (e.kind === 'unpaired') renderSavedPcs();
    }
  });
  $('#pairForget').addEventListener('click', async () => {
    const was = pc;
    if (!was) return;
    // Let go locally first. An offline PC must not leave this button looking broken while fetch waits to time out.
    savePc(null);
    await render();
    pairView('pairStart', `Forgot ${was.name}.`, true);
    renderSavedPcs();
    call(was.url, '/go/forget', {}, was.key).catch(() => { /* the PC's list can forget it too */ });
  });

  // Sending: the pictures the PC doesn't have yet, then the board. Marked Sent only once the PC has saved it.
  let sending = false;
  async function sendBoard(id, n, of, open = false) {
    const b = await S.getBoard(id);
    if (!b) return null;
    const label = of > 1 ? ` (${n} of ${of})` : '';
    const badge = document.querySelector(`.card[data-id="${CSS.escape(id)}"] .badge`);
    if (badge) { badge.textContent = 'Sending…'; badge.className = 'badge sending'; }
    toast(`Sending “${b.name}”${label}…`, 60000);
    const have = new Set(((await call(pc.url, '/go/have', { board: b.id }, pc.key)).images || []).map(Number));
    const missing = Object.keys(b.images || {}).filter((k) => !have.has(Number(k)));
    let i = 0;
    for (const k of missing) {
      toast(`Sending “${b.name}”${label}: picture ${++i} of ${missing.length}…`, 60000);
      await call(pc.url, '/go/image', { board: b.id, id: Number(k), url: b.images[k] }, pc.key);
    }
    toast(`Sending “${b.name}”${label}: its pages…`, 60000);
    const r = await call(pc.url, '/go/board', { board: b.id, name: b.name, state: b.state, thumb: b.thumb, open }, pc.key);
    const now = await S.getBoard(id);
    if (now) {
      const at = Math.max(Date.now(), now.modified + 1);
      now.sent = { at, pc: r.pc || pcName(), id: r.id, copy: !!r.copy, to: { ...((now.sent && now.sent.to) || {}), [pc.url]: at } };
      await S.putBoard(now);
    }
    return r;
  }
  async function send(ids, open = false) {
    if (!pc) { openPair(); return; }
    if (sending || !ids.length) return;
    sending = true;
    $('#sendAll').disabled = true;
    let done = 0, copies = 0;
    try {
      for (const id of ids) {
        const r = await sendBoard(id, done + 1, ids.length, open);
        if (r) { done++; if (r.copy) copies++; }
      }
      toast(open ? `Sent ✓ It’s open on ${pcName()}’s whiteboard.` : done === 1 ? `Sent to ${pcName()} ✓ It’s in the whiteboard’s Boards list.` : `Sent ${done} boards to ${pcName()} ✓`, 5000);
      if (copies) setTimeout(() => toast(`${copies === 1 ? 'One was' : copies + ' were'} changed on the PC since last time, so ${copies === 1 ? 'it' : 'they'} arrived as a copy there: nothing on the PC was replaced.`, 8000), 5200);
    } catch (e) {
      const why = explain(e); // (says which PC, before a forgotten one is let go)
      toast('', 1);
      if (e.kind === 'unpaired') { savePc(null); await render(); }
      await ask({ title: done ? `Sent ${done}, then stopped` : 'Not sent', text: why, ok: 'OK', cancel: false });
    } finally {
      sending = false;
      $('#sendAll').disabled = false;
      await render();
    }
  }
  // ---------- controlling the PC (stage 8): the iPad's own PadLink page, inside PadLink Go ----------
  const MIN_PC = [0, 41, 0]; // the first PadLink that lets PadLink Go control it
  const atLeast = (v, min) => {
    const n = String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((n[i] || 0) !== min[i]) return (n[i] || 0) > min[i]; }
    return true;
  };
  /** Checks the PC is there (and new enough), then opens the control screen. quiet: on opening the app. */
  async function openControl(quiet) {
    if (!pc || !pc.control) return;
    if (!quiet) toast(`Connecting to ${pcName()}…`, 8000);
    try {
      const r = await Promise.race([
        call(pc.url, '/go/check', {}, pc.key),
        new Promise((_, no) => setTimeout(() => no(new PcError('unreachable', 'timeout')), quiet ? 2500 : 6000)),
      ]);
      if (!atLeast(r.version, MIN_PC)) {
        toast('', 1);
        await ask({ title: 'Update PadLink on the PC', text: `${pcName()} has PadLink ${r.version || 'from before 0.39'}. Controlling it from PadLink Go needs PadLink 0.41 or newer: on the PC, Settings → General → Check for updates. Sending boards works already.`, ok: 'OK', cancel: false });
        return;
      }
      location.href = 'control.html';
    } catch (e) {
      if (e.kind === 'unpaired') { savePc(null); await render(); }
      if (quiet) toast(`${pcName()} isn’t reachable right now: here are your boards.`, 4000);
      else { toast('', 1); await ask({ title: 'Can’t connect', text: explain(e), ok: 'OK', cancel: false }); }
    }
  }
  $('#controlPc').addEventListener('click', () => openControl(false));
  /** The teacher's switch: open on the PC by itself when PadLink Go starts (off unless they turn it on). */
  function autoControl() { try { return localStorage.getItem('padlink-go.autoControl') === '1'; } catch { return false; } }
  $('#autoControl').addEventListener('change', (e) => { try { localStorage.setItem('padlink-go.autoControl', e.target.checked ? '1' : '0'); } catch { /* fine */ } });

  // ---------- the PC's boards: keep a copy here (stage 8e) ----------
  async function openFromPc() {
    const list = $('#fromPcList');
    list.innerHTML = '<div class="empty">Getting the boards from the PC…</div>';
    $('#fromPcDialog').hidden = false;
    try {
      const r = await call(pc.url, '/go/list', {}, pc.key);
      list.textContent = '';
      if (!r.boards || !r.boards.length) { list.innerHTML = '<div class="empty">No boards on the PC yet.</div>'; return; }
      for (const b of r.boards) {
        const row = document.createElement('button');
        const img = document.createElement('img');
        img.alt = '';
        if (b.thumb) img.src = b.thumb;
        const text = document.createElement('span');
        const name = document.createElement('b');
        name.textContent = b.name;
        const meta = document.createElement('small');
        meta.textContent = `${b.pages} page${b.pages === 1 ? '' : 's'} · ${b.modified}`;
        text.append(name, meta);
        row.append(img, text);
        row.addEventListener('click', () => copyFromPc(b));
        list.appendChild(row);
      }
    } catch (e) {
      if (e.kind === 'unpaired') { savePc(null); render(); }
      list.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'empty';
      msg.textContent = e.kind === '403' ? 'Connect again to see the PC’s boards (forget the PC, then Connect to your PC).' : explain(e);
      list.appendChild(msg);
    }
  }
  async function copyFromPc(item) {
    toast(`Copying “${item.name}” from ${pcName()}…`, 60000);
    try {
      const d = await call(pc.url, '/go/get', { id: item.id }, pc.key);
      const now = Date.now();
      const state = d.state && Array.isArray(d.state.pages) && d.state.pages.length ? d.state : { pages: [{ bg: 'white', h: 1080, doc: null, items: [] }], cur: 0 };
      await S.putBoard({ id: S.newId(), name: String(d.name || item.name).slice(0, 80), created: now, modified: now, state, images: d.images || {}, thumb: item.thumb || null, sent: { at: now + 1, pc: pcName(), id: item.id, fromPc: true, to: { [pc.url]: now + 1 } } });
      S.keepStorage();
      $('#fromPcDialog').hidden = true;
      await render();
      toast(`“${item.name}” is on this device now. Change it anywhere; Send to PC adds your version to the PC.`, 6000);
    } catch (e) {
      toast('', 1);
      await ask({ title: 'Not copied', text: explain(e), ok: 'OK', cancel: false });
    }
  }
  $('#fromPc').addEventListener('click', openFromPc);
  $('#fromPcClose').addEventListener('click', () => { $('#fromPcDialog').hidden = true; });

  $('#sendAll').addEventListener('click', async () => {
    const list = (await S.allBoards()).filter(unsentHere).sort((a, b) => a.modified - b.modified);
    send(list.map((b) => b.id));
  });

  // ---------- buttons ----------
  $('#helpOpen').addEventListener('click', () => { $('#helpDialog').hidden = false; });
  // iPhone: From the PC, Open a board file and the help live in ⋯ (the top bar has room for the main ones only).
  $('#moreBtn').addEventListener('click', (e) => {
    const menu = $('#headMenu');
    if (!menu.hidden) { menu.hidden = true; return; }
    menu.querySelector('[data-head="frompc"]').hidden = !(pc && pc.control);
    menu.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.bottom + 6}px`;
  });
  for (const b of document.querySelectorAll('#headMenu button')) b.addEventListener('click', () => {
    $('#headMenu').hidden = true;
    if (b.dataset.head === 'frompc') openFromPc();
    else if (b.dataset.head === 'openfile') $('#fileInput').click();
    else $('#helpDialog').hidden = false;
  });
  document.addEventListener('pointerdown', (e) => { const m = $('#headMenu'); if (!m.hidden && !m.contains(e.target) && e.target.id !== 'moreBtn') m.hidden = true; }, true);
  $('#helpClose').addEventListener('click', () => { $('#helpDialog').hidden = true; });
  $('#newBoard').addEventListener('click', newBoard);
  $('#openFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) await importFile(f);
  });
  window.PadLinkGo = { ...S, render }; // for the tests

  // ---------- installed and offline ----------
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) $('#install').hidden = false;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (w) => { if (!w || !navigator.serviceWorker.controller) return; $('#updateReady').hidden = false; $('#restart').onclick = () => w.postMessage('activate'); };
      offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
      });
      // iPadOS and iOS bring the Home Screen app back from the background without loading it again (so without the
      // browser's own check): look for a new version each time it comes back, at most once a minute.
      let lastCheck = Date.now();
      const check = () => {
        if (Date.now() - lastCheck < 60000) return;
        lastCheck = Date.now();
        reg.update().then(() => offer(reg.waiting)).catch(() => { /* offline: next time */ });
      };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      addEventListener('pageshow', (e) => { if (e.persisted) check(); });
      window.GoUpdate = { forget: () => { lastCheck = 0; } }; // for the tests: as if the last check was long ago
    }).catch((e) => console.warn('Offline helper not installed', e));
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && !$('#updateReady').hidden) { reloaded = true; location.reload(); } });
  }

  // Coming back from a board (the browser may show this page from its memory): show the latest.
  addEventListener('pageshow', (e) => { if (e.persisted) render(); });
  // Back from the control screen (or a fresh launch): stay on the boards. Only with the teacher's switch on does a fresh
  // launch go on to the PC by itself (when it can reach it).
  let backWhy = null, stay = false;
  try { backWhy = sessionStorage.getItem('padlink-go.back'); sessionStorage.removeItem('padlink-go.back'); stay = sessionStorage.getItem('padlink-go.stay') === '1'; } catch { /* fine */ }
  if (backWhy === 'forgotten') setTimeout(() => toast('That PC forgot this device. Connect again: tap Connect to your PC at the top.', 7000), 300);
  else if (backWhy === 'disconnected') setTimeout(() => toast(`Disconnected from ${pcName()}. It's still paired: tap Control the PC to connect again.`, 6000), 300);
  else if (!stay && !/[#&]pair=/.test(location.hash) && pc && pc.control && autoControl()) openControl(true);
  try { sessionStorage.setItem('padlink-go.stay', '1'); } catch { /* fine */ } // once per launch

  // Opened from the pairing page in Safari ("Pair it here"): pair this copy of PadLink Go.
  if (/[#&]pair=/.test(location.hash)) {
    const link = location.hash;
    history.replaceState(null, '', location.pathname);
    openPair();
    pair(link);
  }

  render().catch((e) => toast('This device’s storage isn’t available here: ' + (e.message || e), 8000));
})();
