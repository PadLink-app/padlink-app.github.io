// PadLink Student Mode: joining the class from a student's Chromebook. The class code (from the QR code, or typed),
// then their name from the teacher's class list, then waiting until the teacher lets them in. The teacher's PC
// answers on /student/ws. Once in, the student's whiteboard opens (/student/board); the key that lets this device
// back in during the lesson is kept on the device until the class closes.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const STORE = 'padlink.student';
  const steps = ['stepCode', 'stepName', 'stepWait', 'stepMessage'];
  const show = (id) => { for (const s of steps) $('#' + s).hidden = s !== id; };
  const saved = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } };
  const forget = () => { try { localStorage.removeItem(STORE); } catch { /* private mode */ } };

  let code = (new URLSearchParams(location.search).get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let pending = null;

  const transport = PadLinkStudentWs({
    onopen: () => {
      if (!pending) return;
      const msg = pending;
      pending = null;
      transport.send(msg);
    },
    onmessage: (e) => onMessage(JSON.parse(e.data)),
    onclose: () => {
      if (!$('#stepWait').hidden) setTimeout(() => connect({ t: 'code', code }), 2000);
    },
  });

  function connect(first) {
    pending = first;
    transport.connect();
  }

  // On padlink-app.github.io/student without the long link: find the class from its code first (student-rtc-host.js).
  const lookup = window.PadLinkStudentLookup;
  async function findClass(c) {
    if (!lookup) return 'ok';
    $('#codeForm button').disabled = true;
    try { return await lookup(c); } finally { $('#codeForm button').disabled = false; }
  }
  async function joinWithCode() {
    const found = await findClass(code);
    if (found === 'ok') { connect({ t: 'code', code }); return; }
    $('#codeInput').value = code;
    show('stepCode');
    $('#codeError').textContent = found === 'code' ? 'No class is open with that code. Check the code on the board and try again.' : 'Can’t reach your class right now. Check the Wi-Fi, then try again.';
    $('#codeError').hidden = false;
  }

  const MESSAGES = {
    closed: ['The class isn’t open', 'Your teacher hasn’t opened the class yet, or it has finished. Ask your teacher.'],
    code: ['That code didn’t work', 'Check the code on the board and try again.'],
    taken: ['That name is already in', 'Someone has already joined with that name. Tell your teacher if it’s you.'],
    declined: ['Not let in', 'Your teacher didn’t let this device in. Ask your teacher.'],
    removed: ['You’ve left the class', 'Your teacher took this device out of the class.'],
    full: ['The class is full', 'Ask your teacher.'],
    slow: ['Too many tries', 'Wait a minute, then reload this page.'],
    gone: ['Join again', 'Your place in the class has ended. Enter the code again.'],
  };

  function onMessage(m) {
    if (m.t === 'names') {
      $('#className').textContent = m.class ? `Class: ${m.class}` : '';
      const box = $('#names');
      box.innerHTML = '';
      for (const n of m.names) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = n.name;
        if (n.taken) { b.disabled = true; const s = document.createElement('small'); s.textContent = 'joined'; b.appendChild(s); }
        b.addEventListener('click', () => { $('#nameError').hidden = true; connect({ t: 'join', code, name: n.name }); });
        box.appendChild(b);
      }
      show('stepName');
    } else if (m.t === 'waiting') {
      $('#waitName').textContent = m.name;
      show('stepWait');
    } else if (m.t === 'approved') {
      try { localStorage.setItem(STORE, JSON.stringify({ key: m.key, name: m.name, code })); } catch { /* private mode */ }
      location.href = PadLinkStudentBoardUrl();
    } else if (m.t === 'ready') {
      location.href = PadLinkStudentBoardUrl();
    } else if (m.t === 'error') {
      if (m.why === 'code' && !$('#stepCode').hidden) { $('#codeError').textContent = MESSAGES.code[1]; $('#codeError').hidden = false; return; }
      if (m.why === 'taken' && !$('#stepName').hidden) { $('#nameError').textContent = MESSAGES.taken[1]; $('#nameError').hidden = false; return; }
      forget();
      const [title, text] = MESSAGES[m.why] || ['Something went wrong', 'Reload this page and try again.'];
      $('#messageTitle').textContent = title;
      $('#messageText').textContent = text;
      show('stepMessage');
    }
  }

  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    code = $('#codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    $('#codeError').hidden = true;
    if (code.length < 6) { $('#codeError').textContent = 'The code has 6 letters and numbers.'; $('#codeError').hidden = false; return; }
    joinWithCode();
  });
  $('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#backToCode').addEventListener('click', () => { show('stepCode'); $('#codeInput').focus(); });
  $('#notMe').addEventListener('click', () => { transport.close(); connect({ t: 'code', code }); });
  $('#messageAgain').addEventListener('click', () => { $('#codeInput').value = code; show('stepCode'); });

  const me = saved();
  if (me && me.key) {
    // Back in the class (a reload, a new tab): on the short address, find it again from the code it joined with.
    if (lookup && !window.PADLINK_RTC && me.code) {
      findClass(me.code).then((found) => {
        if (found === 'ok') { connect({ t: 'resume', key: me.key }); return; }
        if (found === 'code') forget(); // that class has closed
        code = me.code;
        joinWithCode(); // (says what's wrong, on the code step)
      });
    }
    else connect({ t: 'resume', key: me.key });
  } else if (code.length === 6) { $('#codeInput').value = code; joinWithCode(); }
  else show('stepCode');
  if (me && me.key) show('stepWait'), ($('#waitName').textContent = me.name || '');
})();
