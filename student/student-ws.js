// Student Mode: a WebSocket to /student/ws on the teacher's PC, or the same path over WebRTC when the page came from
// padlink-app.github.io/student (student-rtc-host.js sets window.PADLINK_RTC).
(() => {
  'use strict';

  /** @returns {{ connect(): void, send(obj: object): void, close(): void }} */
  window.PadLinkStudentWs = function (handlers) {
    let ws = null;
    let rtc = null;

    function wireRtc(sock) {
      rtc = sock;
      sock.addEventListener('open', () => handlers.onopen?.());
      sock.addEventListener('message', (e) => handlers.onmessage?.(e));
      sock.addEventListener('close', () => { rtc = null; handlers.onclose?.(); });
      sock.addEventListener('error', () => { /* close follows */ });
    }

    function openRtc() {
      const link = window.PADLINK_RTC.link;
      if (rtc && rtc.readyState === 1) return Promise.resolve();
      if (rtc && rtc.readyState === 0) return Promise.resolve();
      return link.open().then(() => {
        if (rtc && rtc.readyState <= 1) return;
        wireRtc(link.socket('/student/ws'));
      }).catch(() => { handlers.onclose?.(); });
    }

    return {
      connect() {
        if (window.PADLINK_RTC?.link) {
          // Already open (the names came over it): send now, as the WebSocket path does. Waiting for an 'open' that
          // already happened left a tapped name unsent.
          if (rtc && rtc.readyState === 1) { handlers.onopen?.(); return; }
          openRtc();
          return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) { handlers.onopen?.(); return; }
        if (ws && ws.readyState === WebSocket.CONNECTING) return;
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/student/ws`);
        ws.onopen = () => handlers.onopen?.();
        ws.onmessage = (e) => handlers.onmessage?.(e);
        ws.onclose = () => { ws = null; handlers.onclose?.(); };
      },
      send(obj) {
        if (window.PADLINK_RTC?.link) {
          if (rtc && rtc.readyState === 1) rtc.send(JSON.stringify(obj));
          else openRtc().then(() => { if (rtc && rtc.readyState === 1) rtc.send(JSON.stringify(obj)); });
          return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      },
      close() {
        try { ws?.close(); } catch { /* gone */ }
        ws = null;
        try { rtc?.close(); } catch { /* gone */ }
        rtc = null;
      },
    };
  };

  const hostedSuffix = () => location.search + location.hash;

  /** Join page → board page (hosted student site uses relative paths; keep #r= for WebRTC). */
  window.PadLinkStudentBoardUrl = () => (window.PADLINK_RTC ? 'board.html' : '/student/board') + hostedSuffix();
  window.PadLinkStudentJoinUrl = () => (window.PADLINK_RTC ? 'index.html' : '/student') + hostedSuffix();
})();
