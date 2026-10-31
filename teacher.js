// PadLink: the teacher's grid of student boards. Each student's Chromebook sends a small picture of the page it's on
// with every save; the grid shows them all, live. A tap looks closely at one student's board (all its pages, drawn here
// with the whiteboard's own engine, engine.js), also live. Opened on the PC (its own window) or the iPad/iPhone (Class
// tools → Students), with this run's teacher key in the address.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const key = new URLSearchParams(location.search).get('k') || '';
  const host = window.chrome && window.chrome.webview;   // the PC window
  const embedded = window.parent !== window;              // inside the pad

  let ws = null;
  let roster = { open: false, students: [], waiting: 0, following: false };
  const thumbs = new Map();       // key -> data URL
  const cards = new Map();        // key -> card element
  let closer = null;              // { key, state, page } while looking closely
  const images = new Map();       // "key/id" -> Image
  const imageUrls = new Map();    // "key/id" -> data URL (for the whiteboard, when writing on a board)

  // ---------- connection ----------
  function connect() {
    // On the PC (or its page): this page's own address. In PadLink Go: the paired PC's Remote mode address (grid-host.js).
    const base = window.PADLINK_GRID_BASE || `${location.protocol}//${location.host}`;
    ws = new WebSocket(`${base.replace(/^http/, 'ws')}/teacher/ws?k=${encodeURIComponent(key)}`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'roster') { roster = m; render(); }
      else if (m.t === 'thumb') onThumb(m);
      else if (m.t === 'board') onBoard(m);
      else if (m.t === 'marked') { onMarked(m); toMarking({ type: 'marked', ref: m.ref, tid: m.tid }); }
    };
    ws.onopen = () => { if (closer) send({ t: 'watch', key: closer.key }); };
    ws.onclose = () => {
      $('#summary').textContent = 'Reconnecting to the PC…';
      setTimeout(connect, 1500);
    };
  }
  const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

  // ---------- the grid ----------
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 20 ? 'just now' : s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : 'a while ago';
  };

  function render() {
    const list = roster.students || [];
    const kids = list.filter((s) => !s.team); // team boards have cards too, first
    const on = kids.filter((s) => s.connected).length;
    $('#summary').textContent = !roster.open ? 'No class open'
      : `${roster.name} · ${kids.length} in the class · ${on} connected` + (roster.teamBoards ? ' · team boards on' : '');
    $('#waiting').hidden = !roster.waiting;
    $('#waiting').textContent = roster.waiting === 1 ? '1 waiting · Let in' : `${roster.waiting} waiting · Let them in`;
    for (const b of document.querySelectorAll('#see button')) {
      const pick = (b.dataset.follow === '1') === !!roster.following;
      b.classList.toggle('on', pick);
      b.setAttribute('aria-checked', String(pick));
    }
    $('#see').hidden = !roster.open;
    const onShow = list.find((s) => s.key === roster.shown);
    $('#onShow').hidden = !onShow;
    if (onShow) $('#onShow').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/></svg><span></span>`, $('#onShow').querySelector('span').textContent = `${onShow.name} on the whiteboard · Stop`;

    const empty = !roster.open || !kids.length;
    $('#empty').hidden = !empty;
    if (empty) {
      $('#emptyTitle').textContent = roster.open ? 'Nobody’s in yet' : 'No class is open';
      $('#emptyText').textContent = roster.open
        ? 'Students join with the code in the Students window. Their boards show up here as they work.'
        : 'Open the class in Class tools → Students, on the whiteboard or the iPad.';
    }

    const grid = $('#grid');
    const keep = new Set(list.map((s) => s.key));
    for (const [k, el] of cards) if (!keep.has(k)) { el.remove(); cards.delete(k); }
    list.forEach((s, i) => {
      let el = cards.get(s.key);
      if (!el) {
        el = document.createElement('button');
        el.className = 'card';
        el.innerHTML = '<div class="thumb"><span class="none">Nothing yet</span></div><div class="info"><span class="dot"></span><span class="name"></span><span class="meta"></span><span class="badge">On the whiteboard</span></div>';
        el.addEventListener('click', () => openCloser(el.dataset.key));
        cards.set(s.key, el);
      }
      el.dataset.key = s.key;
      el.classList.toggle('away', !s.connected);
      el.classList.toggle('onshow', s.key === roster.shown);
      el.classList.toggle('team', !!s.team);
      el.querySelector('.name').textContent = s.name;
      el.querySelector('.meta').textContent = s.team ? (s.members || []).join(', ')
        : !s.connected ? 'Not connected' : s.pages > 1 ? `Page ${s.cur + 1} of ${s.pages}` : ago(s.updated);
      el.title = s.team ? `${s.name}'s board (${(s.members || []).join(', ')}): tap to look closer`
        : `${s.name}${s.connected ? '' : ' (not connected)'}: tap to look closer`;
      setThumb(el, thumbs.get(s.key));
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    });
    if (closer) renderCloserBar();
  }

  function setThumb(el, url) {
    const box = el.querySelector('.thumb');
    let img = box.querySelector('img');
    if (!url) return;
    if (!img) { box.innerHTML = ''; img = document.createElement('img'); img.alt = ''; box.appendChild(img); }
    if (img.src !== url) img.src = url;
  }

  function onThumb(m) {
    const changed = thumbs.has(m.key) && thumbs.get(m.key) !== m.thumb;
    thumbs.set(m.key, m.thumb);
    const s = (roster.students || []).find((x) => x.key === m.key);
    if (s) { s.pages = m.pages; s.cur = m.cur; s.updated = m.updated; }
    const el = cards.get(m.key);
    if (!el) return;
    setThumb(el, m.thumb);
    if (changed) { el.classList.remove('fresh'); void el.offsetWidth; el.classList.add('fresh'); } // a blue flash: just changed
    render();
  }
  setInterval(() => { if (!closer) render(); }, 20000); // "just now" → "2 min ago"

  // ---------- one board, close up ----------
  const pageCanvas = $('#page');
  PadEngine.configure({ image: (id) => (closer ? images.get(closer.key + '/' + id) || null : null) });

  function openCloser(k) {
    if (!k) return;
    setMarking(false);
    closer = { key: k, state: null, page: null, pending: [], local: [], erased: new Set(), mine: [], drawing: null };
    $('#closer').hidden = false;
    $('#cWait').hidden = false;
    pageCanvas.style.visibility = 'hidden';
    renderCloserBar();
    send({ t: 'watch', key: k });
  }
  function closeCloser() {
    $('#whoPop').hidden = true;
    setWriting(false);
    setMarking(false);
    closer = null;
    $('#closer').hidden = true;
    send({ t: 'watch', key: null });
    render();
  }

  function onBoard(m) {
    if (!closer || m.key !== closer.key) return;
    const loads = Object.entries(m.images || {}).map(([id, url]) => new Promise((done) => {
      const img = new Image();
      img.onload = img.onerror = done;
      img.src = url;
      images.set(m.key + '/' + id, img);
      imageUrls.set(m.key + '/' + id, url);
    }));
    Promise.all(loads).then(() => {
      if (!closer || m.key !== closer.key) return;
      const first = !closer.state;
      closer.state = m.state || { pages: [], cur: 0 };
      closer.pending = m.pending || [];
      closer.owners = m.owners || null; // a team board: who made each mark (shown when a mark is tapped)
      // My marks the board (or the PC) has now are drawn from there, not from here.
      const known = new Set(closer.pending.map((op) => op.tid));
      for (const p of closer.state.pages) for (const it of p.items || []) if (it.tid) known.add(it.tid);
      closer.local = closer.local.filter((l) => !l.tid || !known.has(l.tid));
      // Follow the student to the page they're on (unless the teacher is looking at another of their pages).
      const n = closer.state.pages.length;
      if (first || closer.page == null || closer.followCur) { closer.page = closer.state.cur || 0; closer.followCur = true; }
      closer.page = Math.max(0, Math.min(n - 1, closer.page));
      drawCloser();
      if (marking.frame && marking.loaded) toMarking({ type: 'others', pages: closer.state.pages, images: urlsFor(closer.key) });
      else if (marking.frame && marking.ready) loadMarking();
    });
  }

  function students() { return roster.students || []; }
  function renderCloserBar() {
    const list = students();
    const i = list.findIndex((s) => s.key === closer.key);
    const s = list[i];
    $('#cName').textContent = s ? s.name : '';
    $('#cDot').classList.toggle('away', !s || !s.connected);
    const n = closer.state ? closer.state.pages.length : 0;
    $('#pNo').textContent = n ? `Page ${closer.page + 1} of ${n}` + (closer.state.cur === closer.page ? '' : ' (they’re on ' + (closer.state.cur + 1) + ')') : '';
    $('#pPrev').disabled = !n || closer.page <= 0;
    $('#pNext').disabled = !n || closer.page >= n - 1;
    const prev = list[i - 1], next = list[i + 1];
    $('#sPrev').disabled = !prev;
    $('#sNext').disabled = !next;
    $('#sPrevName').textContent = prev ? prev.name : '';
    const showing = roster.shown === closer.key;
    $('#showBtn').setAttribute('aria-pressed', String(showing));
    $('#showLabel').textContent = showing ? 'Stop showing' : 'Show to class';
    $('#showNameBox').hidden = !showing;
    $('#showDrawBox').hidden = !showing;
    if (showing && roster.shownNamed != null) $('#showName').checked = !!roster.shownNamed;
    if (showing && roster.shownDraw != null) $('#showDraw').checked = !!roster.shownDraw;
    $('#sNextName').textContent = next ? next.name : '';
    // A team board: its members, each drawing or view only (tap to switch).
    const box = $('#cMembers');
    box.hidden = !(s && s.team);
    if (s && s.team) {
      const only = new Set(s.viewOnly || []);
      box.textContent = '';
      const label = document.createElement('span');
      label.className = 'members-label';
      label.textContent = 'Can draw:';
      box.appendChild(label);
      for (const name of s.members || []) {
        const b = document.createElement('button');
        const off = only.has(name);
        b.className = 'member' + (off ? ' off' : '');
        b.textContent = off ? `${name} · view only` : name;
        b.title = off ? `${name} can only watch the team board: tap to let them draw again` : `Tap to make the team board view only for ${name}`;
        b.addEventListener('click', () => send({ t: 'viewOnly', name, on: !off }));
        box.appendChild(b);
      }
    }
  }

  function drawCloser() {
    if (!closer || !closer.state) return;
    renderCloserBar();
    const p = closer.state.pages[closer.page];
    $('#cWait').hidden = !!p;
    $('#cWait').textContent = 'Nothing on this board yet.';
    if (!p) return;
    const stage = $('#stage');
    const cs = getComputedStyle(stage);
    const room = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const roomH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // The page's top part (16:9) fits the screen; a taller page scrolls.
    const w = Math.max(200, Math.min(room, roomH * PadEngine.W / PadEngine.H));
    const k = w / PadEngine.W;
    const h = (p.h || PadEngine.H) * k;
    const dpr = window.devicePixelRatio || 1;
    pageCanvas.style.width = `${w}px`;
    pageCanvas.style.height = `${h}px`;
    pageCanvas.width = Math.round(w * dpr);
    pageCanvas.height = Math.round(h * dpr);
    const ctx = pageCanvas.getContext('2d');
    ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    PadEngine.renderPage(ctx, { bg: p.bg || 'white', h: p.h || PadEngine.H, doc: p.doc, items: itemsOn(closer.page) });
    closer.k = k;
    pageCanvas.style.visibility = 'visible';
  }

  /** What's on one of the student's pages here: theirs, and my marks (on their way, or just drawn), minus ones I took back. */
  function itemsOn(i) {
    const p = closer.state.pages[i];
    const shown = (p.items || []).filter((it) => !it.tid || !closer.erased.has(it.tid));
    const have = new Set(shown.map((it) => it.tid).filter(Boolean));
    for (const op of closer.pending) {
      if (op.op === 'add' && Math.min(op.page, closer.state.pages.length - 1) === i && !have.has(op.tid) && !closer.erased.has(op.tid)) { shown.push(op.item); have.add(op.tid); }
    }
    for (const l of closer.local) if (l.page === i && !(l.tid && (have.has(l.tid) || closer.erased.has(l.tid)))) shown.push(l.item);
    if (closer.drawing && closer.drawing.page === i) shown.push(closer.drawing.item);
    return shown;
  }

  // ---------- writing on the student's board ----------
  const write = { on: false, color: '#e03131', tool: 'pen' };
  function setWriting(on) {
    write.on = on;
    $('#closer').classList.toggle('writing', on);
    $('#wTools').hidden = !on;
    $('#wToggle').setAttribute('aria-pressed', String(on));
    updateUndo();
  }
  function pickTool(mark) {
    if (mark === 'hl' || mark === 'erase') write.tool = write.tool === mark ? 'pen' : mark;
    else { write.color = mark; write.tool = 'pen'; }
    for (const b of document.querySelectorAll('#wTools [data-mark]')) {
      const m = b.dataset.mark;
      b.classList.toggle('on', m === write.tool || (write.tool === 'pen' && m === write.color));
    }
  }
  function updateUndo() { $('#wUndo').disabled = !closer || !closer.mine.some((t) => !closer.erased.has(t)); }

  /** A point on the page (page units, with pressure) from a pointer event. */
  function pagePoint(e) {
    const r = pageCanvas.getBoundingClientRect(), k = r.width / PadEngine.W;
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return [Math.round(((e.clientX - r.left) / k) * 100) / 100, Math.round(((e.clientY - r.top) / k) * 100) / 100, pressure];
  }

  let frame = 0;
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawCloser(); }); };

  // A team board: tap a mark (not writing) to see who made it, and remove it if needed.
  function whoAt(e) {
    const pop = $('#whoPop');
    if (!closer || !closer.owners || write.on) { pop.hidden = true; return false; }
    const pt = pagePoint(e), r = 12 / (closer.k || 1);
    const hit = itemsOn(closer.page).slice().reverse().find((it) => it.tid && PadEngine.hits(it, pt[0], pt[1], r));
    if (!hit) { pop.hidden = true; return true; }
    $('#whoName').textContent = closer.owners[hit.tid] ? `By ${closer.owners[hit.tid]}` : 'By someone who left';
    const stage = $('#stage'), sr = stage.getBoundingClientRect();
    pop.style.left = `${e.clientX - sr.left + stage.scrollLeft}px`;
    pop.style.top = `${e.clientY - sr.top + stage.scrollTop + 12}px`;
    pop.hidden = false;
    $('#whoRemove').onclick = () => {
      pop.hidden = true;
      closer.erased.add(hit.tid);
      send({ t: 'teamRemove', tid: hit.tid });
      redraw();
    };
    return true;
  }
  pageCanvas.addEventListener('pointerdown', (e) => {
    if (!write.on && whoAt(e)) return;
    if (!write.on || !closer || !closer.state || !closer.state.pages[closer.page]) return;
    e.preventDefault();
    try { pageCanvas.setPointerCapture(e.pointerId); } catch { /* keeps working without it */ }
    const pt = pagePoint(e);
    if (write.tool === 'erase') { closer.drawing = { erase: true }; eraseAt(pt); return; }
    const hl = write.tool === 'hl';
    const item = { type: 'stroke', tool: hl ? 'highlighter' : 'pen', color: hl ? '#fcc419' : write.color, size: hl ? PadEngine.SIZES.highlighter[1] : PadEngine.SIZES.pen[1], pts: [pt] };
    if (!hl) item.medium = 'pen';
    closer.drawing = { page: closer.page, item };
    redraw();
  });
  pageCanvas.addEventListener('pointermove', (e) => {
    if (!closer || !closer.drawing) return;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const pts = list && list.length ? list : [e]; // (some browsers give none)
    if (closer.drawing.erase) { for (const c of pts) eraseAt(pagePoint(c)); return; }
    for (const c of pts) closer.drawing.item.pts.push(pagePoint(c));
    redraw();
  });
  const endStroke = () => {
    if (!closer || !closer.drawing) return;
    const d = closer.drawing;
    closer.drawing = null;
    if (d.erase) return;
    if (d.item.pts.length === 1) d.item.pts.push([d.item.pts[0][0] + 0.5, d.item.pts[0][1], d.item.pts[0][2]]); // a dot
    const ref = Math.random().toString(36).slice(2);
    closer.local.push({ ref, page: d.page, item: d.item });
    send({ t: 'mark', ref, page: d.page, item: d.item });
    redraw();
  };
  pageCanvas.addEventListener('pointerup', endStroke);
  pageCanvas.addEventListener('pointercancel', endStroke);

  function onMarked(m) {
    if (!closer) return;
    const l = closer.local.find((x) => x.ref === m.ref);
    if (l) { l.tid = m.tid; l.item.tid = m.tid; l.item.by = 'teacher'; }
    closer.mine.push(m.tid);
    updateUndo();
  }

  /** The eraser: takes away my marks under it (never the student's own work). */
  function eraseAt(pt) {
    const r = 14 / (closer.k || 1);
    for (const it of itemsOn(closer.page)) {
      if (it.by !== 'teacher' || !it.tid || closer.erased.has(it.tid)) continue;
      if (PadEngine.hits(it, pt[0], pt[1], r)) takeBack(it.tid);
    }
  }
  function takeBack(tid) {
    closer.erased.add(tid);
    send({ t: 'mark', op: 'erase', tid });
    updateUndo();
    redraw();
  }

  // ---------- writing on the student's board with every whiteboard tool ----------
  // Write opens the whiteboard itself (in marking mode: /teacher/mark, with mark-host.js) over the student's board: pens,
  // highlighter, shapes, lines, text and math, sticky notes, eraser, Select and Undo, for the teacher's own marks. The
  // student's work is locked there. Each mark goes to the PC as it's made (and changed, or taken back), and from there
  // to the student, who sees it straight away. Their work keeps coming in while the teacher writes.
  const marking = { frame: null, origin: '', ready: false, loaded: false };
  const markBase = () => window.PADLINK_GRID_BASE || `${location.protocol}//${location.host}`;

  function urlsFor(k) {
    const out = {};
    for (const [id, url] of imageUrls) if (id.startsWith(k + '/')) out[id.slice(k.length + 1)] = url;
    return out;
  }
  function toMarking(msg) {
    if (marking.frame && marking.frame.contentWindow && marking.origin) marking.frame.contentWindow.postMessage({ padlinkMark: 1, ...msg }, marking.origin);
  }
  function loadMarking() {
    if (!closer || !closer.state) return;
    const s = students().find((x) => x.key === closer.key);
    // The board as it is here: theirs, with my marks on their way too.
    const pages = closer.state.pages.map((p, i) => ({ ...p, items: itemsOn(i) }));
    toMarking({ type: 'load', name: s ? s.name : 'Student board', state: { pages, cur: closer.state.cur || 0 }, page: closer.page, images: urlsFor(closer.key) });
    marking.loaded = true;
  }
  function setMarking(on) {
    if (on === !!marking.frame) return;
    const btn = $('#wToggle');
    if (on) {
      if (!closer) return;
      const f = document.createElement('iframe');
      f.className = 'mark-frame';
      f.title = 'Writing on the student’s board';
      f.allow = 'clipboard-read; clipboard-write';
      // From the PC (or its pad page): the PC's marking page. In PadLink Go: Go's own copy (mark.html), beside this
      // grid page, since a page from Remote mode's address can't open inside Go (its rules and Microsoft's notice).
      const inGo = !!window.PADLINK_GRID_BASE;
      f.src = inGo ? new URL('mark.html', location.href).href : markBase() + '/teacher/mark';
      marking.origin = new URL(f.src).origin;
      marking.ready = marking.loaded = false;
      marking.frame = f;
      $('#closer').appendChild(f);
    } else {
      marking.frame.remove();
      marking.frame = null;
      marking.ready = marking.loaded = false;
      if (closer) { drawCloser(); send({ t: 'watch', key: closer.key }); } // the board as the PC has it now, with my marks
    }
    $('#closer').classList.toggle('marking', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('span').textContent = on ? 'Done writing' : 'Write';
  }
  window.addEventListener('message', (e) => {
    if (!marking.frame || e.source !== marking.frame.contentWindow || e.origin !== marking.origin || !e.data || !e.data.padlinkMark) return;
    const m = e.data;
    if (m.type === 'ready') { marking.ready = true; loadMarking(); }
    else if (m.type === 'mark' && closer) {
      const msg = { t: 'mark', op: m.op, page: m.page };
      if (m.ref) msg.ref = m.ref;
      if (m.tid) msg.tid = m.tid;
      if (m.item) msg.item = m.item;
      if (m.op === 'erase' && m.tid) closer.erased.add(m.tid);
      send(msg);
    }
  });

  // ---------- showing this board to the class (on the whiteboard) ----------
  /** Show the board I'm looking at, on the page I'm looking at (or the one they're on, while I follow them). */
  function sendShow(draw) {
    if (!closer) return;
    const msg = { t: 'show', key: closer.key, page: closer.followCur ? null : closer.page, named: $('#showName').checked };
    // Let them draw: off when a board goes on show; the switch alone changes it (kept as it is when the page or name changes).
    if (draw !== undefined) msg.draw = draw;
    else if (roster.shown === closer.key) msg.draw = $('#showDraw').checked;
    send(msg);
  }
  $('#showBtn').addEventListener('click', () => {
    if (!closer) return;
    if (roster.shown === closer.key) send({ t: 'show', key: null });
    else { $('#showDraw').checked = false; sendShow(false); }
  });
  $('#showName').addEventListener('change', () => { if (closer && roster.shown === closer.key) sendShow(); });
  $('#showDraw').addEventListener('change', () => { if (closer && roster.shown === closer.key) sendShow($('#showDraw').checked); });
  $('#onShow').addEventListener('click', () => send({ t: 'show', key: null }));
  // Scrolling the board on show: the whiteboard (and the students' screens) scroll with it, a few times a second at most.
  let scrollSent = -1, scrollTimer = 0;
  $('#stage').addEventListener('scroll', () => {
    if (!closer || roster.shown !== closer.key || scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = 0;
      if (!closer || roster.shown !== closer.key) return;
      const h = pageCanvas.offsetHeight;
      const y = h > 0 ? Math.round(($('#stage').scrollTop / h) * 1000) / 1000 : 0;
      if (y !== scrollSent) { scrollSent = y; send({ t: 'showScroll', y }); }
    }, 120);
  }, { passive: true });

  function goPage(d) {
    if (!closer || !closer.state) return;
    closer.page = Math.max(0, Math.min(closer.state.pages.length - 1, closer.page + d));
    closer.followCur = closer.page === closer.state.cur;
    $('#stage').scrollTop = 0;
    drawCloser();
    if (roster.shown === closer.key) sendShow(); // the whiteboard shows this page too
  }
  function goStudent(d) {
    if (!closer) return;
    const list = students();
    const next = list[list.findIndex((s) => s.key === closer.key) + d];
    if (next) openCloser(next.key);
  }

  // ---------- controls ----------
  $('#back').addEventListener('click', closeCloser);
  $('#wToggle').addEventListener('click', () => setMarking(!marking.frame));
  for (const b of document.querySelectorAll('#wTools [data-mark]')) b.addEventListener('click', () => pickTool(b.dataset.mark));
  $('#wUndo').addEventListener('click', () => {
    const tid = closer && [...closer.mine].reverse().find((t) => !closer.erased.has(t));
    if (tid) takeBack(tid);
  });
  $('#pPrev').addEventListener('click', () => goPage(-1));
  $('#pNext').addEventListener('click', () => goPage(1));
  $('#sPrev').addEventListener('click', () => goStudent(-1));
  $('#sNext').addEventListener('click', () => goStudent(1));
  addEventListener('resize', () => drawCloser());
  addEventListener('keydown', (e) => {
    if (closer) {
      if (marking.frame) { if (e.key === 'Escape') setMarking(false); return; } // (the whiteboard has the keys while writing)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('#wUndo').click(); }
      else if (e.key === 'Escape') { if (write.on) setWriting(false); else closeCloser(); }
      else if (e.key === 'ArrowLeft') goStudent(-1);
      else if (e.key === 'ArrowRight') goStudent(1);
      else if (e.key === 'PageUp') goPage(-1);
      else if (e.key === 'PageDown') goPage(1);
    } else if (e.key === 'Escape') close();
  });
  for (const b of document.querySelectorAll('#see button')) b.addEventListener('click', () => send({ t: 'follow', on: b.dataset.follow === '1' }));
  $('#waiting').addEventListener('click', () => send({ t: 'letIn' }));

  let size = 'm';
  try { size = localStorage.getItem('padlink.gridSize') || 'm'; } catch { /* private mode */ }
  function setSize(s) {
    size = s;
    $('#grid').className = 'grid size-' + s;
    for (const b of document.querySelectorAll('#sizes button')) { const on = b.dataset.size === s; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    try { localStorage.setItem('padlink.gridSize', s); } catch { /* private mode */ }
  }
  for (const b of document.querySelectorAll('#sizes button')) b.addEventListener('click', () => setSize(b.dataset.size));
  setSize(size);

  function close() {
    // Inside the whiteboard or the pad (a frame): close just the grid. (In the whiteboard the PC window's own messages
    // reach this frame too, and "close" there would hide the whole whiteboard.)
    if (embedded) window.parent.postMessage({ padlink: 'closeGrid' }, location.origin);
    else if (host) host.postMessage({ type: 'close' });
  }
  $('#close').hidden = !host && !embedded;
  $('#close').addEventListener('click', close);

  connect();
})();
