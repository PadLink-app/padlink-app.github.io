// PadLink's settings that belong to the PC (the same ones as the PC's ⚙ Settings window), shown on the whiteboard
// (its ⚙ Settings). The PC keeps them; every change is told to every screen, so they always agree. The iPad and iPhone
// don't show them (decided Oct 24: too confusing next to the device's own settings).
(() => {
  'use strict';

  const BODY = `
    <section class="pcs-section">
      <h3>Connecting</h3>
      <div class="card">
        <div class="row">
          <label for="pcsAllow">Ask to Allow a paired iPad or iPhone</label>
          <select id="pcsAllow">
            <option value="30">Once every 30 days</option>
            <option value="7">Once a week</option>
            <option value="0">Each time PadLink starts</option>
          </select>
        </div>
        <p class="note">Taking control from another iPad always asks. Disconnect or Forget ends it early.</p>
      </div>
    </section>
    <section class="pcs-section">
      <h3>Raise hand</h3>
      <div class="card">
        <div class="row">
          <label for="pcsChime">Chime on the PC when a hand goes up</label>
          <input type="checkbox" class="switch" id="pcsChime">
        </div>
        <div class="row">
          <label for="pcsShow">Raised hands on the PC screen (the class sees it)</label>
          <select id="pcsShow">
            <option value="count">How many</option>
            <option value="names">Names</option>
            <option value="none">Nothing</option>
          </select>
        </div>
        <p class="note">Notes students add show only on your iPad or iPhone. The iPad's own chime switch is in Class tools → Students.</p>
        <div class="row">
          <label for="pcsQuiet">No chime if raised again within (minutes of lowering)</label>
          <input type="number" id="pcsQuiet" class="pcs-num" min="0" max="30" inputmode="numeric">
        </div>
        <div class="row">
          <label for="pcsGap">At most one chime every (seconds)</label>
          <input type="number" id="pcsGap" class="pcs-num" min="0" max="300" inputmode="numeric">
        </div>
        <div class="row">
          <label for="pcsRemind">Reminder chime for a hand up (minutes)</label>
          <input type="number" id="pcsRemind" class="pcs-num" min="1" max="30" inputmode="numeric">
        </div>
        <button type="button" id="pcsReset" class="quiet-btn">Reset to default</button>
      </div>
    </section>
    <p class="note center" id="pcsVersion"></p>`;

  const CSS = `
    .pcs-section { margin-bottom: 14px; }
    .pcs-section h3 { margin: 0 0 6px; font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #5b6478; }
    .pcs-section .card { padding: 4px 14px 10px; border-radius: 14px; background: #fff; box-shadow: 0 0 0 1px rgba(29,36,51,.08); }
    .pcs-section .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; }
    .pcs-section .row label { flex: 1; }
    .pcs-section select { max-width: 55%; min-height: 38px; padding: 0 8px; border: 1px solid rgba(29,36,51,.15); border-radius: 10px; background: #fff; font: inherit; color: inherit; }
    .pcs-num { width: 72px; min-height: 38px; padding: 0 8px; border: 1px solid rgba(29,36,51,.15); border-radius: 10px; font: inherit; text-align: center; }
    .pcs-section .note { margin: 2px 0 8px; color: #5b6478; font-size: 13.5px; }
    .pcs-wait { color: #5b6478; padding: 8px 0; }`;

  const DEFAULTS = { quiet: 3, gap: 15, reminder: 2 };

  /**
   * opts: { body (element to fill), send(msg), connected() → bool, notice(text) }.
   * Call .opened() when shown (asks the PC how things stand) and .onMessage(msg) with messages from the PC.
   */
  function Panel(opts) {
    const root = opts.body.ownerDocument;
    if (!root.getElementById('padlinkPcsCss')) {
      const st = root.createElement('style');
      st.id = 'padlinkPcsCss';
      st.textContent = CSS;
      root.head.appendChild(st);
    }
    opts.body.innerHTML = '<p class="pcs-wait" id="pcsWait">Getting the PC’s settings…</p><div id="pcsAll" hidden>' + BODY + '</div>';
    const $ = (s) => opts.body.querySelector(s);
    const connected = opts.connected || (() => true);
    let now = null;

    function set(key, value) {
      if (!connected()) { if (opts.notice) opts.notice('Not connected to the PC.'); return; }
      opts.send({ t: 'pcSet', key, value });
    }

    function render(m) {
      now = m;
      $('#pcsWait').hidden = true;
      $('#pcsAll').hidden = false;
      $('#pcsAllow').value = String(m.allowDays);
      $('#pcsChime').checked = !!m.handPcChime;
      $('#pcsShow').value = m.handPcShow || 'count';
      // Don't change a number while it's being typed.
      for (const [id, v] of [['#pcsQuiet', m.handQuiet], ['#pcsGap', m.handGap], ['#pcsRemind', m.handReminder]])
        if (root.activeElement !== $(id)) $(id).value = v;
      $('#pcsVersion').textContent = m.version ? `PadLink ${m.version} on the PC · the PC keeps these settings` : '';
    }

    $('#pcsAllow').addEventListener('change', (e) => set('allowDays', Number(e.target.value)));
    $('#pcsChime').addEventListener('change', (e) => set('handPcChime', e.target.checked));
    $('#pcsShow').addEventListener('change', (e) => set('handPcShow', e.target.value));
    const number = (id, key, min, max) => $(id).addEventListener('change', (e) => {
      const v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v) || v < min || v > max) { if (opts.notice) opts.notice(`Choose a number from ${min} to ${max}.`); if (now) render(now); return; }
      set(key, v);
    });
    number('#pcsQuiet', 'handQuiet', 0, 30);
    number('#pcsGap', 'handGap', 0, 300);
    number('#pcsRemind', 'handReminder', 1, 30);
    $('#pcsReset').addEventListener('click', () => {
      set('handQuiet', DEFAULTS.quiet);
      set('handGap', DEFAULTS.gap);
      set('handReminder', DEFAULTS.reminder);
    });

    return {
      opened() { if (connected()) opts.send({ t: 'pcSettings' }); },
      /** A message from the PC; true if it was for this panel. */
      onMessage(msg) {
        if (msg.t !== 'pcSettings') return false;
        render(msg);
        return true;
      },
    };
  }

  window.PadPcSettings = { Panel };
})();
