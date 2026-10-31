// PadLink Go: the whiteboard (board.js, the same one as on the PC) on the iPad or iPhone. On the PC, PadLink's window
// around the board keeps it saved; here this stand-in does that job on the device: saves go to the app's own storage
// (store.js), pictures come from Photos, the camera or Files, PDF worksheets become pages (pdf.js), and a board leaves
// as a .padlink file. The PC-only parts (Capture, Google Drive, Class tools, the laser) aren't offered. Loaded before
// board.js.
(() => {
  'use strict';

  const S = window.GoStore;
  window.PADLINK_GO = true; // board.js: Go mode
  const listeners = [];
  const deliver = (data) => { for (const fn of listeners) fn({ data }); };
  const MAX_SIDE = 2560; // photos are shrunk to this (a 12-megapixel photo would fill the device's storage quickly)

  let work = Promise.resolve(); // messages are handled in order, so a save finishes before the next thing
  const queue = (fn) => { work = work.then(fn).catch((e) => { console.warn(e); deliver({ type: 'error', message: e.message || String(e) }); }); return work; };

  let boardId = new URLSearchParams(location.search).get('b');
  const remember = (id) => { boardId = id; history.replaceState(null, '', 'board.html?b=' + encodeURIComponent(id)); };

  /** A data: URL as a file, without fetching it. */
  function fileFromDataUrl(url, name) {
    const [head, body] = String(url).split(',', 2);
    const type = (/^data:([^;,]+)/.exec(head) || [])[1] || 'image/png';
    const bytes = /;base64/.test(head) ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
    return new File([bytes], name, { type });
  }
  const dataUrl = (file) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(file); });
  function loadImage(url) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('That picture can’t be opened here.')); img.src = url; });
  }
  /** A picture for the board: big photos made smaller (JPEG); small pictures and drawings kept as they are. */
  async function pictureFrom(file) {
    const url = await dataUrl(file);
    const img = await loadImage(url);
    const side = Math.max(img.naturalWidth, img.naturalHeight);
    const keep = side <= MAX_SIDE && file.size < 1.5 * 1024 * 1024 && /^image\/(png|jpeg|gif|webp)$/.test(file.type);
    if (keep) return url;
    const k = Math.min(1, MAX_SIDE / side);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; // a see-through picture gets a white background as a JPEG
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  /** Ask for files with the device's own chooser (Photo Library, Take Photo, Choose File). */
  function choose(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }


  // ---------- PDF worksheets: pages on the device (stage 6) ----------
  // pdf.js (Mozilla's PDF reader, in pdfjs/ on this site: nothing comes from elsewhere, so it works offline) turns a
  // PDF's pages into pictures, as PadLink does on the PC: the whiteboard's own page picker chooses which, and each page
  // is drawn at 1.5x the board's 1920x1080 page, one at a time (a long worksheet mustn't run the iPad out of memory).
  const PDF_SCALE = 1.5, THUMB_W = 240, MAX_PDF = 200 * 1024 * 1024;
  const pdfs = new Map(); // id -> { doc, name, closed }
  let pdfjsp = null;
  function pdfjs() {
    pdfjsp = pdfjsp || import('./pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', location.href).href;
      return lib;
    });
    return pdfjsp;
  }
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  /** Draws one page of a PDF into a picture (a data URL), width in pixels; frees the canvas straight after. */
  async function renderPage(doc, index, width, type) {
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport, background: 'white' }).promise;
    const url = type === 'jpeg' ? c.toDataURL('image/jpeg', 0.8) : c.toDataURL('image/png');
    c.width = c.height = 0;
    page.cleanup();
    return url;
  }

  async function openPdf(file) {
    if (file.size > MAX_PDF) { deliver({ type: 'error', message: `“${file.name}” is too big to open here (${Math.round(file.size / 1048576)} MB). Add it on the PC instead.` }); return; }
    deliver({ type: 'status', text: `Opening “${file.name}”…` });
    let doc;
    try {
      const lib = await pdfjs();
      doc = await lib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        isEvalSupported: false, // this site allows no eval (its security rules)
        standardFontDataUrl: new URL('pdfjs/standard_fonts/', location.href).href,
      }).promise;
    } catch (e) {
      const locked = e && e.name === 'PasswordException';
      deliver({ type: 'error', message: locked ? `“${file.name}” is password-protected. Open it on the PC, or save a copy without the password.` : `Couldn’t open “${file.name}”. It may be damaged.` });
      return;
    }
    const id = 'p' + Math.random().toString(36).slice(2, 10);
    const entry = { doc, name: file.name, closed: false };
    pdfs.set(id, entry);
    const sizes = [];
    for (let i = 0; i < doc.numPages; i++) {
      const v = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      sizes.push([v.width, v.height]);
    }
    deliver({ type: 'pdf', id, name: file.name, pageCount: doc.numPages, sizes });
    // The picker's small pictures, one by one (not holding up saving meanwhile).
    (async () => {
      for (let i = 0; i < doc.numPages && !entry.closed; i++) {
        try { deliver({ type: 'thumb', id, index: i, dataUrl: await renderPage(doc, i, THUMB_W, 'jpeg') }); }
        catch (e) { console.warn('PDF thumbnail', i, e); }
      }
    })();
  }

  async function addPdfPages(msg) {
    const entry = pdfs.get(msg.id);
    if (!entry) return;
    for (const i of msg.pages || []) {
      if (entry.closed) return;
      if (!(i >= 0 && i < entry.doc.numPages)) continue;
      const v = (await entry.doc.getPage(i + 1)).getViewport({ scale: 1 });
      const fit = Math.min(1920 / v.width, 1080 / v.height);
      try { deliver({ type: 'pdfPage', id: msg.id, index: i, dataUrl: await renderPage(entry.doc, i, Math.round(v.width * fit * PDF_SCALE), 'png') }); }
      catch (e) { console.warn('PDF page', i, e); }
    }
    deliver({ type: 'pdfDone', id: msg.id });
  }

  function closePdf(id) {
    const entry = pdfs.get(id);
    if (!entry) return;
    entry.closed = true;
    pdfs.delete(id);
    entry.doc.destroy().catch(() => {});
  }

  // Google Drive: PadLink's picker page (Google's own file picker, on PadLink's website) and the file it brought back.
  const PICKER = window.__drivePicker || 'https://larogoth.github.io/PadLink-releases/picker/'; // (the test points it at a stand-in)
  let fromDrive = new URLSearchParams(location.search).get('drive') === '1';
  if (fromDrive) history.replaceState(null, '', location.pathname + (boardId ? '?b=' + encodeURIComponent(boardId) : ''));
  async function driveArrived() {
    const rec = await S.driveTake().catch(() => null);
    const data = rec && (rec.bytes || rec.blob); // plain bytes (rec.blob: from before 0.47.2)
    if (!data) return;
    const file = new File([data], rec.name || 'Drive file', { type: rec.type || data.type || '' });
    if (isPdf(file)) { await openPdf(file); return; } // PDFs (and Slides, Docs, Sheets, Drawings as PDFs): the page picker
    const onPage = rec.place === 'image';
    deliver({ type: 'capture', dataUrl: await pictureFrom(file), placement: onPage ? 'image' : 'page', said: `Added “${file.name}” from Google Drive${onPage ? ' to this page' : ' as a new page'}.` });
  }

  const asBoardData = (b) => ({ type: 'boardData', id: b.id, name: b.name, state: b.state, images: b.images || {} });
  const fmt = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  async function list() {
    const all = (await S.allBoards()).sort((a, b) => b.modified - a.modified);
    return all.map((b) => ({ id: b.id, name: b.name, thumb: b.thumb, modified: fmt(b.modified), pages: b.state.pages.length }));
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'boardLast': { // the board page opened: the board chosen in the list
        const b = boardId && await S.getBoard(boardId);
        deliver(b ? asBoardData(b) : { type: 'boardNone' });
        if (fromDrive) { fromDrive = false; queue(driveArrived); } // back from Google Drive with a file
        break;
      }
      case 'drive': { // Google Drive: off to PadLink's picker page; it comes back to drive/return.html with the file
        if (!navigator.onLine) { deliver({ type: 'status', text: 'Google Drive needs the internet. Try again when this iPad is online.' }); break; }
        const code = Array.from(crypto.getRandomValues(new Uint8Array(24)), (v) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[v & 63]).join('');
        try { localStorage.setItem('padlink-go.drive', JSON.stringify({ code, board: boardId, place: msg.place === 'image' ? 'image' : 'page', at: Date.now() })); }
        catch { deliver({ type: 'error', message: 'This device’s storage is full or switched off, so Google Drive can’t be used here.' }); break; }
        location.href = `${PICKER}${PICKER.includes('?') ? '&' : '?'}r=${encodeURIComponent(location.origin + '/drive/return')}&c=${code}`;
        break;
      }
      case 'boardSave': {
        const old = await S.getBoard(msg.id);
        const now = Date.now();
        await S.putBoard({
          id: msg.id, name: msg.name, created: old ? old.created : now, modified: now, state: msg.state,
          images: { ...(old ? old.images : {}), ...(msg.images || {}) }, thumb: msg.thumb || (old && old.thumb) || null, sent: old ? old.sent : null,
        });
        S.keepStorage();
        // The board in hand (a reload opens it again); Boards → Make a copy saves a new one but stays on this board.
        if (old || !msg.name.endsWith(' (copy)')) remember(msg.id);
        deliver({ type: 'boardSaved', id: msg.id });
        break;
      }
      case 'boardList': deliver({ type: 'boards', list: await list() }); break;
      case 'boardOpen': {
        const b = await S.getBoard(msg.id);
        if (!b) { deliver({ type: 'error', message: 'That board couldn’t be found.' }); break; }
        remember(b.id);
        deliver(asBoardData(b));
        break;
      }
      case 'boardDelete':
        await S.deleteBoard(msg.id);
        deliver({ type: 'boards', list: await list() });
        break;
      case 'boardExport': // Boards → Save as a file: the share sheet (Files, AirDrop, Google Drive, email)
        await S.shareFile(await S.boardFile({ name: msg.name, state: msg.state, images: msg.images, thumb: msg.thumb }), msg.name);
        break;
      case 'boardImportFile': { // Boards → Open a board file: a new board here
        const [file] = msg.files;
        if (!file) break;
        const got = await S.readBoardFile(file);
        const now = Date.now();
        const b = { id: S.newId(), name: got.name, created: now, modified: now, state: got.state, images: got.images, thumb: got.thumb, sent: null };
        await S.putBoard(b);
        remember(b.id);
        deliver(asBoardData(b));
        deliver({ type: 'status', text: `Opened “${b.name}”. It’s saved on this device.` });
        break;
      }
      case 'import': { // Add: a picture (Photo Library, Take Photo or Choose File) or a PDF worksheet (Choose File)
        for (const f of msg.files) {
          if (isPdf(f)) { await openPdf(f); continue; } // its page picker opens: one PDF at a time
          if (!f.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(f.name)) {
            deliver({ type: 'status', text: `“${f.name}” isn’t a picture or a PDF.` });
            continue;
          }
          deliver({ type: 'image', dataUrl: await pictureFrom(f) });
        }
        break;
      }
      case 'pdfPages': await addPdfPages(msg); break; // the pages chosen in the picker
      case 'pdfClose': closePdf(msg.id); break;
      case 'close': // back to the boards list (the board saved itself first)
        location.href = './';
        break;
      default: break; // the PC's own messages (class tools, the iPad's copy, capture): nothing to do here
    }
  }

  // Restart now (update.js): save the board first (board.js saves on pagehide), and wait for the save to finish.
  window.goBeforeRestart = () => { dispatchEvent(new Event('pagehide')); return work; };

  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage(msg) {
      // The device only opens its chooser straight from a tap, so ask now; what's chosen is handled in turn (and a
      // chooser closed without a choice, which older iPads don't report, holds nothing up).
      if (msg.type === 'import') { const picked = choose('image/*,application/pdf,.pdf', true); picked.then((files) => { if (files.length) queue(() => handle({ ...msg, files })); }); return; }
      // Save this page as a picture: the share sheet (Save Image puts it in Photos), opened in the same tap (the
      // device refuses it later). The picture is made into a file right here: Go's rules don't let it fetch data: URLs.
      if (msg.type === 'saveImage') { S.shareFile(fileFromDataUrl(msg.dataUrl, msg.name || 'whiteboard.png'), msg.name); return; }
      if (msg.type === 'boardImportFile') { const picked = choose('', false); picked.then((files) => { if (files.length) queue(() => handle({ ...msg, files })); }); return; }
      queue(() => handle(msg));
    },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
  };
})();
