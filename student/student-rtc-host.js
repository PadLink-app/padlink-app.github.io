// On https://padlink-app.github.io/student: read #r=… (this PC's student room, signaling server and key fingerprint),
// or look the class code up (the short address: PadLinkStudentLookup below)
// and route /student/ws over encrypted WebRTC (rtc.js + student-ws.js). Keeps the link in sessionStorage so
// board.html (and reloads) still know which PC to reach after navigation drops the hash.
(() => {
  'use strict';
  const STORE = 'padlink.student.rtc';
  function b64urlToJson(b64) {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
  }
  function loadInfo() {
    const m = /#r=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) {
      try {
        const json = b64urlToJson(m[1]);
        const info = PadLinkRtc.readInfo(json);
        if (info) {
          try { sessionStorage.setItem(STORE, JSON.stringify(json)); } catch { /* private mode */ }
          return info;
        }
      } catch { /* not a valid link */ }
    }
    try {
      const json = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      return json ? PadLinkRtc.readInfo(json) : null;
    } catch { return null; }
  }
  if (!window.PadLinkRtc) return;
  const info = loadInfo();
  if (info) window.PADLINK_RTC = { link: PadLinkRtc.link(info) };

  // The short address: a student who opened padlink-app.github.io/student (no #r=) types the class code, and the page
  // asks PadLink's signaling server which class that is (the PC lists its code there while the class is open). The
  // answer is the same as the long link's, so the PC's key is still checked. Answers 'ok', 'code' (no class with that
  // code right now) or 'offline'.
  const LOOKUP = 'https://padlink-signal.getpadlink.workers.dev';
  window.PadLinkStudentLookup = async (code) => {
    if (/#r=/.test(location.hash)) return 'ok'; // the long link already says which class
    let res;
    try { res = await fetch(`${LOOKUP}/code/${encodeURIComponent(code)}`, { cache: 'no-store', credentials: 'omit' }); } catch { return 'offline'; }
    if (res.status === 404) return 'code';
    if (!res.ok) return 'offline';
    let json;
    try { json = await res.json(); } catch { return 'offline'; }
    const found = PadLinkRtc.readInfo(json);
    if (!found) return 'offline';
    try { sessionStorage.setItem(STORE, JSON.stringify(json)); } catch { /* private mode */ }
    window.PADLINK_RTC = { link: PadLinkRtc.link(found) };
    return 'ok';
  };
})();
