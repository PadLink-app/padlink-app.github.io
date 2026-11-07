// PadLink Go's encrypted WebRTC connection to the classroom PC (Remote mode over WebRTC). The PC's pairing QR code
// says where to find it (its signaling server and room) and which key is really the PC's; this connects
// directly to the PC (or through a TURN relay when a firewall is in the way), end-to-end encrypted with DTLS, and
// refuses any answer the PC didn't sign, so even the signaling server can't listen in or stand in for the PC.
//
// Over that connection the pages use the PC as if it were on the school network: link.fetch(path, init) answers like
// fetch(), and link.socket(path) behaves like a WebSocket. The PC makes each request again on its own web server
// (Server/RtcBridge.cs, which also describes the message format).
(() => {
  'use strict';
  const FIN = 1, TEXT = 2, OPEN = 4, CLOSE = 8;
  const CHUNK = 16 * 1024;
  const HIGH = 1 << 20;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname); // the tests: everything on one computer

  class RtcError extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
  }

  /** Signaling servers PadLink Go may use: PadLink's Cloudflare Worker (and a local one in the tests). */
  function okSignal(url) {
    return typeof url === 'string' && (/^wss:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/i.test(url) || (local && /^ws:\/\/127\.0\.0\.1:\d+$/.test(url)));
  }

  /** The one DTLS certificate fingerprint an SDP announces (lowercase hex, no colons), or null. */
  function fingerprint(sdp) {
    const all = [...new Set([...String(sdp).matchAll(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)\s*$/gim)].map((m) => m[1].replace(/:/g, '').toLowerCase()))];
    return all.length === 1 && /^[0-9a-f]{64}$/.test(all[0]) ? all[0] : null;
  }

  function unbase64url(text) {
    const b = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }

  const hex = (bytes) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');

  /**
   * Whether the answer really comes from the paired PC: its public key is the one the QR code named, and it signed
   * both this connection's certificates (Server/RtcIdentity.cs), so nobody else's certificate can be put in between.
   */
  async function verified(room, pairedKey, offerSdp, answer, id) {
    const offerFp = fingerprint(offerSdp), answerFp = fingerprint(answer.sdp);
    if (!offerFp || !answerFp || !id || typeof id.key !== 'string' || typeof id.sig !== 'string') return false;
    try {
      const spki = unbase64url(id.key);
      if (hex(await crypto.subtle.digest('SHA-256', spki)) !== pairedKey) return false;
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const statement = enc.encode(`PadLink WebRTC 1\n${room}\n${offerFp}\n${answerFp}`);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unbase64url(id.sig), statement);
    } catch { return false; }
  }

  /** One data channel: messages in parts of at most 16 KB, sent in order, waiting while the channel is full. */
  class Lane {
    constructor(link, dc) {
      this.dc = dc;
      this.queue = Promise.resolve();
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = HIGH / 4;
      this.opened = new Promise((resolve, reject) => {
        dc.addEventListener('open', resolve, { once: true });
        dc.addEventListener('close', () => reject(new RtcError('closed')), { once: true });
      });
      this.opened.catch(() => { /* reported by the link */ });
      dc.addEventListener('message', (e) => {
        const m = new Uint8Array(e.data);
        if (m.length < 5) return;
        const id = new DataView(e.data).getUint32(1, true);
        const s = link.streams.get(id);
        if (s) s.part(m[0], m.subarray(5));
      });
      dc.addEventListener('close', () => { if (link.lanes && (link.lanes.live === this || link.lanes.bulk === this)) link.die(); });
    }

    send(id, flags, bytes = new Uint8Array(0)) {
      const run = async () => {
        let offset = 0;
        do {
          const n = Math.min(CHUNK, bytes.length - offset);
          const last = offset + n >= bytes.length;
          const part = new Uint8Array(5 + n);
          part[0] = last ? flags : flags & ~FIN;
          new DataView(part.buffer).setUint32(1, id, true);
          part.set(bytes.subarray(offset, offset + n), 5);
          if (this.dc.readyState !== 'open') throw new RtcError('closed');
          if (this.dc.bufferedAmount > HIGH) await new Promise((resolve) => this.dc.addEventListener('bufferedamountlow', resolve, { once: true }));
          this.dc.send(part);
          offset += n;
        } while (offset < bytes.length);
      };
      const p = this.queue.then(run);
      this.queue = p.catch(() => { /* the next message still goes */ });
      return p;
    }
  }

  /** A stream's message parts put back together. onClose(lost) is told whether the connection itself ended. */
  function collector(onMessage, onClose) {
    let parts = [];
    let size = 0;
    return {
      part(flags, bytes) {
        if (flags & CLOSE) { onClose(false); return; }
        parts.push(bytes.slice());
        size += bytes.length;
        if (!(flags & FIN)) return;
        const whole = parts.length === 1 ? parts[0] : new Uint8Array(size);
        if (parts.length > 1) { let o = 0; for (const p of parts) { whole.set(p, o); o += p.length; } }
        parts = [];
        size = 0;
        onMessage(!!(flags & TEXT), whole);
      },
      close: () => onClose(true),
    };
  }

  class Link {
    constructor(info) {
      this.info = info;
      this.pc = null;
      this.lanes = null;
      this.streams = new Map();
      this.nextId = 1;
      this.ready = null;
      this.dead = true;
      this.up = false; // connected (its lanes opened) at least once
    }

    /** Connected once, but not any more: the iPad slept, or the network changed, and no close event came. */
    stale() {
      if (this.dead || !this.up) return false;
      const st = this.pc ? this.pc.connectionState : 'closed';
      return !this.lanes || st === 'failed' || st === 'closed' || st === 'disconnected'
        || this.lanes.live.dc.readyState !== 'open' || this.lanes.bulk.dc.readyState !== 'open';
    }

    /** Connected (connecting now if needed). Rejects with .kind: offline, unreachable, identity, refused or signal. */
    open() {
      if (this.stale()) this.die(); // start a new connection instead of using the old one
      if (!this.dead && this.ready) return this.ready;
      this.dead = false;
      this.up = false;
      this.ready = this.connect().then(() => { this.up = true; }, (e) => { this.die(); throw e; });
      return this.ready;
    }

    connect() {
      const { s, r, f } = this.info;
      return new Promise((resolve, reject) => {
        let ws = null, pc = null, done = false, online = false, offered = false, iceServers = [];
        const pending = [];
        let offlineTimer = 0;
        const timer = setTimeout(() => fail(online ? 'unreachable' : 'offline'), 25000);
        const fail = (kind) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(offlineTimer);
          try { if (ws) ws.close(); } catch { /* closed */ }
          if (pc) try { pc.close(); } catch { /* closed */ }
          reject(new RtcError(kind));
        };
        const signal = (data) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'signal', data })); };
        const start = async () => {
          if (offered || done) return;
          offered = true;
          clearTimeout(offlineTimer);
          pc = this.pc = new RTCPeerConnection({ iceServers });
          this.lanes = {
            live: new Lane(this, pc.createDataChannel('live', { ordered: true })),
            bulk: new Lane(this, pc.createDataChannel('bulk', { ordered: true })),
          };
          pc.addEventListener('icecandidate', (e) => { if (e.candidate && e.candidate.candidate) signal({ candidate: e.candidate.toJSON() }); });
          pc.addEventListener('connectionstatechange', () => {
            const st = pc.connectionState;
            if (this.pc !== pc) return; // an earlier connection, already replaced
            if (st === 'failed' || st === 'closed') { if (done) this.die(); else fail('unreachable'); }
            else if (st === 'disconnected') setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') this.die(); }, 8000);
          });
          Promise.all([this.lanes.live.opened, this.lanes.bulk.opened]).then(() => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            setTimeout(() => { try { ws.close(); } catch { /* closed */ } }, 1000); // signaling was only for this
            resolve();
          }, () => fail('unreachable'));
          await pc.setLocalDescription(await pc.createOffer());
          signal({ sdp: { type: 'offer', sdp: pc.localDescription.sdp } });
        };
        try { ws = new WebSocket(s.replace(/\/+$/, '') + '/join/' + r); }
        catch { fail('signal'); return; }
        ws.addEventListener('close', (e) => { if (!done) fail(e.code === 4001 ? 'refused' : online ? 'unreachable' : 'signal'); });
        ws.addEventListener('message', async (e) => {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'hello') {
            iceServers = Array.isArray(m.iceServers) ? m.iceServers : [];
            online = !!m.pc;
            if (online) start().catch(() => fail('unreachable'));
            else offlineTimer = setTimeout(() => fail('offline'), 8000); // the PC may be reconnecting to signaling
          } else if (m.t === 'pc') {
            online = !!m.online;
            if (online) start().catch(() => fail('unreachable'));
          } else if (m.t === 'signal' && m.data && pc) {
            try {
              if (m.data.sdp && m.data.sdp.type === 'answer') {
                if (!(await verified(r, f, pc.localDescription.sdp, m.data.sdp, m.data.id))) { fail('identity'); return; } // not the paired PC
                await pc.setRemoteDescription(m.data.sdp);
                for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => { /* unusable here */ });
              } else if (m.data.candidate) {
                if (pc.remoteDescription) await pc.addIceCandidate(m.data.candidate).catch(() => { /* unusable here */ });
                else pending.push(m.data.candidate);
              }
            } catch { fail('unreachable'); }
          }
        });
      });
    }

    /** The connection ended: every request and socket on it ends too, and the next use connects again. */
    die() {
      if (this.dead) return;
      this.dead = true;
      const streams = [...this.streams.values()];
      this.streams.clear();
      for (const s of streams) s.close();
      try { if (this.pc) this.pc.close(); } catch { /* closed */ }
      this.pc = null;
      this.lanes = null;
    }

    /** Like fetch(path, init) on the PC: a Response, or a TypeError when the PC can't be reached (as fetch does). */
    async fetch(path, init = {}) {
      try { await this.open(); } catch (e) { const err = new TypeError('Load failed'); err.kind = e.kind; throw err; }
      const method = String(init.method || 'GET').toUpperCase();
      const packed = init.body == null ? null : new Response(init.body); // the Content-Type fetch() would give the body
      const body = packed ? new Uint8Array(await packed.arrayBuffer()) : new Uint8Array(0);
      const headers = {};
      new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
      if (packed && !headers['content-type'] && packed.headers.get('content-type')) headers['content-type'] = packed.headers.get('content-type');
      const lane = this.lanes.bulk;
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        let head = null, finished = false;
        const end = (err) => {
          if (finished) return;
          finished = true;
          this.streams.delete(id);
          reject(err || new TypeError('Load failed'));
        };
        this.streams.set(id, collector((text, bytes) => {
          if (!head) { try { head = JSON.parse(dec.decode(bytes)); } catch { end(); } return; }
          if (finished) return;
          finished = true;
          this.streams.delete(id);
          const status = head.status >= 200 && head.status <= 599 ? head.status : 502;
          resolve(new Response([204, 205, 304].includes(status) ? null : bytes, { status, headers: head.headers || {} }));
        }, () => end()));
        if (init.signal) init.signal.addEventListener('abort', () => { lane.send(id, CLOSE).catch(() => {}); end(new DOMException('Aborted', 'AbortError')); }, { once: true });
        lane.send(id, OPEN | TEXT | FIN, enc.encode(JSON.stringify({ kind: 'http', method, path, headers, size: body.length })))
          .then(() => (body.length ? lane.send(id, FIN, body) : null))
          .catch(() => end());
      });
    }

    /** Like new WebSocket(…) to the PC's path. */
    socket(path) { return new RtcSocket(this, path); }

    /** Drop this connection (the PC stopped answering): every request and socket on it ends, the next use connects again. */
    reset() { this.die(); }
  }

  /** A WebSocket over the WebRTC connection: the same readyState, events, send and close. */
  class RtcSocket {
    constructor(link, path) {
      this.link = link;
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.listeners = {};
      this.id = 0;
      link.open().then(() => this.start(path), () => this.end(1006));
    }

    get bufferedAmount() { return this.link.lanes && this.link.lanes.live ? this.link.lanes.live.dc.bufferedAmount : 0; }

    start(path) {
      if (this.readyState !== 0) return;
      const id = this.id = this.link.nextId++;
      let opened = false;
      this.link.streams.set(id, collector((text, bytes) => {
        if (!opened) {
          let m = null;
          try { m = JSON.parse(dec.decode(bytes)); } catch { /* not a head */ }
          if (!m || !m.open) { this.end(1006); return; }
          opened = true;
          this.readyState = 1;
          this.fire('open', new Event('open'));
          return;
        }
        const data = text ? dec.decode(bytes) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        this.fire('message', new MessageEvent('message', { data }));
      }, (lost) => this.end(opened && !lost ? 1000 : 1006)));
      this.link.lanes.live.send(id, OPEN | TEXT | FIN, enc.encode(JSON.stringify({ kind: 'ws', path }))).catch(() => this.end(1006));
    }

    send(data) {
      if (this.readyState === 0) throw new DOMException('Still connecting', 'InvalidStateError');
      if (this.readyState !== 1) return;
      const text = typeof data === 'string';
      const bytes = text ? enc.encode(data)
        : data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : enc.encode(String(data));
      this.link.lanes.live.send(this.id, (text ? TEXT : 0) | FIN, bytes).catch(() => this.end(1006));
    }

    close() {
      if (this.readyState >= 2) return;
      if (this.id && this.link.lanes) this.link.lanes.live.send(this.id, CLOSE).catch(() => { /* gone anyway */ });
      this.end(1000);
    }

    end(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.id) this.link.streams.delete(this.id);
      if (code !== 1000) this.fire('error', new Event('error'));
      this.fire('close', new CloseEvent('close', { code, wasClean: code === 1000 }));
    }

    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    fire(type, ev) {
      const h = this['on' + type];
      if (typeof h === 'function') h.call(this, ev);
      for (const fn of this.listeners[type] || []) fn.call(this, ev);
    }
  }
  RtcSocket.CONNECTING = 0; RtcSocket.OPEN = 1; RtcSocket.CLOSING = 2; RtcSocket.CLOSED = 3;

  const links = new Map();
  window.PadLinkRtc = {
    okSignal,
    /** A pairing link's WebRTC details ({s, r, f}), or null if they aren't valid. */
    readInfo(info) {
      if (!info || typeof info.u !== 'string') return null;
      const m = /^rtc:\/\/([A-Za-z0-9_-]{43})$/.exec(info.u);
      if (!m || !okSignal(info.s) || typeof info.f !== 'string' || !/^[0-9a-f]{64}$/.test(info.f)) return null;
      return { s: info.s, r: m[1], f: info.f };
    },
    isRtc: (url) => /^rtc:\/\//.test(String(url || '')),
    /** The one connection per PC for this page. */
    link(info) {
      const key = info.s + '|' + info.r + '|' + info.f;
      if (!links.has(key)) links.set(key, new Link(info));
      return links.get(key);
    },
  };
})();
