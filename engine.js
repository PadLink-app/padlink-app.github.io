// PadLink whiteboard engine: how a page and everything on it is drawn, shared by the whiteboard on the PC (board.js)
// and the iPad or iPhone (pad.js), so both draw the same board the same way.
// Pages and items are plain data (see board.js); pictures are looked up by id through hooks the host sets.
window.PadEngine = (() => {
  'use strict';

  const W = 1920;
  const H = 1080; // height of a new page, and of the visible part of a page at 100%
  const ph = (p) => p.h || H;
  // Stroke widths for each size choice (0-2), per pen type, highlighter, shapes and the eraser.
  const SIZES = {
    pen: [3, 6, 12],
    marker: [6, 12, 22],
    pencil: [3, 5, 9],
    crayon: [8, 14, 22],
    chalk: [8, 14, 24],
    highlighter: [16, 28, 44],
    shape: [3, 6, 12],
    eraser: [16, 32, 64],
  };

  // What the host knows: its pictures, and which text box is being typed in (drawn differently, or not at all).
  const hooks = { image: () => null, isEditing: () => false, skipText: () => false };
  const configure = (h) => Object.assign(hooks, h);

  /** A rounded rectangle path (radius r, or [top-left, top-right, bottom-right, bottom-left]); works on older Safari too. */
  function roundRect(ctx, x, y, w, h, r) {
    const [a, b, c, d] = (Array.isArray(r) ? [...r, 0, 0, 0, 0] : [r, r, r, r]).map((v) => Math.max(0, Math.min(v || 0, w / 2, h / 2)));
    ctx.moveTo(x + a, y);
    ctx.lineTo(x + w - b, y);
    ctx.arcTo(x + w, y, x + w, y + b, b);
    ctx.lineTo(x + w, y + h - c);
    ctx.arcTo(x + w, y + h, x + w - c, y + h, c);
    ctx.lineTo(x + d, y + h);
    ctx.arcTo(x, y + h, x, y + h - d, d);
    ctx.lineTo(x, y + a);
    ctx.arcTo(x, y, x + a, y, a);
    ctx.closePath();
  }

  // ---------- rendering ----------
  const isDark = (p) => p.bg === 'dark';

  function drawBackground(ctx, p) {
    const H = ph(p);
    ctx.fillStyle = isDark(p) ? '#1f3329' : '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = isDark(p) ? 'rgba(255,255,255,0.08)' : 'rgba(30,60,120,0.12)';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    if (p.bg === 'grid' || p.bg === 'lines') {
      ctx.beginPath();
      for (let y = 60; y < H; y += 60) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      if (p.bg === 'grid') for (let x = 60; x < W; x += 60) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      ctx.stroke();
    } else if (p.bg === 'dots') {
      ctx.fillStyle = 'rgba(30,60,120,0.3)';
      for (let y = 40; y < H; y += 40) for (let x = 40; x < W; x += 40) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    if (p.doc) {
      const img = hooks.image(p.doc.img);
      if (img) { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, p.doc.x, p.doc.y, p.doc.w, p.doc.h); } // shrunk to fit: keep text crisp
    }
  }

  const strokeWidth = (size, pressure) => size * (0.35 + 1.3 * pressure);

  // ---------- ink ----------
  // Pen strokes are drawn as one filled outline around a smoothed path, so the width follows the Pencil smoothly and
  // the ends taper. Marker, colored pencil, crayon and chalk use the same outline with their own look; the textures
  // are fixed patterns (seeded), so a saved board always looks the same when it's opened again.

  /** Smooth the raw points a little (each point moves part of the way from the last smoothed one). */
  function smoothPoints(pts, amount = 0.4) {
    if (pts.length < 3) return pts.map((p) => [p[0], p[1], p[2] ?? 0.5]);
    const out = [[pts[0][0], pts[0][1], pts[0][2] ?? 0.5]];
    for (let i = 1; i < pts.length; i++) {
      const prev = out[out.length - 1];
      const p = pts[i];
      const k = i === pts.length - 1 ? 1 : 1 - amount; // the last point stays where the Pencil lifted
      out.push([prev[0] + (p[0] - prev[0]) * k, prev[1] + (p[1] - prev[1]) * k, p[2] ?? 0.5]);
    }
    return out;
  }

  /**
   * The outline around a stroke as [left side, right side] point lists. `widthAt(i, along, total)` gives the full width
   * at point i. Points closer together than a fraction of the width are skipped so the edges stay clean.
   */
  function strokeOutline(pts, widthAt) {
    const keep = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const last = keep[keep.length - 1];
      if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) > 0.8 || i === pts.length - 1) keep.push(pts[i]);
    }
    const n = keep.length;
    const dist = [0];
    for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(keep[i][0] - keep[i - 1][0], keep[i][1] - keep[i - 1][1]));
    const total = dist[n - 1] || 1;
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const a = keep[Math.max(0, i - 1)], b = keep[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const w = widthAt(keep[i], dist[i], total) / 2;
      left.push([keep[i][0] - dy * w, keep[i][1] + dx * w, w]);
      right.push([keep[i][0] + dy * w, keep[i][1] - dx * w, w]);
    }
    return { left, right, pts: keep };
  }

  /** Trace the outline as a smooth closed path with round ends. */
  function traceOutline(ctx, o) {
    const { left, right, pts } = o;
    const n = pts.length;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < n; i++) {
      const mx = (left[i - 1][0] + left[i][0]) / 2, my = (left[i - 1][1] + left[i][1]) / 2;
      ctx.quadraticCurveTo(left[i - 1][0], left[i - 1][1], mx, my);
    }
    ctx.lineTo(left[n - 1][0], left[n - 1][1]);
    // round end
    const end = pts[n - 1];
    const ae = Math.atan2(left[n - 1][1] - end[1], left[n - 1][0] - end[0]);
    ctx.arc(end[0], end[1], left[n - 1][2], ae, ae - Math.PI, true);
    for (let i = n - 1; i > 0; i--) {
      const mx = (right[i][0] + right[i - 1][0]) / 2, my = (right[i][1] + right[i - 1][1]) / 2;
      ctx.quadraticCurveTo(right[i][0], right[i][1], mx, my);
    }
    ctx.lineTo(right[0][0], right[0][1]);
    const start = pts[0];
    const as = Math.atan2(right[0][1] - start[1], right[0][0] - start[0]);
    ctx.arc(start[0], start[1], right[0][2], as, as - Math.PI, true);
    ctx.closePath();
  }

  // Seeded noise so textures are the same every time.
  function seededRandom(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  const grainCache = new Map();
  /** A repeating texture for a medium in one color (alpha carries the grain). */
  function grainPattern(ctx, medium, color) {
    const key = medium + '|' + color;
    const cached = grainCache.get(key);
    if (cached) return ctx.createPattern(cached, 'repeat');
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const rnd = seededRandom(medium === 'pencil' ? 11 : medium === 'crayon' ? 23 : 37);
    // Color from the hex value
    const hex = color.replace('#', '');
    const full = hex.length === 3 ? hex.split('').map((h) => h + h).join('') : hex.padEnd(6, '0');
    const r = parseInt(full.slice(0, 2), 16), gr = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
    // A slightly blurred noise field for crayon and chalk (waxy / dusty clumps rather than single pixels)
    const field = new Float32Array(size * size);
    for (let i = 0; i < field.length; i++) field[i] = rnd();
    const smooth = (x, y) => {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) sum += field[((y + dy + size) % size) * size + ((x + dx + size) % size)];
      return sum / 15;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let a;
        if (medium === 'pencil') {
          const v = field[y * size + x];
          a = v < 0.18 ? 0.15 : 0.55 + 0.45 * v;              // fine graphite grain
        } else if (medium === 'crayon') {
          const v = smooth(x, y);
          a = v < 0.42 ? 0.05 : Math.min(1, 0.7 + (v - 0.42) * 1.5); // waxy, with paper showing through
        } else { // chalk
          const v = smooth(x, y) * 0.6 + field[y * size + x] * 0.4;
          a = v < 0.45 ? 0 : Math.min(0.95, 0.45 + (v - 0.45) * 2); // dusty, with gaps
        }
        const o = (y * size + x) * 4;
        img.data[o] = r; img.data[o + 1] = gr; img.data[o + 2] = b; img.data[o + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    grainCache.set(key, c);
    return ctx.createPattern(c, 'repeat');
  }

  const MEDIA = {
    // width range from pressure (as a multiple of the size), taper, texture, opacity
    pen:    { min: 0.35, max: 1.65, taper: true },
    marker: { min: 0.9, max: 1.1, taper: false, alpha: 0.9 },
    pencil: { min: 0.55, max: 1.25, taper: true, grain: true },
    crayon: { min: 0.85, max: 1.2, taper: false, grain: true },
    chalk:  { min: 0.8, max: 1.15, taper: false, grain: true },
  };

  function drawInk(ctx, s) {
    const m = MEDIA[s.medium] || MEDIA.pen;
    const pts = smoothPoints(s.pts, s.medium === 'marker' ? 0.5 : 0.4);
    const taperLen = Math.max(12, s.size * 4);
    const widthAt = (p, along, total) => {
      let w = s.size * (m.min + (m.max - m.min) * (p[2] ?? 0.5));
      if (m.taper) {
        // (an end the eraser cut keeps its full width: cut0 the start, cut1 the end)
        const t = Math.min(1, s.cut0 ? 1 : along / taperLen, s.cut1 ? 1 : (total - along) / (taperLen * 0.8));
        w *= 0.45 + 0.55 * Math.max(0, t);
      }
      return Math.max(0.8, w);
    };
    ctx.save();
    if (m.alpha) ctx.globalAlpha = m.alpha;
    if (m.grain) {
      // Lighter pressure shows more paper through the grain (pencil especially).
      const avg = pts.reduce((sum, p) => sum + (p[2] ?? 0.5), 0) / pts.length;
      ctx.globalAlpha = s.medium === 'pencil' ? 0.55 + 0.45 * Math.min(1, avg * 1.4) : 0.95;
      ctx.fillStyle = grainPattern(ctx, s.medium, s.color);
    } else {
      ctx.fillStyle = s.color;
    }
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], widthAt(pts[0], 0, 1) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      traceOutline(ctx, strokeOutline(pts, widthAt));
      ctx.fill();
    }
    ctx.restore();
  }


  /** The highlighter's path (smoothed points) on a context. */
  function highlighterPath(g, hp) {
    g.beginPath();
    g.moveTo(hp[0][0], hp[0][1]);
    if (hp.length === 1) g.lineTo(hp[0][0] + 0.1, hp[0][1]);
    for (let i = 1; i < hp.length - 1; i++) {
      g.quadraticCurveTo(hp[i][0], hp[i][1], (hp[i][0] + hp[i + 1][0]) / 2, (hp[i][1] + hp[i + 1][1]) / 2);
    }
    if (hp.length > 1) g.lineTo(hp[hp.length - 1][0], hp[hp.length - 1][1]);
  }

  /**
   * A highlighter stroke, blended (multiply on light pages, screen on dark ones) so the words under it stay readable.
   * The stroke is drawn plain on a small layer of its own first, and that layer is blended onto the page: Safari (the
   * iPad and iPhone) draws a long, self-crossing path badly when it's blended straight onto the page (pale patches
   * with straight edges), while blending a picture works everywhere.
   */
  let hlLayer = null;
  function drawHighlighter(ctx, hp, s, dark) {
    const mode = dark ? 'screen' : 'multiply', alpha = dark ? 0.6 : 0.8;
    const T = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const canvas = ctx.canvas;
    const direct = () => {
      ctx.save();
      ctx.globalCompositeOperation = mode;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      highlighterPath(ctx, hp);
      ctx.stroke();
      ctx.restore();
    };
    if (!T || !canvas || typeof document === 'undefined') { direct(); return; }
    // Where the stroke lands on the canvas, in its pixels
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of hp) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const pad = s.size / 2 + 2;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      const px = T.a * x + T.c * y + T.e, py = T.b * x + T.d * y + T.f;
      if (px < dx0) dx0 = px; if (px > dx1) dx1 = px; if (py < dy0) dy0 = py; if (py > dy1) dy1 = py;
    }
    dx0 = Math.max(0, Math.floor(dx0)); dy0 = Math.max(0, Math.floor(dy0));
    dx1 = Math.min(canvas.width, Math.ceil(dx1)); dy1 = Math.min(canvas.height, Math.ceil(dy1));
    const w = dx1 - dx0, h = dy1 - dy0;
    if (w <= 0 || h <= 0) return; // off the canvas
    if (w * h > 16e6) { direct(); return; } // (bigger than a layer can be)
    if (!hlLayer) hlLayer = document.createElement('canvas');
    if (hlLayer.width < w || hlLayer.height < h) { hlLayer.width = Math.max(hlLayer.width, w); hlLayer.height = Math.max(hlLayer.height, h); }
    const g = hlLayer.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, w, h);
    g.setTransform(T.a, T.b, T.c, T.d, T.e - dx0, T.f - dy0);
    g.strokeStyle = s.color;
    g.lineWidth = s.size;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    highlighterPath(g, hp);
    g.stroke();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = mode;
    ctx.globalAlpha = alpha;
    ctx.drawImage(hlLayer, 0, 0, w, h, dx0, dy0, w, h);
    ctx.restore();
  }

  function drawStroke(ctx, s, dark) {
    const pts = s.pts;
    if (!pts.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;

    if (s.tool === 'highlighter') {
      // One smoothed path at constant width, so overlapping parts of the same stroke don't get darker.
      // Multiply keeps text underneath readable on light pages.
      const hp = smoothPoints(pts, 0.55);
      ctx.restore();
      drawHighlighter(ctx, hp, s, dark);
      return;
    }
    ctx.restore();
    drawInk(ctx, s);
  }

  // ---------- shapes ----------
  // Every shape is a box (x1,y1)-(x2,y2) plus a kind; fraction shapes, number lines and axes also have `parts`, and
  // fraction shapes a list of `shaded` sections (tap a section with the Shapes tool to shade it).

  const PARTS_SHAPES = new Set(['fcircle', 'fbar', 'numline', 'axes', 'polygon', 'star']); // polygon: sides; star: points
  const DEFAULT_PARTS = { fcircle: 4, fbar: 4, numline: 10, axes: 5, polygon: 8, star: 5 };
  // A ruler measures in board units, so it agrees with anything drawn at every zoom: 96 to the inch (a screen inch),
  // which makes a page 20 inches (50.8 cm) wide. It's always this thick; its length is how far it was dragged.
  const PER_INCH = 96, PER_CM = 96 / 2.54, RULER_T = 110;
  const MIN_SIDES = 3;
  const MAX_SIDES = 12; // beyond this a polygon looks like a circle
  const SQUARE_SHAPES = new Set(['fcircle', 'pentagon', 'hexagon', 'polygon', 'star', 'protractor']); // always drawn regular (a protractor: twice as wide as tall)
  // Measuring tools: a ruler and a protractor, see-through, to move and turn over a drawing. Solid to a tap inside.
  const MEASURE_SHAPES = new Set(['ruler', 'protractor']);
  // Shapes whose line can be solid, dashed or dotted (s.dash: 'dash' | 'dot'; none = solid).
  const DASH_SHAPES = new Set(['line', 'arrow', 'darrow', 'rect', 'rrect', 'ellipse', 'triangle', 'rtriangle', 'pentagon', 'hexagon', 'polygon', 'fcircle', 'fbar', 'star', 'bubble']);
  /** A dashed or dotted line's pattern for this thickness (round ends make the dots round), or [] for solid. */
  const dashPattern = (s) => (s.dash === 'dash' ? [Math.max(10, s.size * 3.2), Math.max(8, s.size * 2.4)] : s.dash === 'dot' ? [0.01, Math.max(7, s.size * 2.2)] : []);

  const box = (s) => ({ x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) });

  /** Corners of a regular polygon fitted to the box: a corner at the top, or (for the Polygon shape with an even
   *  number of sides) a flat top and bottom, so 4 sides is a square rather than a diamond. */
  function polygonPoints(s, n) {
    const b = box(s), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const turn = s.shape === 'polygon' && n % 2 === 0 ? Math.PI / n : 0;
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + turn + (i * 2 * Math.PI) / n;
      return [cx + (b.w / 2) * Math.cos(a), cy + (b.h / 2) * Math.sin(a)];
    });
  }

  /** The outline of a shape as polylines, for drawing and for hit-testing (select, eraser). */
  function shapeLines(s) {
    const b = box(s), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const ring = (n = 48) => Array.from({ length: n + 1 }, (_, i) => {
      const a = (i * 2 * Math.PI) / n;
      return [cx + (b.w / 2) * Math.cos(a), cy + (b.h / 2) * Math.sin(a)];
    });
    const rect = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x, b.y]];
    switch (s.shape) {
      case 'line': case 'arrow': case 'darrow': return [[[s.x1, s.y1], [s.x2, s.y2]]];
      case 'rect': return [rect];
      case 'rrect': { // corners rounded by a fifth of the shorter side
        const r = Math.min(b.w, b.h) * 0.2, k = 6;
        const arc = (ax, ay, a0) => Array.from({ length: k + 1 }, (_, i) => { const a = a0 + (i * Math.PI) / 2 / k; return [ax + r * Math.cos(a), ay + r * Math.sin(a)]; });
        const pts = [...arc(b.x + b.w - r, b.y + r, -Math.PI / 2), ...arc(b.x + b.w - r, b.y + b.h - r, 0), ...arc(b.x + r, b.y + b.h - r, Math.PI / 2), ...arc(b.x + r, b.y + r, Math.PI)];
        return [[...pts, pts[0]]];
      }
      case 'ellipse': return [ring()];
      case 'triangle': return [[[cx, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [cx, b.y]]];
      case 'rtriangle': return [[[b.x, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h], [b.x, b.y]]];
      case 'pentagon': case 'hexagon': case 'polygon': {
        const n = s.shape === 'pentagon' ? 5 : s.shape === 'hexagon' ? 6 : Math.max(MIN_SIDES, Math.min(MAX_SIDES, s.parts || DEFAULT_PARTS.polygon));
        const pts = polygonPoints(s, n);
        return [[...pts, pts[0]]];
      }
      case 'fcircle': {
        const n = s.parts || 4;
        const spokes = Array.from({ length: n }, (_, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          return [[cx, cy], [cx + (b.w / 2) * Math.cos(a), cy + (b.h / 2) * Math.sin(a)]];
        });
        return [ring(), ...(n > 1 ? spokes : [])];
      }
      case 'fbar': {
        const n = s.parts || 4;
        const dividers = Array.from({ length: n - 1 }, (_, i) => [[b.x + (b.w * (i + 1)) / n, b.y], [b.x + (b.w * (i + 1)) / n, b.y + b.h]]);
        return [rect, ...dividers];
      }
      case 'numline': {
        const y = s.y1, xa = Math.min(s.x1, s.x2), xb = Math.max(s.x1, s.x2);
        return [[[xa, y], [xb, y]]];
      }
      case 'star': { // points around the outside, corners in between at 0.42 of the way out
        const n = Math.max(3, Math.min(12, s.parts || DEFAULT_PARTS.star));
        const pts = Array.from({ length: n * 2 }, (_, i) => {
          const a = -Math.PI / 2 + (i * Math.PI) / n, k = i % 2 ? 0.42 : 1;
          return [cx + (b.w / 2) * k * Math.cos(a), cy + (b.h / 2) * k * Math.sin(a)];
        });
        return [[...pts, pts[0]]];
      }
      case 'cube': { // the outline first (for a fill), then the front's top and right edges and one edge going back
        const c = cubePoints(b);
        return [[c.A, c.A2, c.B2, c.C2, c.C, c.D, c.A], [c.A, c.B, c.C], [c.B, c.B2]];
      }
      case 'cylinder': { // the outline, then the front of the top
        const ry = Math.min(b.h * 0.16, b.w * 0.25), k = 24;
        const half = (ey, a0, a1) => Array.from({ length: k + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / k; return [cx + (b.w / 2) * Math.cos(a), ey + ry * Math.sin(a)]; });
        const top = b.y + ry, bottom = b.y + b.h - ry;
        return [[...half(top, Math.PI, 2 * Math.PI), ...half(bottom, 0, Math.PI), [b.x, top]], half(top, 0, Math.PI)];
      }
      case 'bubble': { // a speech bubble: a rounded box with a tail at the bottom left
        const bh = b.h * 0.78, r = Math.min(b.w, bh) * 0.2, k = 6;
        const arc = (ax, ay, a0) => Array.from({ length: k + 1 }, (_, i) => { const a = a0 + (i * Math.PI) / 2 / k; return [ax + r * Math.cos(a), ay + r * Math.sin(a)]; });
        const yb = b.y + bh;
        const pts = [...arc(b.x + b.w - r, b.y + r, -Math.PI / 2), ...arc(b.x + b.w - r, yb - r, 0),
          [b.x + b.w * 0.42, yb], [b.x + b.w * 0.12, b.y + b.h], [b.x + b.w * 0.24, yb],
          ...arc(b.x + r, yb - r, Math.PI / 2), ...arc(b.x + r, b.y + r, Math.PI)];
        return [[...pts, pts[0]]];
      }
      case 'ruler': return [rect];
      case 'protractor': { // a half circle on its flat edge
        const r = Math.min(b.w / 2, b.h), oy = b.y + b.h;
        return [[...Array.from({ length: 49 }, (_, i) => { const a = Math.PI + (i * Math.PI) / 48; return [cx + r * Math.cos(a), oy + r * Math.sin(a)]; }), [cx - r, oy]]];
      }
      case 'axes': {
        if (!s.quad) return [[[b.x, cy], [b.x + b.w, cy]], [[cx, b.y], [cx, b.y + b.h]]];
        const ox = b.x + 6, oy = b.y + b.h - 6; // first quadrant only: the origin at the bottom left
        return [[[ox, oy], [b.x + b.w, oy]], [[ox, oy], [ox, b.y]]];
      }
    }
    return [rect];
  }

  /** A cube drawn in a box: the front square (A top left, B, C, D) and the back one (A2...) up and to the right. */
  function cubePoints(b) {
    const d = Math.min(b.w, b.h) * 0.3;
    const A = [b.x, b.y + d], B = [b.x + b.w - d, b.y + d], C = [b.x + b.w - d, b.y + b.h], D = [b.x, b.y + b.h];
    const back = (p) => [p[0] + d, p[1] - d];
    return { A, B, C, D, A2: back(A), B2: back(B), C2: back(C), D2: back(D) };
  }

  /** A ruler in inches (16ths) or centimeters (millimeters), s.units, at the board's fixed scale: 0 near one end and
   *  as many inches or centimeters as fit. Long and thin either way: an upright one reads from the top down. */
  function drawRuler(ctx, s, b) {
    const cm = s.units === 'cm', unit = cm ? PER_CM : PER_INCH, sub = cm ? 10 : 16;
    const upright = b.h > b.w;
    const L = upright ? b.h : b.w, T = upright ? b.w : b.h;
    ctx.save();
    if (upright) { ctx.translate(b.x + b.w, b.y); ctx.rotate(Math.PI / 2); } else ctx.translate(b.x, b.y);
    ctx.beginPath();
    roundRect(ctx, 0, 0, L, T, Math.min(8, T * 0.15));
    ctx.fillStyle = 'rgba(255, 224, 102, 0.42)';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, s.size * 0.4);
    ctx.stroke();
    const pad = 12, steps = Math.max(0, Math.floor(((L - 2 * pad) / unit) * sub + 1e-6));
    // Tick lengths: whole units longest; then halves; then (inches) quarters, eighths, sixteenths, or (cm) millimeters.
    const tick = (i) => (i % sub === 0 ? 0.42 : i % (sub / 2) === 0 ? 0.32 : cm ? 0.17 : i % 4 === 0 ? 0.25 : i % 2 === 0 ? 0.18 : 0.12);
    ctx.lineWidth = Math.max(1, Math.min(2, s.size * 0.25));
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const x = pad + (unit * i) / sub;
      ctx.moveTo(x, 0); ctx.lineTo(x, T * tick(i));
    }
    ctx.stroke();
    const fontPx = Math.max(10, Math.min(26, T * 0.24, unit * 0.45));
    ctx.fillStyle = s.color;
    ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let k = 0; k * sub <= steps; k++) ctx.fillText(String(k), pad + unit * k, T * 0.46);
    ctx.font = `600 ${Math.max(9, fontPx * 0.7)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(cm ? 'cm' : 'in', L - pad, T - 6);
    ctx.restore();
  }

  /** A protractor: degrees 0 to 180 both ways round (outside from the left, inside from the right), a tick for every
   *  degree, and its centre marked on the flat edge. */
  function drawProtractor(ctx, s, b) {
    const r = Math.min(b.w / 2, b.h), cx = b.x + b.w / 2, oy = b.y + b.h;
    if (r < 20) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, oy, r, Math.PI, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = 'rgba(116, 192, 252, 0.22)';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, s.size * 0.4);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, s.size * 0.22);
    ctx.beginPath();
    const step = r >= 160 ? 1 : r >= 80 ? 5 : 10;
    for (let d = 0; d <= 180; d += step) {
      const a = (d * Math.PI) / 180, len = d % 10 === 0 ? 0.1 : d % 5 === 0 ? 0.065 : 0.035;
      ctx.moveTo(cx + r * Math.cos(a), oy - r * Math.sin(a));
      ctx.lineTo(cx + r * (1 - len) * Math.cos(a), oy - r * (1 - len) * Math.sin(a));
    }
    ctx.arc(cx, oy, r * 0.58, 0, Math.PI, true); // the inner ring
    ctx.moveTo(cx - r * 0.05, oy); ctx.lineTo(cx + r * 0.05, oy); // the centre
    ctx.moveTo(cx, oy); ctx.lineTo(cx, oy - r * 0.06);
    ctx.stroke();
    const label = (d, rr, px, text) => {
      const a = (d * Math.PI) / 180;
      ctx.save();
      ctx.translate(cx + rr * Math.cos(a), oy - rr * Math.sin(a));
      ctx.rotate(Math.PI / 2 - a); // along the curve, the way a protractor's numbers read
      ctx.font = `600 ${px}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    ctx.fillStyle = s.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = Math.max(9, Math.min(26, r * 0.075)), small = Math.max(8, Math.min(20, r * 0.058));
    const each = r >= 120 ? 10 : r >= 60 ? 30 : 90;
    for (let d = 0; d <= 180; d += each) {
      label(d, r * 0.82, big, String(180 - d)); // outside: 0 on the left
      if (r >= 140) label(d, r * 0.69, small, String(d)); // inside: 0 on the right (on a big enough one)
    }
    ctx.restore();
  }

  // Shapes that can show geometry marks (s.marks): square corners, ticks on equal sides, arcs on equal angles.
  const MARK_SHAPES = new Set(['rect', 'triangle', 'rtriangle', 'pentagon', 'hexagon', 'polygon']);

  /** Geometry marks on a closed shape: a small square in each right angle, the same number of ticks on sides of
   *  the same length, and the same number of arcs in angles of the same size. Sides or angles that match nothing
   *  get no mark. */
  function drawMarks(ctx, s) {
    const outline = shapeLines(s)[0];
    const v = outline.slice(0, -1), n = v.length;
    const len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    const sides = v.map((p, i) => len(p, v[(i + 1) % n]));
    const shortest = Math.min(...sides);
    if (shortest < 30) return;
    const angles = v.map((p, i) => {
      const a = v[(i + n - 1) % n], c = v[(i + 1) % n];
      const d = ((a[0] - p[0]) * (c[0] - p[0]) + (a[1] - p[1]) * (c[1] - p[1])) / (len(p, a) * len(p, c));
      return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
    });
    /** Which group each value is in (1, 2, 3 in order), or 0 when no other value matches it. */
    const groups = (vals, tol, skip = () => false) => {
      const out = vals.map(() => 0);
      let g = 0;
      vals.forEach((x, i) => {
        if (out[i] || skip(x)) return;
        const same = vals.map((y, j) => (j !== i && !out[j] && !skip(y) && Math.abs(y - x) <= tol ? j : -1)).filter((j) => j >= 0);
        if (!same.length || g >= 3) return;
        g++;
        for (const j of [i, ...same]) out[j] = g;
      });
      return out;
    };
    const right = (a) => Math.abs(a - 90) < 1.5;
    const tickN = groups(sides, Math.max(2, Math.max(...sides) * 0.02));
    const arcN = groups(angles, 1.5, right);
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = Math.max(1.5, s.size * 0.5);
    const unit = (p, q) => { const d = len(p, q) || 1; return [(q[0] - p[0]) / d, (q[1] - p[1]) / d]; };
    const tick = 12 + s.size * 2, gap = 5 + s.size;
    sides.forEach((_, i) => { // ticks across the middle of each side
      const k = tickN[i];
      if (!k) return;
      const p = v[i], q = v[(i + 1) % n], u = unit(p, q), nx = -u[1], ny = u[0];
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      ctx.beginPath();
      for (let t = 0; t < k; t++) {
        const off = (t - (k - 1) / 2) * gap, x = mx + u[0] * off, y = my + u[1] * off;
        ctx.moveTo(x - (nx * tick) / 2, y - (ny * tick) / 2);
        ctx.lineTo(x + (nx * tick) / 2, y + (ny * tick) / 2);
      }
      ctx.stroke();
    });
    const r0 = Math.min(18 + s.size * 2, shortest * 0.22);
    v.forEach((p, i) => { // corners: a square for a right angle, arcs for equal angles
      const a = v[(i + n - 1) % n], c = v[(i + 1) % n], ua = unit(p, a), uc = unit(p, c);
      ctx.beginPath();
      if (right(angles[i])) {
        const m = Math.min(16 + s.size * 2, shortest * 0.2);
        ctx.moveTo(p[0] + ua[0] * m, p[1] + ua[1] * m);
        ctx.lineTo(p[0] + (ua[0] + uc[0]) * m, p[1] + (ua[1] + uc[1]) * m);
        ctx.lineTo(p[0] + uc[0] * m, p[1] + uc[1] * m);
      } else if (arcN[i]) {
        const a0 = Math.atan2(ua[1], ua[0]);
        let d = Math.atan2(uc[1], uc[0]) - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d <= -Math.PI) d += 2 * Math.PI;
        for (let t = 0; t < arcN[i]; t++) {
          const r = r0 + t * (5 + s.size);
          ctx.moveTo(p[0] + r * Math.cos(a0), p[1] + r * Math.sin(a0));
          ctx.arc(p[0], p[1], r, a0, a0 + d, d < 0);
        }
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  /** A number line's range: Parts, and the Start and End numbers (older ones: 0 to Parts, or 0 to 1 in fractions). */
  function numlineRange(s) {
    const n = Math.max(1, s.parts || 10);
    const from = Number.isFinite(s.from) ? s.from : 0;
    const to = Number.isFinite(s.to) ? s.to : from + (s.frac ? 1 : n);
    return { n, from, to };
  }
  const MINUS = '\u2212';
  /** The number under tick i: whole numbers and decimals, or fractions ("1/4", "1 3/4", "\u22121/2") when s.frac. */
  function numlineLabel(s, i) {
    const { n, from, to } = numlineRange(s);
    if (s.frac && Number.isInteger(from) && Number.isInteger(to)) {
      let num = from * n + (to - from) * i, den = n;
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const g = gcd(Math.abs(num), den) || 1;
      num /= g; den /= g;
      const sign = num < 0 ? MINUS : '', a = Math.abs(num);
      if (den === 1) return sign + a;
      const whole = Math.floor(a / den), rest = a % den;
      return sign + (whole ? `${whole} ${rest}/${den}` : `${rest}/${den}`);
    }
    const x = Math.round((from + ((to - from) * i) / n) * 100) / 100;
    return x < 0 ? MINUS + String(-x) : String(x);
  }

  /** Which section of a fraction circle or bar is at (x, y), or -1. */
  function sectionAt(s, x, y) {
    const b = box(s);
    const n = s.parts || 4;
    if (s.shape === 'fbar') {
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return -1;
      return Math.min(n - 1, Math.floor(((x - b.x) / b.w) * n));
    }
    if (s.shape === 'fcircle') {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const nx = (x - cx) / (b.w / 2), ny = (y - cy) / (b.h / 2);
      if (nx * nx + ny * ny > 1) return -1;
      let a = Math.atan2(ny, nx) + Math.PI / 2; // 0 at the top, clockwise
      if (a < 0) a += 2 * Math.PI;
      return Math.min(n - 1, Math.floor(a / ((2 * Math.PI) / n)));
    }
    return -1;
  }

  function arrowHead(ctx, x, y, angle, head) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - head * Math.cos(angle - 0.45), y - head * Math.sin(angle - 0.45));
    ctx.lineTo(x - head * Math.cos(angle + 0.45), y - head * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawShape(ctx, s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const b = box(s);

    if (s.shape === 'line' || s.shape === 'arrow' || s.shape === 'darrow') {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const head = Math.min(14 + s.size * 3, len * (s.shape === 'darrow' ? 0.35 : 0.6));
      // The line stops inside each head (not at the tip), so it never pokes out past the point.
      const back = head * Math.cos(0.45) * 0.7;
      const endBack = s.shape === 'line' ? 0 : back, startBack = s.shape === 'darrow' ? back : 0;
      ctx.beginPath();
      ctx.moveTo(s.x1 + startBack * Math.cos(angle), s.y1 + startBack * Math.sin(angle));
      ctx.lineTo(s.x2 - endBack * Math.cos(angle), s.y2 - endBack * Math.sin(angle));
      ctx.setLineDash(dashPattern(s));
      ctx.stroke();
      ctx.setLineDash([]); // the heads stay solid
      ctx.lineWidth = Math.max(1, s.size * 0.6); // softly rounded corners on the heads
      if (s.shape !== 'line') arrowHead(ctx, s.x2, s.y2, angle, head);
      if (s.shape === 'darrow') arrowHead(ctx, s.x1, s.y1, angle + Math.PI, head);
    } else if (s.shape === 'ruler') {
      drawRuler(ctx, s, b);
    } else if (s.shape === 'protractor') {
      drawProtractor(ctx, s, b);
    } else if (s.shape === 'numline') {
      const n = Math.max(1, s.parts || 10);
      const y = s.y1, xa = Math.min(s.x1, s.x2), xb = Math.max(s.x1, s.x2);
      const pad = Math.min(30, (xb - xa) * 0.06);
      const head = 10 + s.size * 2;
      ctx.beginPath();
      ctx.moveTo(xa + head * 0.5, y);
      ctx.lineTo(xb - head * 0.5, y);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, s.size * 0.6);
      arrowHead(ctx, xb, y, 0, head);
      arrowHead(ctx, xa, y, Math.PI, head);
      const tick = 10 + s.size * 2;
      const fontPx = Math.max(16, 12 + s.size * 2.5);
      ctx.lineWidth = Math.max(2, s.size * 0.8);
      ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // Every tick gets its number, unless they'd run into each other: then every 2nd (or 5th, 10th) one.
      const space = (xb - xa - 2 * pad) / n;
      const labels = Array.from({ length: n + 1 }, (_, i) => numlineLabel(s, i));
      const widest = Math.max(...labels.map((t) => ctx.measureText(t).width));
      const every = [1, 2, 5, 10, 20].find((k) => space * k >= widest + 8) || n;
      for (let i = 0; i <= n; i++) {
        const x = xa + pad + space * i;
        ctx.beginPath();
        ctx.moveTo(x, y - tick / 2);
        ctx.lineTo(x, y + tick / 2);
        ctx.stroke();
        if (i % every === 0 || i === n) ctx.fillText(labels[i], x, y + tick / 2 + 6);
      }
    } else if (s.shape === 'axes') {
      const n = Math.max(1, s.parts || 5);
      // Four quadrants: the origin in the middle and n boxes each way. First quadrant only (s.quad): the origin at
      // the bottom left and n boxes up and across.
      const q1 = !!s.quad;
      const ox = q1 ? b.x + 6 : b.x + b.w / 2, oy = q1 ? b.y + b.h - 6 : b.y + b.h / 2;
      const ux = q1 ? (b.w - 12) / n : (b.w / 2 - 6) / n, uy = q1 ? (b.h - 12) / n : (b.h / 2 - 6) / n;
      const lo = q1 ? 0 : -n;
      // light grid
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = Math.max(1, s.size * 0.35);
      ctx.beginPath();
      for (let i = lo; i <= n; i++) {
        const x = ox + ux * i, y = oy - uy * i;
        ctx.moveTo(x, oy - uy * lo); ctx.lineTo(x, oy - uy * n);
        ctx.moveTo(ox + ux * lo, y); ctx.lineTo(ox + ux * n, y);
      }
      ctx.stroke();
      ctx.restore();
      const head = 10 + s.size * 2;
      ctx.beginPath();
      ctx.moveTo(q1 ? ox : b.x, oy); ctx.lineTo(b.x + b.w - head * 0.5, oy);
      ctx.moveTo(ox, q1 ? oy : b.y + b.h); ctx.lineTo(ox, b.y + head * 0.5);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, s.size * 0.6);
      arrowHead(ctx, b.x + b.w, oy, 0, head);
      arrowHead(ctx, ox, b.y, -Math.PI / 2, head);
      const fontPx = Math.max(14, 11 + s.size * 2);
      ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
      if (s.nums) {
        // Numbers along both axes (counting by s.step), with a small tick at each; 0 once, by the origin.
        const step = [1, 2, 5, 10].includes(s.step) ? s.step : 1;
        const num = (i) => (i < 0 ? MINUS + -i * step : String(i * step));
        const widest = ctx.measureText(num(lo || n)).width;
        const everyX = [1, 2, 5, 10].find((k) => ux * k >= widest + 8) || n;
        const everyY = [1, 2, 5, 10].find((k) => uy * k >= fontPx * 1.15) || n;
        const t = 5 + s.size;
        ctx.lineWidth = Math.max(1.5, s.size * 0.5);
        ctx.beginPath();
        for (let i = lo; i <= n; i++) {
          if (!i) continue;
          ctx.moveTo(ox + ux * i, oy - t); ctx.lineTo(ox + ux * i, oy + t);
          ctx.moveTo(ox - t, oy - uy * i); ctx.lineTo(ox + t, oy - uy * i);
        }
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = lo; i <= n; i++) if (i && i % everyX === 0) ctx.fillText(num(i), ox + ux * i, oy + t + 3);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = lo; i <= n; i++) if (i && i % everyY === 0) ctx.fillText(num(i), ox - t - 4, oy - uy * i);
        ctx.textBaseline = 'top';
        ctx.fillText('0', ox - 5, oy + 4);
        // x and y past the arrowheads, clear of the numbers
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('x', b.x + b.w + 6, oy);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('y', ox, b.y - 4);
      } else {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('x', b.x + b.w - head * 0.4, oy + head * 0.7 + 4); // under the arrowhead
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('y', ox + head * 0.7 + 6, b.y + head * 0.4); // beside the arrowhead
      }
    } else {
      // A fill (closed shapes, chosen with Select), then shaded sections (fraction shapes), then the outline on top.
      if (s.fill && FILL_SHAPES.has(s.shape)) {
        const outline = shapeLines(s)[0];
        ctx.save();
        ctx.fillStyle = s.fill;
        if (s.fillAlpha != null) ctx.globalAlpha = Math.max(0.05, Math.min(1, s.fillAlpha)); // see-through
        ctx.beginPath();
        ctx.moveTo(outline[0][0], outline[0][1]);
        for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      if ((s.shape === 'fcircle' || s.shape === 'fbar') && s.shaded?.length) {
        const n = s.parts || 4;
        ctx.save();
        ctx.globalAlpha = 0.35;
        for (const i of s.shaded) {
          if (i >= n) continue;
          ctx.beginPath();
          if (s.shape === 'fbar') ctx.rect(b.x + (b.w * i) / n, b.y, b.w / n, b.h);
          else {
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n, a1 = a0 + (2 * Math.PI) / n;
            ctx.moveTo(cx, cy);
            ctx.ellipse(cx, cy, b.w / 2, b.h / 2, 0, a0, a1);
            ctx.closePath();
          }
          ctx.fill();
        }
        ctx.restore();
      }
      if (DASH_SHAPES.has(s.shape)) ctx.setLineDash(dashPattern(s));
      for (const line of shapeLines(s)) {
        ctx.beginPath();
        ctx.moveTo(line[0][0], line[0][1]);
        for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0], line[i][1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (s.shape === 'cube' || s.shape === 'cylinder') { // the edges at the back, dashed
        ctx.save();
        ctx.lineWidth = Math.max(1.5, s.size * 0.6);
        ctx.setLineDash([Math.max(8, s.size * 2.4), Math.max(7, s.size * 2)]);
        ctx.beginPath();
        if (s.shape === 'cube') {
          const c = cubePoints(b);
          ctx.moveTo(...c.D); ctx.lineTo(...c.D2); ctx.lineTo(...c.A2);
          ctx.moveTo(...c.D2); ctx.lineTo(...c.C2);
        } else {
          const ry = Math.min(b.h * 0.16, b.w * 0.25);
          ctx.ellipse(b.x + b.w / 2, b.y + b.h - ry, b.w / 2, ry, 0, Math.PI, 2 * Math.PI);
        }
        ctx.stroke();
        ctx.restore();
      }
      if (s.marks && MARK_SHAPES.has(s.shape)) drawMarks(ctx, s);
      else if (s.marks === undefined && s.shape === 'rtriangle' && b.w > 30 && b.h > 30) { // older ones: always marked
        const m = Math.min(24, b.w / 5, b.h / 5); // the right-angle mark
        ctx.lineWidth = Math.max(1.5, s.size * 0.5);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + b.h - m);
        ctx.lineTo(b.x + m, b.y + b.h - m);
        ctx.lineTo(b.x + m, b.y + b.h);
        ctx.stroke();
      }
    }
    ctx.restore();
    if (s.tag) drawTag(ctx, s);
  }

  /** While a shape is drawn: a small tag by the end being dragged, with its angle ("37°"), or blue once it snaps
   *  ("45°", "Square", "Circle"). Only on the preview, never saved. */
  function drawTag(ctx, s) {
    const text = String(s.tag.t || '');
    if (!text) return;
    ctx.save();
    ctx.font = '700 34px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 32, h = 52;
    const b = box(s);
    let x = s.x2 + 34 + w / 2, y = s.y2 + 40;
    if (!['line', 'arrow', 'darrow', 'numline'].includes(s.shape)) { x = b.x + b.w + 18 + w / 2; y = b.y + b.h + 24; }
    ctx.fillStyle = s.tag.on ? '#2f6bff' : 'rgba(29, 36, 51, 0.78)';
    ctx.beginPath();
    roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  /** Draw an item, turned about its centre if it has been turned (item.rot, degrees clockwise). */
  function drawItem(ctx, item, dark) {
    if (!item.rot) { drawItemFlat(ctx, item, dark); return; }
    const [cx, cy] = centerOf(item);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((item.rot * Math.PI) / 180);
    ctx.translate(-cx, -cy);
    drawItemFlat(ctx, item, dark);
    ctx.restore();
  }

  function drawItemFlat(ctx, item, dark) {
    if (item.type === 'group') { for (const c of item.items) drawItem(ctx, c, dark); return; }
    if (item.type === 'stroke') drawStroke(ctx, item, dark);
    else if (item.type === 'shape') drawShape(ctx, item);
    else if (item.type === 'image') {
      const img = hooks.image(item.img);
      if (img) { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, item.x, item.y, item.w, item.h); }
    } else if (item.type === 'text') {
      if (item.note) drawNotePaper(ctx, item); // a sticky note: its paper shows even while it's typed on
      if (item.note && item.wh) { drawNoteHidden(ctx, item); return; } // a class wall's note the teacher hid
      const mine = hooks.isEditing(item);
      if (hooks.skipText(ctx, item)) return; // typed in place on the PC: the editor shows it
      if (item.fill && !item.note) { // a highlight behind the words (Select → Fill)
        const b = bounds(item), m = 8;
        ctx.save();
        ctx.fillStyle = item.fill;
        ctx.beginPath();
        roundRect(ctx, b.x - m, b.y - m, b.w + m * 2, b.h + m * 2, 12);
        ctx.fill();
        ctx.restore();
      }
      PadText.draw(ctx, item, item.note ? false : dark, mine); // a note's words are dark on its light paper
      if (item.note && Array.isArray(item.ink) && item.ink.length) drawNoteInk(ctx, item);
    }
  }

  /** A class wall note's drawing: strokes of points 0–1 across and down its paper, kept inside it. */
  function drawNoteInk(ctx, item) {
    const b = noteBox(item), side = item.w + NOTE_PAD * 2; // (across and down the square the student drew on)
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const st of item.ink) {
      const p = st && st.p;
      if (!Array.isArray(p) || p.length < 2) continue;
      ctx.strokeStyle = st.c || '#1f2328';
      ctx.lineWidth = (st.w || 3) * side / 308;
      ctx.beginPath();
      ctx.moveTo(b.x + p[0] * side, b.y + p[1] * side);
      if (p.length === 2) ctx.lineTo(b.x + p[0] * side + 0.01, b.y + p[1] * side);
      for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(b.x + p[i] * side, b.y + p[i + 1] * side);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A class wall note the teacher hid: just its paper, and a word that it's hidden. */
  function drawNoteHidden(ctx, item) {
    const b = noteBox(item);
    ctx.save();
    ctx.fillStyle = 'rgba(29, 36, 51, 0.45)';
    ctx.font = `600 ${Math.max(14, Math.round(b.w / 12))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Hidden', b.x + b.w / 2, b.y + b.h / 2);
    ctx.restore();
  }

  // ---------- sticky notes ----------
  // A sticky note is a text box (type 'text', note: true) on a square of colored paper (its fill) with a soft shadow.
  // The paper is NOTE_PAD wider than the words all round, square to start with, and taller if the words need it.
  const NOTE_COLORS = ['#fff3a3', '#ffd1e3', '#c9f2c7', '#cfe6ff', '#ffd9b0', '#e5d9ff'];
  const NOTE_PAD = 24;
  const NOTE_W = 260; // a new note's width for words (its paper: 308 square)

  function noteBox(item) {
    const t = PadText.bounds(item, hooks.isEditing(item));
    const side = item.w + NOTE_PAD * 2;
    return { x: item.x - NOTE_PAD, y: item.y - NOTE_PAD, w: side, h: Math.max(side, t.y + t.h - item.y + NOTE_PAD * 2) };
  }

  function drawNotePaper(ctx, item) {
    const b = noteBox(item);
    ctx.save();
    ctx.shadowColor = 'rgba(29, 36, 51, 0.22)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = item.fill || NOTE_COLORS[0];
    ctx.beginPath();
    roundRect(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'; // the sticky strip along the top
    ctx.beginPath();
    roundRect(ctx, b.x, b.y, b.w, Math.min(34, b.h * 0.12), [6, 6, 0, 0]);
    ctx.fill();
    ctx.restore();
  }

  function renderPage(ctx, p) {
    drawBackground(ctx, p);
    for (const item of p.items) {
      // One item that can't be drawn here (an older browser) mustn't stop the rest of the page.
      ctx.save();
      try { drawItem(ctx, item, isDark(p)); } catch (e) { hooks.onError?.(e, item); }
      ctx.restore();
    }
  }

  function centerOf(item) { const b = bounds(item); return [b.x + b.w / 2, b.y + b.h / 2]; }
  function turnPoint(x, y, cx, cy, deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    return [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
  }
  /** The page area an item covers, turned pieces and all (groups: all their pieces). */
  function extentOf(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of list) {
      const b = bounds(it);
      const pts = it.rot ? [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => turnPoint(x, y, b.x + b.w / 2, b.y + b.h / 2, it.rot)) : [[b.x, b.y], [b.x + b.w, b.y + b.h]];
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return list.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
  }

  function bounds(item) {
    if (item.type === 'group') return extentOf(item.items);
    if (item.type === 'image') return { x: item.x, y: item.y, w: item.w, h: item.h };
    if (item.type === 'text') return item.note ? noteBox(item) : PadText.bounds(item, hooks.isEditing(item));
    if (item.type === 'shape') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const line of shapeLines(item)) for (const [x, y] of line) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const pad = item.size / 2 + (['arrow', 'darrow', 'numline', 'axes'].includes(item.shape) ? 14 + item.size * 3 : 0);
      const labels = item.shape === 'numline' ? 40 + item.size * 4 : 0; // the numbers under a number line
      const nums = item.shape === 'axes' && item.nums ? 28 + item.size * 4 : 0; // numbers, x and y around axes
      return { x: x0 - pad - nums, y: y0 - pad - nums, w: x1 - x0 + pad * 2 + nums * 2, h: y1 - y0 + pad * 2 + labels + nums * 2 };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of item.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = item.size;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  const FILL_SHAPES = new Set(['rect', 'rrect', 'ellipse', 'triangle', 'rtriangle', 'pentagon', 'hexagon', 'polygon', 'fcircle', 'fbar', 'star', 'cube', 'cylinder', 'bubble']);

  // ---------- hit-testing (the eraser, Select) ----------
  const toLocal = (item, x, y) => (item.rot ? turnPoint(x, y, ...centerOf(item), -item.rot) : [x, y]);

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** Is (x, y) inside a closed shape's outline (even-odd)? */
  function insideOutline(s, x, y) {
    const pts = shapeLines(s)[0];
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Is (x, y) within `r` of the item's ink? */
  function hits(item, x, y, r) {
    if (item.type === 'group') return item.items.some((c) => hits(c, x, y, r));
    if (item.rot) [x, y] = toLocal(item, x, y);
    if (item.type === 'image') return x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h;
    if (item.type === 'text') {
      const b = bounds(item);
      return x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
    }
    if (item.type === 'shape') {
      const tol = r + item.size / 2;
      if (sectionAt(item, x, y) >= 0) return true; // inside a fraction circle or bar
      if (item.fill && FILL_SHAPES.has(item.shape) && insideOutline(item, x, y)) return true; // a filled shape is solid
      if (MEASURE_SHAPES.has(item.shape) && insideOutline(item, x, y)) return true; // so is a ruler or protractor
      for (const line of shapeLines(item))
        for (let i = 1; i < line.length; i++)
          if (distToSegment(x, y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]) <= tol) return true;
      return false;
    }
    const tol = r + (item.tool === 'highlighter' ? item.size / 2 : strokeWidth(item.size, 1) / 2);
    const pts = item.pts;
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= tol;
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= tol) return true;
    }
    return false;
  }

  /**
   * Where a bar goes beside a selection (both in screen pixels): above it, else below, else to its right or left;
   * always whole on the screen. Near an edge it slides along the edge rather than follow the selection off it, and on
   * a narrow screen it wraps onto two rows. If no side has room (a selection as big as the screen), it goes where it
   * covers the least of the selection.
   */
  function barSpot(bar, sel, area) {
    bar.style.maxWidth = `${Math.max(120, area.r - area.l)}px`;
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const cx = (x) => Math.max(area.l, Math.min(area.r - bw, x)), cy = (y) => Math.max(area.t, Math.min(area.b - bh, y));
    const midX = cx((sel.l + sel.r) / 2 - bw / 2), midY = cy((sel.t + sel.b) / 2 - bh / 2);
    const spots = [
      { side: 'above', x: midX, y: sel.t - bh - 12 },
      { side: 'below', x: midX, y: sel.b + 14 },
      { side: 'right', x: sel.r + 14, y: midY },
      { side: 'left', x: sel.l - bw - 14, y: midY },
    ];
    const fits = (s) => s.x >= area.l && s.x + bw <= area.r && s.y >= area.t && s.y + bh <= area.b;
    const free = spots.find(fits);
    if (free) return free;
    const cover = (s) => Math.max(0, Math.min(s.x + bw, sel.r) - Math.max(s.x, sel.l)) * Math.max(0, Math.min(s.y + bh, sel.b) - Math.max(s.y, sel.t));
    return spots.map((s) => ({ ...s, x: cx(s.x), y: cy(s.y) })).sort((a, b) => cover(a) - cover(b))[0];
  }

  return { configure, barSpot, DASH_SHAPES, MARK_SHAPES, MEASURE_SHAPES, RULER_T, numlineRange, W, H, ph, SIZES, NOTE_COLORS, NOTE_PAD, NOTE_W, toLocal, distToSegment, insideOutline, hits, isDark, drawBackground, strokeWidth, smoothPoints, MEDIA, drawStroke, PARTS_SHAPES, DEFAULT_PARTS, MIN_SIDES, MAX_SIDES, SQUARE_SHAPES, box, polygonPoints, shapeLines, sectionAt, drawShape, drawItem, renderPage, bounds, centerOf, turnPoint, extentOf, FILL_SHAPES };
})();

// The laser pointer's looks, drawn over a page: a dot with a fading trail, a glow trail, a spotlight, fading ink, a ring,
// an arrow, ripples or a magnifier. Used on students' screens (student-host.js) and on the iPad (pad.js), so they show
// the laser as the PC does. opts.where(x, y, on) turns a point into { x, y, k, area } on this screen (k: screen pixels
// per board pixel; area: the board's rectangle); opts.clip keeps it inside that area; opts.skip(el) leaves a canvas or
// picture out of the magnifier.
window.PadLaser = (() => {
  'use strict';
  const W = 1920;

  function create(opts) {
    const TRAIL_MS = 900, STREAK_MS = 50, SABER_MS = 380, DOT_MS = 1500, INK_HOLD = 1800, INK_FADE = 700, RIPPLE_MS = 1100, RIPPLE_EVERY = 1000;
    const STYLES = ['dot', 'saber', 'spotlight', 'ink', 'ring', 'arrow', 'ripple', 'magnifier'];
    let cv = null, g = null, off = null, frame = 0, on = 'page', look = { style: 'dot', color: '#ff2828' };
    let trail = [], recent = [], dot = null, dotAt = 0, drawing = false;
    let ink = [], ripples = [], lastRipple = 0; // fading ink's lines, and ripples

    function set(m) {
      if (!cv) {
        if (!document.body) return;
        cv = document.createElement('canvas');
        cv.className = opts.className;
        document.body.appendChild(cv);
        g = cv.getContext('2d');
        off = document.createElement('canvas');
      }
      const now = performance.now();
      const style = STYLES.includes(m.style) ? m.style : 'dot';
      const color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : '#ff2828';
      const where = m.on === 'shown' ? 'shown' : 'page';
      if (style !== look.style || color !== look.color || where !== on) { trail = []; recent = []; ink = []; ripples = []; drawing = false; }
      look = { style, color };
      on = where;
      const pts = (Array.isArray(m.pts) ? m.pts : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (!pts.length) { dot = null; recent = []; drawing = false; }
      let joined = drawing;
      pts.forEach(([x, y], i) => {
        const t = now - (pts.length - 1 - i) * (40 / pts.length); // spread over the 40 ms they were gathered in
        if (m.down) {
          if (style === 'ink') {
            if (!joined || !ink.length) ink.push({ pts: [], end: t });
            ink[ink.length - 1].pts.push({ x, y });
            ink[ink.length - 1].end = t;
          }
          if (style === 'ripple' && (!joined || t - lastRipple >= RIPPLE_EVERY)) { ripples.push({ x, y, t }); lastRipple = t; }
          trail.push({ x, y, t, joined });
          joined = true;
        }
        recent.push({ x, y, t });
        dot = { x, y };
        dotAt = now;
      });
      drawing = !!m.down && pts.length > 0;
      if (!frame) frame = requestAnimationFrame(paint);
    }

    const where = (x, y) => opts.where(x, y, on);
    const rgba = (alpha) => {
      const n = parseInt(look.color.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
    };

    function paint() {
      frame = 0;
      const now = performance.now();
      trail = trail.filter((p) => now - p.t < TRAIL_MS);
      recent = recent.filter((p) => now - p.t < SABER_MS);
      if (dot && !drawing && now - dotAt > DOT_MS) dot = null;
      ink = ink.filter((l, i) => (drawing && i === ink.length - 1) || now - l.end < INK_HOLD + INK_FADE);
      ripples = ripples.filter((r) => now - r.t < RIPPLE_MS + 400);
      const dpr = devicePixelRatio || 1, w = innerWidth, h = innerHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const head = dot && where(dot.x, dot.y);
      const probe = head || where(0, 0);
      if (probe) {
        // Sizes as on the PC's screen, for a board this wide here.
        const s = Math.max(0.4, Math.min(1.2, (probe.k * W) / 1600));
        g.save();
        if (opts.clip) { const a = probe.area; g.beginPath(); g.rect(a.left, a.top, a.width, a.height); g.clip(); } // only over the board or screen
        try { draw(now, head, s, probe); } catch (e) { console.warn('Laser: could not draw', e); }
        g.restore();
      }
      if (dot || trail.length || recent.length || ink.length || ripples.length) frame = requestAnimationFrame(paint);
    }

    function draw(now, head, s, probe) {
      if (look.style === 'spotlight') {
        if (!head) return;
        // Everything dims except a soft-edged circle round the laser.
        const r = Math.max(36, probe.area.height * 0.11);
        const grad = g.createRadialGradient(head.x, head.y, r, head.x, head.y, r * 1.25);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.65)');
        g.fillStyle = grad;
        g.fillRect(0, 0, innerWidth, innerHeight);
        return;
      }
      if (look.style === 'ink') {
        // Glowing lines that stay a moment after the teacher lifts, then fade away together.
        ink.forEach((l, i) => {
          const life = drawing && i === ink.length - 1 ? 1 : Math.max(0, Math.min(1, 1 - (now - l.end - INK_HOLD) / INK_FADE));
          const pts = l.pts.map((p) => { const at = where(p.x, p.y); return at && { x: at.x, y: at.y, life }; }).filter(Boolean);
          beam(pts, (v) => 0.11 * v, () => 26 * s, look.color);
          beam(pts, (v) => 0.24 * v, () => 14 * s, look.color);
          beam(pts, (v) => 0.94 * v, () => 6 * s, look.color);
          beam(pts, (v) => 0.67 * v, () => 1.6 * s, '#ffffff');
        });
        if (head) glow(head, s * 0.55);
        return;
      }
      if (look.style === 'ring') {
        if (!head) return;
        // Breathing gently, with a faint echo drifting outward once a breath.
        const phase = (now % 1400) / 1400;
        const r = (26 + 2.5 * Math.sin(phase * 2 * Math.PI)) * s;
        ring(head, r + 22 * phase * s, 2.5 * s, rgba(0.59 * (1 - phase) * (1 - phase)));
        ring(head, r, 22 * s, rgba(0.09));
        ring(head, r, 11 * s, rgba(0.22));
        ring(head, r, 4 * s, rgba(0.96));
        ring(head, r, 1.3 * s, 'rgba(255,255,255,0.75)');
        return;
      }
      if (look.style === 'arrow') {
        if (head) arrow(head, s * 1.15); // a plain, bright arrow, tip on the spot: no tail
        return;
      }
      if (look.style === 'ripple') {
        for (const r0 of ripples) {
          const at = where(r0.x, r0.y);
          if (!at) continue;
          for (let k = 0; k < 3; k++) {
            const age = (now - r0.t - k * 170) / RIPPLE_MS;
            if (age <= 0 || age >= 1) continue;
            const r = (10 + 85 * (1 - (1 - age) * (1 - age))) * s;
            const fade = (1 - age) * (k === 0 ? 1 : 0.75); // the first ring brightest
            ring(at, r, (16 * (1 - age) + 5) * s, rgba(0.1 * fade));
            ring(at, r, (8 * (1 - age) + 3) * s, rgba(0.24 * fade));
            ring(at, r, (3 * (1 - age) + 1.2) * s, rgba(0.94 * fade));
            ring(at, r, 1.1 * s, `rgba(255,255,255,${0.59 * fade * (1 - age)})`);
          }
        }
        if (head) glow(head, s * 0.75);
        return;
      }
      if (look.style === 'magnifier') {
        if (head) magnifier(head, probe, s);
        return;
      }
      if (look.style === 'saber') {
        const pts = recent.map((p) => { const at = where(p.x, p.y); return at && { x: at.x, y: at.y, life: 1 - (now - p.t) / SABER_MS }; }).filter(Boolean);
        beam(pts, (l) => 0.22 * l, (l) => (26 * l + 6) * s, look.color);
        beam(pts, (l) => 0.67 * l, (l) => (11 * l + 3) * s, look.color);
        beam(pts, (l) => l, (l) => (4.5 * l + 1.5) * s, '#ffffff');
        if (head) glow(head, s * 1.1);
        return;
      }
      // The dot, like a real laser: moved quickly, it smears into a short streak that vanishes when it stops.
      const streak = recent.filter((p) => now - p.t < STREAK_MS).map((p) => { const at = where(p.x, p.y); return at && { x: at.x, y: at.y, life: 1 - (now - p.t) / STREAK_MS }; }).filter(Boolean);
      beam(streak, (l) => 0.2 * l, (l) => (18 * l + 4) * s, look.color);
      beam(streak, (l) => 0.8 * l, (l) => (8 * l + 2) * s, look.color);
      if (head) glow(head, s);
    }

    /** A ribbon through the points, tapering away at the old end, in one color at the head's brightness (no beads). */
    function beam(pts, alpha, width, color) {
      pts = pts.filter((p) => p.life > 0.01);
      if (!pts.length) return;
      const dpr = devicePixelRatio || 1;
      if (off.width !== cv.width || off.height !== cv.height) { off.width = cv.width; off.height = cv.height; }
      const o = off.getContext('2d');
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.clearRect(0, 0, innerWidth, innerHeight);
      o.strokeStyle = o.fillStyle = color;
      o.lineCap = o.lineJoin = 'round';
      const wide = (l) => width(Math.max(0, Math.min(1, l))) * Math.max(0, Math.min(1, l * 3));
      if (pts.length === 1) { o.beginPath(); o.arc(pts[0].x, pts[0].y, wide(pts[0].life) / 2, 0, Math.PI * 2); o.fill(); }
      for (let i = 1; i < pts.length; i++) {
        o.lineWidth = wide(pts[i].life);
        o.beginPath();
        o.moveTo(pts[i - 1].x, pts[i - 1].y);
        o.lineTo(pts[i].x, pts[i].y);
        o.stroke();
      }
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = Math.max(0, Math.min(1, alpha(pts[pts.length - 1].life)));
      g.drawImage(off, 0, 0);
      g.restore();
    }

    function ring(p, r, width, color) {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath(); g.arc(p.x, p.y, Math.max(0.5, r), 0, Math.PI * 2); g.stroke();
    }

    /** A plain, bright arrow, its tip on p, pointing up and to the left like a mouse pointer, with a white edge and a soft shadow. */
    function arrow(p, k) {
      const shape = [[0, 0], [-34, -23], [-34, -9], [-70, -9], [-70, 9], [-34, 9], [-34, 23]];
      const path = () => { g.beginPath(); shape.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
      g.save();
      g.translate(p.x, p.y);
      g.rotate(-3 * Math.PI / 4);
      g.scale(k, k);
      g.lineJoin = 'round';
      g.save();
      g.translate(-3, -5);
      path();
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 6; g.stroke();
      g.restore();
      path();
      g.strokeStyle = 'rgba(255,255,255,0.96)'; g.lineWidth = 5; g.stroke();
      g.fillStyle = rgba(1); g.fill();
      g.restore();
    }

    /** A round lens showing the board under it at twice the size: the board's own pictures, copied in. */
    function magnifier(p, probe, s) {
      const r = Math.max(60, probe.area.height * 0.13);
      g.save();
      g.beginPath(); g.arc(p.x + 2, p.y + 5, r, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fill();
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = '#ffffff';
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      // Every picture layer of the board under the laser, in page order, scaled up 2x around the point.
      g.translate(p.x, p.y); g.scale(2, 2); g.translate(-p.x, -p.y);
      for (const el of document.querySelectorAll('canvas, img')) {
        if (el === cv || el === off || (opts.skip && opts.skip(el))) continue;
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height || p.x < b.left || p.x > b.right || p.y < b.top || p.y > b.bottom) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        try { g.drawImage(el, b.left, b.top, b.width, b.height); } catch { /* not ready yet */ }
      }
      // A sheen of glass across the top left.
      g.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0);
      const sheen = g.createLinearGradient(p.x - r, p.y - r, p.x, p.y);
      sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = sheen;
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      g.restore();
      ring(p, r, 20 * s, rgba(0.09));
      ring(p, r, 10 * s, rgba(0.24));
      ring(p, r, 4.5 * s, rgba(0.96));
      ring(p, r - 3 * s, 1.3 * s, 'rgba(255,255,255,0.67)');
    }

    /** A soft glowing dot: a faint halo, the colored centre and a white-hot core. */
    function glow(p, s) {
      const r = 26 * s;
      const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      halo.addColorStop(0, rgba(0.59));
      halo.addColorStop(1, rgba(0));
      g.fillStyle = halo;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = rgba(0.94);
      g.beginPath(); g.arc(p.x, p.y, 8.5 * s, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff8f0';
      g.beginPath(); g.arc(p.x, p.y, 3.8 * s, 0, Math.PI * 2); g.fill();
    }

    return { set };
  }

  return { create };
})();
