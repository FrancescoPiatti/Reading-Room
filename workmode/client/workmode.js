/* ===========================================================================
   workmode.js — the local "work mode" client. Injected ONLY by the local server
   (never present in the static docs/ on GitHub Pages).

   Adds, on every page:
     • an IDE-style bottom terminal drawer (xterm.js) bridged to the server's
       node-pty shell over a WebSocket, with resize handling;
     • a floating launcher of split buttons (a main action + a ▾ menu): a command
       picker that pre-types /explain-paper · /compare · /learn (the ▾ switches
       which, remembered across reloads), and a Terminal button (main = toggle the
       drawer) whose ▾ launches an AI — claude · codex · gemini — in the shell;
     • a live-refresh toast when the server rebuilds docs/ (digest watcher);
     • the work-mode hooks the Phase 2 graph add-on calls when present:
         window.RR_runInTerminal(cmd)  — focus the terminal and pre-type cmd
         window.RR_dismissGhost(d)     — POST /api/dismiss (persisted + rebuilt)

   It pre-types commands but never presses Enter and never spawns the AI
   itself, so the AI's own permission prompts are always preserved.
   =========================================================================== */
(function () {
  'use strict';
  var WM = window.RR_WORKMODE;
  if (!WM) return;                              // not in work mode — do nothing

  var WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + (WM.ws || '/__workmode/ws');

  // A chromeless app window (chrome --app / standalone) has no address bar, so we
  // keep external links (e.g. arXiv) from stranding it with no way back.
  var CHROMELESS = (window.locationbar && window.locationbar.visible === false) ||
    (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: minimal-ui)').matches));
  // arXiv id of the report being viewed (papers/<id>/index.html), for "View PDF"
  var REPORT_ID = (location.pathname.match(/\/papers\/([^/]+)\//) || [])[1];
  // slug of the discussion being viewed (chat/<slug>/index.html), for "Remove discussion"
  var CHAT_ID = (location.pathname.match(/\/chat\/([^/]+)\//) || [])[1];
  if (REPORT_ID) { try { REPORT_ID = decodeURIComponent(REPORT_ID); } catch (e) {} }
  var LS_OPEN = 'rr-wm-open';                   // drawer open/closed persists across reloads
  var LS_H = 'rr-wm-h';                         // drawer height persists

  function lsGet(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------------------------------------------------------- icons */
  function svg(p){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; }
  var ICO_TERM = svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>');
  var ICO_DOC  = svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
  var ICO_X    = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
  var ICO_CLR  = svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>');
  var ICO_BACK = svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>');
  var ICO_EXT  = svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>');
  var ICO_PDF  = svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>');
  var ICO_CARET= svg('<polyline points="6 9 12 15 18 9"/>');
  var ICO_CMP  = svg('<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>');
  var ICO_LEARN= svg('<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5"/>');
  var ICO_BOT  = svg('<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>');
  var ICO_PEN  = svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>');

  /* --------------------------------------------------------------- helpers */
  function el(tag, cls, html){ var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  // open a url in the system browser via the server (falls back to a new tab)
  function openExternal(url){
    fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) })
      .catch(function (){ window.open(url, '_blank', 'noopener'); });
  }

  /* ------------------------------------------------------- toast (fallback) */
  // Reuse the graph add-on's toast if present; otherwise build our own.
  var toast = window.RR_toast || (function () {
    var t = el('div', 'rr-wm-toast');
    var msg = el('span', 'rr-wm-toast-msg');
    var act = el('button', 'rr-wm-toast-act'); act.type = 'button'; act.hidden = true;
    t.appendChild(msg); t.appendChild(act);
    document.body.appendChild(t);
    var timer = null;
    function hide(){ t.classList.remove('rr-show'); }
    return function (message, label, onAction){
      msg.textContent = message;
      if (label && onAction){ act.textContent = label; act.hidden = false; act.onclick = function (){ hide(); onAction(); }; }
      else { act.hidden = true; act.onclick = null; }
      t.classList.add('rr-show');
      if (timer) clearTimeout(timer);
      if (!(label && onAction)) timer = setTimeout(hide, 3000);
    };
  })();

  /* ---- split button: a main action + a ▾ caret that switches which command it
     runs (remembered across reloads). One compact control, several related
     commands — "otherwise it stays the same". The menu floats above the launcher. */
  var rrSplitMenus = [];                          // every split menu's hide() — only one open at a time
  function splitButton(cfg){
    var hasMain = !!cfg.main;                     // a fixed primary action (Terminal); items live only in the ▾ menu
    var cur = hasMain ? null : lsGet(cfg.store, cfg.def);
    if (!hasMain && !cfg.items.some(function (it){ return it.key === cur; })) cur = cfg.def;
    function itemFor(k){ for (var i = 0; i < cfg.items.length; i++) if (cfg.items[i].key === k) return cfg.items[i]; return cfg.items[0]; }

    var wrap  = el('div', 'rr-wm-split');
    var main  = el('button', 'rr-wm-btn rr-wm-split-main'); main.type = 'button';
    var caret = el('button', 'rr-wm-btn rr-wm-split-caret', ICO_CARET); caret.type = 'button';
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-label', cfg.switchLabel || 'Switch action');
    var menu  = el('div', 'rr-wm-menu'); menu.setAttribute('role', 'menu');

    function render(){ var m = hasMain ? cfg.main : itemFor(cur); main.innerHTML = m.icon + '<span>' + m.label + '</span>'; main.setAttribute('aria-label', m.label); }
    function isOpenMenu(){ return menu.classList.contains('rr-show'); }
    function hide(){ menu.classList.remove('rr-show'); }    // close without moving focus
    function closeMenu(){ var was = isOpenMenu(); hide(); if (was) caret.focus(); } // explicit close -> focus the caret
    rrSplitMenus.push(hide);                                // opening any split menu closes the others
    function openMenu(){
      rrSplitMenus.forEach(function (h){ h(); });          // enforce one-open-at-a-time (caret stopPropagation otherwise leaves the other open)
      var r = wrap.getBoundingClientRect();                 // anchor it above the control
      menu.classList.add('rr-show');                        // show first so offsetWidth is measurable
      var mw = menu.offsetWidth || 184;
      menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - mw - 10))) + 'px';
      menu.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px';
      var f = menu.querySelector('.rr-wm-menu-item'); if (f) f.focus();
    }
    cfg.items.forEach(function (it){
      var b = el('button', 'rr-wm-menu-item', it.icon + '<span>' + it.label + '</span>');
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function (e){ e.stopPropagation(); if (!hasMain){ cur = it.key; lsSet(cfg.store, cur); render(); } hide(); it.run(); });
      menu.appendChild(b);
    });
    main.addEventListener('click', function (){ (hasMain ? cfg.main : itemFor(cur)).run(); });
    caret.addEventListener('click', function (e){ e.stopPropagation(); isOpenMenu() ? closeMenu() : openMenu(); });
    document.addEventListener('click', function (e){ if (isOpenMenu() && !menu.contains(e.target) && !wrap.contains(e.target)) hide(); });
    document.addEventListener('keydown', function (e){ if (e.key === 'Escape' && isOpenMenu()) closeMenu(); });
    menu.addEventListener('keydown', function (e){    // arrow-key roving (role=menu contract)
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      var items = Array.prototype.slice.call(menu.querySelectorAll('.rr-wm-menu-item'));
      if (!items.length) return;
      var i = items.indexOf(document.activeElement);
      items[((e.key === 'ArrowDown' ? i + 1 : i - 1) + items.length) % items.length].focus();
    });

    wrap.appendChild(main); wrap.appendChild(caret);
    document.body.appendChild(menu);
    render();
    return wrap;
  }

  /* ----------------------------------------------------------- build the UI */
  var launch = el('div', 'rr-wm-launch');
  if (REPORT_ID) {                                 // reading a report -> offer its PDF + notes in-app
    var pdfBtn = el('button', 'rr-wm-btn', ICO_PDF + '<span>View PDF</span>'); pdfBtn.type = 'button';
    pdfBtn.addEventListener('click', function (){ viewPdf(REPORT_ID); });
    launch.appendChild(pdfBtn);
    var notesBtn = el('button', 'rr-wm-btn', ICO_PEN + '<span>Edit notes</span>'); notesBtn.type = 'button';
    notesBtn.title = 'Your own notes for this paper (reports/<id>/notes.md) — rendered under "My notes"';
    notesBtn.addEventListener('click', function (){ editNotes(REPORT_ID); });
    launch.appendChild(notesBtn);
  }
  if (CHAT_ID) {                                   // reading a discussion -> offer to remove it (no terminal needed)
    var rmBtn = el('button', 'rr-wm-btn', ICO_CLR + '<span>Remove discussion</span>'); rmBtn.type = 'button';
    rmBtn.addEventListener('click', function (){ removeChat(CHAT_ID); });
    launch.appendChild(rmBtn);
  }
  // command picker — /explain-paper · /compare · /learn · /deep-dive (pre-typed, never auto-run).
  // On a report page the current paper's id is pre-filled for the commands that act on an
  // existing paper (/learn, /deep-dive, /compare) so you don't retype it; /explain-paper stays
  // bare because it adds a NEW paper, not the one you're already reading.
  function withId(cmd){ return REPORT_ID ? cmd + REPORT_ID + ' ' : cmd; }
  var cmdSplit = splitButton({
    store: 'rr-wm-cmd', def: 'explain', switchLabel: 'Switch command',
    items: [
      { key: 'explain',  label: 'Explain a paper', icon: ICO_DOC,   run: function (){ preType('/explain-paper '); } },
      { key: 'compare',  label: 'Compare papers',  icon: ICO_CMP,   run: function (){ preType(withId('/compare ')); } },
      { key: 'learn',    label: 'Discuss a paper',  icon: ICO_LEARN, run: function (){ preType(withId('/learn ')); } },
      { key: 'deepdive', label: 'Deep dive',        icon: ICO_LEARN, run: function (){ preType(withId('/deep-dive ')); } },
    ],
  });
  // terminal — the main button toggles the drawer; the ▾ launches an AI (Claude/Codex/Gemini) in it
  var termSplit = splitButton({
    main: { label: 'Terminal', icon: ICO_TERM, run: function (){ toggleDrawer(); } },
    switchLabel: 'Launch an AI',
    items: [
      { key: 'claude', label: 'Launch claude', icon: ICO_BOT, run: function (){ launchAgent('claude'); } },
      { key: 'codex',  label: 'Launch codex',  icon: ICO_BOT, run: function (){ launchAgent('codex'); } },
      { key: 'gemini', label: 'Launch gemini', icon: ICO_BOT, run: function (){ launchAgent('gemini'); } },
    ],
  });
  launch.appendChild(cmdSplit); launch.appendChild(termSplit);

  var drawer = el('div', 'rr-wm-drawer');
  var grip = el('div', 'rr-wm-grip'); grip.title = 'Drag to resize';
  var bar = el('div', 'rr-wm-bar');
  var title = el('span', 'rr-wm-title', ICO_TERM + '<span>Terminal</span>');
  var dot = el('span', 'rr-wm-dot'); dot.title = 'shell connection';
  var hint = el('span', 'rr-wm-hint', '');
  var spacer = el('span', 'rr-wm-spacer');
  var endChatBtn = el('button', 'rr-wm-endchat', 'End chat'); endChatBtn.type = 'button';
  endChatBtn.title = 'Finish a /learn discussion — compact it and append it below the reading list';
  endChatBtn.hidden = true;                        // only shown while a /learn discussion is running
  var clearBtn = el('button', 'rr-wm-iconbtn', ICO_CLR); clearBtn.type = 'button'; clearBtn.title = 'Clear';
  var closeBtn = el('button', 'rr-wm-iconbtn', ICO_X); closeBtn.type = 'button'; closeBtn.title = 'Hide (Esc)';
  bar.appendChild(title); bar.appendChild(dot); bar.appendChild(hint); bar.appendChild(spacer);
  bar.appendChild(endChatBtn); bar.appendChild(clearBtn); bar.appendChild(closeBtn);
  var termWrap = el('div', 'rr-wm-term');
  drawer.appendChild(grip); drawer.appendChild(bar); drawer.appendChild(termWrap);

  document.body.appendChild(launch);
  document.body.appendChild(drawer);

  // restore persisted height
  var savedH = parseInt(lsGet(LS_H, ''), 10);
  if (savedH > 80) document.documentElement.style.setProperty('--rr-wm-h', savedH + 'px');

  function setHint(t){ hint.textContent = t || ''; }

  /* --------------------------------------------------------- xterm + socket */
  var term = null, fit = null, ws = null, spawned = false, wantSpawn = false;
  var awaitingReady = false, everSpawned = false, reattached = false;
  var wantRespawn = false;                       // a launch needs a FRESH shell (see launchAgent)
  var pending = [];                              // input queued before the shell is ready (latest request wins)
  var CLR = '\x15';                              // Ctrl+U: clear the input line before (re)typing, so an
                                                 // un-run pre-typed command never accumulates with the next
  var reconnectTimer = null, reconnectDelay = 1500;

  function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function xtermTheme(){
    return {
      background: cssVar('--bg-raised') || '#ffffff',
      foreground: cssVar('--ink-soft') || '#222222',
      cursor: cssVar('--accent') || '#2a52d6',
      cursorAccent: cssVar('--bg-raised') || '#ffffff',
      selectionBackground: cssVar('--accent-dim') || 'rgba(42,82,214,0.18)',
    };
  }

  function ensureTerm(){
    if (term || !window.Terminal) return;
    term = new window.Terminal({
      fontFamily: cssVar('--mono') || 'JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: 13, cursorBlink: true, scrollback: 5000, theme: xtermTheme(),
    });
    var FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    if (FitCtor) { fit = new FitCtor(); term.loadAddon(fit); }
    term.open(termWrap);
    term.onData(function (d){ send({ type: 'data', data: d }); });
    // keep the xterm palette in sync with the page's light/dark toggle (only once a
    // terminal actually exists — pages that never open the drawer add no observer)
    new MutationObserver(function (){ if (term) term.options.theme = xtermTheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    fitSoon();
  }

  function connect(){
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = function (){
      dot.classList.add('rr-live'); reconnectDelay = 1500;   // reset backoff on a good connect
      if (wantSpawn) spawn();                    // (re)attach the shell if the drawer is open
    };
    ws.onmessage = function (ev){
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'data') { if (term) term.write(m.data); }
      else if (m.type === 'replay') {            // reattaching to a still-running shell (e.g. after navigating)
        if (term) { term.reset(); term.write(m.data); }  // reset first so a same-page reconnect doesn't double up
        reattached = true;
      }
      else if (m.type === 'ready') {             // server (re)attached the pty — now safe to flush input
        spawned = true; awaitingReady = false;
        if (wantRespawn) {
          // this 'ready' may be a REATTACH to a shell with an agent mid-session —
          // a queued launch must only flush into a shell created after the respawn
          wantRespawn = false; spawned = false; awaitingReady = true; reattached = false;
          send({ type: 'respawn', cols: term ? term.cols : 80, rows: term ? term.rows : 24 });
          return;
        }
        if (everSpawned && !reattached && term) term.write('\r\n\x1b[2m— new shell —\x1b[0m\r\n');
        everSpawned = true; reattached = false;
        while (pending.length) send({ type: 'data', data: pending.shift() });
      }
      else if (m.type === 'changed') onRebuilt();
      else if (m.type === 'building') setHint('rebuilding…');
      else if (m.type === 'build-error') {
        setHint('build error');
        // last non-empty line of build.py's stderr is the most useful one-liner
        var bline = String(m.error || '').split('\n').map(function(s){ return s.trim(); }).filter(Boolean).pop() || '';
        toast('Build failed' + (bline ? ': ' + bline.slice(0, 160) : ' — see workmode.log'));
      }
      else if (m.type === 'exit') { setHint('shell exited — reopen to start a new one'); spawned = false; awaitingReady = false; wantSpawn = false; pending = []; endChatBtn.hidden = true; }
      else if (m.type === 'fatal') { if (term) term.write('\r\n\x1b[31m' + m.msg + '\x1b[0m\r\n'); }
    };
    ws.onclose = function (){
      dot.classList.remove('rr-live'); spawned = false; awaitingReady = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);   // recover the reload channel
      reconnectDelay = Math.min(30000, reconnectDelay * 2);    // exponential backoff, capped at 30s
    };
    ws.onerror = function (){ try { ws.close(); } catch (e) {} };
  }

  function send(obj){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function spawn(){
    ensureTerm();
    if (spawned || awaitingReady || !term || !ws || ws.readyState !== 1) return;
    var dims = (fit && fit.proposeDimensions && fit.proposeDimensions()) || { cols: 80, rows: 24 };
    awaitingReady = true;                         // 'spawned' flips only on the server 'ready' ack
    send({ type: 'spawn', cols: dims.cols || 80, rows: dims.rows || 24 });
    // pre-typed input is flushed when 'ready' arrives — no timer guesswork, no loss/dupe
  }

  function fitSoon(){ setTimeout(function (){
    if (!fit || !term) return;
    try { fit.fit(); } catch (e) {}
    if (spawned) send({ type: 'resize', cols: term.cols, rows: term.rows });
  }, 30); }

  /* --------------------------------------------------------- drawer open/close */
  function isOpen(){ return drawer.classList.contains('rr-open'); }
  function openDrawer(){
    if (isOpen()) return;
    drawer.classList.add('rr-open');
    document.body.classList.add('rr-wm-bodyopen');
    launch.classList.add('rr-hidden');
    lsSet(LS_OPEN, '1');
    wantSpawn = true;
    if (!ws || ws.readyState > 1) connect();
    if (ws && ws.readyState === 1) spawn();
    fitSoon();
    if (term) term.focus();
  }
  function closeDrawer(){
    drawer.classList.remove('rr-open');
    document.body.classList.remove('rr-wm-bodyopen');
    launch.classList.remove('rr-hidden');
    lsSet(LS_OPEN, '0');
    wantSpawn = false;            // don't re-spawn a hidden shell on reconnect while closed
  }
  function toggleDrawer(){ isOpen() ? closeDrawer() : openDrawer(); }

  closeBtn.addEventListener('click', closeDrawer);
  clearBtn.addEventListener('click', function (){ if (term) term.clear(); if (term) term.focus(); });
  // End chat: tell a running /learn discussion to wrap up — it compacts the conversation
  // and appends it below the reading list (never a new paper/digest). Sends the "done" signal.
  endChatBtn.addEventListener('click', function (){
    openDrawer();
    if (spawned && ws && ws.readyState === 1) send({ type: 'data', data: CLR + 'done\r' });
    else pending = ['done\r'];
    endChatBtn.hidden = true;                          // the chat is wrapping up
    setHint('ending chat — the agent will compact it');
    if (term) term.focus();
  });
  document.addEventListener('keydown', function (e){ if (e.key === 'Escape' && isOpen() && document.activeElement !== term && !(pdfOv && pdfOv.classList.contains('rr-show')) && !(notesOv && notesOv.classList.contains('rr-show'))) closeDrawer(); });

  // pre-type a command (no Enter): user reviews + runs it, prompts preserved.
  // Clears the line first so switching commands (or to a launch) never accumulates
  // text the user would have to delete by hand; before the shell is ready the LATEST
  // request replaces any earlier queued one.
  function preType(cmd){
    openDrawer();
    endChatBtn.hidden = cmd.indexOf('/learn') !== 0;   // End chat only while a /learn discussion is running
    setHint('press Enter to run · start your AI (claude / codex / gemini) first if it isn’t running');
    if (spawned && ws && ws.readyState === 1) { send({ type: 'data', data: CLR + cmd }); }
    else { pending = [cmd]; }
    if (term) term.focus();
  }
  // launch an agent REPL in the shell. Unlike preType, this DOES press Enter —
  // starting `claude`/`codex` is what "launch" means. It ALWAYS starts from a fresh
  // shell: the pty is shared and persists across pages, so another agent may be
  // mid-session inside it — typing `codex` then would go INTO claude's prompt
  // instead of the shell. The server kills the old pty and spawns a new one; the
  // launch command flushes only when the fresh shell's 'ready' arrives.
  function launchAgent(name){
    openDrawer();
    endChatBtn.hidden = true;                          // a freshly launched agent has no /learn chat yet
    setHint('launching ' + name + ' …');
    pending = [name + '\r'];            // latest action wins; no leftover pre-typed command
    if (ws && ws.readyState === 1 && !awaitingReady) {
      spawned = false; awaitingReady = true;
      send({ type: 'respawn', cols: term ? term.cols : 80, rows: term ? term.rows : 24 });
    } else {
      wantRespawn = true;               // converts the in-flight/upcoming spawn into a respawn
    }
    if (term) term.focus();
  }

  /* ---------------------------------------------------------- resize handle */
  (function () {
    var dragging = false, startY = 0, startH = 0;
    grip.addEventListener('pointerdown', function (e){
      dragging = true; startY = e.clientY;
      startH = drawer.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', function (e){
      if (!dragging) return;
      var h = Math.max(120, Math.min(window.innerHeight * 0.85, startH + (startY - e.clientY)));
      document.documentElement.style.setProperty('--rr-wm-h', h + 'px');
    });
    grip.addEventListener('pointerup', function (e){
      if (!dragging) return; dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
      var h = drawer.getBoundingClientRect().height;
      lsSet(LS_H, Math.round(h)); fitSoon();
    });
  })();

  window.addEventListener('resize', function (){ if (isOpen()) fitSoon(); });
  // re-fit once the open animation settles, so cols/rows match the final height
  drawer.addEventListener('transitionend', function (e){ if (e.propertyName === 'transform' && isOpen()) fitSoon(); });

  /* ----------------------------------------------------- rebuild → refresh */
  // A digest landed and the server rebuilt docs/. Offer a refresh; do NOT
  // auto-reload (that would drop a terminal session mid-command).
  function onRebuilt(){
    setHint('');
    toast('Library updated — refresh to see it', 'Refresh', function (){ location.reload(); });
  }

  /* ------------------------------------------- hooks the graph add-on calls */
  window.RR_runInTerminal = function (cmd){ preType(cmd); };
  window.RR_launchAgent = function (name){ launchAgent(name); };   // Setup's "Launch claude/codex/gemini"
  // Setup's Finish: auto-run cmd in the EXISTING shell, WITHOUT opening/raising the
  // drawer. Returns true if it reached a live shell, false if none is running yet.
  window.RR_submitCommand = function (cmd){
    if (spawned && ws && ws.readyState === 1) { send({ type: 'data', data: cmd + '\r' }); return true; }
    return false;
  };

  window.RR_dismissGhost = function (d){
    return fetch('/api/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: d.id, title: d.label || '' }),
    }).then(function (r){ if (!r.ok) throw new Error('dismiss failed'); return r.json(); });
  };

  // remove the discussion being viewed: deletes chats/<id>/ + its page, rebuilds, returns home
  function removeChat(id){
    if (!window.confirm('Remove this discussion from the library? This deletes it and rebuilds the site.')) return;
    setHint('removing discussion…');
    fetch('/api/remove-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
    }).then(function (r){ if (!r.ok) throw new Error('remove failed'); return r.json(); })
      .then(function (){ location.href = '../../index.html'; })
      .catch(function (){ toast('Could not remove the discussion'); });
  }

  /* ------------------------------------------- in-app PDF viewer overlay */
  // Shows an arXiv PDF INSIDE the app (proxied same-origin via /pdf), with a
  // Back button — so you can read it here and return without leaving the app.
  var pdfOv = null;
  function buildPdfOverlay(){
    if (pdfOv) return pdfOv;
    pdfOv = el('div', 'rr-pdf-overlay');
    var bar = el('div', 'rr-pdf-bar');
    var back = el('button', 'rr-wm-btn', ICO_BACK + '<span>Back</span>'); back.type = 'button';
    var title = el('span', 'rr-pdf-title', '');
    var spacer = el('span', 'rr-wm-spacer');
    var ext = el('button', 'rr-wm-iconbtn', ICO_EXT); ext.type = 'button'; ext.title = 'Open in browser';
    var frame = el('iframe', 'rr-pdf-frame'); frame.setAttribute('title', 'PDF viewer');
    bar.appendChild(back); bar.appendChild(title); bar.appendChild(spacer); bar.appendChild(ext);
    pdfOv.appendChild(bar); pdfOv.appendChild(frame);
    document.body.appendChild(pdfOv);
    back.addEventListener('click', closePdf);
    ext.addEventListener('click', function (){ if (pdfOv._id) openExternal('https://arxiv.org/abs/' + pdfOv._id); });
    pdfOv._title = title; pdfOv._frame = frame;
    return pdfOv;
  }
  function viewPdf(id){
    if (!id) return;
    var ov = buildPdfOverlay();
    ov._id = id;
    ov._title.textContent = 'arXiv:' + id;
    ov._frame.src = '/pdf?id=' + encodeURIComponent(id);
    ov.classList.add('rr-show');
    document.body.classList.add('rr-pdf-open');
  }
  function closePdf(){
    if (!pdfOv) return;
    pdfOv.classList.remove('rr-show');
    pdfOv._frame.src = 'about:blank';            // stop loading / free the viewer
    document.body.classList.remove('rr-pdf-open');
  }
  window.RR_viewPdf = viewPdf;
  document.addEventListener('keydown', function (e){
    if (e.key === 'Escape' && pdfOv && pdfOv.classList.contains('rr-show')) closePdf();
  });

  /* ---------------------------------------------- in-app notes editor overlay */
  // Edit reports/<id>/notes.md right here: plain text + light Markdown, rendered
  // into the report's "My notes" block by the build. Saving writes the file via
  // the loopback API, rebuilds, and reloads this page to show the result.
  var notesOv = null;
  function buildNotesOverlay(){
    if (notesOv) return notesOv;
    notesOv = el('div', 'rr-notes-overlay');
    var bar = el('div', 'rr-pdf-bar');
    var back = el('button', 'rr-wm-btn', ICO_BACK + '<span>Back</span>'); back.type = 'button';
    var title = el('span', 'rr-pdf-title', '');
    var hint = el('span', 'rr-notes-hint', 'plain text + light Markdown: paragraphs, - bullets, **bold**, `code`');
    var spacer = el('span', 'rr-wm-spacer');
    var save = el('button', 'rr-wm-btn rr-notes-save', ICO_PEN + '<span>Save</span>'); save.type = 'button';
    var ta = el('textarea', 'rr-notes-ta'); ta.setAttribute('aria-label', 'Notes for this paper'); ta.spellcheck = false;
    bar.appendChild(back); bar.appendChild(title); bar.appendChild(hint); bar.appendChild(spacer); bar.appendChild(save);
    notesOv.appendChild(bar); notesOv.appendChild(ta);
    document.body.appendChild(notesOv);
    back.addEventListener('click', closeNotes);
    save.addEventListener('click', function (){
      save.disabled = true;
      fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: notesOv._id, text: ta.value }),
      }).then(function (r){ return r.json(); })
        .then(function (j){
          if (!j.ok) throw new Error(j.error || 'save failed');
          location.reload();                       // show the rendered notes (the shell reattaches)
        })
        .catch(function (e){ save.disabled = false; toast('Could not save notes' + (e.message ? ': ' + e.message : '')); });
    });
    notesOv._title = title; notesOv._ta = ta; notesOv._save = save;
    return notesOv;
  }
  function editNotes(id){
    if (!id) return;
    var ov = buildNotesOverlay();
    ov._id = id;
    ov._title.textContent = 'My notes — ' + id;
    ov._ta.value = ''; ov._save.disabled = true;
    fetch('/api/notes?id=' + encodeURIComponent(id))
      .then(function (r){ return r.json(); })
      .then(function (j){ ov._ta.value = (j && j.text) || ''; ov._save.disabled = false; ov._ta.focus(); })
      .catch(function (){ ov._save.disabled = false; ov._ta.focus(); });
    ov.classList.add('rr-show');
    document.body.classList.add('rr-pdf-open');    // same scroll lock as the PDF overlay
  }
  function closeNotes(){
    if (!notesOv) return;
    notesOv.classList.remove('rr-show');
    document.body.classList.remove('rr-pdf-open');
  }
  document.addEventListener('keydown', function (e){
    if (e.key === 'Escape' && notesOv && notesOv.classList.contains('rr-show')) closeNotes();
  });

  /* -------- keep external links out of the chromeless app window -------- */
  if (CHROMELESS) {
    document.addEventListener('click', function (e){
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href[0] === '#') return;
      var u; try { u = new URL(a.href, location.href); } catch (err) { return; }
      if (u.origin === location.origin) return;                 // internal nav stays in-window
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      e.preventDefault();                                        // open externally, don't strand us
      openExternal(u.href);
    }, true);
  }

  /* ------------------------------------------------------------- kick off */
  connect();                                     // always connect for the reload channel
  // restore drawer state; on a paper report open the terminal by default so it's ready to
  // discuss / deep-dive the paper — unless the reader explicitly closed it before.
  var openState = lsGet(LS_OPEN, '');
  if (REPORT_ID ? openState !== '0' : openState === '1') openDrawer();
})();
