// PadLink's Class tools panel: the countdown timer, the random name picker, and Students (Student Mode). Shared by the pad (its Class tools
// sheet) and the whiteboard on the PC (its Class button). Both run on the PC, which tells every screen about every
// change ('timer', 'rosters', 'picked' messages), so the iPad, iPhone and whiteboard always agree, whichever was used.
// Exposes window.PadClass.
(() => {
  'use strict';

  const TABS = `
    <button data-ctab="timer" class="on" role="tab">Timer</button>
    <button data-ctab="names" role="tab">Names</button>
    <button data-ctab="students" role="tab">Students</button>
    <button data-ctab="poll" role="tab">Poll</button>`;

  // Student tools: what students can use on their Chromebooks (the teacher switches them on and off any time).
  const STUDENT_TOOLS = [
    ['shapes', 'Shapes'], ['text', 'Text'], ['math', 'Math'], ['notes', 'Sticky notes'],
    ['pictures', 'Pasting pictures'], ['pages', 'Adding and deleting pages'], ['clear', 'Clearing the page'],
    ['hand', 'Raise hand'],
  ];

  const BODY = (deviceSound) => `
      <section id="tabTimer">
        <div class="t-display" id="tDisplay">0:00</div>
        <p class="t-state" id="tState">Shows in the bottom-right corner of the PC screen</p>
        <div class="grid t-presets">
          <button data-secs="30">0:30</button>
          <button data-secs="60">1:00</button>
          <button data-secs="120">2:00</button>
          <button data-secs="180">3:00</button>
          <button data-secs="300">5:00</button>
          <button data-secs="600">10:00</button>
          <button data-secs="900">15:00</button>
          <button data-secs="1800">30:00</button>
        </div>
        <form id="tCustom" class="t-custom">
          <input id="tMin" type="number" inputmode="numeric" min="0" max="599" placeholder="min" aria-label="Minutes">
          <span>:</span>
          <input id="tSec" type="number" inputmode="numeric" min="0" max="59" placeholder="sec" aria-label="Seconds">
          <button type="submit">Start</button>
        </form>
        <div class="chips t-controls">
          <button id="tAdd">+0:30</button>
          <button id="tPause" disabled>Pause</button>
          <button id="tStop" disabled>Stop</button>
        </div>
        <details class="c-more" id="tMore"><summary>Size and chime</summary>
        <div class="n-label">Size on the PC screen</div>
        <div class="seg small n-seg" id="tSize" role="radiogroup" aria-label="Timer size on the PC screen">
          <button data-tsize="0" role="radio">Small</button>
          <button data-tsize="1" role="radio">Medium</button>
          <button data-tsize="2" role="radio">Large</button>
        </div>
        <div class="card" style="margin-top: 14px">
          <div class="row">
            <label for="tPcSound">Chime on the PC when time is up (timer and polls)</label>
            <input type="checkbox" class="switch" id="tPcSound" checked>
          </div>${deviceSound ? `
          <div class="row">
            <label for="tPadSound">Chime on this device too</label>
            <input type="checkbox" class="switch" id="tPadSound" checked>
          </div>` : ''}
        </div>
        </details>
      </section>

      <section id="tabNames" hidden>
        <div id="nEmpty" class="n-empty" hidden>
          <p>Add a class list, then pick names at random. The picker spins on the PC screen for everyone to see.</p>
          <button id="nAddFirst" class="primary-btn">Add a class</button>
        </div>
        <div id="nMain" hidden>
          <div class="n-roster">
            <select id="nRoster" aria-label="Class"></select>
            <button id="nEdit">Edit</button>
            <button id="nNew" aria-label="Add a class">＋</button>
          </div>
          <button id="nPick" class="pick-btn">Pick a name</button>
          <div class="n-result" id="nResult" aria-live="polite"></div>
          <div class="n-left"><span id="nLeft"></span><button id="nReset" hidden>Start over</button></div>
          <button id="nHide" class="quiet-btn">Hide the picker on the PC</button>
          <details class="c-more" id="nMore"><summary>How it picks</summary>
          <div class="n-label">Show it as</div>
          <div class="seg small n-seg" id="nStyle">
            <button data-style="wheel">Spinning wheel</button>
            <button data-style="flash">Flashing names</button>
          </div>
          <div class="n-label">Who can be picked</div>
          <div class="seg small n-seg" id="nMode">
            <button data-once="1">Everyone once, then repeat</button>
            <button data-once="0">Anyone, every time</button>
          </div>
          <div class="card n-sound">
            <div class="row">
              <label for="nTicking">Ticking sound on the PC while it picks</label>
              <input type="checkbox" class="switch" id="nTicking" checked>
            </div>
          </div>
          </details>
        </div>
        <div id="nChoose" class="n-choose" hidden>
          <div class="n-choose-top"><b>Choose the name</b><button type="button" id="nChooseX" class="n-x" aria-label="Back">✕</button></div>
          <div class="seg small n-seg" id="nChooseMode">
            <button type="button" data-cm="pick">Land on</button>
            <button type="button" data-cm="out">Leave out today</button>
          </div>
          <input id="nFind" type="search" placeholder="Find a name" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Find a name">
          <div id="nChooseList" class="n-choose-list"></div>
          <p class="note" id="nChooseNote"></p>
        </div>
        <form id="nEditor" hidden>
          <div class="n-label" id="nEditorTitle">New class</div>
          <input id="nName" maxlength="60" placeholder="Class name, e.g. Period 3" autocomplete="off">
          <div class="n-table">
            <div class="n-head" aria-hidden="true"><span>Name</span><span>Team</span><span>Seat</span><span></span></div>
            <div id="nRows"></div>
          </div>
          <button type="button" id="nAddRow" class="n-add">＋ Add student</button>
          <p class="note" id="nCount"></p>
          <p class="note">Team and seat are optional: each student's <b>home team</b> and <b>seat</b>, for making teams. To paste a whole list, copy the name column (and the team and seat columns, if you have them) from a spreadsheet and paste into a name box.</p>
          <details class="n-seats">
            <summary>What do the seat numbers mean?</summary>
            <p>One common way: give each level the same seat at every table: <b>1 High, 2 Low-Medium, 3 Low, 4 High-Medium</b>. High and Low sit kitty-corner; shoulder partners are 1 and 2, 3 and 4; face partners are 1 and 4, 2 and 3. PadLink keeps only the numbers, never the levels, and mixed teams stay balanced only if seats mean the same at every table.</p>
          </details>
          <div class="chips">
            <button type="button" id="nCancel">Cancel</button>
            <button type="submit" class="on">Save</button>
          </div>
          <button type="button" id="nDelete" class="quiet-btn danger" hidden>Delete this class</button>
        </form>
      </section>

      <section id="tabStudents" hidden>
        <div id="sClosed">
          <p class="note">Students join from their Chromebooks with a code: no app or account. Their boards are kept on the PC during the lesson and deleted when you close the class.</p>
          <div id="sNoLists" class="note" hidden>Add a class list first, in the Names tab.</div>
          <div id="sPick">
            <div class="n-label">Class list</div>
            <select id="sRoster" class="s-select" aria-label="Class list"></select>
            <div class="n-label">Students start with</div>
            <div class="seg small n-seg" id="sStart" role="radiogroup" aria-label="Students start with">
              <button data-blank="0" role="radio">My lesson pages</button>
              <button data-blank="1" role="radio">Empty boards (I’ll send pages)</button>
            </div>
            <p class="note" id="sStartNote"></p>
            <button id="sOpenBtn" class="pick-btn">Open the class</button>
          </div>
        </div>
        <div id="sOpen" hidden>
          <p class="s-info" id="sInfo"></p>
          <div id="sHandBox" class="s-box hand" hidden>
            <div class="s-head"><b id="sHandTitle">Hands up</b><button id="sLowerAll" class="s-small">Lower all</button></div>
            <div class="s-list" id="sHandList"></div>
            <p class="note" id="sHandPcNote" hidden></p>
          </div>
          <div class="s-actions">
            <button id="sJoinBtn" class="s-act">Show join code</button>
            <button id="sBoards" class="s-act">See their boards</button>
          </div>
          <label class="s-apart s-corner" id="sCornerRow" hidden><input type="checkbox" id="sCorner"> Class code in the corner of the whiteboard, for late students</label>
          <div class="s-link" id="sLinkBox" hidden>
            <button id="sCopyLink" class="s-link-btn">📋 Copy student link</button>
            <span id="sLinkText" class="s-link-text" hidden></span>
          </div>
          <p class="note s-link-changed" id="sLinkChanged" hidden></p>
          <div class="s-box s-compare" id="sCompareBox" hidden><span id="sCompareText"></span><button id="sCompareStop" class="s-small">Stop</button></div>
          <div id="sWaitBox" class="s-box warn" hidden>
            <div class="s-head"><b id="sWaitTitle">Waiting to be let in</b><button id="sLetIn" class="s-small primary">Let everyone in</button></div>
            <div class="s-list" id="sWaitList"></div>
          </div>
          <div class="n-label">Who turns the pages</div>
          <div class="seg small n-seg" id="sPace" role="radiogroup" aria-label="Who turns the pages">
            <button data-own="0" role="radio">👣 You lead</button>
            <button data-own="1" role="radio">🧭 Their own pace</button>
          </div>
          <div class="s-pace-acts">
            <button id="sDraw" class="s-act s-draw">✏️ Let them draw</button>
            <button id="sEyes" class="s-act s-eyes" title="Cover every student's screen with Eyes on the teacher (their work stays underneath)">👀 Eyes up</button>
          </div>
          <p class="note" id="sPaceNote"></p>
          <label class="s-apart" id="sKeepRow"><input type="checkbox" id="sKeepDraw"> Keep drawing on when I turn the page</label>
          <label class="s-apart" id="sCheckRow"><input type="checkbox" id="sSelfCheck"> Pages' polls: show ✓ or the right answer as soon as they lock in</label>
          <div class="s-box" id="sTeamBox">
            <div class="s-head"><b>Teams</b><button id="sTeamsClear" class="s-small danger" hidden>Clear teams</button></div>
            <div id="sTeamMake">
              <div class="seg small n-seg s-how" id="sHow" role="radiogroup" aria-label="Make teams from">
                <button data-how="home" role="radio">Home teams</button>
                <button data-how="mixed" role="radio">Mixed</button>
                <button data-how="seat" role="radio">Same seats</button>
                <button data-how="random" role="radio">Random</button>
              </div>
              <p class="note" id="sHowNote"></p>
              <label class="s-apart" id="sApartRow"><input type="checkbox" id="sApart" checked> Keep tablemates apart</label>
              <button id="sMakeTeams" class="s-act s-make">Make teams</button>
            </div>
            <div id="sTeamList" class="s-teams" hidden></div>
            <p class="note" id="sTeamHelp" hidden>Tap a name, then another name to swap them, or a team's ＋ to move them there (the first empty seat; their old team closes up). Each Chromebook shows its team and seat.</p>
            <button id="sTeamBoards" class="s-act s-make" hidden>Start team boards</button>
            <p class="note" id="sTeamBoardsNote" hidden></p>
            <div class="s-actions" id="sTeamActs" hidden>
              <button id="sTeamsShow" class="s-act">Show teams</button>
              <button id="sTeamsRemake" class="s-act">Make again</button>
            </div>
          </div>
          <div id="sSendBox">
            <button id="sSend" class="pick-btn">Send my page to everyone</button>
            <p class="note">Copies the whiteboard page you’re on onto every student’s board, as a new page to work on.</p>
            <button id="sLessonAll" class="s-act">Send all my lesson pages</button>
            <p class="note">Students started with empty boards. This gives them your lesson pages (not the hidden ones), and from then on the class works as if it had started with them. What they did is kept.</p>
          </div>
          <div class="s-box" id="sWallBox">
            <div class="s-head"><b>🗒️ Class wall</b></div>
            <div class="s-actions s-wall-make" id="sWallMakes">
              <button class="s-act" data-layout="grid" title="A sticky note for each student">🗒️ A note each</button>
              <button class="s-act" data-layout="nw" title="Two columns: each student's I notice… and I wonder… notes">👀 Notice &amp; Wonder</button>
              <button class="s-act" data-layout="lot" title="Students add their ideas or questions, one per note, up to 5 each; you drag them into groups">🅿️ Parking lot</button>
            </div>
            <p class="note" id="sWallNote">A sticky note for each student on the whiteboard page you’re on, for notice and wonder or an exit ticket. Each student types or draws on their own note only. The class sees the wall live, without names.</p>
            <div id="sWallOn" hidden>
              <label class="s-apart"><input type="checkbox" id="sWallWriting"> Students can write on their notes</label>
              <label class="s-apart"><input type="checkbox" id="sWallNames"> Show names on the whiteboard</label>
              <div class="s-list s-wall" id="sWallList"></div>
            </div>
          </div>
          <div class="s-box">
            <div class="s-head"><b id="sInTitle">In the class</b></div>
            <div class="s-list" id="sInList"></div>
          </div>
        </div>
        <details class="c-more" id="sMore"><summary>Class settings</summary>
        <div id="sViaBox" hidden>
          <div class="n-label">Students join through</div>
          <div class="seg small n-seg" id="sVia" role="radiogroup" aria-label="Students join through">
            <button data-net="1" role="radio">School network</button>
            <button data-net="0" role="radio">Remote mode</button>
          </div>
          <p class="note" id="sViaNote"></p>
        </div>
        <div class="n-label">Raise hand</div>
        <div class="card">
          <div class="row">
            <label for="sHandPc">Chime on the PC when a hand goes up</label>
            <input type="checkbox" class="switch" id="sHandPc" checked>
          </div>${deviceSound ? `
          <div class="row">
            <label for="sHandPad">Chime on this device too</label>
            <input type="checkbox" class="switch" id="sHandPad" checked>
          </div>` : ''}
        </div>
        <p class="note" id="sHandRules">Students tap ✋ on their Chromebook. The PC decides when to chime, so it can’t be used to make noise.</p>
        <div class="n-label">Students can use</div>
        <div class="card" id="sTools">${STUDENT_TOOLS.map(([k, label]) => `
          <div class="row">
            <label for="sTool-${k}">${label}</label>
            <input type="checkbox" class="switch" id="sTool-${k}" data-stool="${k}" checked>
          </div>`).join('')}
        </div>
        </details>
        <div class="s-box" id="sWallsBox" hidden>
          <div class="s-head"><b>🗒️ Class walls in this board</b></div>
          <div class="s-list s-walls" id="sWallsList"></div>
          <label class="s-apart"><input type="checkbox" id="sWallsNames" checked> With students’ names</label>
          <button id="sWallsCompare" class="s-act" disabled>Compare the two ticked</button>
          <p class="note">A PDF of a wall: a picture of it, then each student’s words and drawing. Tick two walls (the start of a unit and later) to see each student’s two notes side by side. Saved on the PC (Documents › PadLink › Poll results). The lesson’s PDF report (Poll tab) has its walls too.</p>
        </div>
        <button id="sCloseBtn" class="quiet-btn danger" hidden>Close the class</button>
      </section>

      <section id="tabPoll" hidden>
        <div class="s-actions" id="pPrep" hidden>
          <button id="pPrepPage" class="s-act">📊 Poll for this page</button>
          <button id="pPrepPaste" class="s-act">📋 Paste questions</button>
        </div>
        <div id="pNoClass">
          <p class="note">A poll asks every student in the class at once: they answer with big buttons on their Chromebooks. Open the class first, in the Students tab.</p>
          <button id="pToStudents" class="pick-btn">Go to Students</button>
        </div>
        <div class="s-box" id="pSelfBox" hidden>
          <div class="s-head"><b id="pSelfTitle">Their own pace</b></div>
          <p class="note" id="pSelfNote"></p>
          <details class="p-who" id="pSelfWho"><summary id="pSelfSum">Each student</summary><div class="p-self" id="pSelfGrid"></div></details>
        </div>
        <div id="pSetup" hidden>
          <div class="s-box p-page" id="pPageBox" hidden>
            <div class="s-head"><b>📊 This page has a poll</b></div>
            <p class="p-page-q" id="pPageQ"></p>
            <button id="pPageStart" class="pick-btn">Start this page’s poll</button>
          </div>
          <div class="n-label">Question (optional)</div>
          <input id="pQuestion" class="p-text" type="text" maxlength="200" placeholder="Type the question, or leave it empty" autocomplete="off" enterkeyhint="done" aria-label="Question">
          <div class="n-label">Answers</div>
          <div class="p-kinds" id="pKind" role="radiogroup" aria-label="Answers">
            <button data-pkind="mc" role="radio">Multiple choice</button>
            <button data-pkind="tf" role="radio">True / False</button>
            <button data-pkind="yn" role="radio">Yes / No</button>
            <button data-pkind="draw" role="radio">✏️ Draw</button>
            <button data-pkind="num" role="radio">🔢 Number</button>
            <button data-pkind="text" role="radio">✍️ Short answer</button>
            <button data-pkind="long" role="radio" title="A few sentences or a paragraph (up to 1,000 characters): each answer shown in full">📝 Long answer</button>
          </div>
          <div class="p-count" id="pCountRow"><button type="button" id="pFewer" aria-label="One choice fewer">−</button><span id="pCountText">A–D</span><button type="button" id="pMoreChoices" aria-label="One more choice">+</button></div>
          <div id="pRightBox">
            <div class="n-label">Correct answer (optional)</div>
            <div class="p-kinds p-correct" id="pRight" role="radiogroup" aria-label="Correct answer"></div>
            <input id="pRightText" class="p-text" type="text" maxlength="80" autocomplete="off" enterkeyhint="done" aria-label="Correct answer">
            <p class="note p-right-note">Students don’t see it until you show it, after the results.</p>
          </div>
          <label class="s-apart" id="pBgRow"><input type="checkbox" id="pBg"> Draw on a picture of the whiteboard page</label>
          <div class="n-label">Time limit</div>
          <div class="seg small n-seg" id="pTime" role="radiogroup" aria-label="Time limit">
            <button data-psecs="0" role="radio">No limit</button>
            <button data-psecs="30" role="radio">0:30</button>
            <button data-psecs="60" role="radio">1:00</button>
            <button data-psecs="120" role="radio">2:00</button>
          </div>
          <p class="note">When the time runs out, the PC chimes once. The timer’s chime switch turns it off (Timer → Size and chime).</p>
          <label class="s-apart" id="pShuffleRow"><input type="checkbox" id="pShuffle"> Shuffle the answers on each Chromebook (A is still A)</label>
          <label class="s-apart"><input type="checkbox" id="pOnBoard"> Show a poll's question on the whiteboard</label>
          <button id="pStart" class="pick-btn">Start the poll</button>
          <details class="c-more" id="pHow"><summary>How students answer</summary>
          <p class="note">Type the question here, put it on your whiteboard, or ask it aloud. Students tap an answer (or type a number or a few words), then <b>Lock it in</b>. They can change it until the poll closes, and their screen never shows which answer they chose, so a neighbour can’t copy it.</p>
          <p class="note" id="pPrepNote">To prepare polls ahead, with the question and answers: the whiteboard's 📊 Poll for this page or 📋 Paste questions (in Pages → Poll).</p>
          </details>
        </div>
        <div id="pLive" hidden>
          <div class="p-top"><span class="p-state" id="pState"></span><span class="p-clock" id="pClock"></span></div>
          <div class="p-count" id="pCount"></div>
          <div class="p-sub" id="pSub"></div>
          <div class="p-bars" id="pBars"></div>
          <div class="s-box p-drawbox" id="pDrawBox" hidden>
            <p class="note" id="pDrawNote"></p>
            <div class="p-drawgrid" id="pDrawGrid"></div>
            <label class="s-apart" id="pDrawNameRow"><input type="checkbox" id="pDrawNames"> Show names</label>
            <div class="s-actions"><button id="pDrawSide" class="s-act" disabled>Show side by side</button><button id="pDrawAll" class="s-act">Show all</button></div>
            <button id="pDrawStop" class="s-act s-make" hidden>Stop showing</button>
          </div>
          <p class="note" id="pNote"></p>
          <div class="s-actions" id="pOpenActs">
            <button id="pMore" class="s-act">+0:30</button>
            <button id="pClose" class="s-act on">Close the poll</button>
          </div>
          <button id="pOnBoardLive" class="s-act p-onboard" hidden></button>
          <div id="pCorrectBox">
            <div class="n-label">Correct answer (optional)</div>
            <div class="p-kinds" id="pCorrect" role="radiogroup" aria-label="Correct answer"></div>
          </div>
          <div class="s-actions" id="pDoneActs">
            <button id="pReopen" class="s-act" title="Open the poll again for another minute: students can still answer">+1:00 more time</button>
            <button id="pShow" class="s-act">Show results</button>
            <button id="pReveal" class="s-act" hidden>Show the correct answer</button>
            <button id="pNew" class="s-act s-finish">✓ Finish the poll</button>
          </div>
          <details class="p-who" id="pWhoBox">
            <summary id="pWhoSum">Who chose what</summary>
            <div id="pWho"></div>
          </details>
        </div>
        <div class="s-box p-hist" id="pHistBox" hidden>
          <div class="s-head"><b id="pHistTitle">Lesson so far</b></div>
          <div class="p-cards" id="pLessonCards"></div>
          <div id="pHist"></div>
          <p class="p-again" id="pAgain" hidden></p>
          <details class="p-who" id="pEachBox">
            <summary id="pEachSum">Each student</summary>
            <div id="pEach"></div>
          </details>
          <div class="s-actions">
            <button id="pLessonShow" class="s-act">Show the class</button>
            <label class="s-apart p-answers-row" id="pAnswersRow"><input type="checkbox" id="pLessonAnswers"> Show correct answers</label>
          </div>
          <p class="note" id="pLessonNote">Show the class puts every closed poll's bars on the whiteboard, without names. The correct answers stay hidden until you tick Show correct answers.</p>
          <details class="c-more" id="pSave"><summary>Reports (PDF or spreadsheet)</summary>
          <label class="s-apart"><input type="checkbox" id="pNames" checked> With students’ names</label>
          <div class="s-actions">
            <button id="pReport" class="s-act on">PDF report</button>
            <button id="pExport" class="s-act">Export as CSV</button>
          </div>
          <p class="note"><b>PDF report</b>: a printable summary of every poll (bars, percent correct, what to reteach, each student's answers and score), and the lesson's class walls. <b>CSV</b>: the same answers as a spreadsheet. Both are saved on the PC (Documents › PadLink › Poll results). Polls are deleted when you close the class.</p>
          </details>
        </div>
        <div class="s-box p-board" id="pBoardBox" hidden>
          <div class="s-head"><b id="pBoardTitle">Polls in this board</b></div>
          <div id="pBoardList"></div>
          <p class="note">Tap a poll to go to its page on the whiteboard.</p>
        </div>
      </section>`;

  // The Students tab's own look (the rest of the panel uses the pad's and the whiteboard's shared styles).
  const STUDENT_CSS = `
    #tabStudents .s-select { width: 100%; min-height: 44px; margin: 4px 0 12px; padding: 0 12px; border: 1px solid rgba(29,36,51,.15); border-radius: 12px; background: #fff; font: inherit; color: inherit; }
    #tabStudents .s-info { margin: 2px 0 10px; font-weight: 600; }
    #tabStudents .s-actions, #tabPoll .s-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    #tabStudents .s-act, #tabPoll .s-act { min-height: 46px; padding: 0 10px; border: 0; border-radius: 12px; background: #eef3ff; color: #1e4fc2; font: inherit; font-weight: 700; cursor: pointer; }
    #tabStudents .s-act:hover, #tabPoll .s-act:hover { background: #e2eaff; }
    #tabStudents .s-act.on, #tabPoll .s-act.on { background: #2f6bff; color: #fff; }
    #tabStudents .s-box { margin-bottom: 12px; padding: 10px 12px; border-radius: 14px; background: rgba(29,36,51,.04); }
    #tabStudents .s-box.warn { background: #fff4e5; }
    #tabStudents .s-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; }
    #tabStudents .s-list { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
    #tabStudents .s-person { display: flex; align-items: center; gap: 8px; min-height: 40px; }
    #tabStudents .s-person .s-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tabStudents .s-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: #16a34a; }
    #tabStudents .s-dot.away { background: #a8b0c0; }
    #tabStudents .s-link { display: flex; justify-content: center; margin: -6px 0 10px; }
    #tabStudents .s-link-btn { padding: 4px 8px; border: 0; border-radius: 8px; background: none; color: #5b6478; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; }
    #tabStudents .s-link-btn:hover { background: rgba(29,36,51,.06); color: #1e4fc2; }
    #tabStudents .s-link-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5b6478; font-size: 13.5px; }
    #tabStudents .s-link-changed { margin: -6px 0 12px; padding: 8px 10px; border-radius: 10px; background: #fff4e5; color: #8a4b00; }
    #tabStudents .s-via { flex: none; padding: 2px 8px; border-radius: 999px; background: #eef3ff; color: #1e4fc2; font-size: 12px; font-weight: 700; }
    #tabStudents .s-small { min-height: 34px; padding: 0 12px; border: 0; border-radius: 10px; background: rgba(29,36,51,.07); color: inherit; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    #tabStudents .s-small:hover { background: rgba(29,36,51,.12); }
    #tabStudents .s-small.primary { background: #2f6bff; color: #fff; }
    #tabStudents .s-small.primary:hover { background: #2559e0; }
    #tabStudents .s-small.danger { background: none; color: #b42318; font-weight: 600; }
    #tabStudents .s-small.danger:hover { background: #fdecec; }
    #tabStudents .s-empty { color: #5b6478; font-size: 13.5px; padding: 4px 0; }
    #tabStudents .s-wall .s-person { align-items: flex-start; padding: 4px 0; }
    #tabStudents .s-wall .s-words { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    #tabStudents .s-wall .s-words b { font-size: 14px; }
    #tabStudents .s-wall .s-words span { color: #5b6478; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tabStudents .s-wall .s-person.hid .s-words span { font-style: italic; }
    #tabStudents .s-walls .s-person input { flex: none; width: 20px; height: 20px; }
    #tabStudents .s-wall-make { flex-wrap: wrap; }
    #tabStudents .s-wall-make .s-act { flex: 1 1 140px; }
    #tabStudents #sCloseBtn { margin-top: 14px; }
    #tabStudents .s-box.hand { background: #fff3e6; }
    .n-table { display: flex; flex-direction: column; gap: 6px; }
    .n-head, .n-row { display: grid; grid-template-columns: minmax(0, 1fr) 52px 52px 36px; gap: 6px; align-items: center; }
    .n-head span { padding: 0 4px; color: #5b6478; font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .n-row input { width: 100%; min-width: 0; height: 40px; padding: 0 10px; border: 1px solid rgba(29,36,51,.15); border-radius: 10px; background: #fff; font: inherit; color: inherit; box-sizing: border-box; }
    .n-row .n-tm, .n-row .n-st { padding: 0 4px; text-align: center; }
    .n-row input:focus { outline: none; border-color: #2f6bff; box-shadow: 0 0 0 3px rgba(47,107,255,.15); }
    .n-row.bad input { border-color: #b42318; background: #fff6f5; }
    .n-del { width: 36px; height: 36px; border: 0; border-radius: 10px; background: none; color: #8a93a6; font: inherit; font-size: 15px; cursor: pointer; }
    .n-del:hover { background: #fdecec; color: #b42318; }
    .n-add { align-self: flex-start; min-height: 40px; padding: 0 14px; border: 0; border-radius: 10px; background: #eef3ff; color: #1e4fc2; font: inherit; font-weight: 700; cursor: pointer; }
    #nCount.bad { color: #b42318; font-weight: 600; }
    #tabStudents .s-how button { padding: 0 6px; }
    #tabStudents .s-how button.unavail { opacity: .4; }
    #tabStudents .s-apart { display: flex; align-items: center; gap: 8px; margin: 2px 0 10px; font-size: 14.5px; }
    #tabStudents .s-apart[hidden] { display: none; }
    #tabStudents .s-make { width: 100%; }
    #tabStudents .s-pace-acts { display: flex; gap: 8px; margin-top: 8px; }
    #tabStudents .s-compare { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #eef3ff; color: #1e4fc2; font-weight: 600; font-size: 14px; }
    #tabStudents .s-pace-acts .s-act { flex: 1; }
    #tabStudents .s-eyes { background: #fff4e5; color: #8a4b00; }
    #tabStudents .s-eyes:hover { background: #ffe8c7; }
    #tabStudents .s-eyes.on { background: #e8590c; color: #fff; }
    #tabStudents .s-draw.on { background: #157f3c; }
    #tabStudents .s-draw[hidden], #tabStudents [hidden] { display: none; }
    #tabStudents .s-teams { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 6px 0 8px; }
    #tabStudents .s-team { padding: 8px; border-radius: 12px; background: #fff; box-shadow: 0 0 0 1px rgba(29,36,51,.08); }
    #tabStudents .s-team-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 4px; font-weight: 700; font-size: 14px; }
    #tabStudents .s-team-head button { min-height: 28px; padding: 0 8px; border: 0; border-radius: 8px; background: rgba(29,36,51,.07); color: inherit; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    #tabStudents .s-team-head .s-here { background: #2f6bff; color: #fff; }
    #tabStudents .s-member { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 30px; padding: 0 6px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
    #tabStudents .s-member:hover { background: rgba(29,36,51,.05); }
    #tabStudents .s-member.picked { background: #2f6bff; color: #fff; }
    #tabStudents .s-member .s-seat { flex: none; width: 20px; height: 20px; border-radius: 6px; background: rgba(29,36,51,.08); font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; }
    #tabStudents .s-member.picked .s-seat { background: rgba(255,255,255,.25); }
    #tabStudents .s-member.away { opacity: .55; }
    #tabStudents .s-member .s-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tabStudents .s-hand { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; }
    #tabStudents .s-hand + .s-hand { border-top: 1px solid rgba(29,36,51,.08); }
    #tabStudents .s-hand .s-who { flex: 1; min-width: 0; }
    #tabStudents .s-hand .s-name { display: block; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tabStudents .s-hand .s-note { display: block; margin-top: 2px; font-size: 14px; overflow-wrap: anywhere; }
    #tabStudents .s-hand .s-meta { display: block; margin-top: 2px; color: #5b6478; font-size: 12.5px; }
    #tabStudents .s-hand .s-meta.busy { color: #b45309; font-weight: 600; }
    #tabStudents .s-hand-off { min-height: 34px; padding: 0 8px; border: 0; border-radius: 10px; background: none; font: inherit; font-size: 16px; cursor: pointer; }
    #tabStudents .s-hand-off.off { opacity: .35; text-decoration: line-through; }
    #tabPoll .p-kinds { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 4px; }
    #tabPoll .p-kinds button { min-height: 44px; padding: 0 6px; border: 0; border-radius: 12px; background: rgba(29,36,51,.06); color: inherit; font: inherit; font-weight: 700; cursor: pointer; }
    #tabPoll .p-kinds button[data-pkind="mc"], #tabPoll .p-kinds button[data-pkind="tf"], #tabPoll .p-kinds button[data-pkind="yn"], #tabPoll .p-kinds button[data-pkind="draw"], #tabPoll .p-kinds button[data-pkind="num"], #tabPoll .p-kinds button[data-pkind="text"] { grid-column: span 2; }
    #tabPoll .p-count { display: flex; align-items: center; gap: 8px; margin: 4px 0 6px; }
    #tabPoll .p-count[hidden] { display: none; }
    #tabPoll .p-count button { width: 44px; height: 40px; border: 0; border-radius: 12px; background: rgba(29,36,51,.06); color: inherit; font: inherit; font-size: 20px; font-weight: 700; cursor: pointer; }
    #tabPoll .p-count button:disabled { opacity: .35; cursor: default; }
    #tabPoll .p-text { display: block; width: 100%; height: 44px; margin: 2px 0 10px; padding: 0 12px; border: 1px solid rgba(29,36,51,.15); border-radius: 12px; background: #fff; font: inherit; color: inherit; box-sizing: border-box; }
    #tabPoll .p-text:focus { outline: none; border-color: #2f6bff; box-shadow: 0 0 0 3px rgba(47,107,255,.15); }
    #tabPoll .p-right-note { margin: 0 0 10px; font-size: 13px; }
    #tabPoll .s-actions .s-finish { grid-column: 1 / -1; background: #2f6bff; color: #fff; }
    #tabPoll .s-actions .s-finish:hover { background: #2559e0; }
    #tabPoll .p-count span { min-width: 64px; text-align: center; font-weight: 700; }
    #tabPoll .p-bar.hid b, #tabPoll .p-bar.hid .p-num { opacity: 0.45; }
    #tabPoll .p-bar.hid b { text-decoration: line-through; }
    #tabPoll .p-bars.typed .p-bar { grid-template-columns: minmax(28px, 40%) 1fr 74px auto; }
    #tabPoll .p-bars.typed .p-bar b { font-size: 15px; overflow-wrap: anywhere; }
    #tabPoll .p-bars.long { max-height: 50vh; overflow-y: auto; }
    #tabPoll .p-bars.long .p-bar { grid-template-columns: 1fr auto; align-items: start; padding: 8px 10px; border-radius: 12px; background: rgba(29, 36, 51, 0.04); }
    #tabPoll .p-bars.long .p-bar b { font-size: 15px; font-weight: 500; line-height: 1.4; white-space: pre-wrap; }
    #tabPoll .p-bars.long .p-track, #tabPoll .p-bars.long .p-num { display: none; }
    #tabPoll .p-hide { min-height: 30px; padding: 0 10px; border: 0; border-radius: 9px; background: #eef1f7; color: #1d2433; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    #tabPoll .p-hide.on { background: #fff4e5; color: #8a4b00; }
    #tabPoll .p-reveal { width: 100%; min-height: 40px; border: 1px dashed rgba(29, 36, 51, 0.25); border-radius: 12px; background: transparent; color: #1d2433; font: inherit; font-weight: 700; cursor: pointer; }
    #tabPoll .p-drawgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin: 6px 0 8px; }
    #tabPoll .p-draw { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 4px; border: 0; border-radius: 10px; background: #fff; box-shadow: 0 0 0 1px rgba(29,36,51,.12); font: inherit; font-size: 12.5px; font-weight: 600; color: #5b6478; cursor: pointer; }
    #tabPoll .p-draw canvas { width: 100%; height: auto; border-radius: 6px; }
    #tabPoll .p-draw.on { box-shadow: 0 0 0 3px #2f6bff; background: #fff; color: #5b6478; }
    #tabPoll .p-draw { height: auto; min-width: 0; } /* (the whiteboard sizes every button 44 px tall) */
    #tabPoll .p-draw.on::before { content: attr(data-letter); position: absolute; top: 8px; left: 8px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: #2f6bff; color: #fff; font-weight: 800; }
    #tabPoll .p-kinds button.on { background: #2f6bff; color: #fff; }
    #tabPoll .p-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; }
    #tabPoll .p-state { font-weight: 700; }
    #tabPoll .p-state.open::before { content: ''; display: inline-block; width: 9px; height: 9px; margin-right: 8px; border-radius: 50%; background: #16a34a; vertical-align: 1px; }
    #tabPoll .p-clock { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
    #tabPoll .p-clock.soon { color: #b45309; }
    #tabPoll .p-count { margin-top: 6px; font-size: 26px; font-weight: 800; }
    #tabPoll .p-sub { color: #5b6478; font-size: 14px; margin-bottom: 10px; }
    #tabPoll .p-bars { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 10px; }
    #tabPoll .p-bar { display: grid; grid-template-columns: minmax(28px, auto) 1fr 74px; align-items: center; gap: 10px; }
    #tabPoll .p-bar b { font-size: 17px; }
    #tabPoll .p-track { height: 24px; border-radius: 8px; background: rgba(29,36,51,.07); overflow: hidden; }
    #tabPoll .p-fill { height: 100%; border-radius: 8px; background: #2f6bff; transition: width .3s; }
    #tabPoll .p-num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    #tabPoll .p-num small { color: #5b6478; font-weight: 500; }
    #tabPoll .p-who { margin-top: 6px; padding: 8px 12px; border-radius: 14px; background: rgba(29,36,51,.04); }
    #tabPoll .p-who summary { min-height: 30px; font-weight: 700; cursor: pointer; }
    #tabPoll .p-self-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px 92px 44px; align-items: center; gap: 8px; min-height: 34px; font-size: 14px; }
    #tabPoll .p-self-row.head { min-height: 26px; font-size: 12.5px; font-weight: 600; color: #5b6478; }
    #tabPoll .p-self-row.away { color: #a0a8b8; }
    #tabPoll .p-self-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tabPoll .p-self-flag { margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: #fff4e5; color: #8a4b00; font-size: 11.5px; font-style: normal; font-weight: 700; }
    #tabPoll .p-self-bar { display: flex; align-items: center; gap: 6px; }
    #tabPoll .p-self-bar i { display: block; flex: 1; height: 8px; border-radius: 4px; background: linear-gradient(#2f6bff, #2f6bff) left / var(--w, 0) 100% no-repeat, #e6e9f0; }
    #tabPoll .p-self-bar small { font-size: 12px; color: #5b6478; }
    #tabPoll [hidden] { display: none; }
    #tabPoll .p-group { margin: 6px 0; font-size: 14px; }
    #tabPoll .p-group b { display: block; }
    #tabPoll .p-group span { color: #3a4256; }
    #tabPoll .p-bar.right b { color: #2b8a3e; }
    #tabPoll .p-bar.right .p-fill { background: #2f9e44; }
    #tabPoll .p-kinds.p-correct button.on { background: #2f9e44; }
    #tabPoll .s-box { margin: 14px 0 12px; padding: 10px 12px; border-radius: 14px; background: rgba(29,36,51,.04); }
    #tabPoll .s-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; }
    #tabPoll .s-apart { display: flex; align-items: center; gap: 8px; margin: 8px 0 10px; font-size: 14.5px; }
    #tabPoll .s-make { width: 100%; }
    #tabPoll .p-hrow { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 14px; }
    #tabPoll .p-hrow + .p-hrow { border-top: 1px solid rgba(29,36,51,.08); }
    #tabPoll .p-hrow span:last-child { color: #5b6478; text-align: right; }
    #tabPoll .p-page { background: #eef3ff; }
    #tabPoll .p-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 4px 0 8px; }
    #tabPoll .p-card { padding: 8px 6px; border-radius: 10px; background: #fff; text-align: center; font-size: 12.5px; color: #5b6478; }
    #tabPoll .p-card b { display: block; font-size: 19px; color: #1d2433; }
    #tabPoll .p-card.ok b { color: #2b8a3e; }
    #tabPoll .p-hrow .p-flag { font-weight: 600; }
    #tabPoll .p-flag.reteach { color: #b45309; }
    #tabPoll .p-flag.gotit { color: #2b8a3e; }
    #tabPoll .p-again { margin: 8px 0 4px; padding: 8px 10px; border-radius: 10px; background: #fff4e5; font-size: 13.5px; }
    #tabPoll .p-answers-row { justify-content: center; margin: 0; }
    #tabPoll .p-each { display: flex; justify-content: space-between; padding: 3px 0; font-size: 14px; }
    #tabPoll .p-each + .p-each { border-top: 1px solid rgba(29,36,51,.06); }
    #tabPoll .p-each.low span:last-child { color: #b45309; font-weight: 600; }
    #tabPoll .p-brow { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 4px; border: 0; border-bottom: 1px solid rgba(29,36,51,.08); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    #tabPoll .p-brow:last-child { border-bottom: 0; }
    #tabPoll .p-brow:hover { background: rgba(29,36,51,.04); }
    #tabPoll .p-brow .p-pg { flex: none; width: 52px; color: #5b6478; font-size: 13px; }
    #tabPoll .p-brow .p-bq { flex: 1; min-width: 0; font-size: 14px; }
    #tabPoll .p-brow .p-bq small { display: block; color: #5b6478; font-size: 12.5px; }
    #tabPoll .p-brow .p-bq small.warn { color: #b45309; }
    #tabPoll .p-brow .p-res { flex: none; font-size: 13px; font-weight: 600; color: #5b6478; }
    #tabPoll .p-brow .p-res.ok { color: #2b8a3e; }
    #tabPoll .p-brow .p-start { flex: none; min-height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: #2f6bff; color: #fff; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
    #tabPoll .p-page .pick-btn { margin: 8px 0 4px; }
    #tabPoll .p-page-q { margin: 2px 0 0; font-size: 15px; }
    #tabPoll .p-qtext { margin: 4px 0 2px; font-size: 16px; font-weight: 600; }
    .c-more { margin: 16px 0 8px; padding: 6px 12px; border-radius: 14px; background: rgba(29,36,51,.04); }
    .c-more > summary { display: flex; align-items: center; gap: 8px; min-height: 38px; font-weight: 700; cursor: pointer; list-style: none; }
    .c-more > summary::-webkit-details-marker { display: none; }
    .c-more > summary::after { content: ''; width: 8px; height: 8px; margin: -4px 4px 0 auto; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(45deg); opacity: .5; transition: transform .15s; }
    .c-more[open] > summary::after { transform: rotate(-135deg); margin-top: 4px; }
    .c-more[open] { padding-bottom: 10px; }
    .c-more > .n-label:first-of-type { margin-top: 4px; }
    .c-more .card { background: #fff; }
    /* Close the poll (or Finish) stays in reach while the bars or drawings scroll */
    #tabPoll .p-onboard { width: 100%; margin: 0 0 12px; }
    #tabPoll #pOpenActs, #tabPoll #pDoneActs { position: sticky; bottom: 0; z-index: 2; margin: 0 -4px 12px; padding: 8px 4px; background: var(--panel, var(--bar, #fff)); box-shadow: 0 -10px 12px -10px rgba(29,36,51,.25); }
  `;

  function fmtTime(ms) {
    const secs = Math.max(0, Math.ceil(ms / 1000 - 0.001));
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${Math.floor(secs / 60)}:${String(s).padStart(2, '0')}`;
  }

  /**
   * opts: {
   *   tabs, body: elements to fill (the tab buttons; the timer and names sections),
   *   send(msg), notice(text, ms), connected() → bool,
   *   self: 'pad' | 'board' (which screen this is: a class saved here closes this editor, not the other screen's),
   *   deviceSound: offer "Chime on this device too" (the pad; the whiteboard is on the PC, which chimes anyway),
   *   store: { get(key), set(key, value) } for remembered choices,
   *   onTimer(state, text): the timer changed or ticked (for a badge on the button that opens the panel),
   *   openGrid(url): show the teacher's grid of student boards (Students tab),
   *   onStudents(msg): news of the class (for a "waiting" badge on the button that opens the panel),
   * }
   * Call .opened() when the panel is shown, and .onMessage(msg) with every message from the PC (true if it was ours).
   */
  function Panel(opts) {
    const { send, notice } = opts;
    const connected = opts.connected || (() => true);
    const root = opts.body.ownerDocument;
    opts.tabs.innerHTML = TABS;
    opts.body.innerHTML = BODY(!!opts.deviceSound);
    opts.body.querySelectorAll('details.c-more').forEach(d => {
      const k = 'padlink.more.' + d.id;
      try { d.open = localStorage.getItem(k) === '1'; } catch { }
      d.addEventListener('toggle', () => { try { localStorage.setItem(k, d.open ? '1' : '0'); } catch { } });
    });
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => [...root.querySelectorAll(s)];

    const prefs = { pcSound: true, padSound: true, handSound: true, ticking: true, tab: 'timer' };
    try { Object.assign(prefs, JSON.parse(opts.store.get('class') || '{}')); } catch { /* old or broken: defaults */ }
    const savePrefs = () => opts.store.set('class', JSON.stringify(prefs));

    function showTab(tab) {
      prefs.tab = ['names', 'students', 'poll'].includes(tab) ? tab : 'timer';
      savePrefs();
      for (const b of opts.tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.ctab === prefs.tab);
      $('#tabTimer').hidden = prefs.tab !== 'timer';
      $('#tabNames').hidden = prefs.tab !== 'names';
      $('#tabStudents').hidden = prefs.tab !== 'students';
      $('#tabPoll').hidden = prefs.tab !== 'poll';
      if (prefs.tab === 'students' || prefs.tab === 'poll') send({ t: 'students' });
    }
    for (const b of opts.tabs.querySelectorAll('button')) b.addEventListener('click', () => showTab(b.dataset.ctab));

    // --- sound: Safari only plays audio after a tap, so the audio is switched on by taps in this panel ---

    let audio = null;
    function unlockAudio() {
      if (!opts.deviceSound) return;
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
      } catch { /* no Web Audio */ }
    }

    if (opts.deviceSound) root.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true });

    /** Raise hand: two soft notes, falling (different from the timer's, so it's clear which it is). */
    function handChime() {
      if (!audio) return;
      const t0 = audio.currentTime + 0.05;
      [[1318.51, 0], [987.77, 0.22]].forEach(([f, offset]) => {
        const at = t0 + offset;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
        osc.connect(gain).connect(audio.destination);
        osc.start(at);
        osc.stop(at + 1);
      });
    }

    /** The same three rising bell notes as the PC, twice (the timer) or once (a poll's time ran out). */
    function chime(once) {
      if (!audio) return;
      const t0 = audio.currentTime + 0.05;
      const notes = [880, 1108.73, 1318.51];
      (once === true ? [0, 0.16, 0.32] : [0, 0.16, 0.32, 1, 1.16, 1.32]).forEach((offset, i) => {
        const at = t0 + offset;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = notes[i % 3];
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.3, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
        osc.connect(gain).connect(audio.destination);
        osc.start(at);
        osc.stop(at + 1.2);
      });
    }

    // --- timer ---

    let timer = { state: 'idle', remainingMs: 0, endsAt: 0 };
    const timerLeft = () => (timer.state === 'running' ? Math.max(0, timer.endsAt - performance.now()) : timer.remainingMs);

    function renderTimer() {
      const left = timerLeft();
      const display = $('#tDisplay');
      display.textContent = timer.state === 'idle' ? '0:00' : fmtTime(left);
      display.className = 't-display ' + timer.state;
      $('#tState').textContent = {
        idle: 'Shows in the bottom-right corner of the PC screen',
        running: 'Counting down on the PC screen',
        paused: 'Paused',
        done: 'Time’s up!',
      }[timer.state] || '';
      const pause = $('#tPause');
      pause.disabled = timer.state !== 'running' && timer.state !== 'paused';
      pause.textContent = timer.state === 'paused' ? 'Resume' : 'Pause';
      $('#tStop').disabled = timer.state === 'idle';
      if (opts.onTimer) opts.onTimer(timer.state, timer.state === 'done' ? '0:00' : fmtTime(left));
    }
    setInterval(() => { if (timer.state === 'running') renderTimer(); }, 250);

    function onTimer(msg) {
      timer = { state: msg.state, remainingMs: msg.remainingMs, endsAt: performance.now() + msg.remainingMs };
      if (typeof msg.boxSize === 'number') for (const b of $$('[data-tsize]')) { const on = Number(b.dataset.tsize) === msg.boxSize; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
      renderTimer();
      if (msg.expired) {
        if (opts.deviceSound && prefs.padSound) chime();
        if (opts.timesUp) opts.timesUp(); else notice('Time’s up!', 4000); // one blue alert per screen
      }
    }

    function sendTimer(cmd, seconds) {
      unlockAudio();
      send({ t: 'timer', cmd, seconds, pcSound: prefs.pcSound });
    }
    for (const b of $$('.t-presets button')) b.addEventListener('click', () => sendTimer('start', Number(b.dataset.secs)));
    $('#tCustom').addEventListener('submit', (e) => {
      e.preventDefault();
      const secs = (Number($('#tMin').value) || 0) * 60 + (Number($('#tSec').value) || 0);
      if (secs <= 0) { notice('Type the minutes and/or seconds first.'); return; }
      sendTimer('start', secs);
      root.activeElement.blur(); // put the keyboard away
    });
    $('#tAdd').addEventListener('click', () => sendTimer('add', 30));
    for (const b of $$('[data-tsize]')) b.addEventListener('click', () => send({ t: 'timer', cmd: 'size', boxSize: Number(b.dataset.tsize) }));
    $('#tPause').addEventListener('click', () => sendTimer(timer.state === 'paused' ? 'resume' : 'pause'));
    $('#tStop').addEventListener('click', () => sendTimer('stop'));
    $('#tPcSound').checked = prefs.pcSound;
    $('#tPcSound').addEventListener('change', (e) => { prefs.pcSound = e.target.checked; savePrefs(); sendTimer('sound'); });
    if (opts.deviceSound) {
      $('#tPadSound').checked = prefs.padSound;
      $('#tPadSound').addEventListener('change', (e) => { prefs.padSound = e.target.checked; savePrefs(); if (e.target.checked) chime(); });
    }

    // --- name picker ---

    let rosters = { rosters: [], active: null, eachOnce: true, style: 'wheel' };
    let editing = null;      // null = not editing; '' = a new class; otherwise the id of the class being edited
    let pickWait = 0;    // waiting for the name to show (the wheel is spinning): Spin again starts a fresh spin
    let pickSending = 0; // waiting for the PC to answer a Spin (a moment)
    // Hold Pick a name (iPad and iPhone only, never the PC's own screen, which the class sees): choose who it lands on,
    // or who's left out today. null = not open; 'pick' or 'out' = which.
    let choosing = null;

    const currentRoster = () => rosters.rosters.find((r) => r.id === rosters.active) || rosters.rosters[0];

    function renderNames() {
      const has = rosters.rosters.length > 0;
      const inEditor = editing !== null;
      $('#nEmpty').hidden = has || inEditor;
      $('#nMain').hidden = !has || inEditor || !!choosing;
      $('#nEditor').hidden = !inEditor;
      $('#nChoose').hidden = !has || inEditor || !choosing;
      if (!has) return;

      const r = currentRoster();
      rosters.active = r.id;
      const sel = $('#nRoster');
      sel.innerHTML = '';
      for (const x of rosters.rosters) {
        const opt = root.createElement('option');
        opt.value = x.id;
        opt.textContent = `${x.name} (${x.students.length})`;
        sel.appendChild(opt);
      }
      sel.value = r.id;
      for (const b of $$('#nStyle button')) b.classList.toggle('on', b.dataset.style === rosters.style);
      for (const b of $$('#nMode button')) b.classList.toggle('on', (b.dataset.once === '1') === rosters.eachOnce);

      const out = r.out || [];
      const notYet = r.students.filter((s) => !r.called.includes(s) && !out.includes(s)).length;
      $('#nLeft').textContent = r.students.length === 0 ? 'This class has no names yet: tap Edit.'
        : (rosters.eachOnce ? `${notYet} of ${r.students.length - out.length} not picked yet` : `${r.students.length - out.length} names`)
          + (out.length && opts.self === 'pad' ? ` · ${out.length} left out today` : '');
      if (choosing) renderChoose(r);
      $('#nReset').hidden = !rosters.eachOnce || r.called.length === 0;
      $('#nPick').disabled = r.students.length === 0 || pickSending !== 0;
    }

    function onRosters(msg) {
      // Keep this screen's unsent choices (style, mode, class) unless this screen just saved a class.
      const keep = { active: rosters.active, eachOnce: rosters.eachOnce, style: rosters.style };
      const first = !rosters.loaded;
      rosters = { rosters: msg.rosters || [], active: msg.active, eachOnce: msg.eachOnce !== false, style: msg.style === 'flash' ? 'flash' : 'wheel', loaded: true };
      if (!first) Object.assign(rosters, keep);
      if (msg.saved && (!msg.by || msg.by === opts.self)) {
        rosters.active = msg.saved;
        editing = null;
      }
      if (editing && !rosters.rosters.some((r) => r.id === editing)) editing = null; // deleted
      renderNames();
      renderStudentLists();
    }

    function onPicked(msg) {
      clearTimeout(pickWait);
      clearTimeout(pickSending);
      pickSending = 0;
      // Show the name here when it lands on the PC screen, not before (no spoilers for the teacher holding the iPad).
      pickWait = setTimeout(() => {
        pickWait = 0;
        const result = $('#nResult');
        result.className = 'n-result';
        result.textContent = msg.name;
        if (msg.wrapped) notice('Everyone had been picked, so the list started over.', 6000);
        renderNames();
      }, msg.ms || 0);
      if (msg.by && msg.by !== opts.self) { // picked on the other screen: show it's happening here too
        const result = $('#nResult');
        result.className = 'n-result waiting';
        result.textContent = 'Picking on the PC…';
      }
      renderNames();
    }

    function startPick(name) {
      const r = currentRoster();
      if (!r || pickSending) return; // (still spinning is fine: Spin again starts a fresh spin with a new name)
      if (!connected()) { notice('Not connected to the PC.'); return; }
      send({ t: 'pick', id: r.id, eachOnce: rosters.eachOnce, style: rosters.style, ticking: prefs.ticking, ...(name ? { name } : {}) });
      clearTimeout(pickWait);
      pickWait = 0;
      const result = $('#nResult');
      result.className = 'n-result waiting';
      result.textContent = rosters.style === 'wheel' ? 'Spinning on the PC…' : 'Picking on the PC…';
      pickSending = setTimeout(() => { pickSending = 0; renderNames(); }, 10000); // no answer: let them try again
      $('#nPick').disabled = true;
    }
    let held = false; // the hold opened the sheet: the tap that ends it isn't a pick
    $('#nPick').addEventListener('click', () => { if (held) { held = false; return; } startPick(); });

    // The sheet: every name as a button. Land on: a tap spins the PC's picker and lands on that name, exactly as a random
    // pick looks (the same wheel or flashing names, the same time, ticking and "everyone once" count). Leave out today:
    // a tap leaves the name out of random picks until tomorrow (absent, or not ready to be put on the spot).
    function renderChoose(r) {
      for (const b of $$('#nChooseMode button')) b.classList.toggle('on', b.dataset.cm === choosing);
      const out = r.out || [], q = $('#nFind').value.trim().toLowerCase();
      const group = (s) => (out.includes(s) ? 2 : rosters.eachOnce && r.called.includes(s) ? 1 : 0);
      const names = r.students.filter((s) => !q || s.toLowerCase().includes(q));
      if (choosing === 'pick') names.sort((a, b) => group(a) - group(b)); // not picked yet first (the list's own order otherwise)
      const list = $('#nChooseList');
      list.innerHTML = '';
      for (const s of names) {
        const b = root.createElement('button');
        b.type = 'button';
        const g = group(s);
        b.className = 'n-name' + (g === 2 ? ' out' : g === 1 ? ' done' : '');
        const tag = g === 2 ? 'out today' : g === 1 ? 'picked' : '';
        b.innerHTML = '<span></span>' + (tag ? `<small>${tag}</small>` : '');
        b.firstChild.textContent = s;
        b.addEventListener('click', () => {
          if (choosing === 'pick') { choosing = null; $('#nFind').value = ''; startPick(s); renderNames(); return; }
          const next = out.includes(s) ? out.filter((x) => x !== s) : [...out, s];
          r.out = next; // shows at once; the PC sends everyone the list back
          send({ t: 'pickOut', id: r.id, names: next });
          renderNames();
        });
        list.appendChild(b);
      }
      if (!names.length) list.innerHTML = '<p class="note">No name matches.</p>';
      $('#nChooseNote').textContent = choosing === 'pick'
        ? 'Tap a name: the PC picks it the usual way, with the wheel or flashing names, and lands on it.'
        : `Left-out names aren't picked at random${out.length ? ` (${out.length} today)` : ''}. Tomorrow everyone is back in.`;
    }
    function openChoose(mode) {
      choosing = mode;
      $('#nFind').value = '';
      renderNames();
    }
    if (opts.self === 'pad') {
      const btn = $('#nPick');
      let hold = 0;
      btn.classList.add('holdable');
      btn.addEventListener('pointerdown', () => {
        held = false;
        clearTimeout(hold);
        hold = setTimeout(() => { held = true; if (navigator.vibrate) navigator.vibrate(10); openChoose('pick'); }, 550);
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(type, () => clearTimeout(hold));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      $('#nChooseX').addEventListener('click', () => { choosing = null; renderNames(); });
      for (const b of $$('#nChooseMode button')) b.addEventListener('click', () => { choosing = b.dataset.cm; renderNames(); });
      $('#nFind').addEventListener('input', () => renderNames());
    }
    $('#nRoster').addEventListener('change', (e) => {
      choosing = null;
      rosters.active = e.target.value;
      $('#nResult').textContent = '';
      renderNames();
    });
    for (const b of $$('#nStyle button')) b.addEventListener('click', () => { rosters.style = b.dataset.style; renderNames(); });
    for (const b of $$('#nMode button')) b.addEventListener('click', () => { rosters.eachOnce = b.dataset.once === '1'; renderNames(); });
    $('#nReset').addEventListener('click', () => { const r = currentRoster(); if (r) send({ t: 'pickReset', id: r.id }); });
    $('#nHide').addEventListener('click', () => send({ t: 'pickHide' }));
    $('#nTicking').checked = prefs.ticking;
    $('#nTicking').addEventListener('change', (e) => { prefs.ticking = e.target.checked; savePrefs(); });

    // Editing a class list: a table, one row per student (name; home team and seat optional), with ＋ Add student and a
    // ✕ at the end of each row (it asks first). Pasting a list from a spreadsheet into a name box fills the rows.
    function openEditor(roster) {
      editing = roster ? roster.id : '';
      $('#nEditorTitle').textContent = roster ? 'Edit class' : 'New class';
      $('#nName').value = roster ? roster.name : '';
      $('#nRows').textContent = '';
      for (const s of roster ? roster.students : []) {
        const ts = roster.seats && Object.entries(roster.seats).find(([n]) => n.toLowerCase() === s.toLowerCase());
        addRow({ name: s, team: ts ? ts[1][0] : '', seat: ts && ts[1][1] ? ts[1][1] : '' });
      }
      if (!$('#nRows').children.length) addRow();
      $('.n-seats').open = false;
      $('#nDelete').hidden = !roster;
      countNames();
      renderNames();
    }

    /** A row for one student; after <paramref name="before"/> if given, otherwise at the end. Returns the row. */
    function addRow(v = {}, after = null) {
      const row = root.createElement('div');
      row.className = 'n-row';
      row.innerHTML = '<input class="n-nm" maxlength="60" placeholder="Name" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Name">'
        + '<input class="n-tm" maxlength="2" inputmode="numeric" placeholder="–" autocomplete="off" aria-label="Home team">'
        + '<input class="n-st" maxlength="1" inputmode="numeric" placeholder="–" autocomplete="off" aria-label="Seat">'
        + '<button type="button" class="n-del" aria-label="Remove this student" title="Remove this student">✕</button>';
      row.querySelector('.n-nm').value = v.name || '';
      row.querySelector('.n-tm').value = v.team || '';
      row.querySelector('.n-st').value = v.seat || '';
      if (after && after.parentNode) after.after(row); else $('#nRows').appendChild(row);
      return row;
    }
    const rows = () => [...$('#nRows').querySelectorAll('.n-row')];
    const rowValue = (r) => ({ name: r.querySelector('.n-nm').value.trim(), team: r.querySelector('.n-tm').value.trim(), seat: r.querySelector('.n-st').value.trim() });

    // Numbers only in the team and seat boxes.
    $('#nRows').addEventListener('input', (e) => {
      if (e.target.matches('.n-tm, .n-st')) e.target.value = e.target.value.replace(/\D/g, '');
      e.target.closest('.n-row')?.classList.remove('bad');
      countNames();
    });
    // ✕: a blank row goes at once; a student only after asking (an accidental tap shouldn't lose a name).
    $('#nRows').addEventListener('click', (e) => {
      const del = e.target.closest('.n-del');
      if (!del) return;
      const row = del.closest('.n-row'), v = rowValue(row);
      if (v.name && !confirm(`Remove ${v.name} from this class list?`)) return;
      row.remove();
      if (!rows().length) addRow();
      countNames();
    });
    // Enter: on to the next row's name (a new row at the end), so a list can be typed straight in.
    $('#nRows').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const row = e.target.closest('.n-row');
      const next = row.nextElementSibling || addRow({}, row);
      next.querySelector('.n-nm').focus();
      countNames();
    });
    // Pasting several lines (or spreadsheet columns) into a name box: one row each, from that row on.
    $('#nRows').addEventListener('paste', (e) => {
      if (!e.target.matches('.n-nm')) return;
      const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      if (!/[\r\n\t]/.test(text.trim())) return; // one name: an ordinary paste
      e.preventDefault();
      const list = parseList(text);
      if (!list.length) return;
      let row = e.target.closest('.n-row');
      list.forEach((v, i) => {
        if (i > 0) row = row.nextElementSibling && !rowValue(row.nextElementSibling).name ? row.nextElementSibling : addRow({}, row);
        row.querySelector('.n-nm').value = v.name;
        row.querySelector('.n-tm').value = v.team || '';
        row.querySelector('.n-st').value = v.seat || '';
      });
      countNames();
      notice(`Added ${list.length} name${list.length === 1 ? '' : 's'}.`, 2500);
    });
    $('#nAddRow').addEventListener('click', () => {
      const last = rows().at(-1);
      const row = last && !rowValue(last).name ? last : addRow();
      row.querySelector('.n-nm').focus();
      countNames();
    });

    /** Lines of a pasted list: "name", "name<tab>team<tab>seat" or "name, team, seat"; a header row is skipped. */
    const TEAM_SEAT = /^(.*?)\s*[\t,;]\s*(?:team\s*)?(\d{1,2})\s*(?:[\t,;]\s*(?:seat\s*)?(\d{1,2})\s*)?$/i;
    function parseList(text) {
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // One row of names across (tabs or semicolons, no numbers): a name each.
      if (lines.length === 1 && /[\t;]/.test(lines[0]) && !/\d/.test(lines[0])) return lines[0].split(/[\t;]/).map((s) => ({ name: s.trim() })).filter((v) => v.name);
      const out = [];
      for (const line of lines) {
        const m = line.match(TEAM_SEAT);
        const team = m && m[1].trim() ? Number(m[2]) : 0;
        if (/name/i.test(line) && /team|seat/i.test(line) && !team) continue; // a spreadsheet's header row
        if (team >= 1 && team <= 30) out.push({ name: m[1].trim().replace(/[,;]+$/, '').trim(), team, seat: Number(m[3]) >= 1 && Number(m[3]) <= 5 ? Number(m[3]) : '' });
        else out.push({ name: line.split('\t')[0].trim() });
      }
      return out.filter((v) => v.name);
    }

    /** The rows as the PC reads them, and what's wrong (shown, and Save waits until it's fixed). */
    function checkRows() {
      const list = [], problems = [], seen = new Map(), seats = new Map();
      for (const r of rows()) {
        r.classList.remove('bad');
        const v = rowValue(r);
        if (!v.name) { if (v.team || v.seat) { r.classList.add('bad'); problems.push('A row has a team or seat but no name.'); } continue; }
        const key = v.name.toLowerCase();
        if (seen.has(key)) { r.classList.add('bad'); seen.get(key).classList.add('bad'); problems.push(`Two students are called ${v.name}: add a last name or initial.`); continue; }
        seen.set(key, r);
        const team = v.team ? Number(v.team) : 0, seat = v.seat ? Number(v.seat) : 0;
        if (v.team && (team < 1 || team > 30)) { r.classList.add('bad'); problems.push(`${v.name}: the team is a number from 1 to 30.`); }
        if (v.seat && (seat < 1 || seat > 5)) { r.classList.add('bad'); problems.push(`${v.name}: the seat is a number from 1 to 4 (5 for a team of five).`); }
        if (seat && !team) { r.classList.add('bad'); problems.push(`${v.name} has a seat but no team.`); }
        if (team && seat) {
          const k = `${team}/${seat}`;
          if (seats.has(k)) problems.push(`Team ${team} has two students in seat ${seat} (${seats.get(k)} and ${v.name}).`);
          else seats.set(k, v.name);
        }
        list.push(team ? `${v.name}\t${team}${seat ? `\t${seat}` : ''}` : v.name);
      }
      return { list, problems: [...new Set(problems)], withTeam: list.filter((l) => l.includes('\t')).length };
    }
    function countNames() {
      const { list, problems, withTeam } = checkRows();
      const n = list.length;
      $('#nCount').textContent = problems.length ? problems[0]
        : n === 0 ? 'Type a name, or paste a list into the name box.'
        : `${n} student${n === 1 ? '' : 's'}` + (withTeam ? `, ${withTeam} with a home team` : '');
      $('#nCount').classList.toggle('bad', problems.length > 0);
    }
    $('#nAddFirst').addEventListener('click', () => openEditor(null));
    $('#nNew').addEventListener('click', () => openEditor(null));
    $('#nEdit').addEventListener('click', () => openEditor(currentRoster()));
    $('#nCancel').addEventListener('click', () => { editing = null; renderNames(); });
    $('#nEditor').addEventListener('submit', (e) => {
      e.preventDefault();
      const { list: students, problems } = checkRows();
      // Two students in one seat is only a warning; anything else waits until it's fixed.
      const blocking = problems.filter((p) => !p.includes('two students in seat'));
      if (blocking.length) { notice(blocking[0], 6000); countNames(); return; }
      if (students.length === 0) { notice('Add at least one name.'); return; }
      if (!connected()) { notice('Not connected to the PC: the list is saved there.'); return; }
      const msg = { t: 'rosterSave', name: $('#nName').value.trim() || 'My class', students };
      if (editing) msg.id = editing;
      send(msg);
      root.activeElement.blur();
    });
    $('#nDelete').addEventListener('click', () => {
      const r = rosters.rosters.find((x) => x.id === editing);
      if (!r || !confirm(`Delete “${r.name}” and its list of names?`)) return;
      send({ t: 'rosterDelete', id: r.id });
      editing = null;
    });

    // --- students (Student Mode on the Chromebooks) ---

    let gridUrl = '';
    if (!root.getElementById('padlinkStudentCss')) {
      const st = root.createElement('style');
      st.id = 'padlinkStudentCss';
      st.textContent = STUDENT_CSS;
      root.head.appendChild(st);
    }
    let students = { open: false };
    function onStudents(msg) {
      if (msg.grid) gridUrl = msg.grid;
      students = msg;
      $('#sClosed').hidden = !!msg.open;
      if (!msg.open) {
        const blank = !!msg.startBlankPref;
        for (const b of $$('#sStart button')) { const on = (b.dataset.blank === '1') === blank; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
        $('#sStartNote').textContent = blank
          ? 'Each student starts with an empty board, and nothing of yours is copied until you send it: Send my page (one page), or Send all my lesson pages.'
          : 'Each student gets a copy of your lesson pages (not the ones you hide with 👁 in Pages). You lead to start.';
      }
      $('#sOpen').hidden = !msg.open;
      $('#sCloseBtn').hidden = !msg.open;
      if (msg.open) {
        $('#sInfo').textContent = `${msg.name}: ${msg.inClass} in the class, ${msg.connected} connected` + (msg.waiting ? `, ${msg.waiting} waiting` : '');
        $('#sJoinBtn').textContent = msg.joinShown ? 'Hide join code' : 'Show join code';
        $('#sJoinBtn').classList.toggle('on', !!msg.joinShown);
        $('#sCornerRow').hidden = false;
        $('#sCorner').checked = msg.joinCorner !== false;
        // The address to post in Canvas, Clever or Hapara (students type the class's code each lesson)
        $('#sLinkBox').hidden = !msg.joinAddress;
        $('#sLinkText').textContent = msg.joinAddress || '';
        $('#sCopyLink').title = msg.joinAddress ? `Copy ${msg.joinAddress}` : '';
        $('#sLinkChanged').hidden = !msg.joinChangedFrom;
        if (msg.joinChangedFrom) $('#sLinkChanged').textContent = `This PC's student address changed (it was ${msg.joinChangedFrom}). If you posted the link in Canvas, Clever or Hapara, post the new one.`;
        // Who turns the pages: You lead (Let them draw on or off) or Their own pace
        const own = msg.pace === 'own';
        for (const b of $$('#sPace button')) { const on = (b.dataset.own === '1') === own; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
        $('#sDraw').hidden = own;
        $('#sCompareBox').hidden = !msg.comparing;
        if (msg.comparing) $('#sCompareText').textContent = `Comparing ${msg.comparing} boards on the whiteboard (students see Look at the board)`;
        // Eyes up: every screen says Eyes on the teacher (either pace)
        $('#sEyes').classList.toggle('on', !!msg.eyesUp);
        $('#sEyes').textContent = msg.eyesUp ? '👀 End Eyes up' : '👀 Eyes up';
        $('#sDraw').classList.toggle('on', !!msg.drawing);
        $('#sDraw').textContent = msg.drawing ? '✏️ Stop drawing' : '✏️ Let them draw';
        $('#sKeepRow').hidden = own || msg.startBlank;
        $('#sKeepDraw').checked = !!msg.keepDrawing;
        $('#sCheckRow').hidden = !own || msg.startBlank;
        $('#sSelfCheck').checked = msg.selfCheck !== false;
        $('#sSendBox').hidden = !msg.startBlank; // with your board, students already have every page
        $('#sPaceNote').textContent = msg.eyesUp ? 'Every student’s screen says Eyes on the teacher. Their work is kept; End Eyes up gives it back.' : own
          ? (msg.startBlank ? 'Students work on their own empty boards: your lesson pages aren’t copied to them. Send my page, or Send all my lesson pages below.' : 'Students move through the pages at their own pace and write on any of them. Hidden pages aren’t sent.')
          : !msg.drawing
            ? 'Everyone watches your whiteboard live, on the page you’re on. Tap Let them draw when they should start.'
            : msg.startBlank
              ? 'Students draw on their own boards and stay on the page they’re on.'
              : (msg.keepDrawing ? 'Everyone writes on their own copy of your page, and moves with you when you turn the page.' : 'Everyone writes on their own copy of your page. Turning the page switches drawing off, so you can teach first.');
        renderPeople(msg);
        renderHands(msg);
        renderTeams(msg);
        renderWall(msg);
      } else renderHands({ hands: [] });
      // The Students tab says how many hands are up.
      const handsUp = msg.open ? (msg.hands || []).length : 0;
      const tabBtn = opts.tabs.querySelector('[data-ctab="students"]');
      if (tabBtn) tabBtn.textContent = (handsUp ? `Students ✋${handsUp}` : 'Students') + (msg.open && msg.eyesUp ? ' 👀' : '');
      renderPoll(msg);
      renderBoardWalls(msg);
      $('#sHandPc').checked = msg.handPcChime !== false;
      const r = msg.handRules;
      if (r) {
        const mins = (n) => (n === 1 ? '1 minute' : `${n} minutes`);
        $('#sHandRules').textContent = 'Students tap ✋ on their Chromebook; the PC decides when to chime, so it can’t be used to make noise. ' +
          `One chime per student${r.quiet > 0 ? ` (raising again within ${mins(r.quiet)} of lowering is silent)` : ''}, ` +
          `at most one every ${r.gap} seconds, and a reminder for a hand up ${mins(r.reminder)}. Change these in the PC's ⚙ Settings (or the whiteboard's ⚙).`;
      }
      for (const box of $$('[data-stool]')) box.checked = msg.allow ? msg.allow[box.dataset.stool] !== false : true;
      // With Remote mode on (for the iPad): students can still join through the school network, if it reaches the PC.
      $('#sViaBox').hidden = !msg.remote;
      for (const b of $$('#sVia button')) { const on = (b.dataset.net === '1') === !!msg.viaNetwork; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
      $('#sViaNote').textContent = msg.viaNetwork
        ? 'Chromebooks connect to this PC directly, so their data doesn’t count toward Remote mode’s 5 GB. Your iPad still uses Remote mode. A student on another Wi-Fi (their own phone, say): Student on another Wi-Fi? on the join code.'
        : 'Chromebooks connect through Remote mode, like your iPad. If they can reach this PC on the school network, choose School network to save Remote mode data.';
      if (opts.onStudents) opts.onStudents(msg);
    }

    /** Who's waiting (let in, or not) and who's in (connected or not; take out of the class). */
    function renderPeople(msg) {
      const asking = msg.asking || [], people = msg.people || [];
      $('#sWaitBox').hidden = !asking.length;
      $('#sWaitTitle').textContent = asking.length === 1 ? '1 waiting to be let in' : `${asking.length} waiting to be let in`;
      $('#sLetIn').hidden = asking.length < 2;
      const wait = $('#sWaitList');
      wait.textContent = '';
      for (const p of asking) {
        const row = person(p.name);
        row.append(small('Let in', 'primary', () => send({ t: 'studentsApprove', key: p.key })));
        row.append(small('Not this one', '', () => send({ t: 'studentsRemove', key: p.key })));
        wait.appendChild(row);
      }
      $('#sInTitle').textContent = people.length ? `In the class (${people.length})` : 'In the class';
      const list = $('#sInList');
      list.textContent = '';
      if (!people.length) {
        const e = root.createElement('div');
        e.className = 's-empty';
        e.textContent = 'Nobody yet. Show the join code so students can scan it.';
        list.appendChild(e);
      }
      for (const p of people) {
        const row = person(p.name, p.connected);
        if (p.remote) { // joined from another Wi-Fi, through Remote mode (its data counts toward the monthly allowance)
          const tag = root.createElement('span');
          tag.className = 's-via';
          tag.textContent = 'Remote mode';
          tag.title = `${p.name} joined from another Wi-Fi, through Remote mode`;
          row.querySelector('.s-name').after(tag);
        }
        // Raise hand for this student: on or off (off lowers their hand and hides their button).
        const hb = root.createElement('button');
        hb.className = 's-hand-off' + (p.handOff ? ' off' : '');
        hb.textContent = '✋';
        hb.title = p.handOff ? `Raise hand is off for ${p.name}: tap to switch it on` : `Switch Raise hand off for ${p.name}`;
        hb.setAttribute('aria-label', hb.title);
        hb.addEventListener('click', () => send({ t: 'handAllow', key: p.key, on: !!p.handOff }));
        row.append(hb);
        row.append(small('Remove', 'danger', () => {
          if (confirm(`Take ${p.name} out of the class? Their board is deleted. They can ask to join again.`)) send({ t: 'studentsRemove', key: p.key });
        }));
        list.appendChild(row);
      }
    }
    function person(name, connected) {
      const row = root.createElement('div');
      row.className = 's-person';
      if (connected !== undefined) {
        const dot = root.createElement('span');
        dot.className = 's-dot' + (connected ? '' : ' away');
        dot.title = connected ? 'Connected' : 'Not connected right now';
        row.appendChild(dot);
      }
      const n = root.createElement('span');
      n.className = 's-name';
      n.textContent = name;
      row.appendChild(n);
      return row;
    }
    function small(text, kind, onClick) {
      const b = root.createElement('button');
      b.className = 's-small' + (kind ? ' ' + kind : '');
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    }

    /** Raised hands, in the order raised, with how long each has waited (ticking here) and the note, if any. */
    let handsAt = 0, handTick = 0;
    function renderHands(msg) {
      const hands = msg.hands || [];
      handsAt = performance.now();
      $('#sHandBox').hidden = !hands.length;
      $('#sHandTitle').textContent = hands.length === 1 ? '✋ 1 hand up' : `✋ ${hands.length} hands up`;
      $('#sLowerAll').hidden = hands.length < 2;
      // On the whiteboard (which the class can see) notes never show; say where they are.
      const notes = opts.self === 'board' && hands.length > 0;
      $('#sHandPcNote').hidden = !notes;
      $('#sHandPcNote').textContent = 'Notes students add show only on your iPad or iPhone.';
      const list = $('#sHandList');
      list.textContent = '';
      for (const h of hands) {
        const row = root.createElement('div');
        row.className = 's-hand';
        const who = root.createElement('div');
        who.className = 's-who';
        const n = root.createElement('span');
        n.className = 's-name';
        n.textContent = h.name;
        who.appendChild(n);
        if (h.note) {
          const note = root.createElement('span');
          note.className = 's-note';
          note.textContent = `“${h.note}”`;
          who.appendChild(note);
        }
        const meta = root.createElement('span');
        meta.className = 's-meta' + (h.raises >= 5 ? ' busy' : '');
        meta.dataset.waited = String(h.waited || 0);
        meta.dataset.raises = String(h.raises || 1);
        who.appendChild(meta);
        row.appendChild(who);
        row.append(small('Lower', '', () => send({ t: 'handLower', key: h.key })));
        list.appendChild(row);
      }
      tickHands();
      clearInterval(handTick);
      if (hands.length) handTick = setInterval(tickHands, 1000);
    }
    function tickHands() {
      const extra = Math.floor((performance.now() - handsAt) / 1000);
      for (const m of $$('#sHandList .s-meta')) {
        const secs = Number(m.dataset.waited) + extra, raises = Number(m.dataset.raises);
        const waited = secs < 60 ? 'just now' : `waiting ${Math.floor(secs / 60)} min`;
        m.textContent = raises > 1 ? `${waited} · raised ${raises} times` : waited;
      }
    }
    $('#sLowerAll').addEventListener('click', () => send({ t: 'handLower' }));
    $('#sHandPc').addEventListener('change', (e) => send({ t: 'handPcChime', on: e.target.checked }));
    if (opts.deviceSound) {
      $('#sHandPad').checked = prefs.handSound;
      $('#sHandPad').addEventListener('change', (e) => { prefs.handSound = e.target.checked; savePrefs(); if (e.target.checked) { unlockAudio(); handChime(); } });
    }

    // --- teams: made from home teams or on the fly; tap a name, then another (swap) or a team's ＋ (move) ---
    let teamHow = prefs.teamHow || 'home', picked = null, lastTeams = null;
    const HOW_NOTES = {
      home: 'Your home teams and seats, from the class list.',
      mixed: 'New teammates, same seats: one seat 1, 2, 3 and 4 on each team, from different home teams. As balanced as your home teams.',
      seat: 'All the seat 1s together, all the 2s, and so on (similar levels).',
      random: 'Shuffled across the room. Seats are given out fresh.',
    };
    function renderTeams(msg) {
      const teams = msg.teams && msg.teams.list;
      lastTeams = teams || null;
      teamHow = msg.homeTeams ? (prefs.teamHow || 'home') : 'random'; // no numbers in the list: Random only; once added, the teacher's usual choice
      for (const b of $$('#sHow button')) {
        const on = b.dataset.how === teamHow;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('unavail', b.dataset.how !== 'random' && !msg.homeTeams); // tapping says why
      }
      $('#sHowNote').textContent = msg.homeTeams ? HOW_NOTES[teamHow]
        : 'Only Random for now: this class list has no Team and Seat numbers. Add them in Names → Edit (and Save) for Home teams, Mixed and Same seats.';
      $('#sApartRow').hidden = teamHow !== 'random' || !msg.homeTeams;
      $('#sTeamMake').hidden = !!teams;
      $('#sTeamList').hidden = !teams;
      $('#sTeamHelp').hidden = !teams;
      $('#sTeamActs').hidden = !teams;
      $('#sTeamsClear').hidden = !teams;
      $('#sTeamBoards').hidden = !teams;
      $('#sTeamBoards').textContent = msg.teamBoards ? 'End team boards' : 'Start team boards';
      $('#sTeamBoards').classList.toggle('on', !!msg.teamBoards);
      $('#sTeamBoardsNote').hidden = !teams;
      $('#sTeamBoardsNote').textContent = msg.teamBoards
        ? 'Each team works on one shared board. Students change only their own marks. See their boards shows each team\'s board: look closer, write on it or show it to the class. End team boards: everyone back on their own board (the team boards stay until you close the class).'
        : 'One shared whiteboard per team, live on every teammate\'s Chromebook. Their own boards wait, unchanged.';
      $('#sTeamsShow').textContent = msg.teamsShown ? 'Hide teams' : 'Show teams';
      $('#sTeamsShow').classList.toggle('on', !!msg.teamsShown);
      $('#sSend').textContent = teams ? 'Send my page to everyone' : 'Send my page to everyone';
      if (!teams) { picked = null; return; }
      if (picked && !teams.some((t) => t.members.some((m) => m.name === picked))) picked = null;
      const list = $('#sTeamList');
      list.textContent = '';
      for (const t of teams) {
        const box = root.createElement('div');
        box.className = 's-team';
        const head = root.createElement('div');
        head.className = 's-team-head';
        const title = root.createElement('span');
        title.textContent = `Team ${t.no}`;
        head.appendChild(title);
        const btns = root.createElement('span');
        if (picked && !t.members.some((m) => m.name === picked)) {
          const here = root.createElement('button');
          here.className = 's-here';
          here.textContent = '＋';
          here.title = `Move ${picked} to team ${t.no}`;
          here.setAttribute('aria-label', here.title);
          here.addEventListener('click', () => { send({ t: 'teamsMove', name: picked, team: t.no }); picked = null; });
          btns.appendChild(here);
        } else {
          const page = root.createElement('button');
          page.textContent = 'Send page';
          page.title = students.teamBoards ? `Add the whiteboard page you're on to team ${t.no}'s board` : `Send the whiteboard page you're on to team ${t.no} only`;
          page.addEventListener('click', () => { send({ t: 'studentsSend', team: t.no }); notice(`Sending the page you’re on to team ${t.no}…`, 3000); });
          btns.appendChild(page);
        }
        head.appendChild(btns);
        box.appendChild(head);
        for (const m of t.members) {
          const b = root.createElement('button');
          b.className = 's-member' + (m.name === picked ? ' picked' : '') + (m.connected ? '' : ' away');
          b.innerHTML = '<span class="s-seat"></span><span class="s-nm"></span>';
          b.querySelector('.s-seat').textContent = m.seat;
          b.querySelector('.s-nm').textContent = m.name;
          b.title = m.connected ? `${m.name}, seat ${m.seat}` : `${m.name}, seat ${m.seat} (not connected right now)`;
          b.addEventListener('click', () => {
            if (picked === m.name) picked = null;
            else if (picked) { send({ t: 'teamsSwap', a: picked, b: m.name }); picked = null; }
            else picked = m.name;
            renderTeams(students);
          });
          box.appendChild(b);
        }
        list.appendChild(box);
      }
    }
    for (const b of $$('#sHow button')) b.addEventListener('click', () => {
      if (b.classList.contains('unavail')) {
        notice('This class list has no home teams yet. Names → Edit, fill in each student\'s Team and Seat, and Save: then Home teams, Mixed and Same seats work (the open class picks it up).', 8000);
        return;
      }
      teamHow = b.dataset.how; prefs.teamHow = teamHow; savePrefs(); renderTeams(students);
    });
    const makeTeams = () => {
      if (!connected()) { notice('Not connected to the PC.'); return; }
      send({ t: 'teamsMake', how: teamHow, apart: $('#sApart').checked });
    };
    $('#sMakeTeams').addEventListener('click', makeTeams);
    $('#sTeamsRemake').addEventListener('click', () => {
      if (confirm('Make the teams again? Everyone gets a new team and seat.')) { send({ t: 'teamsClear' }); makeTeams(); }
    });
    $('#sTeamsClear').addEventListener('click', () => { if (confirm('Clear the teams? Every Chromebook drops its team card.')) send({ t: 'teamsClear' }); });
    $('#sTeamsShow').addEventListener('click', () => send({ t: 'teamsShow', on: !students.teamsShown }));
    // ---------- the class wall (StudentClass.Wall.cs): a note each on the whiteboard page ----------
    function renderWall(msg) {
      const w = msg.wall;
      $('#sWallMakes').hidden = !!w;
      const lot = !!w && w.layout === 'lot';
      $('#sWallNote').textContent = !w
        ? 'Sticky notes on the whiteboard page you’re on, for an exit ticket, notice and wonder, or questions to come back to. Each student types or draws on their own notes only. The class sees the wall live, without names.'
        : !w.writing ? 'Writing is off: the notes stay as they are, on the whiteboard and the students’ screens.'
          : msg.drawing || msg.pace === 'own' ? 'Students write on the wall while they watch your whiteboard. Stop Let them draw (You lead) to open it again.'
            : lot ? 'Students tap ➕ New note for each idea (up to 5 each), and can change or delete their own. Drag the notes on the whiteboard to group them. Only they see their name on theirs' + (w.names ? '.' : ', and the class sees no names.')
              : (w.layout === 'nw' ? 'Each student has an I notice… and an I wonder… note, and taps one to type or draw on it.' : 'Each student taps their note to type or draw on it.')
                + ' Only they see their name on it' + (w.names ? '' : ', and the class sees no names') + '.';
      $('#sWallOn').hidden = !w;
      if (!w) return;
      $('#sWallWriting').checked = !!w.writing;
      $('#sWallNames').checked = !!w.names;
      const list = $('#sWallList');
      list.textContent = '';
      if (lot && !(w.notes || []).length) {
        const none = root.createElement('p');
        none.className = 'note';
        none.textContent = 'No notes yet.';
        list.append(none);
      }
      for (const n of w.notes || []) {
        const row = root.createElement('div');
        row.className = 's-person' + (n.hidden ? ' hid' : '');
        const words = root.createElement('div');
        words.className = 's-words';
        const who = root.createElement('b');
        who.textContent = (n.name || `Note ${n.no}`) + (n.kind === 'n' ? ' · notice' : n.kind === 'w' ? ' · wonder' : '');
        const said = root.createElement('span');
        said.textContent = n.hidden ? 'Hidden from the class' + (n.text ? ': ' + n.text.replace(/\n/g, ' ') : '')
          : (n.text ? n.text.replace(/\n/g, ' ') : n.ink ? '' : 'Nothing yet') + (n.ink ? (n.text ? ' ' : '') + '✏️ a drawing' : '');
        words.append(who, said);
        const hide = root.createElement('button');
        hide.className = 's-small';
        hide.textContent = n.hidden ? 'Show' : 'Hide';
        hide.title = n.hidden ? 'Show this note to the class again' : 'Hide this note from the class (it’s kept)';
        hide.addEventListener('click', () => send({ t: 'wall', cmd: 'hide', note: n.id, on: !n.hidden }));
        const clear = root.createElement('button');
        clear.className = 's-small danger';
        clear.textContent = 'Clear';
        clear.hidden = !n.text && !n.ink;
        clear.addEventListener('click', () => { if (confirm(`Clear ${n.name ? n.name + '’s' : 'this'} note? Its words and drawing go.`)) send({ t: 'wall', cmd: 'clear', note: n.id }); });
        row.append(words, hide, clear);
        list.append(row);
      }
    }
    // Every wall in the whiteboard's board: a PDF of one, or two side by side (works with the class closed too)
    const wallsTicked = [];
    function renderBoardWalls(msg) {
      const list = msg.boardWalls || [];
      $('#sWallsBox').hidden = !list.length;
      for (let i = wallsTicked.length - 1; i >= 0; i--) if (!list.some((w) => w.id === wallsTicked[i])) wallsTicked.splice(i, 1);
      const box = $('#sWallsList');
      box.textContent = '';
      for (const w of list) {
        const row = root.createElement('label');
        row.className = 's-person';
        const tick = root.createElement('input');
        tick.type = 'checkbox';
        tick.checked = wallsTicked.includes(w.id);
        tick.title = 'Tick two walls to compare them';
        tick.addEventListener('change', () => {
          const at = wallsTicked.indexOf(w.id);
          if (tick.checked && at < 0) { wallsTicked.push(w.id); if (wallsTicked.length > 2) wallsTicked.shift(); }
          if (!tick.checked && at >= 0) wallsTicked.splice(at, 1);
          renderBoardWalls(students || msg);
        });
        const words = root.createElement('div');
        words.className = 's-words';
        const what = root.createElement('b');
        const made = w.made ? new Date(w.made) : null;
        what.textContent = [w.cls, made ? made.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Class wall'].filter(Boolean).join(' · ') + ` · page ${w.page}` + (w.here ? ' (on the board now)' : '');
        const said = root.createElement('span');
        said.textContent = `${w.written} of ${w.notes} wrote or drew`;
        words.append(what, said);
        const pdf = root.createElement('button');
        pdf.className = 's-small';
        pdf.textContent = 'PDF';
        pdf.title = 'This wall as a PDF: a picture of it, and each student’s note';
        pdf.addEventListener('click', (e) => { e.preventDefault(); if (!connected()) { notice('Not connected to the PC.'); return; } send({ t: 'wallReport', ids: [w.id], names: $('#sWallsNames').checked }); });
        row.append(tick, words, pdf);
        box.append(row);
      }
      $('#sWallsCompare').disabled = wallsTicked.length !== 2;
      $('#sWallsCompare').textContent = wallsTicked.length === 2 ? 'Compare the two ticked (PDF)' : 'Tick two walls to compare them';
    }
    $('#sWallsCompare').addEventListener('click', () => {
      if (wallsTicked.length !== 2) return;
      if (!connected()) { notice('Not connected to the PC.'); return; }
      // Oldest first: the start of the unit, then later
      const list = (students && students.boardWalls) || [];
      const ids = [...wallsTicked].sort((a, b) => { const A = list.find((w) => w.id === a), B = list.find((w) => w.id === b); return String(A && A.made || '').localeCompare(String(B && B.made || '')) || (A ? A.page : 0) - (B ? B.page : 0); });
      send({ t: 'wallReport', ids, names: $('#sWallsNames').checked });
    });
    for (const b of $$('#sWallMakes [data-layout]')) b.addEventListener('click', () => send({ t: 'wall', cmd: 'make', layout: b.dataset.layout }));
    $('#sWallWriting').addEventListener('change', (e) => send({ t: 'wall', cmd: 'writing', on: e.target.checked }));
    $('#sWallNames').addEventListener('change', (e) => send({ t: 'wall', cmd: 'names', on: e.target.checked }));

    $('#sTeamBoards').addEventListener('click', () => {
      if (students.teamBoards && !confirm('End team boards? Every student goes back to their own board.')) return;
      send({ t: 'teamBoards', on: !students.teamBoards });
    });

    // --- poll: the teacher asks, every student answers with big buttons (A–B up to A–E, True/False, Yes/No), draws,
    // or types a number or a short answer ---
    let poll = null, pollAt = 0, pollTick = 0, typedHere = 0; // typedHere: a short-answer poll's answers opened on the whiteboard (its id)
    // Multiple choice: A–B up to A–H
    const MC_LETTERS = 'ABCDEFGH', MC_MAX = MC_LETTERS.length;
    const pollWhatOf = (q) => (q.kind === 'draw' ? '✏️ Draw' : q.kind === 'num' ? '🔢 Number' : q.kind === 'text' ? '✍️ Short answer' : q.kind === 'long' ? '📝 Long answer' : q.kind === 'tf' ? 'True / False' : q.kind === 'yn' ? 'Yes / No' : `A–${MC_LETTERS[Math.max(2, Math.min(MC_MAX, q.count || 4)) - 1]}`);
    const pollStartMsg = (q, extra) => ({ t: 'pollStart', pcSound: prefs.pcSound, kind: q.kind, count: q.count || 4, seconds: q.seconds || 0, question: q.question || '', answers: q.answers || [], correct: q.correct ?? -1, answer: q.answer || '', shuffle: !!q.shuffle, board: prefs.pollOnBoard !== false, background: q.kind === 'draw' && q.bg !== false, ...extra });
    // (A choice saved before Multiple choice, '2'…'5', is multiple choice with that many.)
    const pollKind = () => (!prefs.pollKind || /^\d$/.test(prefs.pollKind) ? 'mc' : prefs.pollKind);
    const pollCount = () => Math.max(2, Math.min(MC_MAX, prefs.pollCount || (/^\d$/.test(prefs.pollKind || '') ? Number(prefs.pollKind) : 4)));
    const pollSecs = () => (prefs.pollSecs === undefined ? 0 : prefs.pollSecs);
    function renderPollSetup() {
      for (const b of $$('#pKind button')) { const on = b.dataset.pkind === pollKind(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
      for (const b of $$('#pTime button')) { const on = Number(b.dataset.psecs) === pollSecs(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
      $('#pShuffleRow').hidden = pollKind() !== 'mc';
      $('#pCountRow').hidden = pollKind() !== 'mc';
      $('#pCountText').textContent = `A–${MC_LETTERS[pollCount() - 1]}`;
      $('#pFewer').disabled = pollCount() <= 2;
      $('#pMoreChoices').disabled = pollCount() >= MC_MAX;
      $('#pBgRow').hidden = pollKind() !== 'draw';
      $('#pBg').checked = prefs.pollBg !== false;
      renderSetupRight();
      $('#pShuffle').checked = !!prefs.pollShuffle;
      $('#pOnBoard').checked = prefs.pollOnBoard !== false;
    }
    // A poll on the fly: its correct answer, picked before Start (optional; students see it only once it's shown)
    let setupRight = -1;
    const setupChoices = () => { const k = pollKind(); return k === 'mc' ? [...MC_LETTERS.slice(0, pollCount())] : k === 'tf' ? ['True', 'False'] : k === 'yn' ? ['Yes', 'No'] : []; };
    function renderSetupRight() {
      const k = pollKind(), typed = k === 'num' || k === 'text' || k === 'long';
      const choices = setupChoices();
      if (setupRight >= choices.length) setupRight = -1;
      $('#pRightBox').hidden = k === 'draw';
      $('#pRight').hidden = typed;
      $('#pRightText').hidden = !typed;
      $('#pRightText').inputMode = k === 'num' ? 'decimal' : 'text';
      $('#pRightText').placeholder = k === 'num' ? 'The number, or leave it empty' : 'The answer, or leave it empty';
      const box = $('#pRight');
      box.textContent = '';
      choices.forEach((label, i) => {
        const b = root.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.classList.toggle('on', i === setupRight);
        b.setAttribute('aria-checked', String(i === setupRight));
        if (label.length > 1) b.style.gridColumn = 'span 2';
        b.addEventListener('click', () => { setupRight = i === setupRight ? -1 : i; renderSetupRight(); });
        box.appendChild(b);
      });
    }
    let pagePoll = null;
    function renderPagePoll(msg) {
      pagePoll = msg.open && msg.pagePoll ? msg.pagePoll : null;
      $('#pPageBox').hidden = !pagePoll;
      if (!pagePoll) return;
      const q = pagePoll;
      const what = pollWhatOf(q);
      $('#pPageStart').textContent = q.of > 1 ? `Start question ${(q.pageQ || 0) + 1} of ${q.of}` : 'Start this page’s poll';
      $('#pPageQ').textContent = (q.of > 1 ? `Question ${(q.pageQ || 0) + 1} of ${q.of} · ` : '') + (q.question ? `“${q.question}” · ` : '') + what + (q.seconds ? ` · ${fmtTime(q.seconds * 1000)}` : '') + (q.shuffle ? ' · shuffled' : '');
    }
    function pollLeft() { return poll && poll.leftMs != null ? Math.max(0, poll.leftMs - (performance.now() - pollAt)) : null; }
    function tickPoll() {
      const left = pollLeft();
      const clock = $('#pClock');
      clock.textContent = poll && poll.open && left != null ? fmtTime(left) : '';
      clock.classList.toggle('soon', left != null && left <= 10000);
    }
    // Lesson so far: every closed poll summed up, live (formative assessment without exporting). Names only in Each
    // student, which on the whiteboard (the class can see it) stays folded until opened.
    let lesson = null;
    function renderPollHistory(msg) {
      lesson = msg.open ? msg.lesson || null : null;
      $('#pHistBox').hidden = !lesson;
      if (!lesson) return;
      const n = lesson.polls.length;
      $('#pHistTitle').textContent = `Lesson so far: ${n} poll${n === 1 ? '' : 's'}`;
      const cards = $('#pLessonCards');
      cards.innerHTML = '<div class="p-card"><b></b>polls</div><div class="p-card"><b></b>answered</div><div class="p-card"><b></b>correct</div>';
      cards.children[0].firstChild.textContent = n;
      cards.children[1].firstChild.textContent = `${lesson.answeredAvg}%`;
      cards.children[2].firstChild.textContent = lesson.correctAvg != null ? `${lesson.correctAvg}%` : '–';
      cards.children[2].classList.toggle('ok', lesson.correctAvg != null);
      const list = $('#pHist');
      list.textContent = '';
      for (const p of lesson.polls) {
        const row = root.createElement('div');
        row.className = 'p-hrow';
        row.innerHTML = '<span></span><span class="p-flag"></span>';
        row.firstChild.textContent = `${p.no} · ${p.question || p.what}`;
        const flag = row.lastChild;
        if (p.percent == null) flag.textContent = `${p.answered} answered`;
        else {
          flag.textContent = `${p.percent}%` + (p.flag === 'reteach' ? ` · Reteach?${p.wrong ? ` (most chose ${p.wrong})` : ''}` : p.flag === 'gotit' ? ' · Got it' : '');
          if (p.flag) flag.classList.add(p.flag);
        }
        list.appendChild(row);
      }
      const again = lesson.again || [];
      $('#pAgain').hidden = !again.length;
      $('#pAgain').textContent = `Might need another look: ${again.join(', ')}`;
      // On the whiteboard the names in Might need another look stay folded too.
      if (opts.self === 'board') $('#pAgain').hidden = true;
      $('#pEachSum').textContent = opts.self === 'board' ? 'Each student (the class can see this screen)' : 'Each student';
      const each = $('#pEach');
      each.textContent = '';
      if (opts.self === 'board' && again.length) {
        const a = root.createElement('p');
        a.className = 'p-again';
        a.textContent = `Might need another look: ${again.join(', ')}`;
        each.appendChild(a);
      }
      for (const s of lesson.students || []) {
        const row = root.createElement('div');
        row.className = 'p-each' + (lesson.marked && s.right * 2 < lesson.marked ? ' low' : '');
        row.innerHTML = '<span></span><span></span>';
        row.firstChild.textContent = s.name;
        row.lastChild.textContent = lesson.marked ? `${s.right} / ${lesson.marked} right` : `${s.answered} answered`;
        each.appendChild(row);
      }
      $('#pLessonShow').textContent = lesson.shown ? 'Hide from the class' : 'Show the class';
      $('#pLessonShow').classList.toggle('on', !!lesson.shown);
      $('#pAnswersRow').hidden = !lesson.marked;
      $('#pLessonAnswers').checked = !!lesson.answers;
    }
    $('#pLessonShow').addEventListener('click', () => send({ t: 'lessonShow', on: !(lesson && lesson.shown), answers: !!(lesson && lesson.shown && lesson.answers) }));
    $('#pLessonAnswers').addEventListener('change', (e) => send({ t: 'lessonShow', on: true, answers: e.target.checked }));

    // Polls in this board: every page's poll on the whiteboard (go to its page; during class, start it).
    function renderBoardPolls(msg) {
      const list = msg.boardPolls || [];
      $('#pBoardBox').hidden = !list.length;
      if (!list.length) return;
      $('#pBoardTitle').textContent = `Polls in this board (${list.length})`;
      const box = $('#pBoardList');
      box.textContent = '';
      const done = new Map();
      for (const p of (msg.open && msg.lesson && msg.lesson.polls) || []) if (p.page >= 0 && !p.self) done.set(`${p.page}:${p.pageQ || 0}`, p);
      const running = !!(msg.open && msg.poll && msg.poll.open);
      for (const q of list) {
        const row = root.createElement('div');
        row.className = 'p-brow';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.innerHTML = '<span class="p-pg"></span><span class="p-bq"><span></span><small></small></span>';
        row.querySelector('.p-pg').textContent = `Page ${q.page + 1}` + (q.of > 1 ? ` · Q${(q.pageQ || 0) + 1}` : '');
        row.querySelector('.p-bq span').textContent = q.question || '(question on the page)';
        const what = pollWhatOf(q);
        const right = (q.kind === 'num' || q.kind === 'text' || q.kind === 'long') ? (q.answer ? `${q.answer} correct` : '') : q.correct >= 0 ? `${q.kind === 'tf' ? ['True', 'False'][q.correct] : q.kind === 'yn' ? ['Yes', 'No'][q.correct] : MC_LETTERS[q.correct]} correct` : '';
        const small = row.querySelector('small');
        small.textContent = [what, right || 'no correct answer set', q.seconds ? fmtTime(q.seconds * 1000) : '', q.shuffle ? 'shuffled' : ''].filter(Boolean).join(' · ');
        small.classList.toggle('warn', !right && q.kind === 'letters');
        const result = done.get(`${q.page}:${q.pageQ || 0}`);
        if (result) {
          const r = root.createElement('span');
          r.className = 'p-res' + (result.percent != null && result.percent >= 50 ? ' ok' : '');
          r.textContent = result.percent != null ? `${result.percent}%` : 'Done';
          row.appendChild(r);
        } else if (msg.open && !running) {
          const b = root.createElement('button');
          b.className = 'p-start';
          b.textContent = 'Start';
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            send({ t: 'boardPollGo', page: q.page });
            send(pollStartMsg(q, { page: q.page, pageQ: q.pageQ || 0 }));
          });
          row.appendChild(b);
        }
        const go = () => send({ t: 'boardPollGo', page: q.page });
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        box.appendChild(row);
      }
    }
    function renderSelfPaced(msg, on) {
      const sp = on ? msg.selfPaced : null;
      $('#pSelfBox').hidden = !on;
      if (!on) return;
      if (!sp) {
        $('#pSelfTitle').textContent = 'Their own pace';
        $('#pSelfNote').textContent = 'Students are working through the pages. A page with a poll (📊 Poll for this page) is answered when they get to it. Switch to You lead to run a poll live.';
        $('#pSelfWho').hidden = true;
        return;
      }
      const done = sp.people.filter((p) => p.answered >= sp.polls).length;
      const stuck = sp.people.filter((p) => p.stuck != null).length;
      $('#pSelfTitle').textContent = `Their own pace: ${sp.polls} page poll${sp.polls === 1 ? '' : 's'}`;
      $('#pSelfNote').textContent = `${done} of ${sp.people.length} finished` + (stuck ? ` · ${stuck} on one page 5+ minutes` : '') + '. '
        + (sp.selfCheck ? 'Students see ✓ or the right answer as they lock in.' : 'Students can change answers until you switch back to You lead.')
        + ' Back to You lead ends these polls; their results join Lesson so far.';
      $('#pSelfWho').hidden = false;
      const board = opts.self === 'board';
      $('#pSelfSum').textContent = board ? 'Each student (the class can see this screen)' : 'Each student';
      if (!board && !$('#pSelfWho').dataset.touched) $('#pSelfWho').open = true;
      const grid = $('#pSelfGrid');
      grid.innerHTML = '<div class="p-self-row head"><span>Student</span><span>Page</span><span>Answered</span><span>Right</span></div>';
      for (const p of sp.people) {
        const row = root.createElement('div');
        row.className = 'p-self-row' + (p.connected ? '' : ' away');
        row.innerHTML = '<span class="p-self-name"></span><span></span><span class="p-self-bar"><i></i><small></small></span><span></span>';
        row.children[0].textContent = p.name;
        if (p.stuck != null) row.children[0].append(Object.assign(root.createElement('em'), { className: 'p-self-flag', textContent: `⏱ ${p.stuck} min`, title: `${p.stuck} minutes on this page without answering its poll` }));
        row.children[1].textContent = p.page ?? '–';
        row.querySelector('.p-self-bar i').style.setProperty('--w', `${sp.polls ? (p.answered / sp.polls) * 100 : 0}%`);
        row.querySelector('.p-self-bar small').textContent = `${p.answered}/${sp.polls}`;
        row.children[3].textContent = sp.marked ? String(p.right) : '–';
        grid.appendChild(row);
      }
    }
    let lastPollMsg = null;
    function renderPoll(msg) {
      lastPollMsg = msg;
      renderPollHistory(msg);
      renderBoardPolls(msg);
      renderPagePoll(msg);
      poll = msg.open ? msg.poll || null : null;
      pollAt = performance.now();
      $('#pNoClass').hidden = !!msg.open;
      // Their own pace: each page's poll is answered as students get to it (no live poll meanwhile)
      const selfPace = !!msg.open && msg.pace === 'own' && !msg.startBlank;
      renderSelfPaced(msg, selfPace);
      $('#pSetup').hidden = !msg.open || !!poll || selfPace;
      $('#pLive').hidden = !poll;
      const tabBtn = opts.tabs.querySelector('[data-ctab="poll"]');
      if (tabBtn) tabBtn.textContent = poll && poll.open ? `Poll ${poll.answered}/${poll.total}` : 'Poll';
      clearInterval(pollTick);
      renderPollSetup();
      if (!poll) return;
      const draw = poll.kind === 'draw';
      const typed = poll.kind === 'num' || poll.kind === 'text' || poll.kind === 'long';
      const what = draw || typed ? pollWhatOf(poll) : poll.kind === 'tf' ? 'True / False' : poll.kind === 'yn' ? 'Yes / No' : `${poll.choices[0]}–${poll.choices[poll.choices.length - 1]}`;
      // Typed answers: shown in the PC's order (numbers smallest first, words most given first), only those given
      const shownIds = typed && poll.order ? poll.order : poll.choices.map((_, i) => i);
      const hidden = new Set(poll.hidden || []);
      // A short-answer poll's words on the whiteboard (the class can see it): folded until the teacher opens them
      const folded = typed && (poll.kind === 'text' || poll.kind === 'long') && opts.self === 'board' && typedHere !== poll.id;
      $('#pState').textContent = `Poll ${poll.no || ''} ${poll.open ? 'open' : 'closed'} · ${what}`.replace('  ', ' ');
      $('#pState').classList.toggle('open', !!poll.open);
      $('#pCount').textContent = `${poll.answered} of ${poll.total} answered`;
      $('#pState').title = poll.question || '';
      $('#pCount').dataset.q = poll.question || '';
      const notLocked = poll.answered - poll.locked;
      $('#pSub').textContent = draw ? (poll.open ? `${poll.locked} locked in` : (poll.total - poll.locked ? `${poll.total - poll.locked} didn’t answer` : 'Everyone answered')) : poll.open
        ? `${poll.locked} locked in` + (notLocked ? ` · ${notLocked} picked, not locked in yet (it still counts)` : '')
        : (poll.total - poll.answered ? `${poll.total - poll.answered} didn’t answer` : 'Everyone answered');
      // The bars: on the teacher's own iPad or iPhone as answers come in; on the whiteboard only once it's closed.
      const bars = $('#pBars');
      bars.textContent = '';
      bars.classList.toggle('typed', typed);
      bars.classList.toggle('long', poll.kind === 'long'); // each answer in full, not bars
      if (poll.counts && folded && shownIds.length) {
        const b = root.createElement('button');
        b.className = 'p-reveal';
        b.textContent = `Show the ${shownIds.length} answer${shownIds.length === 1 ? '' : 's'} here (the class can see this screen)`;
        b.addEventListener('click', () => { typedHere = poll.id; renderPoll(lastPollMsg); });
        bars.appendChild(b);
      } else if (poll.counts) {
        const most = Math.max(1, poll.answered);
        for (const i of shownIds) {
          const label = poll.choices[i];
          const n = poll.counts[i] || 0;
          const row = root.createElement('div');
          // ✓ on the whiteboard (the class can see it) only once it's shown; the teacher's own screen always has it
          const tick = i === poll.correct && (opts.self !== 'board' || poll.correctShown);
          row.className = 'p-bar' + (tick ? ' right' : '') + (hidden.has(i) ? ' hid' : '');
          row.innerHTML = '<b></b><div class="p-track"><div class="p-fill"></div></div><span class="p-num"></span>';
          row.querySelector('b').textContent = tick ? `${label} ✓` : label;
          row.querySelector('.p-fill').style.width = `${(n / most) * 100}%`;
          row.querySelector('.p-num').innerHTML = `${n} <small>${poll.answered ? Math.round((n / poll.answered) * 100) : 0}%</small>`;
          if (typed && !poll.open) {
            // Hide an answer from the class (the results on the whiteboard and Chromebooks); tap again to show it
            const h = root.createElement('button');
            h.className = 'p-hide' + (hidden.has(i) ? ' on' : '');
            h.textContent = hidden.has(i) ? 'Hidden' : 'Hide';
            h.title = hidden.has(i) ? 'Hidden from the class: tap to show it with the results' : 'Hide this answer from the class when you show the results';
            h.addEventListener('click', () => send({ t: 'pollHide', choice: i, on: !hidden.has(i) }));
            row.appendChild(h);
          }
          bars.appendChild(row);
        }
      }
      $('#pNote').textContent = poll.open
        ? (opts.self === 'board'
          ? 'The answers stay hidden on this screen, which the class can see, until you close the poll. Your iPad or iPhone shows them as they come in.'
          : 'Only you see these bars. Students see the results when you close the poll and tap Show results.')
        : (poll.shown ? 'The results are on the whiteboard and every Chromebook (no names).' + (typed ? ' Hide takes an answer off them.' : '') + (poll.correct >= 0 && !poll.correctShown ? ' The correct answer stays hidden until you tap Show the correct answer.' : '')
          : 'Show results puts these bars on the whiteboard and every Chromebook, without names.' + (typed ? ' Hide any answer you don’t want shown first.' : ''))
          + ' Finish the poll takes it off the whiteboard and students’ screens.';
      $('#pOpenActs').hidden = !poll.open;
      $('#pDoneActs').hidden = !!poll.open;
      // The question on the whiteboard (the class sees it there): hide or show it while the poll is open
      const hasWords = !!poll.question || (Array.isArray(poll.texts) && poll.texts.some((t) => t));
      $('#pOnBoardLive').hidden = !poll.open || !hasWords;
      $('#pOnBoardLive').textContent = poll.onBoard !== false ? 'Hide the question on the whiteboard' : 'Show the question on the whiteboard';
      $('#pOnBoardLive').classList.toggle('on', poll.onBoard === false);
      renderDrawings(); // a draw poll: the gallery instead of bars, correct answers and results
      if (draw) { $('#pNote').textContent = ''; $('#pShow').hidden = true; $('#pReveal').hidden = true; $('#pWhoBox').hidden = true; $('#pCorrectBox').hidden = true; tickPoll(); if (poll.open && poll.leftMs != null) pollTick = setInterval(tickPoll, 250); return; }
      $('#pShow').hidden = false;
      // The correct answer: once it's closed (tap it again for none). Shown in green with the results.
      $('#pCorrectBox').hidden = !!poll.open;
      const correct = $('#pCorrect');
      correct.className = 'p-kinds p-correct';
      correct.textContent = '';
      if (folded) $('#pCorrectBox').hidden = true;
      for (const i of shownIds) {
        const label = poll.choices[i];
        const b = root.createElement('button');
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.classList.toggle('on', i === poll.correct);
        b.setAttribute('aria-checked', String(i === poll.correct));
        if (label.length > 1) b.style.gridColumn = 'span 2';
        b.addEventListener('click', () => send({ t: 'pollCorrect', choice: i === poll.correct ? -1 : i }));
        correct.appendChild(b);
      }
      $('#pShow').textContent = poll.shown ? 'Hide results' : 'Show results';
      // The correct answer waits for its own tap, after the results (even a prepared one): talk about the results first.
      $('#pReveal').hidden = !(poll.shown && poll.correct >= 0);
      $('#pReveal').textContent = poll.correctShown ? 'Hide the correct answer' : 'Show the correct answer';
      $('#pReveal').classList.toggle('on', !!poll.correctShown);
      $('#pShow').classList.toggle('on', !!poll.shown);
      // Who chose what: the teacher's own (on the whiteboard, folded away until opened, since the class can see it).
      $('#pWhoBox').hidden = !poll.who;
      if (poll.who) {
        $('#pWhoSum').textContent = opts.self === 'board' ? 'Who chose what (the class can see this screen)' : 'Who chose what';
        const who = $('#pWho');
        who.textContent = '';
        const groups = [...shownIds.map((i) => [folded ? `Answer ${shownIds.indexOf(i) + 1}` : poll.choices[i], poll.who.filter((w) => w.choice === i)]), ['No answer', poll.who.filter((w) => w.choice < 0)]];
        for (const [label, people] of groups) {
          if (!people.length) continue;
          const g = root.createElement('div');
          g.className = 'p-group';
          g.innerHTML = '<b></b><span></span>';
          g.querySelector('b').textContent = `${label} (${people.length})`;
          g.querySelector('span').textContent = people.map((w) => w.name + (w.choice >= 0 && !w.locked ? ' (not locked in)' : '')).join(', ');
          who.appendChild(g);
        }
      }
      tickPoll();
      if (poll.open && poll.leftMs != null) pollTick = setInterval(tickPoll, 250);
    }
    for (const b of $$('#pKind button')) b.addEventListener('click', () => { if (b.dataset.pkind === 'mc') prefs.pollCount = pollCount(); if (b.dataset.pkind !== pollKind()) { setupRight = -1; $('#pRightText').value = ''; } prefs.pollKind = b.dataset.pkind; savePrefs(); renderPollSetup(); });
    for (const id of ['#pQuestion', '#pRightText']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('#pFewer').addEventListener('click', () => { prefs.pollCount = Math.max(2, pollCount() - 1); savePrefs(); renderPollSetup(); });
    $('#pMoreChoices').addEventListener('click', () => { prefs.pollCount = Math.min(MC_MAX, pollCount() + 1); savePrefs(); renderPollSetup(); });
    for (const b of $$('#pTime button')) b.addEventListener('click', () => { prefs.pollSecs = Number(b.dataset.psecs); savePrefs(); renderPollSetup(); });
    $('#pToStudents').addEventListener('click', () => showTab('students'));
    $('#pStart').addEventListener('click', () => {
      if (!connected()) { notice('Not connected to the PC.'); return; }
      unlockAudio(); const k = pollKind(), typed = k === 'num' || k === 'text' || k === 'long';
      send({ t: 'pollStart', pcSound: prefs.pcSound, kind: k === 'mc' ? 'letters' : k, count: k === 'mc' ? pollCount() : 0, seconds: pollSecs(), question: $('#pQuestion').value.trim(),
        correct: k === 'draw' || typed ? -1 : setupRight, answer: typed ? $('#pRightText').value.trim() : '',
        shuffle: !!prefs.pollShuffle && k === 'mc', board: prefs.pollOnBoard !== false, background: k === 'draw' && prefs.pollBg !== false });
      // ready for the next one
      $('#pQuestion').value = ''; $('#pRightText').value = ''; setupRight = -1; renderSetupRight();
    });
    $('#pBg').addEventListener('change', (e) => { prefs.pollBg = e.target.checked; savePrefs(); });

    // ---------- a draw poll: everyone's drawing, as a gallery (each on the poll's page, or white) ----------
    // Tap 2 to 4 to show them side by side on the whiteboard, or Show all. On the whiteboard (the class can see it) the
    // drawings appear only once the poll is closed; names only on the teacher's own iPad or iPhone.
    const drawBg = new Map(); // poll id -> { page, images: Map(id -> Image) } (asked of the PC once)
    let drawPick = [];
    function drawBgOf(id) {
      if (!drawBg.has(id)) { drawBg.set(id, null); send({ t: 'pollBg', id }); }
      return drawBg.get(id);
    }
    function onPollBg(m) {
      const images = new Map();
      for (const [id, url] of Object.entries(m.images || {})) { const img = root.createElement('img'); img.onload = () => renderDrawings(); img.src = url; images.set(Number(id), img); }
      drawBg.set(m.id, { page: m.page, images });
      renderDrawings();
    }
    function renderDrawings() {
      const p = poll;
      const box = $('#pDrawBox');
      const on = !!p && p.kind === 'draw';
      box.hidden = !on;
      if (!on) { drawPick = []; return; }
      const list = p.drawings || [];
      const keys = new Set(list.map((d) => d.key));
      drawPick = drawPick.filter((k) => keys.has(k));
      $('#pDrawNote').textContent = !p.drawings
        ? 'The drawings show here once you close the poll (the class can see this screen). Your iPad or iPhone shows them as they come in.'
        : !list.length ? 'No drawings locked in yet.'
        : p.answersShown ? `${p.answersShown === 1 ? 'A drawing is' : `${p.answersShown} drawings are`} on the whiteboard (no names unless ticked). Students see Look at the board.`
        : 'Tap 2 to 4 drawings to show side by side on the whiteboard, or Show all. No names unless you tick Show names.';
      const grid = $('#pDrawGrid');
      grid.textContent = '';
      const bg = p.bgId ? drawBgOf(p.bgId) : null;
      const E = window.PadEngine;
      list.forEach((d, i) => {
        const tile = root.createElement('button');
        tile.className = 'p-draw' + (drawPick.includes(d.key) ? ' on' : '');
        const at = drawPick.indexOf(d.key);
        tile.dataset.letter = at >= 0 ? 'ABCD'[at] : '';
        const c = root.createElement('canvas');
        c.width = 320; c.height = 180;
        tile.appendChild(c);
        const cap = root.createElement('span');
        cap.textContent = d.name || `#${i + 1}`;
        tile.appendChild(cap);
        if (E) {
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, 320, 180);
          g.setTransform(320 / 1920, 0, 0, 320 / 1920, 0, 0);
          const own = E.configure({}).image;
          E.configure({ image: (id) => (bg && bg.images.get(id)) || null });
          try {
            if (bg) E.renderPage(g, { bg: bg.page.bg || 'white', h: bg.page.h || 1080, doc: bg.page.doc, items: bg.page.items || [] });
            for (const s of d.drawing || []) E.drawItem(g, s, false);
          } catch { /* a drawing that can't be drawn */ } finally { E.configure({ image: own }); }
        }
        tile.addEventListener('click', () => {
          const k = drawPick.indexOf(d.key);
          if (k >= 0) drawPick.splice(k, 1); else if (drawPick.length < 4) drawPick.push(d.key);
          renderDrawings();
        });
        grid.appendChild(tile);
      });
      $('#pDrawSide').disabled = drawPick.length < 2;
      $('#pDrawSide').textContent = drawPick.length >= 2 ? `Show these ${drawPick.length} side by side` : 'Show side by side';
      $('#pDrawAll').hidden = !list.length;
      $('#pDrawStop').hidden = !p.answersShown;
      $('#pDrawNameRow').hidden = !list.length;
    }
    $('#pDrawSide').addEventListener('click', () => { if (poll && drawPick.length >= 2) send({ t: 'pollShowAnswers', id: poll.id, keys: drawPick, named: $('#pDrawNames').checked }); });
    $('#pDrawAll').addEventListener('click', () => { if (poll) send({ t: 'pollShowAnswers', id: poll.id, all: true, named: $('#pDrawNames').checked }); });
    $('#pDrawStop').addEventListener('click', () => { if (poll) send({ t: 'pollShowAnswers', id: poll.id, keys: [] }); });
    $('#pShuffle').addEventListener('change', (e) => { prefs.pollShuffle = e.target.checked; savePrefs(); });
    $('#pPageStart').addEventListener('click', () => {
      if (!connected()) { notice('Not connected to the PC.'); return; }
      if (!pagePoll) return;
      const q = pagePoll;
      send(pollStartMsg(q, { page: q.page ?? -1, pageQ: q.pageQ || 0 }));
    });
    $('#pOnBoard').addEventListener('change', (e) => { prefs.pollOnBoard = e.target.checked; savePrefs(); });
    $('#pOnBoardLive').addEventListener('click', () => send({ t: 'pollOnBoard', on: !!(poll && poll.onBoard === false) }));
    // Preparing polls (where there's a whiteboard to put them on: the PC's, and PadLink Go's).
    $('#pPrep').hidden = !opts.openPollEditor;
    $('#pPrepNote').hidden = !!opts.openPollEditor;
    $('#pPrepPage').addEventListener('click', () => opts.openPollEditor && opts.openPollEditor());
    $('#pPrepPaste').addEventListener('click', () => opts.openPasteQuestions && opts.openPasteQuestions());
    $('#pMore').addEventListener('click', () => { unlockAudio(); send({ t: 'pollTime', seconds: 30, pcSound: prefs.pcSound }); });
    $('#pReopen').addEventListener('click', () => { unlockAudio(); send({ t: 'pollTime', seconds: 60, pcSound: prefs.pcSound }); }); // closed (time ran out): open again for a minute
    $('#pClose').addEventListener('click', () => send({ t: 'pollClose' }));
    $('#pShow').addEventListener('click', () => send({ t: 'pollShow', on: !(poll && poll.shown) }));
    $('#pReveal').addEventListener('click', () => send({ t: 'pollReveal', on: !(poll && poll.correctShown) }));
    $('#pNew').addEventListener('click', () => send({ t: 'pollEnd' }));
    $('#pExport').addEventListener('click', () => {
      if (!connected()) { notice('Not connected to the PC.'); return; }
      send({ t: 'pollExport', names: $('#pNames').checked });
    });
    $('#pReport').addEventListener('click', () => {
      if (!connected()) { notice('Not connected to the PC.'); return; }
      send({ t: 'pollReport', names: $('#pNames').checked });
    });

    /** The class lists to open the class with (the name picker's lists). */
    function renderStudentLists() {
      const lists = rosters.rosters || [];
      $('#sNoLists').hidden = lists.length > 0;
      $('#sPick').hidden = !lists.length;
      const sel = $('#sRoster');
      const keep = sel.value || rosters.active;
      sel.textContent = '';
      for (const r of lists) {
        const o = root.createElement('option');
        o.value = r.id;
        o.textContent = `${r.name} (${r.students.length} names)`;
        sel.appendChild(o);
      }
      if (lists.some((r) => r.id === keep)) sel.value = keep;
    }
    $('#sOpenBtn').addEventListener('click', () => {
      if (!connected()) { notice('Not connected to the PC.'); return; }
      send({ t: 'studentsOpen', id: $('#sRoster').value, blank: !!students.startBlankPref });
    });
    $('#sCloseBtn').addEventListener('click', () => {
      const polls = (students.polls || []).length;
      const also = polls ? ` The results of ${polls === 1 ? 'this lesson’s poll' : `this lesson’s ${polls} polls`} are deleted too (Poll → Export as CSV keeps them).` : '';
      if (confirm('Close the class? Every student is disconnected and their boards are deleted.' + also)) send({ t: 'studentsClose' });
    });
    $('#sJoinBtn').addEventListener('click', () => send({ t: 'studentsJoin', on: !students.joinShown }));
    $('#sCorner').addEventListener('change', (e) => send({ t: 'pcSet', key: 'joinCorner', value: e.target.checked }));
    // Copy student link: navigator.clipboard where the page is secure (the PC), a hidden text box elsewhere (the iPad over the
    // school network)
    $('#sCopyLink').addEventListener('click', async () => {
      const link = students && students.joinAddress;
      if (!link) return;
      let ok = false;
      try { await navigator.clipboard.writeText(link); ok = true; } catch { /* not allowed here: the fallback below */ }
      if (!ok) {
        const t = root.createElement('textarea');
        t.value = link; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
        (root.body || document.body).appendChild(t); t.select();
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        t.remove();
      }
      notice(ok ? `Copied ${link}. Paste it in Canvas, Clever or Hapara: students type the class's code each lesson.` : `Couldn't copy here. The link is ${link}`, 6000);
    });
    for (const b of $$('#sStart button')) b.addEventListener('click', () => {
      students.startBlankPref = b.dataset.blank === '1';
      onStudents(students); // shown at once; saved when the class opens
    });
    for (const b of $$('#sPace button')) b.addEventListener('click', () => send({ t: 'studentsPace', own: b.dataset.own === '1' }));
    $('#sDraw').addEventListener('click', () => send({ t: 'studentsDraw', on: !students.drawing }));
    $('#sEyes').addEventListener('click', () => send({ t: 'studentsEyes', on: !students.eyesUp }));
    $('#sCompareStop').addEventListener('click', () => send({ t: 'studentsCompareStop' }));
    $('#sKeepDraw').addEventListener('change', () => send({ t: 'studentsKeepDraw', on: $('#sKeepDraw').checked }));
    $('#pSelfSum').addEventListener('click', () => { $('#pSelfWho').dataset.touched = '1'; }); // the teacher folded or opened it: leave it so
    $('#sSelfCheck').addEventListener('change', () => send({ t: 'studentsSelfCheck', on: $('#sSelfCheck').checked }));
    $('#sLessonAll').addEventListener('click', () => send({ t: 'studentsLessonAll' }));
    $('#sSend').addEventListener('click', () => {
      send({ t: 'studentsSend' });
      notice('Sending the page you’re on to every student…', 3000);
    });
    $('#sLetIn').addEventListener('click', () => send({ t: 'studentsLetIn' }));
    for (const b of $$('#sVia button')) b.addEventListener('click', () => send({ t: 'studentsVia', network: b.dataset.net === '1' }));
    $('#sBoards').addEventListener('click', () => { if (gridUrl && opts.openGrid) opts.openGrid(gridUrl); });
    for (const box of $$('[data-stool]')) box.addEventListener('change', () => send({ t: 'studentsAllow', key: box.dataset.stool, on: box.checked }));

    renderTimer();
    showTab(prefs.tab);

    return {
      /** The panel was opened: switch the sound on (a tap opened it) and get the class lists. */
      opened() {
        unlockAudio();
        showTab(prefs.tab);
        send({ t: 'rosters' });
        if (prefs.tab === 'students' || prefs.tab === 'poll') send({ t: 'students' });
      },
      /** Start the whiteboard page's poll (the control screen's Start tag): as Class tools → Poll does. */
      startPagePoll() { $('#pPageStart').click(); },
      /** A message from the PC; true if it was for the class tools. */
      onMessage(msg) {
        if (msg.t === 'timer') onTimer(msg);
        else if (msg.t === 'rosters') onRosters(msg);
        else if (msg.t === 'picked') onPicked(msg);
        else if (msg.t === 'students') onStudents(msg);
        else if (msg.t === 'pollBg') onPollBg(msg); // a draw poll's page, for the gallery
        else if (msg.t === 'pollChime') { if (opts.deviceSound && prefs.padSound) chime(true); }
        else if (msg.t === 'handChime') { if (opts.deviceSound && prefs.handSound) handChime(); if (opts.onHandChime) opts.onHandChime(msg); }
        else return false;
        return true;
      },
      get prefs() { return prefs; },
      /** Show one of the tabs ('timer', 'names', 'students', 'poll'). */
      showTab(tab) { showTab(tab); send({ t: 'rosters' }); },
    };
  }

  window.PadClass = { Panel, fmtTime };
})();
