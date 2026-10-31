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
        const t = Math.min(1, along / taperLen, (total - along) / (taperLen * 0.8));
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
      ctx.globalCompositeOperation = dark ? 'screen' : 'multiply';
      ctx.globalAlpha = dark ? 0.6 : 0.8;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hp[0][0], hp[0][1]);
      if (hp.length === 1) ctx.lineTo(hp[0][0] + 0.1, hp[0][1]);
      for (let i = 1; i < hp.length - 1; i++) {
        ctx.quadraticCurveTo(hp[i][0], hp[i][1], (hp[i][0] + hp[i + 1][0]) / 2, (hp[i][1] + hp[i + 1][1]) / 2);
      }
      if (hp.length > 1) ctx.lineTo(hp[hp.length - 1][0], hp[hp.length - 1][1]);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.restore();
    drawInk(ctx, s);
  }

  // ---------- shapes ----------
  // Every shape is a box (x1,y1)-(x2,y2) plus a kind; fraction shapes, number lines and axes also have `parts`, and
  // fraction shapes a list of `shaded` sections (tap a section with the Shapes tool to shade it).

  const PARTS_SHAPES = new Set(['fcircle', 'fbar', 'numline', 'axes', 'polygon']); // polygon: its number of sides
  const DEFAULT_PARTS = { fcircle: 4, fbar: 4, numline: 10, axes: 5, polygon: 8 };
  const MIN_SIDES = 3;
  const MAX_SIDES = 12; // beyond this a polygon looks like a circle
  const SQUARE_SHAPES = new Set(['fcircle', 'pentagon', 'hexagon', 'polygon']); // always drawn regular

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
      case 'axes': return [[[b.x, cy], [b.x + b.w, cy]], [[cx, b.y], [cx, b.y + b.h]]];
    }
    return [rect];
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

  const fracLabel = (i, n) => {
    if (i === 0) return '0';
    if (i === n) return '1';
    let a = i, b = n;
    for (let g = a; g > 1; g--) if (a % g === 0 && b % g === 0) { a /= g; b /= g; break; }
    return `${a}/${b}`;
  };

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
      ctx.stroke();
      ctx.lineWidth = Math.max(1, s.size * 0.6); // softly rounded corners on the heads
      if (s.shape !== 'line') arrowHead(ctx, s.x2, s.y2, angle, head);
      if (s.shape === 'darrow') arrowHead(ctx, s.x1, s.y1, angle + Math.PI, head);
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
      for (let i = 0; i <= n; i++) {
        const x = xa + pad + ((xb - xa - 2 * pad) * i) / n;
        ctx.beginPath();
        ctx.moveTo(x, y - tick / 2);
        ctx.lineTo(x, y + tick / 2);
        ctx.stroke();
        ctx.fillText(s.frac ? fracLabel(i, n) : String(i), x, y + tick / 2 + 6);
      }
    } else if (s.shape === 'axes') {
      const n = Math.max(1, s.parts || 5);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      // light grid
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = Math.max(1, s.size * 0.35);
      ctx.beginPath();
      for (let i = -n; i <= n; i++) {
        const x = cx + (b.w / 2 - 6) * (i / n), y = cy + (b.h / 2 - 6) * (i / n);
        ctx.moveTo(x, b.y + 6); ctx.lineTo(x, b.y + b.h - 6);
        ctx.moveTo(b.x + 6, y); ctx.lineTo(b.x + b.w - 6, y);
      }
      ctx.stroke();
      ctx.restore();
      const head = 10 + s.size * 2;
      ctx.beginPath();
      ctx.moveTo(b.x, cy); ctx.lineTo(b.x + b.w - head * 0.5, cy);
      ctx.moveTo(cx, b.y + b.h); ctx.lineTo(cx, b.y + head * 0.5);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, s.size * 0.6);
      arrowHead(ctx, b.x + b.w, cy, 0, head);
      arrowHead(ctx, cx, b.y, -Math.PI / 2, head);
      const fontPx = Math.max(14, 11 + s.size * 2);
      ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('x', b.x + b.w - head * 0.4, cy + head * 0.7 + 4); // under the arrowhead
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('y', cx + head * 0.7 + 6, b.y + head * 0.4); // beside the arrowhead
    } else {
      // A fill (closed shapes, chosen with Select), then shaded sections (fraction shapes), then the outline on top.
      if (s.fill && FILL_SHAPES.has(s.shape)) {
        const outline = shapeLines(s)[0];
        ctx.save();
        ctx.fillStyle = s.fill;
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
      for (const line of shapeLines(s)) {
        ctx.beginPath();
        ctx.moveTo(line[0][0], line[0][1]);
        for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0], line[i][1]);
        ctx.stroke();
      }
      if (s.shape === 'rtriangle' && b.w > 30 && b.h > 30) {
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
    }
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
      return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 + labels };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of item.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = item.size;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  const FILL_SHAPES = new Set(['rect', 'ellipse', 'triangle', 'rtriangle', 'pentagon', 'hexagon', 'polygon', 'fcircle', 'fbar']);

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

  return { configure, W, H, ph, SIZES, NOTE_COLORS, NOTE_PAD, NOTE_W, toLocal, distToSegment, insideOutline, hits, isDark, drawBackground, strokeWidth, smoothPoints, MEDIA, drawStroke, PARTS_SHAPES, DEFAULT_PARTS, MIN_SIDES, MAX_SIDES, SQUARE_SHAPES, box, polygonPoints, shapeLines, sectionAt, drawShape, drawItem, renderPage, bounds, centerOf, turnPoint, extentOf, FILL_SHAPES };
})();
