// PadLink Go: back from Google Drive (drive/return.html). PadLink's picker page (larogoth.github.io/PadLink-releases/
// picker) sends the browser here with the file that was picked and Google's short-lived pass for just that file, in
// the address's #fragment (which never leaves this device). This page checks it's the pick PadLink Go asked for,
// downloads the file straight from Google (no PC needed), keeps it for a moment on the device, and goes back to the
// board, which puts it on (a picture) or opens the page chooser (a PDF, or Google Slides, Docs, Sheets, Drawings as PDF).
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const API = window.__driveApi || 'https://www.googleapis.com/drive/v3/files'; // (the test points it at a stand-in)
  const MAX = 80 * 1024 * 1024;
  const MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif']);
  const GOOGLE = new Set(['application/vnd.google-apps.presentation', 'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.drawing']);

  function say(title, text, problem) {
    $('#title').textContent = title;
    $('#text').textContent = text || '';
    $('#back').hidden = !problem;
    document.body.classList.toggle('problem', !!problem);
  }

  let pending = null;
  try { pending = JSON.parse(localStorage.getItem('padlink-go.drive') || 'null'); } catch { /* storage unavailable */ }
  const back = (extra) => location.replace(pending && pending.board ? `/board.html?b=${encodeURIComponent(pending.board)}${extra || ''}` : '/');
  $('#back').addEventListener('click', () => back());

  // Read the pick, then take it out of the address at once (the pass shouldn't stay in the history).
  const got = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);

  (async () => {
    const code = got.get('c') || '', id = got.get('id') || '', name = (got.get('name') || 'Drive file').slice(0, 200);
    const mime = got.get('mime') || '', token = got.get('token') || '';
    if (!pending || !code || code !== pending.code || Date.now() - pending.at > 30 * 60 * 1000) {
      say('That Google Drive pick wasn’t for this device', 'Open Google Drive again from the whiteboard (its Drive button).', true);
      return;
    }
    try { localStorage.removeItem('padlink-go.drive'); } catch { /* fine */ }
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id) || !token || !(MIMES.has(mime) || GOOGLE.has(mime))) {
      say('That file can’t go on the whiteboard', 'Pick a PDF, a picture, or Google Slides, Docs, Sheets or Drawings.', true);
      return;
    }
    say(`Getting “${name}” from Google Drive…`, GOOGLE.has(mime) ? 'Google makes it into a PDF first: a few seconds.' : '');
    try {
      const url = GOOGLE.has(mime)
        ? `${API}/${encodeURIComponent(id)}/export?mimeType=application%2Fpdf`
        : `${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(res.status === 403 && GOOGLE.has(mime) ? 'too-big' : 'http-' + res.status);
      if (Number(res.headers.get('content-length')) > MAX) throw new Error('too-big');
      // Kept as plain bytes, not a Blob: Safari on an iPad can hand a stored Blob back unreadable.
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > MAX) throw new Error('too-big');
      const type = GOOGLE.has(mime) ? 'application/pdf' : mime;
      if (type === 'application/pdf' && !new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength))).includes('%PDF')) throw new Error('not-pdf');
      const fileName = GOOGLE.has(mime) && !/\.pdf$/i.test(name) ? name + '.pdf' : name;
      await GoStore.drivePut({ name: fileName, type, bytes, place: pending.place === 'image' ? 'image' : 'page', at: Date.now() });
      say(`Got “${name}”`, 'Back to your board…');
      back('&drive=1');
    } catch (e) {
      const why = String(e && e.message);
      say('Couldn’t get that file from Google Drive',
        why === 'too-big' ? 'It’s too big to bring in here (Google Docs and Slides can only be made into PDFs up to about 10 MB). Try a smaller file.'
          : why === 'not-pdf' ? 'Google sent something that isn’t a PDF. Try again, or download the file and add it with Photo, picture or PDF.'
          : why === 'http-401' ? 'Google’s sign-in ran out. Open Google Drive again from the whiteboard.'
          : why.startsWith('http-') ? `Google said no (${why.slice(5)}). Check you can open that file in Google Drive, then try again.`
          : 'Is this iPad online? Try again in a moment.', true);
    }
  })();
})();
