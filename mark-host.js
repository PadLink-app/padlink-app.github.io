// PadLink: the teacher writing on a student's board with every whiteboard tool. The teacher's grid of student boards
// (teacher.js) opens the whiteboard (board.js, in marking mode) in a frame over the student's board; this stand-in for
// PadLink's window gives it the student's board, and turns each save into the teacher's marks: added, changed or
// taken back, one at a time, which teacher.js sends to the PC (and the PC to the student). The student's own work
// (and their teammates', on a team board) is locked on this board, so only the teacher's marks ever change here.
// Loaded before board.js.
(() => {
  'use strict';

  window.PADLINK_MARK = true;
  const listeners = [];
  const deliver = (data) => { for (const fn of listeners) fn({ data }); };
  let parentOrigin = null;     // the grid's, from its first message
  let started = false;         // the board asked for its board
  let loaded = null;           // the board, once the grid sent it (kept until the board asks)

  // The teacher's marks as last sent: key -> { page, json, tid, ref }. A mark the PC knows is keyed by its id there
  // (tid); a new one, by its id here until the PC answers with its tid.
  const known = new Map();
  const waiting = new Map();   // ref -> what changed meanwhile, to send once the PC's tid is in: { item, page } or 'erase'

  const toGrid = (msg) => { if (parentOrigin) window.parent.postMessage({ padlinkMark: 1, ...msg }, parentOrigin); };
  const strip = (it) => { const c = JSON.parse(JSON.stringify(it)); delete c.by; delete c.tid; delete c.id; return c; };
  const mine = (it) => !it.by || it.by === 'teacher';
  // The teacher's marks made here (or in the grid before): "t" and 12 hex digits. The rest of what's the teacher's (the
  // items of a page the teacher sent to a team board) stays as it is, locked like the student's work.
  const isMark = (it) => it.by === 'teacher' && /^t[0-9a-f]{12}$/.test(it.tid || '');
  const lockIt = (it) => (isMark(it) ? it : it.by === 'teacher' ? { ...it, by: 'sent' } : it.by ? it : { ...it, by: 'student' });

  /** The student's work as the board shows it, locked: their items marked as theirs (teammates' already are). */
  function lockedPages(pages) {
    return (pages || []).map((p) => ({
      bg: p.bg, h: p.h, doc: p.doc || null,
      items: (p.items || []).filter((it) => !isMark(it)).map(lockIt),
    }));
  }

  function load(m) {
    known.clear();
    waiting.clear();
    const state = m.state || { pages: [], cur: 0 };
    const pages = (state.pages || []).map((p, i) => {
      const items = (p.items || []).map(lockIt);
      for (const it of items) if (isMark(it)) known.set(it.tid, { page: i, json: JSON.stringify(it), tid: it.tid });
      return { ...p, items };
    });
    loaded = { type: 'boardData', id: 'mark', name: m.name || 'Student board', state: { pages, cur: m.page ?? state.cur ?? 0 }, images: m.images || {} };
    if (started) deliver(loaded);
  }

  /** The board saved: what's new, changed or gone among the teacher's marks goes to the PC. */
  function saved(state) {
    const now = new Map();
    (state.pages || []).forEach((p, i) => (p.items || []).forEach((it) => {
      if (!mine(it)) return;
      const key = it.tid || (it.id != null ? 'n:' + it.id : null);
      if (key) now.set(key, { page: i, item: it, json: JSON.stringify(it) });
    }));
    for (const [key, v] of now) {
      const was = known.get(key);
      if (!was) {
        const ref = key.slice(2);
        known.set(key, { page: v.page, json: v.json, tid: null, ref });
        toGrid({ type: 'mark', op: 'add', ref, page: v.page, item: strip(v.item) });
      } else if (was.json !== v.json) {
        was.json = v.json;
        if (was.tid) toGrid({ type: 'mark', op: 'update', tid: was.tid, page: v.page, item: strip(v.item) });
        else waiting.set(was.ref, { item: strip(v.item), page: v.page });
      }
    }
    for (const [key, was] of [...known]) {
      if (now.has(key)) continue;
      known.delete(key);
      if (was.tid) toGrid({ type: 'mark', op: 'erase', tid: was.tid });
      else waiting.set(was.ref, 'erase');
    }
  }

  /** The PC took a new mark: its id there, and anything that changed since. */
  function marked(ref, tid) {
    for (const v of known.values()) if (v.ref === ref) v.tid = tid;
    const next = waiting.get(ref);
    waiting.delete(ref);
    if (next === 'erase') toGrid({ type: 'mark', op: 'erase', tid });
    else if (next) toGrid({ type: 'mark', op: 'update', tid, page: next.page, item: next.item });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || !e.data.padlinkMark) return;
    if (parentOrigin && e.origin !== parentOrigin) return;
    parentOrigin = e.origin;
    const m = e.data;
    if (m.type === 'load') load(m);
    else if (m.type === 'others') deliver({ type: 'markOthers', pages: lockedPages(m.pages), images: m.images || {} });
    else if (m.type === 'marked') marked(m.ref, m.tid);
  });

  // What board.js sees as PadLink's window around it (in its own name: inside PadLink's window, the real one is there too).
  window.PADLINK_HOST = {
    postMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'boardLast') {
        started = true;
        // What the teacher may use: everything but pictures (the PC doesn't take pictures from here) and the student's
        // pages (adding, deleting or clearing them).
        deliver({ type: 'studentTools', allow: { pictures: false, pages: false } });
        if (loaded) deliver(loaded);
      } else if (msg.type === 'boardSave') {
        saved(msg.state || {});
        deliver({ type: 'boardSaved', id: msg.id });
      }
    },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
  };
  window.parent.postMessage({ padlinkMark: 1, type: 'ready' }, '*'); // (nothing private: the grid answers with the board)
})();
