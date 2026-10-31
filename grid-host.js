// PadLink Go: the teacher's grid of student boards (teacher.html, the same page the PC serves), opened from the control
// screen's Class tools → Students → See their boards. It's PadLink Go's own page, so it's shown straight away; only its
// live connection goes to the paired PC, through Remote mode (a page opened from Remote mode's address inside PadLink Go
// would stop at Microsoft's "developer tunnel" notice, which Safari can't get past there). Loaded before teacher.js.
(() => {
  'use strict';
  let pc = null;
  try { pc = JSON.parse(localStorage.getItem('padlink-go.pc') || 'null'); } catch { /* storage unavailable */ }
  if (pc && pc.url && pc.control) window.PADLINK_GRID_BASE = String(pc.url).replace(/\/+$/, '');
})();
