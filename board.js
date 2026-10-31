// PadLink whiteboard: pages of pen/highlighter strokes, shapes and pictures. A page is 1920 wide and
// starts 1080 tall; it grows downwards as you write near the bottom, and the view scrolls.
// Runs inside PadLink's WebView2 window (window.chrome.webview); also opens in a normal browser
// for testing, where import is limited to images.
(() => {
  'use strict';

  const W = 1920;
  const H = 1080;        // height of a new page, and of the visible part of a page at 100%
  const GROW_NEAR = 120; // ink this close to the bottom of a page...
  const GROW_BY = 540;   // ...makes the page this much taller
  const MAX_H = 30000;   // tallest page (the browser can't draw or save much taller pictures)
  // (Marking from the teacher's grid: mark-host.js's stand-in, even inside PadLink's own window.)
  const host = window.PADLINK_HOST || (window.chrome && window.chrome.webview);
  // Student Mode: this board is a student's, on their Chromebook (student-host.js stands in for PadLink's window and
  // keeps it on the teacher's PC). The PC-only buttons are hidden; the board shows the student's name.
  const student = window.PADLINK_STUDENT || null;
  if (student) document.body.classList.add('student');
  // Marking: the teacher writes on a student's board (or a team board) from the grid of student boards, with every
  // whiteboard tool (mark-host.js stands in for PadLink's window and sends the teacher's marks to the PC). The student's
  // own work is locked: the teacher's marks are the only ones that can be changed here. Like a student's board, the
  // PC-only buttons are hidden.
  const marking = !!window.PADLINK_MARK;
  if (marking) document.body.classList.add('student', 'marking');
  // PadLink Go: this board is on the teacher's iPad or iPhone, being prepared away from the PC (go/board-host.js keeps
  // it on the device). The PC-only parts (Capture, Google Drive, Class tools, the laser) are hidden.
  const go = !!window.PADLINK_GO;
  if (go) {
    document.body.classList.add('go');
    const imp = document.querySelector('#import');
    imp.title = 'Add a picture or a PDF worksheet: Photo Library, Take Photo or Choose File';
    imp.lastChild.textContent = 'Add';
    const close = document.querySelector('#close');
    close.title = 'Back to your boards (this one is saved)';
    close.setAttribute('aria-label', 'Back to your boards');
  }

  // The teacher's marks on a student's board (written from the teacher's grid) are the teacher's: the student can't erase,
  // select, move or clear them, and Undo leaves them be. Only the teacher takes them away. On a team board the same goes
  // for teammates' marks: each student changes only their own (the PC checks it too).
  // (Marking, the other way round: the student's work and their teammates' are locked; the teacher's marks aren't.)
  const locked = (it) => (marking ? !!it.by && it.by !== 'teacher' : !!student && !!it.by);
  // A team board (student-host.js): shared with teammates, so it's sent sooner after each change, every item has an id.
  const teamBoard = !!window.PADLINK_TEAM;
  if (teamBoard) document.body.classList.add('team-board');

  // Student tools: what the teacher has switched off for students (shapes, text, math, notes, pictures, pages, clear).
  let studentOff = new Set();
  const TOOL_KEYS = { text: 'text', math: 'math', note: 'notes' };
  /** Allowed for this board? (Everything is, except on a student's board where the teacher switched it off.) */
  function allowed(key) {
    if (!studentOff.has(key)) return true;
    toast('Your teacher has switched this off for now.');
    return false;
  }
  const toolKey = (t) => (SHAPES.has(t) ? 'shapes' : TOOL_KEYS[t]);
  function setStudentTools(allow) {
    studentOff = new Set(Object.entries(allow || {}).filter(([, on]) => !on).map(([k]) => k));
    for (const k of ['shapes', 'text', 'math', 'notes', 'pictures', 'pages', 'move', 'clear']) document.body.classList.toggle('no-' + k, studentOff.has(k));
    if (studentOff.has(toolKey(tool))) setTool('pen'); // the tool in hand was switched off
  }
  const post = (msg) => host && host.postMessage(msg);

  const $ = (s) => document.querySelector(s);
  const area = $('#area');
  const pageEl = $('#page');
  const base = $('#base');
  const live = $('#live');
  const bctx = base.getContext('2d');
  const lctx = live.getContext('2d');

  // ---------- model ----------
  // page: { bg, h, doc: { img, x, y, w, h } | null, items: [...] }   (h: the page's height, at least H)
  // item: { type: 'stroke', tool: 'pen'|'highlighter', color, size, pts: [[x, y, pressure]] }
  //     | { type: 'shape', shape: 'line'|'arrow'|'rect'|'ellipse', color, size, x1, y1, x2, y2 }
  //     | { type: 'image', img, x, y, w, h }
  //     | { type: 'text', id, x, y, w, paras }   (words and math: see rich.js)
  const images = new Map(); // id -> HTMLImageElement
  let nextImageId = 1;
  const pages = [newPage('white')];
  let cur = 0;
  const undoStack = [];
  const redoStack = [];

  function newPage(bg) { return { bg, h: H, doc: null, items: [] }; }
  const page = () => pages[cur];
  const ph = (p = page()) => p.h || H;

  /** Make the page taller when something reaches within GROW_NEAR of its bottom edge. */
  function growFor(bottom, p = page()) {
    let h = ph(p);
    while (bottom > h - GROW_NEAR && h < MAX_H) h = Math.min(MAX_H, h + GROW_BY);
    p.h = h;
  }

  // ---------- tools ----------
  const PEN_COLORS = ['#1f2328', '#ffffff', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#7048e8', '#fcc419'];
  const HIGHLIGHT_COLORS = ['#ffe066', '#8ce99a', '#ffa8d4', '#74c0fc', '#ffc078'];
  const SIZES = PadEngine.SIZES; // stroke widths for each size choice (engine.js)
  const SHAPES = new Set(['line', 'arrow', 'darrow', 'rect', 'ellipse', 'triangle', 'rtriangle', 'pentagon', 'hexagon', 'polygon', 'fcircle', 'fbar', 'numline', 'axes']);

  const PLAIN_TOOLS = new Set(['select', 'pen', 'highlighter', 'eraser', 'text', 'math', 'note', 'laser']);
  const NOTE_COLORS = PadEngine.NOTE_COLORS; // sticky notes' paper colors (engine.js)
  let tool = 'pen';
  const category = (t) => (SHAPES.has(t) ? 'shape' : t); // shapes share a color/size setting
  const settings = {
    pen: { color: PEN_COLORS[0], size: 1, medium: 'pen' },
    highlighter: { color: HIGHLIGHT_COLORS[0], size: 1 },
    shape: { color: PEN_COLORS[3], size: 1, parts: { fcircle: 4, fbar: 4, numline: 10, axes: 5, polygon: 8 }, frac: false },
    note: { color: NOTE_COLORS[0] }, // the paper of the next sticky note
    eraser: { size: 1 },
    select: {},
    text: {},
    math: {},
    laser: loadLaser(), // its look and color, kept on this PC
  };
  const setting = () => settings[category(tool)];

  // The laser pointer on the PC: same looks and colors as the pad's; PadLink draws it over everything.
  const LASER_COLORS = ['#ff2828', '#ff8a1c', '#facc15', '#22c55e', '#2f6bff', '#a855f7', '#ec4899', '#ffffff'];
  function loadLaser() {
    try {
      const s = JSON.parse(localStorage.getItem('padlink.boardLaser') || '{}');
      return { style: ['dot', 'saber', 'spotlight'].includes(s.style) ? s.style : 'dot', color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ff2828' };
    } catch { return { style: 'dot', color: '#ff2828' }; }
  }
  function saveLaser() {
    try { localStorage.setItem('padlink.boardLaser', JSON.stringify(settings.laser)); } catch { /* not kept: fine */ }
  }
  /** Send where the laser is (page-pixel positions in the window), or that it's gone (no points). */
  function laserAt(points, down) {
    post({ type: 'laser', pts: points, down, style: settings.laser.style, color: settings.laser.color });
    laserToClass(points, down, settings.laser.style, settings.laser.color);
  }

  // The laser on students' screens too, while they follow the teacher's board or a board is on show: where it is on
  // that page (not the window), gathered up and sent every 40 ms. From this board's Laser tool, or the pad's laser in
  // Remote mode (the PC passes on where it is in this window: laserIn).
  const classLaser = { pts: [], on: '', down: false, style: 'dot', color: '#ff2828', timer: 0 };
  function laserToClass(points, down, style, color) {
    const showing = !!(shown.msg && shown.el && !shown.el.hidden && shown.canvas);
    if (!showing && !mirror.follow) { if (classLaser.on) laserClassOff(); return; }
    if (!points.length) { laserClassOff(); return; }
    let on, map;
    if (showing) {
      const r = shown.canvas.getBoundingClientRect(), k = W / (r.width || 1);
      on = 'shown';
      map = ([x, y]) => [(x - r.left) * k, (y - r.top) * k];
    } else {
      const r = live.getBoundingClientRect();
      on = 'page';
      map = ([x, y]) => [view.x + (x - r.left) / (r.width || 1) * W / view.z, view.y + (y - r.top) / (r.height || 1) * H / view.z];
    }
    if (on !== classLaser.on || down !== classLaser.down) laserClassFlush();
    Object.assign(classLaser, { on, down, style, color });
    for (const p of points) classLaser.pts.push(map(p).map((v) => Math.round(v)));
    if (!classLaser.timer) classLaser.timer = setTimeout(laserClassFlush, 40);
  }
  function laserClassFlush() {
    clearTimeout(classLaser.timer);
    classLaser.timer = 0;
    if (!classLaser.pts.length) return;
    const { on, down, style, color } = classLaser;
    post({ type: 'mirror', msg: { t: 'mlaser', on, pts: classLaser.pts, down, style, color } });
    classLaser.pts = [];
  }
  function laserClassOff() {
    laserClassFlush();
    if (!classLaser.on) return;
    post({ type: 'mirror', msg: { t: 'mlaser', on: classLaser.on, pts: [], down: false, style: classLaser.style, color: classLaser.color } });
    classLaser.on = '';
  }
  const laserPoint = (e) => [Math.round(e.clientX * 10) / 10, Math.round(e.clientY * 10) / 10];

  let stylePopTucked = false; // the color/size panel was tucked away by tapping the active tool again
  let stateTimer = 0;   // the pad hears about tool changes (see reportState)
  let lastState = '';

  /** The color and size panel beside the rail: shown for tools that have colors or sizes, unless tucked away. */
  function updateStylePop() {
    const s = setting();
    // Select shows the panel only for the Parts control of a selected fraction shape / number line / axes.
    $('#stylePop').hidden = stylePopTucked || !('color' in s || 'size' in s || selectedHasParts());
  }
  function selectedHasParts() { return selected?.type === 'shape' && PARTS_SHAPES.has(selected.shape); }

  function setTool(t) {
    if (studentOff.has(toolKey(t)) && !allowed(toolKey(t))) return;
    if (t !== tool) { stylePopTucked = false; finishText(); }
    if (tool === 'laser' && t !== 'laser') laserAt([], false); // put the laser away
    tool = t;
    document.body.classList.toggle('laser-on', t === 'laser'); // a board on show doesn't scroll under a finger meanwhile
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    if (SHAPES.has(t)) {
      lastShape = t;
      $('#shapesIcon').setAttribute('href', '#b-' + t);
    }
    $('#shapesBtn').classList.toggle('on', SHAPES.has(t));
    for (const c of [...document.body.classList]) if (c.startsWith('tool-')) document.body.classList.remove(c);
    document.body.classList.add('tool-' + t); // keep other classes (tools-away)
    if (t !== 'select') { select(null); addMode = false; }
    renderSwatches();
    renderSizes();
    renderMedia();
    renderLaserStyles();
    renderParts();
    updateStylePop();
    clearLive();
    reportState();
  }

  function renderSwatches() {
    const box = $('#swatches');
    box.innerHTML = '';
    const s = setting();
    const hasColor = 'color' in s;
    box.hidden = !hasColor;
    $('.custom').hidden = !hasColor;
    if (!hasColor) return;
    const palette = tool === 'highlighter' ? HIGHLIGHT_COLORS : tool === 'laser' ? LASER_COLORS : tool === 'note' ? NOTE_COLORS : PEN_COLORS;
    for (const c of palette) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === s.color ? ' on' : '');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => { s.color = c; if (tool === 'laser') saveLaser(); renderSwatches(); });
      box.appendChild(b);
    }
    $('#customColor').value = s.color;
    reportState();
  }

  // One Shapes button on the rail opens a flyout with every shape; it shows the shape used last.
  let lastShape = 'rect';
  const shapeFly = $('#shapeFly');
  function openShapeFly(open) {
    shapeFly.hidden = !open;
    if (!open) return;
    const r = $('#shapesBtn').getBoundingClientRect();
    const pop = $('#stylePop');
    const right = pop.hidden ? r.right : Math.max(r.right, pop.getBoundingClientRect().right); // beside the color panel, not over it
    shapeFly.style.left = `${right + 12}px`;
    shapeFly.style.top = `${Math.max(76, Math.min(r.top - 20, innerHeight - shapeFly.offsetHeight - 12))}px`;
    for (const b of shapeFly.querySelectorAll('[data-shape]')) b.classList.toggle('on', b.dataset.shape === tool);
  }
  $('#shapesBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!SHAPES.has(tool)) setTool(lastShape);
    openShapeFly(shapeFly.hidden);
  });
  shapeFly.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => {
    setTool(b.dataset.shape);
    openShapeFly(false);
  }));
  document.addEventListener('pointerdown', (e) => {
    if (!shapeFly.hidden && !shapeFly.contains(e.target) && !$('#shapesBtn').contains(e.target)) openShapeFly(false);
  }, true);

  /** Parts (and fraction labels) for fraction shapes, number lines and axes; also changes a selected one. */
  function renderParts() {
    const kind = selected?.type === 'shape' && PARTS_SHAPES.has(selected.shape) ? selected.shape : tool;
    const show = PARTS_SHAPES.has(kind);
    $('#partsBox').hidden = !show;
    if (!show) return;
    $('#partsN').textContent = selected?.shape === kind ? selected.parts : settings.shape.parts[kind];
    $('#partsLabel').textContent = kind === 'polygon' ? 'Sides' : 'Parts';
    $('#fracRow').hidden = kind !== 'numline';
    $('#fracLabels').checked = selected?.shape === 'numline' ? !!selected.frac : settings.shape.frac;
    reportState();
  }
  function changeParts(delta) {
    const kind = selected?.type === 'shape' && PARTS_SHAPES.has(selected.shape) ? selected.shape : tool;
    if (!PARTS_SHAPES.has(kind)) return;
    const limit = kind === 'numline' ? 20 : 12;
    const next = Math.max(kind === 'polygon' ? MIN_SIDES : 1, Math.min(limit, (selected?.shape === kind ? selected.parts : settings.shape.parts[kind]) + delta));
    settings.shape.parts[kind] = next;
    if (selected?.shape === kind) {
      pushUndo();
      replaceSelected();
      selected.parts = next;
      if (selected.shaded) selected.shaded = selected.shaded.filter((i) => i < next);
      renderBase();
    }
    renderParts();
  }
  $('#partsMinus').addEventListener('click', () => changeParts(-1));
  $('#partsPlus').addEventListener('click', () => changeParts(1));
  function setFracLabels(on) {
    settings.shape.frac = on;
    $('#fracLabels').checked = on;
    if (selected?.shape === 'numline') { pushUndo(); replaceSelected(); selected.frac = on; renderBase(); }
    reportState();
  }
  $('#fracLabels').addEventListener('change', (e) => setFracLabels(e.target.checked));

  /** The laser's look (dot, light saber, spotlight): in the side panel while the laser is the tool. */
  function renderLaserStyles() {
    const box = $('#laserStyles');
    box.hidden = tool !== 'laser';
    for (const b of box.querySelectorAll('[data-lstyle]')) b.classList.toggle('on', b.dataset.lstyle === settings.laser.style);
    $('.custom').hidden = tool === 'laser' || $('#swatches').hidden; // the laser has its 8 colors only
  }
  document.querySelectorAll('[data-lstyle]').forEach((b) => b.addEventListener('click', () => {
    settings.laser.style = b.dataset.lstyle;
    saveLaser();
    renderLaserStyles();
  }));

  /** Pen, marker, colored pencil, crayon or chalk: shown in the side panel while the pen is the tool. */
  function renderMedia() {
    const box = $('#media');
    box.hidden = tool !== 'pen';
    for (const b of box.querySelectorAll('[data-medium]')) b.classList.toggle('on', b.dataset.medium === settings.pen.medium);
    reportState();
  }
  document.querySelectorAll('[data-medium]').forEach((b) => b.addEventListener('click', () => {
    settings.pen.medium = b.dataset.medium;
    renderMedia();
  }));

  function renderSizes() {
    const s = setting();
    const hasSize = 'size' in s;
    $('#sizes').hidden = !hasSize;
    document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === s.size));
    reportState();
  }

  $('#customColor').addEventListener('input', (e) => { setting().color = e.target.value; renderSwatches(); });
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tool === tool) { stylePopTucked = !stylePopTucked; updateStylePop(); return; } // tap again: tuck away / bring back
    setTool(b.dataset.tool);
  }));
  document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
    setting().size = Number(b.dataset.size);
    renderSizes();
  }));

  // ---------- layout ----------
  let scale = 1; // CSS px per page unit
  let foregroundAt = performance.now();
  let layoutTimer = 0;

  function layout() {
    const cs = getComputedStyle(area);
    const aw = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    scale = Math.min(aw / W, ah / H);
    pageEl.style.width = `${W * scale}px`;
    pageEl.style.height = `${H * scale}px`;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [base, live]) {
      c.width = Math.round(W * scale * dpr);
      c.height = Math.round(H * scale * dpr);
    }
    renderBase();
    // Where the page is in the window: PadLink tells the iPad, which can show just the page.
    const r = pageEl.getBoundingClientRect();
    post({ type: 'pageRect', x: r.left, y: r.top, w: r.width, h: r.height });
  }
  window.addEventListener('resize', layout);
  // iPadOS can restore a Home Screen app with the visual viewport size it had while the keyboard or app switcher
  // was up, without sending the usual window resize afterwards. Measure again after the restored frame has settled.
  function refreshLayout() {
    requestAnimationFrame(() => requestAnimationFrame(layout));
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(layout, 250);
  }
  window.visualViewport?.addEventListener('resize', refreshLayout);
  window.addEventListener('pageshow', () => {
    foregroundAt = performance.now();
    refreshLayout();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    foregroundAt = performance.now();
    refreshLayout();
  });

  // ---------- zoom and scrolling ----------
  // The visible part of the page: zoom level and the page point at the top-left of the view. The view
  // always shows W/z x H/z of the page; a tall page scrolls under it even at 100%.
  // Ctrl + mouse wheel zooms (a pinch on the iPad arrives as exactly that); the wheel alone moves around
  // (on the iPad, a finger drag arrives as the wheel).
  const view = { z: 1, x: 0, y: 0 };
  const MAX_ZOOM = 6;
  const px = () => scale * view.z; // CSS px per page unit, including zoom

  function pageTransform(ctx) {
    const k = px() * (window.devicePixelRatio || 1);
    ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  }

  function clampView() {
    view.z = Math.min(MAX_ZOOM, Math.max(1, view.z));
    view.x = Math.min(W - W / view.z, Math.max(0, view.x));
    view.y = Math.min(ph() - H / view.z, Math.max(0, view.y));
  }

  function zoomAt(clientX, clientY, factor) {
    const r = live.getBoundingClientRect();
    zoomAtView((clientX - r.left) / r.width, (clientY - r.top) / r.height, factor);
  }

  /** Zoom by `factor` about a point given as fractions (0..1) across and down the view. */
  function zoomAtView(fx, fy, factor) {
    const before = view.z;
    const px0 = view.x + fx * W / before, py0 = view.y + fy * H / before; // page point under the fingers
    view.z = Math.min(MAX_ZOOM, Math.max(1, before * factor));
    view.x = px0 - fx * W / view.z;
    view.y = py0 - fy * H / view.z;
    clampView();
    renderBase();
  }

  function panBy(dxPage, dyPage) {
    const x = view.x, y = view.y;
    view.x += dxPage;
    view.y += dyPage;
    clampView();
    if (view.x !== x || view.y !== y) renderBase();
  }

  /** Back to 100%, keeping roughly the same part of a tall page in view. */
  function resetZoom() {
    const mid = view.y + H / view.z / 2;
    view.z = 1; view.x = 0; view.y = mid - H / 2;
    clampView();
    renderBase();
  }

  // Slim bar on the right edge: where the view is on a tall (or zoomed-in) page.
  const scrollbar = $('#scrollbar');
  const scrollThumb = scrollbar.firstElementChild;
  function updateScrollbar() {
    const h = ph(), vh = H / view.z;
    scrollbar.hidden = h <= vh + 1;
    if (scrollbar.hidden) return;
    scrollThumb.style.top = `${view.y / h * 100}%`;
    scrollThumb.style.height = `${vh / h * 100}%`;
  }

  function updateZoomUI() {
    const b = $('#zoomReset');
    const zoomed = view.z >= 1.01;
    if (go) b.hidden = !zoomed; // PadLink Go: shown only while zoomed in (fingers pinch)
    b.classList.toggle('zoomed', zoomed);
    b.textContent = `${Math.round(view.z * 100)}%`;
    $('#zoomOut').disabled = !zoomed;
    $('#zoomIn').disabled = view.z >= MAX_ZOOM - 0.01;
  }

  /** Zoom by <factor> about the middle of what's on screen. */
  function zoomCenter(factor) {
    const r = live.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  area.addEventListener('wheel', (e) => {
    e.preventDefault(); // never let the browser zoom or scroll the whole board page
    if (e.ctrlKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0025));
    } else {
      const k = px();
      panBy(e.deltaX / k, e.deltaY / k);
    }
  }, { passive: false });

  $('#zoomReset').addEventListener('click', resetZoom);
  $('#zoomOut').addEventListener('click', () => zoomCenter(0.8));
  $('#zoomIn').addEventListener('click', () => zoomCenter(1.25));

  // Chrome's own zoom makes the toolbar and everything else bigger too, so a student can lose the toolbar off the
  // screen. Ctrl + scroll (a pinch on a Chromebook's touchpad) and Ctrl and + / − zoom the board instead, wherever
  // the pointer or the typing is (the board's own handler above covers the page itself).
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || area.contains(e.target)) return;
    e.preventDefault();
    zoomCenter(Math.exp(-e.deltaY * 0.0025));
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key;
    if (k === '0') resetZoom();
    else if (k === '=' || k === '+') zoomCenter(1.25);
    else if (k === '-' || k === '_') zoomCenter(0.8);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // If Chrome's zoom changed anyway on a student's Chromebook (from its menu, say), say how to put it back: a web
  // page can't undo it itself. (Not on the PC, where moving PadLink to another screen changes the scale too.)
  const browserZoom = $('#browserZoom');
  const startDpr = window.devicePixelRatio || 1;
  function checkBrowserZoom() {
    const ratio = (window.devicePixelRatio || 1) / startDpr;
    browserZoom.hidden = !student || Math.abs(ratio - 1) < 0.04 || browserZoom.dataset.dismissed === String(window.devicePixelRatio);
  }
  window.addEventListener('resize', checkBrowserZoom);
  $('#browserZoomOk').addEventListener('click', () => { browserZoom.dataset.dismissed = String(window.devicePixelRatio); checkBrowserZoom(); });

  // ---------- rendering (the shared engine, engine.js) ----------
  PadEngine.configure({
    image: (id) => images.get(id),
    isEditing: (item) => editing?.item === item,
    skipText: (ctx, item) => editing?.item === item && editing.by === 'pc' && ctx === bctx,
  });
  const { isDark, drawBackground, strokeWidth, smoothPoints, MEDIA, drawStroke, PARTS_SHAPES, DEFAULT_PARTS, MIN_SIDES, MAX_SIDES,
    SQUARE_SHAPES, box, polygonPoints, shapeLines, sectionAt, drawShape, drawItem, renderPage, bounds, centerOf, turnPoint,
    extentOf, FILL_SHAPES } = PadEngine;


  function renderBase() {
    if (!pageMenu.hidden) renderPagesPanel();
    pageTransform(bctx);
    renderPage(bctx, page());
    renderLive();
    $('#pageNo').textContent = `${cur + 1} / ${pages.length}` + (pollUiReady && teacherBoard && pollSpec(page()) ? ' 📊' : '');
    $('#background').value = page().bg;
    updateZoomUI();
    updateScrollbar();
    placePcEditor();
    reportState();
    pagePollChanged();
    boardPollsChanged();
    scheduleSave(); // every change ends in a redraw, so this catches them all (unchanged boards aren't re-saved)
    mirrorChanged(); // and the iPad's copy follows
  }

  function clearLive() {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, live.width, live.height);
  }

  // The live layer shows what's being drawn right now, the selection box and the eraser ring.
  let preview = null;      // item being drawn
  let eraserAt = null;     // [x, y] eraser ring position

  function renderLive() {
    mirrorLive(); // what's moving, for the iPad's copy
    clearLive();
    pageTransform(lctx);
    if (preview) drawItem(lctx, preview, isDark(page()));
    for (const it of padStrokes.values()) drawItem(lctx, it, isDark(page())); // being drawn on the iPad
    if (selected) drawSelection(lctx, selected);
    if (action?.kind === 'marquee') {
      const a = action, k = px();
      lctx.save();
      lctx.fillStyle = 'rgba(47, 107, 255, 0.08)';
      lctx.strokeStyle = '#2f6bff';
      lctx.lineWidth = 1.5 / k;
      lctx.setLineDash([6 / k, 4 / k]);
      lctx.fillRect(Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0));
      lctx.strokeRect(Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0));
      lctx.restore();
    }
    placeSelBar();
    if (editing && editing.by === 'pad') {
      // Being typed on the iPad or iPhone: a dashed box shows where.
      const b = bounds(editing.item);
      const m = 8 / px();
      lctx.save();
      lctx.strokeStyle = '#2f6bff';
      lctx.lineWidth = 2 / px();
      lctx.setLineDash([8 / px(), 6 / px()]);
      lctx.strokeRect(b.x - m, b.y - m, b.w + m * 2, b.h + m * 2);
      lctx.restore();
    }
    if (eraserAt) {
      lctx.save();
      lctx.strokeStyle = isDark(page()) ? '#fff' : '#555';
      lctx.lineWidth = 1.5 / px();
      lctx.beginPath();
      lctx.arc(eraserAt[0], eraserAt[1], SIZES.eraser[settings.eraser.size] / 2, 0, Math.PI * 2);
      lctx.stroke();
      lctx.restore();
    }
  }

  // ---------- geometry ----------
  const HANDLE = 16; // CSS px

  // Turning: any item can be turned (item.rot, degrees clockwise) about the centre of its box. It is drawn, hit and
  // resized in its own unturned frame: page points are turned back into that frame first.

  /** Turn an item by <deg> about (cx, cy): its centre goes round, and it turns too (a group: each piece). */
  function turnItem(item, deg, cx, cy) {
    if (item.type === 'group') {
      for (const c of item.items) turnItem(c, deg, cx, cy);
      item.frame = ((((item.frame || 0) + deg) % 360) + 360) % 360; // its box turns with it
      if (!item.frame) delete item.frame;
      return;
    }
    const [ox, oy] = centerOf(item);
    const [nx, ny] = turnPoint(ox, oy, cx, cy, deg);
    moveItem(item, nx - ox, ny - oy);
    item.rot = ((((item.rot || 0) + deg) % 360) + 360) % 360;
    if (!item.rot) delete item.rot;
  }

  /** The pieces of an item (a group's, all the way down). */
  const leaves = (item) => (item.type === 'group' ? item.items.flatMap(leaves) : [item]);

  const { toLocal, distToSegment, insideOutline, hits } = PadEngine; // hit-testing (engine.js)
  const toPageFrom = (item, x, y) => (item.rot ? turnPoint(x, y, ...centerOf(item), item.rot) : [x, y]);

  /** Where the selection's handles are, in the item's own frame: corners, edge middles, and the turn handle. */
  /** The corners of everything an item covers on the page (a group: all its pieces, turned as they are). */
  function cornerPoints(it) {
    if (it.type === 'group') return it.items.flatMap(cornerPoints);
    const b = bounds(it);
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    return it.rot ? pts.map(([x, y]) => turnPoint(x, y, b.x + b.w / 2, b.y + b.h / 2, it.rot)) : pts;
  }

  /**
   * The selection's frame: the box around an item in its own turned frame, the angle (rot) and its middle. One item:
   * its box and angle. A group, or several things: the box around all their pieces, turned by the angle the group has
   * been turned by (item.frame), so the box turns with them rather than growing and shrinking around them.
   */
  function selFrame(item) {
    if (item.type !== 'group') {
      const b = bounds(item);
      // text: its height follows its words, so only the side handles (width) show (the pad reads this too)
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rot: item.rot || 0, box: b, ...(item.type === 'text' ? { text: true } : {}) };
    }
    const f = item.frame || 0;
    const pts = cornerPoints(item);
    const span = (list) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of list) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const a = span(pts), px0 = a.x + a.w / 2, py0 = a.y + a.h / 2; // any turning point will do
    const b = f ? span(pts.map(([x, y]) => turnPoint(x, y, px0, py0, -f))) : a;
    const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    const [cx, cy] = f ? turnPoint(bcx, bcy, px0, py0, f) : [bcx, bcy];
    return { cx, cy, rot: f, box: { x: b.x + cx - bcx, y: b.y + cy - bcy, w: b.w, h: b.h } };
  }
  const frameLocal = (fr, x, y) => (fr.rot ? turnPoint(x, y, fr.cx, fr.cy, -fr.rot) : [x, y]);
  const framePage = (fr, x, y) => (fr.rot ? turnPoint(x, y, fr.cx, fr.cy, fr.rot) : [x, y]);

  function selHandles(item) {
    const fr = selFrame(item), b = fr.box, m = 8 / px();
    const x0 = b.x - m, y0 = b.y - m, x1 = b.x + b.w + m, y1 = b.y + b.h + m;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    return {
      fr,
      box: [x0, y0, x1, y1],
      corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
      // top, right, bottom, left (a text box: no top or bottom, its height follows its words)
      edges: fr.text ? [null, [x1, my], null, [x0, my]] : [[mx, y0], [x1, my], [mx, y1], [x0, my]],
      knob: [mx, y0 - 34 / px()],
    };
  }

  function drawSelection(ctx, item) {
    const h = selHandles(item), k = px();
    if (item.type === 'group') { // each piece of several (or of a group) outlined lightly
      ctx.save();
      ctx.strokeStyle = 'rgba(47, 107, 255, 0.55)';
      ctx.lineWidth = 1.5 / k;
      for (const it of item.items) { // each piece's own (turned) box
        const f = selFrame(it), b = f.box;
        ctx.save();
        ctx.translate(f.cx, f.cy);
        ctx.rotate((f.rot * Math.PI) / 180);
        ctx.translate(-f.cx, -f.cy);
        ctx.strokeRect(b.x - 4 / k, b.y - 4 / k, b.w + 8 / k, b.h + 8 / k);
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.save();
    if (h.fr.rot) {
      ctx.translate(h.fr.cx, h.fr.cy);
      ctx.rotate((h.fr.rot * Math.PI) / 180);
      ctx.translate(-h.fr.cx, -h.fr.cy);
    }
    const [x0, y0, x1, y1] = h.box;
    ctx.strokeStyle = '#2f6bff';
    ctx.lineWidth = 2 / k;
    ctx.setLineDash([8 / k, 6 / k]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.beginPath(); // the turn handle's stem
    ctx.moveTo((x0 + x1) / 2, y0);
    ctx.lineTo(h.knob[0], h.knob[1] + 11 / k);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(h.knob[0], h.knob[1], 11 / k, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); // a little turning arrow inside the knob
    ctx.arc(h.knob[0], h.knob[1], 5 / k, -Math.PI * 0.9, Math.PI * 0.4);
    ctx.stroke();
    const hs = 14 / k;
    for (const [x, y] of h.corners) {
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
    }
    const es = 12 / k;
    for (const [x, y] of h.edges.filter(Boolean)) {
      ctx.fillRect(x - es / 2, y - es / 2, es, es);
      ctx.strokeRect(x - es / 2, y - es / 2, es, es);
    }
    ctx.restore();
  }



  // ---------- undo ----------
  function snapshot() { return { page: cur, items: page().items.slice(), bg: page().bg, doc: page().doc, h: ph() }; }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }

  function restore(from, to) {
    finishText(); // a text box being typed counts as one change, so Undo takes it back whole
    const s = from.pop();
    if (!s) return;
    cur = Math.min(s.page, pages.length - 1);
    to.push(snapshot());
    const marks = page().items.filter(locked);
    page().items = s.items.filter((i) => !locked(i)).concat(marks);
    page().bg = s.bg;
    page().doc = s.doc;
    page().h = s.h;
    clampView();
    select(null);
    renderBase();
  }

  const undo = () => restore(undoStack, redoStack);
  const redo = () => restore(redoStack, undoStack);
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);

  // ---------- selection ----------
  // One item, or several: then `selected` is a passing group { type: 'group', temp: true, items } of the page's own
  // items (not on the page itself), so moving, turning, resizing and recoloring work on all of them at once.
  let selected = null;
  let addMode = false; // the pad's "Add to selection": each tap adds or removes, as Ctrl+click does on the PC
  const selectedItems = () => (!selected ? [] : selected.temp ? selected.items.slice() : [selected]);
  function selectMany(list) {
    select(list.length === 0 ? null : list.length === 1 ? list[0] : { type: 'group', temp: true, items: list });
  }
  function select(item) {
    selected = item;
    renderLive();
    renderParts();
    updateStylePop();
  }

  /** Clear the page (Undo brings it back). */
  /**
   * Clear the page's drawings; with <all>, its picture too (a capture or an imported page). Undo brings it back.
   * The trash button: a tap clears the drawings, a tap on a page with only its picture left removes the picture,
   * a long press clears both. It asks first (here, or on the pad).
   */
  function clearPage(all) {
    finishText();
    if (!allowed('clear')) return;
    if (!page().items.length && !(all && page().doc)) return;
    pushUndo();
    page().items = all ? page().items.filter(locked) : page().items.filter((i) => i.type === 'image' || locked(i)); // drawings only: pictures (and the teacher's marks) stay
    if (all) page().doc = null;
    select(null);
    renderBase();
  }

  /** The page's pictures: those placed on it and its background picture (the trash's second tap). */
  function clearPictures() {
    if (!hasPictures()) return;
    pushUndo();
    page().items = page().items.filter((i) => i.type !== 'image');
    page().doc = null;
    select(null);
    renderBase();
  }
  const hasDrawings = () => page().items.some((i) => i.type !== 'image');
  const hasPictures = () => !!page().doc || page().items.some((i) => i.type === 'image');

  function deleteSelectionOrClear() {
    if (selected) {
      editSelected('delete');
    } else if (hasDrawings()) {
      if (confirm('Clear the drawings on this page? Pictures stay. Undo brings them back.')) clearPage(false);
    } else if (hasPictures()) {
      if (confirm('Remove the pictures on this page? Undo brings them back.')) clearPictures();
    }
  }
  // The trash: click as above; hold it down to clear everything at once (drawings and pictures).
  let trashHeld = false, trashTimer = 0;
  $('#delete').addEventListener('pointerdown', () => {
    trashHeld = false;
    clearTimeout(trashTimer);
    trashTimer = setTimeout(() => {
      trashHeld = true;
      if ((page().items.length || page().doc) && confirm('Clear everything on this page, the drawings and the pictures? Undo brings it back.')) clearPage(true);
    }, 600);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) $('#delete').addEventListener(type, () => clearTimeout(trashTimer));
  $('#delete').addEventListener('click', () => { if (trashHeld) { trashHeld = false; return; } deleteSelectionOrClear(); });

  // ---------- pointer input ----------
  let action = null; // { kind: 'stroke'|'shape'|'erase'|'move'|'resize', ... }

  function toPage(e) {
    const r = live.getBoundingClientRect();
    return [view.x + (e.clientX - r.left) / r.width * W / view.z, view.y + (e.clientY - r.top) / r.height * H / view.z];
  }

  const pressureOf = (e) => (e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 0.5);
  const isEraserEnd = (e) => e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);

  // ---------- links (the teacher's, in text boxes) ----------
  // With Select, a click (or tap) on a link opens it: a press let go where it started, so dragging the box still moves
  // it. On the PC whiteboard it opens in the PC's own browser; on a Chromebook, the iPad or a phone, in a new tab.
  let linkPress = null;
  function linkAt(x, y) {
    const it = textAt(x, y);
    if (!it) return null;
    const [lx, ly] = it.rot ? turnPoint(x, y, ...centerOf(it), -it.rot) : [x, y];
    return PadText.linkAt(it, lx, ly, 6 / px());
  }
  function openLink(href) {
    const url = PadText.cleanHref(href);
    if (!url) return;
    let site = url;
    try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* shown in full */ }
    toast(`Opening ${site}…`, 2500);
    if (host && !student && !go && !marking) post({ type: 'openLink', url }); // the PC's own browser, not PadLink's window
    else window.open(url, '_blank', 'noopener');
  }
  live.addEventListener('pointerup', (e) => {
    const lp = linkPress;
    linkPress = null;
    if (lp && lp.id === e.pointerId && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 8) openLink(lp.href);
  }, true);
  live.addEventListener('pointermove', (e) => {
    if (linkPress && linkPress.id === e.pointerId && Math.hypot(e.clientX - linkPress.x, e.clientY - linkPress.y) >= 8) linkPress = null;
    if (e.buttons || tool !== 'select') { live.classList.remove('on-link'); return; }
    live.classList.toggle('on-link', !!linkAt(...toPage(e)));
  });

  // Select: double-click (or double-tap, with a finger or the Pencil) a text box to change its words. Counted here, not
  // with the browser's dblclick: iPad Safari doesn't send that for a double tap, and Chrome can miss it.
  let lastDown = { at: 0, x: 0, y: 0 };
  function secondTap(e) {
    const now = performance.now();
    const twice = now - lastDown.at < 450 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 24;
    lastDown = twice ? { at: 0, x: 0, y: 0 } : { at: now, x: e.clientX, y: e.clientY };
    return twice;
  }

  function boardPointerDown(e) {
    if (e.button !== 0 && !isEraserEnd(e)) return; // ignore right-click / barrel button
    e.preventDefault();
    try { live.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const [x, y] = toPage(e);
    selPop.hidden = true;
    const t = isEraserEnd(e) ? 'eraser' : tool;
    linkPress = null;
    const href = t === 'select' ? linkAt(x, y) : null;
    if (href) linkPress = { href, x: e.clientX, y: e.clientY, id: e.pointerId }; // opened if it's let go without moving
    else if (t === 'select' && secondTap(e) && textAt(x, y)) { beginText(x, y, 'text'); return; }
    if (t === 'text' || t === 'math' || t === 'note') { beginText(x, y, t); return; }
    finishText();
    if (t === 'laser') { action = { kind: 'laser' }; laserAt([laserPoint(e)], true); return; }

    if (t === 'pen' || t === 'highlighter') {
      const s = settings[t];
      const medium = t === 'pen' ? s.medium : undefined;
      preview = { type: 'stroke', tool: t, medium, color: s.color, size: SIZES[medium || t][s.size], pts: [[x, y, pressureOf(e)]] };
      action = { kind: 'stroke' };
      renderLive();
    } else if (SHAPES.has(t)) {
      const s = settings.shape;
      preview = { type: 'shape', shape: t, color: s.color, size: SIZES.shape[s.size], x1: x, y1: y, x2: x, y2: y };
      if (PARTS_SHAPES.has(t)) preview.parts = s.parts[t];
      if (t === 'fcircle' || t === 'fbar') preview.shaded = [];
      if (t === 'numline') preview.frac = s.frac;
      action = { kind: 'shape' };
    } else if (t === 'eraser') {
      action = { kind: 'erase', changed: false, before: snapshot() };
      eraseAt(x, y);
    } else if (t === 'select') {
      startSelect(x, y, e);
    }
  }

  function boardPointerMove(e) {
    const [x, y] = toPage(e);
    const effective = isEraserEnd(e) ? 'eraser' : tool;

    if (effective === 'laser') {
      // Only while pressed (mouse button down or a finger touching): every in-between point, for a smooth line.
      if (action?.kind !== 'laser') return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      laserAt((events.length ? events : [e]).map(laserPoint), true);
      return;
    }
    if (!action) {
      // Hover feedback
      if (effective === 'eraser') { eraserAt = [x, y]; renderLive(); }
      else if (eraserAt) { eraserAt = null; renderLive(); }
      return;
    }

    if (action.kind === 'stroke') {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const [px, py] = toPage(ev);
        preview.pts.push([px, py, pressureOf(ev)]);
      }
      renderLive();
    } else if (action.kind === 'shape') {
      let x2 = x, y2 = y;
      if (e.shiftKey || SQUARE_SHAPES.has(preview.shape)) [x2, y2] = constrain(preview, x, y);
      if (preview.shape === 'numline') y2 = preview.y1; // number lines lie flat
      preview.x2 = x2;
      preview.y2 = y2;
      renderLive();
    } else if (action.kind === 'erase') {
      eraserAt = [x, y];
      eraseAt(x, y);
    } else if (action.kind === 'move') {
      moveItem(selected, x - action.lastX, y - action.lastY);
      action.lastX = x;
      action.lastY = y;
      renderBase();
    } else if (action.kind === 'rotate') {
      // How far round from the press, clicking into 15° steps (always with Shift): of the item's own angle for one
      // item, of the turn itself for a group or several.
      let turn = ((Math.atan2(y - action.cy, x - action.cx) - action.a0) * 180) / Math.PI;
      const base = action.rot0;
      const near = Math.round((base + turn) / 15) * 15;
      if (e.shiftKey || Math.abs(base + turn - near) < 4) turn = near - base;
      turnItem(selected, turn - (action.applied || 0), action.cx, action.cy);
      action.applied = turn;
      renderBase();
    } else if (action.kind === 'marquee') {
      action.x1 = x;
      action.y1 = y;
      renderLive();
    } else if (action.kind === 'scale') {
      scaleSelected(action, x, y, e.shiftKey);
      renderBase();
    }
  }

  function endAction(e) {
    if (!action) return;
    if (action.kind === 'laser') {
      laserAt([], false); // let go: the laser goes away (its trail fades)
      action = null;
      return;
    }
    if (action.kind === 'stroke' || action.kind === 'shape') {
      const item = preview;
      preview = null;
      const tiny = item.type === 'shape' && Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < 4;
      if (tiny && toggleSection(item.x1, item.y1)) { action = null; renderBase(); return; }
      if (!tiny) {
        pushUndo();
        page().items.push(item);
        const b = bounds(item);
        growFor(b.y + b.h);
      }
      renderBase();
    } else if (action.kind === 'erase') {
      if (action.changed) {
        undoStack.push(action.before);
        redoStack.length = 0;
        reportState();
      }
      eraserAt = null;
      renderLive();
    } else if (action.kind === 'marquee') {
      const a = action;
      action = null;
      finishMarquee(a);
      renderBase();
    } else if (action.kind === 'move' && action.one && Math.hypot(action.lastX - action.x0, action.lastY - action.y0) < 3 / px()) {
      const one = action.one;
      action = null;
      undoStack.pop(); // nothing moved: no Undo step
      select(one);
      renderBase();
    } else if ((action.kind === 'move' || action.kind === 'rotate' || action.kind === 'scale') && selected) {
      if (action.kind === 'move' && Math.hypot(action.lastX - action.x0, action.lastY - action.y0) < 0.5 / px()) undoStack.pop(); // a tap: nothing moved, no Undo step
      if (!selected.rot) delete selected.rot;
      action = null; // so the bar over the selection comes back
      const b = bounds(selected);
      growFor(b.y + b.h);
      renderBase();
    }
    action = null;
  }

  // PadLink Go uses the same saved finger choice as its Control the PC screen. On an iPad, the default is
  // Tap and scroll: Pencil draws, one finger moves the page, and two fingers pan/pinch. Phones default to acting
  // like the Pencil because they do not have one. This also gives Go the whiteboard's Undo/Redo finger gestures.
  const goTouches = new Map();
  const goIgnoredTouches = new Set();
  const GO_TOUCH_SLOP = 10;
  const GO_TOUCH_TAP_MS = 500;
  const GO_INK_TOOLS = new Set(['pen', 'highlighter', 'eraser', ...SHAPES]);
  let goGesture = null;
  let goLastPenAt = -Infinity;
  let sendingGoPen = false;

  function goFingerMode() {
    const phone = /iPhone|iPod/.test(navigator.userAgent) || (/Android/.test(navigator.userAgent) && /Mobile/.test(navigator.userAgent));
    const fallback = phone ? 'pencil' : 'touch';
    try {
      const s = JSON.parse(localStorage.getItem('padlink.settings') || '{}');
      return s.fingersChosen && ['touch', 'pencil', 'off'].includes(s.fingers) ? s.fingers : fallback;
    } catch { return fallback; }
  }

  const goCentroid = () => {
    let x = 0, y = 0;
    for (const p of goTouches.values()) { x += p.x; y += p.y; }
    return [x / goTouches.size, y / goTouches.size];
  };
  const goSpread = () => {
    const [a, b] = [...goTouches.values()];
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  };
  function goPenEvent(type, p, pointerId) {
    sendingGoPen = true;
    try {
      live.dispatchEvent(new PointerEvent(type, {
        pointerId: pointerId + 100000,
        pointerType: 'pen',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
        pressure: type === 'pointerup' || type === 'pointercancel' ? 0 : 0.5,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      }));
    } finally { sendingGoPen = false; }
  }
  function cancelGoTouches() {
    if (goGesture?.penStarted) goPenEvent('pointercancel', goGesture.last, goGesture.id);
    for (const id of goTouches.keys()) goIgnoredTouches.add(id);
    goTouches.clear();
    goGesture = null;
  }
  function goTouchDown(e) {
    e.preventDefault();
    try { live.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    const mode = goFingerMode();
    if (mode === 'off' || performance.now() - goLastPenAt < 600) { goIgnoredTouches.add(e.pointerId); return; }
    const p = { x: e.clientX, y: e.clientY };
    goTouches.set(e.pointerId, p);
    if (goTouches.size === 1) {
      // With Select, a finger that starts on what's selected (or its handles) moves, resizes or turns it, as the
      // Pencil would; anywhere else it moves the page.
      const grab = mode === 'touch' && tool === 'select' && onSelection(...toPage(e));
      goGesture = { kind: 'one', mode: grab ? 'pencil' : mode, id: e.pointerId, start: p, last: p, at: performance.now(), moved: 0, penStarted: false };
    } else if (goTouches.size === 2 && goGesture) {
      if (goGesture.penStarted) goPenEvent('pointerup', goGesture.last, goGesture.id);
      const [x, y] = goCentroid();
      goGesture.kind = 'two';
      goGesture.start = { x, y };
      goGesture.lastCenter = [x, y];
      goGesture.originCenter = [x, y];
      goGesture.lastSpread = goSpread();
      goGesture.originSpread = goGesture.lastSpread;
      goGesture.moved = 0;
    } else if (goTouches.size === 3 && goGesture) {
      const [x, y] = goCentroid();
      goGesture.kind = 'three';
      goGesture.start = { x, y };
      goGesture.moved = 0;
    } else {
      cancelGoTouches(); // a resting hand
    }
  }
  /** Is the page point (x, y) on the selection's box, its handles or its turn knob? */
  function onSelection(x, y) {
    if (!selected) return false;
    const h = selHandles(selected);
    const [lx, ly] = frameLocal(h.fr, x, y);
    const r = (HANDLE * 0.9) / px();
    const [x0, y0, x1, y1] = h.box;
    return (lx >= x0 - r && lx <= x1 + r && ly >= y0 - r && ly <= y1 + r) || Math.hypot(lx - h.knob[0], ly - h.knob[1]) <= r * 1.4;
  }
  function goTouchMove(e) {
    if (!goTouches.has(e.pointerId) || !goGesture) return;
    e.preventDefault();
    const p = { x: e.clientX, y: e.clientY };
    goTouches.set(e.pointerId, p);
    if (goGesture.kind === 'one') {
      const d = Math.hypot(p.x - goGesture.start.x, p.y - goGesture.start.y);
      goGesture.moved = Math.max(goGesture.moved, d);
      if (goGesture.mode === 'pencil') {
        if (!goGesture.penStarted && d > 8) {
          goGesture.penStarted = true;
          goPenEvent('pointerdown', goGesture.start, goGesture.id);
        }
        if (goGesture.penStarted) goPenEvent('pointermove', p, goGesture.id);
      } else if (d > GO_TOUCH_SLOP) {
        panBy(-(p.x - goGesture.last.x) / px(), -(p.y - goGesture.last.y) / px());
      }
      goGesture.last = p;
      return;
    }
    if (goGesture.kind === 'two' && goTouches.size === 2) {
      const [x, y] = goCentroid();
      const d = goSpread();
      const dx = x - goGesture.lastCenter[0], dy = y - goGesture.lastCenter[1];
      goGesture.moved = Math.max(goGesture.moved, Math.hypot(x - goGesture.originCenter[0], y - goGesture.originCenter[1]), Math.abs(d - goGesture.originSpread));
      if (Math.abs(d / goGesture.lastSpread - 1) > 0.002) zoomAt(x, y, d / goGesture.lastSpread);
      panBy(-dx / px(), -dy / px());
      goGesture.lastCenter = [x, y];
      goGesture.lastSpread = d;
    } else if (goGesture.kind === 'three') {
      const [x, y] = goCentroid();
      goGesture.moved = Math.max(goGesture.moved, Math.hypot(x - goGesture.start.x, y - goGesture.start.y));
    }
  }
  function goTouchEnd(e) {
    if (goIgnoredTouches.delete(e.pointerId)) return;
    if (!goTouches.has(e.pointerId)) return;
    e.preventDefault();
    const p = { x: e.clientX, y: e.clientY };
    goTouches.delete(e.pointerId);
    if (!goGesture) return;
    if (goGesture.kind === 'one' && goGesture.id === e.pointerId) {
      if (goGesture.penStarted) goPenEvent(e.type === 'pointercancel' ? 'pointercancel' : 'pointerup', p, goGesture.id);
      else if (e.type !== 'pointercancel' && goGesture.moved <= GO_TOUCH_SLOP && performance.now() - goGesture.at < GO_TOUCH_TAP_MS) {
        if (goGesture.mode === 'pencil' || !GO_INK_TOOLS.has(tool)) {
          goPenEvent('pointerdown', goGesture.start, goGesture.id);
          goPenEvent('pointerup', goGesture.start, goGesture.id);
        }
      }
      goGesture = null;
      return;
    }
    if (goTouches.size) return; // finish a two/three-finger gesture after every finger lifts
    if (e.type !== 'pointercancel' && goGesture.moved <= GO_TOUCH_SLOP && performance.now() - goGesture.at < GO_TOUCH_TAP_MS) {
      if (goGesture.kind === 'two') undo();
      else if (goGesture.kind === 'three') redo();
    }
    goGesture = null;
  }

  // Touch screens (an interactive panel on the PC, a touch Chromebook): one finger draws as before, and two fingers
  // move the page (a tall page scrolls) and pinch to zoom. The first finger's line, started a moment before the second
  // landed, is taken back. Until every finger lifts, it stays a move.
  const fingers = new Map(); // touch pointers down on the board: id -> { x, y }
  let fingerPan = null;      // { center, spread } while two fingers move the page
  const fingerCenter = () => {
    let x = 0, y = 0;
    for (const p of fingers.values()) { x += p.x; y += p.y; }
    return [x / fingers.size, y / fingers.size];
  };
  const fingerSpread = () => {
    const [a, b] = [...fingers.values()];
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  };
  /** The first finger's drawing, dropped (or, for what can't be dropped, finished): the second finger moves the page. */
  function dropFingerAction() {
    if (!action) return;
    const k = action.kind;
    if (k === 'stroke' || k === 'shape' || k === 'marquee') { preview = null; action = null; renderLive(); }
    else if (k === 'laser') { action = null; laserAt([], false); }
    else endAction(); // erasing or moving something: kept, as it is
  }
  /** A touch on the board: true when it's part of a two-finger move (so it doesn't draw). */
  function fingerDown(e) {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingerPan) return true;
    if (fingers.size < 2) return false;
    e.preventDefault();
    dropFingerAction();
    fingerPan = { center: fingerCenter(), spread: fingerSpread() };
    return true;
  }
  function fingerMove(e) {
    if (!fingers.has(e.pointerId)) return false;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!fingerPan) return false;
    e.preventDefault();
    if (fingers.size >= 2) {
      const [x, y] = fingerCenter(), d = fingerSpread();
      if (Math.abs(d / fingerPan.spread - 1) > 0.002) zoomAt(x, y, d / fingerPan.spread);
      panBy(-(x - fingerPan.center[0]) / px(), -(y - fingerPan.center[1]) / px());
      fingerPan = { center: [x, y], spread: d };
    }
    return true;
  }
  function fingerUp(e) {
    if (!fingers.delete(e.pointerId)) return false;
    if (!fingerPan) return false;
    if (fingers.size === 0) fingerPan = null;
    else fingerPan = { center: fingerCenter(), spread: fingerSpread() }; // one finger left: no jump when another lands
    return true;
  }

  live.addEventListener('pointerdown', (e) => {
    if (go && e.pointerType === 'touch') { goTouchDown(e); return; }
    if (go && e.pointerType === 'pen' && !sendingGoPen) { goLastPenAt = performance.now(); cancelGoTouches(); }
    if (e.pointerType === 'touch' && fingerDown(e)) return;
    boardPointerDown(e);
  });
  live.addEventListener('pointermove', (e) => {
    if (go && e.pointerType === 'touch') { goTouchMove(e); return; }
    if (e.pointerType === 'touch' && fingerMove(e)) return;
    boardPointerMove(e);
  });
  live.addEventListener('pointerup', (e) => {
    if (go && e.pointerType === 'touch') { goTouchEnd(e); return; }
    if (e.pointerType === 'touch' && fingerUp(e)) return;
    endAction(e);
  });
  // While writing, the color column fades so the ink under it shows.
  live.addEventListener('pointerdown', () => document.body.classList.add('inking'));
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, () => document.body.classList.remove('inking'));
  live.addEventListener('dblclick', (e) => e.preventDefault()); // (a double-click is counted in boardPointerDown)
  live.addEventListener('pointercancel', (e) => {
    if (go && e.pointerType === 'touch') { goTouchEnd(e); return; }
    if (e.pointerType === 'touch' && fingerUp(e)) return;
    endAction(e);
  });
  live.addEventListener('pointerleave', () => {
    if (!action && eraserAt) { eraserAt = null; renderLive(); }
    if (tool === 'laser' && !action) laserAt([], false);
  });

  /** Shade or clear the section of the topmost fraction circle or bar at (x, y). Returns whether there was one. */
  function toggleSection(x, y) {
    const items = page().items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type !== 'shape') continue;
      const k = sectionAt(it, ...toLocal(it, x, y));
      if (k < 0) continue;
      pushUndo();
      const copy = structuredClone(it); // undo keeps the original
      copy.shaded = copy.shaded?.includes(k) ? copy.shaded.filter((j) => j !== k) : [...(copy.shaded || []), k];
      items[i] = copy;
      return true;
    }
    return false;
  }

  /** Shift: lines snap to 45°, rectangles/ellipses become squares/circles. */
  function constrain(s, x, y) {
    const dx = x - s.x1, dy = y - s.y1;
    if (s.shape === 'line' || s.shape === 'arrow' || s.shape === 'darrow') {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return [s.x1 + len * Math.cos(angle), s.y1 + len * Math.sin(angle)];
    }
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [s.x1 + Math.sign(dx || 1) * d, s.y1 + Math.sign(dy || 1) * d];
  }

  function eraseAt(x, y) { eraseWith(x, y, SIZES.eraser[settings.eraser.size] / 2, action); }

  /** Erase the strokes and shapes at (x, y) within r; `state.changed` notes that something went (for Undo). */
  function eraseWith(x, y, r, state) {
    const items = page().items;
    let changed = false;
    const erase = (list) => list.flatMap((i) => {
      if (i.type === 'image') return [i]; // pictures are removed with Select + Delete
      if (locked(i)) return [i]; // the teacher's marks
      if (i.type === 'group') { // just the piece it touches; a new group object, so Undo keeps the old one
        const kept = erase(i.items);
        if (kept.length === i.items.length) return [i];
        return kept.length ? [{ ...i, items: kept }] : [];
      }
      if (hits(i, x, y, r)) { changed = true; return []; }
      return [i];
    });
    const keep = erase(items);
    if (changed) {
      page().items = keep;
      state.changed = true;
      renderBase();
    } else {
      renderLive();
    }
  }

  function startSelect(x, y, e) {
    const adding = !!e && (e.ctrlKey || e.shiftKey || e.metaKey) || addMode;
    if (selected) { // its handles work with Shift too (Shift + corner: a square)
      const h = selHandles(selected);
      const [lx, ly] = frameLocal(h.fr, x, y);
      const r = (HANDLE * 0.9) / px();
      // The round handle on top: turn it (about the middle of its box).
      if (Math.hypot(lx - h.knob[0], ly - h.knob[1]) <= r * 1.4) {
        pushUndo();
        replaceSelected();
        const { cx, cy } = h.fr;
        action = { kind: 'rotate', cx, cy, a0: Math.atan2(y - cy, x - cx), rot0: h.fr.rot };
        return;
      }
      // A corner: resize it, the opposite corner staying where it is.
      const ci = h.corners.findIndex(([hx, hy]) => Math.abs(lx - hx) <= r && Math.abs(ly - hy) <= r);
      if (ci >= 0) {
        pushUndo();
        replaceSelected();
        if (selected.type === 'group') { // a group or several: evenly, along its (turned) box
          const b = h.fr.box, gc = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
          action = { kind: 'scale', group: true, start: structuredClone(selected), fr: h.fr, anchor: gc[(ci + 2) % 4], corner: gc[ci], from: [lx, ly] };
          return;
        }
        // Measured on the item itself (not its handles), so the opposite edge stays exactly where it is.
        const g = geoBox(selected);
        const gc = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]];
        action = { kind: 'scale', start: structuredClone(selected), anchor: gc[(ci + 2) % 4], corner: gc[ci], from: [lx, ly], center: centerOf(selected) };
        return;
      }
      // An edge middle changes just that dimension. Corners above keep the established proportional behaviour for
      // pictures, text, regular shapes and groups; these handles make width and height independently adjustable.
      const ei = h.edges.findIndex((e) => e && Math.abs(lx - e[0]) <= r && Math.abs(ly - e[1]) <= r);
      if (ei >= 0) {
        pushUndo();
        replaceSelected();
        const axis = ei % 2 ? 'x' : 'y';
        if (selected.type === 'group') {
          const b = h.fr.box;
          const ge = [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]];
          action = { kind: 'scale', group: true, axis, start: structuredClone(selected), fr: h.fr, anchor: ge[(ei + 2) % 4], corner: ge[ei], from: [lx, ly] };
          return;
        }
        const g = geoBox(selected);
        const ge = [[g.x + g.w / 2, g.y], [g.x + g.w, g.y + g.h / 2], [g.x + g.w / 2, g.y + g.h], [g.x, g.y + g.h / 2]];
        action = { kind: 'scale', axis, start: structuredClone(selected), anchor: ge[(ei + 2) % 4], corner: ge[ei], from: [lx, ly], center: centerOf(selected) };
        return;
      }
      // Anywhere inside the selection's box: move it (thin lines are hard to grab exactly). Several selected: a tap
      // (no drag) on one of them selects just that one.
      const [x0, y0, x1, y1] = h.box;
      if (!adding && lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1) {
        const one = selected.temp ? [...selected.items].reverse().find((it) => hits(it, x, y, 10)) : null;
        pushUndo();
        replaceSelected();
        action = { kind: 'move', lastX: x, lastY: y, x0: x, y0: y, one: one ? selected.items[selected.items.length - 1 - [...selected.items].reverse().findIndex((it) => hits(it, x, y, 10))] : null };
        return;
      }
    }
    // Topmost item under the pointer (a group: the whole group)
    const items = page().items;
    let hit = null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (!locked(items[i]) && hits(items[i], x, y, 10)) { hit = items[i]; break; }
    }
    if (adding) { // add it to the selection, or take it out
      if (hit) {
        const now = selectedItems();
        selectMany(now.includes(hit) ? now.filter((i) => i !== hit) : [...now, hit]);
        renderBase(); // and tell the pad
      } else action = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, add: true };
      return;
    }
    select(hit);
    if (hit) {
      pushUndo();
      replaceSelected();
      action = { kind: 'move', lastX: x, lastY: y, x0: x, y0: y };
    } else action = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, add: false }; // drag a box to select several
  }

  /** The selection box let go: everything mostly inside it (its middle is inside) is selected. */
  function finishMarquee(a) {
    const x0 = Math.min(a.x0, a.x1), x1 = Math.max(a.x0, a.x1), y0 = Math.min(a.y0, a.y1), y1 = Math.max(a.y0, a.y1);
    if (x1 - x0 < 6 / px() && y1 - y0 < 6 / px()) return; // just a tap
    const inside = page().items.filter((it) => {
      if (locked(it)) return false;
      const b = extentOf([it]);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
    const now = a.add ? selectedItems() : [];
    selectMany([...now, ...inside.filter((i) => !now.includes(i))]);
  }

  /** Swap the selected item for a copy, so the undo snapshot keeps the original untouched. */
  function replaceSelected() {
    const items = page().items;
    if (selected?.temp) { // each of several
      selected.items = selected.items.map((it) => { const copy = structuredClone(it); items[items.indexOf(it)] = copy; return copy; });
      return;
    }
    const i = items.indexOf(selected);
    const copy = structuredClone(selected);
    items[i] = copy;
    selected = copy;
  }

  function moveItem(item, dx, dy) {
    if (item.type === 'group') { for (const c of item.items) moveItem(c, dx, dy); return; }
    if (item.type === 'image' || item.type === 'text') { item.x += dx; item.y += dy; }
    else if (item.type === 'shape') { item.x1 += dx; item.x2 += dx; item.y1 += dy; item.y2 += dy; }
    else for (const p of item.pts) { p[0] += dx; p[1] += dy; }
  }

  /** The item's own box (its points, without the line's thickness or the selection's margin). */
  function geoBox(it) {
    if (it.type === 'group') return extentOf(it.items);
    if (it.type === 'shape') return box(it);
    if (it.type === 'image') return { x: it.x, y: it.y, w: it.w, h: it.h };
    if (it.type === 'text') { const b = bounds(it); return { x: it.x, y: it.y, w: it.w, h: b.h }; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of it.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  /** Set <item> to <start> stretched from the point (ax, ay) by sx, sy (in the item's own frame). */
  function scaleFrom(item, start, ax, ay, sx, sy) {
    if (item.type === 'group') { item.items.forEach((c, i) => scaleFrom(c, start.items[i], ax, ay, sx, sy)); return; }
    const X = (x) => ax + (x - ax) * sx, Y = (y) => ay + (y - ay) * sy;
    if (item.type === 'shape') { item.x1 = X(start.x1); item.x2 = X(start.x2); item.y1 = Y(start.y1); item.y2 = Y(start.y2); }
    else if (item.type === 'stroke') item.pts = start.pts.map((p) => [X(p[0]), Y(p[1]), p[2]]);
    else if (item.type === 'image') { item.x = X(start.x); item.y = Y(start.y); item.w = start.w * sx; item.h = start.h * sy; }
    else if (item.type === 'text') { // bigger or smaller words, and a box to match
      item.x = X(start.x);
      item.y = Y(start.y);
      item.w = Math.max(60, start.w * sx);
      item.paras = start.paras.map((p) => ({ ...p, r: p.r.map((run) => (run.z ? { ...run, z: Math.max(8, Math.min(400, Math.round(run.z * sy * 10) / 10)) } : run)) }));
    }
  }

  /** Dragging a corner: stretch the item from the opposite corner (evenly for pictures, text, circles, regular
   *  shapes, or with Shift); a turned item keeps that corner where it was on the page. */
  function scaleSelected(a, x, y, square) {
    if (a.group) {
      const [lx, ly] = frameLocal(a.fr, x, y);
      const [ax, ay] = a.anchor;
      const dx = a.corner[0] - ax, dy = a.corner[1] - ay;
      let sx = Math.max(0.05, (dx + lx - a.from[0]) / (dx || 1));
      let sy = Math.max(0.05, (dy + ly - a.from[1]) / (dy || 1));
      if (!a.axis) sx = sy = Math.max(sx, sy);
      else if (a.axis === 'x') sy = 1;
      else sx = 1;
      const [px0, py0] = framePage(a.fr, ax, ay); // the opposite corner, on the page
      scaleFrom(selected, a.start, px0, py0, sx, sy);
      return;
    }
    const st = a.start;
    const [lx, ly] = toLocal(st, x, y);
    const [ax, ay] = a.anchor;
    const dx = a.corner[0] - ax, dy = a.corner[1] - ay;
    // The corner follows the pointer by as much as it has moved since the press.
    let sx = Math.max(0.05, (dx + lx - a.from[0]) / (dx || 1)), sy = Math.max(0.05, (dy + ly - a.from[1]) / (dy || 1));
    if (a.axis === 'x') sy = 1;
    else if (a.axis === 'y') sx = 1;
    const boxed = st.type === 'shape' && !['line', 'arrow', 'darrow', 'numline'].includes(st.shape);
    if (!a.axis && square && boxed) { // Shift: a square (graphs, rectangles, ellipses…), as when drawing
      const d = Math.max(Math.abs(dx) * sx, Math.abs(dy) * sy);
      sx = d / (Math.abs(dx) || 1);
      sy = d / (Math.abs(dy) || 1);
    } else if (!a.axis && (square || st.type === 'image' || st.type === 'text' || st.type === 'group' || (st.type === 'shape' && SQUARE_SHAPES.has(st.shape)))) {
      sx = sy = Math.max(sx, sy); // keep the proportions
    }
    if (st.type === 'shape' && st.shape === 'numline') sy = 1; // number lines lie flat
    scaleFrom(selected, st, ax, ay, sx, sy);
    if (st.rot) { // keep the fixed corner fixed on the page as the centre moves
      const before = turnPoint(ax, ay, ...a.center, st.rot);
      const after = turnPoint(ax, ay, ...centerOf(selected), st.rot);
      moveItem(selected, before[0] - after[0], before[1] - after[1]);
    }
  }

  // ---------- the bar over a selection (PC) ----------
  // Shown with the Select tool over whatever is selected, unless an iPad or iPhone is connected (it has its own
  // Select panel) or something is being dragged.
  const selBar = $('#selBar'), selPop = $('#selPop');
  function placeSelBar() {
    const show = !!selected && tool === 'select' && !action && !editing && !document.body.classList.contains('tools-away');
    selBar.hidden = !show;
    if (!show) { selPop.hidden = true; return; }
    const info = selInfo(selected);
    $('#selColorBtn').hidden = !info.canColor;
    $('#selColorLabel').textContent = selected.type === 'text' ? 'Text' : selected.type === 'stroke' ? 'Color' : selected.type === 'group' ? 'Color' : 'Border';
    $('#selColorDot').style.setProperty('--c', info.color || '#1f2328');
    $('#selFillBtn').hidden = !info.canFill;
    $('#selGroupBtn').hidden = !selected.temp; // several things: Group
    $('#selUngroupBtn').hidden = selected.type !== 'group' || !!selected.temp; // a group: Ungroup
    $('#selFillDot').style.setProperty('--c', selected.fill || '#fff');
    $('#selFillDot').classList.toggle('none', !selected.fill);
    $('#selColorBtn').classList.toggle('on', !selPop.hidden && selPop.dataset.kind === 'color');
    $('#selFillBtn').classList.toggle('on', !selPop.hidden && selPop.dataset.kind === 'fill');
    // Above the (turned) selection on the screen, or below it when there's no room.
    const h = selHandles(selected);
    const pts = [...h.corners, h.knob].map(([x, y]) => framePage(h.fr, x, y));
    const r = live.getBoundingClientRect(), k = r.width / (W / view.z);
    const xs = pts.map(([x]) => r.left + (x - view.x) * k), ys = pts.map(([, y]) => r.top + (y - view.y) * k);
    const bw = selBar.offsetWidth, bh = selBar.offsetHeight;
    let top = Math.min(...ys) - bh - 26; // clear of the turn handle
    const above = top >= r.top + 6;
    if (!above) top = Math.max(...ys) + 14;
    top = Math.max(6, Math.min(innerHeight - bh - 6, top));
    const left = Math.max(r.left + 6, Math.min(r.right - bw - 6, (Math.min(...xs) + Math.max(...xs)) / 2 - bw / 2));
    selBar.style.left = `${left}px`;
    selBar.style.top = `${top}px`;
    if (!selPop.hidden) { // on the side of the bar away from the selection, so the colors don't hide what they color
      selPop.style.left = `${Math.min(innerWidth - selPop.offsetWidth - 6, left)}px`;
      const up = top - selPop.offsetHeight - 8, down = top + bh + 8;
      selPop.style.top = `${above ? (up >= 6 ? up : down) : (down + selPop.offsetHeight < innerHeight ? down : up)}px`;
    }
  }

  /** The color pop-up: swatches for the border (and its thickness), or for the fill (and None). */
  function fillSelPop() {
    if (!selected) { selPop.hidden = true; return; }
    const kind = selPop.dataset.kind, info = selInfo(selected);
    selPop.innerHTML = '';
    const title = (t) => Object.assign(document.createElement('div'), { className: 't', textContent: t });
    const row = document.createElement('div');
    row.className = 'sw';
    if (kind === 'fill') {
      selPop.append(title(selected.type === 'text' ? 'Highlight behind the text' : 'Fill'));
      const none = Object.assign(document.createElement('button'), { className: 'none' + (!selected.fill ? ' on' : ''), title: 'No fill' });
      none.setAttribute('aria-label', 'No fill');
      none.addEventListener('click', () => { editSelected('fill', 'none'); fillSelPop(); });
      row.append(none);
    } else selPop.append(title(selected.type === 'text' ? 'Text color' : selected.type === 'stroke' ? 'Color' : 'Border'));
    for (const c of kind === 'fill' ? SEL_FILLS : SEL_COLORS) {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.classList.toggle('on', (kind === 'fill' ? selected.fill : info.color) === c);
      b.addEventListener('click', () => { editSelected(kind === 'fill' ? 'fill' : 'color', c); fillSelPop(); });
      row.append(b);
    }
    selPop.append(row);
    if (kind === 'color' && info.canThick) {
      selPop.append(title('Thickness'));
      const th = document.createElement('div');
      th.className = 'th';
      [3, 6, 11].forEach((d, i) => {
        const b = document.createElement('button');
        b.innerHTML = `<i style="height:${d}px"></i>`;
        b.title = ['Thin', 'Medium', 'Thick'][i];
        b.classList.toggle('on', info.size === i);
        b.addEventListener('click', () => { editSelected('size', i); fillSelPop(); });
        th.append(b);
      });
      selPop.append(th);
    }
    placeSelBar();
  }
  for (const b of selBar.querySelectorAll('[data-selpop]')) b.addEventListener('click', () => {
    const kind = b.dataset.selpop;
    if (!selPop.hidden && selPop.dataset.kind === kind) { selPop.hidden = true; placeSelBar(); return; }
    selPop.dataset.kind = kind;
    selPop.hidden = false;
    fillSelPop();
  });
  for (const b of selBar.querySelectorAll('[data-selop]')) b.addEventListener('click', () => {
    selPop.hidden = true;
    editSelected(b.dataset.selop, b.dataset.v != null ? Number(b.dataset.v) : undefined);
  });

  // ---------- editing what's selected (the PC's bar and the pad's Select panel) ----------
  const SEL_COLORS = ['#1f2328', '#2f6bff', '#e8590c', '#16a34a', '#dc2626', '#a855f7', '#f59e0b', '#ffffff'];
  const SEL_FILLS = ['#dce7ff', '#ffe3d1', '#d7f5e1', '#fde0e0', '#efe0ff', '#fff1c7', '#2f6bff', '#1f2328'];
  const SHAPE_NAMES = { line: 'Line', arrow: 'Arrow', darrow: 'Double arrow', numline: 'Number line', axes: 'Axes', rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', rtriangle: 'Right triangle', pentagon: 'Pentagon', hexagon: 'Hexagon', polygon: 'Polygon', fcircle: 'Fraction circle', fbar: 'Fraction bar' };

  /** What can be done to an item: its name, and whether it has a color, a fill and a thickness. */
  function selInfo(it) {
    if (it.type === 'group') { // several, or a group: what any of its pieces can do
      const infos = leaves(it).map(selInfo);
      const first = (key) => infos.find((i) => i[key]);
      const n = it.items.length;
      return {
        name: it.temp ? `${n} things` : `Group of ${n}`, sizes: first('canThick')?.sizes || null,
        color: first('canColor')?.color, fill: first('canFill')?.fill || 'none',
        canColor: infos.some((i) => i.canColor), canFill: infos.some((i) => i.canFill), canThick: infos.some((i) => i.canThick),
        size: first('canThick')?.size ?? null,
      };
    }
    const name = it.type === 'shape' ? SHAPE_NAMES[it.shape] || 'Shape' : it.type === 'stroke' ? (it.tool === 'highlighter' ? 'Highlighter' : 'Pen stroke') : it.type === 'text' ? 'Text' : 'Picture';
    const sizes = it.type === 'shape' ? SIZES.shape : it.type === 'stroke' ? SIZES[it.medium || it.tool] : null;
    const color = it.type === 'text' ? (it.paras?.[0]?.r?.[0]?.c || '#1f2328') : it.color;
    return {
      name, color, sizes,
      fill: it.fill || 'none',
      canColor: it.type !== 'image',
      canFill: it.type === 'text' || (it.type === 'shape' && FILL_SHAPES.has(it.shape)),
      canThick: !!sizes,
      size: sizes ? sizes.reduce((best, v, i) => (Math.abs(v - it.size) < Math.abs(sizes[best] - it.size) ? i : best), 0) : null,
    };
  }

  /** One change to the selection: color, fill ('none' = no fill), size (0-2), turn (degrees), scale (factor),
   *  front, back, dup or delete. Each is one step for Undo. */
  function editSelected(op, v) {
    if (op === 'addmode') { addMode = !!v; reportState(); return; }
    if (op === 'all') { // everything on this page
      if (tool !== 'select') setTool('select');
      selectMany(page().items.filter((it) => !locked(it)));
      renderBase();
      return;
    }
    if (!selected) return;
    if (op === 'deselect') { select(null); renderBase(); return; } // the pad's Select panel closed
    if (op === 'ungroup' && (selected.type !== 'group' || selected.temp)) return;
    if (op === 'group' && !selected.temp) return;
    const many = selectedItems();
    pushUndo();
    if (op === 'delete') {
      page().items = page().items.filter((i) => !many.includes(i));
      select(null);
      renderBase();
      return;
    }
    if (op === 'dup') {
      const copies = many.map((it) => { const c = structuredClone(it); for (const l of [c, ...leaves(c)]) if (l.id) l.id = newId(); moveItem(c, 30, 30); return c; });
      page().items.push(...copies);
      selectMany(copies);
      renderBase();
      return;
    }
    if (op === 'front' || op === 'back') {
      const rest = page().items.filter((i) => !many.includes(i));
      const moved = page().items.filter((i) => many.includes(i)); // in their order on the page
      page().items = op === 'front' ? [...rest, ...moved] : [...moved, ...rest];
      renderBase();
      return;
    }
    if (op === 'group') { // several become one: where the topmost of them was
      const items = page().items;
      const at = Math.max(...many.map((i) => items.indexOf(i)));
      const group = { type: 'group', id: newId(), items: items.filter((i) => many.includes(i)) };
      if (selected.frame) group.frame = selected.frame;
      items.splice(at, 1, group);
      page().items = items.filter((i) => !many.includes(i));
      select(group);
      renderBase();
      return;
    }
    if (op === 'ungroup') { // back into its pieces, still selected
      const items = page().items;
      const g = selected, pieces = structuredClone(g.items);
      items.splice(items.indexOf(g), 1, ...pieces);
      selectMany(pieces);
      if (selected?.temp && g.frame) selected.frame = g.frame;
      renderBase();
      return;
    }
    replaceSelected();
    const it = selected;
    const each = leaves(it);
    for (const l of each) {
      const info = selInfo(l);
      if (op === 'color' && info.canColor) {
        if (l.type === 'text') l.paras = l.paras.map((p) => ({ ...p, r: p.r.map((run) => ({ ...run, c: v })) }));
        else l.color = v;
      } else if (op === 'fill' && info.canFill) {
        if (v === 'none') delete l.fill; else l.fill = v;
      } else if (op === 'size' && info.canThick) {
        l.size = info.sizes[Math.max(0, Math.min(2, v))];
      }
    }
    const fr = selFrame(it);
    if (op === 'turn') turnItem(it, v, fr.cx, fr.cy);
    else if (op === 'scale') {
      const [cx, cy] = [fr.cx, fr.cy];
      const start = structuredClone(it);
      const local = toLocal(it, cx, cy); // the centre stays put
      scaleFrom(it, start, local[0], local[1], v, it.type === 'shape' && it.shape === 'numline' ? 1 : v);
    }
    renderBase();
    updateStylePop();
  }

  // ---------- text boxes ----------
  // Text and Math: tap the board to start a text box, or tap one to change it. On the PC it's typed in place. From
  // the iPad or iPhone, the pad sees `editing` in the board's state, opens its own editor (with the math keyboard),
  // claims the box and sends the words as they're typed ('wb' {text}); the board draws them as they arrive.
  let editing = null; // { item, before, isNew, math, by: 'pc' | 'pad', rev, original, ox, ow }
  const newId = () => Math.random().toString(36).slice(2, 10);
  // Words start smaller on a student's board: 48 reads from the back of the room on the projector, but fills a
  // Chromebook's screen.
  const TEXT_Z = student || teamBoard || marking ? 32 : PadText.DEFAULT_Z;
  const MATH_Z = student || teamBoard || marking ? 36 : 56;
  const pcEditor = new PadText.Editor({
    scale: () => px(),
    defaultSize: TEXT_Z,
    links: !student && !teamBoard, // links are the teacher's: a student never adds one (the PC removes any that turn up)
    touch: go, // in PadLink Go, put formatting below the words so iPadOS's selection menu stays out of its way
    keysHost: $('#textKeys'),
    onChange: (paras) => {
      if (!editing) return;
      editing.item.paras = paras;
      editing.rev++;
      renderBase();
    },
    onDone: () => finishText(),
  });
  pcEditor.el.hidden = true;
  $('#textEdit').appendChild(pcEditor.el);
  let editorK = 0; // the editor's px per page unit, to redraw it after a zoom

  // While typing, the dashed box has a handle on each side: drag one to make the box wider or narrower, and the
  // words wrap to the new width (their size stays the same).
  const textGrips = ['l', 'r'].map((side) => {
    const g = document.createElement('div');
    g.className = 'text-grip';
    g.dataset.side = side;
    g.title = 'Drag to make the text box wider or narrower';
    g.hidden = true;
    $('#textEdit').appendChild(g);
    g.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays in the words
    g.addEventListener('pointerdown', (e) => {
      if (!editing || editing.by !== 'pc') return;
      e.preventDefault();
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      const it = editing.item;
      const from = e.clientX, x0 = it.x, w0 = it.w;
      const move = (ev) => {
        if (!editing || editing.item !== it) return;
        const d = (ev.clientX - from) / px();
        if (side === 'r') it.w = Math.max(60, Math.min(w0 + d, W - x0));
        else {
          const x = Math.max(0, Math.min(x0 + d, x0 + w0 - 60));
          it.w = w0 + (x0 - x);
          it.x = x;
        }
        renderBase();
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        if (editing) pcEditor.restore();
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    return g;
  });

  function textAt(x, y) {
    const find = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i];
        if (it.type === 'group') { const t = find(it.items); if (t) return t; }
        else if (it.type === 'text' && hits(it, x, y, 6)) return it;
      }
      return null;
    };
    return find(page().items);
  }

  /** Make <target> (on the page, or inside a group) this change's own copy, so Undo keeps the original: the group
   *  around it is copied too. Returns the copy. */
  function ownCopy(target) {
    const items = page().items;
    const path = (list, t) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i] === t) return [i];
        if (list[i].type === 'group') { const p = path(list[i].items, t); if (p) return [i, ...p]; }
      }
      return null;
    };
    const p = path(items, target);
    if (!p) return target;
    items[p[0]] = structuredClone(items[p[0]]);
    let node = items[p[0]];
    for (const i of p.slice(1)) node = node.items[i];
    return node;
  }

  /** The list an item is in: the page's, or a group's. */
  function listOf(target, list = page().items) {
    if (list.includes(target)) return list;
    for (const it of list) if (it.type === 'group') { const l = listOf(target, it.items); if (l) return l; }
    return null;
  }

  /** Start typing at (x, y): in the text box there, or a new one (a math box with the Math tool). */
  function beginText(x, y, kind) {
    finishText();
    const hit = textAt(x, y);
    const before = snapshot();
    let item;
    if (hit) {
      item = ownCopy(hit); // undo keeps the original (a text box in a group stays in the group)
    } else if (kind === 'note') {
      // A sticky note, centred where it was tapped, in the chosen color; its words are dark on the light paper.
      const P = PadEngine.NOTE_PAD, w = PadEngine.NOTE_W, side = w + P * 2;
      const left = Math.max(P + 10, Math.min(x - side / 2 + P, W - w - P - 10));
      item = { type: 'text', note: true, fill: settings.note.color, id: newId(), x: left, y: Math.max(P + 10, y - side / 2 + P), w, paras: [{ r: [] }] };
      page().items.push(item);
    } else {
      const z = kind === 'math' ? MATH_Z : TEXT_Z;
      const ink = isDark(page()) ? '#ffffff' : '#1f2328';
      const left = Math.max(10, Math.min(x, W - 210));
      item = { type: 'text', id: newId(), x: left, y: Math.max(0, y - z * 0.7), w: Math.min(kind === 'math' ? 520 : 720, W - left - 10), paras: [{ r: kind === 'math' ? [{ m: [], c: ink, z }] : [] }] };
      page().items.push(item);
    }
    select(null);
    editing = { item, before, isNew: !hit, math: kind === 'math' && !hit, by: 'pc', rev: 0, original: JSON.stringify(hit ? hit.paras : null), ox: item.x, ow: item.w };
    pcEditor.text.style.color = isDark(page()) && !item.note ? '#ffffff' : '#1f2328';
    pcEditor.open(item.paras, { math: editing.math });
    editorK = px();
    renderBase();
  }

  /** Keep the PC's editor over its text box (after a zoom or scroll, at the new size). */
  function placePcEditor() {
    const show = !!editing && editing.by === 'pc';
    for (const g of textGrips) g.hidden = !show;
    if (!show) { if (!pcEditor.el.hidden) pcEditor.close(); return; }
    const k = px();
    if (Math.abs(k - editorK) > 1e-6) { editorK = k; pcEditor.rescale(); }
    const it = editing.item;
    const el = pcEditor.el;
    el.style.left = `${(it.x - view.x) * k}px`;
    el.style.top = `${(it.y - view.y) * k}px`;
    el.style.width = `${it.w * k}px`;
    el.querySelector('.rt-bar').classList.toggle('below', (it.y - view.y) * k < 70);
    const mid = (it.y - view.y) * k + pcEditor.text.offsetHeight / 2;
    for (const g of textGrips) {
      g.style.left = `${(it.x - view.x + (g.dataset.side === 'r' ? it.w : 0)) * k + (g.dataset.side === 'r' ? 6 : -6)}px`;
      g.style.top = `${mid}px`;
    }
  }

  /** The pad's editor: it took the box over, sent the words so far, or is done. */
  function padText(t) {
    if ((t.claim || t.paras) && editing.by === 'pc') { editing.by = 'pad'; pcEditor.close(); }
    if (t.paras) editing.item.paras = PadText.clean(t.paras);
    if (t.done) finishText();
    else renderBase();
  }

  /** Done typing: an empty box goes away; a changed one is one step for Undo. */
  function finishText() {
    if (!editing) return;
    const e = editing;
    editing = null;
    pcEditor.close();
    const items = listOf(e.item) || page().items;
    const empty = PadText.isEmpty(e.item.paras) && !e.item.note; // a blank sticky note stays (one to fill in later)
    if (empty) { const i = items.indexOf(e.item); if (i >= 0) items.splice(i, 1); }
    const resized = e.item.x !== e.ox || e.item.w !== e.ow;
    const changed = e.isNew ? !empty : empty || resized || JSON.stringify(e.item.paras) !== e.original;
    if (changed) {
      undoStack.push(e.before);
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
    }
    if (!empty) { const b = bounds(e.item); growFor(b.y + b.h); }
    renderBase();
  }

  // ---------- pages ----------
  function goTo(i) {
    finishText();
    cur = Math.max(0, Math.min(pages.length - 1, i));
    view.z = 1; view.x = 0; view.y = 0; // each page starts zoomed out
    select(null);
    renderBase();
  }

  // Page menu (tap the page number): add, duplicate, delete, and the page's picture/background.
  const pageMenu = $('#pageMenu');
  $('#pageNo').addEventListener('click', (e) => {
    e.stopPropagation();
    if (marking) return; // the student's pages are theirs: no adding, moving or deleting them from here
    if (!pageMenu.hidden) { pageMenu.hidden = true; return; }
    const hasDoc = !!page().doc;
    $('#pmRemoveDoc').hidden = !hasDoc;
    $('#pmUnlockDoc').hidden = !hasDoc;
    $('#pmDelete').querySelector('b').textContent = pages.length > 1 ? 'Delete this page' : 'Clear this page';
    pageMenu.hidden = false;
    renderPagesPanel();
  });
  $('#ppClose').addEventListener('click', () => { pageMenu.hidden = true; });

  // ---------- Pages: every page as a picture; click to go there, drag to move it ----------
  /** A small picture of a page (the top of it, for a tall page). */
  function pagePicture(p, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.setTransform(w / W, 0, 0, w / W, 0, 0);
    renderPage(g, p);
    return c;
  }

  function renderPagesPanel() {
    if (pageMenu.hidden) return;
    const hasDoc = !!page().doc;
    $('#pmRemoveDoc').hidden = !hasDoc;
    $('#pmUnlockDoc').hidden = !hasDoc;
    $('#pmDelete').querySelector('b').textContent = pages.length > 1 ? 'Delete page' : 'Clear page';
    $('#ppCount').textContent = `Page ${cur + 1} of ${pages.length}`;
    const strip = $('#ppStrip');
    const keep = strip.scrollLeft;
    strip.innerHTML = '';
    pages.forEach((p, i) => {
      const t = document.createElement('div');
      t.className = 'pp-page' + (i === cur ? ' on' : '');
      t.dataset.i = i;
      t.setAttribute('role', 'option');
      t.setAttribute('aria-selected', String(i === cur));
      t.append(pagePicture(p, 352, 198), Object.assign(document.createElement('span'), { textContent: String(i + 1) }));
      if (pollUiReady && teacherBoard && pollSpec(p)) t.append(Object.assign(document.createElement('b'), { className: 'pp-poll', textContent: '📊', title: 'This page has a poll' }));
      strip.appendChild(t);
    });
    strip.scrollLeft = keep;
    const on = strip.children[cur];
    if (on && (on.offsetLeft < strip.scrollLeft || on.offsetLeft + on.offsetWidth > strip.scrollLeft + strip.clientWidth)) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2;
  }

  /** Move page <from> to position <to> (the page you're on stays the one you're on). */
  function movePage(from, to) {
    to = Math.max(0, Math.min(pages.length - 1, to));
    if (from === to || from < 0 || from >= pages.length) return;
    finishText();
    const here = pages[cur];
    const [p] = pages.splice(from, 1);
    pages.splice(to, 0, p);
    cur = pages.indexOf(here);
    select(null);
    renderBase();
    renderPagesPanel();
  }

  // Click a page to go there. Drag it to move it: with a mouse straight away; with a finger or pen, hold it first
  // (otherwise the drag scrolls the row).
  {
    const strip = $('#ppStrip');
    let press = null; // { i, x0, y0, pointerId, mouse, lifted, scrolled, hold, ghost, drop, scroll0 }
    const dropAt = (x) => {
      const kids = [...strip.children];
      let to = kids.length;
      for (let k = 0; k < kids.length; k++) {
        const r = kids[k].getBoundingClientRect();
        if (x < r.left + r.width / 2) { to = k; break; }
      }
      return to; // insert before this index (in the list as it is now)
    };
    const showDrop = (to) => {
      for (const k of strip.children) k.classList.remove('drop-before', 'drop-after');
      const kids = strip.children;
      if (to < kids.length) kids[to].classList.add('drop-before'); else if (kids.length) kids[kids.length - 1].classList.add('drop-after');
    };
    const lift = (e) => {
      press.lifted = true;
      const t = strip.children[press.i];
      t.classList.add('lifted');
      const pic = t.querySelector('canvas').cloneNode(false);
      pic.getContext('2d').drawImage(t.querySelector('canvas'), 0, 0);
      pic.className = 'pp-ghost';
      pic.style.width = '176px';
      pic.style.height = '99px';
      document.body.appendChild(pic);
      press.ghost = pic;
      moveGhost(e);
    };
    const moveGhost = (e) => {
      press.ghost.style.left = `${e.clientX - 88}px`;
      press.ghost.style.top = `${e.clientY - 50}px`;
      press.drop = dropAt(e.clientX);
      showDrop(press.drop);
      // Near an end: scroll that way
      const r = strip.getBoundingClientRect();
      if (e.clientX < r.left + 40) strip.scrollLeft -= 20; else if (e.clientX > r.right - 40) strip.scrollLeft += 20;
    };
    strip.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('.pp-page');
      if (!t) return;
      try { strip.setPointerCapture(e.pointerId); } catch { /* gone */ }
      press = { i: Number(t.dataset.i), x0: e.clientX, y0: e.clientY, mouse: e.pointerType === 'mouse', lifted: false, scrolled: false, scroll0: strip.scrollLeft };
      if (!press.mouse) press.hold = setTimeout(() => { if (press && !press.scrolled) lift(e); }, 350);
    });
    strip.addEventListener('pointermove', (e) => {
      if (!press) return;
      const dx = e.clientX - press.x0;
      if (press.lifted) { moveGhost(e); return; }
      if (Math.abs(dx) < 6 && Math.abs(e.clientY - press.y0) < 6) return;
      if (press.mouse) { lift(e); return; }
      press.scrolled = true; // a finger or pen moving before the hold: scroll the row
      clearTimeout(press.hold);
      strip.scrollLeft = press.scroll0 - dx;
    });
    const end = (e, cancelled) => {
      if (!press) return;
      const p = press;
      press = null;
      clearTimeout(p.hold);
      for (const k of strip.children) k.classList.remove('drop-before', 'drop-after', 'lifted');
      p.ghost?.remove();
      if (cancelled) return;
      if (p.lifted) {
        let to = p.drop ?? p.i;
        if (to > p.i) to--; // the page itself leaves its place first
        movePage(p.i, to);
      } else if (!p.scrolled) {
        if (p.i !== cur && !allowed('move')) return; // a student kept on this page by the teacher
        goTo(p.i);
        renderPagesPanel();
      }
    };
    strip.addEventListener('pointerup', (e) => end(e, false));
    strip.addEventListener('pointercancel', (e) => end(e, true));
    strip.addEventListener('wheel', (e) => { e.preventDefault(); strip.scrollLeft += e.deltaY + e.deltaX; }, { passive: false });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!pageMenu.hidden && !pageMenu.contains(e.target) && e.target.id !== 'pageNo') pageMenu.hidden = true;
  }, true);

  $('#pmNew').addEventListener('click', () => {
    pageMenu.hidden = true;
    if (!allowed('pages')) return;
    pages.splice(cur + 1, 0, newPage(page().bg === 'dark' ? 'dark' : 'white'));
    goTo(cur + 1);
  });
  function duplicatePage() {
    finishText();
    if (!allowed('pages')) return;
    const p = page();
    pages.splice(cur + 1, 0, { bg: p.bg, h: ph(p), doc: p.doc ? { ...p.doc } : null, items: structuredClone(p.items) });
    goTo(cur + 1);
    toast('Duplicated the page.');
  }
  /** Delete this page (the only page: clear it instead). Asked first, here or on the pad. */
  function deletePage() {
    finishText();
    if (pages.length === 1) {
      pages[0] = newPage(page().bg);
      undoStack.length = redoStack.length = 0;
      goTo(0);
      return;
    }
    pages.splice(cur, 1);
    // Undo history points at page numbers; after a deletion it would point at the wrong pages.
    undoStack.length = redoStack.length = 0;
    goTo(Math.min(cur, pages.length - 1));
    toast('Page deleted.');
  }
  function removePagePicture() {
    if (!page().doc || !allowed('clear')) return;
    pushUndo();
    page().doc = null;
    renderBase();
    toast('Removed the page’s picture. Undo brings it back.');
  }
  $('#pmDuplicate').addEventListener('click', () => { pageMenu.hidden = true; duplicatePage(); });
  $('#pmDelete').addEventListener('click', () => {
    pageMenu.hidden = true;
    if (!allowed('pages')) return;
    if (pages.length === 1 ? !confirm('Clear this page? Drawings and its picture/background will be removed.') : !confirm(`Delete page ${cur + 1}? This can't be undone.`)) return;
    deletePage();
  });
  $('#pmRemoveDoc').addEventListener('click', () => { pageMenu.hidden = true; removePagePicture(); });
  $('#pmUnlockDoc').addEventListener('click', () => {
    // Turn the fixed background picture into a normal picture: move, resize or delete it with Select.
    pageMenu.hidden = true;
    pushUndo();
    const d = page().doc;
    const item = { type: 'image', img: d.img, x: d.x, y: d.y, w: d.w, h: d.h };
    page().doc = null;
    page().items.unshift(item); // keep it underneath the drawings
    setTool('select');
    select(item);
    renderBase();
    toast('The picture can now be moved, resized or deleted.');
  });
  // (A student's board: the teacher can keep students on the page they're on: Moving between pages, off.)
  $('#prev').addEventListener('click', () => { if (allowed('move')) goTo(cur - 1); });
  $('#next').addEventListener('click', () => { if (allowed('move')) goTo(cur + 1); });
  function addPageAfter() {
    if (!allowed('pages')) return;
    pages.splice(cur + 1, 0, newPage(page().bg === 'dark' ? 'dark' : 'white'));
    goTo(cur + 1);
  }
  $('#addPage').addEventListener('click', (e) => {
    // iPadOS can finish the touch that reopened a suspended Home Screen app over the bottom page bar. Do not turn
    // that launch/resume touch into a new blank page; keyboard and intentional taps after the app settles still work.
    if (go && e.isTrusted && e.detail > 0 && performance.now() - foregroundAt < 700) return;
    e.currentTarget.blur(); // a keyboard's Enter or Space later mustn't add another page
    addPageAfter();
  });
  const BACKGROUNDS = new Set(['white', 'grid', 'lines', 'dots', 'dark']);
  /** The page's background (the top bar's list, or the pad's page menu). */
  function setBackground(bg) {
    if (!BACKGROUNDS.has(bg) || (page().bg || 'white') === bg) return;
    pushUndo();
    page().bg = bg;
    renderBase();
    reportState();
  }
  $('#background').addEventListener('change', (e) => setBackground(e.target.value));

  // ---------- saved boards (autosave to %LocalAppData%\PadLink\Boards on the PC) ----------
  const imageData = new Map(); // image id -> data URL, to save pictures with the board
  let sentImages = new Set();  // image ids the PC already has for this board
  let boardId = null;
  let boardName = '';
  let lastSavedJson = '';
  let saveTimer = 0;
  let loadingBoard = false;
  let boardLoading = Promise.resolve(); // a board opening (its pictures load first)

  const newBoardId = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const defaultName = () => student ? student.name : 'Board · ' + new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  // Ransomware protection (Malwarebytes and others) watches for programs rewriting files again and again, and once
  // stopped PadLink for it. So the teacher's own board saves 5 seconds after the last change, and right away whenever it
  // matters: switching boards, hiding the whiteboard, PadLink closing. A team board saves quickly, for its teammates; a
  // student's board (kept only in the PC's memory) and PadLink Go (saved on the iPad itself) as before. The thumbnail is
  // only rewritten when it changed, at most every 30 seconds while working.
  const SAVE_DELAY = teamBoard || marking ? 400 : go || student ? 1500 : 5000;
  const THUMB_EVERY = student || teamBoard ? 0 : 30000; // students' thumbnails are the teacher's live class grid
  let lastThumb = '';
  let lastThumbAt = -Infinity;
  let thumbBehind = false; // a save skipped the thumbnail: the next prompt save brings it up to date
  function resetThumb() { lastThumb = ''; lastThumbAt = -Infinity; thumbBehind = false; }

  function scheduleSave() {
    if (!host || loadingBoard || !boardId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(false), SAVE_DELAY);
  }

  /** Save the board if it changed. prompt: a moment that matters (not just a pause in the work): the thumbnail too. */
  function saveNow(prompt = true) {
    clearTimeout(saveTimer);
    if (!host || loadingBoard || !boardId) return;
    // A team board: every one of this student's own items gets an id, so their teammates' boards can follow each one.
    if (teamBoard) for (const p of pages) for (const it of p.items) if (!it.by && !it.id) it.id = newId();
    // Marking: so is every new mark of the teacher's (mark-host.js follows each one to the PC).
    if (marking) for (const p of pages) for (const it of p.items) if (!locked(it) && !it.tid && !it.id) it.id = newId();
    const state = { pages, cur };
    const json = JSON.stringify(state);
    const changed = json !== lastSavedJson;
    const urgent = prompt !== false; // (also an event, as a pagehide listener)
    if (!changed && !(urgent && thumbBehind)) return;
    const msg = { type: 'boardSave', id: boardId, name: boardName, state, images: {} };
    if (changed) for (const [id, url] of imageData) if (!sentImages.has(id)) msg.images[id] = url;
    if (urgent || performance.now() - lastThumbAt >= THUMB_EVERY) {
      const t = thumbnail();
      lastThumbAt = performance.now();
      thumbBehind = false;
      if (t !== lastThumb) { msg.thumb = t; lastThumb = t; }
    } else thumbBehind = true;
    if (!changed && !msg.thumb) return;
    post(msg);
    for (const id of Object.keys(msg.images)) sentImages.add(Number(id));
    lastSavedJson = json;
    setSaveState('Saving…');
  }

  /** A small picture of the board: its first page (a student's: the page they're on, for the teacher's grid). */
  function thumbnail() {
    const c = document.createElement('canvas');
    const w = student ? 400 : 320;
    c.width = w;
    c.height = Math.round(w * 9 / 16);
    const g = c.getContext('2d');
    g.setTransform(w / W, 0, 0, w / W, 0, 0);
    renderPage(g, student ? page() : pages[0]);
    return c.toDataURL('image/jpeg', 0.7);
  }

  function setSaveState(text) {
    $('#saveState').textContent = text;
  }

  function updateBoardUI() {
    $('#boardName').textContent = boardName;
    $('#boardsBtn').title = go ? `Boards: “${boardName}” is saved on this device` : `Boards: “${boardName}” is saved on this PC`;
  }

  function startNewBoard() {
    saveNow(); // keep the current one first
    pages.length = 0;
    pages.push(newPage('white'));
    images.clear();
    imageData.clear();
    sentImages = new Set();
    nextImageId = 1;
    undoStack.length = redoStack.length = 0;
    boardId = newBoardId();
    boardName = defaultName();
    lastSavedJson = JSON.stringify({ pages, cur: 0 }); // an empty board isn't saved until something is added
    resetThumb();
    updateBoardUI();
    setSaveState('');
    goTo(0);
  }

  async function loadBoard(msg) {
    loadingBoard = true;
    try {
      images.clear();
      imageData.clear();
      let maxId = 0;
      await Promise.all(Object.entries(msg.images || {}).map(([id, url]) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { images.set(Number(id), img); imageData.set(Number(id), url); resolve(); };
        img.onerror = resolve; // a missing picture just doesn't draw
        img.src = url;
        maxId = Math.max(maxId, Number(id));
      })));
      sentImages = new Set([...imageData.keys()]);
      nextImageId = maxId + 1;
      pages.length = 0;
      pages.push(...(msg.state.pages && msg.state.pages.length ? msg.state.pages : [newPage('white')]));
      undoStack.length = redoStack.length = 0;
      boardId = msg.id;
      boardName = msg.name || defaultName();
      lastSavedJson = JSON.stringify({ pages, cur: Math.min(msg.state.cur || 0, pages.length - 1) });
      resetThumb();
    } finally {
      loadingBoard = false;
    }
    updateBoardUI();
    setSaveState('Saved');
    goTo(Math.min(msg.state.cur || 0, pages.length - 1));
  }

  // Boards menu
  const boardsMenu = $('#boardsMenu');
  $('#boardsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!boardsMenu.hidden) { boardsMenu.hidden = true; return; }
    if (student || marking) return; // a student's board is just theirs: no saved boards to choose from
    if (!host) { toast('Saving boards works inside PadLink on the PC.'); return; }
    saveNow();
    $('#boardsList').innerHTML = '<div class="empty">Loading saved boards…</div>';
    $('#currentBoard').textContent = boardName;
    boardsMenu.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    boardsMenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - boardsMenu.offsetWidth - 8))}px`;
    boardsMenu.style.top = `${r.bottom + 6}px`;
    post({ type: 'boardList' });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!boardsMenu.hidden && !boardsMenu.contains(e.target) && !$('#boardsBtn').contains(e.target)) boardsMenu.hidden = true;
  }, true);

  $('#renameBoard').addEventListener('click', () => {
    const name = prompt('Name this board', boardName);
    if (!name || !name.trim()) return;
    boardName = name.trim().slice(0, 80);
    $('#currentBoard').textContent = boardName;
    updateBoardUI();
    lastSavedJson = ''; // force a save so the new name is stored
    saveNow();
  });
  $('#newBoard').addEventListener('click', () => {
    boardsMenu.hidden = true;
    startNewBoard();
    toast('Started a new board. The previous one is saved.');
  });
  $('#copyBoard').addEventListener('click', () => {
    boardsMenu.hidden = true;
    saveNow();
    const name = `${boardName} (copy)`;
    post({ type: 'boardSave', id: newBoardId(), name, state: { pages, cur }, images: Object.fromEntries(imageData), thumb: thumbnail() });
    toast(`Saved a copy: “${name}”. You’re still on this board.`);
  });
  $('#openBoardsFolder').addEventListener('click', () => post({ type: 'openBoardsFolder' }));
  // A board as one file (.padlink): pages and every picture, to keep anywhere and double-click to open.
  $('#exportBoard').addEventListener('click', () => {
    boardsMenu.hidden = true;
    finishText();
    saveNow();
    post({ type: 'boardExport', name: boardName, state: { pages, cur }, images: Object.fromEntries(imageData), thumb: thumbnail() });
  });
  $('#importBoardFile').addEventListener('click', () => {
    boardsMenu.hidden = true;
    saveNow(); // this one stays saved
    post({ type: 'boardImportFile' });
  });

  // PadLink Go: boards prepared on the teacher's iPad or iPhone are sent here. Pairing a device (once) needs this PC's
  // QR code (Remote mode's link and a one-time code, made by MainForm) and Allow on this PC.
  const goDialog = $('#goDialog');
  $('#goBoards').addEventListener('click', () => {
    boardsMenu.hidden = true;
    $('#goQr').removeAttribute('src');
    $('#goPairNote').textContent = 'Making a pairing code…';
    $('#goPairNote').className = 'sub';
    goDialog.hidden = false;
    post({ type: 'goPair', refresh: true }); // the code PadLink's window shows now
  });
  $('#goNewCode').addEventListener('click', () => post({ type: 'goPair' })); // a new code, here and in the window
  const closeGoDialog = () => { goDialog.hidden = true; post({ type: 'goPairClosed' }); };
  $('#goClose').addEventListener('click', closeGoDialog);
  goDialog.addEventListener('pointerdown', (e) => { if (e.target === goDialog) closeGoDialog(); });
  function showGoPair(msg) {
    const note = $('#goPairNote');
    $('#goPairBox').classList.toggle('off', !msg.qr);
    if (msg.qr) $('#goQr').src = msg.qr;
    note.textContent = msg.error || (msg.qr ? 'The same code as in PadLink’s window. It changes every 10 minutes (New code: now).' : '');
    note.className = msg.error ? 'sub warn' : 'sub';
    $('#goNewCode').hidden = !msg.qr;
    const list = $('#goDevices');
    list.innerHTML = '';
    if (!msg.devices || !msg.devices.length) { list.innerHTML = '<div class="empty">None yet.</div>'; return; }
    for (const d of msg.devices) {
      const row = document.createElement('div');
      row.className = 'go-device';
      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = d.name;
      const info = document.createElement('small');
      info.textContent = d.sendOnly ? `Sends boards only · last used ${d.lastSeen}` : `Last used ${d.lastSeen}`;
      text.append(name, info);
      const forget = document.createElement('button');
      forget.textContent = 'Forget';
      forget.addEventListener('click', () => {
        if (!confirm(`Forget “${d.name}”? It will need to connect again (scan the code, Allow). Boards it sent stay.`)) return;
        post({ type: 'goForget', hash: d.hash });
      });
      row.append(text, forget);
      list.appendChild(row);
    }
  }
  /** A board arrived from PadLink Go: say so; if it's the one open (and unchanged here), show the new version. */
  function boardArrived(msg) {
    toast(`“${msg.name}” arrived from PadLink Go${msg.copy ? ' as a copy (you had changed it here)' : ''}. It's in Boards.`, 6000);
    if (!msg.copy && msg.id === boardId) { saveNow(); post({ type: 'boardOpen', id: msg.id }); }
    if (!boardsMenu.hidden) post({ type: 'boardList' });
    if (!goDialog.hidden) post({ type: 'goPair', refresh: true });
  }

  function showBoards(list) {
    const box = $('#boardsList');
    box.innerHTML = '';
    const others = list.filter((b) => b.id !== boardId);
    if (!others.length) { box.innerHTML = '<div class="empty">No other boards yet. Each board saves itself as you work: start a New board, and this one shows up here to open again.</div>'; return; }
    for (const b of others) {
      const row = document.createElement('div');
      row.className = 'board-row';
      const open = document.createElement('button');
      open.className = 'board-open';
      if (b.thumb) { const im = document.createElement('img'); im.src = b.thumb; im.alt = ''; open.appendChild(im); }
      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = b.name;
      const info = document.createElement('small');
      info.textContent = `${b.modified} · ${b.pages} page${b.pages === 1 ? '' : 's'}`;
      text.append(name, info);
      open.appendChild(text);
      open.addEventListener('click', () => {
        saveNow();
        boardsMenu.hidden = true;
        toast('Opening ' + b.name + '…');
        post({ type: 'boardOpen', id: b.id });
      });
      const del = document.createElement('button');
      del.className = 'board-del';
      del.title = 'Delete this board';
      del.setAttribute('aria-label', 'Delete ' + b.name);
      del.innerHTML = '<svg class="i"><use href="#b-trash"/></svg>';
      del.addEventListener('click', () => {
        if (!confirm(`Delete “${b.name}”? This can't be undone.`)) return;
        post({ type: 'boardDelete', id: b.id });
      });
      row.append(open, del);
      box.appendChild(row);
    }
  }

  // ---------- Student Mode: pages the teacher sends ----------
  /** Send my page: a copy of this page (and the pictures on it) for every student's own board. */
  function sendPageToStudents() {
    finishText();
    const p = page();
    const copy = JSON.parse(JSON.stringify(p));
    delete copy.sent;
    delete copy.poll; // the page's poll (and its correct answer) is the teacher's
    const ids = new Set();
    if (p.doc) ids.add(p.doc.img);
    for (const it of p.items) imagesIn(it, ids);
    const imgs = {};
    for (const id of ids) { const url = imageData.get(id); if (url) imgs[id] = url; }
    post({ type: 'forStudents', page: copy, images: imgs });
  }

  /** A student's board: the teacher sent a page. It's added at the end (once), and shown. */
  async function addSentPage(msg) {
    const p = msg.page;
    if (!p || !Array.isArray(p.items) || pages.some((q) => q.sent === msg.sid)) return;
    const ids = new Map(); // the teacher's picture ids -> this board's
    for (const [id, url] of Object.entries(msg.images || {})) {
      try { ids.set(Number(id), (await addImage(url)).id); } catch { /* a picture that can't load just doesn't draw */ }
    }
    const fix = (it) => {
      if (it.type === 'image') it.img = ids.get(it.img) ?? -1;
      else if (it.type === 'group') it.items.forEach(fix);
    };
    p.items.forEach(fix);
    if (p.doc) p.doc.img = ids.get(p.doc.img) ?? -1;
    p.sent = msg.sid;
    p.h = p.h || H;
    p.bg = p.bg || 'white';
    const empty = !teamBoard && pages.length === 1 && !pages[0].items.length && !pages[0].doc; // a new board: this page instead (a team board keeps its pages as the PC has them)
    if (empty) pages[0] = p;
    else pages.push(p);
    goTo(pages.length - 1);
    scheduleSave();
    toast(empty ? 'Your teacher sent you a page to work on.' : `Your teacher sent you a page to work on: it’s page ${pages.length}.`, 6000);
  }

  /** Marking a student's board: their work (and their teammates') as it is now, in place of what's locked here; the
   *  teacher's own marks stay as they are. A page the student added comes in too. */
  async function markOthers(m) {
    if (!marking || !Array.isArray(m.pages)) return;
    for (const [id, url] of Object.entries(m.images || {})) {
      const n = Number(id);
      if (images.has(n)) continue;
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { images.set(n, img); imageData.set(n, url); nextImageId = Math.max(nextImageId, n + 1); resolve(); };
        img.onerror = resolve;
        img.src = url;
      });
    }
    m.pages.forEach((fp, i) => {
      let p = pages[i];
      if (!p) { p = newPage(fp.bg || 'white'); pages.push(p); }
      p.bg = fp.bg || 'white';
      p.h = Math.max(fp.h || H, p.h || H);
      p.doc = fp.doc || null;
      p.items = (fp.items || []).concat(p.items.filter((it) => !locked(it)));
    });
    renderBase();
  }

  // ---------- a student's board shown to the class (from the teacher's grid of student boards) ----------
  const shown = { el: null, canvas: null, msg: null, images: new Map() };
  function showStudent(msg) {
    if (msg.off) {
      if (shown.el) shown.el.hidden = true;
      shown.msg = null;
      return;
    }
    if (!shown.el) {
      shown.el = document.createElement('div');
      shown.el.className = 'shown-board';
      shown.el.innerHTML = '<div class="shown-bar"><svg class="shown-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/></svg><b class="shown-title"></b><span class="shown-page"></span><button class="shown-stop">Stop showing</button></div><div class="shown-stage"><canvas></canvas></div>';
      document.body.appendChild(shown.el);
      shown.canvas = shown.el.querySelector('canvas');
      shown.el.querySelector('.shown-stop').addEventListener('click', () => post({ type: 'stopShowing' }));
      // The Laser tool works over the board on show too (the class sees it there, and on their screens).
      const stage = shown.el.querySelector('.shown-stage');
      let lasering = false;
      stage.addEventListener('pointerdown', (e) => {
        if (tool !== 'laser' || e.button !== 0) return;
        e.preventDefault();
        lasering = true;
        try { stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        laserAt([laserPoint(e)], true);
      });
      stage.addEventListener('pointermove', (e) => {
        if (!lasering) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        laserAt((events.length ? events : [e]).map(laserPoint), true);
      });
      for (const type of ['pointerup', 'pointercancel']) stage.addEventListener(type, () => { if (lasering) { lasering = false; laserAt([], false); } });
      addEventListener('resize', () => { if (shown.msg) drawShown(); });
    }
    if (!shown.msg || shown.msg.key !== msg.key) shown.images.clear(); // another student: their pictures
    shown.msg = msg;
    shown.el.hidden = false;
    shown.el.querySelector('.shown-title').textContent = msg.name ? `${msg.name}’s board` : 'A student’s board';
    shown.el.querySelector('.shown-page').textContent = msg.pages > 1 ? `Page ${msg.pageNo} of ${msg.pages}` : '';
    const loads = Object.entries(msg.images || {}).filter(([id]) => !shown.images.has(Number(id))).map(([id, url]) => new Promise((done) => {
      const img = new Image();
      img.onload = img.onerror = done;
      img.src = url;
      shown.images.set(Number(id), img);
    }));
    Promise.all(loads).then(() => { if (shown.msg === msg) drawShown(); });
    drawShown();
  }
  function drawShown() {
    const m = shown.msg, c = shown.canvas;
    if (!m || !c) return;
    const stage = shown.el.querySelector('.shown-stage');
    const p = m.page || { items: [] };
    const roomW = stage.clientWidth - 48, roomH = stage.clientHeight - 48;
    const w = Math.max(200, Math.min(roomW, roomH * W / H)), k = w / W, h = (p.h || H) * k;
    const dpr = window.devicePixelRatio || 1;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    // The engine draws this board's pictures; the student's, just while drawing theirs.
    const hooks = PadEngine.configure({});
    const own = hooks.image;
    PadEngine.configure({ image: (id) => shown.images.get(id) || null });
    try { PadEngine.renderPage(g, { bg: p.bg || 'white', h: p.h || H, doc: p.doc, items: p.items || [] }); }
    catch (e) { console.warn('Showing a student board:', e); }
    finally { PadEngine.configure({ image: own }); }
    shownScroll(m.scroll ?? 0);
  }

  /** Scroll the board on show to where the teacher is looking (a share of the page's height from the top). */
  function shownScroll(y) {
    if (!shown.msg || !shown.canvas || !Number.isFinite(y)) return;
    shown.msg.scroll = y;
    shown.el.querySelector('.shown-stage').scrollTop = y * shown.canvas.offsetHeight;
  }

  /** A student's board: the teacher's mark (added once, on its page) or the teacher taking one back. */
  let teacherNoted = -Infinity;
  function teacherInk(m) {
    if (m.op === 'add' && m.item && m.tid) {
      if (pages.some((p) => p.items.some((it) => it.tid === m.tid))) return; // already here
      const i = Math.max(0, Math.min(pages.length - 1, m.page | 0));
      pages[i].items.push(m.item);
      if (i === cur) renderBase();
      scheduleSave();
      if (m.item.by === 'teacher' && performance.now() - teacherNoted > 20000) { // not for every stroke (nor a teammate's)
        teacherNoted = performance.now();
        toast(i === cur ? 'Your teacher wrote on your board.' : `Your teacher wrote on page ${i + 1} of your board.`, 5000);
      }
    } else if (m.op === 'update' && m.item && m.tid) {
      // A teammate changed one of their marks (moved it, typed in it): in its place.
      let found = false;
      pages.forEach((p, i) => {
        const at = p.items.findIndex((it) => it.tid === m.tid);
        if (at < 0) return;
        p.items[at] = m.item;
        found = true;
        if (i === cur) renderBase();
      });
      if (!found) return teacherInk({ ...m, op: 'add' });
      scheduleSave();
    } else if (m.op === 'eraseOwn' && m.id != null) {
      // The teacher took away one of this student's own marks on the team board.
      pages.forEach((p, i) => {
        const at = p.items.findIndex((it) => !it.by && String(it.id) === String(m.id));
        if (at < 0) return;
        p.items.splice(at, 1);
        if (i === cur) renderBase();
        scheduleSave();
      });
    } else if (m.op === 'erase' && m.tid) {
      pages.forEach((p, i) => {
        const at = p.items.findIndex((it) => it.tid === m.tid);
        if (at < 0) return;
        p.items.splice(at, 1);
        if (i === cur) renderBase();
        scheduleSave();
      });
    }
  }

  // Save right away when the board is hidden or PadLink closes it.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  window.addEventListener('pagehide', saveNow);

  // ---------- import ----------
  function addImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const id = nextImageId++;
        images.set(id, img);
        imageData.set(id, dataUrl); // kept for saving the board
        resolve({ id, img });
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /** Fit w×h inside the box, centred. */
  function fit(w, h, bw, bh, bx = 0, by = 0) {
    const k = Math.min(bw / w, bh / h);
    return { x: bx + (bw - w * k) / 2, y: by + (bh - h * k) / 2, w: w * k, h: h * k };
  }

  async function placeImage(dataUrl, offset = 0) {
    if (!allowed('pictures')) return;
    const { id, img } = await addImage(dataUrl);
    const box = fit(img.naturalWidth, img.naturalHeight, W * 0.6, H * 0.6, W * 0.2, H * 0.2);
    // Don't upscale small pictures past their real size.
    if (box.w > img.naturalWidth) Object.assign(box, fit(img.naturalWidth, img.naturalHeight, img.naturalWidth, img.naturalHeight, (W - img.naturalWidth) / 2, (H - img.naturalHeight) / 2));
    // In view, also when a tall page is scrolled down.
    const item = { type: 'image', img: id, x: box.x + offset, y: box.y + offset + view.y, w: box.w, h: box.h };
    pushUndo();
    page().items.push(item);
    growFor(item.y + item.h);
    setTool('select');
    select(item);
    renderBase();
  }

  // PadLink Go: Add offers a picture or PDF from the device, or Google Drive (the device's chooser still opens straight
  // from a tap: the first choice's).
  let goAdd = null;
  if (go) {
    goAdd = document.createElement('div');
    goAdd.className = 'go-add-menu';
    goAdd.hidden = true;
    goAdd.setAttribute('role', 'menu');
    goAdd.innerHTML = `
      <button data-goadd="file" role="menuitem"><svg class="i"><use href="#b-import"/></svg><span>Photo, picture or PDF<small>From Photos, the camera or Files</small></span></button>
      <button data-goadd="drive" role="menuitem"><span class="drive-logo">${window.PadDrive ? PadDrive.LOGO : ''}</span><span>Google Drive<small>Needs the internet, not the PC</small></span></button>`;
    document.body.appendChild(goAdd);
    goAdd.querySelector('[data-goadd=file]').addEventListener('click', () => { goAdd.hidden = true; post({ type: 'import' }); });
    goAdd.querySelector('[data-goadd=drive]').addEventListener('click', () => { goAdd.hidden = true; $('#driveDialog').hidden = false; });
    document.addEventListener('pointerdown', (e) => { if (!goAdd.hidden && !goAdd.contains(e.target) && !e.target.closest('#import')) goAdd.hidden = true; }, true);
  }
  $('#import').addEventListener('click', () => {
    if (goAdd) {
      const r = $('#import').getBoundingClientRect();
      goAdd.style.top = `${r.bottom + 8}px`;
      goAdd.style.left = `${Math.max(8, Math.min(innerWidth - 268, r.right - 260))}px`;
      goAdd.hidden = !goAdd.hidden;
      return;
    }
    if (host) post({ type: 'import' });
    else $('#fileFallback').click(); // plain browser: images only
  });
  $('#fileFallback').addEventListener('change', async (e) => {
    let offset = 0;
    for (const file of e.target.files) {
      const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      await placeImage(url, offset);
      offset += 30;
    }
    e.target.value = '';
  });

  // PDF page picker
  let pdf = null; // { id, name, pageCount, sizes, chosen: Set, placement, insertAt, added, offset }
  let pdfWork = Promise.resolve(); // the pages arriving, added one after another

  function openPicker(msg) {
    pdf = { id: msg.id, name: msg.name, pageCount: msg.pageCount, sizes: msg.sizes, chosen: new Set() };
    for (let i = 0; i < msg.pageCount; i++) pdf.chosen.add(i);
    if (msg.auto === 'pad') return; // picked on the pad: its pages are chosen there (padAdd 'pages')
    if (msg.auto) { startAdding(msg.auto === 'images' ? 'images' : 'pages'); return; } // nothing to choose: every page
    $('#pickerTitle').textContent = `Import “${msg.name}” · ${msg.pageCount} page${msg.pageCount === 1 ? '' : 's'}`;
    $('#pickRange').value = '';
    const thumbs = $('#thumbs');
    thumbs.innerHTML = '';
    for (let i = 0; i < msg.pageCount; i++) {
      const t = document.createElement('div');
      t.className = 'thumb on';
      t.dataset.index = i;
      const [w, h] = msg.sizes[i];
      t.style.setProperty('--ar', String(w / h));
      t.innerHTML = `<img alt=""><span>${i + 1}</span>`;
      t.addEventListener('click', () => {
        if (pdf.chosen.has(i)) pdf.chosen.delete(i); else pdf.chosen.add(i);
        syncPicker();
      });
      thumbs.appendChild(t);
    }
    $('#picker').hidden = false;
    syncPicker();
  }

  function syncPicker() {
    document.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('on', pdf.chosen.has(Number(t.dataset.index))));
    const n = pdf.chosen.size;
    $('#pickCount').textContent = `${n} of ${pdf.pageCount} selected`;
    $('#pickAdd').textContent = n === 1 ? 'Add 1 page' : `Add ${n} pages`;
    $('#pickAdd').disabled = n === 0;
  }

  function closePicker(cancelled) {
    $('#picker').hidden = true;
    if (cancelled && pdf) { post({ type: 'pdfClose', id: pdf.id }); pdf = null; }
  }

  $('#pickAll').addEventListener('click', () => { for (let i = 0; i < pdf.pageCount; i++) pdf.chosen.add(i); syncPicker(); });
  $('#pickNone').addEventListener('click', () => { pdf.chosen.clear(); syncPicker(); });
  $('#pickRange').addEventListener('input', (e) => {
    // "1-3, 5, 8-" style ranges (1-based)
    const chosen = new Set();
    for (const part of e.target.value.split(/[,;\s]+/).filter(Boolean)) {
      const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
      if (m) {
        const a = m[1] ? Number(m[1]) : 1;
        const b = m[2] ? Number(m[2]) : pdf.pageCount;
        for (let i = Math.max(1, a); i <= Math.min(pdf.pageCount, b); i++) chosen.add(i - 1);
      } else if (/^\d+$/.test(part)) {
        const i = Number(part);
        if (i >= 1 && i <= pdf.pageCount) chosen.add(i - 1);
      }
    }
    pdf.chosen = chosen;
    syncPicker();
  });
  $('#pickCancel').addEventListener('click', () => closePicker(true));
  $('#pickAdd').addEventListener('click', () => startAdding(document.querySelector('input[name=placement]:checked').value));
  /** Ask the PC for the chosen pages ("pages": each a new page; "images": pictures on this page). */
  function startAdding(placement) {
    pdf.placement = placement;
    pdf.insertAt = cur + 1;
    pdf.firstNew = null;
    pdf.added = 0;
    pdf.offset = 0;
    if (pdf.placement === 'images') pushUndo();
    $('#pickAdd').disabled = true;
    $('#pickAdd').textContent = 'Adding…';
    post({ type: 'pdfPages', id: pdf.id, pages: [...pdf.chosen].sort((a, b) => a - b) });
  }

  async function addPdfPage(msg) {
    if (!pdf || msg.id !== pdf.id) return;
    const { id, img } = await addImage(msg.dataUrl);
    if (pdf.placement === 'pages') {
      const p = newPage('white');
      p.doc = { img: id, ...fit(img.naturalWidth, img.naturalHeight, W, H) };
      pages.splice(pdf.insertAt, 0, p);
      if (pdf.firstNew === null) pdf.firstNew = pdf.insertAt;
      pdf.insertAt++;
    } else {
      const box = fit(img.naturalWidth, img.naturalHeight, W * 0.45, H * 0.8, W * 0.05 + pdf.offset, H * 0.1 + pdf.offset / 2 + view.y);
      page().items.push({ type: 'image', img: id, ...box });
      growFor(box.y + box.h);
      pdf.offset += 40;
    }
    pdf.added++;
    $('#pickAdd').textContent = `Adding… ${pdf.added}/${pdf.chosen.size}`;
    $('#pageNo').textContent = `${cur + 1} / ${pages.length}`;
  }

  function finishPdf(msg) {
    if (!pdf || msg.id !== pdf.id) return;
    const done = pdf;
    post({ type: 'pdfClose', id: done.id });
    pdf = null;
    closePicker(false);
    if (done.placement === 'pages' && done.firstNew !== null) goTo(done.firstNew);
    else renderBase();
    toast(`Added ${done.added} page${done.added === 1 ? '' : 's'} from ${done.name}`);
  }

  // ---------- capture: PC screen, a window, a web page ----------

  const captureMenu = $('#captureMenu');
  let placement = 'page'; // 'page' = new whiteboard page, 'image' = picture on the current page

  function openCaptureMenu(x, y) {
    captureMenu.hidden = false;
    const w = captureMenu.offsetWidth, h = captureMenu.offsetHeight;
    captureMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    captureMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  }
  const closeCaptureMenu = () => { captureMenu.hidden = true; };

  $('#capture').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!captureMenu.hidden) { closeCaptureMenu(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    openCaptureMenu(r.left, r.bottom + 6);
  });
  // A right-click (or a long-press on the iPad) on the board opens nothing: the Capture menu lives on the Capture button only.
  live.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerdown', (e) => {
    if (!captureMenu.hidden && !captureMenu.contains(e.target) && e.target.id !== 'capture') closeCaptureMenu();
  }, true);

  document.querySelectorAll('[data-place]').forEach((b) => b.addEventListener('click', () => {
    placement = b.dataset.place;
    document.querySelectorAll('[data-place]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.querySelectorAll('[data-capture]').forEach((b) => b.addEventListener('click', () => {
    closeCaptureMenu();
    if (!host) { toast('Capturing works inside PadLink on the PC.'); return; }
    const kind = b.dataset.capture;
    if (kind === 'screen') {
      toast('Capturing the screen behind the board…');
      post({ type: 'captureScreen', placement });
    } else if (kind === 'window') {
      $('#windowList').innerHTML = '<div class="empty">Finding open windows…</div>';
      $('#windowsDialog').hidden = false;
      post({ type: 'listWindows' });
    } else {
      $('#urlDialog').hidden = false;
      $('#urlInput').value = '';
      $('#urlInput').focus();
    }
  }));

  function showWindowList(list) {
    const box = $('#windowList');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="empty">No other open windows found.</div>'; return; }
    for (const w of list) {
      const b = document.createElement('button');
      const title = document.createElement('b');
      title.textContent = w.title;
      const app = document.createElement('small');
      app.textContent = w.app;
      b.append(title, app);
      b.addEventListener('click', () => {
        $('#windowsDialog').hidden = true;
        toast('Capturing ' + w.title + '…');
        post({ type: 'captureWindow', id: w.id, placement });
      });
      box.appendChild(b);
    }
  }
  $('#windowsCancel').addEventListener('click', () => { $('#windowsDialog').hidden = true; });

  $('#urlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#urlInput').value.trim();
    if (!url) return;
    $('#urlDialog').hidden = true;
    post({ type: 'captureUrl', url, placement: placement === 'page' ? 'pages' : 'image' });
  });
  $('#urlCancel').addEventListener('click', () => { $('#urlDialog').hidden = true; });

  /** A captured picture arrives from the PC. */
  async function addCapture(msg) {
    if (msg.placement === 'image') { await placeImage(msg.dataUrl); toast(msg.said || 'Added the capture to this page.'); return; }

    const { id, img } = await addImage(msg.dataUrl);
    const p = newPage('white');
    const fullH = img.naturalHeight * W / img.naturalWidth; // its height at the full page width
    if (msg.placement === 'pages' && fullH > H * 1.15) {
      // A long web page: one tall page, top to bottom, that scrolls.
      p.doc = { img: id, ...fit(img.naturalWidth, img.naturalHeight, W, MAX_H - GROW_BY) };
      p.doc.y = 0;
      p.h = Math.min(MAX_H, Math.max(H, Math.ceil(p.doc.h)));
    } else {
      p.doc = { img: id, ...fit(img.naturalWidth, img.naturalHeight, W, H) };
    }
    pages.splice(cur + 1, 0, p);
    goTo(cur + 1);
    toast(msg.said || (p.h > H ? 'Added the web page as one tall page. Scroll with two fingers or the mouse wheel.' : 'Added the capture as a new page. Draw on it!'));
  }

  // ---------- Add to the board, from the pad ----------
  // The pad's "Add to the board" panel: the PC screen, a window (the list goes to the pad in the board's state), a web
  // page, or a PDF or picture from the PC. Photos from the iPad or iPhone come straight from PadLink ('capture').
  let padWantsWindows = false;
  let padWindows = null;
  function padAdd(a) {
    const placement = a.place === 'image' ? 'image' : 'page';
    if (!host) { toast('Adding things works inside PadLink on the PC.'); return; }
    switch (a.kind) {
      case 'screen':
        toast('Capturing the screen behind the board…');
        post({ type: 'captureScreen', placement });
        break;
      case 'windows':
        padWantsWindows = true;
        padWindows = null;
        post({ type: 'listWindows' });
        break;
      case 'window':
        padWindows = null;
        reportState();
        toast('Capturing the window…');
        post({ type: 'captureWindow', id: a.id, placement });
        break;
      case 'nowindow':
        padWindows = null;
        reportState();
        break;
      case 'url':
        post({ type: 'captureUrl', url: a.url, placement: placement === 'page' ? 'pages' : 'image' });
        break;
      case 'import':
        post({ type: 'import' });
        break;
      case 'pages': // a Drive file's pages, chosen on the pad
        if (!pdf || pdf.id !== a.id) { toast('That file is no longer open. Pick it again from Google Drive.'); break; }
        pdf.chosen = new Set(a.pages.filter((i) => i >= 0 && i < pdf.pageCount));
        if (pdf.chosen.size) startAdding(placement === 'image' ? 'images' : 'pages');
        break;
      case 'nopages':
        if (pdf && pdf.id === a.id) closePicker(true);
        break;
    }
  }

  // ---------- Google Drive (the board's Drive button) ----------
  // Google's own picker opens in the PC's web browser (WhiteboardForm → GoogleDrive); the file comes back to PadLink
  // and arrives here like a file from the PC: a PDF opens the page picker, a picture goes where it was asked for.
  let drivePlace = 'page';
  $('#driveLogo').innerHTML = PadDrive.LOGO;
  $('#driveOpenLogo').innerHTML = PadDrive.LOGO;
  $('#driveBtn').addEventListener('click', () => { $('#driveDialog').hidden = false; });
  $('#driveClose').addEventListener('click', () => { $('#driveDialog').hidden = true; });
  if (go) $('.drive-note').textContent = 'Google Drive opens here: sign in with Google, then find your file in your folders, Shared with me or shared drives, or search for it. PadLink Go only gets the file you pick, and it comes back to this board. It needs the internet, but not the PC.';
  $('#driveOpen').addEventListener('click', () => {
    $('#driveDialog').hidden = true;
    if (!host) { toast('Google Drive works inside PadLink on the PC.'); return; }
    if (go) saveNow(); // PadLink Go leaves this page for Google's picker: the board is saved first
    post({ type: 'drive', op: 'pick', place: drivePlace });
  });
  document.querySelectorAll('[data-dplace]').forEach((b) => b.addEventListener('click', () => {
    drivePlace = b.dataset.dplace;
    document.querySelectorAll('[data-dplace]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  // ---------- drawing tools tucked away while an iPad or iPhone is connected ----------
  // The pad shows these tools as its own buttons, so on the PC screen (which the pad also shows) they only confuse.
  // A device connecting tucks them away; the arrow at the left, the button at the bottom of the rail and the pad's
  // "Tools on the PC" all toggle them. When the device has been gone a while they come back by themselves.
  let toolsAway = false;
  let deviceOn = false;
  let deviceGone = 0; // waiting to see whether a dropped device comes back (Safari drops it when you switch apps)
  function setToolsAway(away) {
    toolsAway = away;
    document.body.classList.toggle('tools-away', away);
    $('#toolsTab').hidden = !away;
    $('#toolsHide').hidden = away || !deviceOn;
    if (away) $('#shapeFly').hidden = true;
    layout(); // the page can use the rail's space too
    placeSelBar(); // the iPad or iPhone has its own Select panel
    reportState();
  }
  function onDevice(on) {
    if (on) {
      const fresh = !deviceOn && !deviceGone; // not just a quick reconnect: tuck the tools away
      clearTimeout(deviceGone);
      deviceGone = 0;
      deviceOn = true;
      setToolsAway(fresh ? true : toolsAway);
    } else if (deviceOn) {
      deviceOn = false;
      $('#toolsHide').hidden = true;
      deviceGone = setTimeout(() => { deviceGone = 0; setToolsAway(false); }, 15000);
    }
  }
  $('#toolsTab').addEventListener('click', () => setToolsAway(false));
  $('#toolsHide').addEventListener('click', () => setToolsAway(true));

  // ---------- Class tools: countdown timer and name picker ----------
  // The same panel as on the iPad and iPhone (class.js). The PC runs both tools; this asks it through WhiteboardForm
  // ('class' messages) and hears every change, wherever it was made, so the board and the pad always agree.
  const classStore = {
    get(k) { try { return localStorage.getItem('padlink.board.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('padlink.board.' + k, v); } catch { /* private mode */ } },
  };
  const classPanel = PadClass.Panel({
    tabs: $('#classTabs'),
    body: $('#classBody'),
    send: (msg) => post({ type: 'class', msg }),
    notice: (text, ms) => toast(text, ms),
    connected: () => !!host,
    self: 'board',
    openGrid: openStudentGrid, // over the whiteboard
    onStudents: onStudentNews, // the waiting badge, raised hands, and the join code screen's numbers
    openPollEditor: () => openPollEditor(), // Class tools → Poll: prepare this page's poll
    openPasteQuestions: () => $('#pmPaste').click(), // …or paste a list of questions
    onHandChime: () => pulseHands(),
    timesUp: () => {}, // the PC's own blue box already says it
    deviceSound: false, // the PC chimes itself
    store: classStore,
    onTimer(state, text) {
      const badge = $('#classBadge');
      badge.hidden = state === 'idle';
      badge.textContent = text;
      badge.classList.toggle('done', state === 'done');
    },
  });
  // How the class stands, once the whiteboard opens (a poll going on, or its results on show, after a reload).
  if (!go && !student) post({ type: 'class', msg: { t: 'students' } });
  // ---------- Student Mode on the whiteboard: the join code screen, the grid of student boards, the waiting badge ----------
  const join = { el: null };
  let studentNews = null;
  /** The join code over the whole whiteboard (for the class to scan), until the teacher closes it. */
  function showJoinCode(m) {
    if (!m.on) { if (join.el) join.el.hidden = true; return; }
    if (!join.el) {
      join.el = document.createElement('div');
      join.el.className = 'join-screen';
      join.el.innerHTML = `
        <div class="join-card" role="dialog" aria-label="Join the class">
          <button class="join-x" aria-label="Close" title="Close (the class stays open)"><svg class="i"><use href="#b-close"/></svg></button>
          <p class="join-eyebrow">Join on your Chromebook or device</p>
          <h2 class="join-title"></h2>
          <div class="join-body">
            <img class="join-qr" alt="QR code to join the class">
            <div class="join-text">
              <p class="join-step">Scan the code with the camera, or go to</p>
              <p class="join-address"></p>
              <p class="join-step">and type</p>
              <p class="join-code"></p>
              <p class="join-count"></p>
            </div>
          </div>
          <div class="join-other" hidden>
            <button class="join-other-btn">Student on another Wi-Fi?</button>
            <div class="join-other-box" hidden>
              <img class="join-other-qr" alt="QR code to join through Remote mode">
              <div class="join-text">
                <p class="join-step">Not on the school Wi-Fi? Scan this, or go to</p>
                <p class="join-other-address"></p>
                <p class="join-step">and type the same code. (This uses Remote mode.)</p>
              </div>
            </div>
          </div>
          <button class="join-done">Back to the lesson</button>
        </div>`;
      document.body.appendChild(join.el);
      const close = () => post({ type: 'class', msg: { t: 'studentsJoin', on: false } });
      join.el.querySelector('.join-x').addEventListener('click', close);
      join.el.querySelector('.join-done').addEventListener('click', close);
      join.el.querySelector('.join-other-btn').addEventListener('click', () => {
        const box = join.el.querySelector('.join-other-box');
        box.hidden = !box.hidden;
        join.el.querySelector('.join-other-btn').textContent = box.hidden ? 'Student on another Wi-Fi?' : 'Hide the other Wi-Fi code';
      });
    }
    if (join.el.hidden) { // each time the join screen opens, the other Wi-Fi code starts hidden
      join.el.querySelector('.join-other-box').hidden = true;
      join.el.querySelector('.join-other-btn').textContent = 'Student on another Wi-Fi?';
    }
    join.el.hidden = false;
    join.el.querySelector('.join-title').textContent = m.className || 'Join the class';
    const qr = join.el.querySelector('.join-qr');
    qr.hidden = !m.qr;
    if (m.qr) qr.src = m.qr;
    join.el.querySelector('.join-address').textContent = m.address || 'Waiting for the remote link…';
    join.el.querySelector('.join-code').textContent = m.code || '';
    // Students join on the school network; a device on another Wi-Fi can use Remote mode (shown only when asked).
    join.el.querySelector('.join-other').hidden = !m.otherAddress;
    if (m.otherAddress) {
      join.el.querySelector('.join-other-address').textContent = m.otherAddress;
      join.el.querySelector('.join-other-qr').src = m.otherQr || '';
    }
    updateJoinCount();
  }
  /**
   * Every team over the whole whiteboard, each as a table seen from above (seats 1 and 2 on one side, 4 and 3 across
   * from them), so students find their team and seat. Names and seat numbers only.
   */
  const teamsView = { el: null };
  function showTeams(m) {
    if (!m.on) { if (teamsView.el) teamsView.el.hidden = true; return; }
    if (!teamsView.el) {
      teamsView.el = document.createElement('div');
      teamsView.el.className = 'teams-screen';
      teamsView.el.innerHTML = '<div class="teams-top"><h2></h2><button class="teams-done">Back to the lesson</button></div><div class="teams-grid"></div>';
      document.body.appendChild(teamsView.el);
      teamsView.el.querySelector('.teams-done').addEventListener('click', () => post({ type: 'class', msg: { t: 'teamsShow', on: false } }));
    }
    teamsView.el.hidden = false;
    teamsView.el.querySelector('h2').textContent = (m.className ? `${m.className}: ` : '') + 'find your team and seat';
    const grid = teamsView.el.querySelector('.teams-grid');
    grid.textContent = '';
    for (const t of m.teams || []) {
      const card = document.createElement('div');
      card.className = 'team-card';
      const h = document.createElement('h3');
      h.textContent = `Team ${t.no}`;
      card.appendChild(h);
      const table = document.createElement('div');
      table.className = 'team-table';
      const bySeat = new Map((t.members || []).map((x) => [x.seat, x.name]));
      const seat = (n, extra) => {
        const d = document.createElement('div');
        d.className = 'team-seat' + (bySeat.has(n) ? '' : ' empty') + (extra ? ' extra' : '');
        d.innerHTML = '<b></b><span></span>';
        d.querySelector('b').textContent = n;
        d.querySelector('span').textContent = bySeat.get(n) || '';
        return d;
      };
      for (const n of [1, 2, 4, 3]) table.appendChild(seat(n));
      for (const n of [...bySeat.keys()].filter((n) => n > 4).sort((a, b) => a - b)) table.appendChild(seat(n, true));
      card.appendChild(table);
      grid.appendChild(card);
    }
  }
  function updateJoinCount() {
    if (!join.el || join.el.hidden || !studentNews) return;
    const n = studentNews.inClass || 0, w = studentNews.waiting || 0;
    join.el.querySelector('.join-count').textContent = `${n} in the class` + (w ? ` · ${w} waiting to be let in` : '');
  }
  /** News of the class (from Class tools → Students): a badge on the Class button while students wait to be let in. */
  function onStudentNews(m) {
    studentNews = m;
    let badge = $('#studentsBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'studentsBadge';
      badge.className = 'students-badge';
      $('#classBtn').appendChild(badge);
    }
    badge.hidden = !(m.open && m.waiting);
    badge.textContent = m.waiting ? `${m.waiting} waiting` : '';
    showHands(m);
    if (!go) { showPoll(m); showLesson(m); }
    pagePollChanged(); // Start this page's poll: only while a class is open and no poll is going
    updateJoinCount();
  }
  /**
   * Raise hand on the PC screen, which the class can see: how many hands are up (the default), their names, or
   * nothing (Settings → Raise hand). Notes never show here. Tap it for Class tools → Students.
   */
  let handCorner = null;
  function showHands(m) {
    const hands = m.open ? m.hands || [] : [];
    const how = m.handPcShow || 'count';
    if (!handCorner) {
      handCorner = document.createElement('button');
      handCorner.id = 'handCorner';
      handCorner.className = 'hand-corner';
      handCorner.addEventListener('click', () => { openClass(true); classPanel.showTab('students'); });
      document.body.appendChild(handCorner);
    }
    handCorner.hidden = !hands.length || how === 'none' || !$('#classSheet').hidden || !$('#setSheet').hidden;
    if (handCorner.hidden) return;
    const names = hands.map((h) => h.name);
    const words = how === 'names'
      ? (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`)
      : (hands.length === 1 ? '1 hand up' : `${hands.length} hands up`);
    handCorner.textContent = `✋ ${words}`;
    handCorner.title = 'Raised hands: open Class tools → Students';
  }
  // ---------- Polls on the whiteboard (which the class can see): how many have answered while it's open, and the
  // results once the teacher shows them (no names) ----------
  // A poll with its question typed in (a page's poll): the question and the answers' words in a banner across the top,
  // for the class (and anyone walking in) to read. Tap it to make it small (the chip); tap the chip to bring it back.
  const pollView = { chip: null, banner: null, el: null, tick: 0, small: new Set(), last: null };
  function showPoll(m) {
    const p = m.open ? m.poll : null;
    pollView.last = m;
    if (!pollView.chip) {
      pollView.chip = document.createElement('button');
      pollView.chip.className = 'poll-chip';
      pollView.chip.addEventListener('click', () => {
        const q = pollView.last && pollView.last.poll;
        if (q && pollView.small.has(q.id)) { pollView.small.delete(q.id); showPoll(pollView.last); return; }
        openClass(true); classPanel.showTab('poll');
      });
      document.body.appendChild(pollView.chip);
      pollView.banner = document.createElement('div');
      pollView.banner.className = 'poll-banner';
      pollView.banner.hidden = true;
      pollView.banner.title = 'Tap to make it smaller';
      pollView.banner.addEventListener('click', () => {
        const q = pollView.last && pollView.last.poll;
        if (q) { pollView.small.add(q.id); showPoll(pollView.last); }
      });
      document.body.appendChild(pollView.banner);
    }
    const chip = pollView.chip, banner = pollView.banner;
    clearInterval(pollView.tick);
    const open = !!(p && p.open);
    const words = open && Array.isArray(p.texts) && p.texts.some((t) => t);
    const hasQuestion = open && p.onBoard !== false && (!!p.question || words);
    const big = hasQuestion && !pollView.small.has(p.id);
    chip.hidden = !open || big;
    banner.hidden = !big;
    chip.title = hasQuestion ? 'Show the question again' : 'Open Class tools → Poll';
    const lefts = [];
    if (open && !big) {
      chip.innerHTML = '<span class="poll-dot"></span><b>Poll open</b><span class="poll-n"></span><span class="poll-left"></span>';
      chip.querySelector('.poll-n').textContent = `${p.answered} of ${p.total} answered`;
      lefts.push(chip.querySelector('.poll-left'));
    }
    if (big) {
      banner.innerHTML = '<div class="pb-top"><span class="poll-dot"></span><b class="pb-no"></b><span class="pb-n"></span><span class="poll-left"></span><span class="pb-small" aria-hidden="true">–</span></div><p class="pb-q"></p><div class="pb-answers"></div>';
      banner.querySelector('.pb-no').textContent = `Poll ${p.no || ''} open`.replace('  ', ' ');
      banner.querySelector('.pb-n').textContent = `${p.answered} of ${p.total} answered`;
      const q = banner.querySelector('.pb-q');
      q.textContent = p.question || '';
      q.hidden = !p.question;
      const answers = banner.querySelector('.pb-answers');
      // The answers: each letter with its words (lettered polls with words), or True / False, Yes / No.
      const show = p.kind === 'letters' ? (words ? p.choices.map((c, i) => [c, p.texts[i] || '']) : []) : p.choices.map((c) => [c, '']);
      answers.hidden = !show.length;
      answers.classList.toggle('two', show.length === 2 || show.length === 4);
      for (const [letter, text] of show) {
        const a = document.createElement('div');
        a.className = 'pb-a';
        a.innerHTML = '<b></b><span></span>';
        a.querySelector('b').textContent = letter;
        a.querySelector('span').textContent = text;
        answers.appendChild(a);
      }
      lefts.push(banner.querySelector('.poll-left'));
    }
    if (open) {
      const at = performance.now();
      const tick = () => {
        const ms = p.leftMs != null ? Math.max(0, p.leftMs - (performance.now() - at)) : null;
        for (const left of lefts) {
          left.hidden = ms == null;
          if (ms != null) { left.textContent = PadClass.fmtTime(ms); left.classList.toggle('soon', ms <= 10000); }
        }
      };
      tick();
      if (p.leftMs != null) pollView.tick = setInterval(tick, 250);
    }
    const shown = !!(p && p.shown && p.counts);
    if (!shown) { if (pollView.el) pollView.el.hidden = true; return; }
    if (!pollView.el) {
      pollView.el = document.createElement('div');
      pollView.el.className = 'poll-screen';
      pollView.el.innerHTML = '<div class="poll-card"><p class="poll-eyebrow">Poll results</p><h2></h2><div class="poll-chart"></div><button class="poll-done">Back to the lesson</button></div>';
      document.body.appendChild(pollView.el);
      pollView.el.querySelector('.poll-done').addEventListener('click', () => post({ type: 'class', msg: { t: 'pollShow', on: false } }));
    }
    pollView.el.hidden = false;
    pollView.el.querySelector('.poll-eyebrow').textContent = p.question ? `Poll results · ${p.answered} of ${p.total} answered` : 'Poll results';
    pollView.el.querySelector('h2').textContent = p.question || `${p.answered} of ${p.total} answered`;
    pollChart(pollView.el.querySelector('.poll-chart'), p.choices, p.counts, -1, p.correct);
  }
  // ---------- Lesson so far, for the class: every closed poll's bars, no names; the correct answers once switched on ----------
  const lessonView = { el: null };
  function showLesson(m) {
    const l = m.open ? m.lesson : null;
    const on = !!(l && l.shown && l.polls && l.polls.length);
    if (!on) { if (lessonView.el) lessonView.el.hidden = true; return; }
    if (!lessonView.el) {
      lessonView.el = document.createElement('div');
      lessonView.el.className = 'poll-screen lesson-screen';
      lessonView.el.innerHTML = '<div class="poll-card lesson-card"><p class="poll-eyebrow">How we did today</p><h2></h2><div class="lesson-grid"></div>'
        + '<div class="lesson-acts"><button class="lesson-answers"></button><button class="poll-done">Back to the lesson</button></div></div>';
      document.body.appendChild(lessonView.el);
      lessonView.el.querySelector('.poll-done').addEventListener('click', () => post({ type: 'class', msg: { t: 'lessonShow', on: false } }));
      lessonView.el.querySelector('.lesson-answers').addEventListener('click', () => post({ type: 'class', msg: { t: 'lessonShow', on: true, answers: !lessonView.answers } }));
    }
    lessonView.answers = !!l.answers;
    lessonView.el.hidden = false;
    const n = l.polls.length;
    lessonView.el.querySelector('h2').textContent = `${n} poll${n === 1 ? '' : 's'}` + (l.answers && l.correctAvg != null ? ` · ${l.correctAvg}% correct` : '');
    const btn = lessonView.el.querySelector('.lesson-answers');
    btn.textContent = l.answers ? 'Hide the correct answers' : 'Show the correct answers';
    btn.hidden = !l.marked;
    const grid = lessonView.el.querySelector('.lesson-grid');
    grid.textContent = '';
    for (const p of l.polls) {
      const card = document.createElement('div');
      card.className = 'lesson-poll';
      const h = document.createElement('h3');
      h.textContent = p.question || `Poll ${p.no} · ${p.what}`;
      card.appendChild(h);
      const chart = document.createElement('div');
      chart.className = 'poll-chart';
      pollChart(chart, p.choices, p.counts, -1, l.answers ? p.correct : -1);
      card.appendChild(chart);
      const foot = document.createElement('p');
      foot.className = 'lesson-foot';
      foot.textContent = l.answers && p.percent != null ? `${p.percent}% correct` : `${p.answered} answered`;
      card.appendChild(foot);
      grid.appendChild(card);
    }
  }
  /** Bars for a poll's results: each answer, how many chose it and what share of those who answered. */
  function pollChart(el, choices, counts, mine, correct) {
    const answered = counts.reduce((a, b) => a + b, 0);
    el.textContent = '';
    choices.forEach((label, i) => {
      const n = counts[i] || 0;
      const row = document.createElement('div');
      row.className = 'poll-row' + (i === mine ? ' mine' : '') + (i === correct ? ' right' : '');
      row.innerHTML = '<b class="poll-label"></b><div class="poll-track"><div class="poll-fill"></div></div><span class="poll-num"><b></b><small></small></span>';
      row.querySelector('.poll-label').textContent = i === correct ? `${label} ✓` : label;
      row.querySelector('.poll-fill').style.width = `${answered ? (n / answered) * 100 : 0}%`;
      row.querySelector('.poll-num b').textContent = n;
      row.querySelector('.poll-num small').textContent = `${answered ? Math.round((n / answered) * 100) : 0}%`;
      el.appendChild(row);
    });
  }
  // ---------- A page's poll: prepared ahead (📊 Poll in the Pages menu, or Paste questions), started from the page ----------
  // page.poll = { kind: 'letters'|'tf'|'yn', count, question, answers: [words…], correct, seconds, shuffle }. It's saved
  // with the board (and in board files), never sent to students; its correct answer stays hidden until the poll closes.
  const teacherBoard = !student && !teamBoard && !marking;
  let pagePollBtn = null, lastPagePoll;
  const pollSpec = (p) => p && p.poll && ['letters', 'tf', 'yn'].includes(p.poll.kind) ? p.poll : null;
  const pollWhat = (q) => (q.kind === 'tf' ? 'True / False' : q.kind === 'yn' ? 'Yes / No' : `A–${'ABCDE'[Math.max(2, Math.min(5, q.count || 4)) - 1]}`);
  function startPagePoll() {
    const q = pollSpec(page());
    if (!q) return;
    post({ type: 'class', msg: { t: 'pollStart', kind: q.kind, count: q.count || 4, seconds: q.seconds || 0, question: q.question || '', answers: q.answers || [], correct: q.correct ?? -1, shuffle: !!q.shuffle, board: classPanel.prefs.pollOnBoard !== false, page: cur } });
  }
  function pagePollChanged() {
    if (!pollUiReady || !teacherBoard) return; // (a redraw while the board is still starting up)
    const q = pollSpec(page());
    if (!pagePollBtn) {
      pagePollBtn = document.createElement('button');
      pagePollBtn.className = 'page-poll-btn';
      pagePollBtn.addEventListener('click', () => { if (pagePollBtn.classList.contains('ready')) openPollEditor(); else startPagePoll(); });
      document.body.appendChild(pagePollBtn);
    }
    // On a page with a poll: Start this page's poll while a class is open (and no poll is going); otherwise a quiet
    // "Poll ready" tag, so a page's poll shows without opening anything (tap it to change the poll).
    const classOpen = !!(studentNews && studentNews.open);
    const busy = classOpen && !!(studentNews.poll && studentNews.poll.open);
    pagePollBtn.hidden = !q || busy;
    pagePollBtn.classList.toggle('ready', !!q && !classOpen);
    if (q) {
      const what = pollWhat(q) + (q.seconds ? ` · ${PadClass.fmtTime(q.seconds * 1000)}` : '');
      const right = q.correct >= 0 ? ` · ${q.kind === 'tf' ? ['True', 'False'][q.correct] : q.kind === 'yn' ? ['Yes', 'No'][q.correct] : 'ABCDE'[q.correct]} correct` : '';
      pagePollBtn.innerHTML = classOpen ? '<span>📊</span><span>Start this page’s poll</span><small></small>' : '<span>📊</span><span>Poll ready</span><small></small>';
      pagePollBtn.querySelector('small').textContent = classOpen ? what : what + right;
      pagePollBtn.title = classOpen ? 'Start this page’s poll' : 'This page has a poll: tap to see or change it';
    }
    $('#pmPoll').querySelector('b').textContent = q ? 'Poll ✓' : 'Poll';
    // Class tools (on the iPad too) offers to start it: the PC's whiteboard tells the PC which page's poll is up.
    if (go) return;
    const json = q ? JSON.stringify({ ...q, page: cur }) : '';
    if (json === lastPagePoll) return;
    lastPagePoll = json;
    post({ type: 'class', msg: { t: 'pagePoll', poll: q ? { ...q, page: cur } : null } });
  }
  /** Every page's poll, for Class tools → Poll → Polls in this board (the PC's whiteboard only). */
  let lastBoardPolls;
  function boardPollsChanged() {
    if (!pollUiReady || !teacherBoard || go) return;
    const list = pages.map((p, i) => (pollSpec(p) ? { page: i, ...pollSpec(p) } : null)).filter(Boolean);
    const json = JSON.stringify(list);
    if (json === lastBoardPolls) return;
    lastBoardPolls = json;
    post({ type: 'class', msg: { t: 'boardPolls', list } });
  }

  // The editor (📊 Poll in the Pages menu).
  const pe = { kind: '4', seconds: 0, correct: -1, answers: [] };
  function peRender() {
    for (const b of document.querySelectorAll('#peKind button')) b.classList.toggle('on', b.dataset.pk === pe.kind);
    for (const b of document.querySelectorAll('#peTime button')) b.classList.toggle('on', Number(b.dataset.ps) === pe.seconds);
    const letters = !['tf', 'yn'].includes(pe.kind);
    const labels = pe.kind === 'tf' ? ['True', 'False'] : pe.kind === 'yn' ? ['Yes', 'No'] : 'ABCDE'.slice(0, Number(pe.kind)).split('');
    if (pe.correct >= labels.length) pe.correct = -1;
    const box = $('#peAnswers');
    // Keep what's been typed when the number of answers changes.
    for (const [i, inp] of [...box.querySelectorAll('input')].entries()) pe.answers[i] = inp.value;
    box.textContent = '';
    labels.forEach((label, i) => {
      const row = document.createElement('div');
      row.className = 'pe-row';
      if (letters) {
        row.innerHTML = '<b></b><input class="pe-input" maxlength="80" autocomplete="off"><button class="pe-right" title="The correct answer">✓</button>';
        row.querySelector('b').textContent = label;
        row.querySelector('input').value = pe.answers[i] || '';
        row.querySelector('input').placeholder = `Answer ${label} (optional)`;
        for (const type of ['keydown', 'paste']) row.querySelector('input').addEventListener(type, (e) => e.stopPropagation());
      } else {
        row.innerHTML = '<b>' + (i ? '2' : '1') + '</b><span class="pe-fixed"></span><button class="pe-right" title="The correct answer">✓</button>';
        row.querySelector('.pe-fixed').textContent = label;
      }
      const right = row.querySelector('.pe-right');
      right.classList.toggle('on', pe.correct === i);
      right.setAttribute('aria-pressed', String(pe.correct === i));
      right.addEventListener('click', () => { pe.correct = pe.correct === i ? -1 : i; peRender(); });
      box.appendChild(row);
    });
    $('#peShuffleRow').hidden = !letters;
  }
  function openPollEditor() {
    pageMenu.hidden = true;
    const q = pollSpec(page());
    pe.kind = q ? (q.kind === 'letters' ? String(Math.max(2, Math.min(5, q.count || 4))) : q.kind) : '4';
    pe.seconds = q ? q.seconds || 0 : 0;
    pe.correct = q && Number.isInteger(q.correct) ? q.correct : -1;
    pe.answers = q && Array.isArray(q.answers) ? q.answers.slice() : [];
    $('#peAnswers').textContent = '';
    $('#peQuestion').value = q ? q.question || '' : '';
    $('#peShuffle').checked = !!(q && q.shuffle);
    $('#peRemove').hidden = !q;
    peRender();
    $('#pollDialog').hidden = false;
    $('#peQuestion').focus();
  }
  for (const type of ['keydown', 'paste']) for (const id of ['#peQuestion', '#pqText']) $(id).addEventListener(type, (e) => e.stopPropagation());
  for (const b of document.querySelectorAll('#peKind button')) b.addEventListener('click', () => { pe.kind = b.dataset.pk; peRender(); });
  for (const b of document.querySelectorAll('#peTime button')) b.addEventListener('click', () => { pe.seconds = Number(b.dataset.ps); peRender(); });
  $('#peCancel').addEventListener('click', () => { $('#pollDialog').hidden = true; });
  $('#peRemove').addEventListener('click', () => {
    delete page().poll;
    $('#pollDialog').hidden = true;
    renderBase();
    toast('The poll was taken off this page.');
  });
  $('#peSave').addEventListener('click', () => {
    peRender(); // (picks up the typing)
    const letters = !['tf', 'yn'].includes(pe.kind);
    const count = letters ? Number(pe.kind) : 2;
    const answers = letters ? pe.answers.slice(0, count).map((a) => String(a || '').trim().slice(0, 80)) : [];
    page().poll = {
      kind: letters ? 'letters' : pe.kind, count,
      question: $('#peQuestion').value.trim().slice(0, 200),
      answers: answers.some((a) => a) ? answers : [],
      correct: pe.correct, seconds: pe.seconds, shuffle: letters && $('#peShuffle').checked,
    };
    $('#pollDialog').hidden = true;
    renderBase();
    toast('Poll saved on this page. In the lesson, tap Start this page’s poll.');
  });
  $('#pmPoll').addEventListener('click', openPollEditor);

  // Paste questions: each block (question, then answers; * marks the correct one) becomes a new page with its poll.
  function parseQuestions(text) {
    const done = [], skipped = [];
    const blocks = text.replace(/\r/g, '').split(/\n\s*\n/)
      .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
    for (let lines of blocks) {
      if (lines.length === 1 && lines[0].includes(' / ')) lines = lines[0].split(' / ').map((s) => s.trim()).filter(Boolean);
      const [first, ...rest] = lines;
      let correct = -1;
      const answers = rest.map((a, i) => {
        let t = a;
        if (t.startsWith('*')) { correct = i; t = t.slice(1).trim(); }
        t = t.replace(/^[A-Ea-e][.)]\s+/, '');
        if (t.startsWith('*')) { correct = i; t = t.slice(1).trim(); }
        return t.slice(0, 80);
      });
      const question = first.replace(/^(\d+|Q\d*)[.):]\s+/i, '').slice(0, 200);
      const said = answers.map((a) => a.toLowerCase()).join('|');
      const kind = said === 'true|false' ? 'tf' : said === 'yes|no' ? 'yn' : 'letters';
      if (answers.length < 2 || answers.length > 5) { skipped.push(question); continue; }
      done.push({ question, answers, kind, correct });
    }
    return { done, skipped };
  }
  const pq = { seconds: 0 };
  function pqRender() {
    for (const b of document.querySelectorAll('#pqTime button')) b.classList.toggle('on', Number(b.dataset.ps) === pq.seconds);
    const { done, skipped } = parseQuestions($('#pqText').value);
    $('#pqNote').textContent = !$('#pqText').value.trim() ? ''
      : `${done.length} question${done.length === 1 ? '' : 's'} found` + (skipped.length ? `; ${skipped.length} skipped (each needs 2 to 5 answers): ${skipped.slice(0, 2).join('; ')}` : '.');
    $('#pqAdd').disabled = !done.length;
  }
  $('#pmPaste').addEventListener('click', () => {
    pageMenu.hidden = true;
    $('#pqText').value = '';
    pqRender();
    $('#pasteDialog').hidden = false;
    $('#pqText').focus();
  });
  $('#pqText').addEventListener('input', pqRender);
  for (const b of document.querySelectorAll('#pqTime button')) b.addEventListener('click', () => { pq.seconds = Number(b.dataset.ps); pqRender(); });
  $('#pqCancel').addEventListener('click', () => { $('#pasteDialog').hidden = true; });
  $('#pqAdd').addEventListener('click', () => {
    const { done } = parseQuestions($('#pqText').value);
    if (!done.length) return;
    finishText();
    const bg = page().bg === 'dark' ? 'dark' : 'white';
    const ink = bg === 'dark' ? '#ffffff' : '#1f2328';
    const run = (s, z, b) => ({ s, c: ink, f: 'clean', z, ...(b ? { b: 1 } : {}) });
    const made = done.map((q, n) => {
      const p = newPage(bg);
      p.items.push({ type: 'text', id: newId(), x: 80, y: 60, w: W - 160, paras: PadText.clean([{ r: [run(q.question, 60, true)] }]) });
      if (q.kind === 'letters') {
        p.items.push({ type: 'text', id: newId(), x: 120, y: 200, w: W - 240,
          paras: PadText.clean(q.answers.map((a, i) => ({ r: [run(`${'ABCDE'[i]}.  `, 48, true), run(a, 48)] }))) });
      }
      p.poll = { kind: q.kind, count: q.kind === 'letters' ? q.answers.length : 2, question: q.question,
        answers: q.kind === 'letters' ? q.answers : [], correct: q.correct, seconds: pq.seconds,
        shuffle: q.kind === 'letters' && $('#pqShuffle').checked };
      return p;
    });
    pages.splice(cur + 1, 0, ...made);
    $('#pasteDialog').hidden = true;
    goTo(cur + 1);
    toast(`Added ${made.length} page${made.length === 1 ? '' : 's'}, each with its poll ready.`);
  });
  if (!teacherBoard) for (const id of ['#pmPoll', '#pmPaste']) $(id).hidden = true;
  var pollUiReady = true; // eslint-disable-line no-var -- read by redraws that can run before this point

  function pulseHands() {
    if (!handCorner || handCorner.hidden) return;
    handCorner.classList.remove('pulse');
    void handCorner.offsetWidth; // start the animation again
    handCorner.classList.add('pulse');
  }
  /** The grid of student boards, over the whiteboard (its own page, in a frame), until it's closed. */
  let studentGrid = null;
  function openStudentGrid(url) {
    if (studentGrid) return;
    openClass(false);
    studentGrid = document.createElement('div');
    studentGrid.className = 'student-grid-over';
    const frame = document.createElement('iframe');
    frame.title = 'Student boards';
    frame.src = url;
    studentGrid.appendChild(frame);
    document.body.appendChild(studentGrid);
    frame.focus();
  }
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data && e.data.padlink === 'closeGrid' && studentGrid) { studentGrid.remove(); studentGrid = null; }
  });

  function openClass(open) {
    $('#classSheet').hidden = !open;
    if (open && $('#setSheet')) { $('#setSheet').hidden = true; $('#settingsBtn').classList.remove('on'); }
    $('#classBtn').classList.toggle('on', open);
    if (open) classPanel.opened();
    if (studentNews) showHands(studentNews); // the corner steps aside while the panel (which lists the hands) is open
  }
  $('#classBtn').addEventListener('click', () => openClass($('#classSheet').hidden));

  // ---------- Settings: PadLink's settings on this PC (the same as its ⚙ Settings window, and the iPad's "On the PC") ----------
  const pcSettings = window.PadPcSettings ? PadPcSettings.Panel({
    body: $('#setBody'),
    send: (msg) => post({ type: 'class', msg }),
    connected: () => !!host,
    notice: (text) => toast(text),
  }) : null;
  function openSettings(open) {
    $('#setSheet').hidden = !open;
    $('#settingsBtn').classList.toggle('on', open);
    if (open) { openClass(false); if (pcSettings) pcSettings.opened(); }
    if (studentNews) showHands(studentNews); // the ✋ corner steps aside while Settings is open
  }
  $('#settingsBtn').addEventListener('click', () => openSettings($('#setSheet').hidden));
  $('#setClose').addEventListener('click', () => openSettings(false));
  $('#classClose').addEventListener('click', () => openClass(false));
  post({ type: 'class', msg: { t: 'timerNow' } }); // the timer may already be running (started on the iPad)

  // ---------- the pad's whiteboard buttons ----------
  // While the board is open, the iPad/iPhone shows these tools as its own buttons. The board tells the pad (through
  // PadLink) whenever its tool, colors, sizes or page change, and the pad's buttons arrive here as 'wb' commands,
  // so the two always agree, whichever side was tapped.

  function boardState() {
    let sel = null;
    if (selected) {
      const info = selInfo(selected);
      sel = {
        kind: selected.temp ? 'multi' : selected.type, count: selected.type === 'group' ? selected.items.length : 1,
        name: info.name, color: info.color, fill: info.fill, size: info.size,
        rot: Math.round((selected.type === 'group' ? selected.frame : selected.rot) || 0), canColor: info.canColor, canFill: info.canFill, canThick: info.canThick,
      };
      const fr = selFrame(selected);
      sel.box = [Math.round(fr.box.w), Math.round(fr.box.h)]; // the selection box's size in its own (turned) frame
      if (selectedHasParts()) Object.assign(sel, { shape: selected.shape, parts: selected.parts, frac: !!selected.frac });
    }
    return {
      toolsAway,
      addMode,
      boardName,
      tool,
      lastShape,
      pen: { ...settings.pen },
      highlighter: { ...settings.highlighter },
      shape: { color: settings.shape.color, size: settings.shape.size, parts: { ...settings.shape.parts }, frac: settings.shape.frac },
      eraser: { ...settings.eraser },
      sel,
      page: cur + 1,
      pages: pages.length,
      bg: page().bg || 'white',
      zoomed: view.z > 1.01,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      empty: page().items.length === 0 && !page().doc,
      drawn: hasDrawings(), // drawings on this page (the trash clears these first; pictures stay)
      pics: hasPictures(), // pictures on it, or behind it (the trash's second tap)
      doc: !!page().doc, // the page has a picture behind its drawings (a capture, an imported page)
      windows: padWindows, // the open windows, when the pad asked to capture one
      editing: editing ? { id: editing.item.id, paras: editing.item.paras, math: editing.math, by: editing.by, rev: editing.rev } : null,
      palettes: { pen: PEN_COLORS, highlighter: HIGHLIGHT_COLORS, note: NOTE_COLORS },
      note: { ...settings.note },
    };
  }

  /** Tell the pad what's chosen now (soon, once per burst of changes, and only if something changed). */
  function reportState(force) {
    if (!host) return;
    if (force) lastState = '';
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      const state = boardState();
      const json = JSON.stringify(state);
      if (json === lastState) return;
      lastState = json;
      post({ type: 'wbState', state });
    }, 30);
  }

  // ---------- the iPad pressing on the page ----------
  // For Select, shapes, text and math the iPad (drawing its own copy of the board) sends where on the page the Pencil
  // or a finger presses, moves and lets go. The board takes that as a touch on its own page, so every tool works
  // exactly as on the PC: no Windows pen in between, and nothing for the iPad to do differently.
  const PAD_POINTER = 7771; // an id of its own, apart from real pointers on the PC
  let padPointerDown = false;

  function padPointer(k) {
    const r = live.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const type = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' }[k.e];
    if (!type || (k.e !== 'down' && !padPointerDown)) return; // only while pressed: no hover needed
    padPointerDown = k.e === 'down' || k.e === 'move';
    const pressed = k.e === 'down' || k.e === 'move';
    live.dispatchEvent(new PointerEvent(type, {
      pointerId: PAD_POINTER, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: r.left + ((k.x - view.x) * view.z / W) * r.width,
      clientY: r.top + ((k.y - view.y) * view.z / H) * r.height,
      pressure: pressed ? (k.p ?? 0.5) : 0, button: 0, buttons: pressed ? 1 : 0, shiftKey: !!k.shift,
    }));
  }

  // ---------- strokes and erasing done on the iPad ----------
  // With its own copy of the board, the iPad draws pen and highlighter strokes itself and sends them here: begin
  // (how the stroke looks), its points as they're drawn (shown here live, for the class), then end (it becomes part of
  // the page, one Undo step). Its eraser sends where it rubbed; whatever it touches goes, as with the PC's eraser.
  const padStrokes = new Map(); // the iPad's strokes being drawn: id -> stroke
  let padErase = null;          // { before, changed } while the iPad's eraser is down

  function padInk(k) {
    if (k.op === 'begin') {
      const it = { type: 'stroke', tool: k.tool, color: k.color, size: k.size, pts: [] };
      if (k.tool === 'pen') it.medium = k.medium || 'pen';
      padStrokes.set(k.id, it);
    } else if (k.op === 'pts' || k.op === 'end') {
      const it = padStrokes.get(k.id);
      if (!it) return;
      if (k.pts) it.pts.push(...k.pts);
      if (k.op === 'pts') { renderLive(); return; }
      padStrokes.delete(k.id);
      if (!it.pts.length) { renderLive(); return; }
      pushUndo();
      page().items.push(it);
      const b = bounds(it);
      growFor(b.y + b.h);
      renderBase();
    } else if (k.op === 'erase') {
      if (!padErase) padErase = { before: snapshot(), changed: false };
      for (const [x, y] of k.pts || []) eraseWith(x, y, k.r, padErase);
      if (k.done) {
        if (padErase.changed) { undoStack.push(padErase.before); redoStack.length = 0; reportState(); }
        padErase = null;
      }
    }
  }

  // ---------- the iPad's own copy of the board ----------
  // In whiteboard mode the iPad (or iPhone) draws the board itself, with the same engine (engine.js), instead of
  // showing a video of the PC screen. The board sends it the page it's on as it changes: each item once (and again
  // when it changes), the order of the items, each picture once, and what's moving right now (the stroke being drawn,
  // the selection, the eraser ring). Items and pages get ids for this only; they aren't saved.
  const mirror = { on: false, pad: false, follow: false, ids: new WeakMap(), next: 1, pageIds: new WeakMap(), nextPage: 1, sent: new Map(), imgs: new Set(), timer: 0, liveTimer: 0, lastLive: '' };
  const mirrorId = (o, map, key) => { let id = map.get(o); if (!id) { id = mirror[key]++; map.set(o, id); } return id; };

  /** Changes when the item does (cheap for long strokes: their size, and a few points). */
  function itemSig(it) {
    if (it.type === 'stroke') {
      const p = it.pts, n = p.length;
      return `s|${it.tool}|${it.color}|${it.size}|${it.medium}|${it.rot || 0}|${n}|${p[0]}|${p[n >> 1]}|${p[n - 1]}`;
    }
    if (it.type === 'group') return `g|${it.rot || 0}|${it.frame || 0}[${it.items.map(itemSig).join(';')}]`;
    return JSON.stringify(it);
  }
  function imagesIn(it, out) {
    if (it.type === 'image') out.add(it.img);
    else if (it.type === 'group') for (const c of it.items) imagesIn(c, out);
    return out;
  }
  function mirrorImages(ids) {
    for (const id of ids) {
      if (id == null || mirror.imgs.has(id)) continue;
      const url = imageData.get(id);
      if (!url) continue; // still loading: sent with a later change
      mirror.imgs.add(id);
      post({ type: 'mirror', msg: { t: 'mimg', id, url } });
    }
  }

  /** The pad starts (or stops) drawing its own copy: send everything again from the start. */
  function mirrorStart(op) { mirror.pad = op === 'start'; mirrorRestart(); }
  /** Student Mode, Follow me: students see this board (PadLink keeps a copy for them, and sends it on). */
  function mirrorFollow(on) { mirror.follow = !!on; mirrorRestart(); }
  function mirrorRestart() {
    mirror.on = mirror.pad || mirror.follow;
    mirror.sent.clear();
    mirror.imgs.clear();
    mirror.lastLive = '';
    if (mirror.on) { mirrorFlush(); mirrorLiveFlush(); }
  }

  function mirrorChanged() { if (mirror.on && !mirror.timer) mirror.timer = setTimeout(mirrorFlush, 30); }
  function mirrorFlush() {
    clearTimeout(mirror.timer);
    mirror.timer = 0;
    if (!mirror.on) return;
    const p = page(), pid = mirrorId(p, mirror.pageIds, 'nextPage');
    let sent = mirror.sent.get(pid);
    const first = !sent;
    if (!sent) { sent = new Map(); mirror.sent.set(pid, sent); }
    const ids = [], add = [], imgs = new Set();
    if (p.doc) imgs.add(p.doc.img);
    for (const it of p.items) {
      const id = mirrorId(it, mirror.ids, 'next');
      ids.push(id);
      imagesIn(it, imgs);
      const s = itemSig(it);
      if (sent.get(id) !== s) { sent.set(id, s); add.push([id, it]); }
    }
    const keep = new Set(ids);
    for (const id of [...sent.keys()]) if (!keep.has(id)) sent.delete(id);
    mirrorImages(imgs); // pictures first, so the page draws with them
    post({ type: 'mirror', msg: { t: 'mpage', pid, first, bg: p.bg, h: ph(p), doc: p.doc, ids, add, view: { x: view.x, y: view.y, z: view.z } } });
  }

  function mirrorLive() { if (mirror.on && !mirror.liveTimer) mirror.liveTimer = setTimeout(mirrorLiveFlush, 33); }
  function mirrorLiveFlush() {
    clearTimeout(mirror.liveTimer);
    mirror.liveTimer = 0;
    if (!mirror.on) return;
    const msg = {
      t: 'mlive',
      preview: preview || null,
      sel: selected ? selFrame(selected) : null,
      eraser: eraserAt ? [eraserAt[0], eraserAt[1], SIZES.eraser[settings.eraser.size] / 2] : null,
      marquee: action?.kind === 'marquee' ? [action.x0, action.y0, action.x1, action.y1] : null,
    };
    const json = JSON.stringify(msg);
    if (json === mirror.lastLive) return;
    mirror.lastLive = json;
    if (preview) mirrorImages(imagesIn(preview, new Set()));
    post({ type: 'mirror', msg });
  }

  /** A button on the pad: a tool (with its pen type, color, size, Parts) or an action such as undo or the next page. */
  function padCommand(c) {
    if (c.mirror) mirrorStart(c.mirror); // the iPad draws its own copy of the board
    if (c.ink) padInk(c.ink); // a stroke drawn, or erasing done, on the iPad itself
    if (c.ptr) padPointer(c.ptr); // the iPad pressing on the page (Select, shapes, text, math)
    if (c.pan) panBy(c.pan.dx, c.pan.dy); // two fingers moving on the iPad (page units)
    if (c.zoom) zoomAtView(c.zoom.fx, c.zoom.fy, c.zoom.f); // a pinch on the iPad, about a point in the view
    if (c.tool && (PLAIN_TOOLS.has(c.tool) || SHAPES.has(c.tool)) && c.tool !== tool) setTool(c.tool);
    if (c.tool) openShapeFly(false);
    if (c.medium && MEDIA[c.medium]) settings.pen.medium = c.medium;
    const s = setting();
    if (c.color && 'color' in s) s.color = c.color;
    if (typeof c.size === 'number' && 'size' in s) s.size = Math.max(0, Math.min(2, c.size));
    if (c.parts) changeParts(c.parts);
    if (typeof c.frac === 'boolean') setFracLabels(c.frac);
    if (c.text && editing && c.text.id === editing.item.id) padText(c.text);
    if (c.add) padAdd(c.add);
    if (c.sel && c.sel.op) editSelected(c.sel.op, c.sel.v); // the pad's Select panel
    if (c.pages) padPages(c.pages); // the pad's Pages panel
    if (c.boards) padBoards(c.boards); // the pad's Boards panel
    if (c.bg) setBackground(c.bg); // the pad's page menu
    switch (c.action) {
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'prev': goTo(cur - 1); break;
      case 'next': goTo(cur + 1); break;
      case 'add': addPageAfter(); break;
      case 'fit': resetZoom(); break;
      case 'clear': clearPage(false); break; // the pad already asked
      case 'clearall': clearPage(true); break;
      case 'delpage': deletePage(); break; // asked on the pad too
      case 'duplicate': duplicatePage(); break;
      case 'removedoc': removePagePicture(); break;
      case 'clearpics': clearPictures(); break; // the pad already asked
      case 'tools': setToolsAway(!toolsAway); break; // "Tools on the PC" on the pad
    }
    if (c.tool || c.medium || c.color || typeof c.size === 'number') {
      stylePopTucked = false;
      renderSwatches();
      renderSizes();
      renderMedia();
      renderParts();
      updateStylePop();
    }
    reportState(c.action === 'get');
  }

  // ---------- Pages and boards from the pad ----------
  // The pad shows every page as a picture too: it asks for them ('thumbs'), goes to one, or moves one. Messages for the
  // pad go through PadLink ('toPad').
  const toPad = (msg) => post({ type: 'toPad', msg });
  function sendPagePictures() {
    toPad({ t: 'pagethumbs', cur, list: pages.map((p) => pagePicture(p, 192, 108).toDataURL('image/jpeg', 0.6)) });
  }
  function padPages(p) {
    if (p.op === 'thumbs') sendPagePictures();
    else if (p.op === 'go') goTo(p.n);
    else if (p.op === 'move') { movePage(p.from, p.to); sendPagePictures(); }
  }

  // Boards from the pad: the list, open one, start a new one.
  let padWantsBoards = false;
  function padBoards(b) {
    if (b.op === 'list') { padWantsBoards = true; post({ type: 'boardList' }); }
    else if (b.op === 'open' && b.id) { saveNow(); toast('Opening the board…'); post({ type: 'boardOpen', id: b.id }); }
    else if (b.op === 'new') { startNewBoard(); toast('Started a new board. The previous one is saved.'); }
  }

  // ---------- tips ----------

  $('#helpBtn').addEventListener('click', () => { $('#boardHelp').hidden = false; });
  // Each topic's page in the PadLink guide (getpadlink.com), for Learn more. Students' boards don't show it.
  const GUIDE = 'https://getpadlink.com/guide/';
  const guidePages = { draw: 'whiteboard.html#pens', shapes: 'whiteboard.html#shapes', text: 'whiteboard.html#text', select: 'whiteboard.html#select',
    add: 'whiteboard.html#bring', pages: 'whiteboard.html#pages', boards: 'whiteboard.html#boards', go: 'planning.html', students: 'students.html',
    ipad: 'whiteboard.html#ipad', keys: 'whiteboard.html#keys' };
  $('#helpGuide').hidden = !!student;
  $('#helpGuide').addEventListener('click', (e) => { e.preventDefault(); openLink($('#helpGuide').href); });
  // Tips: one topic at a time
  for (const b of document.querySelectorAll('.help-nav button')) b.addEventListener('click', () => {
    for (const n of document.querySelectorAll('.help-nav button')) n.classList.toggle('on', n === b);
    for (const s of document.querySelectorAll('.help-pane section')) s.hidden = s.dataset.topic !== b.dataset.topic;
    $('.help-pane').scrollTop = 0;
    $('#helpGuide').href = GUIDE + (guidePages[b.dataset.topic] || 'whiteboard.html');
  });
  $('#helpClose').addEventListener('click', () => { $('#boardHelp').hidden = true; });

  // ---------- save ----------
  $('#save').addEventListener('click', () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = ph(); // the whole page, however tall
    renderPage(c.getContext('2d'), page());
    const dataUrl = c.toDataURL('image/png');
    const name = `whiteboard-page-${cur + 1}.png`;
    if (host) post({ type: 'saveImage', dataUrl, name });
    else { const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click(); }
  });

  // ---------- window ----------
  $('#fullscreen').addEventListener('click', () => post({ type: 'fullscreen' }));
  $('#close').addEventListener('click', () => { finishText(); saveNow(); post({ type: 'close' }); });

  let toastTimer = 0;
  function toast(text, ms = 3500) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  if (host) {
    host.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.t === 'notice') { toast(msg.text, 5000); return; }
      if (msg.t && classPanel.onMessage(msg)) return; // Class tools news (timer, class lists, a name picked)
      if (msg.t && pcSettings && pcSettings.onMessage(msg)) return; // the PC's settings (Settings)
      switch (msg.type) {
        case 'image': placeImage(msg.dataUrl); break;
        case 'pdf': openPicker(msg); break;
        case 'thumb': {
          const img = document.querySelector(`.thumb[data-index="${msg.index}"] img`);
          if (img && pdf && pdf.id === msg.id) img.src = msg.dataUrl;
          break;
        }
        // In order: each page waits for the one before (its picture loads first), and Done for the last page.
        case 'pdfPage': pdfWork = pdfWork.then(() => addPdfPage(msg)).catch((err) => console.warn(err)); break;
        case 'pdfDone': pdfWork = pdfWork.then(() => finishPdf(msg)); break;
        case 'saved': toast('Saved ' + msg.path); break;
        case 'capture': addCapture(msg); break;
        case 'windows':
          if (padWantsWindows) { padWantsWindows = false; padWindows = msg.list; reportState(); } // for the pad's list
          else showWindowList(msg.list);
          break;
        case 'status': toast(msg.text); break;
        case 'goPage': if (Number.isInteger(msg.page) && msg.page >= 0 && msg.page < pages.length) { goTo(msg.page); pageMenu.hidden = true; } break;
        case 'boardData': boardLoading = loadBoard(msg); break;
        case 'goPair': if (!goDialog.hidden) showGoPair(msg); break;
        case 'openGo': $('#goBoards').click(); break; // the PC window's PadLink Go link
        case 'openBoard': saveNow(); toast('Opening the board from PadLink Go…'); post({ type: 'boardOpen', id: msg.id }); break; // Go's Open on the PC
        case 'boardArrived': boardArrived(msg); break;
        case 'boardNone': startNewBoard(); break;
        case 'saveNow': saveNow(); post({ type: 'savedNow' }); break; // PadLink is closing (or restarting to update)
        case 'device': onDevice(!!msg.connected); break;
        case 'boards':
          showBoards(msg.list);
          if (padWantsBoards) { padWantsBoards = false; toPad({ t: 'boards', list: msg.list, current: boardId, name: boardName }); }
          break;
        case 'boardSaved': if (msg.id === boardId) setSaveState('Saved'); break;
        case 'error':
          toast(msg.message, 8000);
          closePicker(true);
          sentImages = new Set(); // in case it was a save that failed: send every picture again next time
          break;
        case 'notice': toast(msg.message, 15000); break;
        case 'wb': padCommand(msg.cmd || {}); break;
        case 'follow': mirrorFollow(msg.on); break; // Student Mode: Follow me
        case 'sendPage': sendPageToStudents(); break; // Student Mode: Send my page
        case 'studentTools': setStudentTools(msg.allow); break; // a student's board: what the teacher allows
        case 'showStudent': showStudent(msg); break;
        case 'laserIn': laserToClass(Array.isArray(msg.pts) ? msg.pts : [], !!msg.down, msg.style, msg.color); break; // the pad's laser (Remote mode), over this window
        case 'showScroll': shownScroll(msg.y); break; // the teacher scrolled the board on show (in Look closer)
        case 'joinCode': showJoinCode(msg); break; // the class's join code, over the whiteboard
        case 'teams': showTeams(msg); break; // every team and seat, over the whiteboard
        case 'openStudents': openClass(true); classPanel.showTab('students'); break; // PadLink's Students button // a student's board shown to the class, over this one
        case 'teacherInk': boardLoading = boardLoading.then(() => teacherInk(msg)); break; // a student's board: the teacher wrote on it
        case 'markOthers': boardLoading = boardLoading.then(() => markOthers(msg)); break; // marking: the student's work changed
        case 'addPage': boardLoading = boardLoading.then(() => addSentPage(msg)); break; // a student's board: the teacher sent a page
      }
    });
  }

  // ---------- copy and paste ----------
  // Keep PadLink objects in memory: Safari does not reliably preserve custom clipboard types. A small plain-text
  // description is also put on the system clipboard, both as a useful fallback marker and for pasting elsewhere.
  const BOARD_CLIPBOARD_TYPE = 'application/x-padlink-board-selection';
  let boardClipboard = null; // { token, label, items, images, pastes }

  document.addEventListener('copy', (e) => {
    if (e.target instanceof Element && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) return; // copying typed words
    const chosen = selectedItems();
    if (!chosen.length || !e.clipboardData) return;
    const ids = new Set();
    for (const it of chosen) imagesIn(it, ids);
    const token = newId() + newId();
    const label = chosen.length === 1 ? `PadLink board object: ${selInfo(chosen[0]).name}` : `PadLink board selection: ${chosen.length} objects`;
    boardClipboard = {
      token,
      label,
      items: structuredClone(chosen),
      images: Object.fromEntries([...ids].map((id) => [id, imageData.get(id)]).filter(([, url]) => !!url)),
      pastes: 0,
    };
    e.preventDefault();
    e.clipboardData.setData('text/plain', label);
    try { e.clipboardData.setData(BOARD_CLIPBOARD_TYPE, token); } catch { /* Safari keeps the plain-text marker */ }
    toast(`Copied ${chosen.length === 1 ? 'the object' : `${chosen.length} objects`}.`);
  });

  async function pasteBoardObjects(clip) {
    finishText();
    const imageIds = new Map();
    for (const [oldId, url] of Object.entries(clip.images)) {
      // The same picture already on this board (copied within it): share it, rather than keep a second copy
      if (imageData.get(Number(oldId)) === url) { imageIds.set(Number(oldId), Number(oldId)); continue; }
      try { imageIds.set(Number(oldId), (await addImage(url)).id); } catch { imageIds.set(Number(oldId), -1); }
    }
    const offset = 30 * ++clip.pastes;
    const copies = clip.items.map((original) => {
      const copy = structuredClone(original);
      const all = copy.type === 'group' ? [copy, ...leaves(copy)] : [copy];
      for (const it of all) {
        if (it.id) it.id = newId();
        if (it.type === 'image') it.img = imageIds.get(it.img) ?? -1;
      }
      moveItem(copy, offset, offset);
      return copy;
    });
    pushUndo();
    page().items.push(...copies);
    for (const copy of copies) { const b = bounds(copy); growFor(b.y + b.h); }
    setTool('select');
    selectMany(copies);
    renderBase();
    toast(`Pasted ${copies.length === 1 ? 'the object' : `${copies.length} objects`}.`);
  }

  // Ctrl+V: copied PadLink objects keep their formatting and pictures; an outside picture or words are imported.
  document.addEventListener('paste', async (e) => {
    if (e.target instanceof Element && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) return; // typing
    const words = e.clipboardData?.getData('text/plain');
    let token = '';
    try { token = e.clipboardData?.getData(BOARD_CLIPBOARD_TYPE) || ''; } catch { /* custom clipboard types may be hidden */ }
    if (boardClipboard && (token === boardClipboard.token || (!token && words === boardClipboard.label))) {
      e.preventDefault();
      await pasteBoardObjects(boardClipboard);
      return;
    }
    const items = [...(e.clipboardData?.items || [])];
    const pic = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (pic) {
      e.preventDefault();
      const file = pic.getAsFile();
      const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      await placeImage(url);
      toast('Pasted the picture. Drag it, or resize it from a corner.');
      return;
    }
    if (words && words.trim()) {
      e.preventDefault();
      finishText();
      const ink = isDark(page()) ? '#ffffff' : '#1f2328';
      const x = view.x + 80, y = view.y + 80;
      const href = !student && !teamBoard && /^\s*https?:\/\/\S+\s*$/i.test(words) ? PadText.cleanHref(words.trim()) : null;
      const paras = href
        ? PadText.clean([{ r: [{ s: words.trim(), c: '#1971c2', f: 'clean', z: TEXT_Z, href }] }]) // a web address: a link, ready to click
        : PadText.clean(words.replace(/\r/g, '').split('\n').slice(0, 200).map((line) => ({ r: [{ s: line, c: ink, f: 'clean', z: PadText.DEFAULT_Z }] })));
      const item = { type: 'text', id: newId(), x, y, w: Math.min(1100, W - x - 40), paras };
      pushUndo();
      page().items.push(item);
      setTool('select');
      select(item);
      renderBase();
      toast(href ? 'Pasted the link. Click it with Select to open it; change its words with Text.' : 'Pasted the words as a text box. Double-click it to change them.');
    }
  });

  // ---------- keyboard ----------
  const KEY_TOOLS = { v: 'select', p: 'pen', h: 'highlighter', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', e: 'eraser', t: 'text', m: 'math', n: 'note', k: 'laser' };
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && (e.target.matches('input, select, textarea') || e.target.isContentEditable)) return; // typing in a box
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); }
    else if (e.ctrlKey && k === 'd' && selected) { editSelected('dup'); e.preventDefault(); }
    else if (e.ctrlKey && k === 'a') { editSelected('all'); e.preventDefault(); }
    else if (e.ctrlKey && k === 'g' && selected) { editSelected(e.shiftKey ? 'ungroup' : 'group'); e.preventDefault(); }
    else if (selected && k.startsWith('arrow')) { // nudge (Shift: further)
      const d = e.shiftKey ? 20 : 2;
      pushUndo();
      replaceSelected();
      moveItem(selected, k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0);
      renderBase();
      e.preventDefault();
    }
    else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { redo(); e.preventDefault(); }
    else if (k === 'delete' || k === 'backspace') { if (selected) deleteSelectionOrClear(); }
    else if (k === 'escape') {
      const open = ['#captureMenu', '#pageMenu', '#boardsMenu', '#windowsDialog', '#urlDialog', '#boardHelp', '#driveDialog'].map((s) => $(s)).find((el) => !el.hidden);
      if (open) open.hidden = true;
      else if (!$('#classSheet').hidden) openClass(false);
      else if (selected && !editing) { select(null); renderBase(); }
      else if (editing) finishText();
      else if (!$('#picker').hidden) closePicker(true);
      else select(null);
    }
    else if (k === 'arrowdown' || k === 'arrowup') { panBy(0, (k === 'arrowdown' ? 1 : -1) * H / view.z / 3); e.preventDefault(); }
    else if (k === 'home' || k === 'end') { view.y = k === 'home' ? 0 : ph(); clampView(); renderBase(); }
    else if ((k === 'pagedown' || k === 'arrowright') && allowed('move')) goTo(cur + 1);
    else if ((k === 'pageup' || k === 'arrowleft') && allowed('move')) goTo(cur - 1);
    else if (k === 'f11') { post({ type: 'fullscreen' }); e.preventDefault(); }
    else if (!e.ctrlKey && !e.altKey && KEY_TOOLS[k] && !(student && KEY_TOOLS[k] === 'laser')) setTool(KEY_TOOLS[k]);
  });

  setTool('pen');
  layout();
  reportState(true);
  post({ type: 'mirror', msg: { t: 'mready' } }); // loaded: an iPad drawing its own copy asks for it now
  // Carry on with the last board (PadLink reopens it after a restart); a new one if there isn't any.
  if (host) post({ type: 'boardLast' });
  else { boardName = defaultName(); updateBoardUI(); }
})();
