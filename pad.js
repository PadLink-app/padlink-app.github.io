// PadLink pad page: the iPad/iPhone side. Turns Apple Pencil and finger input into input on the PC,
// and shows the PC screen when streaming is on.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const stage = $('#stage');
  const surface = $('#surface');
  const canvas = $('#ink');
  const ctx = canvas.getContext('2d');
  const screenCanvas = $('#screen');
  const screenCtx = screenCanvas.getContext('2d');
  const copyCanvas = $('#boardCopy');
  const copyCtx = copyCanvas.getContext('2d');
  const hint = $('#hint');

  // ---------- constants ----------

  const SCROLL_GAIN = 3;        // wheel units per CSS pixel of finger movement
  const TAP_SLOP = 10;          // CSS px a finger may wobble and still be a tap
  const LONG_PRESS_MS = 550;    // finger held still this long = right-click
  const TWO_TAP_MS = 400;       // two fingers tapped together within this = right-click
  const PINCH_START = 0.12;     // fingers' distance must change by 12% before it counts as a pinch
  const ZOOM_GAIN = 420;        // wheel units per doubling of the finger distance (about 2× zoom on the whiteboard)
  const LEAVE_DELAY = 400;      // ms after lifting the Pencil before telling the PC it left hover range
  const TRAIL_MS = 1200;        // how long local ink feedback stays visible
  const PEN_QUIET_MS = 600;     // fingers are ignored this long after any Pencil activity (palm rejection)
  const TAP_MS = 300;           // light-touch mode: a quick light tap still clicks
  const TAP_MOVE_PX = 12;

  const QUALITY = {
    fast: { scale: 0.6, max: 1280, q: 55, note: 'Smaller picture that uses the least Wi-Fi, so it stays smooth on a weak connection. Small text looks soft.' },
    balanced: { scale: 1, max: 1920, q: 70, note: 'Full iPad resolution with medium detail. Right for most rooms.' },
    sharp: { scale: 1, max: 2560, q: 85, note: 'Most detail and the crispest text, but about twice the data. Can stutter on busy Wi-Fi.' },
  };

  // First byte of each binary message from the PC.
  const FRAME_JPEG = 1, FRAME_H264_KEY = 2;

  // ---------- settings (saved on this device as its defaults) ----------

  // Phones have no Apple Pencil, so there a finger does what the Pencil does (move, click, drag, draw).
  // iPads keep "tap and scroll" so a hand resting next to the Pencil can't draw. (iPadOS Safari reports itself as
  // a Mac, so only phones match here.)
  const isPhone = /iPhone|iPod/.test(navigator.userAgent) || (/Android/.test(navigator.userAgent) && /Mobile/.test(navigator.userAgent));

  const DEFAULTS = { fingers: isPhone ? 'pencil' : 'touch', fingersChosen: false, light: true, firmness: 0.3, quality: 'balanced', stream: false, barHidden: false, laserStyle: 'dot', laserColor: '#ff2828', pcPinch: false, follow: true, boardOnly: true, nativeBoard: true };
  const settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('padlink.settings') || '{}')); } catch { /* private mode */ }
  if (!QUALITY[settings.quality]) settings.quality = DEFAULTS.quality;
  // Only keep a finger choice someone actually made: older versions saved the iPad default on phones too.
  if (!settings.fingersChosen || !['touch', 'pencil', 'off'].includes(settings.fingers)) settings.fingers = DEFAULTS.fingers;

  function saveSetting(key, value) {
    settings[key] = value;
    try { localStorage.setItem('padlink.settings', JSON.stringify(settings)); } catch { /* private mode */ }
  }

  // ---------- which PC ----------
  // The PC's own page (served by PadLink): the PC is where this page came from, as always. PadLink Go (the iPad app on
  // PadLink's website, stage 8) loads this same page and says which paired PC to control, before this script runs:
  //   window.PADLINK_HOST = { base: 'https://….devtunnels.ms', deviceKey, saveKey(key), forget(), back() }
  // Every address below goes through pcUrl(), so the page works the same either way.
  const host = window.PADLINK_HOST || null;
  const PC = (host && host.base ? host.base : location.origin).replace(/\/+$/, '');
  const pcUrl = (path) => PC + path;
  const pcOrigin = new URL(PC).origin;

  const store = {
    get(k) { try { return localStorage.getItem('padlink.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('padlink.' + k, v); } catch { /* private mode */ } },
    remove(k) { try { localStorage.removeItem('padlink.' + k); } catch { /* private mode */ } },
  };

  /** A short message at the bottom of the screen. */
  let noticeTimer = 0;
  function notice(text, ms = 5000) {
    const el = document.querySelector('#notice');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- state ----------

  let token = host ? '' : (new URLSearchParams(location.search).get('t') || '').replace(/\s/g, '').toUpperCase();
  let ws = null;
  let reconnectDelay = 500;
  let aspect = 16 / 9;
  let pcPage = null; // the board's page on the PC screen (fractions), as the PC last said (see applyCrop)
  let crop = null;   // the part of the screen shown as the whole picture: the page, or null for the whole screen
  let rect = surface.getBoundingClientRect();
  let tool = 'pen';             // 'pen' | 'eraser' | 'right' | 'laser'
  let targetKind = 'mouse';     // what the Pencil acts as on the PC right now ('pen' in drawing apps)
  let targetApp = null;
  let connected = false;         // allowed by the PC and receiving (the PC says hello once it allows this device)
  let halted = false;            // turned away or disconnected on purpose: don't reconnect by ourselves
  let latency = null;
  let pcName = '';
  let streaming = settings.stream;

  const laserOn = () => tool === 'laser';

  // ---------- connection ----------

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /** Pencil events go to the PC as pen/mouse input, or as laser-pointer moves when the laser is on. */
  function sendPen(e, pts) {
    if (!laserOn()) { send(pts ? { t: 'pen', e, pts } : { t: 'pen', e }); return; }
    const laserEvent = { down: 'draw', move: 'draw', up: 'move', hover: 'move' }[e] || 'off';
    const look = { style: settings.laserStyle, color: settings.laserColor }; // dot, light saber or spotlight, and its color
    send(laserEvent === 'off' ? { t: 'laser', e: 'off', ...look } : { t: 'laser', e: laserEvent, pts: pts.map((p) => [p[0], p[1]]), ...look });
  }

  // A device that paired once gets its own key from the PC ("d"). It's kept in this page's address, so a Home Screen
  // shortcut reconnects every day without a new code, and in this browser's storage as a backup.
  // In PadLink Go, the app keeps each PC's key (one per paired PC) and hands this page the one for this PC.
  let deviceKey = host ? (host.deviceKey || '') : new URLSearchParams(location.search).get('d') || store.get('device') || '';
  function saveDeviceKey(key) {
    deviceKey = key;
    if (host) { if (host.saveKey) host.saveKey(key); } else store.set('device', key);
  }
  function forgetDeviceKey() {
    deviceKey = '';
    if (host) { if (host.forget) host.forget(); } else store.remove('device');
  }
  /** Keeps the page's own address current (the PC's page only: a Home Screen shortcut reconnects with it). */
  function rememberAddress() { if (!host) history.replaceState(null, '', pagePath()); }

  function authQuery() {
    const q = [];
    if (token) q.push('t=' + encodeURIComponent(token));
    if (deviceKey) q.push('d=' + encodeURIComponent(deviceKey));
    return q.join('&');
  }
  const pagePath = () => (deviceKey ? '/?d=' + encodeURIComponent(deviceKey) : '/?t=' + encodeURIComponent(token));

  async function start() {
    if (!token && !deviceKey) return showPair('');
    let status;
    try {
      status = (await fetch(pcUrl('/check?' + authQuery()), { cache: 'no-store' })).status;
    } catch {
      setConnection('PC not reachable, retrying…', 'bad');
      setTimeout(start, 2000);
      return;
    }
    if (status === 200) {
      rememberAddress();
      // Only devices that finished the HD setup page try HTTPS. Others (like a school PC behind a web filter
      // that answers for any address) would otherwise get sent to a page the filter blocks.
      if (!host && location.protocol === 'http:' && store.get('https') === '1' && await upgradeToHttps()) return;
      $('#hd').hidden = window.isSecureContext; // already able to use H.264
      $('#hd').href = pcUrl('/setup?' + authQuery());
      connect();
    } else if (status === 403 && deviceKey && !token) {
      // This device was forgotten on the PC (or it's a different PC): pair again with the code.
      forgetDeviceKey();
      if (host && host.back) { host.back('forgotten'); return; }
      showPair('This device needs pairing again: scan the QR code on the PC, or type the code shown there.');
    } else {
      showPair(status === 429 ? 'Too many wrong codes. Wait a minute and try again.' : 'That code isn’t valid (a new one may have been made on the PC).');
    }
  }

  /** If this iPad already trusts the PC's certificate, switch to the HTTPS page (needed for H.264 video). */
  async function upgradeToHttps() {
    try {
      const { httpsPort } = await (await fetch('/info', { cache: 'no-store' })).json();
      const base = `https://${location.hostname}:${httpsPort}`;
      // Must be a real PadLink reply: school web filters answer for unreachable sites with their own pages.
      const probe = fetch(base + '/ping', { mode: 'cors', cache: 'no-store' }).then((r) => r.json());
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500));
      const reply = await Promise.race([probe, timeout]);
      if (!reply || reply.padlink !== true) return false;
      location.replace(base + pagePath());
      return true;
    } catch {
      return false; // not trusted (yet): stay on HTTP with JPEG streaming
    }
  }

  function connect() {
    const pc = new URL(PC);
    ws = new WebSocket(`${pc.protocol === 'https:' ? 'wss' : 'ws'}://${pc.host}/ws?${authQuery()}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      reconnectDelay = 500;
      setConnection('Waiting for the PC…', 'warn');
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { handleMessage(JSON.parse(e.data)); return; }
      // [kind][flags][view seq][view x, y, width, height][picture]: which part of the PC screen the picture shows.
      const kind = new Uint8Array(e.data, 0, 1)[0];
      const head2 = new DataView(e.data, 0, 20);
      const tag = { followed: (head2.getUint8(1) & 1) === 1, seq: head2.getUint16(2, true), x: head2.getFloat32(4, true), y: head2.getFloat32(8, true), w: head2.getFloat32(12, true), h: head2.getFloat32(16, true) };
      const payload = new Uint8Array(e.data, 20);
      if (kind === FRAME_JPEG) showJpeg(payload, tag);
      else decodeH264(kind === FRAME_H264_KEY, payload, tag);
    };
    ws.onclose = () => {
      ws = null;
      connected = false;
      latency = null;
      closeDecoder();
      abortInput();
      clearHeld();
      if (halted) { setConnection('Not connected', 'bad'); return; }
      $('#gate').hidden = true; // a PIN from this connection is no longer valid
      setConnection('Reconnecting…', 'bad');
      setTimeout(start, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
  }

  function handleMessage(msg) {
    if (msg.t === 'hello') {
      pcName = msg.host || '';
      if (!connected) {
        // The PC allowed this device (it only says hello then): start sending input and video.
        connected = true;
        $('#gate').hidden = true;
        setConnection('Connected', 'good');
        // The PC's own page: PadLink Go now does all this too. Once, until dismissed (not inside PadLink Go itself).
        if (!host && store.get('goNote') !== 'no') setTimeout(() => { if (connected) $('#goNote').hidden = false; }, 1500);
        updateToolChip();
        send({ t: 'mode', m: laserOn() ? 'pen' : tool });
        sendStream();
        if (view.z > 1 || crop) sendView(); // reconnected while zoomed in (or showing just the page): the PC starts from the whole screen
      }
      pcPage = msg.page || null;
      applyCrop();
      if (nativeActive) askForCopy(); // a fresh copy after a reconnect
      const sel = $('#monitor');
      sel.innerHTML = '';
      for (const m of msg.monitors) {
        const opt = document.createElement('option');
        opt.value = m.i;
        opt.textContent = m.name;
        opt.title = `${m.w}×${m.h}`;
        sel.appendChild(opt);
      }
      sel.value = msg.monitor;
      $('#monitorRow').hidden = msg.monitors.length < 2;
      $('#routing').value = msg.routing;
      setBoardButton(!!msg.board);
      const mon = msg.monitors.find((m) => m.i === msg.monitor);
      if (mon && Math.abs(mon.w / mon.h - aspect) > 0.001) {
        aspect = mon.w / mon.h;
        layout();
      }
      updateStatusText();
    } else if (msg.t === 'codec') {
      if (msg.codec === 'jpeg') {
        h264Failed = true; // the PC has no H.264 encoder: stay on pictures
        console.warn('H.264 unavailable on the PC:', msg.error);
      } else {
        setupDecoder(msg);
      }
      updateVideoText();
    } else if (msg.t === 'target') {
      targetKind = msg.kind;
      targetApp = msg.app;
      $('#setTarget').textContent = (msg.kind === 'pen' ? 'Pen' : 'Mouse') + (msg.app ? ` · ${msg.app}` : '');
      updateToolChip();
    } else if (msg.t === 'device') {
      // First pairing: remember this device. Its link now works every day without a code.
      saveDeviceKey(msg.key);
      rememberAddress();
      if (!host) notice(navigator.standalone
        ? 'This device is remembered: it reconnects by itself from now on.'
        : 'This device is remembered. Tip: Share → Add to Home Screen, and PadLink opens with one tap every day.', 9000);
    } else if (msg.t === 'board') {
      setBoardButton(msg.open);
    } else if (msg.t === 'mready') {
      if (nativeActive) askForCopy(); // the PC whiteboard (re)loaded: its copy from the start
    } else if (msg.t === 'mpage' || msg.t === 'mimg' || msg.t === 'mlive') {
      onCopy(msg); // the board's own copy, drawn here
    } else if (msg.t === 'crop') {
      pcPage = msg.page || null;
      applyCrop();
    } else if (msg.t === 'wbstate') {
      onWbState(msg.s);
    } else if (msg.t === 'pagethumbs') {
      onPageThumbs(msg);
    } else if (msg.t === 'boards') {
      onBoards(msg);
    } else if (msg.t === 'goLink') {
      onGoLink(msg);
    } else if (msg.t === 'drive') {
      onDrive(msg);
    } else if (msg.t === 'timer' || msg.t === 'rosters' || msg.t === 'picked' || msg.t === 'students' || msg.t === 'handChime') {
      classPanel.onMessage(msg);
    } else if (msg.t === 'notice') {
      notice(msg.text);
    } else if (msg.t === 'approve') {
      showGate('Allow on the PC', msg.pin,
        'The PC is showing a number too. If it matches, click Allow there. ' +
        'This is needed once each time PadLink starts, so only someone at the PC can let a device in.', false);
    } else if (msg.t === 'denied' || msg.t === 'bye') {
      turnedAway(msg);
    } else if (msg.t === 'pong') {
      if (!connected) return;
      latency = Math.round(performance.now() - msg.c);
      setConnection(`Connected · ${latency} ms`, latency > 250 ? 'warn' : 'good');
    }
  }

  setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

  function setConnection(text, state) {
    const conn = $('#conn');
    conn.className = 'conn pill ' + state;
    $('#connText').textContent = text;
    conn.title = text;
    updateStatusText();
  }

  function updateStatusText() {
    $('#setStatus').textContent = connected
      ? `Connected${pcName ? ' to ' + pcName : ''}${latency != null ? ` · ${latency} ms` : ''}`
      : $('#connText').textContent;
  }

  const GATE_MESSAGES = {
    declined: ['Not allowed', 'The PC chose “Not now”.'],
    blocked: ['Blocked', 'This device was blocked on the PC.'],
    timeout: ['No answer', 'Nobody clicked Allow on the PC within 2 minutes.'],
    replaced: ['Another device asked', 'Another device asked to connect at the same time, so the PC is showing its number instead.'],
    cooldown: ['Blocked for now', 'The PC blocked this device a few minutes ago. Try again later.'],
    busy: ['Too many tries', 'Wait a minute, then try again.'],
    disconnected: ['Disconnected', 'The PC disconnected this device. Connecting again needs Allow on the PC.'],
    took: ['Another device took over', 'Another device is controlling the PC now. Connect again to take control back.'],
    forgotten: ['Forgotten on the PC', 'This device was removed from the PC’s remembered devices. Scan the QR code on the PC to pair again.'],
  };

  /** The PC refused this device or ended its session: say why and wait for the user instead of reconnecting. */
  function turnedAway(msg) {
    halted = true;
    const reason = msg.t === 'bye' && msg.reason === 'replaced' ? 'took' : msg.reason;
    if (msg.forget || reason === 'forgotten') {
      token = '';
      forgetDeviceKey();
      if (!host) history.replaceState(null, '', '/');
    }
    const [title, text] = GATE_MESSAGES[reason] || ['Not connected', 'The PC ended the connection.'];
    const forgotten = !deviceKey && !token;
    showGate(title, '', text + (msg.forget ? ' It was also forgotten: scan the QR code on the PC to pair again.' : ''), true,
      forgotten ? 'Pair again' : 'Connect again');
  }

  function showGate(title, pin, text, retry, retryLabel = 'Connect again') {
    $('#pair').hidden = true;
    $('#gate').hidden = false;
    $('#gateTitle').textContent = title;
    $('#gatePin').textContent = pin;
    $('#gateText').textContent = text;
    $('#gateRetry').hidden = !retry;
    $('#gateRetry').textContent = retryLabel;
    setConnection(pin ? 'Waiting for the PC…' : 'Not connected', pin ? 'warn' : 'bad');
  }

  $('#gateRetry').addEventListener('click', () => {
    if (host && !deviceKey) { host.back('forgotten'); return; } // PadLink Go pairs again from its boards list
    halted = false;
    $('#gate').hidden = true;
    start();
  });

  function showPair(error) {
    $('#gate').hidden = true;
    $('#pair').hidden = false;
    $('#pairError').textContent = error;
    setConnection('Not paired', 'bad');
    const input = $('#code');
    input.value = '';
    input.focus();
  }

  $('#pairForm').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('#code').value.replace(/\s/g, '').toUpperCase();
    $('#pair').hidden = true;
    start();
  });

  // ---------- screen stream ----------

  // H.264 needs WebCodecs, which Safari only enables on HTTPS pages (see /setup).
  let h264Failed = false;
  const canH264 = () => window.isSecureContext && 'VideoDecoder' in window && !h264Failed;

  function sendStream() {
    updateNative();
    const qs = QUALITY[settings.quality];
    const px = rect.width * (window.devicePixelRatio || 1) * qs.scale;
    send({
      t: 'stream',
      on: streaming && !nativeActive, // the whiteboard drawn here needs no video
      w: Math.round(Math.min(qs.max, Math.max(320, px))),
      q: qs.q,
      codec: canH264() ? 'h264' : 'jpeg',
    });
    surface.classList.toggle('streaming', streaming);
    $('#streamBtn').classList.toggle('on', streaming);
    $('#moreStream').classList.toggle('on', streaming);
    $('#streamToggle').checked = streaming;
    updateVideoText();
  }

  function setStreaming(on) {
    streaming = on;
    saveSetting('stream', on);
    sendStream();
    if (!on && view.z > 1) resetView();
    updateViewBar();
  }

  function updateVideoText() {
    $('#videoKind').textContent = !streaming ? 'Off' : canH264() ? 'HD (H.264)' : 'Basic (pictures)';
  }

  // ---- H.264 (WebCodecs) ----

  let decoder = null;
  let needKey = true;
  let frameNo = 0;
  let ackPending = false;

  /** Tell the PC we're ready for the next frame (once per frame). */
  function ackFrame() {
    if (!ackPending) return;
    ackPending = false;
    send({ t: 'ack' });
  }

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
  }

  function setupDecoder(msg) {
    closeDecoder();
    decoder = new VideoDecoder({
      output: (frame) => {
        const tag = frameTags.get(frame.timestamp);
        frameTags.delete(frame.timestamp);
        showFrame(frame, frame.displayWidth, frame.displayHeight, tag);
        frame.close();
        ackFrame();
      },
      error: (err) => {
        console.warn('Video decoder error', err);
        closeDecoder();
        needKey = true;
        send({ t: 'keyframe' });
        ackFrame();
      },
    });
    decoder.configure({
      codec: msg.codec,
      codedWidth: msg.w,
      codedHeight: msg.h,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    });
    needKey = true;
  }

  const frameTags = new Map(); // decoder timestamp -> the view that frame shows

  function decodeH264(isKey, data, tag) {
    ackPending = true;
    if (!decoder || decoder.state !== 'configured' || (needKey && !isKey)) {
      send({ t: 'keyframe' }); // joined mid-stream or recovering: ask for a fresh start
      ackFrame();
      return;
    }
    needKey = false;
    try {
      const timestamp = frameNo++ * 33333;
      frameTags.set(timestamp, tag);
      if (frameTags.size > 30) frameTags.delete(frameTags.keys().next().value);
      decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data }));
    } catch (err) {
      console.warn('decode failed', err);
      needKey = true;
      send({ t: 'keyframe' });
      ackFrame();
      return;
    }
    // Some decoders hold a frame back until the next one arrives; never let that stall the stream.
    setTimeout(ackFrame, 60);
  }

  // ---- JPEG (works on plain HTTP) ----

  async function showJpeg(bytes, tag) {
    try {
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      if (window.createImageBitmap) {
        const bmp = await createImageBitmap(blob);
        showFrame(bmp, bmp.width, bmp.height, tag);
        bmp.close?.();
      } else {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await img.decode();
        showFrame(img, img.naturalWidth, img.naturalHeight, tag);
        URL.revokeObjectURL(url);
      }
    } catch { /* drop a bad frame */ }
    send({ t: 'ack' }); // ready for the next frame
  }

  // ---------- toolbar ----------

  function setTool(t) {
    if (stroke) endStroke(stroke.last); // finish whatever was in progress the old way
    if (laserOn() || t === 'laser') sendPen('leave');
    tool = t;
    $$('[data-tool]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === t);
      b.setAttribute('aria-checked', b.dataset.tool === t);
    });
    if (t !== 'laser') send({ t: 'mode', m: t });
    else send({ t: 'mode', m: 'pen' });
    updateToolChip();
    if (wbOn) renderWb();
  }

  /** The pill at the top left: which Pencil tool is on, and what it is on the PC right now (pen or mouse, in which app). */
  function updateToolChip() {
    const names = { pen: 'Pen', eraser: 'Eraser', right: 'Right-click', laser: 'Laser pointer' };
    const chip = $('#toolChip');
    chip.dataset.current = tool; // not data-tool: that would make the pill look like a tool button
    $('#toolChipName').textContent = names[tool] || 'Pen';
    $('#toolChipTarget').textContent = tool === 'laser' || !connected ? ''
      : ` · ${targetKind === 'pen' ? 'pen' : 'mouse'}${targetApp ? ' in ' + targetApp : ''}`;
  }
  $$('[data-tool]').forEach((b) => b.addEventListener('click', (e) => {
    // Tap the laser again (once it's on) for its look: dot, light saber or spotlight, and the color.
    if (b.dataset.tool === 'laser' && tool === 'laser') { e.stopPropagation(); openLaserPop($('#laserPop').hidden); return; }
    setTool(b.dataset.tool);
  }));

  // ---------- laser options ----------
  const LASER_COLORS = ['#ff2828', '#ff8a1c', '#facc15', '#22c55e', '#2f6bff', '#a855f7', '#ec4899', '#ffffff'];
  function renderLaserPop() {
    for (const b of $$('[data-lstyle]')) b.classList.toggle('on', b.dataset.lstyle === settings.laserStyle);
    const box = $('#laserColors');
    if (!box.children.length) {
      for (const c of LASER_COLORS) {
        const b = document.createElement('button');
        b.className = 'lswatch';
        b.dataset.color = c;
        b.style.background = c;
        b.setAttribute('aria-label', 'Laser color ' + c);
        b.addEventListener('click', () => { saveSetting('laserColor', c); renderLaserPop(); });
        box.appendChild(b);
      }
    }
    for (const b of box.children) b.classList.toggle('on', b.dataset.color === settings.laserColor);
  }
  /** The button the laser options open from: the Laser tool, or in whiteboard mode its rail button or (phone) the dock button. */
  const laserAnchor = () => (!wbOn ? $('[data-tool="laser"]') : compact() ? $('[data-wb="more"]') : $('[data-wb="laser"]'));
  function openLaserPop(open) {
    const pop = $('#laserPop');
    pop.hidden = !open;
    if (!open) return;
    renderLaserPop();
    // Beside the laser button (or above it, when the tools are a dock at the bottom).
    const anchor = laserAnchor();
    const r = anchor.getBoundingClientRect();
    const bar = (anchor.closest('.seg') || anchor).getBoundingClientRect();
    const dock = bar.width > bar.height; // a dock along the bottom (phone), not a rail down the side
    pop.style.right = 'auto';
    pop.style.left = `${Math.max(8, Math.min(dock ? r.left + r.width / 2 - pop.offsetWidth / 2 : r.right + 12, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${dock ? r.top - pop.offsetHeight - 12 : Math.max(8, Math.min(r.top - 20, innerHeight - pop.offsetHeight - 8))}px`;
  }
  $$('[data-lstyle]').forEach((b) => b.addEventListener('click', () => { saveSetting('laserStyle', b.dataset.lstyle); renderLaserPop(); }));
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#laserPop');
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.('[data-tool="laser"], [data-wb="laser"], [data-wb="more"]')) pop.hidden = true;
  }, true);

  $$('[data-key]').forEach((b) => b.addEventListener('click', () => send({ t: 'key', combo: b.dataset.key })));

  $$('[data-hold]').forEach((b) => b.addEventListener('click', () => {
    const down = !b.classList.contains('on');
    b.classList.toggle('on', down);
    send({ t: 'hold', key: b.dataset.hold, down });
    updateHeldBadge();
  }));

  function clearHeld() {
    $$('[data-hold].on').forEach((b) => b.classList.remove('on'));
    updateHeldBadge();
  }

  function updateHeldBadge() {
    const n = $$('[data-hold].on').length;
    const badge = $('#heldBadge');
    badge.hidden = n === 0;
    badge.textContent = n;
  }

  // Keys pop-up: opens under its button, closes when tapping anywhere else.
  const keysPop = $('#keysPop');
  function openKeys(open) {
    keysPop.hidden = !open;
    $('#keysBtn').classList.toggle('on', open);
  }
  $('#keysBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openKeys(keysPop.hidden);
  });
  document.addEventListener('pointerdown', (e) => {
    if (keysPop.hidden || keysPop.contains(e.target) || $('#keysBtn').contains(e.target)) return;
    keysPop.hidden = true;
    $('#keysBtn').classList.remove('on');
  }, true);

  // Type on the PC: whatever has focus there gets the text (e.g. the whiteboard's web-address box).
  function typeOnPc(enter) {
    const input = $('#typeText');
    const text = input.value;
    if (!text && !enter) return;
    send({ t: 'type', text, enter });
    input.value = '';
    input.focus(); // keep the keyboard up for more typing
  }
  $('#typeForm').addEventListener('submit', (e) => { e.preventDefault(); typeOnPc(false); });
  $('#typeEnter').addEventListener('click', () => typeOnPc(true));

  $('#streamBtn').addEventListener('click', () => setStreaming(!streaming));

  /** Blue while the whiteboard is open on the PC (the PC reports it, so it's right however it was opened). */
  function setBoardButton(open) {
    const btn = $('#boardBtn');
    btn.classList.toggle('on', open);
    btn.title = open ? 'Close the whiteboard on the PC' : 'Open the whiteboard on the PC';
    btn.setAttribute('aria-pressed', open);
    setWbMode(open);
  }

  // ---------- whiteboard mode ----------
  // While the whiteboard is open on the PC, the toolbar shows the whiteboard's own tools (select, pen and its types,
  // highlighter, shapes, eraser, colors, sizes, Parts, pages) instead of Pen / Eraser / Right-click / Laser. Taps here
  // go to the board as 'wb' messages; the board reports every change back ('wbstate'), whichever side it was made on.
  // The Pencil stays a pen: what it does on the board is the board's tool.

  const WB_SHAPES = new Set(['line', 'arrow', 'darrow', 'numline', 'axes', 'rect', 'ellipse', 'triangle', 'rtriangle', 'pentagon', 'hexagon', 'polygon', 'fcircle', 'fbar']);
  const WB_PARTS = new Set(['fcircle', 'fbar', 'numline', 'axes', 'polygon']); // polygon: its sides
  const WB_INK_TOOLS = new Set(['pen', 'highlighter', 'shapes', 'eraser']); // tools a stray finger tap would mark with
  const WB_NAMES = { select: 'Select', pen: 'Pen', highlighter: 'Highlighter', shapes: 'Shapes', eraser: 'Eraser', text: 'Text', math: 'Math', note: 'Sticky note' };
  const WB_SHAPE_NAMES = { line: 'Line', arrow: 'Arrow', darrow: 'Double arrow', numline: 'Number line', axes: 'Axes', rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', rtriangle: 'Right triangle', pentagon: 'Pentagon', hexagon: 'Hexagon', polygon: 'Polygon', fcircle: 'Fraction circle', fbar: 'Fraction bar' };
  // Until the board reports in: the board's own starting tools.
  let wb = {
    tool: 'pen', lastShape: 'rect',
    pen: { color: '#1f2328', size: 1, medium: 'pen' }, highlighter: { color: '#ffe066', size: 1 },
    shape: { color: '#1971c2', size: 1, parts: { fcircle: 4, fbar: 4, numline: 10, axes: 5, polygon: 8 }, frac: false }, eraser: { size: 1 },
    note: { color: '#fff3a3' },
    sel: null, page: 1, pages: 1, zoomed: false, canUndo: false, canRedo: false,
    palettes: { pen: ['#1f2328', '#ffffff', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#7048e8', '#fcc419'], highlighter: ['#ffe066', '#8ce99a', '#ffa8d4', '#74c0fc', '#ffc078'], note: ['#fff3a3', '#ffd1e3', '#c9f2c7', '#cfe6ff', '#ffd9b0', '#e5d9ff'] },
  };
  let wbOn = false;          // whiteboard open on the PC: whiteboard mode
  let wbSheetFor = null;     // phone: which tool's options sheet is open (null = closed)
  let wbTucked = false;      // iPad: options panel tucked away by tapping the active tool again
  let selAsked = false;      // iPad: Select's panel with nothing selected (Select all, Add to selection) only when asked for
  let toolBeforeWb = 'pen';  // the Pencil tool to go back to when the whiteboard closes

  /** Phone-sized screen: a dock and sheets instead of the rail and side panel. */
  const compact = () => matchMedia('(max-width: 700px), (max-height: 560px)').matches;
  const wbGroup = (t) => (WB_SHAPES.has(t) ? 'shapes' : t);
  const wbSettingFor = (g) => ({ pen: wb.pen, highlighter: wb.highlighter, shapes: wb.shape, eraser: wb.eraser, note: wb.note })[g] || null;
  /** The board tool a tap in a tool's options means (Shapes: the shape that's on, or the one used last). */
  const wbToolFor = (g) => (g === 'shapes' ? (WB_SHAPES.has(wb.tool) ? wb.tool : wb.lastShape) : g);

  function setWbMode(on) {
    if (on === wbOn) return;
    wbOn = on;
    document.body.classList.toggle('wb', on);
    if (on) {
      toolBeforeWb = tool;
      if (tool !== 'pen') setTool('pen'); // the Pencil draws; the board's tool decides with what
      wbTucked = false;
      selAsked = false; // opening the whiteboard on Select shows just the board, not an empty Select panel
      if (compact() && !streaming) setStreaming(true); // a phone has to see the board to use it
    } else {
      wbSheetFor = null;
      $('#wbMore').hidden = true;
      $('#wbAdd').hidden = true;
      $('#wbPageMenu').hidden = true;
      $('#laserPop').hidden = true;
      closeText();
      // The laser goes off with the whiteboard (setTool sends the 'off'); otherwise back to the Pencil tool from before.
      const back = toolBeforeWb === 'laser' ? 'pen' : toolBeforeWb;
      if (tool !== back) setTool(back);
    }
    renderWb();
    applyCrop();
    layout();
  }

  /** The board reported its tools and page. */
  /** The page menu's background choice shows the page's background. */
  function renderBgChoice() {
    for (const b of $$('.pm-bg [data-bg]')) { const on = b.dataset.bg === (wb.bg || 'white'); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  }
  for (const b of $$('.pm-bg [data-bg]')) b.addEventListener('click', () => { wbSend({ bg: b.dataset.bg }); wb.bg = b.dataset.bg; renderBgChoice(); });

  function onWbState(s) {
    wb = { ...wb, ...s };
    renderBgChoice();
    renderWb();
    onBoardEditing(wb.editing);
    renderAddWindows();
  }

  /** Send a whiteboard command, and show its effect straight away (the board's report confirms it). */
  function wbSend(cmd) {
    if (cmd.tool && laserOn()) { setTool('pen'); $('#laserPop').hidden = true; } // a drawing tool: the laser goes off
    send({ t: 'wb', ...cmd });
    if (cmd.tool) {
      wb.tool = cmd.tool;
      if (WB_SHAPES.has(cmd.tool)) wb.lastShape = cmd.tool;
      if (cmd.tool !== 'select') wb.sel = null;
    }
    const s = wbSettingFor(wbGroup(wb.tool));
    if (cmd.medium) wb.pen.medium = cmd.medium;
    if (cmd.color && s && 'color' in s) s.color = cmd.color;
    if (cmd.size != null && s && 'size' in s) s.size = cmd.size;
    if (cmd.parts) {
      const kind = wb.sel ? wb.sel.shape : wb.tool;
      const limit = kind === 'numline' ? 20 : 12;
      const next = (n) => Math.max(kind === 'polygon' ? 3 : 1, Math.min(limit, n + cmd.parts));
      if (wb.sel) wb.sel.parts = next(wb.sel.parts);
      if (WB_PARTS.has(kind)) wb.shape.parts[kind] = next(wb.shape.parts[kind]);
    }
    if (typeof cmd.frac === 'boolean') { wb.shape.frac = cmd.frac; if (wb.sel?.shape === 'numline') wb.sel.frac = cmd.frac; }
    renderWb();
  }

  /** Which tool's options to show now, or null. iPad: the active tool's, unless tucked away. Phone: only when opened. */
  function wbSheetGroup() {
    if (!wbOn) return null;
    if (wb.tool === 'select' && wb.sel && !laserOn()) return 'select'; // something selected: its panel, also on phones
    if (compact()) return wbSheetFor;
    if (wbTucked || laserOn()) return null;
    const g = wbGroup(wb.tool);
    if (g === 'text' || g === 'math' || g === 'laser') return null; // text: in the editor; the board's laser: on the PC
    if (g === 'select' && !selAsked) return null; // nothing selected: its panel only when you tap Select again
    return g;
  }

  // Select: the panel for what's selected on the board (the board says what it is and what it can do: wb.sel).
  const SEL_COLORS = ['#1f2328', '#2f6bff', '#e8590c', '#16a34a', '#dc2626', '#a855f7', '#f59e0b', '#ffffff'];
  const SEL_FILLS = ['#dce7ff', '#ffe3d1', '#d7f5e1', '#fde0e0', '#efe0ff', '#fff1c7', '#2f6bff', '#1f2328'];
  const selEdit = (op, v) => send({ t: 'wb', sel: { op, v } });
  function renderSel(sg) {
    const sel = sg === 'select' ? wb.sel : null;
    $('#wbSelMany').hidden = sg !== 'select';
    $('#wbAddMode').checked = !!wb.addMode;
    $('#wbGroup').hidden = sel?.kind !== 'multi';
    $('#wbUngroup').hidden = sel?.kind !== 'group';
    $('#wbSel').hidden = !sel;
    if (!sel) return;
    $('#wbSheetTitle').textContent = `${sel.name} selected`;
    const swatches = (box, list, current, op, none) => {
      box.innerHTML = '';
      if (none) {
        const b = document.createElement('button');
        b.className = 'wswatch none-swatch' + (current === 'none' ? ' on' : '');
        b.setAttribute('aria-label', 'No fill');
        b.addEventListener('click', () => selEdit(op, 'none'));
        box.appendChild(b);
      }
      for (const c of list) {
        const b = document.createElement('button');
        b.className = 'wswatch' + (c === current ? ' on' : '');
        b.style.background = c;
        b.setAttribute('aria-label', 'Color ' + c);
        b.addEventListener('click', () => selEdit(op, c));
        box.appendChild(b);
      }
    };
    $('#wbSelColorBox').hidden = !sel.canColor;
    $('#wbSelColorTitle').textContent = sel.kind === 'text' ? 'Text color' : sel.kind === 'stroke' || sel.kind === 'multi' || sel.kind === 'group' ? 'Color' : 'Border';
    if (sel.canColor) swatches($('#wbSelColors'), SEL_COLORS, sel.color, 'color', false);
    $('#wbSelFillBox').hidden = !sel.canFill;
    $('#wbSelFillTitle').textContent = sel.kind === 'text' ? 'Highlight behind the text' : 'Fill';
    if (sel.canFill) swatches($('#wbSelFills'), SEL_FILLS, sel.fill, 'fill', true);
    $('#wbSelThickBox').hidden = !sel.canThick;
    for (const b of $$('[data-selsize]')) b.classList.toggle('on', Number(b.dataset.selsize) === sel.size);
    $('#wbSelRot').textContent = `${sel.rot || 0}°`;
  }
  for (const b of $$('[data-selop]')) b.addEventListener('click', () => selEdit(b.dataset.selop, b.dataset.v != null ? Number(b.dataset.v) : undefined));
  for (const b of $$('[data-selsize]')) b.addEventListener('click', () => selEdit('size', Number(b.dataset.selsize)));
  $('#wbAddMode').addEventListener('change', (e) => selEdit('addmode', e.target.checked));

  function renderWb() {
    const laser = wbOn && laserOn();
    const g = laser ? 'laser' : wbGroup(wb.tool);
    for (const b of $$('[data-wb]')) {
      const on = b.dataset.wb === g || (b.dataset.wb === 'more' && !$('#wbMore').hidden);
      b.classList.toggle('on', on);
      if (b.getAttribute('role') === 'radio') b.setAttribute('aria-checked', b.dataset.wb === g);
    }
    $('[data-wb="more"]').classList.toggle('laser', laser);
    // Phone: Text and Math live in More, so while one is on, the More button shows it.
    const typing = !laser && (g === 'text' || g === 'math' || g === 'note');
    $('[data-wb="more"]').classList.toggle('on', typing || !$('#wbMore').hidden);
    $('#wbMoreIcon').setAttribute('href', laser ? '#i-laser' : typing ? '#w-' + g : '#w-more');
    $('#wbMoreLabel').textContent = laser ? 'Laser' : typing ? WB_NAMES[g] : 'More';
    $('#moreLaser').classList.toggle('on', laser);
    $('#moreText').classList.toggle('on', g === 'text');
    $('#moreMath').classList.toggle('on', g === 'math');
    $('#moreNote').classList.toggle('on', g === 'note');
    $('#wbPenDot').style.background = wb.pen.color;
    $('#wbHlDot').style.background = wb.highlighter.color;
    $('#wbShapeIcon').setAttribute('href', '#w-' + wbToolFor('shapes'));
    $('#wbPageNo').textContent = `${wb.page} / ${wb.pages}`;
    if (!$('#wbPageMenu').hidden && pageStripAt !== `${wb.page}/${wb.pages}`) { // the page or the count changed: follow it
      pageStripAt = `${wb.page}/${wb.pages}`;
      if ($('#pmStrip').children.length !== wb.pages) send({ t: 'wb', pages: { op: 'thumbs' } });
      renderPageStrip(null);
    }
    $('[data-wbact="prev"]').disabled = wb.page <= 1;
    $('[data-wbact="next"]').disabled = wb.page >= wb.pages;
    for (const b of $$('[data-wbact="undo"]')) b.disabled = !wb.canUndo;
    for (const b of $$('[data-wbact="redo"]')) b.disabled = !wb.canRedo;
    $('#wbClear').disabled = wb.empty === true;
    $('#wbFit').hidden = !wbOn || !wb.zoomed;
    $('#moreStream').classList.toggle('on', streaming);
    $('#morePcTools').classList.toggle('on', wb.toolsAway === false); // lit while the PC shows its tools

    // Options for one tool: shapes, pen types, colors, sizes, Parts.
    const sg = wbSheetGroup();
    const sheet = $('#wbSheet');
    sheet.hidden = !sg;
    $('#wbScrim').hidden = !wbOn || (!compact() && $('#wbAdd').hidden) || (!sg && $('#wbMore').hidden && $('#wbAdd').hidden);
    if (!sg) return;
    sheet.dataset.for = sg;
    const set = wbSettingFor(sg);
    const toolNow = wbToolFor(sg);
    $('#wbSheetTitle').textContent = sg === 'shapes' && WB_SHAPES.has(wb.tool) ? `Shapes · ${WB_SHAPE_NAMES[wb.tool]}` : WB_NAMES[sg];
    $('#wbShapes').hidden = sg !== 'shapes';
    for (const b of $$('[data-shape]')) b.classList.toggle('on', b.dataset.shape === wb.tool);
    $('#wbMedia').hidden = sg !== 'pen';
    for (const b of $$('[data-medium]')) b.classList.toggle('on', b.dataset.medium === wb.pen.medium);

    const hasColor = !!set && 'color' in set;
    $('#wbColors').hidden = !hasColor;
    if (hasColor) {
      const box = $('#wbSwatches');
      const palette = sg === 'highlighter' ? wb.palettes.highlighter : sg === 'note' ? wb.palettes.note || [] : wb.palettes.pen;
      for (const old of box.querySelectorAll('.wswatch')) old.remove();
      const custom = box.querySelector('.wb-custom');
      for (const c of palette) {
        const b = document.createElement('button');
        b.className = 'wswatch' + (c === set.color ? ' on' : '');
        b.style.background = c;
        b.dataset.color = c;
        b.setAttribute('aria-label', 'Color ' + c);
        b.addEventListener('click', () => wbSend({ tool: wbToolFor(sg), color: c }));
        box.insertBefore(b, custom);
      }
      const isCustom = !palette.includes(set.color);
      custom.classList.toggle('on', isCustom);
      custom.style.setProperty('--c', set.color);
      if (document.activeElement !== $('#wbCustom')) $('#wbCustom').value = set.color;
    }
    const hasSize = !!set && 'size' in set;
    $('#wbSizes').hidden = !hasSize;
    for (const b of $$('[data-wbsize]')) b.classList.toggle('on', hasSize && Number(b.dataset.wbsize) === set.size);

    renderSel(sg);
    const kind = wb.sel?.shape || wb.tool;
    const showParts = (sg === 'shapes' && WB_PARTS.has(wb.tool)) || (sg === 'select' && wb.sel?.parts != null);
    $('#wbParts').hidden = !showParts;
    if (showParts) {
      $('#wbPartsN').textContent = wb.sel ? wb.sel.parts : wb.shape.parts[kind];
      $('#wbPartsTitle').textContent = kind === 'polygon' ? 'Sides' : 'Parts';
      $('#wbFracRow').hidden = kind !== 'numline';
      $('#wbFrac').checked = wb.sel?.shape === 'numline' ? wb.sel.frac : wb.shape.frac;
    }
    $('#wbNone').hidden = !(sg === 'select' && !wb.sel);
  }

  // Tool buttons: tap a tool to use it; tap it again for its options (iPad: tuck its panel away or bring it back).
  for (const b of $$('[data-wb]')) b.addEventListener('click', () => {
    const g = b.dataset.wb;
    if (g === 'more') {
      if (moreHeld) { moreHeld = false; return; } // the long-press already opened More
      // While the laser is on, this button is the laser: it opens the laser's look and color.
      if (laserOn()) openLaserPop($('#laserPop').hidden);
      else openWbMore($('#wbMore').hidden);
      return;
    }
    $('#wbMore').hidden = true;
    if (g === 'laser') {
      if (laserOn()) openLaserPop($('#laserPop').hidden); // tap again: its look and color
      else { wbSheetFor = null; setTool('laser'); }
      return;
    }
    const active = !laserOn() && wbGroup(wb.tool) === g;
    if (laserOn()) { setTool('pen'); $('#laserPop').hidden = true; } // a drawing tool: the laser goes off
    if (compact()) {
      // Shapes opens its choices straight away: picking a shape is the point.
      wbSheetFor = active ? (wbSheetFor === g ? null : g) : g === 'shapes' ? 'shapes' : null;
    } else if (g === 'select') {
      selAsked = active ? !selAsked : false; // tap Select again: its panel (Select all, Add to selection), or away again
      wbTucked = false;
    } else {
      wbTucked = active ? !wbTucked : false;
    }
    if (!active) wbSend({ tool: wbToolFor(g) });
    else renderWb();
  });
  for (const b of $$('[data-shape]')) b.addEventListener('click', () => {
    wbSend({ tool: b.dataset.shape });
    if (compact() && !WB_PARTS.has(b.dataset.shape)) { wbSheetFor = null; renderWb(); } // back to the board to draw it
  });
  for (const b of $$('[data-medium]')) b.addEventListener('click', () => wbSend({ tool: 'pen', medium: b.dataset.medium }));
  for (const b of $$('[data-wbsize]')) b.addEventListener('click', () => {
    const g = $('#wbSheet').dataset.for;
    wbSend({ tool: wbToolFor(g), size: Number(b.dataset.wbsize) });
  });
  // Any color: sent while it changes (a few times a second at most), and once more when chosen.
  let customTimer = 0;
  function sendCustom() {
    clearTimeout(customTimer);
    customTimer = 0;
    const g = $('#wbSheet').dataset.for;
    wbSend({ tool: wbToolFor(g), color: $('#wbCustom').value });
  }
  $('#wbCustom').addEventListener('input', () => { if (!customTimer) customTimer = setTimeout(sendCustom, 120); });
  $('#wbCustom').addEventListener('change', sendCustom);
  $('#wbPartsMinus').addEventListener('click', () => wbSend({ parts: -1 }));
  $('#wbPartsPlus').addEventListener('click', () => wbSend({ parts: 1 }));
  $('#wbFrac').addEventListener('change', (e) => wbSend({ frac: e.target.checked }));
  for (const b of $$('[data-wbact]')) b.addEventListener('click', () => send({ t: 'wb', action: b.dataset.wbact }));
  // The trash, as on the PC: a tap clears the drawings (pictures stay); a tap when only pictures are left removes
  // them; a long press clears everything. It always asks first; Undo brings it back.
  let trashHeld = false, trashTimer = 0;
  $('#wbClear').addEventListener('pointerdown', () => {
    trashHeld = false;
    clearTimeout(trashTimer);
    trashTimer = setTimeout(() => {
      trashHeld = true;
      if (confirm('Clear everything on this page, the drawings and the pictures? Undo brings it back.')) send({ t: 'wb', action: 'clearall' });
    }, LONG_PRESS_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) $('#wbClear').addEventListener(type, () => clearTimeout(trashTimer));
  $('#wbClear').addEventListener('contextmenu', (e) => e.preventDefault());
  $('#wbClear').addEventListener('click', () => {
    if (trashHeld) { trashHeld = false; return; } // the long press already did it
    if (wb.drawn !== false) {
      if (confirm('Clear the drawings on this page? Pictures stay. Undo brings them back.')) send({ t: 'wb', action: 'clear' });
    } else if (wb.pics) {
      if (confirm('Remove the pictures on this page? Undo brings them back.')) { send({ t: 'wb', action: 'clearpics' }); wbFlash('Pictures removed'); }
    }
  });

  // The page menu: tap the page number.
  function openPageMenu(open) {
    const menu = $('#wbPageMenu');
    menu.hidden = !open;
    if (!open) return;
    renderPageStrip(null); // a picture of each page arrives from the PC
    send({ t: 'wb', pages: { op: 'thumbs' } });
    $('#pmRemoveDoc').hidden = !wb.doc;
    $('#pmDelPage').querySelector('span').textContent = wb.pages > 1 ? `Delete page ${wb.page}` : 'Clear this page';
    // Next to the page bar: above it at the bottom (iPad), below it at the top (iPhone).
    const r = $('#wbPages').getBoundingClientRect();
    const atBottom = r.top > innerHeight / 2;
    menu.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - menu.offsetWidth / 2, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${atBottom ? r.top - menu.offsetHeight - 10 : r.bottom + 10}px`;
  }
  $('#wbPageNo').addEventListener('click', (e) => { e.stopPropagation(); openPageMenu($('#wbPageMenu').hidden); });
  document.addEventListener('pointerdown', (e) => {
    const menu = $('#wbPageMenu');
    if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'wbPageNo') menu.hidden = true;
  }, true);
  for (const b of $$('[data-pm]')) b.addEventListener('click', () => {
    const what = b.dataset.pm;
    openPageMenu(false);
    if (what === 'clear' && !confirm('Clear everything on this page, the drawings and the pictures? Undo brings it back.')) return;
    if (what === 'clear') { send({ t: 'wb', action: 'clearall' }); return; }
    if (what === 'delpage') {
      if (wb.pages > 1 ? !confirm(`Delete page ${wb.page}? This can't be undone.`) : !confirm('Clear this page? Drawings and its picture will be removed.')) return;
    }
    send({ t: 'wb', action: what });
    if (what === 'removedoc') wbFlash('Picture removed');
    else if (what === 'delpage' && wb.pages > 1) wbFlash('Page deleted');
  });

  // ---------- every page as a picture (the page menu) ----------
  let pageThumbs = [];
  let pageStripAt = '';
  function renderPageStrip(list) {
    if (list) pageThumbs = list;
    const strip = $('#pmStrip');
    const keep = strip.scrollLeft;
    strip.innerHTML = '';
    const n = Math.max(wb.pages || 1, pageThumbs.length);
    for (let i = 0; i < n; i++) {
      const t = document.createElement('div');
      t.className = 'pm-page' + (i === wb.page - 1 ? ' on' : '');
      t.dataset.i = i;
      const pic = document.createElement('div');
      pic.className = 'pic';
      if (pageThumbs[i]) pic.style.backgroundImage = `url(${pageThumbs[i]})`;
      t.append(pic, Object.assign(document.createElement('span'), { textContent: String(i + 1) }));
      strip.appendChild(t);
    }
    strip.scrollLeft = keep;
    const on = strip.children[wb.page - 1];
    if (on && (on.offsetLeft < strip.scrollLeft || on.offsetLeft + on.offsetWidth > strip.scrollLeft + strip.clientWidth)) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2;
  }
  function onPageThumbs(msg) {
    if ($('#wbPageMenu').hidden) return;
    renderPageStrip(msg.list || []);
  }
  // Tap a page to go there; hold one, then drag it to move it (a drag before the hold scrolls the row).
  {
    const strip = $('#pmStrip');
    let press = null;
    const dropAt = (x) => {
      const kids = [...strip.children];
      for (let k = 0; k < kids.length; k++) { const r = kids[k].getBoundingClientRect(); if (x < r.left + r.width / 2) return k; }
      return kids.length;
    };
    const showDrop = (to) => {
      for (const k of strip.children) k.classList.remove('drop-before', 'drop-after');
      const kids = strip.children;
      if (to < kids.length) kids[to].classList.add('drop-before'); else if (kids.length) kids[kids.length - 1].classList.add('drop-after');
    };
    const moveGhost = (x, y) => {
      press.ghost.style.left = `${x - 64}px`;
      press.ghost.style.top = `${y - 36}px`;
      press.drop = dropAt(x);
      showDrop(press.drop);
      const r = strip.getBoundingClientRect();
      if (x < r.left + 30) strip.scrollLeft -= 16; else if (x > r.right - 30) strip.scrollLeft += 16;
    };
    const lift = () => {
      press.lifted = true;
      const t = strip.children[press.i];
      t.classList.add('lifted');
      const g = document.createElement('div');
      g.className = 'pm-ghost';
      g.style.backgroundImage = t.querySelector('.pic').style.backgroundImage;
      document.body.appendChild(g);
      press.ghost = g;
      moveGhost(press.x, press.y);
      if (navigator.vibrate) navigator.vibrate(10);
    };
    strip.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('.pm-page');
      if (!t) return;
      try { strip.setPointerCapture(e.pointerId); } catch { /* gone */ }
      press = { i: Number(t.dataset.i), x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, lifted: false, scrolled: false, scroll0: strip.scrollLeft };
      press.hold = setTimeout(() => { if (press && !press.scrolled) lift(); }, 350);
    });
    strip.addEventListener('pointermove', (e) => {
      if (!press) return;
      press.x = e.clientX;
      press.y = e.clientY;
      if (press.lifted) { moveGhost(e.clientX, e.clientY); return; }
      const dx = e.clientX - press.x0;
      if (Math.abs(dx) < 6 && Math.abs(e.clientY - press.y0) < 6) return;
      press.scrolled = true;
      clearTimeout(press.hold);
      strip.scrollLeft = press.scroll0 - dx;
    });
    const end = (cancelled) => {
      if (!press) return;
      const p = press;
      press = null;
      clearTimeout(p.hold);
      for (const k of strip.children) k.classList.remove('drop-before', 'drop-after', 'lifted');
      p.ghost?.remove();
      if (cancelled) return;
      if (p.lifted) {
        let to = p.drop ?? p.i;
        if (to > p.i) to--;
        if (to !== p.i) {
          send({ t: 'wb', pages: { op: 'move', from: p.i, to } });
          const [moved] = pageThumbs.splice(p.i, 1); // straight away here; the PC sends fresh pictures
          if (moved) pageThumbs.splice(to, 0, moved);
          renderPageStrip(null);
          wbFlash(`Moved to page ${to + 1}`);
        }
      } else if (!p.scrolled) {
        send({ t: 'wb', pages: { op: 'go', n: p.i } });
        for (const k of strip.children) k.classList.toggle('on', Number(k.dataset.i) === p.i);
      }
    };
    strip.addEventListener('pointerup', () => end(false));
    strip.addEventListener('pointercancel', () => end(true));
  }

  // ---------- Boards (More → Boards): open a saved board, or start a new one ----------
  function openBoards(open) {
    $('#wbBoards').hidden = !open;
    if (!open) return;
    $('#bdName').textContent = wb.boardName || 'This board';
    $('#bdList').innerHTML = '<div class="empty">Getting your boards from the PC…</div>';
    send({ t: 'wb', boards: { op: 'list' } });
  }
  function onBoards(msg) {
    if ($('#wbBoards').hidden) return;
    $('#bdName').textContent = msg.name || 'This board';
    const box = $('#bdList');
    box.innerHTML = '';
    const others = (msg.list || []).filter((b) => b.id !== msg.current);
    if (!others.length) { box.innerHTML = '<div class="empty">No other boards yet. Each board saves itself on the PC as you work: start a New board, and this one shows up here to open again.</div>'; return; }
    for (const b of others) {
      const row = document.createElement('button');
      if (b.thumb) { const im = document.createElement('img'); im.src = b.thumb; im.alt = ''; row.appendChild(im); }
      const text = document.createElement('span');
      text.append(Object.assign(document.createElement('b'), { textContent: b.name }), Object.assign(document.createElement('small'), { textContent: `${b.modified} · ${b.pages} page${b.pages === 1 ? '' : 's'}` }));
      row.appendChild(text);
      row.addEventListener('click', () => { send({ t: 'wb', boards: { op: 'open', id: b.id } }); openBoards(false); wbFlash('Opening the board'); });
      box.appendChild(row);
    }
  }
  $('#bdNew').addEventListener('click', () => {
    if (!confirm('Start a new board? This one stays saved on the PC.')) return;
    send({ t: 'wb', boards: { op: 'new' } });
    openBoards(false);
    wbFlash('New board');
  });

  // Phone: while the laser is on, the More button is the laser; long-press it (or More in the laser options) for More.
  let moreHeld = false;
  let moreTimer = 0;
  $('[data-wb="more"]').addEventListener('pointerdown', () => {
    moreHeld = false;
    clearTimeout(moreTimer);
    if (laserOn()) moreTimer = setTimeout(() => { moreHeld = true; $('#laserPop').hidden = true; openWbMore(true); }, LONG_PRESS_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) $('[data-wb="more"]').addEventListener(type, () => clearTimeout(moreTimer));
  $('[data-wb="more"]').addEventListener('contextmenu', (e) => e.preventDefault());
  $('#laserMore').addEventListener('click', () => { $('#laserPop').hidden = true; openWbMore(true); });

  function openWbMore(open) {
    $('#wbMore').hidden = !open;
    if (open) wbSheetFor = null;
    renderWb();
  }
  for (const b of $$('[data-close]')) b.addEventListener('click', () => {
    if (b.dataset.close === 'wbAdd') openAdd(false);
    else if (b.dataset.close === 'wbBoards') openBoards(false);
    else if (b.dataset.close === 'wbMore') openWbMore(false);
    else if ($('#wbSheet').dataset.for === 'select' && wb.sel) { selEdit('deselect'); wb.sel = null; renderWb(); } // done with it
    else { wbSheetFor = null; wbTucked = true; renderWb(); }
  });
  $('#wbScrim').addEventListener('click', () => { wbSheetFor = null; $('#wbMore').hidden = true; if (!$('#wbAdd').hidden) openAdd(false); renderWb(); });
  for (const b of $$('[data-more]')) b.addEventListener('click', (e) => {
    const what = b.dataset.more;
    openWbMore(false);
    if (what === 'select' || what === 'text' || what === 'math' || what === 'note') wbSend({ tool: what });
    else if (what === 'add') openAdd(true);
    else if (what === 'laser') setTool(laserOn() ? 'pen' : 'laser');
    else if (what === 'keys') { e.stopPropagation(); openKeys(true); }
    else if (what === 'stream') setStreaming(!streaming);
    else if (what === 'class') openClass(true);
    else if (what === 'boards') openBoards(true);
    else if (what === 'pctools') wbSend({ action: 'tools' }); // show or hide them on the PC whiteboard
    else if (what === 'settings') openSettings(true);
    else if (what === 'help') { openSettings(true); openHelp(true); } // Back from the topics goes to Settings
    else if (what === 'hide') setBarHidden(true);
    else if (what === 'board') send({ t: 'board' });
  });

  // ---------- text boxes (whiteboard mode) ----------
  // With Text or Math, tap the board (Pencil or finger): the board starts a text box there and says so in its state.
  // This editor then opens here, claims the box, and sends the words as they're typed; the board draws them.
  const padEditor = new PadText.Editor({
    scale: () => (compact() ? 0.42 : 0.6),
    touch: true,
    keysHost: $('#wbTextKeys'),
    onChange: (paras) => queueText(paras),
    onDone: () => endText(),
    onKeys: (on) => document.body.classList.toggle('wb-mathkeys', on),
  });
  padEditor.el.hidden = true;
  $('#wbText').appendChild(padEditor.el);
  let textId = null;      // the board's text box being typed here
  let closedTextId = null; // just finished: ignore it while the board's state catches up
  let textTimer = 0;
  let textQueued = null;

  function onBoardEditing(ed) {
    if (!wbOn || !ed) { if (textId) closeText(); if (!ed) closedTextId = null; return; }
    if (ed.id === textId || ed.id === closedTextId) return;
    textId = ed.id;
    $('#wbText').hidden = false;
    $('#wbMore').hidden = true;
    padEditor.open(PadText.clean(ed.paras), { math: !!ed.math });
    send({ t: 'wb', text: { id: textId, claim: true } }); // typed here: the PC hides its own editor
  }

  function queueText(paras) {
    textQueued = paras;
    if (!textTimer) textTimer = setTimeout(flushText, 80);
  }
  function flushText(extra) {
    clearTimeout(textTimer);
    textTimer = 0;
    if (!textId || (!textQueued && !extra)) return;
    send({ t: 'wb', text: { id: textId, ...(textQueued ? { paras: textQueued } : {}), ...extra } });
    textQueued = null;
  }
  function endText() {
    if (!textId) return;
    textQueued = padEditor.paras();
    flushText({ done: true });
    closedTextId = textId;
    closeText();
  }
  function closeText() {
    clearTimeout(textTimer);
    textTimer = 0;
    textQueued = null;
    textId = null;
    padEditor.close();
    $('#wbText').hidden = true;
    document.body.classList.remove('wb-mathkeys');
  }

  // ---------- Add to the board ----------
  // The PC screen (what's behind the board), a window, a web page, or a PDF or picture from the PC: the board does
  // these (as its own Capture and Import buttons do). Photos from this device are shrunk here and sent to /photo.
  let addPlace = 'page';
  let addWaitingWindows = false;

  function openAdd(open) {
    $('#wbAdd').hidden = !open;
    if (open) {
      $('#wbMore').hidden = true;
      wbSheetFor = null;
      showAddPart(null);
    }
    renderWb();
    $('#wbScrim').hidden = !wbOn || (!open && $('#wbMore').hidden && !wbSheetGroup());
  }
  $('#addBtn').addEventListener('click', () => openAdd($('#wbAdd').hidden));
  for (const b of $$('[data-addplace]')) b.addEventListener('click', () => {
    addPlace = b.dataset.addplace;
    for (const x of $$('[data-addplace]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }
  });

  /** One of the panel's parts below the tiles: the window list or the web address (or neither). */
  function showAddPart(part) {
    $('#addWindows').hidden = part !== 'windows';
    $('#addUrl').hidden = part !== 'url';
    $('#addNote').hidden = !!part;
    if (part !== 'windows' && addWaitingWindows) { addWaitingWindows = false; send({ t: 'wb', add: { kind: 'nowindow' } }); }
  }

  function addDone(text) {
    openAdd(false);
    wbFlash(text);
  }

  for (const b of $$('[data-add]')) b.addEventListener('click', () => {
    const kind = b.dataset.add;
    if (kind === 'screen') { send({ t: 'wb', add: { kind: 'screen', place: addPlace } }); addDone('Capturing the PC screen'); }
    else if (kind === 'windows') {
      showAddPart('windows');
      $('#addWindowList').innerHTML = '<div class="empty">Finding open windows…</div>';
      addWaitingWindows = true;
      send({ t: 'wb', add: { kind: 'windows' } });
    } else if (kind === 'url') {
      showAddPart('url');
      $('#addUrlInput').focus();
    } else if (kind === 'take') $('#addTake').click();
    else if (kind === 'pick') $('#addPick').click();
    else if (kind === 'import') { send({ t: 'wb', add: { kind: 'import' } }); addDone('Pick the file on the PC'); }
    else if (kind === 'drive') openDrive();
  });

  // Google Drive: Google's own picker, on PadLink's website, opens in Safari. The picked file goes back to the PC
  // (its /drive/return page); a PDF's pages then come here to choose from, as 'drive' messages.
  function openDrive() {
    const code = PadDrive.newCode();
    send({ t: 'drive', code, place: addPlace }); // the PC waits for this code
    // Straight from the tap: Safari only opens a new tab from one.
    const tab = window.open(PadDrive.pickerFor(PC, code), '_blank');
    openAdd(false);
    if (tab) wbFlash('Pick a file in Google Drive');
    else notice('Safari didn\u2019t open Google Drive. Turn off Block Pop-ups (Settings \u2192 Apps \u2192 Safari) and try again.', 9000);
  }
  $('#addDriveLogo').innerHTML = PadDrive.LOGO;

  // Choosing a PDF's pages (Google Slides, Docs and Sheets arrive as PDFs). Every page starts chosen.
  let pg = null; // { id, name, count, chosen: Set, place }
  function onDrive(msg) {
    if (msg.op === 'getting') { closePages(false); notice(`Getting \u201c${msg.name}\u201d from Google Drive\u2026`, 6000); }
    else if (msg.op === 'added') { closePages(false); notice(`Added \u201c${msg.name}\u201d to the board`, 3000); }
    else if (msg.op === 'error') notice(msg.message, 9000);
    else if (msg.op === 'pages') openPages(msg);
    else if (msg.op === 'thumb' && pg && msg.id === pg.id) {
      const img = $(`#pgGrid [data-i="${Number(msg.index)}"] img`);
      if (img) img.src = msg.url;
    }
  }

  function openPages(msg) {
    if (pg && pg.id === msg.id) return; // sent again after a reconnect: it's already open
    openAdd(false);
    wbSheetFor = null; // nothing else open on top of or behind it
    $('#wbMore').hidden = true;
    renderWb();
    pg = { id: msg.id, name: msg.name, count: msg.count, chosen: new Set(), place: msg.place === 'image' ? 'image' : 'page' };
    for (let i = 0; i < msg.count; i++) pg.chosen.add(i);
    $('#pgTitle').textContent = msg.name.replace(/\.pdf$/i, '');
    const grid = $('#pgGrid');
    grid.innerHTML = '';
    for (let i = 0; i < msg.count; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pg-page on';
      b.dataset.i = i;
      const size = msg.sizes && msg.sizes[i];
      if (size) b.style.setProperty('--ar', String(size[0] / size[1]));
      b.innerHTML = '<span class="pg-img"><img alt=""></span><span class="pg-no"></span>';
      b.querySelector('.pg-no').textContent = String(i + 1);
      b.setAttribute('aria-label', `Page ${i + 1}`);
      b.addEventListener('click', () => {
        if (pg.chosen.has(i)) pg.chosen.delete(i); else pg.chosen.add(i);
        syncPages();
      });
      grid.appendChild(b);
    }
    $('#wbChoose').hidden = false;
    syncPages();
  }

  function syncPages() {
    for (const b of $$('#pgGrid .pg-page')) {
      const on = pg.chosen.has(Number(b.dataset.i));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const b of $$('[data-pgplace]')) { const on = b.dataset.pgplace === pg.place; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    const n = pg.chosen.size;
    $('#pgCount').textContent = `${n} of ${pg.count} chosen`;
    $('#pgAdd').textContent = n === 1 ? 'Add 1 page' : `Add ${n} pages`;
    $('#pgAdd').disabled = n === 0;
  }

  /** Close the page chooser; cancelled: tell the board to forget the file. */
  function closePages(cancelled) {
    if (!pg) return;
    if (cancelled) send({ t: 'wb', add: { kind: 'nopages', id: pg.id } });
    pg = null;
    $('#wbChoose').hidden = true;
  }
  $('#pgClose').addEventListener('click', () => closePages(true));
  $('#pgAll').addEventListener('click', () => { for (let i = 0; i < pg.count; i++) pg.chosen.add(i); syncPages(); });
  $('#pgNone').addEventListener('click', () => { pg.chosen.clear(); syncPages(); });
  for (const b of $$('[data-pgplace]')) b.addEventListener('click', () => { pg.place = b.dataset.pgplace; syncPages(); });
  $('#pgAdd').addEventListener('click', () => {
    if (!pg || !pg.chosen.size) return;
    const n = pg.chosen.size;
    send({ t: 'wb', add: { kind: 'pages', id: pg.id, pages: [...pg.chosen].sort((x, y) => x - y), place: pg.place } });
    closePages(false);
    wbFlash(n === 1 ? 'Adding 1 page' : `Adding ${n} pages`);
  });

  /** The board sent the open windows (in its state): list them to pick from. */
  function renderAddWindows() {
    if (!addWaitingWindows || !Array.isArray(wb.windows)) return;
    const box = $('#addWindowList');
    box.innerHTML = '';
    if (!wb.windows.length) { box.innerHTML = '<div class="empty">No other open windows found.</div>'; return; }
    for (const w of wb.windows) {
      const b = document.createElement('button');
      const title = document.createElement('b');
      title.textContent = w.title;
      const app = document.createElement('small');
      app.textContent = w.app;
      b.append(title, app);
      b.addEventListener('click', () => {
        addWaitingWindows = false;
        send({ t: 'wb', add: { kind: 'window', id: w.id, place: addPlace } });
        addDone('Capturing ' + w.title);
      });
      box.appendChild(b);
    }
  }

  $('#addUrl').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#addUrlInput').value.trim();
    if (!url) return;
    $('#addUrlInput').blur();
    send({ t: 'wb', add: { kind: 'url', url, place: addPlace } });
    $('#addUrlInput').value = '';
    addDone('Capturing the web page');
  });

  /** A photo from this device: shrunk to at most 2400 px on its long side, sent as a JPEG. */
  async function sendPhoto(file) {
    if (!file) return;
    addDone('Sending the photo…');
    try {
      // Decode it (turned the right way up, as the camera held it); an <img> if this browser can't.
      let img, w, h, url = null;
      try {
        img = await createImageBitmap(file, { imageOrientation: 'from-image' });
        w = img.width; h = img.height;
      } catch {
        url = URL.createObjectURL(file);
        img = new Image();
        img.src = url;
        await img.decode();
        w = img.naturalWidth; h = img.naturalHeight;
      }
      const k = Math.min(1, 2400 / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if (url) URL.revokeObjectURL(url); else img.close?.();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      const res = await fetch(pcUrl(`/photo?${authQuery()}&place=${addPlace}`), { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
      if (!res.ok) throw new Error(res.status === 409 ? 'Open the whiteboard first.' : `The PC said no (${res.status}).`);
      wbFlash('Photo added');
    } catch (err) {
      notice("The photo didn't arrive: " + (err.message || err));
    }
  }
  for (const id of ['#addTake', '#addPick']) $(id).addEventListener('change', (e) => { sendPhoto(e.target.files[0]); e.target.value = ''; });

  /** A short word in the middle of the screen, for gestures that have no button to light up. */
  let flashTimer = 0;
  function wbFlash(text) {
    const el = $('#wbFlash');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth; // restart the fade
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 800);
  }

  // Finger gestures in whiteboard mode: two-finger tap = Undo, three-finger tap = Redo, two-finger double-tap = the
  // whole page. A two-finger tap waits a moment to see whether a second one follows.
  const DOUBLE_TAP_MS = 320;
  let twoTapTimer = 0;
  function wbTwoFingerTap() {
    if (twoTapTimer) {
      clearTimeout(twoTapTimer);
      twoTapTimer = 0;
      send({ t: 'wb', action: 'fit' });
      wbFlash('Whole page');
      return;
    }
    twoTapTimer = setTimeout(() => {
      twoTapTimer = 0;
      send({ t: 'wb', action: 'undo' });
      wbFlash('Undo');
    }, DOUBLE_TAP_MS);
  }
  function wbThreeFingerTap() {
    send({ t: 'wb', action: 'redo' });
    wbFlash('Redo');
  }

  $('#boardBtn').addEventListener('click', () => {
    send({ t: 'board' });
    if (!streaming) setStreaming(true); // the board is only useful if you can see it
  });

  // Hide / show the toolbar (more room while presenting).
  function setBarHidden(hidden) {
    document.body.classList.toggle('bar-hidden', hidden);
    $('#showBar').hidden = !hidden;
    saveSetting('barHidden', hidden);
    layout();
  }
  $('#hideBar').addEventListener('click', () => setBarHidden(true));
  $('#showBar').addEventListener('click', () => setBarHidden(false));

  // ---------- settings panel ----------

  function openSettings(open) {
    if (open && !$('#classPanel').hidden) openClass(false);
    $('#settings').hidden = !open;
    $('#scrim').hidden = !open;
    $('#settingsBtn').classList.toggle('on', open);
  }
  $('#settingsBtn').addEventListener('click', () => openSettings($('#settings').hidden));
  $('#conn').addEventListener('click', () => openSettings(true));
  $('#closeSettings').addEventListener('click', () => openSettings(false));
  $('#scrim').addEventListener('click', () => openSettings(false));

  // Help opens over Settings; Back returns to Settings, ✕ closes both.
  /** Help: a grid of topics; tapping one shows just that topic (Back returns to the topics). */
  function helpTopic(name) {
    const topic = name && $(`.help-topic[data-topic="${name}"]`);
    $('#helpHome').hidden = !!topic;
    $$('.help-topic').forEach((t) => { t.hidden = t !== topic; });
    $('#helpTitle').textContent = topic ? topic.dataset.title : 'Help & tips';
    $('#helpBack').setAttribute('aria-label', topic ? 'Back to the topics' : 'Back to settings');
    $('#help .scroll').scrollTop = 0;
  }
  $$('.help-card').forEach((c) => c.addEventListener('click', () => helpTopic(c.dataset.topic)));

  function openHelp(open) {
    $('#help').hidden = !open;
    if (open) helpTopic(null);
  }
  $('#openHelp').addEventListener('click', () => openHelp(true));

  // ---------- PadLink Go: prepare boards anywhere (help topic, from Settings, Boards and the help) ----------
  // "Copy pairing link" asks the PC for a fresh one (Remote mode's link and a one-time code) as the topic opens, so the
  // tap that copies it is still a tap (Safari only lets a page copy straight from one).
  let goLink = null;
  function openGoHelp() {
    openSettings(true);
    $('#help').hidden = false;
    helpTopic('go');
    goLink = null;
    $('#goCopy').disabled = true;
    goStatus('Getting a pairing link from the PC…');
    send({ t: 'goLink' });
  }
  function goStatus(text, kind = '') { const el = $('#goStatus'); el.textContent = text; el.className = 'go-status' + (kind ? ' ' + kind : ''); }
  function onGoLink(msg) {
    goLink = msg.link || null;
    $('#goCopy').disabled = !goLink;
    if (goLink) goStatus('Ready. It works once, for 10 minutes.');
    else goStatus(msg.error || 'The PC couldn’t make a pairing link.', 'warn');
  }
  $('#goCopy').addEventListener('click', async () => {
    if (!goLink) return;
    try { await navigator.clipboard.writeText(goLink); goStatus('Copied ✓ Now in PadLink Go: Connect to your PC → Have a pairing link instead? → Paste.', 'good'); }
    catch { goStatus('Copying didn’t work here. In PadLink Go, tap Connect to your PC and scan the QR code in PadLink’s window instead.', 'warn'); }
  });
  $('#openGoHelp').addEventListener('click', openGoHelp);
  $('#goNoteYes').addEventListener('click', () => { $('#goNote').hidden = true; store.set('goNote', 'no'); openGoHelp(); });
  $('#goNoteNo').addEventListener('click', () => { $('#goNote').hidden = true; store.set('goNote', 'no'); });
  $('#bdGo').addEventListener('click', () => { openBoards(false); if (host) host.back(); else openGoHelp(); });
  $$('.help-card[data-topic="go"]').forEach((c) => c.addEventListener('click', openGoHelp));
  // Inside PadLink Go: this is already PadLink Go, so its entries lead back to the boards list instead.
  if (host) {
    // Back to the boards list: at the top of Settings, and as Boards at the top left (leaving closes the connection; the
    // pairing stays).
    $('#goBack').hidden = false;
    $('#goBack').addEventListener('click', () => host.back('disconnected'));
    $('#goBoards').hidden = false;
    $('#goBoards').addEventListener('click', () => host.back('disconnected'));
    $('#openGoHelp').hidden = true;
    $$('.help-card[data-topic="go"]').forEach((c) => { c.hidden = true; });
    $('#bdGo b').textContent = 'Your prepared boards';
    $('#bdGo small').textContent = 'Back to PadLink Go’s boards: open, prepare and send them';
  }
  $('#helpBack').addEventListener('click', () => { if ($('#helpHome').hidden) helpTopic(null); else openHelp(false); });
  $('#closeHelp').addEventListener('click', () => { openHelp(false); openSettings(false); });
  $('#scrim').addEventListener('click', () => openHelp(false));

  $('#routing').addEventListener('change', (e) => send({ t: 'routing', r: e.target.value }));
  $('#monitor').addEventListener('change', (e) => send({ t: 'monitor', i: Number(e.target.value) }));

  $('#light').addEventListener('change', (e) => {
    if (stroke) endStroke(stroke.last);
    saveSetting('light', e.target.checked);
    applySettingsUI();
  });
  $('#firmness').addEventListener('input', (e) => saveSetting('firmness', Number(e.target.value)));

  $$('input[name="fingers"]').forEach((r) => r.addEventListener('change', () => {
    abortFingers();
    saveSetting('fingers', r.value);
    saveSetting('fingersChosen', true);
  }));

  $('#streamToggle').addEventListener('change', (e) => setStreaming(e.target.checked));

  $$('[data-q]').forEach((b) => b.addEventListener('click', () => {
    saveSetting('quality', b.dataset.q);
    applySettingsUI();
    sendStream();
  }));

  $('#resetDefaults').addEventListener('click', () => {
    for (const [k, v] of Object.entries(DEFAULTS)) saveSetting(k, v);
    send({ t: 'routing', r: 'auto' });
    streaming = settings.stream;
    applySettingsUI();
    setBarHidden(false);
    sendStream();
  });

  function applySettingsUI() {
    $('#light').checked = settings.light;
    $('#firmRow').hidden = !settings.light;
    $('#firmness').value = settings.firmness;
    $$('input[name="fingers"]').forEach((r) => { r.checked = r.value === settings.fingers; });
    // The tip on the empty drawing surface describes what fingers do right now.
    const fingerTip = {
      touch: 'Pencil: write, click and drag · Finger: tap to click, drag to scroll, pinch to zoom',
      pencil: 'Finger: move, click, drag and draw · Two fingers: scroll and pinch to zoom · Long-press: right-click',
      off: 'Pencil: write, click and drag · Fingers are off (Settings)',
    }[settings.fingers];
    $('#hintFingers').textContent = fingerTip;
    $('#fingersDefault').textContent = isPhone
      ? 'On a phone (no Apple Pencil) the default is “Act like the Pencil”.'
      : 'On an iPad the default is “Tap and scroll”, so a hand resting near the Pencil can’t draw.';
    $$('[data-q]').forEach((b) => {
      b.classList.toggle('on', b.dataset.q === settings.quality);
      b.setAttribute('aria-checked', b.dataset.q === settings.quality);
    });
    $('#qualityNote').textContent = QUALITY[settings.quality].note;
    $('#streamToggle').checked = streaming;
    $('#followRow').hidden = !viewCapable();
    $('#followToggle').checked = settings.follow;
    $('#boardOnlyToggle').checked = settings.boardOnly;
    $('#nativeToggle').checked = settings.nativeBoard;
    updateVideoText();
  }

  // ---------- layout ----------

  function layout() {
    sizeSurface();
    sendStream(); // new size: ask for a matching resolution and a fresh frame
  }

  /**
   * Size the picture: the PC screen's shape, as big as fits. A phone held upright, zoomed in, has room above and
   * below that strip: the picture grows taller as you zoom (up to all the free height) and shows more of the PC
   * screen's height, so the zoom uses the whole phone instead of a strip across the middle.
   */
  function sizeSurface() {
    const cs = getComputedStyle(stage);
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // The page's shape: drawn here, or the video of just the board page; otherwise the PC screen's.
    const shape = nativeActive ? PadEngine.W / PadEngine.H : crop ? aspect * crop.w / crop.h : aspect;
    let sw = w;
    let sh = w / shape;
    if (sh > h) { sh = h; sw = h * shape; }
    if (viewCapable() && streaming && view.z > 1) sh = Math.max(sh, Math.min(h, sh * view.z));
    view.h = Math.min(1, (sh / sw) * shape / view.z); // the part of the PC screen's height in view
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(sw * dpr), ch = Math.round(sh * dpr);
    if (screenCanvas.width !== cw || screenCanvas.height !== ch || copyCanvas.width !== cw || copyCanvas.height !== ch || surface.style.width !== `${sw}px`) {
      surface.style.width = `${sw}px`;
      surface.style.height = `${sh}px`;
      for (const c of [canvas, screenCanvas, copyCanvas]) { c.width = cw; c.height = ch; }
    }
    rect = surface.getBoundingClientRect();
    paintScreen();
    drawCopy();
    updateViewBar();
    kick();
  }
  window.addEventListener('resize', () => { renderWb(); layout(); });
  window.addEventListener('orientationchange', () => setTimeout(layout, 300));

  // ---------- local feedback (instant; the real result shows up on the PC) ----------

  const trails = [];
  const ripples = [];
  let cursor = null;
  let animating = false;

  function kick() {
    if (!animating) { animating = true; requestAnimationFrame(draw); }
  }

  function draw(now) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    // Zoomed in on a phone: PC positions (0..1) to this view's pixels.
    const X = (v) => (UX(v) - view.x) * view.z * w;
    const Y = (v) => (UY(v) - view.y) / view.h * h;

    // When streaming, the real ink shows up in the video, so local ink only bridges the delay.
    const life = streaming ? 400 : TRAIL_MS;
    while (trails.length && now - trails[0].t > life) trails.shift();
    for (const s of trails) {
      ctx.globalAlpha = 1 - (now - s.t) / life;
      ctx.strokeStyle = s.tool === 'laser' ? '#ff2020' : s.tool === 'eraser' ? '#e0675c' : s.tool === 'right' ? '#a06cf0' : '#2563eb';
      ctx.lineWidth = 1 + s.p * 5;
      ctx.beginPath();
      ctx.moveTo(X(s.x1), Y(s.y1));
      ctx.lineTo(X(s.x2), Y(s.y2));
      ctx.stroke();
    }

    // Finger taps: a ring that grows and fades (purple = right-click).
    while (ripples.length && now - ripples[0].t > 450) ripples.shift();
    for (const r of ripples) {
      const k = (now - r.t) / 450;
      ctx.globalAlpha = 0.6 * (1 - k);
      ctx.strokeStyle = r.right ? '#a06cf0' : '#5b9cff';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(X(r.x), Y(r.y), 10 + 22 * k, 0, Math.PI * 2); ctx.stroke();
    }

    // Where the Pencil is pointing, drawn instantly (the streamed cursor arrives a few frames later).
    if (cursor && now - cursor.t < 3000) {
      const x = X(cursor.x);
      const y = Y(cursor.y);
      if (laserOn()) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#ff2020';
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      } else {
        const r = cursor.down ? 4 : 8;
        ctx.globalAlpha = cursor.down ? 0.9 : 0.7;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff'; // white halo keeps the ring visible on dark and light screens
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#111';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    if (trails.length || ripples.length || (cursor && now - cursor.t < 3000)) requestAnimationFrame(draw);
    else animating = false;
  }

  function trail(a, b) {
    if (nativeActive && tool !== 'laser' && (wb.tool === 'pen' || wb.tool === 'highlighter')) { localInkTo(a, b); return; }
    trails.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], p: b[2], t: performance.now(), tool });
    kick();
  }

  function moveCursor(s, down) {
    cursor = { x: s[0], y: s[1], down, t: performance.now() };
    kick();
  }

  function ripple(x, y, right) {
    ripples.push({ x, y, right, t: performance.now() });
    kick();
  }

  // ---------- the board drawn here ----------
  // In whiteboard mode the iPad draws the board itself, with the same engine as the PC (engine.js), instead of showing
  // a video of the PC screen: sharp at this screen's resolution, nothing on the PC in the way, and little to send. The
  // PC board sends the page it's on as it changes (see board.js: mirror); the Pencil still drives the PC board, and its
  // ink shows here straight away, drawn the way the board will draw it, until the board's own stroke arrives.
  let nativeActive = false;
  const copy = { pages: new Map(), pid: 0, view: { x: 0, y: 0, z: 1 }, viewHeldUntil: 0, live: null, images: new Map(), hidden: new Set(), eraser: null };
  const localInk = { cur: null, done: [], owner: null, timer: 0 };
  let copyFrame = 0, copyTimer = 0;
  let copyFailed = false; // this device couldn't draw the board: the video instead (until the page is reloaded)
  const copyErrors = new Set();
  PadEngine.configure({
    image: (id) => copy.images.get(id) || null,
    onError: (e, item) => {
      // Something on the page can't be drawn on this device: say so once (the rest is still drawn).
      const key = (item && item.type) + ': ' + e.message;
      if (copyErrors.has(key)) return;
      copyErrors.add(key);
      console.warn('Board copy: could not draw', item, e);
      notice(`Part of the board (${item?.note ? 'a sticky note' : item?.type || 'an item'}) can't be shown on this device: ${e.message}`, 8000);
    },
  });

  /** Whiteboard mode, the switch on, and the PC said where its page is (the Pencil needs that): draw the board here. */
  function updateNative() {
    const on = wbOn && settings.nativeBoard && streaming && !copyFailed; // the board's place on the PC screen isn't needed
    if (on === nativeActive) return;
    nativeActive = on;
    document.body.classList.toggle('native', on);
    if (on && view.z > 1) { view.x = 0; view.y = 0; view.z = 1; view.h = 1; } // this device's own zoom isn't used
    if (on) askForCopy();
    else { resetCopy(); clearTimeout(copyAsk); send({ t: 'wb', mirror: 'stop' }); }
    sizeSurface(); // the page's shape
    drawCopy();
  }

  /**
   * Ask the PC whiteboard for its copy, from the start, and again every moment until it comes: the whiteboard may
   * still be loading when this device asks (it then also says when it's ready).
   */
  let copyAsk = 0;
  function askForCopy() {
    resetCopy();
    clearTimeout(copyAsk);
    const ask = () => {
      if (!nativeActive || copy.pid) return; // its copy is here
      send({ t: 'wb', mirror: 'start' });
      copyAsk = setTimeout(ask, 1500);
    };
    ask();
  }

  function resetCopy() {
    copy.pages.clear();
    copy.pid = 0;
    copy.live = null;
    localInk.cur = null;
    localInk.done = [];
  }

  function onCopy(msg) {
    if (msg.t === 'mimg') {
      const img = new Image();
      img.onload = () => { copy.images.set(msg.id, img); drawCopy(); };
      img.src = msg.url;
      return;
    }
    if (msg.t === 'mpage') {
      let p = copy.pages.get(msg.pid);
      if (!p || msg.first) { p = { items: new Map(), order: [] }; copy.pages.set(msg.pid, p); }
      let newInk = 0;
      for (const [id, it] of msg.add) { if (!p.items.has(id) && it.type === 'stroke') newInk++; p.items.set(id, it); }
      const keep = new Set(msg.ids);
      for (const id of [...p.items.keys()]) if (!keep.has(id)) p.items.delete(id);
      p.order = msg.ids;
      p.bg = msg.bg; p.h = msg.h; p.doc = msg.doc;
      copy.pid = msg.pid;
      // While fingers are moving the view here, this device's own view leads (the board's is a step behind).
      if (msg.view && performance.now() > copy.viewHeldUntil) copy.view = msg.view;
      if (newInk) localInk.done.splice(0, newInk); // the board has these strokes now: draw its own
      for (const id of [...copy.hidden]) if (!keep.has(id)) copy.hidden.delete(id); // the board has erased these too
    } else if (msg.t === 'mlive') {
      copy.live = msg;
    }
    drawCopy();
  }

  /** A piece of the Pencil's stroke (from a to b, PC screen fractions with pressure) as ink on the page here. */
  function localInkTo(a, b) {
    const toPage = (s) => {
      const v = copy.view;
      return [v.x + UX(s[0]) * PadEngine.W / v.z, v.y + UY(s[1]) * PadEngine.H / v.z, s[2] ?? 0.5];
    };
    if (!localInk.cur || localInk.owner !== stroke) {
      if (localInk.cur) localInk.done.push(localInk.cur);
      const hl = wb.tool === 'highlighter';
      const set = hl ? wb.highlighter : wb.pen;
      const medium = hl ? undefined : set.medium || 'pen';
      const sizes = PadEngine.SIZES[hl ? 'highlighter' : medium] || PadEngine.SIZES.pen;
      localInk.cur = { type: 'stroke', tool: hl ? 'highlighter' : 'pen', medium, color: set.color, size: sizes[set.size ?? 1], pts: [toPage(a)] };
      localInk.owner = stroke;
    }
    localInk.cur.pts.push(toPage(b));
    // Kept until the board's own stroke arrives; if it never does (the PC missed it), it fades after a while.
    clearTimeout(localInk.timer);
    localInk.timer = setTimeout(() => { localInk.cur = null; localInk.done = []; drawCopy(); }, 4000);
    drawCopy();
  }

  // ---- drawing and erasing here (stage 2) ----
  // With the board drawn here and the pen, highlighter or eraser on, the Pencil doesn't drive the PC any more: the
  // stroke is drawn here as it's made and sent to the board as a drawing (its look, then its points as they come,
  // then done), and the eraser rubs out here at once and tells the board where it went.
  const inkHere = () => nativeActive && tool !== 'laser' && (wb.tool === 'pen' || wb.tool === 'highlighter' || wb.tool === 'eraser');
  const INK_SEND_MS = 30; // points are sent in small batches, about 30 times a second
  let inkSeq = 1;

  /** A Pencil sample (PC screen fractions and pressure) as a point on the page. */
  function pagePoint(s) {
    const v = copy.view;
    return [round(v.x + UX(s[0]) * PadEngine.W / v.z, 100), round(v.y + UY(s[1]) * PadEngine.H / v.z, 100), round(s[2] ?? 0.5, 1000)];
  }

  function inkLook() {
    if (wb.tool === 'highlighter') return { tool: 'highlighter', color: wb.highlighter.color, size: PadEngine.SIZES.highlighter[wb.highlighter.size ?? 1] };
    const medium = wb.pen.medium || 'pen';
    return { tool: 'pen', medium, color: wb.pen.color, size: (PadEngine.SIZES[medium] || PadEngine.SIZES.pen)[wb.pen.size ?? 1] };
  }

  function beginInk(id, type, samples) {
    stroke = { id, type, ink: true, erasing: wb.tool === 'eraser', inkId: inkSeq++, last: samples[samples.length - 1], pending: [], timer: 0 };
    if (stroke.erasing) {
      stroke.r = PadEngine.SIZES.eraser[wb.eraser.size ?? 1] / 2;
    } else {
      if (localInk.cur) localInk.done.push(localInk.cur);
      localInk.cur = { type: 'stroke', ...inkLook(), pts: [] };
      localInk.owner = stroke;
      send({ t: 'wb', ink: { op: 'begin', id: stroke.inkId, ...inkLook() } });
    }
    moveInk(samples);
  }

  function moveInk(samples) {
    const pts = samples.map(pagePoint);
    stroke.last = samples[samples.length - 1];
    if (stroke.erasing) {
      for (const [x, y] of pts) eraseHere(x, y, stroke.r);
      copy.eraser = [...pts[pts.length - 1].slice(0, 2), stroke.r];
    } else {
      localInk.cur.pts.push(...pts);
    }
    stroke.pending.push(...pts);
    if (!stroke.timer) { const s = stroke; s.timer = setTimeout(() => flushInk(s), INK_SEND_MS); }
    drawCopy();
  }

  /** Send the points waiting to go (and, at the end, say it's done). */
  function flushInk(s, done = false) {
    clearTimeout(s.timer);
    s.timer = 0;
    const pts = s.pending.splice(0);
    if (s.erasing) {
      if (pts.length || done) send({ t: 'wb', ink: { op: 'erase', pts, r: s.r, done } });
    } else if (done) send({ t: 'wb', ink: { op: 'end', id: s.inkId, pts } });
    else if (pts.length) send({ t: 'wb', ink: { op: 'pts', id: s.inkId, pts } });
  }

  function endInk(sample) {
    const s = stroke;
    if (sample && sample !== s.last) moveInk([sample]);
    flushInk(s, true);
    stroke = null;
    if (s.erasing) {
      copy.eraser = null;
      // Whatever the board didn't erase after all comes back (its page is the truth).
      setTimeout(() => { if (!(stroke && stroke.erasing)) { copy.hidden.clear(); drawCopy(); } }, 1500);
    }
    else {
      localInk.done.push(localInk.cur); // shown until the board's own stroke comes back
      localInk.cur = null;
      clearTimeout(localInk.timer);
      localInk.timer = setTimeout(() => { localInk.done = []; drawCopy(); }, 4000); // if it never does
    }
    drawCopy();
  }

  /** Rub out here at once what the eraser touches (the board does the same; its page then confirms it). */
  function eraseHere(x, y, r) {
    const p = copy.pages.get(copy.pid);
    if (!p) return;
    for (const id of p.order) {
      const it = p.items.get(id);
      if (!it || copy.hidden.has(id) || it.type === 'image' || it.type === 'group') continue; // pictures stay; groups lose just a piece (the board shows it)
      if (PadEngine.hits(it, x, y, r)) copy.hidden.add(id);
    }
  }

  // ---- Select, shapes, text and math (stage 3) ----
  // These run on the board itself: the iPad sends where on the page it presses, moves and lets go (page units, with
  // pressure and a held Shift), and the board treats it as a touch on its own page. What they show (the shape being
  // dragged, the selection box, a text box) comes back in the board's copy.
  const shiftHeld = () => !!document.querySelector('[data-hold="shift"].on');
  const POINTER_MS = 16; // moves are sent at most about 60 times a second (the newest position)

  function pagePointerMsg(e, s) {
    const [x, y, p] = pagePoint(s);
    const k = { e, x, y, p };
    if (shiftHeld()) k.shift = true;
    return { t: 'wb', ptr: k };
  }

  function beginPagePointer(id, type, samples) {
    stroke = { id, type, page: true, last: samples[samples.length - 1], timer: 0, waiting: null };
    send(pagePointerMsg('down', samples[0]));
    if (samples.length > 1) movePagePointer(samples.slice(1));
  }

  function movePagePointer(samples) {
    const s = stroke;
    s.last = s.waiting = samples[samples.length - 1];
    if (!s.timer) s.timer = setTimeout(() => sendPagePointerMove(s), POINTER_MS);
  }

  function sendPagePointerMove(s) {
    clearTimeout(s.timer);
    s.timer = 0;
    if (s.waiting) { send(pagePointerMsg('move', s.waiting)); s.waiting = null; }
  }

  function endPagePointer(sample) {
    const s = stroke;
    sendPagePointerMove(s);
    send(pagePointerMsg('up', sample || s.last));
    stroke = null;
  }

  /** A quick finger tap on the page: press and let go there. */
  function pageTap(sample) {
    send(pagePointerMsg('down', sample));
    send(pagePointerMsg('up', sample));
    ripple(sample[0], sample[1], false);
  }

  // ---- moving and zooming the board (stage 4) ----
  // Two fingers move the board and a pinch zooms it, here at once and on the board a moment later: the changes are
  // sent about 30 times a second (page units for moving; how much and about which point of the view for zooming).
  const viewOut = { dx: 0, dy: 0, f: 1, fx: 0.5, fy: 0.5, timer: 0 };

  function clampCopyView() {
    const v = copy.view, p = copy.pages.get(copy.pid), h = (p && p.h) || PadEngine.H;
    v.z = Math.min(6, Math.max(1, v.z));
    v.x = Math.min(PadEngine.W - PadEngine.W / v.z, Math.max(0, v.x));
    v.y = Math.min(Math.max(0, h - PadEngine.H / v.z), Math.max(0, v.y));
  }

  /** Fingers moved by (dx, dy) CSS pixels: the page follows them. */
  function panCopy(dx, dy) {
    const v = copy.view;
    const ux = -dx / rect.width * PadEngine.W / v.z, uy = -dy / rect.height * PadEngine.H / v.z;
    copy.view = { ...v, x: v.x + ux, y: v.y + uy };
    clampCopyView();
    viewOut.dx += ux;
    viewOut.dy += uy;
    viewMoved();
  }

  /** A pinch: zoom by `factor` about the point between the fingers. */
  function zoomCopy(factor, clientX, clientY) {
    const v = copy.view;
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)), fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const px = v.x + fx * PadEngine.W / v.z, py = v.y + fy * PadEngine.H / v.z;
    const z = Math.min(6, Math.max(1, v.z * factor));
    copy.view = { x: px - fx * PadEngine.W / z, y: py - fy * PadEngine.H / z, z };
    clampCopyView();
    sendViewMove(); // a pan waiting to go first
    viewOut.f *= factor;
    viewOut.fx = fx;
    viewOut.fy = fy;
    viewMoved();
  }

  function viewMoved() {
    copy.viewHeldUntil = performance.now() + 500;
    if (!viewOut.timer) viewOut.timer = setTimeout(sendViewMove, 33);
    drawCopy();
  }

  function sendViewMove() {
    clearTimeout(viewOut.timer);
    viewOut.timer = 0;
    if (Math.abs(viewOut.f - 1) > 1e-4) send({ t: 'wb', zoom: { f: round(viewOut.f, 1e5), fx: round(viewOut.fx, 1e4), fy: round(viewOut.fy, 1e4) } });
    if (viewOut.dx || viewOut.dy) send({ t: 'wb', pan: { dx: round(viewOut.dx, 100), dy: round(viewOut.dy, 100) } });
    viewOut.dx = viewOut.dy = 0;
    viewOut.f = 1;
  }

  function drawCopy() {
    if (!nativeActive || copyFrame) return;
    // The next frame, or very soon if frames are held back (a page in the background still keeps up).
    copyFrame = requestAnimationFrame(paintCopy);
    copyTimer = setTimeout(paintCopy, 40);
  }

  function paintCopy() {
    cancelAnimationFrame(copyFrame);
    clearTimeout(copyTimer);
    copyFrame = 0;
    try { paintCopyNow(); } catch (e) {
      // This device can't draw the board at all: never leave a blank page, show the video of it instead.
      console.warn('Board copy failed', e);
      copyFailed = true;
      notice(`The whiteboard can't be drawn on this device (${e.message}), so it's shown as video instead.`, 10000);
      sendStream();
    }
  }

  function paintCopyNow() {
    const c = copyCanvas, ctx = copyCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const p = copy.pages.get(copy.pid);
    if (!p || !c.width) return;
    const v = copy.view, k = c.width / (PadEngine.W / v.z);
    const unit = (window.devicePixelRatio || 1) / k; // one CSS pixel here, in page units
    ctx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
    const pageNow = { bg: p.bg, h: p.h, doc: p.doc, items: p.order.filter((id) => !copy.hidden.has(id)).map((id) => p.items.get(id)).filter(Boolean) };
    PadEngine.renderPage(ctx, pageNow);
    const dark = PadEngine.isDark(pageNow);
    for (const s of localInk.done) PadEngine.drawItem(ctx, s, dark);
    if (localInk.cur) PadEngine.drawItem(ctx, localInk.cur, dark);
    const L = copy.live || {};
    {
      // The board's stroke in progress is the one drawn here already: don't draw it twice.
      if (L.preview && !(localInk.cur && L.preview.type === 'stroke')) PadEngine.drawItem(ctx, L.preview, dark);
      ctx.save();
      ctx.strokeStyle = '#2f6bff';
      ctx.lineWidth = 2 * unit;
      if (L.sel) {
        const f = L.sel, b = f.box, m = 8 * unit;
        ctx.save();
        if (f.rot) { ctx.translate(f.cx, f.cy); ctx.rotate((f.rot * Math.PI) / 180); ctx.translate(-f.cx, -f.cy); }
        ctx.setLineDash([8 * unit, 6 * unit]);
        const x0 = b.x - m, y0 = b.y - m, x1 = b.x + b.w + m, y1 = b.y + b.h + m;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        // The same handles as on the PC: corners resize proportionally, edge handles change one dimension, and the
        // round knob turns the selection.
        ctx.setLineDash([]);
        const knob = [(x0 + x1) / 2, y0 - 34 * unit];
        ctx.beginPath();
        ctx.moveTo(knob[0], y0);
        ctx.lineTo(knob[0], knob[1] + 11 * unit);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(knob[0], knob[1], 11 * unit, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const hs = 14 * unit;
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
          ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
          ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
        }
        const es = 12 * unit, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        for (const [x, y] of f.text ? [[x1, my], [x0, my]] : [[mx, y0], [x1, my], [mx, y1], [x0, my]]) { // text: width only
          ctx.fillRect(x - es / 2, y - es / 2, es, es);
          ctx.strokeRect(x - es / 2, y - es / 2, es, es);
        }
        ctx.restore();
      }
      if (L.marquee) {
        const [x0, y0, x1, y1] = L.marquee;
        ctx.fillStyle = 'rgba(47, 107, 255, 0.08)';
        ctx.setLineDash([6 * unit, 4 * unit]);
        ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      const er = copy.eraser || L.eraser; // this device's own eraser, or the PC's
      if (er) {
        ctx.setLineDash([]);
        ctx.strokeStyle = dark ? '#fff' : '#555';
        ctx.lineWidth = 1.5 * unit;
        ctx.beginPath();
        ctx.arc(er[0], er[1], er[2], 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------- input ----------

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const round = (v, n) => Math.round(v * n) / n;
  // Positions on the PC screen (0..1), through the phone's zoomed view when there is one.
  const normX = (clientX) => round(CX(clamp01(view.x + (clientX - rect.left) / rect.width / view.z)), 1e5);
  const normY = (clientY) => round(CY(clamp01(view.y + (clientY - rect.top) / rect.height * view.h)), 1e5);

  // ---------- just the board page ----------
  // In whiteboard mode the iPad shows only the PC board's page, as big as it fits: it asks the PC for that part of the
  // screen (as a view, like a phone zoomed in) and its Pencil reaches only the page. The view (and zooming on a phone)
  // then works inside the page: view positions are fractions of the page, and CX/CY (UX/UY) turn them into
  // fractions of the PC screen (and back).
  const CX = (v) => (crop ? crop.x + v * crop.w : v);
  const CY = (v) => (crop ? crop.y + v * crop.h : v);
  const UX = (v) => (crop ? (v - crop.x) / crop.w : v);
  const UY = (v) => (crop ? (v - crop.y) / crop.h : v);

  function applyCrop() {
    const next = wbOn && settings.boardOnly && pcPage ? pcPage : null;
    const same = (a, b) => a === b || (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
    if (same(next, crop)) return;
    crop = next;
    view.x = 0; view.y = 0; view.z = 1; view.h = 1;
    document.body.classList.toggle('page-only', !!crop);
    sizeSurface();
    sendView();
    sendStream(); // the picture's new size: a matching resolution
  }

  // ---------- zooming the PC screen on a phone ----------
  // A phone shows the whole PC screen at about a fifth of its size. There, a pinch zooms this view (the PC isn't
  // touched) and the PC sends only the part in view, at full detail, so text stays sharp. Two fingers move around,
  // and scroll the PC once the view reaches an edge. While zoomed in, the view follows the PC's pointer when it
  // leaves the view (the PC moves it; frames say so). The magnifier button makes a pinch zoom the PC app again.
  const VIEW_MAX = 6;
  const view = { x: 0, y: 0, z: 1, h: 1 }; // z: zoom (width in view = 1/z); h: height in view (0..1)
  let viewSeq = 0;
  let viewTimer = 0;
  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d');
  let frameView = { x: 0, y: 0, w: 1, h: 1 };

  /** Phones (and other small screens) zoom their own view, while the PC screen is showing. */
  const viewCapable = () => isPhone || compact();
  const pinchZoomsView = () => viewCapable() && streaming && !settings.pcPinch && !nativeActive;

  /** A frame arrived (tag: the part of the screen it shows). */
  function showFrame(source, w, h, tag) {
    if (frameCanvas.width !== w || frameCanvas.height !== h) { frameCanvas.width = w; frameCanvas.height = h; }
    frameCtx.drawImage(source, 0, 0, w, h);
    if (tag) {
      frameView = { x: UX(tag.x), y: UY(tag.y), w: tag.w / (crop ? crop.w : 1), h: tag.h / (crop ? crop.h : 1) };
      // The PC moved the view to follow the pointer: take it, unless fingers are on the screen.
      if (!crop && tag.followed && tag.seq === viewSeq && touches.size === 0 && (tag.x !== view.x || tag.y !== view.y)) {
        view.x = tag.x; view.y = tag.y;
        clampView();
        updateViewBar();
        kick();
      }
    }
    paintScreen();
  }

  /** Draw the last frame as the view now is (a pinch shows straight away; the sharp picture follows). */
  function paintScreen() {
    if (!frameCanvas.width) return;
    const W = screenCanvas.width, H = screenCanvas.height;
    // Where the frame's part of the PC screen falls in this view.
    const dx = (frameView.x - view.x) * view.z * W, dy = (frameView.y - view.y) / view.h * H;
    const dw = frameView.w * view.z * W, dh = frameView.h / view.h * H;
    if (Math.abs(dw - W) > 0.5 || Math.abs(dh - H) > 0.5 || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      screenCtx.fillStyle = '#e6e9f0';
      screenCtx.fillRect(0, 0, W, H);
    }
    screenCtx.drawImage(frameCanvas, dx, dy, dw, dh);
  }

  function clampView() {
    view.z = Math.min(VIEW_MAX, Math.max(1, view.z));
    if (view.z < 1.02) { view.z = 1; view.x = 0; view.y = 0; view.h = 1; }
    view.x = Math.min(1 - 1 / view.z, Math.max(0, view.x));
    view.y = Math.min(1 - view.h, Math.max(0, view.y));
  }

  function viewChanged() {
    clampView();
    sizeSurface(); // zooming in on an upright phone makes the picture taller
    clampView();
    paintScreen();
    updateViewBar();
    kick();
    if (!viewTimer) viewTimer = setTimeout(sendView, 50); // a few times a second while pinching
  }

  function sendView() {
    clearTimeout(viewTimer);
    viewTimer = 0;
    viewSeq = (viewSeq + 1) & 0xffff;
    const cw = crop ? crop.w : 1, ch = crop ? crop.h : 1;
    send({ t: 'view', x: CX(view.x), y: CY(view.y), w: cw / view.z, h: view.h * ch, follow: settings.follow && !crop, seq: viewSeq });
  }

  function resetView() {
    view.x = 0; view.y = 0; view.z = 1; view.h = 1;
    viewChanged();
  }

  /** Zoom the view by `factor` around a point on the screen. */
  function zoomViewAt(clientX, clientY, factor) {
    const fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
    const px = view.x + fx / view.z, py = view.y + fy * view.h; // the PC point under the fingers stays there
    view.z = Math.min(VIEW_MAX, Math.max(1, view.z * factor));
    sizeSurface(); // the picture may have grown taller: where are the fingers in it now?
    const fx2 = (clientX - rect.left) / rect.width, fy2 = (clientY - rect.top) / rect.height;
    view.x = px - fx2 / view.z;
    view.y = py - fy2 * view.h;
    viewChanged();
  }

  /** Move the view with the fingers (content follows them). Returns what's left over at an edge, in px. */
  function panView(dx, dy) {
    const bx = view.x, by = view.y;
    view.x -= dx / rect.width / view.z;
    view.y -= dy / rect.height * view.h;
    clampView();
    const usedX = (bx - view.x) * rect.width * view.z, usedY = (by - view.y) / view.h * rect.height;
    if (view.x !== bx || view.y !== by) viewChanged();
    return [dx - usedX, dy - usedY];
  }

  /** A pinch on a phone: zoom around the fingers, and move with them. */
  function pinchView(d, x, y) {
    zoomViewAt(x, y, d / gesture.lastSpread);
    gesture.lastSpread = d;
    if (gesture.mid) panView(x - gesture.mid[0], y - gesture.mid[1]);
    gesture.mid = [x, y];
  }

  /** The zoom bar under the picture (phones): the magnifier (pinch zooms the PC app instead) and Whole screen. */
  function updateViewBar() {
    const bar = $('#viewBar');
    const show = viewCapable() && streaming;
    bar.hidden = !show;
    if (!show) return;
    const zoomed = view.z > 1;
    $('#viewFit').hidden = !zoomed;
    $('#viewLevel').textContent = `${view.z.toFixed(view.z < 2 ? 1 : 0)}×`;
    $('#pcZoomBtn').classList.toggle('on', !!settings.pcPinch);
    $('#pcZoomBtn').setAttribute('aria-pressed', String(!!settings.pcPinch));
    // Under the picture when there's room (iPhone upright), otherwise over its bottom edge.
    const r = surface.getBoundingClientRect();
    const h = bar.offsetHeight || 44;
    // Room ends at the tool dock when it's along the bottom (a phone held upright), else near the screen's edge.
    const dock = $('#rail').getBoundingClientRect();
    const room = dock.width > dock.height && dock.top > r.top ? dock.top - 6 : innerHeight - 16;
    const top = r.bottom + 10 + h <= room ? r.bottom + 10 : r.bottom - h - 10;
    bar.style.top = `${Math.max(8, top)}px`;
    bar.style.left = `${r.left + r.width / 2}px`;
  }
  $('#viewFit').addEventListener('click', resetView);
  $('#pcZoomBtn').addEventListener('click', () => {
    saveSetting('pcPinch', !settings.pcPinch);
    updateViewBar();
    wbFlash(settings.pcPinch ? 'Pinch zooms the PC app' : 'Pinch zooms this view');
  });
  $('#nativeToggle').addEventListener('change', (e) => { saveSetting('nativeBoard', e.target.checked); sendStream(); });
  $('#boardOnlyToggle').addEventListener('change', (e) => { saveSetting('boardOnly', e.target.checked); applyCrop(); });
  $('#followToggle').addEventListener('change', (e) => { saveSetting('follow', e.target.checked); if (view.z > 1) sendView(); });

  function sample(e) {
    let p;
    if (e.pointerType === 'pen') p = e.pressure;
    else p = e.buttons ? 0.5 : 0; // finger / mouse have no real pressure
    return [normX(e.clientX), normY(e.clientY), round(p, 1e3), Math.round(e.tiltX || 0), Math.round(e.tiltY || 0)];
  }

  let stroke = null;          // the Pencil (or mouse, or a finger acting like the Pencil) currently pressing
  let leaveTimer = 0;
  let penQuietUntil = 0;

  function notePen() { penQuietUntil = performance.now() + PEN_QUIET_MS; }
  const penBusy = () => (stroke && stroke.type === 'pen') || performance.now() < penQuietUntil;

  // ---- Pencil: light touch moves, firm press clicks ----
  // Most iPads can't sense the Pencil hovering, so where the Pencil acts as a mouse a light touch moves the
  // cursor and only a firm press clicks or drags. A quick light tap still clicks. Drawing apps keep real pressure.

  const useLightTouch = (type) => type === 'pen' && settings.light && !laserOn() && targetKind === 'mouse';

  function lightSamples(samples) {
    const press = settings.firmness;
    const release = press * 0.6; // lower than the press level so it doesn't flicker
    for (const s of samples) {
      if (!stroke.pressed && s[2] >= press) {
        sendPen('down', [s]);
        stroke.pressed = true;
      } else if (stroke.pressed && s[2] < release) {
        sendPen('up', [s]);
        stroke.pressed = false;
        sendPen('hover', [s]);
      } else {
        sendPen(stroke.pressed ? 'move' : 'hover', [s]);
      }
      const dx = (s[0] - stroke.start[0]) / (crop ? crop.w : 1) * rect.width;
      const dy = (s[1] - stroke.start[1]) / (crop ? crop.h : 1) * rect.height;
      stroke.moved = Math.max(stroke.moved, Math.hypot(dx, dy));
      if (stroke.pressed) trail(stroke.last, s);
      stroke.last = s;
    }
    moveCursor(stroke.last, stroke.pressed);
  }

  function endLightStroke(s) {
    if (stroke.pressed) {
      sendPen('up', [s]);
    } else if (performance.now() - stroke.startTime < TAP_MS && stroke.moved < TAP_MOVE_PX) {
      sendPen('down', [stroke.start]); // a quick light tap: click where it landed
      sendPen('up', [stroke.start]);
    }
    stroke = null;
    moveCursor(s, false);
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => sendPen('leave'), LEAVE_DELAY);
  }

  function beginStroke(id, type, samples) {
    if (nativeActive && tool !== 'laser') { // the board drawn here: nothing goes through Windows
      if (inkHere()) beginInk(id, type, samples); // pen, highlighter, eraser: drawn here, sent as a drawing
      else beginPagePointer(id, type, samples); // Select, shapes, text, math: the board's own tools, by page position
      return;
    }
    if (useLightTouch(type)) {
      const first = samples[0];
      stroke = { id, type, light: true, pressed: false, start: first, startTime: performance.now(), moved: 0, last: first };
      lightSamples(samples);
      return;
    }
    stroke = { id, type, last: samples[samples.length - 1] };
    sendPen('down', samples);
    for (let i = 1; i < samples.length; i++) trail(samples[i - 1], samples[i]);
    moveCursor(stroke.last, true);
  }

  function moveStroke(samples) {
    if (stroke.ink) { moveInk(samples); return; }
    if (stroke.page) { movePagePointer(samples); return; }
    if (stroke.light) { lightSamples(samples); return; }
    sendPen('move', samples);
    for (const s of samples) { trail(stroke.last, s); stroke.last = s; }
    moveCursor(stroke.last, true);
  }

  function endStroke(s) {
    if (stroke.ink) { endInk(s); return; }
    if (stroke.page) { endPagePointer(s); return; }
    if (stroke.light) { endLightStroke(s); return; }
    sendPen('up', [s]);
    const type = stroke.type;
    stroke = null;
    moveCursor(s, false);
    clearTimeout(leaveTimer);
    if (type === 'pen') leaveTimer = setTimeout(() => sendPen('leave'), LEAVE_DELAY);
    else if (type === 'touch') sendPen('leave');
  }

  // ---- Fingers ----
  // "Tap and scroll" (default): tap = click, drag = scroll, long-press or two-finger tap = right-click.
  // "Act like the Pencil": a finger draws/drags like the Pencil; two fingers scroll.
  // Palm rejection: fingers are ignored while the Pencil is in use and just after.

  const touches = new Map();  // pointerId -> { x, y } (client px) of fingers in the current gesture
  const ignored = new Set();  // pointerIds ignored until they lift (palm, or fingers off)
  let gesture = null;         // { kind: 'one'|'two'|'hand', t0, x0, y0, moved, scrolling, longFired, long, penTimer, samples }
  let scrollBase = null;      // { x, y, ax, ay, pointSent }

  function centroid() {
    let x = 0, y = 0;
    for (const t of touches.values()) { x += t.x; y += t.y; }
    return [x / touches.size, y / touches.size];
  }

  function resetScrollBase() {
    if (touches.size === 0) { scrollBase = null; return; }
    const [x, y] = centroid();
    scrollBase = { x, y, ax: scrollBase?.ax || 0, ay: scrollBase?.ay || 0, pointSent: scrollBase?.pointSent || false };
  }

  function scrollWith(x, y) {
    if (!scrollBase) return;
    if (nativeActive) { panCopy(x - scrollBase.x, y - scrollBase.y); scrollBase.x = x; scrollBase.y = y; return; }
    // Natural scrolling: content follows the fingers.
    scrollBase.ay += (y - scrollBase.y) * SCROLL_GAIN;
    scrollBase.ax -= (x - scrollBase.x) * SCROLL_GAIN;
    scrollBase.x = x;
    scrollBase.y = y;
    const dy = Math.trunc(scrollBase.ay);
    const dx = Math.trunc(scrollBase.ax);
    if (!dx && !dy) return;
    scrollBase.ax -= dx;
    scrollBase.ay -= dy;
    const msg = { t: 'scroll', dx, dy };
    if (!scrollBase.pointSent) {
      // First scroll of the gesture: scroll whatever is under the finger(s).
      msg.x = normX(gesture.x0);
      msg.y = normY(gesture.y0);
      scrollBase.pointSent = true;
    }
    send(msg);
  }

  function click(clientX, clientY, right) {
    const x = normX(clientX), y = normY(clientY);
    send({ t: 'click', x, y, right });
    ripple(x, y, right);
  }

  function abortFingers() {
    if (gesture) { clearTimeout(gesture.long); clearTimeout(gesture.penTimer); }
    if (stroke && stroke.type === 'touch') endStroke(stroke.last);
    for (const id of touches.keys()) ignored.add(id);
    touches.clear();
    gesture = null;
    scrollBase = null;
  }

  function abortInput() {
    stroke = null;
    abortFingers();
    ignored.clear();
  }

  function fingerDown(e) {
    if (settings.fingers === 'off' || penBusy()) { ignored.add(e.pointerId); return; }

    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();

    if (touches.size === 1) {
      gesture = { kind: 'one', id: e.pointerId, t0: now, x0: e.clientX, y0: e.clientY, moved: 0, scrolling: false, longFired: false, samples: [sample(e)] };
      // Long-press = right-click in both finger modes (on a phone it's the only quick way to right-click).
      // "Act like the Pencil" starts its stroke only once the finger moves, so a still finger can be a long-press.
      gesture.long = setTimeout(() => {
        if (gesture && gesture.kind === 'one' && !gesture.scrolling) {
          gesture.longFired = true;
          click(gesture.x0, gesture.y0, true);
        }
      }, LONG_PRESS_MS);
    } else if (touches.size === 2 && gesture && gesture.kind === 'one' && !gesture.scrolling && !gesture.longFired && !stroke) {
      clearTimeout(gesture.long);
      clearTimeout(gesture.penTimer);
      const [x, y] = centroid();
      const d = spread();
      gesture = { kind: 'two', t0: gesture.t0, x0: x, y0: y, moved: 0, scrolling: false, pinching: false, spread0: d, lastSpread: d, zoomAcc: 0, zoomPointSent: false };
    } else if (touches.size === 3 && wbOn && gesture && gesture.kind === 'two' && !gesture.scrolling && !gesture.pinching) {
      // Whiteboard mode: a third finger joining a fresh two-finger touch may be a three-finger tap (Redo).
      const [x, y] = centroid();
      gesture = { kind: 'three', t0: gesture.t0, x0: x, y0: y, moved: 0 };
    } else {
      // A third finger, or a second one mid-gesture: a resting hand. Stop and wait for all fingers to lift.
      if (gesture) { clearTimeout(gesture.long); clearTimeout(gesture.penTimer); }
      if (stroke && stroke.type === 'touch') endStroke(stroke.last);
      gesture = { kind: 'hand' };
    }
    resetScrollBase();
  }

  function startFingerStroke() {
    if (!gesture || gesture.kind !== 'one' || stroke) return;
    gesture.kind = 'stroke';
    beginStroke(gesture.id, 'touch', gesture.samples);
  }

  function fingerMove(e) {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture || gesture.kind === 'hand') return;

    if (gesture.kind === 'stroke') {
      if (stroke && stroke.id === e.pointerId) moveStroke([sample(e)]);
      return;
    }

    const [x, y] = centroid();
    gesture.moved = Math.max(gesture.moved, Math.hypot(x - gesture.x0, y - gesture.y0));
    if (gesture.kind === 'three') { if (gesture.moved > TAP_SLOP * 2) gesture = { kind: 'hand' }; return; }
    if (gesture.kind === 'one') {
      gesture.samples.push(sample(e));
      if (settings.fingers === 'pencil') {
        if (gesture.moved > 8 && !gesture.longFired) {
          clearTimeout(gesture.long);
          startFingerStroke();
        }
        return;
      }
    }
    if (gesture.kind === 'two' && !gesture.pinching && touches.size === 2) {
      // Fingers spreading or closing = pinch (zoom); moving together = scroll. Fingers often drift a little before
      // they spread, so a clear spread still turns a scroll into a pinch.
      const change = Math.abs(spread() / gesture.spread0 - 1);
      if (change > PINCH_START && (!gesture.scrolling || change > PINCH_START * 2)) {
        if (gesture.scrolling) gesture.lastSpread = spread(); // zoom from here, not from where the fingers began
        gesture.pinching = true;
        gesture.scrolling = false;
      }
    }
    if (gesture.pinching) {
      if (touches.size === 2) { if (pinchZoomsView()) pinchView(spread(), x, y); else zoomWith(spread(), x, y); }
      return;
    }
    if (!gesture.scrolling && gesture.moved > TAP_SLOP) {
      gesture.scrolling = true;
      clearTimeout(gesture.long);
    }
    if (gesture.scrolling) {
      // Zoomed in on a phone: two fingers move the view first, and scroll the PC once it reaches an edge.
      if (pinchZoomsView() && view.z > 1 && scrollBase) {
        const [lx, ly] = panView(x - scrollBase.x, y - scrollBase.y);
        scrollBase.x = x - lx;
        scrollBase.y = y - ly;
      }
      scrollWith(x, y);
    }
  }

  /** Distance between the two fingers. */
  function spread() {
    const [a, b] = [...touches.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  /**
   * Pinch = Ctrl + mouse wheel on the PC, the standard Windows zoom: the whiteboard, Chrome, Office and PDF
   * viewers all zoom around the point between the fingers. Sent in whole wheel notches, because some apps
   * zoom one step per notch however small the turn.
   */
  function zoomWith(d, x, y) {
    if (nativeActive) { zoomCopy(d / gesture.lastSpread, x, y); gesture.lastSpread = d; return; }
    gesture.zoomAcc += Math.log(d / gesture.lastSpread) * ZOOM_GAIN;
    gesture.lastSpread = d;
    while (Math.abs(gesture.zoomAcc) >= 120) {
      const delta = gesture.zoomAcc > 0 ? 120 : -120;
      gesture.zoomAcc -= delta;
      const msg = { t: 'zoom', delta };
      if (!gesture.zoomPointSent) {
        msg.x = normX(x);
        msg.y = normY(y);
        gesture.zoomPointSent = true;
      }
      send(msg);
    }
  }

  function fingerUp(e) {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    const cancelled = e.type === 'pointercancel';

    if (gesture && gesture.kind === 'stroke' && stroke && stroke.id === e.pointerId) {
      endStroke(cancelled ? stroke.last : sample(e));
    }
    if (touches.size > 0) { resetScrollBase(); if (gesture) gesture.mid = null; return; } // wait until every finger is up
    if (viewTimer) sendView(); // the last bit of a pinch

    const g = gesture;
    gesture = null;
    scrollBase = null;
    if (!g || cancelled) return;
    clearTimeout(g.long);
    clearTimeout(g.penTimer);

    if (g.kind === 'one' && !g.scrolling && !g.longFired) {
      if (settings.fingers === 'pencil') {
        // A quick tap acting like the Pencil: press and release where it landed.
        beginStroke(e.pointerId, 'touch', [g.samples[0]]);
        endStroke(g.samples[0]);
      } else if (!(wbOn && WB_INK_TOOLS.has(wbGroup(wb.tool)))) {
        if (nativeActive) pageTap(g.samples[0]); // the board drawn here: tap its page directly
        else click(g.x0, g.y0, false);
      } // whiteboard with a drawing tool: a finger tap does nothing (only the Pencil draws on an iPad)
    } else if (g.kind === 'two' && !g.scrolling && !g.pinching && performance.now() - g.t0 < TWO_TAP_MS) {
      if (wbOn) wbTwoFingerTap(); // whiteboard: Undo (twice quickly: the whole page)
      else click(g.x0, g.y0, true); // two-finger tap = right-click
    } else if (g.kind === 'three' && performance.now() - g.t0 < TWO_TAP_MS * 1.5) {
      wbThreeFingerTap(); // whiteboard: Redo
    }
  }

  // ---- event wiring ----

  function hideHint() { hint.style.opacity = 0; }

  surface.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rect = surface.getBoundingClientRect();
    hideHint();
    try { surface.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }

    if (e.pointerType === 'pen') {
      clearTimeout(leaveTimer);
      notePen();
      abortFingers(); // whatever was touching before the Pencil landed is a resting hand
      if (stroke) endStroke(stroke.last);
      beginStroke(e.pointerId, 'pen', [sample(e)]);
    } else if (e.pointerType === 'mouse') {
      if (e.button === 0) beginStroke(e.pointerId, 'mouse', [sample(e)]);
    } else {
      fingerDown(e);
    }
  }, { passive: false });

  surface.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen') notePen();
    if (ignored.has(e.pointerId)) return;

    if (e.pointerType === 'touch') { fingerMove(e); return; }

    if (stroke && e.pointerId === stroke.id) {
      const events = e.getCoalescedEvents?.() || [];
      moveStroke((events.length ? events : [e]).map(sample));
      return;
    }

    // Pencil hover (iPad Pro M2 and later) or mouse hover when testing from a desktop browser.
    if ((e.pointerType === 'pen' || e.pointerType === 'mouse') && e.buttons === 0) {
      clearTimeout(leaveTimer);
      rect = surface.getBoundingClientRect();
      const s = sample(e);
      sendPen('hover', [s]);
      moveCursor(s, false);
    }
  });

  function onPointerEnd(e) {
    if (e.pointerType === 'pen') notePen();
    if (ignored.delete(e.pointerId)) return;
    if (e.pointerType === 'touch') { fingerUp(e); return; }
    if (stroke && e.pointerId === stroke.id) endStroke(e.type === 'pointercancel' ? stroke.last : sample(e));
  }

  surface.addEventListener('pointerup', onPointerEnd);
  surface.addEventListener('pointercancel', onPointerEnd);
  surface.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'pen' && !stroke) {
      clearTimeout(leaveTimer);
      sendPen('leave');
    }
  });

  // Stop iOS from scrolling, zooming, selecting or showing callouts on the drawing surface.
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    surface.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  surface.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- class tools: countdown timer and random name picker ----------
  // Both run on the PC (they keep going if this device sleeps) and show on the PC screen; this panel controls them.
  // The panel itself is shared with the whiteboard on the PC (class.js), and the PC tells both about every change.

  const classPanel = PadClass.Panel({
    tabs: $('#classTabs'),
    body: $('#classBody'),
    send,
    notice,
    connected: () => connected,
    self: 'pad',
    openGrid: openStudentGrid, // over everything here
    onStudents(m) { // raised hands (✋), and students waiting to be let in: a badge on the Class tools button
      let badge = $('#studentsBadge');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'studentsBadge';
        badge.className = 'students-badge';
        $('#classBtn').appendChild(badge);
      }
      const hands = m.open ? (m.hands || []).length : 0, waiting = m.open ? m.waiting || 0 : 0;
      badge.hidden = !(hands || waiting);
      badge.classList.toggle('hand', hands > 0);
      badge.textContent = [hands ? `✋${hands}` : '', waiting ? String(waiting) : ''].filter(Boolean).join(' · ');
      badge.title = [hands ? `${hands} hand${hands === 1 ? '' : 's'} up` : '', waiting ? `${waiting} student${waiting === 1 ? '' : 's'} waiting to be let in` : ''].filter(Boolean).join(', ');
    },
    timesUp: showTimesUp, // a blue box like the PC's (the PC's own isn't in this device's picture)
    deviceSound: true,
    store,
    onTimer(state, text) {
      const badge = $('#classBadge');
      badge.hidden = state === 'idle';
      badge.textContent = text;
      badge.classList.toggle('done', state === 'done');
      if (state !== 'done') $('#timesUp').hidden = true; // a new countdown, or stopped
    },
  });

  /** Time's up: a pulsing blue box in the bottom-right corner, like the one on the PC screen. Tap to close it. */
  let timesUpTimer = 0;
  function showTimesUp() {
    const box = $('#timesUp');
    box.hidden = false;
    clearTimeout(timesUpTimer);
    timesUpTimer = setTimeout(() => { box.hidden = true; }, 20000); // as long as the PC shows its own
  }
  $('#timesUp').addEventListener('click', () => { $('#timesUp').hidden = true; });

  /** The teacher's grid of student boards (Class tools → Students), over everything until it's closed. */
  let studentGrid = null;
  function openStudentGrid(url) {
    if (studentGrid) return;
    openClass(false);
    studentGrid = document.createElement('div');
    studentGrid.className = 'student-grid';
    const frame = document.createElement('iframe');
    frame.title = 'Student boards';
    // The PC serves the grid. In PadLink Go it's Go's own copy of that page (only its connection goes to the PC), as a
    // page from Remote mode's address can't open inside Go (Microsoft's tunnel notice stops it).
    frame.src = host ? new URL('teacher.html' + new URL(url, PC + '/').search, location.href).href : new URL(url, PC + '/').href;
    studentGrid.appendChild(frame);
    document.body.appendChild(studentGrid);
  }
  window.addEventListener('message', (e) => {
    if ((e.origin === pcOrigin || (host && e.origin === location.origin)) && e.data && e.data.padlink === 'closeGrid' && studentGrid) { studentGrid.remove(); studentGrid = null; }
  });

  function openClass(open) {
    if (open) openSettings(false);
    $('#classPanel').hidden = !open;
    $('#scrim').hidden = !open;
    $('#classBtn').classList.toggle('on', open);
    if (open) classPanel.opened();
  }
  $('#classBtn').addEventListener('click', () => openClass($('#classPanel').hidden));
  $('#closeClass').addEventListener('click', () => openClass(false));
  $('#scrim').addEventListener('click', () => openClass(false));

  // ---------- start ----------

  applySettingsUI();
  updateToolChip();
  renderWb();
  document.body.classList.toggle('bar-hidden', settings.barHidden);
  $('#showBar').hidden = !settings.barHidden;
  layout();
  start();
})();
