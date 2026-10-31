// PadLink text boxes: words with bold / italic / underline, colors, fonts, sizes and lists, plus math that can sit
// inside a line ("The answer is ¾"): fractions, powers, square roots and symbols such as ÷ × ≤ ≥.
// Shared by the whiteboard (board.js: draws text boxes on the page, and edits them on the PC) and the pad (pad.js:
// edits them on the iPad or iPhone, with a math keyboard). Exposes window.PadText.
//
// A text box: { type: 'text', id, x, y, w, paras }   (page units; it is as tall as its text)
//   paras: [{ l?: 'b' | 'n', d?: number, a?: 'c' | 'r', r: [run] }]
//             (l: bulleted or numbered; d: Tab indentation; a: center or right, with left as the default)
//   run:   { s, b?, i?, u?, c, h?, f, z, href? }     (words: bold, italic, underline, color, highlight, font, size, and
//                                                     a web link: the teacher's only, http(s) only)
//        | { m: nodes, c, h?, z }                     (math)
//   nodes: [string | { fr: [nodes, nodes] } | { sp: nodes } | { rt: nodes }]   (fraction, power, square root)
(() => {
  'use strict';

  const FONTS = {
    clean: { name: 'Clean', css: "'Segoe UI', ui-rounded, -apple-system, Arial, sans-serif" },
    school: { name: 'School print', css: "'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', cursive" },
    serif: { name: 'Serif', css: "Georgia, 'Times New Roman', serif" },
    display: { name: 'Bold display', css: "'Arial Black', 'Helvetica Neue', Impact, sans-serif" },
    mono: { name: 'Mono', css: "Consolas, 'SF Mono', Menlo, monospace" },
  };
  const MATH_FONT = "'Cambria Math', 'STIX Two Math', 'Times New Roman', serif";
  const COLORS = ['#1f2328', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#7048e8'];
  const HIGHLIGHTS = ['#fff3a3', '#c9f3d5', '#cfe3ff', '#ffd6e7', '#ffe0b8', '#e6d9ff'];
  const INK = '#1f2328';
  const DEFAULT_Z = 48; // readable from the back of a classroom on a 1920-wide page
  const MIN_Z = 8;
  const MAX_Z = 160;
  const MAX_INDENT = 8;
  const INDENT_EM = 1.4;
  const ZW = '​'; // a zero-width space: somewhere for the caret to sit in an empty slot
  const BINARY = '+−×÷=<>≤≥≠±·';
  const fontKeys = Object.keys(FONTS);

  // ---------- cleaning (whatever arrives from the pad or a saved file) ----------

  const cleanColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : INK);
  const cleanHighlight = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
  const cleanSize = (z) => (Number.isFinite(z) ? Math.max(MIN_Z, Math.min(MAX_Z, Math.round(z))) : DEFAULT_Z);
  /** A web address a link may go to: http or https only (never javascript:, data: and the like), and not too long. */
  const cleanHref = (u) => {
    if (typeof u !== 'string' || u.length > 2000) return null;
    try { const url = new URL(u.trim()); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; }
  };

  function cleanNodes(nodes, depth) {
    if (!Array.isArray(nodes) || depth > 6) return [];
    const out = [];
    for (const n of nodes.slice(0, 400)) {
      if (typeof n === 'string') { if (n) out.push(n.slice(0, 500)); }
      else if (n && Array.isArray(n.fr)) out.push({ fr: [cleanNodes(n.fr[0], depth + 1), cleanNodes(n.fr[1], depth + 1)] });
      else if (n && Array.isArray(n.sp)) out.push({ sp: cleanNodes(n.sp, depth + 1) });
      else if (n && Array.isArray(n.rt)) out.push({ rt: cleanNodes(n.rt, depth + 1) });
    }
    return out;
  }

  function clean(paras) {
    const list = Array.isArray(paras) ? paras.slice(0, 300) : [];
    const out = list.map((p) => {
      const runs = (Array.isArray(p?.r) ? p.r : []).slice(0, 500).map((run) => {
        if (run && Array.isArray(run.m)) {
          const o = { m: cleanNodes(run.m, 0), c: cleanColor(run.c), z: cleanSize(run.z) };
          const h = cleanHighlight(run.h);
          if (h) o.h = h;
          return o;
        }
        const o = { s: typeof run?.s === 'string' ? run.s.slice(0, 5000) : '', c: cleanColor(run?.c), f: FONTS[run?.f] ? run.f : 'clean', z: cleanSize(run?.z) };
        if (run?.b) o.b = 1;
        if (run?.i) o.i = 1;
        if (run?.u) o.u = 1;
        const h = cleanHighlight(run?.h);
        if (h) o.h = h;
        const href = cleanHref(run?.href);
        if (href) o.href = href;
        return o;
      });
      const q = { r: runs };
      if (p?.l === 'b' || p?.l === 'n') q.l = p.l;
      if (p?.a === 'c' || p?.a === 'r') q.a = p.a;
      const d = Number.isFinite(p?.d) ? Math.max(0, Math.min(MAX_INDENT, Math.floor(p.d))) : 0;
      if (d) q.d = d;
      return q;
    });
    return out.length ? out : [{ r: [] }];
  }

  const nodesHaveContent = (nodes) => nodes.some((n) => (typeof n === 'string' ? n.replace(/​/g, '').trim() !== '' : true));
  /** Nothing typed: no words and no math. */
  const isEmpty = (paras) => !paras.some((p) => p.r.some((r) => (r.m ? nodesHaveContent(r.m) : r.s.trim() !== '')));

  // ---------- drawing on a canvas ----------

  let measureCtx = null;
  const mctx = () => measureCtx || (measureCtx = document.createElement('canvas').getContext('2d'));
  const fontOf = (run) => `${run.i ? 'italic ' : ''}${run.b ? '700' : '400'} ${run.z}px ${FONTS[run.f]?.css || FONTS.clean.css}`;
  const ink = (c, dark) => (dark && c === INK ? '#ffffff' : c);

  // A math box: { w, a, d, draw(ctx, x, baseline) }  (a / d: height above / below the baseline)
  function mathRow(nodes, z, editing) {
    const parts = [];
    for (const n of nodes) {
      if (typeof n === 'string') { for (const ch of n.replace(/​/g, '')) parts.push(charBox(ch, z)); }
      else if (n.fr) parts.push(fracBox(n.fr, z, editing));
      else if (n.sp) parts.push(supBox(n.sp, z, editing));
      else if (n.rt) parts.push(rootBox(n.rt, z, editing));
    }
    if (!parts.length) return slotBox(z, editing);
    let w = 0, a = 0, d = 0;
    for (const p of parts) { w += p.w; a = Math.max(a, p.a); d = Math.max(d, p.d); }
    return { w, a, d, draw(ctx, x, y) { for (const p of parts) { p.draw(ctx, x, y); x += p.w; } } };
  }

  /** An empty numerator, denominator, power or root: a dotted box while editing, a gap otherwise. */
  function slotBox(z, editing) {
    return {
      w: z * 0.55, a: z * 0.7, d: z * 0.08,
      draw(ctx, x, y) {
        if (!editing) return;
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = Math.max(1, z * 0.04);
        ctx.setLineDash([z * 0.08, z * 0.06]);
        ctx.strokeRect(x + z * 0.06, y - z * 0.66, z * 0.43, z * 0.7);
        ctx.restore();
      },
    };
  }

  function charBox(ch, z) {
    const shown = ch === '-' ? '−' : ch === '*' ? '×' : ch;
    const italic = /[A-Za-z]/.test(shown);
    const font = `${italic ? 'italic ' : ''}400 ${z}px ${MATH_FONT}`;
    const c = mctx();
    c.font = font;
    const gap = BINARY.includes(shown) ? z * 0.22 : 0;
    const w = c.measureText(shown).width + gap * 2 + (italic ? z * 0.04 : 0);
    return { w, a: z * 0.72, d: z * 0.22, draw(ctx, x, y) { ctx.font = font; ctx.fillText(shown, x + gap, y); } };
  }

  function fracBox([top, bottom], z, editing) {
    const s = Math.max(10, z * 0.78);
    const n = mathRow(top, s, editing), dn = mathRow(bottom, s, editing);
    const axis = z * 0.28, gap = z * 0.1, bar = Math.max(1.5, z * 0.06);
    const w = Math.max(n.w, dn.w) + z * 0.3;
    return {
      w, a: axis + gap + n.d + n.a, d: gap + dn.a + dn.d - axis,
      draw(ctx, x, y) {
        n.draw(ctx, x + (w - n.w) / 2, y - axis - gap - n.d);
        ctx.fillRect(x + z * 0.08, y - axis - bar / 2, w - z * 0.16, bar);
        dn.draw(ctx, x + (w - dn.w) / 2, y - axis + gap + dn.a);
      },
    };
  }

  function supBox(nodes, z, editing) {
    const s = mathRow(nodes, Math.max(9, z * 0.62), editing);
    const raise = z * 0.42;
    return { w: s.w + z * 0.06, a: raise + s.a, d: Math.max(0, s.d - raise), draw(ctx, x, y) { s.draw(ctx, x + z * 0.03, y - raise); } };
  }

  function rootBox(nodes, z, editing) {
    const c = mathRow(nodes, z, editing);
    const sym = z * 0.6, pad = z * 0.12, line = Math.max(1.5, z * 0.06);
    return {
      w: sym + c.w + z * 0.12, a: c.a + pad + line, d: c.d + z * 0.04,
      draw(ctx, x, y) {
        const top = y - c.a - pad;
        ctx.save();
        ctx.lineWidth = line;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + z * 0.04, y - z * 0.3);
        ctx.lineTo(x + z * 0.17, y - z * 0.38);
        ctx.lineTo(x + z * 0.33, y + c.d);
        ctx.lineTo(x + sym - z * 0.04, top);
        ctx.lineTo(x + sym + c.w + z * 0.08, top);
        ctx.stroke();
        ctx.restore();
        c.draw(ctx, x + sym, y);
      },
    };
  }

  const layouts = new WeakMap(); // item -> { key, lines, h }

  /** Where every word and math piece goes: wrapped to the box's width, lists indented. */
  function layout(item, editing) {
    const key = JSON.stringify([item.w, item.paras, !!editing]);
    const known = layouts.get(item);
    if (known && known.key === key) return known;
    const c = mctx();
    const lines = [];
    let y = 0;
    let number = 0;
    let prevZ = DEFAULT_Z; // an empty line is as tall as the line above it
    for (const p of item.paras) {
      const first = p.r[0] || { z: prevZ, c: INK, f: 'clean' };
      const z0 = first.z;
      prevZ = z0;
      const indent = ((p.d || 0) + (p.l ? 1 : 0)) * z0 * INDENT_EM;
      const maxW = Math.max(40, item.w - indent);
      number = p.l === 'n' ? number + 1 : 0;
      const atoms = [];
      for (const run of p.r) {
        if (run.m) {
          const box = mathRow(run.m, run.z, editing);
          atoms.push({ run, box, w: box.w + run.z * 0.08, a: Math.max(box.a, run.z * 0.8), d: Math.max(box.d, run.z * 0.25) });
          continue;
        }
        c.font = fontOf(run);
        for (const piece of run.s.split(/(\s+)/)) {
          if (!piece) continue;
          const space = /^\s+$/.test(piece);
          const w = c.measureText(piece).width;
          if (space || w <= maxW) { atoms.push({ run, s: piece, space, w, a: run.z * 0.8, d: run.z * 0.25 }); continue; }
          // A word wider than the box (a web address, a long name): break it where it reaches the edge.
          let part = '';
          for (const ch of piece) {
            if (part && c.measureText(part + ch).width > maxW) {
              atoms.push({ run, s: part, space: false, w: c.measureText(part).width, a: run.z * 0.8, d: run.z * 0.25, piece: true });
              part = '';
            }
            part += ch;
          }
          if (part) atoms.push({ run, s: part, space: false, w: c.measureText(part).width, a: run.z * 0.8, d: run.z * 0.25 });
        }
      }
      const rows = [{ atoms: [], w: 0 }];
      for (const at of atoms) {
        let row = rows[rows.length - 1];
        if ((row.w + at.w > maxW || row.full) && row.atoms.length && !at.space) { row = { atoms: [], w: 0 }; rows.push(row); }
        if (at.space && !row.atoms.length && rows.length > 1) continue; // a wrapped line doesn't start with a space
        row.atoms.push(at);
        row.w += at.w;
        if (at.piece) row.full = true; // the rest of a broken word goes on the next line
      }
      rows.forEach((row, k) => {
        const a = Math.max(z0 * 0.8, ...row.atoms.map((t) => t.a));
        const d = Math.max(z0 * 0.25, ...row.atoms.map((t) => t.d));
        const lead = (a + d) * 0.18;
        const alignedX = indent + (p.a === 'c' ? (maxW - row.w) / 2 : p.a === 'r' ? maxW - row.w : 0);
        lines.push({
          atoms: row.atoms, x: alignedX, base: y + lead / 2 + a,
          marker: k === 0 && p.l ? (p.l === 'b' ? '•' : `${number}.`) : null, mz: z0, mc: first.c, mf: first.f || 'clean',
        });
        y += a + d + lead;
      });
    }
    const lay = { key, lines, h: Math.max(y, DEFAULT_Z * 1.2) };
    layouts.set(item, lay);
    return lay;
  }

  /** Draw a text box on a page (dark: a dark page, where the default ink is drawn white). */
  function draw(ctx, item, dark, editing) {
    const lay = layout(item, editing);
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    for (const ln of lay.lines) {
      let x = item.x + ln.x;
      const y = item.y + ln.base;
      if (ln.marker) {
        ctx.font = `400 ${ln.mz}px ${FONTS[ln.mf]?.css || FONTS.clean.css}`;
        ctx.fillStyle = ink(ln.mc, dark);
        ctx.textAlign = 'right';
        ctx.fillText(ln.marker, x - ln.mz * 0.35, y);
        ctx.textAlign = 'left';
      }
      for (const at of ln.atoms) {
        const color = ink(at.run.c, dark);
        if (at.run.h) {
          ctx.fillStyle = at.run.h;
          ctx.fillRect(x, y - at.a, at.w, at.a + at.d);
        }
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        if (at.box) at.box.draw(ctx, x + at.run.z * 0.04, y);
        else {
          ctx.font = fontOf(at.run);
          if (!at.space) ctx.fillText(at.s, x, y);
          if (at.run.u || at.run.href) ctx.fillRect(x, y + at.run.z * 0.12, at.w, Math.max(1, at.run.z * 0.06));
        }
        x += at.w;
      }
    }
    ctx.restore();
  }

  const bounds = (item, editing) => ({ x: item.x, y: item.y, w: item.w, h: layout(item, editing).h });

  /** The link under (x, y) on a text box (page units, the box unturned), or null. A little slack around the words. */
  function linkAt(item, x, y, slack = 4) {
    if (item.type !== 'text' || !item.paras?.some((p) => p.r.some((r) => r.href))) return null;
    for (const ln of layout(item, false).lines) {
      let ax = item.x + ln.x;
      const base = item.y + ln.base;
      for (const at of ln.atoms) {
        if (at.run.href && x >= ax - slack && x <= ax + at.w + slack && y >= base - at.a - slack && y <= base + at.d + slack) return at.run.href;
        ax += at.w;
      }
    }
    return null;
  }

  // ---------- the editor: DOM <-> paras ----------

  const isSlot = (el) => el.classList?.contains('sl');
  const STRUCT = { fr: 'fr', sp: 'sp', rt: 'rt' };

  function slotEl(cls, nodes, k) {
    const s = document.createElement('span');
    s.className = 'sl ' + cls;
    s.contentEditable = 'true';
    s.append(...nodesToDom(nodes, k));
    if (!s.childNodes.length) s.textContent = ZW;
    return s;
  }

  function structEl(kind, parts, k) {
    const el = document.createElement('span');
    el.className = 'ms ' + kind;
    el.contentEditable = 'false';
    if (kind === 'fr') el.append(slotEl('nu', parts[0], k), slotEl('de', parts[1], k));
    else el.append(slotEl(kind === 'sp' ? 'pw' : 'rd', parts, k));
    return el;
  }

  function nodesToDom(nodes, k) {
    const out = [];
    for (const n of nodes) {
      if (typeof n === 'string') out.push(document.createTextNode(n));
      else if (n.fr) out.push(structEl('fr', n.fr, k));
      else if (n.sp) out.push(structEl('sp', n.sp, k));
      else if (n.rt) out.push(structEl('rt', n.rt, k));
    }
    return out;
  }

  function mathEl(run, k) {
    const el = document.createElement('span');
    el.className = 'm';
    el.style.color = run.c;
    el.style.fontSize = `${run.z * k}px`;
    if (run.h) el.style.backgroundColor = run.h;
    el.append(document.createTextNode(ZW), ...nodesToDom(run.m, k), document.createTextNode(ZW));
    return el;
  }

  function textEl(run, k) {
    const el = document.createElement('span');
    el.textContent = run.s;
    el.style.fontWeight = run.b ? '700' : '400';
    el.style.fontStyle = run.i ? 'italic' : 'normal';
    if (run.u) el.style.textDecoration = 'underline';
    el.style.color = run.c;
    if (run.h) el.style.backgroundColor = run.h;
    el.style.fontFamily = FONTS[run.f].css;
    el.style.fontSize = `${run.z * k}px`;
    if (!run.href) return el;
    const a = document.createElement('a'); // a link: the words inside it
    a.className = 'rt-link';
    a.href = run.href;
    a.appendChild(el);
    return a;
  }

  function toDom(root, paras, k, dz = DEFAULT_Z) {
    root.textContent = '';
    let prevZ = dz;
    for (const p of paras) {
      const div = document.createElement('div');
      div.className = 'p';
      if (p.l) div.dataset.list = p.l;
      if (p.d) div.dataset.indent = String(p.d);
      if (p.a) { div.dataset.align = p.a; div.style.textAlign = p.a === 'c' ? 'center' : 'right'; }
      // The paragraph is the size of its first words (or of the line above, when empty): the editor then spaces its
      // lines as the board draws them, not at the default size.
      const z = p.r[0]?.z || prevZ;
      prevZ = z;
      div.style.fontSize = `${z * k}px`;
      setDomIndent(div, p.d || 0, z * k);
      for (const run of p.r) if (run.m || run.s) div.appendChild(run.m ? mathEl(run, k) : textEl(run, k));
      if (!div.childNodes.length) div.appendChild(document.createElement('br'));
      root.appendChild(div);
    }
  }

  function setDomIndent(div, level, sizePx) {
    if (level) div.style.setProperty('--rt-indent', `${level * INDENT_EM * sizePx}px`);
    else div.style.removeProperty('--rt-indent');
  }

  function rgbToHex(rgb) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    if (!m) return INK;
    return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
  }

  function highlightAt(el, root) {
    for (let e = el; e && e !== root.parentNode; e = e.parentElement) {
      if (!e.style?.backgroundColor || e.style.backgroundColor === 'transparent') continue;
      const css = getComputedStyle(e).backgroundColor;
      if (/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(css)) continue;
      const c = rgbToHex(css);
      if (c) return c;
    }
    return null;
  }

  function fontKeyOf(family) {
    const f = family.toLowerCase();
    for (const key of fontKeys) {
      const firstName = FONTS[key].css.split(',')[0].replace(/'/g, '').trim().toLowerCase();
      if (f.includes(firstName)) return key;
    }
    return 'clean';
  }

  /** The look of the words at an element, as a run (without the words). */
  function styleAt(el, root, k) {
    const cs = getComputedStyle(el);
    let u = false;
    for (let e = el; e && e !== root.parentNode; e = e.parentElement) {
      if (getComputedStyle(e).textDecorationLine.includes('underline')) { u = true; break; }
    }
    const run = { c: rgbToHex(cs.color), f: fontKeyOf(cs.fontFamily), z: cleanSize(parseFloat(cs.fontSize) / k) };
    if (parseInt(cs.fontWeight, 10) >= 600) run.b = 1;
    if (cs.fontStyle === 'italic') run.i = 1;
    if (u) run.u = 1;
    const h = highlightAt(el, root);
    if (h) run.h = h;
    return run;
  }

  function nodesOf(el) {
    const out = [];
    if (!el) return out;
    let text = '';
    const flush = () => { if (text) { out.push(text); text = ''; } };
    for (const n of el.childNodes) {
      if (n.nodeType === 3) text += n.data.replace(/​/g, '');
      else if (n.nodeType === 1) {
        const cl = n.classList;
        if (cl.contains('fr')) { flush(); out.push({ fr: [nodesOf(n.querySelector(':scope > .nu')), nodesOf(n.querySelector(':scope > .de'))] }); }
        else if (cl.contains('sp')) { flush(); out.push({ sp: nodesOf(n.querySelector(':scope > .sl')) }); }
        else if (cl.contains('rt')) { flush(); out.push({ rt: nodesOf(n.querySelector(':scope > .sl')) }); }
        else if (n.tagName !== 'BR') { flush(); out.push(...nodesOf(n)); }
      }
    }
    flush();
    return out;
  }

  const sameLook = (a, b) => !a.m && !b.m && a.c === b.c && a.h === b.h && a.f === b.f && a.z === b.z && !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && (a.href || '') === (b.href || '');

  function fromDom(root, k) {
    normalize(root);
    const paras = [];
    for (const div of root.children) {
      const runs = [];
      const push = (run) => {
        const last = runs[runs.length - 1];
        if (last && sameLook(last, run)) last.s += run.s;
        else runs.push(run);
      };
      const walk = (node, href) => {
        for (const n of node.childNodes) {
          if (n.nodeType === 3) {
            const s = n.data.replace(/​/g, '');
            if (s) push(href ? { s, ...styleAt(n.parentElement, root, k), href } : { s, ...styleAt(n.parentElement, root, k) });
          } else if (n.nodeType === 1) {
            if (n.classList.contains('m')) {
              const st = styleAt(n, root, k);
              const run = { m: nodesOf(n), c: st.c, z: st.z };
              if (st.h) run.h = st.h;
              runs.push(run);
            }
            else if (n.tagName === 'A') walk(n, cleanHref(n.getAttribute('href')) || href);
            else if (n.tagName !== 'BR') walk(n, href);
          }
        }
      };
      walk(div);
      const p = { r: runs };
      if (div.dataset.list === 'b' || div.dataset.list === 'n') p.l = div.dataset.list;
      if (div.dataset.align === 'c' || div.dataset.align === 'r') p.a = div.dataset.align;
      const d = Math.max(0, Math.min(MAX_INDENT, Math.floor(Number(div.dataset.indent) || 0)));
      if (d) p.d = d;
      paras.push(p);
    }
    return clean(paras);
  }

  /** Keep the editor as one <div class="p"> per paragraph, whatever the browser did while typing. */
  function normalize(root) {
    let stray = null;
    for (const n of [...root.childNodes]) {
      const block = n.nodeType === 1 && (n.tagName === 'DIV' || n.tagName === 'P');
      if (block) {
        stray = null;
        if (!n.classList.contains('p')) n.classList.add('p');
        continue;
      }
      if (n.nodeType === 1 && n.tagName === 'BR' && !stray) { n.remove(); continue; }
      if (!stray) { stray = document.createElement('div'); stray.className = 'p'; root.insertBefore(stray, n); }
      stray.appendChild(n);
    }
    if (!root.children.length) {
      const div = document.createElement('div');
      div.className = 'p';
      div.appendChild(document.createElement('br'));
      root.appendChild(div);
    }
  }

  // ---------- the editor ----------

  const MATH_KEYS = [
    ['fr', 'a⁄b', 'Fraction'], ['sp', 'x²', 'Power'], ['rt', '√', 'Square root'], ['÷'], ['×'], ['−'], ['+'], ['='], ['<'], ['>'], ['≤'], ['≥'],
    ['7'], ['8'], ['9'], ['('], [')'], ['x'], ['y'], ['n'], ['π'], ['%'], ['.'], ['back', '⌫', 'Delete'],
    ['4'], ['5'], ['6'], ['1'], ['2'], ['3'], ['0'], ['≠'], [','], ['left', '←', 'Back a step'], ['right', '→', 'Out of the fraction, power or root'], ['done', 'Done', 'Done with the math'],
  ];

  /**
   * A text box editor: format bar, the text, and a math keyboard.
   * opts: { scale(): editor px per page unit, onChange(paras), onDone(), keysHost?: element for the math keyboard,
   *         touch?: put formatting below the text so iPadOS's selection menu does not cover it,
   *         defaultSize?: the size new words start at (DEFAULT_Z when not given),
   *         links?: offer the Link button (the teacher's boards only; a student never adds links) }
   */
  class Editor {
    constructor(opts) {
      this.opts = opts;
      this.k = 1;
      this.mathKeys = false;
      this.saved = null;
      const el = (this.el = document.createElement('div'));
      el.className = 'rt-editor';
      if (opts.touch) el.classList.add('rt-touch');
      el.innerHTML = `
        <div class="rt-bar">
          <select class="rt-font" title="Font" aria-label="Font">${fontKeys.map((key) => `<option value="${key}">${FONTS[key].name}</option>`).join('')}</select>
          <span class="rt-size"><button data-rt="smaller" title="Smaller" aria-label="Smaller">−</button><input class="rt-z" type="number" min="${MIN_Z}" max="${MAX_Z}" aria-label="Size"><button data-rt="bigger" title="Bigger" aria-label="Bigger">+</button></span>
          <span class="rt-sep"></span>
          <button data-rt="bold" class="rt-b" title="Bold" aria-label="Bold">B</button>
          <button data-rt="italic" class="rt-i" title="Italic" aria-label="Italic">I</button>
          <button data-rt="underline" class="rt-u" title="Underline" aria-label="Underline">U</button>
          <span class="rt-sep"></span>
          <button data-rtpop="color" class="rt-color" title="Text color" aria-label="Text color"><span>A</span></button>
          <button data-rtpop="highlight" class="rt-highlight" title="Highlight selected words" aria-label="Highlight selected words"><span>ab</span></button>
          <button data-rtpop="paragraph" class="rt-paragraph" title="Paragraph: alignment, lists and indentation" aria-label="Paragraph formatting">☰</button>
          ${opts.links ? '<button data-rtpop="link" class="rt-linkbtn" title="Link: select words, then paste a web address" aria-label="Link">🔗</button>' : ''}
          <span class="rt-sep"></span>
          <button data-rt="math" class="rt-math" title="Math: fractions, powers, roots and symbols" aria-label="Math">√x</button>
          <button data-rt="done" class="rt-done" title="Done">Done</button>
        </div>
        <div class="rt-text" contenteditable="true" spellcheck="true"></div>`;
      this.text = el.querySelector('.rt-text');
      const pop = (this.pop = document.createElement('div'));
      pop.className = 'rt-pop';
      pop.hidden = true;
      pop.innerHTML = `
        <div data-for="color">
          <b>Text color</b>
          <div class="rt-swatches">${COLORS.map((c) => `<button data-pick-color="${c}" style="--c:${c}" aria-label="Text color ${c}"></button>`).join('')}</div>
          <label class="rt-custom">More… <input class="rt-custom-color" type="color" value="${INK}" aria-label="Custom text color"></label>
        </div>
        <div data-for="highlight">
          <b>Highlight selected words</b>
          <div class="rt-swatches"><button data-pick-highlight="" class="rt-no-highlight" aria-label="No highlight">None</button>${HIGHLIGHTS.map((c) => `<button data-pick-highlight="${c}" style="--c:${c}" aria-label="Highlight ${c}"></button>`).join('')}</div>
          <label class="rt-custom">More… <input class="rt-custom-highlight" type="color" value="${HIGHLIGHTS[0]}" aria-label="Custom highlight color"></label>
        </div>
        <div data-for="paragraph">
          <b>Paragraph</b>
          <div class="rt-pop-row rt-aligns">
            <button data-align="l" title="Align left" aria-label="Align left">☰</button>
            <button data-align="c" title="Align center" aria-label="Align center">☰</button>
            <button data-align="r" title="Align right" aria-label="Align right">☰</button>
          </div>
          <div class="rt-pop-row">
            <button data-rt="list-b" title="Bulleted list" aria-label="Bulleted list">•≡</button>
            <button data-rt="list-n" title="Numbered list" aria-label="Numbered list">1≡</button>
            <button data-indent="-1" title="Outdent" aria-label="Outdent">←≡</button>
            <button data-indent="1" title="Indent" aria-label="Indent">≡→</button>
          </div>
        </div>
        <div data-for="link">
          <b>Link to a web page</b>
          <div class="rt-link-row"><input class="rt-href" type="url" placeholder="https://…" aria-label="Web address" spellcheck="false" autocomplete="off"><button class="rt-link-add">Link</button></div>
          <p class="rt-link-tip">Select the words first. Students open it with the Select tool.</p>
          <button class="rt-link-remove">Remove link</button>
        </div>`;
      document.body.appendChild(pop);
      const keys = (this.keys = document.createElement('div'));
      keys.className = 'rt-keys';
      keys.hidden = true;
      keys.innerHTML = `
        <div class="rt-tabs"><button data-mode="abc">ABC</button><button data-mode="math" class="on">√x Math</button><span>Tap a⁄b for a stacked fraction, x² for a power, √ for a root; → moves out of it</span></div>
        <div class="rt-grid">${MATH_KEYS.map(([id, label, title]) => `<button data-key="${id}" title="${title || label || id}" class="${['fr', 'sp', 'rt'].includes(id) ? 'tpl' : id === 'done' ? 'go' : BINARY.includes(id) ? 'op' : ''}">${label || id}</button>`).join('')}</div>`;
      (opts.keysHost || el).appendChild(keys);
      this.wire();
    }

    wire() {
      const keep = (e) => e.preventDefault(); // tapping a button keeps the caret where it was
      for (const b of this.el.querySelectorAll('.rt-bar button')) { b.addEventListener('mousedown', keep); b.addEventListener('pointerdown', keep); }
      for (const b of this.pop.querySelectorAll('button')) { b.addEventListener('mousedown', keep); b.addEventListener('pointerdown', keep); }
      for (const b of this.keys.querySelectorAll('button')) { b.addEventListener('mousedown', keep); b.addEventListener('pointerdown', keep); }
      document.addEventListener('selectionchange', () => {
        // Opening a font or size control can move focus away from the contenteditable on iPad. Keep the highlighted
        // words, rather than replacing the saved range with Safari's temporary caret while that control is in use.
        if (this.el.querySelector('.rt-bar').contains(document.activeElement) || this.pop.contains(document.activeElement)) return;
        const s = getSelection();
        if (s.rangeCount && this.text.contains(s.anchorNode)) { this.saved = s.getRangeAt(0).cloneRange(); this.showState(); }
      });
      this.text.addEventListener('input', () => this.changed());
      this.text.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') { e.preventDefault(); this.indent(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); this.opts.onDone(); }
        e.stopPropagation(); // typing here never reaches the board's shortcuts
      });
      this.text.addEventListener('paste', (e) => { // paste plain words only
        e.preventDefault();
        const t = (e.clipboardData || window.clipboardData).getData('text/plain');
        const href = this.opts.links && /^\s*https?:\/\/\S+\s*$/i.test(t) ? cleanHref(t.trim()) : null;
        if (href) { this.link(href, t.trim()); return; } // a web address on its own: a link, ready to click
        document.execCommand('insertText', false, t);
      });
      // A link in the words being typed is just words: clicking it puts the caret there (never opens it).
      this.text.addEventListener('click', (e) => { if (e.target.closest?.('a')) e.preventDefault(); });
      this.el.querySelector('.rt-font').addEventListener('change', (e) => { this.restore(); this.css('fontName', FONTS[e.target.value].css); });
      const zIn = this.el.querySelector('.rt-z');
      zIn.addEventListener('change', () => { this.restore(); this.setSize(Number(zIn.value)); });
      for (const b of this.el.querySelectorAll('[data-rtpop]')) b.addEventListener('click', () => this.openPop(b.dataset.rtpop, b));
      for (const b of this.pop.querySelectorAll('[data-pick-color]')) b.addEventListener('click', () => {
        this.restore(); this.css('foreColor', b.dataset.pickColor); this.closePop();
      });
      for (const b of this.pop.querySelectorAll('[data-pick-highlight]')) b.addEventListener('click', () => {
        this.restore(); this.css('backColor', b.dataset.pickHighlight || 'transparent'); this.closePop();
      });
      this.pop.querySelector('.rt-custom-color').addEventListener('change', (e) => { this.restore(); this.css('foreColor', e.target.value); this.closePop(); });
      this.pop.querySelector('.rt-custom-highlight').addEventListener('change', (e) => { this.restore(); this.css('backColor', e.target.value); this.closePop(); });
      for (const b of this.pop.querySelectorAll('[data-align]')) b.addEventListener('click', () => { this.align(b.dataset.align); this.closePop(); });
      for (const b of this.pop.querySelectorAll('[data-indent]')) b.addEventListener('click', () => { this.indent(Number(b.dataset.indent)); this.closePop(); });
      const hrefIn = this.pop.querySelector('.rt-href');
      const addLink = () => {
        const typed = hrefIn.value.trim();
        const href = cleanHref(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : 'https://' + typed);
        if (!typed || !href) { hrefIn.setCustomValidity('A web address, like https://docs.google.com/…'); hrefIn.reportValidity(); return; }
        hrefIn.setCustomValidity('');
        this.restore();
        this.link(href);
        this.closePop();
      };
      this.pop.querySelector('.rt-link-add').addEventListener('click', addLink);
      hrefIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addLink(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.closePop(); this.restore(); }
        e.stopPropagation(); // typing here never reaches the board's shortcuts
      });
      hrefIn.addEventListener('input', () => hrefIn.setCustomValidity(''));
      this.pop.querySelector('.rt-link-remove').addEventListener('click', () => {
        this.restore();
        const a = this.linkHere();
        if (a) { const r = document.createRange(); r.selectNodeContents(a); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        document.execCommand('unlink');
        this.changed();
        this.closePop();
      });
      for (const b of [...this.el.querySelectorAll('[data-rt]'), ...this.pop.querySelectorAll('[data-rt]')]) b.addEventListener('click', () => {
        this.restore();
        const what = b.dataset.rt;
        if (what === 'bold' || what === 'italic' || what === 'underline') { document.execCommand('styleWithCSS', false, false); document.execCommand(what); this.changed(); }
        else if (what === 'smaller' || what === 'bigger') this.setSize(this.sizeHere() + (what === 'bigger' ? 2 : -2));
        else if (what === 'list-b' || what === 'list-n') { this.toggleList(what.slice(-1)); this.closePop(); }
        else if (what === 'math') { if (!this.mathAtCaret()) this.insertMath(); this.setMathKeys(true); }
        else if (what === 'done') this.opts.onDone();
      });
      document.addEventListener('pointerdown', (e) => { if (!this.pop.hidden && !this.pop.contains(e.target) && !e.target.closest?.('[data-rtpop]')) this.closePop(); });
      for (const b of this.keys.querySelectorAll('[data-mode]')) b.addEventListener('click', () => this.setMathKeys(b.dataset.mode === 'math'));
      for (const b of this.keys.querySelectorAll('[data-key]')) b.addEventListener('click', () => this.key(b.dataset.key));
    }

    /** The size new words start at. */
    dz() { return this.opts.defaultSize || DEFAULT_Z; }

    open(paras, { math = false } = {}) {
      this.k = this.opts.scale();
      toDom(this.text, paras, this.k, this.dz());
      this.text.style.fontSize = `${this.dz() * this.k}px`;
      this.el.hidden = false;
      this.text.focus();
      // The caret at the end; a new math box starts inside its math.
      const m = math && this.text.querySelector('.m');
      const s = getSelection();
      const r = document.createRange();
      r.selectNodeContents(m || this.text.lastElementChild || this.text);
      r.collapse(false);
      if (m) r.setStart(m.lastChild, 0);
      s.removeAllRanges();
      s.addRange(r);
      this.saved = r.cloneRange();
      this.setMathKeys(math);
      this.showState();
    }

    close() {
      this.el.hidden = true;
      this.keys.hidden = true;
      this.closePop();
      if (this.text.contains(document.activeElement) || document.activeElement === this.text) document.activeElement.blur();
    }

    openPop(kind, anchor) {
      if (!this.pop.hidden && this.pop.dataset.kind === kind) { this.closePop(); return; }
      this.restore();
      this.showState();
      this.pop.dataset.kind = kind;
      for (const part of this.pop.querySelectorAll('[data-for]')) part.hidden = part.dataset.for !== kind;
      if (kind === 'link') {
        const a = this.linkHere();
        this.pop.querySelector('.rt-href').value = a ? a.getAttribute('href') : '';
        this.pop.querySelector('.rt-link-remove').hidden = !a;
      }
      this.pop.hidden = false;
      if (kind === 'link') setTimeout(() => this.pop.querySelector('.rt-href').focus(), 0);
      const a = anchor.getBoundingClientRect();
      const gap = 6;
      const left = Math.max(8, Math.min(a.left, innerWidth - this.pop.offsetWidth - 8));
      const below = a.bottom + gap + this.pop.offsetHeight <= innerHeight - 8;
      this.pop.style.left = `${left}px`;
      this.pop.style.top = `${below ? a.bottom + gap : Math.max(8, a.top - gap - this.pop.offsetHeight)}px`;
    }

    closePop() {
      this.pop.hidden = true;
      delete this.pop.dataset.kind;
    }

    /** The page units per editor px changed (the board was zoomed): redraw the editor at the new size. */
    rescale() {
      const paras = this.paras();
      this.open(paras, { math: this.mathKeys });
    }

    paras() { return fromDom(this.text, this.k); }

    changed() {
      normalize(this.text);
      this.syncIndents();
      this.showState();
      this.opts.onChange(this.paras());
    }

    /** Each paragraph takes the size of its first words (an empty one, the size of the line above), so the lines are
     *  spaced for the words in them, as on the board; and its indentation follows that size. */
    syncIndents() {
      let prev = this.dz() * this.k;
      for (const div of this.text.children) {
        const level = Math.max(0, Math.min(MAX_INDENT, Math.floor(Number(div.dataset.indent) || 0)));
        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
        const t = walker.nextNode();
        let host = t ? t.parentElement : null;
        const m = host?.closest('.m');
        if (m && div.contains(m)) host = m;
        let size = host ? parseFloat(getComputedStyle(host).fontSize) : prev;
        if (!Number.isFinite(size)) size = prev;
        if (host !== div) div.style.fontSize = `${size}px`;
        setDomIndent(div, level, size);
        prev = size;
      }
    }

    restore() {
      if (!this.saved) return;
      const s = getSelection();
      if (s.rangeCount && this.text.contains(s.anchorNode) && (document.activeElement === this.text || this.text.contains(document.activeElement))) return;
      // Formatting only applies where the typing is: after the size box or a palette's color well, put it back in the words.
      if (document.activeElement !== this.text && !this.text.contains(document.activeElement)) this.text.focus({ preventScroll: true });
      s.removeAllRanges();
      s.addRange(this.saved);
    }

    range() {
      this.restore();
      const s = getSelection();
      return s.rangeCount ? s.getRangeAt(0) : null;
    }

    /** A look for the selected words (or for what's typed next). */
    css(cmd, value) {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(cmd, false, value);
      this.changed();
    }

    /** The link the caret or selection is in, if any. */
    linkHere() {
      const r = this.saved;
      if (!r) return null;
      const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const a = node?.closest?.('a');
      return a && this.text.contains(a) ? a : null;
    }

    /** Make the selected words a link (blue, as links look); with nothing selected, put <words> (or the address) in as one. */
    link(href, words) {
      const r = this.range();
      if (!r) return;
      if (r.collapsed) {
        const shown = words || href.replace(/^https?:\/\//, '').replace(/\/$/, '');
        document.execCommand('insertText', false, shown);
        const s = getSelection();
        const done = s.rangeCount ? s.getRangeAt(0) : null;
        if (!done || done.endContainer.nodeType !== 3 || done.endOffset < shown.length) { this.changed(); return; }
        const back = document.createRange();
        back.setStart(done.endContainer, done.endOffset - shown.length);
        back.setEnd(done.endContainer, done.endOffset);
        s.removeAllRanges();
        s.addRange(back);
      }
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('foreColor', false, '#1971c2');
      document.execCommand('createLink', false, href);
      const s = getSelection();
      if (s.rangeCount) { const end = s.getRangeAt(0).cloneRange(); end.collapse(false); s.removeAllRanges(); s.addRange(end); }
      this.changed();
    }

    sizeHere() {
      const r = this.range();
      const node = r ? r.startContainer : this.text;
      const el = node.nodeType === 1 ? node : node.parentElement;
      return this.text.contains(el) ? cleanSize(parseFloat(getComputedStyle(el).fontSize) / this.k) : this.dz();
    }

    setSize(z) {
      z = cleanSize(z);
      const r = this.range();
      if (!r) return;
      const px = `${z * this.k}px`;
      if (r.collapsed) {
        // Nothing selected: what's typed next is this size.
        const span = document.createElement('span');
        span.style.fontSize = px;
        span.textContent = ZW;
        r.insertNode(span);
        this.caretIn(span, true);
      } else {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('fontSize', false, '7');
        for (const el of this.text.querySelectorAll('font[size="7"], [style*="xxx-large"]')) {
          el.removeAttribute('size');
          el.style.fontSize = px;
        }
        for (const m of this.text.querySelectorAll('.m')) if (r.intersectsNode(m)) m.style.fontSize = px;
      }
      this.changed();
    }

    toggleList(kind) {
      const r = this.range();
      if (!r) return;
      normalize(this.text);
      const blocks = [...this.text.children].filter((d) => r.intersectsNode(d));
      const all = blocks.length && blocks.every((d) => d.dataset.list === kind);
      for (const d of blocks) { if (all) delete d.dataset.list; else d.dataset.list = kind; }
      this.changed();
    }

    align(where) {
      const r = this.range();
      if (!r) return;
      normalize(this.text);
      const here = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const blocks = r.collapsed ? [here?.closest('.p')].filter(Boolean) : [...this.text.children].filter((d) => r.intersectsNode(d));
      for (const d of blocks) {
        if (where === 'c' || where === 'r') {
          d.dataset.align = where;
          d.style.textAlign = where === 'c' ? 'center' : 'right';
        } else {
          delete d.dataset.align;
          d.style.textAlign = 'left';
        }
      }
      this.changed();
    }

    /** Tab and Shift+Tab indent or outdent the current paragraphs without putting focus outside the text box. */
    indent(by) {
      const r = this.range();
      if (!r) return;
      normalize(this.text);
      const here = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const blocks = r.collapsed ? [here?.closest('.p')].filter(Boolean) : [...this.text.children].filter((d) => r.intersectsNode(d));
      for (const d of blocks) {
        const level = Math.max(0, Math.min(MAX_INDENT, Math.floor(Number(d.dataset.indent) || 0) + by));
        if (level) d.dataset.indent = String(level);
        else delete d.dataset.indent;
      }
      this.changed();
    }

    showState() {
      const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
      this.el.querySelector('.rt-b').classList.toggle('on', q('bold'));
      this.el.querySelector('.rt-i').classList.toggle('on', q('italic'));
      this.el.querySelector('.rt-u').classList.toggle('on', q('underline'));
      const zIn = this.el.querySelector('.rt-z');
      if (document.activeElement !== zIn) zIn.value = this.sizeHere();
      const r = this.saved;
      const node = r ? r.startContainer : null;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (el && this.text.contains(el)) {
        const cs = getComputedStyle(el);
        this.el.querySelector('.rt-font').value = fontKeyOf(cs.fontFamily);
        const hex = rgbToHex(cs.color);
        this.el.querySelector('.rt-color').style.setProperty('--c', hex);
        this.pop.querySelector('.rt-custom-color').value = hex;
        for (const b of this.pop.querySelectorAll('[data-pick-color]')) b.classList.toggle('on', b.dataset.pickColor === hex);
        const h = highlightAt(el, this.text);
        this.el.querySelector('.rt-highlight').style.setProperty('--h', h || 'transparent');
        if (h) this.pop.querySelector('.rt-custom-highlight').value = h;
        for (const b of this.pop.querySelectorAll('[data-pick-highlight]')) b.classList.toggle('on', b.dataset.pickHighlight === (h || ''));
        const p = el.closest('.p');
        for (const kind of ['b', 'n']) this.pop.querySelector(`[data-rt="list-${kind}"]`).classList.toggle('on', p?.dataset.list === kind);
        const align = p?.dataset.align || 'l';
        for (const b of this.pop.querySelectorAll('[data-align]')) b.classList.toggle('on', b.dataset.align === align);
        const indent = Number(p?.dataset.indent) || 0;
        this.pop.querySelector('[data-indent="-1"]').disabled = indent <= 0;
        this.pop.querySelector('[data-indent="1"]').disabled = indent >= MAX_INDENT;
      }
      this.el.querySelector('.rt-math').classList.toggle('on', !!this.mathAtCaret());
    }

    // --- math ---

    setMathKeys(on) {
      this.mathKeys = on;
      this.keys.hidden = !on;
      for (const b of this.keys.querySelectorAll('[data-mode]')) b.classList.toggle('on', (b.dataset.mode === 'math') === on);
      // The math keyboard replaces the iPad keyboard; ABC brings it back.
      for (const e of [this.text, ...this.text.querySelectorAll('.sl')]) e.setAttribute('inputmode', on && this.opts.touch ? 'none' : 'text');
      this.opts.onKeys?.(on);
    }

    mathAtCaret() {
      const r = this.saved;
      if (!r) return null;
      const node = r.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      return el && this.text.contains(el) ? el.closest('.m') : null;
    }

    caretIn(el, atEnd) {
      const s = getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(!atEnd);
      s.removeAllRanges();
      s.addRange(r);
      this.saved = r.cloneRange();
    }

    caretAfter(el) {
      let t = el.nextSibling;
      if (!t || t.nodeType !== 3) { t = document.createTextNode(ZW); el.after(t); }
      const s = getSelection();
      const r = document.createRange();
      r.setStart(t, t.data.startsWith(ZW) ? 1 : 0);
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
      this.saved = r.cloneRange();
    }

    caretBefore(el) {
      let t = el.previousSibling;
      if (!t || t.nodeType !== 3) { t = document.createTextNode(ZW); el.before(t); }
      const s = getSelection();
      const r = document.createRange();
      r.setStart(t, t.data.length);
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
      this.saved = r.cloneRange();
    }

    insertMath() {
      const r = this.range();
      if (!r) return;
      const m = document.createElement('span');
      m.className = 'm';
      m.append(ZW, ZW);
      r.deleteContents();
      r.insertNode(m);
      this.caretIn(m.firstChild, true);
      this.changed();
    }

    key(id) {
      if (id === 'done') { const m = this.mathAtCaret(); if (m) this.caretAfter(m); this.setMathKeys(false); this.text.focus(); return; }
      if (!this.mathAtCaret()) this.insertMath();
      const r = this.range();
      if (!r) return;
      const s = getSelection();
      const at = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const slot = at.closest('.sl');
      const struct = slot?.parentElement;
      if (id === 'right' || id === 'left') {
        if (slot && this.text.contains(slot)) {
          if (id === 'right' && slot.classList.contains('nu')) this.caretIn(struct.querySelector('.de'), false);
          else if (id === 'left' && slot.classList.contains('de')) this.caretIn(struct.querySelector('.nu'), true);
          else if (id === 'right') this.caretAfter(struct);
          else this.caretBefore(struct);
        } else {
          s.modify('move', id === 'right' ? 'forward' : 'backward', 'character');
          this.saved = s.getRangeAt(0).cloneRange();
        }
        return;
      }
      if (id === 'back') {
        // An empty fraction / power / root goes whole; so does one just before the caret.
        if (slot && slot.textContent.replace(/​/g, '') === '' && !slot.querySelector('.ms')) {
          const p = struct.previousSibling;
          struct.remove();
          if (p) this.caretAfter(p.nodeType === 3 ? p : p); else this.caretIn(at.closest('.m') || this.text, false);
          this.changed();
          return;
        }
        let prev = null;
        if (r.collapsed) {
          const c = r.startContainer;
          if (c.nodeType === 3 && c.data.slice(0, r.startOffset).replace(/​/g, '') === '') prev = c.previousSibling;
          else if (c.nodeType === 1) prev = c.childNodes[r.startOffset - 1];
        }
        if (prev && prev.nodeType === 1 && prev.classList.contains('ms')) { prev.remove(); this.changed(); return; }
        document.execCommand('delete');
        this.changed();
        return;
      }
      if (STRUCT[id]) {
        const el = structEl(id, id === 'fr' ? [[], []] : [], this.k);
        r.deleteContents();
        r.insertNode(el);
        if (!el.nextSibling) el.after(ZW);
        if (!el.previousSibling) el.before(ZW);
        this.setMathKeys(this.mathKeys); // its slots get the same keyboard
        this.caretIn(el.querySelector('.sl'), true);
        this.changed();
        return;
      }
      document.execCommand('insertText', false, id === '−' ? '−' : id);
      this.changed();
    }
  }

  window.PadText = { FONTS, COLORS, DEFAULT_Z, clean, cleanHref, isEmpty, draw, bounds, layout, linkAt, Editor, isSlot };
})();
