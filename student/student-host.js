// PadLink Student Mode: the student's whiteboard runs the same board as the teacher's PC (board.js), in Chrome on
// the student's Chromebook. On the PC, PadLink's window around the board keeps it saved; here this stand-in does that
// job over the network: the board's saves go to the teacher's PC (/student/ws), and its last copy comes back when the
// page opens again. Everything else the PC's window does (import, Google Drive, capture, the class tools) isn't
// offered to students. Loaded before board.js.
(() => {
  'use strict';

  let me = null;
  try { me = JSON.parse(localStorage.getItem('padlink.student') || 'null'); } catch { /* private mode */ }
  if (!me || !me.key) { location.replace(typeof PadLinkStudentJoinUrl === 'function' ? PadLinkStudentJoinUrl() : '/student'); return; }
  window.PADLINK_STUDENT = { name: me.name || 'My board' }; // board.js: student mode
  // Team boards: /student/board?team=3 is team 3's shared board (the PC says when to switch, and which).
  const teamNo = Number(new URLSearchParams(location.search).get('team')) || 0;
  if (teamNo) window.PADLINK_TEAM = { no: teamNo };
  let teamOwn = null;     // this student's own items on the team board as last sent: id -> { page, json }
  let teamThumbAt = 0, teamThumbTimer = 0;
  let teamMate = '';      // this student's short id on the team board (the PC puts it before their items' ids)

  const listeners = [];
  const deliver = (data) => { for (const fn of listeners) fn({ data }); };
  let ready = false;
  let ended = false;
  let waiting = [];   // messages for the PC while not connected (only the newest save is kept)
  let lastBoardId = null;
  let boardIn = false;     // the board has opened (pages the teacher sends wait for it)
  const heldPages = [];
  let lastTools = null;    // the teacher's switches, also for a board that starts listening after they came
  // A poll open (not a draw poll): no drawing, only looking (zoom and move the page) and answering. The board, and
  // the teacher's page when following, both.
  let lastLook = null;
  function pollLook(on) {
    if ((lastLook ? lastLook.on : false) === on) return;
    lastLook = { type: 'pollLook', on };
    deliver(lastLook);
    follow.setLook(on);
  }
  // Polls: the live one (everyone at once) comes first; at their own pace, the poll of the page the board is on.
  let livePoll = null, pageSrc = null;
  const selfPolls = new Map(); // "lesson page key#question" -> that poll, as the PC last said
  let justLocked = null, justTimer = 0; // the question just locked in stays a moment (its ✓ or right answer), then the next
  function showPoll() {
    if (livePoll && livePoll.id) { poll.set(livePoll); return; }
    // A page can have several questions: the first one not locked in yet (once all are, the last one)
    const mine = pageSrc ? [...selfPolls.values()].filter((p) => p.src === pageSrc).sort((a, b) => (a.q || 0) - (b.q || 0)) : [];
    const held = justLocked && mine.find((p) => p.id === justLocked);
    const sp = held || mine.find((p) => !p.locked) || mine[mine.length - 1];
    if (!sp) { poll.set({ id: 0 }); return; }
    const of = sp.of || 1;
    poll.set(of > 1 ? { ...sp, question: `Question ${(sp.q || 0) + 1} of ${of}` + (sp.question ? `: ${sp.question}` : '') } : sp);
  }

  function send(msg) {
    if (ready) { transport.send(msg); return; }
    if (msg.t === 'save') waiting = waiting.filter((m) => m.t !== 'save');
    waiting.push(msg);
  }

  // This page (tab): the newest one opened has the class. An older tab or device that got replaced doesn't take it back by
  // itself (the two used to take turns, and the one on screen stayed blank): it says so and offers Use it here.
  const tabId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let takeNext = true, replaced = false;
  const transport = PadLinkStudentWs({
    onopen: () => transport.send({ t: 'resume', key: me.key, tab: tabId, take: takeNext }),
    onmessage: (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'replaced') {
        showReplaced();
      } else if (m.t === 'ready') {
        ready = true;
        takeNext = false; // from now on a reconnect is this page's own (a Wi-Fi blip), not taking over
        replaced = false;
        if (replacedEl) replacedEl.hidden = true;
        status('');
        const out = waiting;
        waiting = [];
        for (const msg of out) transport.send(msg);
      } else if (m.t === 'board') {
        if (teamNo) { teamOwn = ownItems(m.data && m.data.state); teamMate = (m.team && m.team.mate) || ''; } // what's theirs on the team board, as the PC has it
        deliver(m.data ? { type: 'boardData', ...m.data } : { type: 'boardNone' });
        boardIn = true;
        for (const pg of heldPages.splice(0)) deliver(pg);
      } else if (m.t === 'page') {
        // The teacher sent a page: onto the board once it has opened.
        // (A page of the lesson: src is the teacher's page, order its place among the lesson's pages.)
        const pg = { type: 'addPage', sid: m.sid, page: m.page, images: m.images, refs: m.refs, src: m.src, order: m.order };
        if (boardIn) deliver(pg); else heldPages.push(pg);
      } else if (m.t === 'unpage' || m.t === 'lead') {
        // The teacher hid a page of the lesson, or (You lead, Let them draw) the page to write on now.
        const pg = { type: m.t, src: m.src };
        if (boardIn) deliver(pg); else heldPages.push(pg);
      } else if (m.t === 'tink') {
        // The teacher wrote on this board (or took a mark back): onto the board once it has opened.
        let ink = { type: 'teacherInk', op: m.op, tid: m.tid, page: m.page, item: m.item };
        // The teacher took away one of this student's own marks (on the team board): it goes here too.
        if (m.op === 'erase' && teamMate && m.tid && m.tid.startsWith(teamMate + '_')) {
          const id = m.tid.slice(teamMate.length + 1);
          if (teamOwn) teamOwn.delete(id);
          ink = { type: 'teacherInk', op: 'eraseOwn', id };
        }
        if (boardIn) deliver(ink); else heldPages.push(ink);
      } else if (m.t === 'tools') {
        // What the teacher allows (the board hides the rest). A team board: no adding or deleting pages, no clearing,
        // no pictures from students, whatever the switches say.
        const allow = teamNo ? { ...m.allow, pages: false, clear: false, pictures: false } : m.allow;
        lastTools = { type: 'studentTools', allow };
        deliver(lastTools);
      } else if (m.t === 'team') {
        team.set(m); // their team and seat (or none)
      } else if (m.t === 'hand') {
        hand.set(m); // up or down (the teacher may have lowered it), and whether it may be raised
      } else if (m.t === 'shown') {
        shown.set(m); // a classmate's board, shown to the class by the teacher
      } else if (m.t === 'shownScroll') {
        shown.scrollTo(m.y); // the teacher scrolled it
      } else if (m.t === 'timer') {
        timer.set(m); // the class timer, as on the teacher's screen
      } else if (m.t === 'poll') {
        livePoll = m; // a poll: answer buttons, closed, or its results
        showPoll();
        pollLook(!!(m.id && m.open && m.kind !== 'draw'));
      } else if (m.t === 'spoll') {
        const was = selfPolls.get(`${m.src}#${m.q || 0}`);
        selfPolls.set(`${m.src}#${m.q || 0}`, m); // a page's poll, answered at their own pace
        if (m.locked && !(was && was.locked) && (m.of || 1) > 1) { // just locked in: a moment to see it, then the next question
          justLocked = m.id;
          clearTimeout(justTimer);
          justTimer = setTimeout(() => { justLocked = null; showPoll(); }, m.final && m.correct >= 0 ? 2500 : 1200);
        }
        showPoll();
      } else if (m.t === 'spollGone') {
        for (const [k, p] of selfPolls) if (p.id === m.id) selfPolls.delete(k); // a question taken off the page
        showPoll();
      } else if (m.t === 'spollEnd') {
        selfPolls.clear(); // back to the teacher's pace: the pages' polls are over
        showPoll();
      } else if (m.t === 'eyes') {
        eyes.set(!!m.on); // Eyes up: the screen says Eyes on the teacher
      } else if (m.t === 'compare') {
        eyes.compare(!!m.on); // boards side by side on the whiteboard: Look at the board
      } else if (m.t === 'follow') {
        follow.set(!!m.on);
      } else if (m.t === 'wall') {
        wall.set(m); // the class wall: which notes are theirs, and whether they can write
      } else if (m.t === 'notice') {
        wall.say(m.text || '');
      } else if (m.t === 'mlaser') {
        laser.set(m); // the teacher's laser pointer
      } else if (m.t === 'mpage' || m.t === 'mimg' || m.t === 'mlive') {
        follow.onCopy(m);
      } else if (m.t === 'saved') {
        deliver({ type: 'boardSaved', id: lastBoardId });
      } else if (m.t === 'error' && m.why === 'noteam') {
        ended = true;
        location.replace(typeof PadLinkStudentBoardUrl === 'function' ? PadLinkStudentBoardUrl() : '/student/board'); // team boards ended meanwhile: back to their own
      } else if (m.t === 'error' && m.why === 'full-board') {
        status('This board is too large to save. Ask your teacher.');
        deliver({ type: 'saveFailed' }); // its pictures weren't kept: the next save sends them again
      } else if (m.t === 'closed' || m.t === 'error') {
        end(m.t === 'closed' ? 'closed' : m.why);
      }
    },
    onclose: () => {
      ready = false;
      if (ended || replaced) return;
      status('Reconnecting to your teacher’s PC…');
      setTimeout(connect, 1500);
    },
  });

  function connect() {
    if (ended) return;
    transport.connect();
  }

  /** Another tab or device has this student's board now: say so, and offer to use it here (which takes it back). */
  let replacedEl = null;
  function showReplaced() {
    replaced = true;
    status('');
    if (!replacedEl) {
      replacedEl = document.createElement('div');
      replacedEl.className = 'student-ended student-replaced';
      replacedEl.innerHTML = '<div><h2>Your board is open somewhere else</h2><p>It’s open in another tab or on another device, and that one gets the class now. Close the other one, or use it here.</p><a href="#" role="button">Use it here</a></div>';
      replacedEl.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); replacedEl.hidden = true; replaced = false; takeNext = true; status('Connecting…'); connect(); });
      document.body.appendChild(replacedEl);
    }
    replacedEl.hidden = false;
  }

  /** The class closed, or this device is no longer in it: say so over the board, and offer to join again. */
  function end(why) {
    ended = true;
    eyes.set(false);
    eyes.compare(false);
    timer.set({ state: 'idle' }); // no timer once the class is over
    poll.set({ id: 0 });
    try { localStorage.removeItem('padlink.student'); } catch { /* private mode */ }
    const words = {
      closed: ['The class has finished', 'Your teacher closed the class. Your board was not kept.'],
      removed: ['You’ve left the class', 'Your teacher took this device out of the class.'],
    }[why] || ['You’re no longer in the class', 'Join again with the code on the board.'];
    const box = document.createElement('div');
    box.className = 'student-ended';
    const joinHref = typeof PadLinkStudentJoinUrl === 'function' ? PadLinkStudentJoinUrl() : '/student';
    box.innerHTML = `<div><h2></h2><p></p><a href="${joinHref}">Join a class</a></div>`;
    box.querySelector('h2').textContent = words[0];
    box.querySelector('p').textContent = words[1];
    document.body.appendChild(box);
  }

  let statusEl = null;
  function status(text) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'student-status';
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(statusEl));
      if (document.body) document.body.appendChild(statusEl);
    }
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  // What board.js sees as PadLink's window around it.
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'boardLast') send({ t: teamNo ? 'teamLoad' : 'load' });
      else if (msg.type === 'boardSave' && teamNo) sendTeamOps(msg);
      else if (msg.type === 'boardSave') { lastBoardId = msg.id; send({ t: 'save', id: msg.id, state: msg.state, images: msg.images, refs: msg.refs, thumb: msg.thumb }); }
      else if (msg.type === 'saveImage') { const a = document.createElement('a'); a.href = msg.dataUrl; a.download = msg.name || 'whiteboard.png'; a.click(); }
      else if (msg.type === 'studentPage') { pageSrc = msg.src || null; send({ t: 'at', src: pageSrc }); showPoll(); } // the page it's on
      else if (msg.type === 'fullscreen') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
      // Anything else is the PC window's own (import, Drive, capture, class tools, the iPad's copy): not for students.
    },
    addEventListener(type, fn) {
      if (type !== 'message') return;
      listeners.push(fn);
      if (lastTools) setTimeout(() => fn({ data: lastTools }));
      if (lastLook) setTimeout(() => fn({ data: lastLook }));
    },
  };

  // ---------- The class timer: the teacher's countdown, in the corner of every student's screen ----------
  // The PC keeps the timer; it says when it starts, pauses, gets more time, stops or runs out, and this counts down
  // in between. "Time's up!" shows for 10 seconds, as on the PC's screen (the chime plays on the teacher's PC only).
  const DONE_SHOWN_MS = 10000;
  const timer = (() => {
    let box = null, state = 'idle', endsAt = 0, remaining = 0, tick = 0, doneAt = 0;

    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-timer';
      box.setAttribute('role', 'timer');
      box.hidden = true;
      document.body.appendChild(box);
    }

    const fmt = (ms) => {
      const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
    };

    function show() {
      build();
      if (!box) return;
      const left = state === 'running' ? Math.max(0, endsAt - Date.now()) : remaining;
      const done = state === 'done' || (state === 'running' && left <= 0);
      if (done && !doneAt) doneAt = Date.now();
      const doneLong = done && Date.now() - doneAt >= DONE_SHOWN_MS;
      if (doneLong) clearInterval(tick);
      box.hidden = state === 'idle' || doneLong;
      box.classList.toggle('done', done);
      box.classList.toggle('paused', state === 'paused');
      box.classList.toggle('soon', !done && state === 'running' && left <= 10000);
      box.innerHTML = done ? '<span class="timer-icon">⏰</span>Time’s up!'
        : `<span class="timer-icon">⏱</span>${state === 'paused' ? '<span class="timer-paused">Paused</span>' : ''}<b>${fmt(left)}</b>`;
      box.setAttribute('aria-label', done ? 'Time’s up' : `Timer: ${fmt(left)} left${state === 'paused' ? ', paused' : ''}`);
    }

    function set(m) {
      const was = state;
      state = ['running', 'paused', 'done'].includes(m.state) ? m.state : 'idle';
      remaining = Math.max(0, Number(m.remainingMs) || 0);
      endsAt = Date.now() + remaining;
      if (state !== 'done' || (was !== 'done' && was !== 'running')) doneAt = 0; // (counted from when time ran out)
      clearInterval(tick);
      if (state === 'running' || state === 'done') tick = setInterval(show, 250);
      if (!document.body) { document.addEventListener('DOMContentLoaded', show, { once: true }); return; }
      show();
    }

    return { set };
  })();

  // ---------- Eyes up: the whole screen says Eyes on the teacher, until the teacher ends it ----------
  // Over everything (polls, a classmate's board, following the teacher); the board underneath stays as it is, and
  // can't be used meanwhile, not by keyboard or pasting either.
  const eyes = (() => {
    let box = null, on = false, comparing = false;
    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-eyes';
      box.hidden = true;
      box.setAttribute('role', 'alert');
      box.innerHTML = '<div><span class="eyes-icon" aria-hidden="true">👀</span><b>Eyes on the teacher</b><small>Your work is saved. It comes back when your teacher is done.</small></div>';
      document.body.appendChild(box);
      for (const type of ['keydown', 'paste', 'wheel']) addEventListener(type, (e) => { if (on || comparing) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true, passive: false });
    }
    function set(value) {
      on = value;
      show();
    }
    // Boards compared on the whiteboard: the same cover, saying where to look (Eyes up's words win when both are on)
    function compare(value) {
      comparing = value;
      show();
    }
    function show() {
      build();
      if (!box) { document.addEventListener('DOMContentLoaded', show, { once: true }); return; }
      const up = on || comparing;
      box.hidden = !up;
      document.body.classList.toggle('eyes-up', up);
      box.querySelector('b').textContent = on ? 'Eyes on the teacher' : 'Look at the board';
      box.querySelector('small').textContent = on ? 'Your work is saved. It comes back when your teacher is done.' : 'Your teacher is showing some boards to the class. Your work is saved.';
      if (!up) return;
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); // (a text box being typed in)
    }
    return { set, compare };
  })();

  // ---------- Follow me: the teacher's board, live, instead of this one ----------
  // The teacher's PC sends its board as it changes (the same as the iPad's own copy): drawn here with the same engine
  // (engine.js), in front of the student's own board, which can't be used meanwhile.
  const follow = (() => {
    const copy = { pages: new Map(), pid: 0, view: { x: 0, y: 0, z: 1 }, live: null, images: new Map() };
    let box = null, canvas = null, ctx = null, waitEl = null, on = false, frame = 0;
    // During a poll: the student's own look at the teacher's page (zoom and move it), instead of the teacher's view.
    let look = null, lookBar = null;
    const pinch = new Map(); // pointers down on the page while looking
    let pinchLast = null;
    const viewNow = () => look || copy.view;

    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-follow';
      box.hidden = true;
      box.innerHTML = '<div class="follow-bar"><span class="follow-dot"></span><span class="follow-what">Watching your teacher</span>'
        + '<span class="follow-look" hidden><button type="button" data-look="out" aria-label="Zoom out">−</button><button type="button" data-look="in" aria-label="Zoom in">+</button><button type="button" data-look="fit">Whole page</button></span></div>'
        + '<canvas></canvas><p class="follow-wait">Waiting for your teacher’s whiteboard…</p>';
      document.body.appendChild(box);
      canvas = box.querySelector('canvas');
      ctx = canvas.getContext('2d');
      waitEl = box.querySelector('.follow-wait');
      lookBar = box.querySelector('.follow-look');
      addEventListener('resize', draw);
      // The student's own board can't be changed meanwhile, also not by keyboard or pasting. (A poll's typed answer
      // and the raised hand still can.) During a poll, the wheel zooms (Ctrl) or moves their look at the page.
      for (const type of ['keydown', 'paste', 'wheel']) addEventListener(type, (e) => {
        if (!on || e.target?.closest?.('.student-hand, .student-poll, .wall-editor')) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (type === 'wheel' && look) {
          if (e.ctrlKey) zoomLook(Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
          else panLook(e.deltaX, e.deltaY);
        }
      }, { capture: true, passive: false });
      for (const b of lookBar.querySelectorAll('button')) b.addEventListener('click', () => {
        if (!look) return;
        const r = canvas.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (b.dataset.look === 'in') zoomLook(1.5, cx, cy);
        else if (b.dataset.look === 'out') zoomLook(1 / 1.5, cx, cy);
        else { look = { x: 0, y: 0, z: 1 }; draw(); }
      });
      // A finger or the mouse moves the page; two fingers pinch to zoom.
      canvas.addEventListener('pointerdown', (e) => {
        if (!look) return;
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch { /* gone */ }
        pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
        pinchLast = null;
      });
      canvas.addEventListener('pointermove', (e) => {
        const was = pinch.get(e.pointerId);
        if (!look || !was) return;
        const now = { x: e.clientX, y: e.clientY };
        if (pinch.size === 1) panLook(was.x - now.x, was.y - now.y);
        pinch.set(e.pointerId, now);
        if (pinch.size >= 2) {
          const [a, b] = [...pinch.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          if (pinchLast) { panLook(pinchLast.mx - mx, pinchLast.my - my); if (pinchLast.d > 0) zoomLook(d / pinchLast.d, mx, my); }
          pinchLast = { d, mx, my };
        }
      });
      for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, (e) => { pinch.delete(e.pointerId); pinchLast = null; });
      // The class wall: a tap on their own note opens it
      canvas.addEventListener('click', (e) => {
        const E = window.PadEngine, r = canvas.getBoundingClientRect(), p = copy.pages.get(copy.pid);
        if (!E || !p || !r.width) return;
        const v = viewNow(), k = r.width / (E.W / v.z);
        wall.tap(v.x + (e.clientX - r.left) / k, v.y + (e.clientY - r.top) / k, notes());
      });
    }

    /** The items on the teacher's page now (for the class wall). */
    function notes() { const p = copy.pages.get(copy.pid); return p ? p.order.map((id) => p.items.get(id)).filter(Boolean) : []; }

    function clampLook() {
      const E = window.PadEngine, p = copy.pages.get(copy.pid), h = (p && p.h) || E.H;
      look.z = Math.min(6, Math.max(1, look.z));
      look.x = Math.min(E.W - E.W / look.z, Math.max(0, look.x));
      look.y = Math.min(Math.max(0, h - E.H / look.z), Math.max(0, look.y));
    }
    /** Move the look by (dx, dy) screen pixels (a drag: the page follows the finger; or the wheel). */
    function panLook(dx, dy) {
      const E = window.PadEngine, r = canvas.getBoundingClientRect();
      if (!look || !E || !r.width) return;
      const k = r.width / (E.W / look.z);
      look.x += dx / k; look.y += dy / k;
      clampLook();
      draw();
    }
    function zoomLook(f, clientX, clientY) {
      const E = window.PadEngine, r = canvas.getBoundingClientRect();
      if (!look || !E || !r.width) return;
      const k0 = r.width / (E.W / look.z), px = look.x + (clientX - r.left) / k0, py = look.y + (clientY - r.top) / k0;
      look.z = Math.min(6, Math.max(1, look.z * f));
      const k1 = r.width / (E.W / look.z);
      look.x = px - (clientX - r.left) / k1; look.y = py - (clientY - r.top) / k1;
      clampLook();
      draw();
    }
    /** A poll is open (not a draw poll): the student zooms and moves the page themselves; closed: the teacher's view again. */
    function setLook(value) {
      build();
      if (!box) return;
      if (value && !look) look = { ...copy.view };
      if (!value) { look = null; pinch.clear(); }
      lookBar.hidden = !look;
      box.classList.toggle('looking', !!look);
      box.querySelector('.follow-what').textContent = look ? 'Zoom and move the page to see the question' : 'Watching your teacher';
      if (!look) wall.button();
      draw();
    }

    function set(value) {
      on = value;
      build();
      if (!box) { document.addEventListener('DOMContentLoaded', () => set(on), { once: true }); return; }
      box.hidden = !on;
      document.body.classList.toggle('following', on);
      if (!on) { copy.pages.clear(); copy.pid = 0; copy.live = null; }
      wall.button();
      draw();
    }

    function onCopy(msg) {
      if (msg.t === 'mimg') {
        const img = new Image();
        img.onload = () => { copy.images.set(msg.id, img); draw(); };
        img.src = msg.url;
        return;
      }
      if (msg.t === 'mpage') {
        let p = copy.pages.get(msg.pid);
        if (!p || msg.first) { p = { items: new Map(), order: [] }; copy.pages.set(msg.pid, p); }
        for (const [id, it] of msg.add || []) p.items.set(id, it);
        const keep = new Set(msg.ids);
        for (const id of [...p.items.keys()]) if (!keep.has(id)) p.items.delete(id);
        p.order = msg.ids || [];
        p.bg = msg.bg; p.h = msg.h; p.doc = msg.doc;
        copy.pid = msg.pid;
        if (msg.view) copy.view = msg.view;
      } else if (msg.t === 'mlive') {
        copy.live = msg;
      }
      draw();
    }

    function draw() { if (on && !frame) frame = requestAnimationFrame(paint); }

    function paint() {
      frame = 0;
      const E = window.PadEngine;
      if (!on || !canvas || !E) return;
      const p = copy.pages.get(copy.pid);
      waitEl.hidden = !!p;
      // The teacher's view of the page (16:9), as big as fits under the bar.
      const bar = box.querySelector('.follow-bar').offsetHeight;
      const room = look ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--poll-room')) || 0 : 0; // (above the poll's box)
      const aw = innerWidth, ah = innerHeight - bar - room;
      const w = Math.min(aw, ah * E.W / E.H), h = w * E.H / E.W;
      const dpr = devicePixelRatio || 1;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.left = `${(aw - w) / 2}px`;
      canvas.style.top = `${bar + (ah - h) / 2}px`;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!p) return;
      const v = viewNow(), k = canvas.width / (E.W / v.z);
      ctx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
      const pageNow = { bg: p.bg, h: p.h, doc: p.doc, items: p.order.map((id) => p.items.get(id)).filter(Boolean) };
      // The engine draws this board's own pictures: the teacher's, just while drawing here.
      const hooks = E.configure({});
      const boardImage = hooks.image;
      E.configure({ image: (id) => copy.images.get(id) || null });
      try {
        E.renderPage(ctx, pageNow);
        const L = copy.live || {};
        const dark = E.isDark(pageNow);
        if (L.preview) E.drawItem(ctx, L.preview, dark);
        wall.paint(ctx, pageNow.items, k); // the class wall: their own note, outlined and named (here only)
        if (L.eraser) {
          ctx.strokeStyle = dark ? '#fff' : '#555';
          ctx.lineWidth = 1.5 * dpr / k;
          ctx.beginPath();
          ctx.arc(L.eraser[0], L.eraser[1], L.eraser[2], 0, Math.PI * 2);
          ctx.stroke();
        }
      } catch (e) {
        console.warn('Following the teacher: could not draw', e);
      } finally {
        E.configure({ image: boardImage });
      }
    }

    /** Where a point on the teacher's page is on this screen (CSS pixels), or null while not following. */
    function toScreen(x, y) {
      const E = window.PadEngine;
      if (!on || !canvas || !E || !copy.pages.get(copy.pid)) return null;
      const r = canvas.getBoundingClientRect(), v = viewNow(), k = r.width / (E.W / v.z);
      return { x: r.left + (x - v.x) * k, y: r.top + (y - v.y) * k, k, area: r };
    }

    return { set, onCopy, toScreen, setLook, notes, redraw: draw };
  })();

  // ---------- the class wall (StudentClass.Wall.cs): their own sticky note on the teacher's page ----------
  // The PC says which notes are theirs (never whose the others are). On the teacher's page their note is outlined,
  // with their name over it, on this screen only. A tap on it (or My note) opens it big: type, or draw with a pen.
  // Each change goes to the PC, which checks it is their note and puts it on the whiteboard; everyone sees it there.
  // Notice and Wonder: two notes each (kind n, w). A parking lot: + New note posts one (note 'new', once there's
  // something on it; the PC says its id back), up to cap; Delete takes theirs away. They pick each note's color.
  const wall = (() => {
    let state = { on: false, mine: [] };
    let ed = null, cur = null, mode = 'type', color = '#1f2328', ink = [], stroke = null, sendTimer = 0, msgTimer = 0, myBtn = null;
    let fill = '', posting = false, dirty = false, known = new Set();
    const COLORS = ['#1f2328', '#1971c2', '#e03131', '#2f9e44'];
    const FILLS = ['#fff3a3', '#ffd6e7', '#d3eaff', '#d8f5c8', '#ffe0b8'];
    const FILL_NAMES = ['Yellow', 'Pink', 'Blue', 'Green', 'Orange'];
    const mine = () => (state.on ? state.mine || [] : []);
    const lot = () => state.layout === 'lot';
    const roomForMore = () => lot() && mine().length < (state.cap || 5);
    const canWrite = () => !!(state.on && state.writing && (mine().some((n) => !n.hidden) || roomForMore()));
    const kindWord = (n) => (n && n.kind === 'n' ? 'I notice…' : n && n.kind === 'w' ? 'I wonder…' : lot() ? 'Your idea' : 'Your note');

    function set(m) {
      state = m || { on: false, mine: [] };
      if (cur && cur.id === 'new' && posting) { // the note they started is on the wall now: carry on with it
        const made = mine().find((n) => !known.has(n.id));
        if (made) { cur = made; posting = false; if (dirty) later(); }
      }
      if (ed && !ed.hidden) {
        const still = cur && cur.id === 'new' ? cur : mine().find((n) => cur && n.id === cur.id);
        if (!state.on || !state.writing || !still || still.hidden) close(!state.on ? '' : still && still.hidden ? 'Your teacher has hidden your note for now.' : !still ? 'That note is gone from the wall.' : 'Your teacher stopped writing on the wall.');
      }
      button();
      follow.redraw();
    }

    /** My note, in the bar over the teacher's page, while they can write. */
    function button() {
      const bar = document.querySelector('.student-follow .follow-bar');
      if (!bar) return;
      if (!myBtn) {
        myBtn = document.createElement('button');
        myBtn.type = 'button';
        myBtn.className = 'follow-wall';
        myBtn.addEventListener('click', () => {
          if (lot()) { if (roomForMore()) open({ id: 'new', text: '', kind: '' }); else say(`You have ${state.cap || 5} notes. Tap one to change or delete it.`); return; }
          const n = mine().find((x) => !x.hidden);
          if (n) open(n);
        });
        bar.appendChild(myBtn);
      }
      myBtn.textContent = lot() ? '➕ New note' : state.layout === 'nw' ? '✏️ My notes' : '✏️ My note';
      myBtn.hidden = !canWrite() || (lot() && !roomForMore());
      const what = bar.querySelector('.follow-what');
      if (what && !document.querySelector('.student-follow.looking')) what.textContent = !state.on ? 'Watching your teacher' : !canWrite() ? 'Class wall'
        : lot() ? (mine().length ? `Parking lot: ${mine().length} of ${state.cap || 5} notes. Tap one to change it` : 'Parking lot: one idea per note')
          : state.layout === 'nw' ? 'Notice and Wonder: tap your notes to write on them' : 'Class wall: tap your note to write on it';
    }

    /** Over the teacher's page: their own notes outlined, with their name (only here). k: canvas pixels per page unit. */
    function paint(ctx, items, k) {
      if (!state.on) return;
      const E = window.PadEngine, ids = new Map(mine().map((n) => [n.id, n]));
      if (!ids.size) return;
      const dpr = devicePixelRatio || 1, u = dpr / k; // one screen pixel, in page units
      for (const it of items) {
        const n = it && it.wn && ids.get(it.wn);
        if (!n) continue;
        const b = E.bounds(it);
        ctx.save();
        ctx.strokeStyle = '#2f6bff';
        ctx.lineWidth = 3 * u;
        ctx.strokeRect(b.x - 4 * u, b.y - 4 * u, b.w + 8 * u, b.h + 8 * u);
        const label = n.hidden ? 'Your note (hidden by your teacher)' : (state.name ? `${state.name} (you)` : 'Your note') + (n.kind === 'n' ? ' · notice' : n.kind === 'w' ? ' · wonder' : '');
        ctx.font = `700 ${13 * u}px system-ui, sans-serif`;
        const tw = ctx.measureText(label).width, h = 20 * u, y = Math.max(0, b.y - h - 6 * u);
        ctx.fillStyle = '#2f6bff';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(b.x - 4 * u, y, tw + 16 * u, h, 10 * u) : ctx.rect(b.x - 4 * u, y, tw + 16 * u, h);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, b.x + 4 * u, y + h / 2);
        ctx.restore();
      }
    }

    /** A tap on the teacher's page (page units): their note opens. */
    function tap(x, y, items) {
      if (!canWrite()) return false;
      const E = window.PadEngine;
      for (const n of mine()) {
        const it = items.find((i) => i && i.wn === n.id);
        if (!it || n.hidden) continue;
        const b = E.bounds(it);
        if (x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 10 && y <= b.y + b.h + 10) { open(n); return true; }
      }
      return false;
    }

    function build() {
      if (ed) return;
      ed = document.createElement('div');
      ed.className = 'wall-editor';
      ed.hidden = true;
      ed.innerHTML = '<div class="we-card" role="dialog" aria-label="Your note">'
        + '<div class="we-head"><b class="we-kind">Your note</b><span>Only you see your name on it.</span></div>'
        + '<div class="we-paper"><textarea maxlength="280" placeholder="Type here…" aria-label="Your note"></textarea><canvas></canvas></div>'
        + '<div class="we-tools"><span class="we-seg"><button type="button" data-mode="type">Aa Type</button><button type="button" data-mode="draw">✏️ Draw</button></span>'
        + '<span class="we-colors">' + COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" aria-label="Pen color"></button>`).join('') + '</span>'
        + '<button type="button" data-act="undo">↶ Undo</button><button type="button" data-act="wipe">Clear drawing</button>'
        + '<span class="we-fills" aria-label="Note color">' + FILLS.map((c, i) => `<button type="button" data-fill="${c}" style="background:${c}" aria-label="${FILL_NAMES[i]} note" title="${FILL_NAMES[i]} note"></button>`).join('') + '</span>'
        + '<button type="button" data-act="delete" class="we-delete" hidden>🗑 Delete note</button>'
        + '<span class="we-count"></span><button type="button" class="we-done">Done</button></div>'
        + '<p class="we-msg" hidden></p></div>';
      document.body.appendChild(ed);
      const ta = ed.querySelector('textarea'), cv = ed.querySelector('canvas');
      ta.addEventListener('input', () => { count(); later(); });
      for (const b of ed.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
      for (const b of ed.querySelectorAll('[data-color]')) b.addEventListener('click', () => { color = b.dataset.color; setMode('draw'); });
      ed.querySelector('[data-act=undo]').addEventListener('click', () => { ink.pop(); paintInk(); later(); });
      ed.querySelector('[data-act=wipe]').addEventListener('click', () => { ink = []; paintInk(); later(); });
      for (const b of ed.querySelectorAll('[data-fill]')) b.addEventListener('click', () => { fill = b.dataset.fill; paper(); later(); });
      ed.querySelector('[data-act=delete]').addEventListener('click', () => {
        if (cur && cur.id !== 'new' && !posting) send({ t: 'wallWrite', wall: state.id, note: cur.id, delete: true, text: '', ink: [] });
        clearTimeout(sendTimer);
        sendTimer = 0;
        dirty = false;
        close('');
      });
      ed.querySelector('.we-done').addEventListener('click', () => close(''));
      const at = (e) => { const r = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
      cv.addEventListener('pointerdown', (e) => {
        if (mode !== 'draw') return;
        e.preventDefault();
        try { cv.setPointerCapture(e.pointerId); } catch { /* gone */ }
        if (ink.length >= 150) { say('Your drawing is full. Undo or clear some of it.'); return; }
        stroke = { c: color, w: 4, p: at(e) };
        ink.push(stroke);
        paintInk();
      });
      cv.addEventListener('pointermove', (e) => {
        if (!stroke) return;
        const [x, y] = at(e), p = stroke.p;
        if (p.length >= 1500 || Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < 0.004) return;
        p.push(Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000);
        paintInk();
      });
      for (const t of ['pointerup', 'pointercancel']) cv.addEventListener(t, () => { if (stroke) { stroke = null; later(); } });
      addEventListener('resize', () => { if (!ed.hidden) fit(); });
    }

    function setMode(m) {
      mode = m;
      for (const b of ed.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
      for (const b of ed.querySelectorAll('[data-color]')) b.classList.toggle('on', m === 'draw' && b.dataset.color === color);
      ed.classList.toggle('drawing', m === 'draw');
      if (m === 'type') ed.querySelector('textarea').focus();
    }

    function count() { const n = ed.querySelector('textarea').value.length; ed.querySelector('.we-count').textContent = n > 200 ? `${n} / 280` : ''; }

    /** The note as big as fits, square like on the wall, its words at the wall's size. */
    function fit() {
      const paper = ed.querySelector('.we-paper'), size = Math.max(200, Math.min(innerWidth - 48, innerHeight - 190, 560));
      paper.style.width = paper.style.height = `${size}px`;
      const it = follow.notes().find((i) => i && cur && i.wn === cur.id);
      const side = it ? it.w + window.PadEngine.NOTE_PAD * 2 : 308, k = size / side;
      const ta = ed.querySelector('textarea');
      ta.style.fontSize = `${Math.round(((it && it.wz) || 32) * k)}px`;
      ta.style.padding = `${Math.round(window.PadEngine.NOTE_PAD * k)}px`;
      if (!fill) fill = (it && it.fill) || (cur && cur.kind === 'w' ? FILLS[2] : FILLS[0]);
      paper.style.background = fill;
      ed.querySelector('.we-paper').style.background = fill;
      for (const b of ed.querySelectorAll('[data-fill]')) b.classList.toggle('on', b.dataset.fill === fill);
      const cv = ed.querySelector('canvas'), dpr = devicePixelRatio || 1;
      cv.width = cv.height = Math.round(size * dpr);
      paintInk();
    }

    /** The paper in the note's color, and the swatch picked. */
    function paper() {
      ed.querySelector('.we-paper').style.background = fill;
      for (const b of ed.querySelectorAll('[data-fill]')) b.classList.toggle('on', b.dataset.fill === fill);
    }

    function paintInk() {
      const cv = ed.querySelector('canvas'), c = cv.getContext('2d'), s = cv.width;
      c.clearRect(0, 0, s, s);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      for (const st of ink) {
        const p = st.p;
        c.strokeStyle = st.c;
        c.lineWidth = st.w * s / 308;
        c.beginPath();
        c.moveTo(p[0] * s, p[1] * s);
        if (p.length === 2) c.lineTo(p[0] * s + 0.5, p[1] * s);
        for (let i = 2; i + 1 < p.length; i += 2) c.lineTo(p[i] * s, p[i + 1] * s);
        c.stroke();
      }
    }

    function open(n) {
      build();
      cur = n;
      posting = false;
      dirty = false;
      known = new Set(mine().map((x) => x.id));
      const it = follow.notes().find((i) => i && i.wn === n.id);
      ink = it && Array.isArray(it.ink) ? JSON.parse(JSON.stringify(it.ink)) : [];
      fill = n.fill || (it && it.fill) || '';
      ed.querySelector('.we-kind').textContent = n.id === 'new' ? 'A new note: one idea' : kindWord(n);
      ed.querySelector('.we-delete').hidden = !lot();
      const ta = ed.querySelector('textarea');
      ta.placeholder = n.kind === 'n' ? 'I notice…' : n.kind === 'w' ? 'I wonder…' : lot() ? 'One idea or question…' : 'Type here…';
      ta.value = n.text || '';
      ed.querySelector('.we-msg').hidden = true;
      ed.hidden = false;
      document.body.classList.add('wall-writing');
      fit();
      count();
      setMode(ink.length && !ta.value ? 'draw' : 'type');
    }

    function later() { dirty = true; clearTimeout(sendTimer); sendTimer = setTimeout(flush, 700); }
    function flush() {
      clearTimeout(sendTimer);
      sendTimer = 0;
      if (!cur || !state.on) return;
      if (posting) return; // (the new note isn't on the wall yet: this goes when it is)
      const text = ed.querySelector('textarea').value.slice(0, 280);
      // A parking lot note with nothing on it isn't sent (Delete takes one away; a new one waits for words)
      if (lot() && !text.trim() && !ink.length) return;
      dirty = false;
      cur.text = text;
      if (cur.id === 'new') posting = true;
      send({ t: 'wallWrite', wall: state.id, note: cur.id, text, ink, fill: fill || undefined });
    }

    function close(why) {
      if (!ed || ed.hidden) return;
      // Done on a parking lot note they emptied: it goes (no empty boxes on the wall)
      if (!why && lot() && cur && cur.id !== 'new' && !posting && !ed.querySelector('textarea').value.trim() && !ink.length) {
        send({ t: 'wallWrite', wall: state.id, note: cur.id, delete: true, text: '', ink: [] });
        clearTimeout(sendTimer);
        sendTimer = 0;
      }
      if (sendTimer && !why) flush();
      clearTimeout(sendTimer);
      ed.hidden = true;
      document.body.classList.remove('wall-writing');
      cur = null;
      if (why) { status(why); setTimeout(() => status(''), 4000); }
    }

    function say(text) {
      if (!ed || ed.hidden) { status(text); setTimeout(() => status(''), 4000); return; }
      const m = ed.querySelector('.we-msg');
      m.textContent = text;
      m.hidden = false;
      clearTimeout(msgTimer);
      msgTimer = setTimeout(() => { m.hidden = true; }, 5000);
    }

    return { set, paint, tap, say, button };
  })();

  // ---------- a classmate's board, shown to the class by the teacher ----------
  // Over everything (Follow me included) until the teacher stops showing it. The student whose board it is keeps
  // working on it, with a note that it's on show.
  const shown = (() => {
    let box = null, canvas = null, title = null, on = false, msg = null, mineNote = null;
    const images = new Map(); // "key/id" -> Image

    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-shown';
      box.hidden = true;
      box.innerHTML = '<div class="shown-bar"><b class="shown-title"></b><span class="shown-page"></span></div><div class="shown-stage"><canvas></canvas></div>';
      document.body.appendChild(box);
      canvas = box.querySelector('canvas');
      title = box.querySelector('.shown-title');
      addEventListener('resize', draw);
      for (const type of ['keydown', 'paste', 'wheel']) addEventListener(type, (e) => { if (on && !e.target?.closest?.('.student-hand')) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true, passive: false });
    }

    function set(m) {
      build();
      if (!box) { document.addEventListener('DOMContentLoaded', () => set(m), { once: true }); return; }
      note(!!m.mine);
      on = !!m.on;
      box.hidden = !on;
      document.body.classList.toggle('shown-on', on);
      if (!on) { msg = null; return; }
      msg = m;
      title.textContent = m.name ? `${m.name}’s board` : 'A classmate’s board';
      box.querySelector('.shown-page').textContent = m.pages > 1 ? `Page ${m.pageNo} of ${m.pages}` : '';
      const loads = Object.entries(m.images || {}).map(([id, url]) => new Promise((done) => {
        const img = new Image();
        img.onload = img.onerror = done;
        img.src = url;
        images.set(m.key + '/' + id, img);
      }));
      Promise.all(loads).then(draw);
      draw();
    }

    /** Where the teacher is looking on the board on show (a share of its page's height from the top): there too. */
    function scrollTo(y) {
      if (!on || !msg || !canvas || !Number.isFinite(y)) return;
      msg.scroll = y;
      box.querySelector('.shown-stage').scrollTop = y * canvas.offsetHeight;
    }

    /** Their own board is on show: a note, and they keep working. */
    function note(mine) {
      if (!mineNote && mine) {
        mineNote = document.createElement('div');
        mineNote.className = 'student-mine';
        mineNote.textContent = 'Your teacher is showing your board to the class.';
        document.body.appendChild(mineNote);
      }
      if (mineNote) mineNote.hidden = !mine;
    }

    function draw() {
      const E = window.PadEngine;
      if (!on || !msg || !canvas || !E) return;
      const stage = box.querySelector('.shown-stage');
      const p = msg.page || { items: [] };
      const w = Math.max(200, Math.min(stage.clientWidth - 32, (stage.clientHeight - 32) * E.W / E.H));
      const k = w / E.W, h = (p.h || E.H) * k, dpr = devicePixelRatio || 1;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
      // The engine draws this board's own pictures: the classmate's, just while drawing theirs.
      const hooks = E.configure({});
      const boardImage = hooks.image;
      E.configure({ image: (id) => images.get(msg.key + '/' + id) || null });
      try { E.renderPage(ctx, { bg: p.bg || 'white', h: p.h || E.H, doc: p.doc, items: p.items || [] }); }
      catch (e) { console.warn('A classmate’s board: could not draw', e); }
      finally { E.configure({ image: boardImage }); }
      scrollTo(msg.scroll ?? 0);
    }

    /** Where a point on the board on show is on this screen (CSS pixels), or null while none is on show. */
    function toScreen(x, y) {
      const E = window.PadEngine;
      if (!on || !msg || !canvas || !E) return null;
      const r = canvas.getBoundingClientRect(), k = r.width / E.W;
      return { x: r.left + x * k, y: r.top + y * k, k, area: box.querySelector('.shown-stage').getBoundingClientRect() };
    }

    return { set, scrollTo, toScreen };
  })();

  // ---------- the teacher's laser pointer (its looks: PadLaser in engine.js) ----------
  // Over the teacher's board (Follow me) or the board on show, as on the PC: the PC sends where it is on that page.
  const laser = (() => {
    let it = null;
    const where = (x, y, on) => (on === 'shown' ? shown.toScreen(x, y) : follow.toScreen(x, y));
    return { set(m) { if (!it && window.PadLaser) it = window.PadLaser.create({ className: 'student-laser', where }); if (it) it.set(m); } };
  })();

  // ---------- Team boards, view only: the teacher paused this student's drawing (they still see the board, live) ----------
  let viewEl = null, viewing = false;
  addEventListener('keydown', (e) => { if (viewing && !e.target?.closest?.('.student-hand')) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true });
  addEventListener('paste', (e) => { if (viewing && !e.target?.closest?.('.student-hand')) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true });
  function viewOnly(on) {
    viewing = on;
    if (!viewEl && on) {
      viewEl = document.createElement('div');
      viewEl.className = 'team-viewonly';
      viewEl.innerHTML = '<div>View only: your teacher has paused your drawing on the team board. You can still watch it.</div>';
      document.body.appendChild(viewEl);
    }
    if (viewEl) viewEl.hidden = !on;
  }

  // ---------- Team boards: this student's own marks go to the PC one by one (added, changed, erased) ----------
  function ownItems(state) {
    const own = new Map();
    (state && state.pages || []).forEach((p, i) => (p.items || []).forEach((it) => {
      if (!it.by && it.id != null) own.set(String(it.id), { page: i, item: it, json: JSON.stringify(it) });
    }));
    return own;
  }
  function sendTeamOps(msg) {
    if (!teamOwn) return; // the team board hasn't loaded yet
    const now = ownItems(msg.state);
    const ops = [];
    for (const [id, v] of now) {
      const was = teamOwn.get(id);
      if (!was) ops.push({ op: 'add', id, page: v.page, item: v.item });
      else if (was.json !== v.json) ops.push({ op: 'update', id, page: v.page, item: v.item });
    }
    for (const id of teamOwn.keys()) if (!now.has(id)) ops.push({ op: 'erase', id });
    teamOwn = now;
    // The picture of the page they're on, for the teacher's grid: not more than every few seconds (Remote mode data),
    // and the latest one once things go quiet.
    clearTimeout(teamThumbTimer);
    const thumb = Date.now() - teamThumbAt > 5000 ? msg.thumb : undefined;
    if (thumb) teamThumbAt = Date.now();
    else teamThumbTimer = setTimeout(() => { teamThumbAt = Date.now(); send({ t: 'teamOps', ops: [], thumb: msg.thumb, cur: msg.state && msg.state.cur }); }, 5000);
    for (let i = 0; i < ops.length || (i === 0 && thumb); i += 50) send({ t: 'teamOps', ops: ops.slice(i, i + 50), thumb: i === 0 ? thumb : undefined, cur: msg.state && msg.state.cur });
    deliver({ type: 'boardSaved', id: msg.id });
  }

  // ---------- Teams: "Team 3 · Seat 2", and the table with their teammates (tap to open or close) ----------
  const team = (() => {
    let box = null, pill = null, card = null, state = { no: 0 }, closeTimer = 0;

    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-team';
      box.hidden = true;
      box.innerHTML = '<button type="button" class="team-pill" aria-expanded="false"></button><div class="team-pop" hidden></div>';
      document.body.appendChild(box);
      pill = box.querySelector('.team-pill');
      card = box.querySelector('.team-pop');
      pill.addEventListener('click', () => open(card.hidden));
    }

    function open(on) {
      clearTimeout(closeTimer);
      card.hidden = !on;
      pill.setAttribute('aria-expanded', String(on));
    }

    function set(m) {
      // Team boards on or off, or a different team: this page switches boards (their own board waits on the PC).
      const want = m.boards && m.no ? m.no : 0;
      if (want !== teamNo) {
        ended = true; // not "reconnecting" while it switches
        if (window.PADLINK_RTC) location.replace(want ? `board.html?team=${want}${location.hash}` : `board.html${location.hash}`);
        else location.replace(want ? `/student/board?team=${want}` : '/student/board');
        return;
      }
      // Opened by itself only for a new team or seat (not every time the page reloads, e.g. switching to the team board).
      let seen = '';
      try { seen = sessionStorage.getItem('padlink.teamSeen') || ''; sessionStorage.setItem('padlink.teamSeen', m.no ? `${m.no}/${m.seat}` : ''); } catch { /* fine */ }
      const changed = !!m.no && seen !== `${m.no}/${m.seat}`;
      viewOnly(!!(teamNo && m.viewOnly));
      state = m;
      build();
      if (!box) { document.addEventListener('DOMContentLoaded', () => set(m), { once: true }); return; }
      box.hidden = !m.no;
      if (!m.no) { open(false); return; }
      pill.innerHTML = '<b></b><span></span>';
      pill.querySelector('b').textContent = `Team ${m.no}`;
      pill.querySelector('span').textContent = `Seat ${m.seat}`;
      const bySeat = new Map((m.members || []).map((x) => [x.seat, x.name]));
      card.innerHTML = '<p class="team-you"></p><div class="team-table"></div><p class="team-partners"></p>';
      card.querySelector('.team-you').textContent = `You're in team ${m.no}, seat ${m.seat}`;
      const table = card.querySelector('.team-table');
      const seats = [1, 2, 4, 3, ...[...bySeat.keys()].filter((n) => n > 4).sort((a, b) => a - b)];
      for (const n of seats) {
        const d = document.createElement('div');
        d.className = 'team-seat' + (n === m.seat ? ' me' : '') + (bySeat.has(n) ? '' : ' empty') + (n > 4 ? ' extra' : '');
        d.innerHTML = '<b></b><span></span>';
        d.querySelector('b').textContent = n;
        d.querySelector('span').textContent = n === m.seat ? 'You' : bySeat.get(n) || '';
        table.appendChild(d);
      }
      const who = (n) => (n && bySeat.has(n) ? `${bySeat.get(n)} (seat ${n})` : '');
      const parts = [];
      if (who(m.shoulder)) parts.push(`Shoulder partner: ${who(m.shoulder)}`);
      if (who(m.face)) parts.push(`Face partner: ${who(m.face)}`);
      if (m.seat > 4) parts.push('You join seats 1 and 2.');
      card.querySelector('.team-partners').textContent = parts.join(' · ');
      // A new team or seat: open it for a while so they see where to go.
      if (changed) { open(true); closeTimer = setTimeout(() => open(false), 12000); }
    }

    return { set };
  })();

  // ---------- Raise hand: tap to say you need help (the teacher's PC decides about any sound) ----------
  const hand = (() => {
    let box = null, btn = null, form = null, input = null, state = { up: false, allowed: false, note: '' };

    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-hand';
      box.hidden = true;
      box.innerHTML = `
        <form class="hand-note" hidden>
          <label for="handNote">Raise your hand. Add a few words if you like:</label>
          <input id="handNote" maxlength="80" autocomplete="off" placeholder="For example: stuck on question 4">
          <div class="hand-row"><button type="button" class="hand-cancel">Cancel</button><button type="submit" class="hand-go">✋ Raise hand</button></div>
        </form>
        <button type="button" class="hand-btn" aria-pressed="false"></button>`;
      document.body.appendChild(box);
      btn = box.querySelector('.hand-btn');
      form = box.querySelector('.hand-note');
      input = box.querySelector('#handNote');
      btn.addEventListener('click', () => {
        if (state.up) { send({ t: 'hand', up: false }); set({ ...state, up: false, note: '' }); return; }
        form.hidden = !form.hidden;
        if (!form.hidden) { input.value = ''; input.focus(); }
      });
      box.querySelector('.hand-cancel').addEventListener('click', () => { form.hidden = true; });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const note = input.value.trim().slice(0, 80);
        send({ t: 'hand', up: true, note });
        form.hidden = true;
        set({ ...state, up: true, note });
      });
      // Typing a note isn't drawing: keys stay in the box.
      for (const type of ['keydown', 'paste']) input.addEventListener(type, (e) => e.stopPropagation());
      render();
    }

    function set(m) {
      state = { up: !!m.up, allowed: m.allowed !== false, note: m.note || '' };
      build();
      if (!box) { document.addEventListener('DOMContentLoaded', () => set(state), { once: true }); return; }
      render();
    }

    function render() {
      if (!box) return;
      box.hidden = !state.allowed;
      if (!state.allowed) form.hidden = true;
      box.classList.toggle('up', state.up);
      btn.setAttribute('aria-pressed', String(state.up));
      btn.innerHTML = state.up
        ? '<span class="hand-icon">✋</span><span><b>Your hand is up</b><small></small></span><span class="hand-lower">Lower</span>'
        : '<span class="hand-icon">✋</span><b>Raise hand</b>';
      if (state.up) btn.querySelector('small').textContent = state.note ? `“${state.note}”` : 'Your teacher can see it';
    }

    return { set };
  })();

  // ---------- Polls: big answer buttons; tap one, then Lock it in (the screen then hides which answer) ----------
  // They can change it until the poll closes. Neither a tap nor a lock shows the answer to anyone but the teacher;
  // once locked in, this screen shows only that they answered, so a neighbour can't copy it.
  const poll = (() => {
    let box = null, state = null, picking = false, at = 0, tick = 0, results = null, hiddenResults = '';
    let draft = '', draftFor = 0, typedNote = ''; // a typed answer being written (kept while the PC sends updates)
    // Hidden by the student (to see the page behind the question): a small bar at the bottom with the countdown and
    // Show. Their answer, typing or drawing stays as it was. A new poll, or this one closing, opens it again.
    let mini = false;
    /** The top of the card: the question, the countdown and Hide (while the poll is open). */
    const headHtml = () => '<div class="poll-head"><b class="poll-title"></b><span class="poll-head-r">'
      + (state.open && state.leftMs != null ? '<span class="poll-time"></span>' : '')
      + (state.open ? '<button type="button" class="poll-hide" title="Hide the question to see the page. Tap Show to answer." aria-label="Hide the question">Hide <span aria-hidden="true">⌄</span></button>' : '')
      + '</span></div>';
    const isTyped = () => !!state && (state.kind === 'num' || state.kind === 'text' || state.kind === 'long');
    /** Whether what's typed is a number (as the PC reads it: 1,000 · -3.5 · .5 · 3/4). */
    const isNumber = (t) => /^[-+−]?(\d+(\.\d*)?|\.\d+)(\/[-+−]?(\d+(\.\d*)?|\.\d+))?$/.test(t.replace(/[\s,]/g, '')) && !/\/[-+−]?0*(\.0*)?$/.test(t.replace(/[\s,]/g, ''));
    function lockTyped() {
      const inp = box.querySelector('.poll-type');
      const text = (inp ? inp.value : draft).trim();
      if (!text) { typedNote = state.kind === 'num' ? 'Type a number first.' : 'Type your answer first.'; render(); return; }
      if (state.kind === 'num' && !isNumber(text)) { typedNote = 'That isn’t a number. Use digits, like 12, 3.5 or 3/4.'; render(); return; }
      typedNote = '';
      state.locked = true;
      state.mineText = text;
      state.mine = 0;
      picking = false;
      draft = '';
      send({ t: 'pollAnswer', id: state.id, text, lock: true });
      render();
    }

    function build() {
      if (box || !document.body) return;
      box = document.createElement('div');
      box.className = 'student-poll';
      box.hidden = true;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', 'Poll');
      document.body.appendChild(box);
      box.addEventListener('input', (e) => { if (e.target.classList.contains('poll-type')) { draft = e.target.value; draftFor = state ? state.id : 0; if (typedNote) { typedNote = ''; const n = box.querySelector('.poll-type-note'); if (n) n.textContent = ''; } } });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('poll-type') && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); lockTyped(); } }); // (a long answer: Enter is a new line; Ctrl+Enter locks it in)
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !state) return;
        if (b.classList.contains('poll-hide')) { mini = true; render(); return; }
        if (b.classList.contains('poll-unmini')) { mini = false; render(); return; }
        if (b.dataset.choice) choose(Number(b.dataset.choice));
        else if (b.classList.contains('pad-lock')) { const p = padOf(state); if (!p.strokes.length) return; state.locked = true; state.mine = 0; picking = false; p.full = false; send({ t: 'pollAnswer', id: state.id, lock: true, drawing: p.strokes }); render(); }
        else if (b.classList.contains('poll-lock') && isTyped()) lockTyped();
        else if (b.classList.contains('poll-lock')) { state.locked = true; picking = false; send({ t: 'pollAnswer', id: state.id, lock: true }); render(); }
        else if (b.classList.contains('poll-change')) { picking = true; render(); }
        else if (b.classList.contains('poll-keep')) { picking = false; render(); }
      });
    }

    function choose(i) {
      if (!state || !state.open) return;
      state.mine = i;
      state.locked = false;
      picking = false;
      send({ t: 'pollAnswer', id: state.id, choice: i });
      render();
    }

    function set(m) {
      if (!m.id) { state = null; picking = false; render(); return; }
      if (!state || state.id !== m.id) { picking = false; mini = false; }
      // The PC's word is final, except a tap here it hasn't heard about yet (its reply to it comes next).
      state = { ...m };
      at = Date.now();
      build();
      if (!box) { document.addEventListener('DOMContentLoaded', () => set(m), { once: true }); return; }
      render();
    }

    const fmt = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    function clock() {
      const el = box && box.querySelector('.poll-time');
      if (!el || !state || state.leftMs == null) return;
      const left = Math.max(0, state.leftMs - (Date.now() - at));
      el.textContent = `${fmt(left)} left`;
      el.classList.toggle('soon', left <= 10000);
    }

    /** How much of the bottom of the screen the poll's box covers: the page fits above it (their board, or the
     *  teacher's page), so nothing on it is out of reach, and the zoom buttons stay in sight. */
    let room = -1;
    function makeRoom() {
      const r = box && !box.hidden ? box.getBoundingClientRect() : null;
      const px = r && r.height && r.height < innerHeight * 0.6 ? Math.ceil(innerHeight - r.top) : 0; // (a draw poll's big pad: no)
      if (px === room) return;
      room = px;
      document.documentElement.style.setProperty('--poll-room', `${px}px`);
      document.body.classList.toggle('poll-room', px > 0);
      dispatchEvent(new Event('resize')); // the board and the teacher's page fit again
    }
    function render() {
      clearInterval(tick);
      if (!box) return;
      try { renderBox(); } finally { requestAnimationFrame(makeRoom); }
    }
    function renderBox() {
      showResults();
      box.hidden = !state;
      if (!state) return;
      box.className = 'student-poll' + (state.open ? '' : ' closed') + (state.src ? ' self' : ''); // (a page's poll: above the page arrows)
      if (!state.open) mini = false; // closed: the outcome shows
      if (mini) { renderMini(); return; }
      if (state.kind === 'draw' && state.open && !(state.locked && !picking)) { renderDraw(); return; } // a draw poll: the pad
      const head = headHtml();
      if (!state.open) {
        const label = state.mine >= 0 ? (isTyped() ? state.mineText || '' : state.choices[state.mine]) : '';
        box.innerHTML = head + '<p class="poll-msg"></p>';
        title();
        box.querySelector('.poll-msg').textContent = label ? `Your answer: ${label}` : 'You didn’t answer this one.';
        return;
      }
      if (state.locked && state.final) {
        // At their own pace, checked right away: ✓ or the right answer, and the answer is final.
        const right = state.correct >= 0, got = right && state.mine === state.correct;
        box.innerHTML = head + `<div class="poll-locked${right ? (got ? ' got' : ' miss') : ''}"><span class="poll-check">${right && !got ? '✗' : '✓'}</span><span><b></b><small></small></span></div>`;
        const say = (i) => (isTyped() ? (i === state.correct ? state.correctText : state.mineText) || '' : state.choices[i] + (state.texts && state.texts[i] ? `: ${state.texts[i]}` : ''));
        box.querySelector('.poll-locked b').textContent = !right ? 'Answer locked in' : got ? `Correct: ${say(state.correct)}` : `The answer is ${say(state.correct)}`;
        box.querySelector('.poll-locked small').textContent = !right ? 'On to the next page.' : got ? 'Well done. On to the next page.' : `You chose ${say(state.mine)}. On to the next page.`;
        title();
        return;
      }
      if (state.locked && !picking) {
        box.innerHTML = head + '<div class="poll-locked"><span class="poll-check">✓</span><span><b>Answer locked in</b><small></small></span>'
          + '<button type="button" class="poll-change">Change answer</button></div>';
        box.querySelector('.poll-locked small').textContent = state.src ? 'You can change it until your teacher ends this.' : 'You can change it until the poll closes.';
        title();
      } else if (isTyped()) {
        // A number or a few words: type, then Lock it in (Enter works too). Changing starts from an empty box, so a
        // glance gives nothing away; what they were typing stays while the PC sends updates.
        if (draftFor !== state.id) { draft = ''; draftFor = state.id; }
        const had = document.activeElement && document.activeElement.classList.contains('poll-type');
        const num = state.kind === 'num', long = state.kind === 'long';
        box.innerHTML = head + (long
          ? '<div class="poll-typed long"><textarea class="poll-type" rows="5" maxlength="1000" spellcheck="true" aria-label="Your answer"></textarea></div>'
          : `<div class="poll-typed"><input class="poll-type" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${num ? 24 : 60}" inputmode="${num ? 'decimal' : 'text'}" aria-label="${num ? 'Your number' : 'Your answer'}"></div>`)
          + '<p class="poll-type-note" role="status"></p><div class="poll-foot"></div>';
        const inp = box.querySelector('.poll-type');
        inp.value = draft;
        inp.placeholder = num ? 'Type a number' : long ? 'Write your answer (up to 1,000 characters)' : 'Type your answer';
        box.querySelector('.poll-type-note').textContent = typedNote;
        const foot = box.querySelector('.poll-foot');
        foot.innerHTML = (picking ? '<button type="button" class="poll-keep">Keep my answer</button>' : '<span></span>') + '<button type="button" class="poll-lock">Lock it in</button>';
        if (!picking) foot.querySelector('span').textContent = num ? 'Numbers like 12, 3.5 or 3/4.' : long ? `${(inp.value || '').length} / 1,000` : 'A word or a few words.';
        if (long && !picking) inp.addEventListener('input', () => { const sp = foot.querySelector('span'); if (sp) sp.textContent = `${inp.value.length} / 1,000`; });
        if (had || !state.locked) setTimeout(() => { if (box.contains(inp) && document.activeElement !== inp && (had || !('ontouchstart' in window))) inp.focus(); }, 0);
      } else {
        const chosen = picking ? -1 : state.mine; // changing: nothing highlighted, so a glance gives nothing away
        const words = state.texts && state.texts.some((t) => t);
        box.innerHTML = head + `<div class="poll-choices${state.choices.length > 4 ? ' many' : ''}${words ? ' words' : ''}">`
          + order().map((i) => `<button type="button" class="poll-choice${i === chosen ? ' on' : ''}" data-choice="${i}" aria-pressed="${i === chosen}"><b></b><span></span></button>`).join('')
          + '</div><div class="poll-foot"></div>';
        state.choices.forEach((c, i) => {
          const b = box.querySelector(`[data-choice="${i}"]`);
          b.querySelector('b').textContent = c;
          b.querySelector('span').textContent = words ? state.texts[i] || '' : '';
        });
        const foot = box.querySelector('.poll-foot');
        if (picking) foot.innerHTML = '<span>Tap your new answer.</span><button type="button" class="poll-keep">Keep my answer</button>';
        else if (state.mine >= 0) foot.innerHTML = '<span>Tap another to change it.</span><button type="button" class="poll-lock">Lock it in</button>';
        else foot.innerHTML = '<span>Tap your answer, then lock it in.</span>';
      }
      title();
      clock();
      if (state.leftMs != null) tick = setInterval(clock, 250);
    }


    /** Hidden: a small bar with how they stand, the countdown (orange in the last 10 seconds) and Show. */
    function renderMini() {
      box.classList.add('mini');
      const answered = state.kind === 'draw' ? (pads.get(state.id)?.strokes.length || 0) > 0 : state.mine >= 0 || (isTyped() && !!draft.trim());
      const how = state.locked ? '✓ Locked in' : answered ? 'Not locked in yet' : 'Not answered yet';
      box.innerHTML = `<button type="button" class="poll-unmini" title="Show the question"><span class="poll-mini-icon" aria-hidden="true">📊</span><span class="poll-mini-what"></span>${state.leftMs != null ? '<span class="poll-time"></span>' : ''}<span class="poll-mini-open">Show <span aria-hidden="true">⌃</span></span></button>`;
      box.querySelector('.poll-mini-what').textContent = how;
      clock();
      if (state.leftMs != null) tick = setInterval(clock, 250);
    }

    // ---------- a draw poll: a pad in the card (pen, eraser, colours, sizes), on white or a picture of the page ----------
    // The drawing is in page units (1920 wide, like the whiteboard), so it lines up with the page behind it and shows
    // the same on the teacher's screens. One finger, a pen or the mouse draws; two fingers pinch and move; Ctrl + wheel
    // zooms. Full screen grows the pad; − + and Fit zoom.
    const PAGE_W = 1920, PAGE_H = 1080;
    const PAD_COLORS = ['#1f2328', '#1971c2', '#e03131', '#2f9e44'];
    // (A stroke's size is its width on the page, as on the whiteboard: thin 6, thick 14.)
    const pads = new Map(); // poll id -> { strokes, undo, tool, color, size, view, full, bg, bgImages }
    function padOf(st) {
      let p = pads.get(st.id);
      if (!p) {
        p = { strokes: Array.isArray(st.drawing) ? st.drawing : [], undo: [], tool: 'pen', color: PAD_COLORS[0], size: 14, view: { x: 0, y: 0, z: 1 }, full: false, bg: null, bgImages: new Map() };
        pads.set(st.id, p);
      }
      if (st.bg && st.bg.page && !p.bg) {
        p.bg = st.bg.page;
        for (const [id, url] of Object.entries(st.bg.images || {})) { const img = new Image(); img.onload = () => drawPad(); img.src = url; p.bgImages.set(Number(id), img); }
      }
      return p;
    }
    let padCanvas = null, padPointers = new Map(), padStroke = null, padPinch = null;
    function renderDraw() {
      const p = padOf(state);
      box.classList.add('draw');
      box.classList.toggle('full', p.full);
      const head = headHtml();
      box.innerHTML = head
        + `<div class="pad-wrap"><canvas class="pad-c" aria-label="Your drawing"></canvas>${state.wantsBg && !p.bg ? '<p class="pad-wait">Waiting for your teacher’s page…</p>' : ''}</div>`
        + '<div class="pad-tools">'
        + `<button type="button" class="pad-t${p.tool === 'pen' ? ' on' : ''}" data-pad="pen" aria-label="Pen" title="Pen">✏️</button>`
        + `<button type="button" class="pad-t${p.tool === 'eraser' ? ' on' : ''}" data-pad="eraser" aria-label="Eraser" title="Eraser">🧽</button>`
        + PAD_COLORS.map((c) => `<button type="button" class="pad-sw${p.color === c && p.tool === 'pen' ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')
        + `<button type="button" class="pad-t${p.size === 6 ? ' on' : ''}" data-size="6" aria-label="Thin" title="Thin">•</button>`
        + `<button type="button" class="pad-t${p.size === 14 ? ' on' : ''}" data-size="14" aria-label="Thick" title="Thick">⬤</button>`
        + '<button type="button" class="pad-t" data-pad="undo" aria-label="Undo" title="Undo">↶</button>'
        + '<button type="button" class="pad-t" data-pad="clear" title="Clear your drawing">Clear</button>'
        + '<span class="pad-gap"></span>'
        + '<button type="button" class="pad-t" data-pad="out" aria-label="Zoom out" title="Zoom out">−</button>'
        + '<button type="button" class="pad-t" data-pad="in" aria-label="Zoom in" title="Zoom in">+</button>'
        + '<button type="button" class="pad-t" data-pad="fit" title="See the whole page">Fit</button>'
        + `<button type="button" class="pad-t" data-pad="full" aria-label="${p.full ? 'Smaller' : 'Full screen'}" title="${p.full ? 'Smaller' : 'Full screen'}">${p.full ? '⤡' : '⤢'}</button>`
        + `<button type="button" class="poll-lock pad-lock"${p.strokes.length ? '' : ' disabled'}>Lock it in</button>`
        + '</div>';
      title();
      if (!box.querySelector('.poll-title').textContent || box.querySelector('.poll-title').textContent === 'Poll') box.querySelector('.poll-title').textContent = '✏️ Draw your answer';
      padCanvas = box.querySelector('.pad-c');
      padWire(p);
      drawPad(); // sized at once, so a stroke started straight away lands where the finger is
      requestAnimationFrame(() => drawPad());
      clock();
      if (state.leftMs != null) tick = setInterval(clock, 250);
    }
    function padSize() {
      const wrap = padCanvas && padCanvas.parentElement;
      if (!wrap) return { w: 0, h: 0 };
      const w = wrap.clientWidth;
      const maxH = wrap.clientHeight || w * PAGE_H / PAGE_W;
      return { w: Math.min(w, maxH * PAGE_W / PAGE_H), h: Math.min(maxH, w * PAGE_H / PAGE_W) };
    }
    function drawPad() {
      const E = window.PadEngine;
      if (!padCanvas || !state || state.kind !== 'draw' || !E) return;
      const p = padOf(state);
      const { w, h } = padSize();
      if (!w) return;
      const dpr = devicePixelRatio || 1;
      padCanvas.style.width = `${w}px`;
      padCanvas.style.height = `${h}px`;
      if (padCanvas.width !== Math.round(w * dpr)) { padCanvas.width = Math.round(w * dpr); padCanvas.height = Math.round(h * dpr); }
      const g = padCanvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, padCanvas.width, padCanvas.height);
      const k = (padCanvas.width / PAGE_W) * p.view.z;
      g.setTransform(k, 0, 0, k, -p.view.x * k, -p.view.y * k);
      const own = E.configure({}).image;
      E.configure({ image: (id) => p.bgImages.get(id) || null });
      try {
        if (p.bg) E.renderPage(g, { bg: p.bg.bg || 'white', h: p.bg.h || PAGE_H, doc: p.bg.doc, items: p.bg.items || [] });
        for (const s of p.strokes) E.drawItem(g, s, false);
        if (padStroke) E.drawItem(g, padStroke, false);
      } catch (e) { console.warn('Draw poll:', e); } finally { E.configure({ image: own }); }
    }
    function padPoint(e, p) {
      const r = padCanvas.getBoundingClientRect();
      const k = (r.width / PAGE_W) * p.view.z;
      return [p.view.x + (e.clientX - r.left) / k, p.view.y + (e.clientY - r.top) / k];
    }
    function padClamp(p) {
      p.view.z = Math.max(1, Math.min(6, p.view.z));
      const pageH = Math.max(PAGE_H, (p.bg && p.bg.h) || PAGE_H);
      p.view.x = Math.max(0, Math.min(PAGE_W - PAGE_W / p.view.z, p.view.x));
      p.view.y = Math.max(0, Math.min(pageH - PAGE_H / p.view.z, p.view.y));
    }
    function padZoom(p, f, cx = PAGE_W / 2, cy = PAGE_H / 2) {
      // about a point on the page (cx, cy in page units): it stays where it is on the pad
      const z0 = p.view.z, z1 = Math.max(1, Math.min(6, z0 * f));
      p.view.x = cx - (cx - p.view.x) * z0 / z1;
      p.view.y = cy - (cy - p.view.y) * z0 / z1;
      p.view.z = z1;
      padClamp(p);
      drawPad();
    }
    function padErase(p, pt) {
      const r = 24 / p.view.z;
      const before = p.strokes.length;
      const keep = p.strokes.filter((s) => !s.pts.some((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < r));
      if (keep.length !== before) { p.undo.push(p.strokes); p.strokes = keep; drawPad(); padChanged(p); }
    }
    function padChanged(p) {
      const lock = box.querySelector('.pad-lock');
      if (lock) lock.disabled = !p.strokes.length;
    }
    function padWire(p) {
      box.querySelector('.pad-tools').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.color) { p.color = b.dataset.color; p.tool = 'pen'; render(); return; }
        if (b.dataset.size) { p.size = Number(b.dataset.size); render(); return; }
        const what = b.dataset.pad;
        if (what === 'pen' || what === 'eraser') { p.tool = what; render(); }
        else if (what === 'undo') { if (p.undo.length) { p.strokes = p.undo.pop(); drawPad(); padChanged(p); } }
        else if (what === 'clear') { if (p.strokes.length) { p.undo.push(p.strokes); p.strokes = []; drawPad(); padChanged(p); } }
        else if (what === 'in') padZoom(p, 1.5);
        else if (what === 'out') padZoom(p, 1 / 1.5);
        else if (what === 'fit') { p.view = { x: 0, y: 0, z: 1 }; drawPad(); }
        else if (what === 'full') { p.full = !p.full; render(); }
      });
      const c = padCanvas;
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { c.setPointerCapture(e.pointerId); } catch { /* gone */ }
        padPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (padPointers.size === 2) {
          // two fingers: pinch and move (the stroke just begun is dropped)
          padStroke = null;
          const [a, b] = [...padPointers.values()];
          padPinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
          drawPad();
          return;
        }
        if (padPointers.size > 2) return;
        const pt = padPoint(e, p);
        if (p.tool === 'eraser') { padErase(p, pt); padStroke = { erasing: true }; return; }
        padStroke = { type: 'stroke', tool: 'pen', medium: 'pen', color: p.color, size: p.size, pts: [[pt[0], pt[1], e.pressure || 0.5]] };
        drawPad();
      });
      c.addEventListener('pointermove', (e) => {
        if (!padPointers.has(e.pointerId)) return;
        padPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (padPinch && padPointers.size === 2) {
          const [a, b] = [...padPointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const r = c.getBoundingClientRect(), k = (r.width / PAGE_W) * p.view.z;
          p.view.x -= (mx - padPinch.mx) / k;
          p.view.y -= (my - padPinch.my) / k;
          const cx = p.view.x + (mx - r.left) / k, cy = p.view.y + (my - r.top) / k;
          padPinch = { d, mx, my };
          if (padPinch.d0 === undefined) padPinch.d0 = d;
          padZoom(p, d / (padPinch.dPrev || d), cx, cy);
          padPinch.dPrev = d;
          return;
        }
        if (!padStroke) return;
        const pt = padPoint(e, p);
        if (padStroke.erasing) { padErase(p, pt); return; }
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) { const q = padPoint(ev, p); padStroke.pts.push([q[0], q[1], ev.pressure || 0.5]); }
        drawPad();
      });
      const up = (e) => {
        if (!padPointers.delete(e.pointerId)) return;
        if (padPointers.size < 2) padPinch = null;
        if (padStroke && !padStroke.erasing && padPointers.size === 0) {
          if (padStroke.pts.length > 0) { p.undo.push(p.strokes); p.strokes = p.strokes.concat([padStroke]); }
          padChanged(p);
        }
        if (padPointers.size === 0) padStroke = null;
        drawPad();
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey) { const pt = padPoint(e, p); padZoom(p, e.deltaY < 0 ? 1.15 : 1 / 1.15, pt[0], pt[1]); return; }
        const r = c.getBoundingClientRect(), k = (r.width / PAGE_W) * p.view.z;
        p.view.x += e.deltaX / k;
        p.view.y += e.deltaY / k;
        padClamp(p);
        drawPad();
      }, { passive: false });
    }
    addEventListener('resize', () => { if (state && state.kind === 'draw' && padCanvas) drawPad(); });

    /** The head: the question, if the teacher prepared one, or just "Poll". */
    function title() {
      const t = box.querySelector('.poll-title');
      if (t) t.textContent = (state.open ? '' : 'Closed · ') + (state.question || 'Poll');
    }

    /**
     * The order of the buttons: as they are, or (the teacher's choice) shuffled for this student, the same way every
     * time for this poll (a reload doesn't move them). The letters stay on their answers.
     */
    function order() {
      const ids = state.choices.map((_, i) => i);
      if (!state.shuffle) return ids;
      let h = 2166136261;
      for (const ch of `${state.id}:${me.key}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      return ids;
    }

    /** The results the teacher showed: the bars (no names), with their own answer marked. Closable here. */
    function showResults() {
      const r = state && state.results;
      const key = r ? `${state.id}:${r.counts.join(',')}:${r.correct}:${(r.labels || []).join('|')}` : '';
      if (!r || hiddenResults === key) { if (results) results.hidden = true; return; }
      if (!results) {
        results = document.createElement('div');
        results.className = 'poll-screen student-results';
        results.innerHTML = '<div class="poll-card"><p class="poll-eyebrow">Poll results</p><h2></h2><p class="poll-you" hidden></p><div class="poll-chart"></div><button class="poll-done">Close</button></div>';
        document.body.appendChild(results);
        results.querySelector('.poll-done').addEventListener('click', () => { hiddenResults = results.dataset.key; results.hidden = true; });
      }
      results.dataset.key = key;
      results.hidden = false;
      results.querySelector('h2').textContent = `${r.answered} of ${r.total} answered`;
      // The correct answer, if the teacher marked it: and whether theirs was.
      const you = results.querySelector('.poll-you');
      // Typed answers: the PC sends the class's list (without any the teacher hid) and where theirs is in it
      const labels = r.labels || state.choices;
      const mine = r.labels ? r.mine : state.mine;
      const theirs = r.labels ? state.mineText || '' : state.mine >= 0 ? state.choices[state.mine] : '';
      const right = r.correct >= 0 ? labels[r.correct] : '';
      you.hidden = !right;
      you.className = 'poll-you' + (right && mine === r.correct ? ' yes' : '');
      you.textContent = !right ? '' : mine === r.correct ? `✓ You got it: ${right}` : `The correct answer is ${right}` + (theirs ? `. ${r.labels ? 'You answered' : 'You chose'} ${theirs}.` : '.');
      const chart = results.querySelector('.poll-chart');
      chart.textContent = '';
      chart.classList.toggle('typed', !!r.labels);
      chart.classList.toggle('long', state.kind === 'long'); // each answer in full
      labels.forEach((label, i) => {
        const n = r.counts[i] || 0;
        const row = document.createElement('div');
        row.className = 'poll-row' + (i === mine ? ' mine' : '') + (i === r.correct ? ' right' : '');
        row.innerHTML = '<b class="poll-label"></b><div class="poll-track"><div class="poll-fill"></div></div><span class="poll-num"><b></b><small></small></span>';
        row.querySelector('.poll-label').textContent = i === r.correct ? `${label} ✓` : label;
        row.querySelector('.poll-fill').style.width = `${r.answered ? (n / r.answered) * 100 : 0}%`;
        row.querySelector('.poll-num b').textContent = n;
        row.querySelector('.poll-num small').textContent = (i === mine ? 'You · ' : '') + `${r.answered ? Math.round((n / r.answered) * 100) : 0}%`;
        chart.appendChild(row);
      });
    }

    return { set };
  })();

  connect();
})();
