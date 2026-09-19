/* ===========================================================================
   workmode.js — the app's local client. Injected ONLY by the local server
   (never present in the static docs/ on GitHub Pages).

   Adds, on every page:
     • an IDE-style bottom terminal drawer (xterm.js) bridged to the server's
       node-pty shell over a WebSocket, with resize handling;
     • a floating launcher of split buttons (a main action + a ▾ menu): a command
       picker that pre-types /explain-paper · /compare · /learn (the ▾ switches
       which, remembered across reloads), and a Terminal button (main = toggle the
       drawer) whose ▾ launches an AI — claude · codex · gemini — in the shell;
     • a live-refresh toast when the server rebuilds docs/ (digest watcher);
     • the hooks the graph add-on / account block call when present:
         window.RR_runInTerminal(cmd)  — focus the terminal and pre-type cmd
         window.RR_dismissGhost(d)     — POST /api/dismiss (persisted + rebuilt)
         window.RR_editProfile()       — full-screen Markdown editor for user/profile.md
         window.RR_openUpdates(force)  — the "Update available" / "up to date" modal
     • hidden-job safety: every GUI run tells the server when it starts (job-start →
       library snapshot) so a Stop button, or the assistant dying in the terminal,
       rolls back anything half-written (job-stop) instead of leaving a stub report;
     • git-based updates: an "Update available" modal (same classes as the account
       modals) that applies the pull/install/build with progress and restarts the
       server (exit 75 → the launcher relaunches it) when its own files changed.

   Assistants are launched in AUTO mode (per-CLI flags in AI_CMD) because the GUI
   flows fire `/… --approve` commands into a hidden session — a permission prompt
   mid-run would stall the job with nothing on screen. "Show terminal" always
   exposes the live session. This never uses a provider API or `claude -p`.
   =========================================================================== */
(function () {
  'use strict';
  var WM = window.RR_WORKMODE;
  if (!WM) return;                              // not served by the app — do nothing

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
  var LS_H = 'rr-wm-h';                         // drawer height persists (open/closed deliberately does NOT)
  var LS_SR = 'rr-wm-sr';                       // xterm screen-reader mode (assistant settings)

  function lsGet(k, d){ try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---- reading state: keep the file on disk in step with this browser ----
     Status, priority, collections, ghost dismissals and the theme live in
     localStorage, which the browser scopes to the ORIGIN — port included. The app
     falls back to the next free port when 4317 is busy, and the library then came
     up unread with the tutorial back. The server seeds every page from
     user/reading-state.json in <head> (window.RR_STATE); from here on every write
     to one of those keys goes back to it. localStorage stays the read path. */
  var STATE_RE = /^rr-(?:status|prio|tags)-|^rr-(?:dismissed|theme)$/;
  (function syncReadingState(){
    var LS; try { LS = window.localStorage; } catch (e) { return; }
    if (!LS || typeof LS.setItem !== 'function') return;
    var queue = { set: {}, remove: [] }, timer = null;
    function flush(keepalive){
      timer = null;
      var body = queue; queue = { set: {}, remove: [] };
      if (!Object.keys(body.set).length && !body.remove.length) return;
      try {
        fetch('/api/reading-state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), keepalive: !!keepalive }).catch(function (){});
      } catch (e) {}
    }
    function queueKey(k, v, del){
      if (!STATE_RE.test(k)) return;
      if (del) { delete queue.set[k]; queue.remove.push(k); }
      else { queue.set[k] = String(v); }
      if (!timer) timer = setTimeout(flush, 250);       // coalesce a burst of stars
    }
    var origSet = LS.setItem, origRemove = LS.removeItem;
    try {
      LS.setItem = function (k, v){ origSet.call(LS, k, v); queueKey(k, v, false); };
      LS.removeItem = function (k){ origRemove.call(LS, k); queueKey(k, null, true); };
    } catch (e) { return; }                              // locked-down browser: reads still work
    // First run under a server that has no file yet, in a browser that already has
    // state (an older copy of the app): seed the file from here instead of starting blank.
    var seeded = window.RR_STATE && Object.keys(window.RR_STATE).length;
    if (!seeded){
      var mine = {}, n = 0;
      try { for (var i = 0; i < LS.length; i++){ var k = LS.key(i); if (k && STATE_RE.test(k)) { mine[k] = LS.getItem(k); n++; } } } catch (e) {}
      if (n){ queue.set = mine; if (!timer) timer = setTimeout(flush, 250); }
    }
    window.addEventListener('pagehide', function (){ if (timer){ clearTimeout(timer); flush(true); } });
  })();


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
  var ICO_DIVE = svg('<circle cx="12" cy="12" r="10"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/>');
  var ICO_GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>');

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
  // primary, GUI way to add a paper: a hidden `/explain-paper … --approve` run with a
  // Working overlay + filesystem-detected result — no terminal to look at (see the
  // Analyze section below). The command picker below stays for pre-typing any command.
  var analyzeBtn = el('button', 'rr-wm-btn rr-wm-primary', ICO_DOC + '<span>Analyze paper</span>'); analyzeBtn.type = 'button';
  analyzeBtn.title = 'Add a paper to your library — runs /explain-paper for you in a hidden assistant session';
  analyzeBtn.addEventListener('click', function (){ openAnalyze(); });
  launch.appendChild(analyzeBtn);
  if (REPORT_ID) {                                 // reading a report -> offer its PDF + notes in-app
    var pdfBtn = el('button', 'rr-wm-btn', ICO_PDF + '<span>View PDF</span>'); pdfBtn.type = 'button';
    pdfBtn.addEventListener('click', function (){ viewPdf(REPORT_ID); });
    launch.appendChild(pdfBtn);
    var notesBtn = el('button', 'rr-wm-btn', ICO_PEN + '<span>Edit notes</span>'); notesBtn.type = 'button';
    notesBtn.title = 'Your own notes for this paper (reports/<id>/notes.md) — rendered under "My notes"';
    notesBtn.addEventListener('click', function (){ editNotes(REPORT_ID); });
    launch.appendChild(notesBtn);
    var rmPaperBtn = el('button', 'rr-wm-btn', ICO_CLR + '<span>Remove paper</span>'); rmPaperBtn.type = 'button';
    rmPaperBtn.title = 'Delete this paper’s report, PDF and page (asks first)';
    rmPaperBtn.addEventListener('click', function (){ removePaper(REPORT_ID); });
    launch.appendChild(rmPaperBtn);
  }
  if (CHAT_ID) {                                   // reading a discussion -> offer to remove it (no terminal needed)
    var rmBtn = el('button', 'rr-wm-btn', ICO_CLR + '<span>Remove discussion</span>'); rmBtn.type = 'button';
    rmBtn.addEventListener('click', function (){ removeChat(CHAT_ID); });
    launch.appendChild(rmBtn);
  }
  // GUI flows (app-first): each opens a full-screen overlay instead of pre-typing.
  // Compare / Deep dive run HIDDEN like Analyze (fire `/…  --approve` into a hidden
  // assistant, watch the filesystem for the result); Discuss opens a live terminal
  // chat (it's a conversation by design). The ▾ switches which is the main action
  // (remembered across reloads). To pre-type a raw command instead, open the Terminal.
  var flowSplit = splitButton({
    store: 'rr-wm-flow', def: 'compare', switchLabel: 'Switch action',
    items: [
      { key: 'compare',  label: 'Compare papers',  icon: ICO_CMP,   run: function (){ openCompare(); } },
      { key: 'learn',    label: 'Discuss a paper',  icon: ICO_LEARN, run: function (){ openDiscuss(); } },
      { key: 'deepdive', label: 'Deep dive',        icon: ICO_DIVE,  run: function (){ openDeepDive(); } },
    ],
  });
  // terminal — the main button toggles the drawer; the ▾ launches an AI (Claude/Codex/Gemini) in it
  var termSplit = splitButton({
    main: { label: 'Terminal', icon: ICO_TERM, run: function (){ toggleDrawer(); } },
    switchLabel: 'Launch an AI',
    items: [
      { key: 'claude', label: 'Launch claude', icon: ICO_BOT, run: function (){ abandonRuns(); launchAgent('claude'); } },
      { key: 'codex',  label: 'Launch codex',  icon: ICO_BOT, run: function (){ abandonRuns(); launchAgent('codex'); } },
      { key: 'gemini', label: 'Launch gemini', icon: ICO_BOT, run: function (){ abandonRuns(); launchAgent('gemini'); } },
      { key: 'settings', label: 'Assistant settings…', icon: ICO_GEAR, run: function (){ openAiCfgModal(); } },
    ],
  });
  launch.appendChild(flowSplit); launch.appendChild(termSplit);

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
  // Stop discussion: abandon a running /learn — the server kills the assistant and rolls
  // back anything it wrote (nothing is saved). Shown next to End chat while one is running.
  var stopChatBtn = el('button', 'rr-wm-endchat rr-wm-stopchat', 'Stop discussion'); stopChatBtn.type = 'button';
  stopChatBtn.title = 'Stop this discussion without saving it';
  stopChatBtn.hidden = true;
  var clearBtn = el('button', 'rr-wm-iconbtn', ICO_CLR); clearBtn.type = 'button'; clearBtn.title = 'Clear';
  var closeBtn = el('button', 'rr-wm-iconbtn', ICO_X); closeBtn.type = 'button'; closeBtn.title = 'Hide (Esc)';
  bar.appendChild(title); bar.appendChild(dot); bar.appendChild(hint); bar.appendChild(spacer);
  bar.appendChild(endChatBtn); bar.appendChild(stopChatBtn); bar.appendChild(clearBtn); bar.appendChild(closeBtn);
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
  var afterFlush = null;                         // called once after a launch's input flushes (boot-wait arming)
  var pending = [];                              // input queued before the shell is ready (latest request wins)
  // shared "hidden run" flow state (Analyze / Compare / Deep dive) — see the Flows section below
  var job = null;                                // the active hidden job, or null
  var runTick = null;                            // 1 s timer updating the run card's elapsed/last-line
  var jobStatusText = '';                        // last status line (re-shown if you reopen the overlay mid-run)
  var activeArm = null;                          // current boot-wait controller (note() on shell output)
  var flowOv = null;                             // the shared full-screen flow overlay
  var setupDoneAt = 0;                           // /setup finished at this time -> reload on the rebuild that follows (TTL'd)
  var lastPtyData = 0;                           // last time the shared pty produced output (job watchdog)
  var launchHint = false;                        // a "launching X …" hint is showing (belt: clear on first output)
  var discuss = null;                            // the running /learn discussion { id, started } (visible terminal), or null
  var serverStartedAt = null;                    // /api/status startedAt — tells a restarted server from the old one
  var keepHintUntil = 0;                         // a deliberate stop's hint outlives the shell-exit hint that follows it
  var agentLive = false;                         // the CURRENT shell is running a live assistant (TUI seen after a launch)
  var launchedAi = null;                         // which assistant was launched into the current shell
  var launchWatch = null;                        // { name, at, bytes } while a launch's first output is being judged
  var CLR = '\x15';                              // Ctrl+U: clear the input line before (re)typing, so an
                                                 // un-run pre-typed command never accumulates with the next
  var reconnectTimer = null, reconnectDelay = 1500;

  function srMode(){ return lsGet(LS_SR, '0') === '1'; }
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
      screenReaderMode: srMode(),
    });
    termWrap.setAttribute('role', 'group');
    termWrap.setAttribute('aria-label', 'Assistant terminal');
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
      if (m.type === 'data') {
        if (term) term.write(m.data);
        lastPtyData = Date.now();
        if (job && job.started) noteOutput(m.data);     // run card: "still working, this is the last thing it said"

        if (launchWatch) judgeLaunch(m.data);
        if (activeArm && !activeArm.sent()) activeArm.note(m.data);
        // belt-and-braces: the assistant producing output IS the launch happening —
        // never leave a stale "launching X …" hint on screen past that point
        if (launchHint && spawned) { launchHint = false; if (hint.textContent.indexOf('launching') === 0) setHint(''); }
      }
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
        if (afterFlush) { var _f = afterFlush; afterFlush = null; try { _f(); } catch (e) {} } // arm the queued send after boot
      }
      else if (m.type === 'report-added' || m.type === 'report-changed' || m.type === 'compare-added' || m.type === 'chat-added') {
        jobOnBroadcast(m);                          // a hidden Analyze/Compare/Deep dive may be waiting for this
        if (m.type === 'chat-added') {
          if (discuss) discussSaved();              // the running discussion compacted → tell the server (job-end)
          if (!job) toast('Discussion saved — ' + m.slug, 'Open', function (){ location.href = '/chat/' + encodeURIComponent(m.slug) + '/'; });
        }
      }
      else if (m.type === 'agent-exited') { agentLive = false; launchWatch = null; onAgentExited(); }   // the shell has had no child for a while: the assistant is gone
      else if (m.type === 'job-started') onJobStarted(m);    // the server registered our run: keep its ownership token
      else if (m.type === 'job-stopped') onJobStopped(m);    // the server finished rolling back a stopped run
      else if (m.type === 'update-progress') updProgress(m); // an update is being applied (pull / install / build)
      else if (m.type === 'restarting') updRestarting();     // the server is about to exit(75) — the launcher relaunches it
      else if (m.type === 'setup-done') {
        // /setup finished (the agent deleted the intake file): close the terminal
        // drawer as promised by the gears overlay, and tell the account block
        // (which owns that overlay) so it can flip to its ✓ state.
        closeDrawer();
        setupDoneAt = Date.now();
        try { window.dispatchEvent(new CustomEvent('rr-setup-done')); } catch (e) {}
        // Kick one rebuild so a fresh 'changed' arrives deterministically (the agent's
        // config/profile writes may have been rebuilt BEFORE setup-done fired).
        fetch('/api/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function (){});
      }
      else if (m.type === 'changed') {
        // reload to show the personalized header — but only for a rebuild that follows
        // setup-done promptly. Without the TTL, a stale flag caused a surprise reload
        // on some unrelated rebuild minutes later.
        if (setupDoneAt && Date.now() - setupDoneAt < 30000) { setupDoneAt = 0; location.reload(); return; }
        setupDoneAt = 0;
        onRebuilt();
      }
      else if (m.type === 'building') setHint('rebuilding…');
      else if (m.type === 'build-error') {
        setHint('build error');
        // last non-empty line of scripts/build.py's stderr is the most useful one-liner
        var bline = String(m.error || '').split('\n').map(function(s){ return s.trim(); }).filter(Boolean).pop() || '';
        toast('Build failed' + (bline ? ': ' + bline.slice(0, 160) : ' — see the app log (workmode/workmode.log)'));
      }
      else if (m.type === 'exit') {
        // a (re)spawn is in flight: this exit is the OLD shell's (we asked for it — e.g. a
        // Stop right before "Launch codex"); the queued launch must survive to the new
        // shell's 'ready', so don't reset the handshake or drop `pending` here
        if (awaitingReady) return;
        agentLive = false; launchedAi = null; launchWatch = null;
        if (Date.now() > keepHintUntil) setHint('shell exited — reopen to start a new one');
        spawned = false; awaitingReady = false; wantSpawn = false; pending = [];
        afterFlush = null;                       // a REAL exit (respawns are epoch-guarded server-side): a queued launch has no shell to land in
        if (activeArm) { activeArm.cancel(); activeArm = null; }
        if (job) jobOnExit();                    // a hidden run lost its shell → roll back, never leave the overlay spinning
        if (discuss) discussOnExit();            // a discussion lost its shell → nothing saved
        endChatBtn.hidden = true; stopChatBtn.hidden = true;
      }
      else if (m.type === 'fatal') {
        // pty unavailable (node-pty not built): a spawn/respawn was answered with
        // 'fatal', never 'ready' — reset the handshake state or awaitingReady sticks
        // true forever ("launching …" hint frozen, every later launch queued into limbo).
        if (term) term.write('\r\n\x1b[31m' + m.msg + '\x1b[0m\r\n');
        spawned = false; awaitingReady = false; wantRespawn = false; pending = []; afterFlush = null;
        setHint('terminal unavailable — run `npm install` in the app’s workmode/ folder');
        if (activeArm) { activeArm.cancel(); activeArm = null; }
        if (job) jobOnExit('The terminal isn’t available, so the assistant could not be started. Nothing was added to your library.');
        if (discuss) discussOnExit();
        endChatBtn.hidden = true; stopChatBtn.hidden = true;
      }
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
    wantSpawn = false;            // don't re-spawn a hidden shell on reconnect while closed
  }
  function toggleDrawer(){ isOpen() ? closeDrawer() : openDrawer(); }

  closeBtn.addEventListener('click', closeDrawer);
  clearBtn.addEventListener('click', function (){ if (term) term.clear(); if (term) term.focus(); });
  // End chat: tell a running /learn discussion to wrap up — it compacts the conversation
  // and appends it below the reading list (never a new paper/digest). Sends the "done" signal.
  endChatBtn.addEventListener('click', function (){
    openDrawer();
    if (spawned && ws && ws.readyState === 1) typeCommand('done');   // two-phase: paste-swallowed Enter otherwise
    else pending = ['done\r'];
    endChatBtn.hidden = true;                          // the chat is wrapping up
    setHint('ending chat — the agent will compact it');
    if (term) term.focus();
  });
  document.addEventListener('keydown', function (e){ if (e.key === 'Escape' && isOpen() && document.activeElement !== term && !(pdfOv && pdfOv.classList.contains('rr-show')) && !(notesOv && notesOv.classList.contains('rr-show')) && !(profOv && profOv.classList.contains('rr-show')) && !(flowOv && flowOv.classList.contains('rr-show'))) closeDrawer(); });

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
  // Every assistant is launched in AUTO mode: the GUI flows fire `/… --approve`
  // commands into it unattended, and a permission prompt mid-run would silently
  // stall a hidden job. The flags are per-CLI (claude/codex/gemini).
  var AI_CMD = {
    claude: 'claude --permission-mode bypassPermissions',
    codex:  'codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false',
    gemini: 'gemini --yolo',
  };
  // opts.headless: run the AI in the shared pty WITHOUT opening the drawer (the Analyze
  // flow watches the filesystem instead of the terminal). opts.then: called once, right
  // after the launch command flushes into the fresh shell (used to arm the analyze cmd).
  function launchAgent(name, opts){
    opts = opts || {};
    if (!opts.headless) openDrawer();
    endChatBtn.hidden = true;                          // a freshly launched agent has no /learn chat yet
    setHint('launching ' + name + ' …'); launchHint = true;
    pending = [aiCommand(name) + '\r'];               // latest action wins; no leftover pre-typed command
    // once the launch line is typed, drop the "launching …" hint (it used to stick
    // around forever on a plain ▾ launch); flows override this with their own step
    var thenCb = opts.then || function (){ setHint(''); };
    launchedAi = name; agentLive = false;
    afterFlush = function (){ launchWatch = { name: name, at: Date.now(), bytes: 0 }; thenCb(); };   // judge the first output
    if (ws && ws.readyState === 1 && !awaitingReady) {
      spawned = false; awaitingReady = true;
      send({ type: 'respawn', cols: term ? term.cols : 80, rows: term ? term.rows : 24 });
    } else {
      wantRespawn = true;               // converts the in-flight/upcoming spawn into a respawn
    }
    if (!opts.headless && term) term.focus();
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
  // GUI flows, openable from anywhere with a prefill (the graph's ghost "Analyze"
  // opens the Analyze overlay with the arXiv id already in the bar — never the terminal)
  window.RR_openAnalyze = function (input){ openAnalyze(input); };
  window.RR_openDiscuss = function (id){ openDiscuss(id); };
  window.RR_launchAgent = function (name){ abandonRuns(); launchAgent(name); };   // Setup's "Launch claude/codex/gemini"
  window.RR_openTerminal = function (){ openDrawer(); };           // Setup busy-box "Show terminal"
  // Setup's Finish: auto-run cmd in the EXISTING shell, WITHOUT opening/raising the
  // drawer. Returns true if it reached a live shell, false if none is running yet.
  window.RR_submitCommand = function (cmd){
    // only into a live assistant: typing /setup into a bare shell leaves the busy box spinning forever
    if (spawned && agentLive && ws && ws.readyState === 1) { typeCommand(flowCommand(launchedAi || chosenAi(), cmd)); return true; }   // two-phase submit, in the LAUNCHED assistant's syntax
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

  /* ------------------------------------------ full-profile Markdown editor */
  // user/profile.md — a free-form Markdown profile (background, current projects,
  // what the reader wants from reports, style) that the commands read to calibrate,
  // on top of profile.json. Same look as the notes editor; backed by GET/POST
  // /api/profile-md (an empty save deletes the file). No rebuild is needed.
  var profOv = null;
  function buildProfileOverlay(){
    if (profOv) return profOv;
    profOv = el('div', 'rr-notes-overlay');
    var bar = el('div', 'rr-pdf-bar');
    var back = el('button', 'rr-wm-btn', ICO_BACK + '<span>Back</span>'); back.type = 'button';
    var title = el('span', 'rr-pdf-title', 'Full profile — user/profile.md');
    var hint = el('span', 'rr-notes-hint', 'Markdown: who you are, what you work on, what you want from reports — the assistant reads this');
    var spacer = el('span', 'rr-wm-spacer');
    var review = el('button', 'rr-wm-btn', ICO_BOT + '<span>Save &amp; review</span>'); review.type = 'button';
    review.title = 'Save, then have your assistant read the profile and bring profile.json / the field config in line with it';
    var save = el('button', 'rr-wm-btn rr-notes-save', ICO_PEN + '<span>Save</span>'); save.type = 'button';
    var ta = el('textarea', 'rr-notes-ta'); ta.setAttribute('aria-label', 'Your full profile (Markdown)'); ta.spellcheck = false;
    ta.placeholder = '# Your name\n\n## Background\n…\n\n## What I\'m working on\n…\n\n## What I want from reports\n…';
    bar.appendChild(back); bar.appendChild(title); bar.appendChild(hint); bar.appendChild(spacer); bar.appendChild(review); bar.appendChild(save);
    profOv.appendChild(bar); profOv.appendChild(ta);
    document.body.appendChild(profOv);
    back.addEventListener('click', closeProfile);
    // save the Markdown; then() runs after a successful save (the review button chains a launch)
    function saveProfile(then){
      save.disabled = true; review.disabled = true;
      fetch('/api/profile-md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ta.value }),
      }).then(function (r){ return r.json(); })
        .then(function (j){
          if (!j || !j.ok) throw new Error((j && j.error) || 'save failed');
          save.disabled = false; review.disabled = false; closeProfile();
          try { window.dispatchEvent(new CustomEvent('rr-profile-md-saved')); } catch (e) {}   // the Profile modal can refresh its excerpt
          if (then) then(); else toast(ta.value.trim() ? 'Profile saved — reports will use it from now on' : 'Full profile removed');
        })
        .catch(function (e){ save.disabled = false; review.disabled = false; toast('Could not save the profile' + (e.message ? ': ' + e.message : '')); });
    }
    save.addEventListener('click', function (){ saveProfile(null); });
    // Save & review: the chosen assistant reads user/profile.md and reconciles profile.json +
    // the field config with it (/setup --review-profile), visibly in the terminal
    review.addEventListener('click', function (){
      if (!ta.value.trim()){ toast('Write something in the profile first'); return; }
      saveProfile(function (){
        var ai = chosenAi();
        abandonRuns();
        setHint('launching ' + ai + ' to review your profile …');
        launchAgent(ai, { then: function (){ activeArm = armSend(flowCommand(ai, '/setup --review-profile'), function (){ setHint('the assistant is reviewing your profile — follow along here'); }); } });
        toast('Profile saved — ' + ai + ' is reviewing it in the terminal');
      });
    });
    profOv._ta = ta; profOv._save = save;
    return profOv;
  }
  function editProfile(){
    // the account block closes its Profile modal before calling us; belt for any other caller
    Array.prototype.forEach.call(document.querySelectorAll('.rr-modal:not([hidden])'), function (m){ m.setAttribute('hidden', ''); });
    document.body.classList.remove('rr-modal-open');
    var ov = buildProfileOverlay();
    ov._ta.value = ''; ov._save.disabled = true;
    fetch('/api/profile-md').then(function (r){ return r.json(); })
      .then(function (j){ ov._ta.value = (j && j.text) || ''; ov._save.disabled = false; ov._ta.focus(); })
      .catch(function (){ ov._save.disabled = false; ov._ta.focus(); });
    ov.classList.add('rr-show');
    document.body.classList.add('rr-pdf-open');    // same scroll lock as the PDF / notes overlays
  }
  function closeProfile(){
    if (!profOv) return;
    profOv.classList.remove('rr-show');
    document.body.classList.remove('rr-pdf-open');
  }
  window.RR_editProfile = editProfile;             // the Profile modal's "Edit full profile"
  document.addEventListener('keydown', function (e){
    if (e.key === 'Escape' && profOv && profOv.classList.contains('rr-show')) closeProfile();
  });

  /* ================================= Flows ==================================
     App-first, GUI ways to run the four workflows. Analyze / Compare / Deep dive
     run HIDDEN — the chosen assistant is launched in the shared pty, the command
     is sent once it's booted, and the FILESYSTEM (not the terminal) tells us when
     the result lands. Discuss is interactive by design, so it opens the visible
     terminal instead. All share: the boot-wait send (armSend), the job runner, one
     full-screen overlay, and the paper/assistant pickers. "Show terminal" reveals
     the same live session (for the assistant's own permission prompts). Nothing here
     uses the Anthropic API / `claude -p` — the interactive CLI is the only sanctioned
     path to the reader's own subscription; this is a veneer over it.
     ========================================================================== */
  var AIS = ['claude', 'codex', 'gemini'];
  // When to send the command after launching the assistant. MARKER-BASED, not
  // quiet-based: after the shell echoes the launch there is a 1–3 s SILENT gap while
  // the assistant's process loads — a quiet-detector fires right into that gap, the
  // text+Enters get queued by the tty and delivered to the TUI as ONE read (= a
  // paste), and the command ends up sitting in the composer unsubmitted. So instead:
  // wait for the TUI to actually take over (alternate-screen switch ESC[?1049h, or a
  // real burst of redraw output), let it settle briefly, then type. Hard cap for
  // non-TUI targets (plain shells in tests).
  var BOOT_SETTLE_MS = 1800, BOOT_CAP_MS = 20000, BOOT_BURST_BYTES = 1500;
  var statusPromise = null;
  function aiStatus(){ return statusPromise || (statusPromise = fetch('/api/status').then(function (r){ return r.json(); }).catch(function (){ return null; })); }
  var reportsPromise = null;   // catalogued papers, for the pickers (per page load)
  function reportsList(){ return reportsPromise || (reportsPromise = fetch('/api/reports').then(function (r){ return r.json(); }).then(function (j){ return (j && j.reports) || []; }).catch(function (){ return []; })); }
  function chosenAi(){ var a = lsGet('rr-wm-ai', 'claude'); return AIS.indexOf(a) === -1 ? 'claude' : a; }
  function clean1(s){ return String(s || '').replace(/[\r\n]+/g, ' ').trim(); }   // one line — a stray newline would submit early
  function headOk(url){ return fetch(url, { method: 'HEAD' }).then(function (r){ return r.ok; }).catch(function (){ return false; }); }

  // After a launch line is flushed, the first output tells whether an assistant is really
  // running: a "command not found" means it isn't installed (never type a flow command
  // into the bare shell); a TUI taking the screen (or a burst of output) means it is.
  function judgeLaunch(chunk){
    var w = launchWatch; if (!w) return;
    w.bytes += (chunk || '').length;
    if (/command not found|is not recognized as an internal|No such file or directory|not found: /i.test(chunk || '')){
      launchWatch = null; agentLive = false;
      setHint(w.name + ' is not installed here — install it, then launch again'); keepHintUntil = Date.now() + 8000;
      toast(w.name + ' isn’t installed (or not on PATH) — see the install steps in the README');
      return;
    }
    if ((chunk && chunk.indexOf('\x1b[?1049h') !== -1) || w.bytes >= BOOT_BURST_BYTES || Date.now() - w.at > 8000){
      launchWatch = null; agentLive = true;
    }
  }
  // run cb once the socket is connected and idle (no spawn handshake in flight), so
  // launchAgent takes the direct-respawn path even if a flow is started right at load.
  // Returns a cancel function: a Stop pressed while this wait is still pending must
  // keep the launch from firing later (it would start an unregistered, unstoppable run).
  function whenTermReady(cb, onTimeout){
    if (ws && ws.readyState === 1 && !awaitingReady){ cb(); return function (){}; }
    if (!ws || ws.readyState > 1) connect();
    var iv = setInterval(function (){ if (ws && ws.readyState === 1 && !awaitingReady){ clearInterval(iv); clearTimeout(to); cb(); } }, 100);
    var to = setTimeout(function (){ clearInterval(iv); if (onTimeout) onTimeout(); }, 8000);
    return function (){ clearInterval(iv); clearTimeout(to); };
  }

  // Type a command into the assistant's composer and SUBMIT it reliably. Sending
  // "text + Enter" in one chunk gets treated as a PASTE by the TUIs — the command
  // lands in the input box but the trailing Enter is swallowed, so it just sits
  // there unsubmitted. Send the text first, then Enter separately (and once more
  // as insurance — Enter on an empty composer is a no-op).
  function typeCommand(cmd){
    send({ type: 'data', data: CLR + cmd });
    setTimeout(function (){ send({ type: 'data', data: '\r' }); }, 400);
    setTimeout(function (){ send({ type: 'data', data: '\r' }); }, 1300);
  }
  // Send a command once the assistant's TUI is actually LIVE (see the constants
  // above for why quiet-detection is wrong here). Returns a controller: note(chunk)
  // on each pty output chunk, sent() to check, cancel() to abort. `activeArm`
  // points at the live one so the ws 'data' handler can feed it.
  function armSend(cmd, onSent){
    var t0 = Date.now(), tuiAt = 0, bytes = 0, done = false, iv;
    iv = setInterval(function (){
      if (done){ clearInterval(iv); return; }
      var now = Date.now();
      if ((tuiAt && now - tuiAt >= BOOT_SETTLE_MS) || now - t0 >= BOOT_CAP_MS){
        done = true; clearInterval(iv);
        typeCommand(cmd);
        if (onSent) onSent();
      }
    }, 200);
    return {
      note: function (chunk){
        if (done || tuiAt) return;
        bytes += (chunk || '').length;
        // the TUI taking over the screen is the readiness signal: alternate-screen
        // switch, or a redraw burst far bigger than a shell echo
        if ((chunk && chunk.indexOf('\x1b[?1049h') !== -1) || bytes >= BOOT_BURST_BYTES) tuiAt = Date.now();
      },
      sent: function (){ return done; },
      cancel: function (){ done = true; clearInterval(iv); },
    };
  }

  /* ---- job runner: launch → arm → watch a broadcast → verify → done ---- */
  // spec: { kind, id?, ai, title, cmd, working, building, watch(msg)->id|null, verify(id)->truthy|url,
  //         openUrl(id), openLabel, doneText(id), doneToast(id), again, againLabel }
  // Every run is bracketed server-side: job-start (the moment the command is
  // submitted) makes the server snapshot the library; job-end on a verified result;
  // job-stop — the Stop button (reason 'user'), or the assistant dying / being quit
  // in the terminal ('exited') — rolls the library back to that snapshot, so a
  // half-written report never lingers. `stopping` holds the run whose rollback we
  // are waiting on (job-stopped).
  // The last readable line the assistant printed — shown on the run card so a long
  // job looks supervised instead of hung. TUIs redraw whole screens, so strip the
  // escape sequences and keep the last line that actually reads like a sentence.
  var lastOutLine = '';
  function noteOutput(s){
    var t = String(s == null ? '' : s)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC (window titles)
      .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')              // CSI (colour, cursor)
      .replace(/\x1b[()][0-9A-Za-z]/g, '')
      .replace(/[\r\x00-\x08\x0b-\x1f\x7f]/g, '\n');
    var lines = t.split('\n');
    for (var i = lines.length - 1; i >= 0; i--){
      var ln = lines[i].replace(/[─-╿▀-▟]/g, ' ').trim();   // box drawing
      if (ln.length > 3 && /[A-Za-z]{3}/.test(ln)) { lastOutLine = ln.slice(0, 140); return; }
    }
  }
  function fmtElapsed(ms){
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    return m ? (m + 'm ' + (s % 60) + 's') : (s + 's');
  }
  var JOB_QUIET_WARN_MS = 90000;   // pty silent this long mid-job -> the assistant is probably waiting
  var stopping = null;             // { spec, text, timer } between job-stop and the server's job-stopped
  // has this assistant ever been launched by the app on this install? Its first start
  // in a folder typically shows a "trust this folder?" / login / onboarding dialog —
  // typing the flow command into that would answer the dialog instead of running.
  function aiKey(name){ return 'rr-ai-ready:' + name + '@' + WM.root + ':' + (WM.dir || ''); }   // per install AND per folder path
  function aiSeen(name){ return lsGet(aiKey(name), '') === '1'; }
  function markAiSeen(name){ lsSet(aiKey(name), '1'); }
  function runJob(spec){
    if (discuss) stopDiscussion();                    // one shared pty: a discussion can't survive the respawn
    job = { spec: spec, resultId: null, poll: null, sentAt: 0, warned: false, dog: null, started: false, token: null, wait: null };
    stopping = null;
    showFlowRun(spec.title);
    setJobStatus('Starting ' + spec.ai + ' …');
    ensureTerm();
    var me = job, first = !aiSeen(spec.ai);
    function submitted(){                             // the flow command is in the assistant's composer
      if (!job || job.spec !== spec) return;          // stopped/replaced while booting
      job.started = true; markAiSeen(spec.ai);
      var start = { type: 'job-start', kind: spec.kind }; if (spec.id) start.id = spec.id;
      send(start);                                    // server: snapshot the library for a rollback
      setJobStatus(spec.working);
      job.sentAt = Date.now(); job.dog = setInterval(jobWatchdog, 5000);
      if (first) closeDrawer();
    }
    me.wait = whenTermReady(function (){
      if (job !== me) return;                         // stopped/replaced while the socket was coming up
      if (first){
        // visible launch + a Continue button: the reader answers any first-run dialog
        // (trust the folder, log in), then the command is sent on their say-so
        launchAgent(spec.ai, { then: function (){ setHint('first launch of ' + spec.ai + ' here — answer its prompts, then press Continue'); } });
        setJobStatus('First launch of ' + spec.ai + ' in this app. If it asks you to trust this folder or to log in, answer in the terminal below — then press Continue.');
        renderRun(flowOv._card, false, { label: 'Continue', run: function (){
          if (job !== me) return;
          typeCommand(flowCommand(spec.ai, spec.cmd)); submitted();
        } });
        return;
      }
      launchAgent(spec.ai, { headless: true, then: function (){
        activeArm = armSend(flowCommand(spec.ai, spec.cmd), submitted);
      } });
    }, function (){
      if (job === me) stopJob('exited', 'Could not reach the app’s terminal — check that Reading Room is running, then try again. Nothing was added to your library.');
    });
  }
  // The whole point of the hidden flows is not watching the terminal — so when the
  // assistant stops producing output for a long stretch (it asked a question, hit an
  // error, wants a login), SAY so instead of spinning forever. Purely advisory: the
  // job keeps running and the warning retracts if output resumes.
  function jobWatchdog(){
    if (!job || !job.sentAt || job.resultId) return;
    var quiet = Date.now() - Math.max(lastPtyData, job.sentAt);
    if (quiet > JOB_QUIET_WARN_MS && !job.warned) {
      job.warned = true;
      setJobStatus('The assistant has been quiet for a while — it may be waiting for you (a question, a login, an error). Open the terminal to check.');
      if (!(flowOv && flowOv.classList.contains('rr-show'))) {
        toast('The assistant may need your attention', 'Show terminal', function (){ openDrawer(); });
      }
    } else if (quiet <= JOB_QUIET_WARN_MS && job.warned) {
      job.warned = false;
      setJobStatus(job.spec.working);          // output resumed — all good again
    }
  }
  // a completion broadcast arrived; if it's ours, poll until the artifact verifies, then finish
  function jobOnBroadcast(m){
    if (!job || job.resultId) return;
    var id = job.spec.watch(m);
    if (id == null) return;
    job.resultId = id;
    setJobStatus(job.spec.building);
    if (flowOv && flowOv.classList.contains('rr-show')) renderRun(flowOv._card, true);   // the run is done writing: no Stop any more
    if (job.poll) clearInterval(job.poll);
    var tries = 0;
    job.poll = setInterval(function (){
      tries++;
      Promise.resolve(job.spec.verify(id)).then(function (res){
        if (res){ clearInterval(job.poll); jobDone(id, typeof res === 'string' ? res : job.spec.openUrl(id)); }
        else if (tries > 240){ clearInterval(job.poll); jobDone(id, job.spec.openUrl(id)); } // give up waiting; offer anyway
      }).catch(function (){ if (tries > 240) clearInterval(job.poll); });
    }, 1000);
  }
  function jobDone(id, url){
    var j = job, sp = j ? j.spec : null;
    if (j && j.poll) clearInterval(j.poll);
    if (j && j.dog) clearInterval(j.dog);
    if (activeArm){ activeArm.cancel(); activeArm = null; }
    job = null;
    if (!sp) return;
    if (j.started) send({ type: 'job-end', token: j.token });      // result verified → the server drops its snapshot
    if (sp.onDone && sp.onDone(id) === true) return;              // a queue renders its own progress
    if (flowOv && flowOv.classList.contains('rr-show')) showFlowDone(sp, id, url);
    else toast(sp.doneToast(id), 'Open', function (){ location.href = url; });
  }
  // Stop the hidden run. reason 'user' (the Stop button): the server kills the
  // assistant, then rolls back; 'exited': the assistant is already gone (pty exit,
  // or quit from the terminal — the old "overlay spins forever" bug), roll back only.
  // A run that never reached job-start has nothing to roll back — finish at once.
  function stopJob(reason, text){
    if (!job) return;
    if (job.resultId){                             // it already finished — a Stop now just means "show me"
      var rid = job.resultId, url = job.spec.openUrl(rid); jobDone(rid, url); return;
    }
    var j = job; job = null;
    if (j.poll) clearInterval(j.poll);
    if (j.dog) clearInterval(j.dog);
    if (j.wait) j.wait();                         // a launch still waiting for the socket must never fire now
    if (activeArm){ activeArm.cancel(); activeArm = null; }
    afterFlush = null;                            // never let the flow command land in a later shell
    text = text || 'Stopped — nothing was added to your library.';
    if (!j.started){
      // no token = "kill the booting assistant only": the server rolls back nothing
      if (reason === 'user') send({ type: 'job-stop', reason: 'user' });
      else if (!arguments[1]) text = 'The assistant didn’t start (or quit before the command was sent). Open the terminal to see what happened. Nothing was added to your library.';
      showFlowStopped(j.spec, text);
      return;
    }
    stopping = { spec: j.spec, text: text, timer: null };
    setJobStatus(reason === 'user' ? 'Stopping…' : 'Cleaning up…');
    if (flowOv && flowOv.classList.contains('rr-show')) renderRun(flowOv._card, true);
    // the token proves this page owns the registered run — without it the server only
    // kills the shell and rolls back nothing (job-start's reply may still be in flight)
    withToken(j, function (token){ send({ type: 'job-stop', reason: reason, token: token }); });
    // belt: a dropped socket never answers — don't leave the overlay on "Stopping…" forever
    stopping.timer = setTimeout(function (){ onJobStopped({ type: 'job-stopped', removed: [], restored: false }); }, 20000);
  }
  // the server answers job-start with a token; keep it on whichever run this page registered
  function onJobStarted(m){
    if (!m || !m.token) return;
    if (m.kind === 'discuss'){ if (discuss && discuss.started && !discuss.token) discuss.token = m.token; }
    else if (job && job.started && !job.token) job.token = m.token;
  }
  // run cb(token) as soon as the run's token is known (job-started may still be in flight)
  function withToken(run, cb){
    if (run.token) return cb(run.token);
    var tries = 0, iv = setInterval(function (){
      if (run.token || ++tries > 15){ clearInterval(iv); cb(run.token || null); }
    }, 100);
  }
  // Leaving a registered run behind (launching an AI by hand, starting another flow):
  // stop it properly instead of letting the respawn kill it in silence.
  function abandonRuns(){
    if (job) stopJob('user');
    if (discuss) stopDiscussion();
  }
  function onJobStopped(m){
    if (!stopping) return;
    var s = stopping; stopping = null;
    if (s.timer) clearTimeout(s.timer);
    var extra = '';
    if (m && m.removed && m.removed.length) extra = ' Removed what it had started writing (' + m.removed.length + ' item' + (m.removed.length === 1 ? '' : 's') + ').';
    else if (m && m.restored) extra = ' The report was restored to how it was.';
    else if (m && m.stale) extra = ' (That run had already finished or belonged to another page — nothing was removed.)';
    showFlowStopped(s.spec, s.text + extra);
  }
  function jobOnExit(msg){
    if (!job) return;
    stopJob('exited', msg || 'The assistant session ended before finishing. Nothing was added to your library.');
  }
  // the shell has had no child process for a while: whoever was running in it is gone
  function onAgentExited(){
    if (job && !job.resultId) stopJob('exited', 'The assistant was stopped before finishing (from the terminal). Nothing was added to your library.');
    else if (discuss) discussOnExit('The assistant was quit before the discussion was saved — nothing was added to your library.');
  }

  /* ---- Remove a paper (report page) ---------------------------------------
     The same paths /remove deletes — digest folder, PDF, cached text, generated
     page. The server answers with the plan first, so the confirm can name exactly
     what goes and warn about comparisons and citations that point at it. */
  function removePaper(id){
    fetch('/api/remove-paper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
      .then(function (r){ return r.json(); })
      .then(function (p){
        if (!p || !p.ok) throw new Error((p && p.error) || 'could not read this paper');
        showRemovePaper(id, p);
      })
      .catch(function (e){ toast('Couldn’t remove this paper — ' + e.message); });
  }
  function showRemovePaper(id, plan){
    buildFlowOverlay();
    flowOv._title.textContent = 'Remove paper'; flowOv._showTerm.hidden = true;
    var card = flowOv._card; card.innerHTML = '';
    heads(card, 'Remove “' + (plan.title || id) + '”?', 'This deletes the paper’s files and its page. It cannot be undone.');
    var list = el('ul', 'rr-rm-list');
    (plan.paths || []).forEach(function (p){ var li = el('li'); li.textContent = p; list.appendChild(li); });
    card.appendChild(list);
    var alsoCmp = null;
    if (plan.compares && plan.compares.length){
      var lbl = el('label', 'rr-rm-check');
      alsoCmp = el('input'); alsoCmp.type = 'checkbox';
      lbl.appendChild(alsoCmp);
      lbl.appendChild(el('span', '', 'Also remove ' + plan.compares.length + ' comparison' + (plan.compares.length === 1 ? '' : 's') + ' built on it (' + plan.compares.map(esc).join(', ') + '). Left alone, they render with a gap.'));
      card.appendChild(lbl);
    }
    if (plan.citedBy && plan.citedBy.length){
      card.appendChild(noteEl('Cited by ' + plan.citedBy.length + ' other paper' + (plan.citedBy.length === 1 ? '' : 's') + ' in your library — it may come back as a hollow node in Connections, which you can dismiss there.'));
    }
    var actions = el('div', 'rr-analyze-actions rr-analyze-actions--center');
    var go = el('button', 'rr-wm-btn rr-wm-danger', ICO_CLR + '<span>Remove</span>'); go.type = 'button';
    var no = el('button', 'rr-wm-btn', '<span>Keep it</span>'); no.type = 'button';
    no.addEventListener('click', closeFlow);
    go.addEventListener('click', function (){
      go.disabled = true; no.disabled = true;
      setJobStatus('Removing “' + (plan.title || id) + '” …');
      renderRun(card, true);
      fetch('/api/remove-paper', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, confirm: true, compares: !!(alsoCmp && alsoCmp.checked) }) })
        .then(function (r){ return r.json(); })
        .then(function (j){
          if (!j || !j.ok) throw new Error((j && j.error) || 'remove failed');
          location.href = '/';                 // the page we are on has just been deleted
        })
        .catch(function (e){ showFlowStopped({ title: 'Remove paper' }, 'Couldn’t remove it — ' + e.message); });
    });
    actions.appendChild(go); actions.appendChild(no);
    card.appendChild(actions);
    flowOv.classList.add('rr-show'); document.body.classList.add('rr-pdf-open');
  }

  /* ---- Diagnostics --------------------------------------------------------
     Everything a "it doesn't work" message needs: versions, what was found on
     PATH, how this copy was installed, and the tail of the server log. */
  var diagOv = null;
  function openDiagnostics(){
    if (!diagOv){
      diagOv = el('div', 'rr-analyze-overlay');
      var bar = el('div', 'rr-pdf-bar');
      var back = el('button', 'rr-wm-btn', ICO_BACK + '<span>Back</span>'); back.type = 'button';
      back.addEventListener('click', function (){ diagOv.classList.remove('rr-show'); document.body.classList.remove('rr-pdf-open'); });
      var t = el('span', 'rr-pdf-title', 'Diagnostics');
      var sp = el('span', 'rr-wm-spacer');
      var copy = el('button', 'rr-wm-btn', ICO_DOC + '<span>Copy</span>'); copy.type = 'button';
      copy.addEventListener('click', function (){
        var txt = diagOv._text || '';
        function done(){ copy.querySelector('span').textContent = 'Copied'; setTimeout(function (){ copy.querySelector('span').textContent = 'Copy'; }, 1500); }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function (){ toast('Couldn’t copy — select the text instead'); });
        else toast('Couldn’t copy — select the text instead');
      });
      bar.appendChild(back); bar.appendChild(t); bar.appendChild(sp); bar.appendChild(copy);
      var body = el('div', 'rr-analyze-body');
      var card = el('div', 'rr-analyze-card rr-diag-card');
      body.appendChild(card);
      diagOv.appendChild(bar); diagOv.appendChild(body);
      document.body.appendChild(diagOv);
      diagOv._card = card;
    }
    var card = diagOv._card;
    card.innerHTML = '';
    heads(card, 'Diagnostics', 'What this copy is running, and the last lines of its log.');
    card.appendChild(el('div', 'rr-analyze-sub2', 'Loading…'));
    diagOv.classList.add('rr-show'); document.body.classList.add('rr-pdf-open');
    fetch('/api/diagnostics').then(function (r){ return r.json(); }).then(function (d){
      if (!d || !d.ok) throw new Error((d && d.error) || 'no answer');
      renderDiag(card, d);
    }).catch(function (e){
      card.innerHTML = '';
      heads(card, 'Diagnostics', 'Couldn’t read the app’s status — ' + e.message);
    });
  }
  function renderDiag(card, d){
    card.innerHTML = '';
    heads(card, 'Diagnostics', 'What this copy is running, and the last lines of its log.');
    var rows = [
      ['Reading Room', (d.app.version || '?') + (d.app.tag ? ('  (' + d.app.tag + ')') : '') + ' · installed with ' + (d.app.install === 'git' ? 'git' : 'a ZIP download')
        + (d.app.commit ? ('  · ' + d.app.commit + (d.app.branch ? ('@' + d.app.branch) : '')) : '')],
      ['Folder', d.app.repo],
      ['Serving', 'http://127.0.0.1:' + d.app.port + '  · since ' + String(d.app.startedAt || '').replace('T', ' ').slice(0, 19)
        + (d.app.restartable ? ' · can restart itself' : ' · started without the launcher')],
      ['Terminal', d.app.terminal ? 'ready' : 'not available (node-pty failed to build — the flows need it)'],
      ['System', d.env.platform + ' ' + d.env.arch + ' · Node ' + d.env.node + (d.env.npm ? (' · npm ' + d.env.npm) : '')],
      ['Python', d.env.pythonOk ? (d.env.python || d.env.pythonCmd) : 'NOT FOUND — the site cannot be rebuilt (install Python 3)'],
      ['Assistants', ['claude', 'codex', 'gemini'].map(function (n){
        return n + ': ' + (d.env.ais[n] ? d.env.ais[n] : (d.env.found[n] ? 'installed' : 'not installed'));
      }).join('\n')],
      ['Library', d.library.reports + ' papers · ' + d.library.comparisons + ' comparisons · ' + d.library.discussions + ' discussions · '
        + d.library.pdfs + ' PDFs · ' + d.library.backups + ' backup zips'],
    ];
    var tbl = el('div', 'rr-diag');
    rows.forEach(function (r){
      var row = el('div', 'rr-diag-row');
      var k = el('div', 'rr-diag-k'); k.textContent = r[0];
      var v = el('div', 'rr-diag-v'); v.textContent = r[1];
      row.appendChild(k); row.appendChild(v); tbl.appendChild(row);
    });
    card.appendChild(tbl);
    var logHead = el('div', 'rr-analyze-label'); logHead.textContent = 'Server log (last ' + (d.log || []).length + ' lines)';
    card.appendChild(logHead);
    var pre = el('pre', 'rr-diag-log'); pre.textContent = (d.log || []).join('\n') || '(the log is empty — this server is running in the foreground)';
    card.appendChild(pre);
    diagOv._text = rows.map(function (r){ return r[0] + ': ' + r[1]; }).join('\n') + '\n\n--- log ---\n' + ((d.log || []).join('\n'));
  }
  window.RR_openDiagnostics = openDiagnostics;

  /* ---- the full-screen panels are dialogs --------------------------------
     Analyze/Compare/Deep dive, the PDF reader, the notes and profile editors and
     Diagnostics are plain divs that slide over the page, so a keyboard had nothing
     to hold on to: focus stayed behind them and Tab wandered into the page they
     cover. One observer gives every panel — including ones built later — a dialog
     role, moves focus in, traps Tab, and hands focus back on the way out. */
  var PANEL_SEL = '.rr-analyze-overlay, .rr-pdf-overlay, .rr-notes-overlay';
  (function panelA11y(){
    if (!window.MutationObserver) return;
    var prevFocus = null, current = null;
    function labelOf(p){
      var t = p.querySelector('.rr-pdf-title');
      var s = t && t.textContent ? t.textContent.trim() : '';
      return s || 'Reading Room';
    }
    function focusables(p){
      return Array.prototype.filter.call(
        p.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'),
        function (e){ return !e.disabled && !e.hidden && e.offsetParent !== null; });
    }
    function enter(p){
      if (current === p) return;
      prevFocus = document.activeElement;
      current = p;
      p.setAttribute('role', 'dialog');
      p.setAttribute('aria-modal', 'true');
      p.setAttribute('aria-label', labelOf(p));
      setTimeout(function (){
        if (current !== p) return;
        var pref = p.querySelector('.rr-analyze-input, textarea') || focusables(p)[0];
        if (pref && pref.focus) { try { pref.focus(); } catch (e) {} }
      }, 40);
    }
    function leave(p){
      if (current !== p) return;
      current = null;
      p.removeAttribute('aria-modal');
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus(); } catch (e) {} }
      prevFocus = null;
    }
    function sweep(){
      Array.prototype.forEach.call(document.querySelectorAll(PANEL_SEL), function (p){
        if (p.classList.contains('rr-show')) enter(p); else leave(p);
      });
    }
    var mo = new MutationObserver(sweep);
    function watch(){
      Array.prototype.forEach.call(document.querySelectorAll(PANEL_SEL), function (p){
        if (p._rrA11y) return;
        p._rrA11y = true;
        mo.observe(p, { attributes: true, attributeFilter: ['class'] });
      });
    }
    new MutationObserver(function (){ watch(); sweep(); }).observe(document.body, { childList: true });
    watch(); sweep();
    document.addEventListener('keydown', function (e){
      if (!current) return;
      if (e.key === 'Tab'){
        var f = focusables(current);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1], a = document.activeElement;
        if (e.shiftKey && (a === first || !current.contains(a))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      } else if (e.key === 'Escape' && current.classList.contains('rr-analyze-overlay')){
        // the PDF/notes/profile panels close themselves on Esc already; the flow and
        // diagnostics panels close through the Back button in their bar
        var back = current.querySelector('.rr-pdf-bar .rr-wm-btn');
        if (back) { e.preventDefault(); e.stopPropagation(); back.click(); }
      }
    }, true);
  })();

  /* ---- shared overlay (form → working → done) ---- */
  function buildFlowOverlay(){
    if (flowOv) return flowOv;
    flowOv = el('div', 'rr-analyze-overlay');
    var bar = el('div', 'rr-pdf-bar');
    var back = el('button', 'rr-wm-btn', ICO_BACK + '<span>Back</span>'); back.type = 'button';
    var title = el('span', 'rr-pdf-title', '');
    var spacer = el('span', 'rr-wm-spacer');
    var showTerm = el('button', 'rr-wm-btn', ICO_TERM + '<span>Show terminal</span>'); showTerm.type = 'button'; showTerm.hidden = true;
    bar.appendChild(back); bar.appendChild(title); bar.appendChild(spacer); bar.appendChild(showTerm);
    var body = el('div', 'rr-analyze-body');
    var card = el('div', 'rr-analyze-card');
    body.appendChild(card);
    flowOv.appendChild(bar); flowOv.appendChild(body);
    document.body.appendChild(flowOv);
    back.addEventListener('click', closeFlow);
    showTerm.addEventListener('click', function (){ closeFlow(); openDrawer(); });   // watch/step in on the same live session
    flowOv._title = title; flowOv._showTerm = showTerm; flowOv._card = card;
    return flowOv;
  }
  function closeFlow(){ if (!flowOv) return; flowOv.classList.remove('rr-show'); document.body.classList.remove('rr-pdf-open'); }
  function setJobStatus(t){ jobStatusText = t; if (flowOv && flowOv._status) flowOv._status.textContent = t; }
  function heads(card, t, s){ var h = el('div', 'rr-analyze-title2'); h.textContent = t; card.appendChild(h); var su = el('div', 'rr-analyze-sub'); su.textContent = s; card.appendChild(su); }
  function labelInto(card, t){ var l = el('label', 'rr-analyze-label'); l.textContent = t; card.appendChild(l); return l; }

  // the "working" card. noStop: a stop is already in flight (no second Stop button)
  function renderRun(card, noStop, extra){
    card.innerHTML = '';
    var run = el('div', 'rr-analyze-run');
    run.appendChild(el('div', 'rr-analyze-spinner'));
    var st = el('div', 'rr-analyze-status'); st.textContent = jobStatusText || 'Starting…';
    st.setAttribute('role', 'status'); st.setAttribute('aria-live', 'polite');
    run.appendChild(st);
    if (extra){                                      // e.g. the first-launch "Continue"
      var ex = el('div', 'rr-analyze-actions rr-analyze-actions--center');
      var go = el('button', 'rr-wm-btn rr-wm-primary', ICO_BOT + '<span>' + esc(extra.label) + '</span>'); go.type = 'button';
      go.addEventListener('click', function (){ go.disabled = true; extra.run(); });
      ex.appendChild(go); run.appendChild(ex);
    }
    // elapsed + the assistant's last line: a spinner alone can't be told from a hang
    var meta = el('div', 'rr-analyze-meta'); meta.hidden = true;
    var metaTime = el('span', 'rr-analyze-elapsed', '');
    var metaLine = el('span', 'rr-analyze-lastline', '');
    meta.appendChild(metaTime); meta.appendChild(metaLine);
    run.appendChild(meta);
    if (runTick) { clearInterval(runTick); runTick = null; }
    runTick = setInterval(function (){
      if (!document.body.contains(meta)) { clearInterval(runTick); runTick = null; return; }
      if (!job || !job.sentAt) { meta.hidden = true; return; }
      meta.hidden = false;
      metaTime.textContent = 'Running ' + fmtElapsed(Date.now() - job.sentAt);
      metaLine.textContent = lastOutLine ? ('· ' + lastOutLine) : '';
    }, 1000);
    run.appendChild(el('div', 'rr-analyze-sub2', 'You can close this and keep browsing — I’ll let you know when it’s ready. Closing the window is fine too: the app keeps the run going and finishes writing.'));
    if (!noStop){
      // Stop → confirm row → job-stop 'user' (kills the assistant, rolls the library back)
      var stopWrap = el('div', 'rr-analyze-stop');
      var stopBtn = el('button', 'rr-wm-btn rr-wm-danger-ghost', ICO_X + '<span>Stop</span>'); stopBtn.type = 'button';
      stopBtn.title = 'Stop this run and discard anything it wrote';
      var confirm = el('div', 'rr-analyze-stoprow'); confirm.hidden = true;
      confirm.appendChild(el('span', 'rr-analyze-stoptxt', 'Stop and discard? Nothing will be added to your library.'));
      var yes = el('button', 'rr-wm-btn rr-wm-danger', ICO_X + '<span>Stop</span>'); yes.type = 'button';
      var no = el('button', 'rr-wm-btn', '<span>Keep running</span>'); no.type = 'button';
      confirm.appendChild(yes); confirm.appendChild(no);
      stopBtn.addEventListener('click', function (){ stopBtn.hidden = true; confirm.hidden = false; yes.focus(); });
      no.addEventListener('click', function (){ confirm.hidden = true; stopBtn.hidden = false; stopBtn.focus(); });
      yes.addEventListener('click', function (){ yes.disabled = true; no.disabled = true; stopJob('user'); });
      stopWrap.appendChild(stopBtn); stopWrap.appendChild(confirm);
      run.appendChild(stopWrap);
    }
    card.appendChild(run);
    flowOv._status = st;
  }
  // final card after a rollback: nothing was added; Close, or Try again (the same flow's form)
  function showFlowStopped(spec, text){
    jobStatusText = '';
    if (spec && spec.onStopped) spec.onStopped();                 // a stopped queue stops for good
    text = text || 'Stopped — nothing was added to your library.';
    if (!(flowOv && flowOv.classList.contains('rr-show'))){
      toast(text, 'Try again', function (){ if (spec.again) spec.again(); });
      return;
    }
    flowOv._title.textContent = spec.title; flowOv._showTerm.hidden = false;
    var card = flowOv._card; card.innerHTML = '';
    var box = el('div', 'rr-analyze-run');
    box.appendChild(el('div', 'rr-analyze-stopmark', '■'));
    var st = el('div', 'rr-analyze-status'); st.textContent = text; box.appendChild(st);
    var actions = el('div', 'rr-analyze-actions rr-analyze-actions--center');
    var again = el('button', 'rr-wm-btn rr-wm-primary', ICO_DOC + '<span>Try again</span>'); again.type = 'button';
    again.addEventListener('click', function (){ if (spec.again) spec.again(); else closeFlow(); });
    var close = el('button', 'rr-wm-btn', ICO_X + '<span>Close</span>'); close.type = 'button';
    close.addEventListener('click', closeFlow);
    actions.appendChild(again); actions.appendChild(close);
    box.appendChild(actions); card.appendChild(box);
    flowOv._status = null;
  }
  function showFlowRun(title){
    buildFlowOverlay();
    flowOv._title.textContent = title;
    flowOv._showTerm.hidden = false;
    renderRun(flowOv._card);
    if (!flowOv.classList.contains('rr-show')){ flowOv.classList.add('rr-show'); document.body.classList.add('rr-pdf-open'); }
  }
  function showFlowDone(spec, id, url){
    flowOv._showTerm.hidden = false;
    var card = flowOv._card; card.innerHTML = '';
    var done = el('div', 'rr-analyze-run');
    done.appendChild(el('div', 'rr-analyze-check', '✓'));
    var dst = el('div', 'rr-analyze-status'); dst.textContent = spec.doneText(id); done.appendChild(dst);
    var actions = el('div', 'rr-analyze-actions rr-analyze-actions--center');
    var open = el('button', 'rr-wm-btn rr-wm-primary', ICO_DOC + '<span>' + spec.openLabel + '</span>'); open.type = 'button';
    open.addEventListener('click', function (){ location.href = url; });
    actions.appendChild(open);
    if (spec.again){ var again = el('button', 'rr-wm-btn', ICO_DOC + '<span>' + (spec.againLabel || 'Do another') + '</span>'); again.type = 'button'; again.addEventListener('click', spec.again); actions.appendChild(again); }
    done.appendChild(actions);
    card.appendChild(done);
    flowOv._status = null;
  }
  // open a flow's form — but if a hidden job is already running, reopen to ITS status
  // (you can't start a second hidden run; that would respawn and kill the first).
  function openFlow(title, renderForm){
    buildFlowOverlay();
    if (job){ flowOv._title.textContent = job.spec.title; flowOv._showTerm.hidden = false; renderRun(flowOv._card); }
    else if (stopping){ flowOv._title.textContent = stopping.spec.title; flowOv._showTerm.hidden = false; renderRun(flowOv._card, true); }
    else { flowOv._title.textContent = title; flowOv._showTerm.hidden = true; flowOv._card.innerHTML = ''; renderForm(flowOv._card); }
    flowOv.classList.add('rr-show'); document.body.classList.add('rr-pdf-open');
  }

  /* ---- shared form components ---- */
  // assistant pills (claude/codex/gemini), persisted; greys out any not on PATH. → getter
  /* ---- assistant settings: model + reasoning effort per assistant (persisted in
     localStorage 'rr-wm-ai-cfg' as {claude:{model,effort}, codex:{…}, gemini:{model}}).
     They become CLI flags on the launch line — nothing else changes. ---- */
  var AI_MODELS = { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5-codex', 'gpt-5', 'o3'], gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'] };
  var AI_EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'], gemini: [] };
  function cleanModel(v){ v = String(v || '').trim(); return /^[A-Za-z0-9._:\/-]{1,80}$/.test(v) ? v : ''; }
  function aiCfg(){ try { var c = JSON.parse(lsGet('rr-wm-ai-cfg', '{}')); return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {}; } catch (e) { return {}; } }
  function aiCfgFor(name){ var c = aiCfg()[name] || {}; return { model: cleanModel(c.model), effort: (AI_EFFORTS[name] || []).indexOf(c.effort) !== -1 ? c.effort : '' }; }
  function setAiCfg(name, patch){ var c = aiCfg(); c[name] = Object.assign({}, c[name] || {}, patch); lsSet('rr-wm-ai-cfg', JSON.stringify(c)); }
  // the launch line: AUTO-mode flags + the reader's model / effort, in each CLI's own syntax
  function aiCommand(name){
    var line = AI_CMD[name] || name, c = aiCfgFor(name);
    if (name === 'claude'){ if (c.model) line += ' --model ' + c.model; if (c.effort) line += ' --effort ' + c.effort; }
    else if (name === 'codex'){ if (c.model) line += ' -m ' + c.model; if (c.effort) line += ' -c model_reasoning_effort="' + c.effort + '"'; }
    else if (name === 'gemini'){ if (c.model) line += ' -m ' + c.model; }
    return line;
  }
  // The flow commands are Claude-style slash commands (/explain-paper …). Codex has no
  // custom slash commands — it rejects unknown ones before the model sees them — but it
  // ships the same workflows as skills (.agents/skills/<name>) invoked with `$name …`.
  function flowCommand(ai, cmd){
    if (ai === 'codex' && cmd.charAt(0) === '/') return '$' + cmd.slice(1);
    return cmd;
  }
  function aiSummary(name){
    var c = aiCfgFor(name), parts = [name, c.model || 'default model'];
    if ((AI_EFFORTS[name] || []).length) parts.push(c.effort ? (c.effort + ' effort') : 'default effort');
    return parts.join(' · ');
  }
  // the settings fields for one assistant (inline under the pills, and in the Terminal ▾ modal)
  function renderAiCfg(box, name, onChange){
    box.innerHTML = '';
    var c = aiCfgFor(name);
    var f1 = el('label', 'rr-ai-field'); f1.appendChild(el('span', 'rr-analyze-label', 'Model'));
    var inp = el('input', 'rr-analyze-input'); inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.value = c.model;
    inp.placeholder = 'default — or e.g. ' + (AI_MODELS[name] || []).slice(0, 2).join(', ');
    var dl = el('datalist'); dl.id = 'rr-ai-models-' + name + '-' + Math.floor(Math.random() * 1e6);
    (AI_MODELS[name] || []).forEach(function (m){ var o = document.createElement('option'); o.value = m; dl.appendChild(o); });
    inp.setAttribute('list', dl.id); f1.appendChild(inp); f1.appendChild(dl); box.appendChild(f1);
    var help = el('div', 'rr-analyze-help');
    function paintHelp(){ help.innerHTML = 'Blank = the CLI’s own default. Launch line: <code>' + esc(aiCommand(name)) + '</code>'; }
    inp.addEventListener('input', function (){
      var v = inp.value.trim(); inp.classList.toggle('rr-bad', !!v && !cleanModel(v));
      setAiCfg(name, { model: cleanModel(v) ? v : '' }); paintHelp(); if (onChange) onChange();
    });
    if ((AI_EFFORTS[name] || []).length){
      var f2 = el('label', 'rr-ai-field'); f2.appendChild(el('span', 'rr-analyze-label', 'Reasoning effort'));
      var sel = el('select', 'rr-analyze-input rr-flow-select'); sel.appendChild(new Option('default', ''));
      AI_EFFORTS[name].forEach(function (e){ sel.appendChild(new Option(e, e)); }); sel.value = c.effort;
      sel.addEventListener('change', function (){ setAiCfg(name, { effort: sel.value }); paintHelp(); if (onChange) onChange(); });
      f2.appendChild(sel); box.appendChild(f2);
    }
    paintHelp(); box.appendChild(help);
    return box;
  }
  // assistant pills (claude/codex/gemini), persisted; greys out any not on PATH; a gear
  // opens the model/effort settings for the chosen one. opts.open: settings shown at once
  // (the Terminal ▾ "Assistant settings" modal). → getter
  function aiSelectorInto(card, opts){
    opts = opts || {};
    var row = el('div', 'rr-analyze-ai'); card.appendChild(row);
    var chosen = chosenAi(); var btns = {};
    var gear = el('button', 'rr-analyze-aibtn rr-ai-gear', ICO_GEAR + '<span>Settings</span>'); gear.type = 'button'; gear.title = 'Model and reasoning effort for this assistant';
    var sum = el('div', 'rr-ai-sum');
    var panel = el('div', 'rr-ai-cfg'); panel.hidden = !opts.open;
    function paintSum(){ sum.textContent = aiSummary(chosen); }
    function paint(){ AIS.forEach(function (n){ btns[n].classList.toggle('rr-on', n === chosen); }); paintSum(); if (!panel.hidden) renderAiCfg(panel, chosen, paintSum); }
    AIS.forEach(function (name){
      var b = el('button', 'rr-analyze-aibtn', ICO_BOT + '<span>' + name + '</span>'); b.type = 'button';
      b.addEventListener('click', function (){ if (!b.disabled){ chosen = name; lsSet('rr-wm-ai', name); paint(); } });
      row.appendChild(b); btns[name] = b;
    });
    if (!opts.open) row.appendChild(gear);
    card.appendChild(sum); card.appendChild(panel);
    gear.addEventListener('click', function (){ panel.hidden = !panel.hidden; gear.classList.toggle('rr-on', !panel.hidden); if (!panel.hidden) renderAiCfg(panel, chosen, paintSum); });
    paint();
    aiStatus().then(function (s){
      var ais = s && s.ais; if (!ais) return;
      if (!AIS.some(function (n){ return ais[n]; })) return;
      AIS.forEach(function (n){ if (!ais[n]){ btns[n].disabled = true; btns[n].title = n + ' isn’t installed'; } });
      if (!ais[chosen]){ var f = AIS.filter(function (n){ return ais[n]; })[0]; if (f){ chosen = f; lsSet('rr-wm-ai', f); paint(); } }
    });
    return function (){ return chosen; };
  }
  // Terminal ▾ → Assistant settings: the same pills + fields in a small modal
  var aiCfgModal = null;
  function openAiCfgModal(){
    if (!aiCfgModal){
      aiCfgModal = el('div', 'rr-modal rr-aicfg-modal'); aiCfgModal.id = 'rr-aicfg-modal'; aiCfgModal.hidden = true;
      var bd = el('div', 'rr-modal-backdrop');
      var card = el('div', 'rr-modal-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'rr-aicfg-title');
      var head = el('div', 'rr-modal-head'); var h = el('h2', 'rr-modal-title'); h.id = 'rr-aicfg-title'; h.textContent = 'Assistant settings';
      var x = el('button', 'rr-modal-x', '&#10005;'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); head.appendChild(h); head.appendChild(x);
      var body = el('div', 'rr-modal-body rr-aicfg-body');
      var foot = el('div', 'rr-modal-foot'); var close = el('button', 'rr-btn rr-btn-ghost'); close.type = 'button'; close.textContent = 'Close'; foot.appendChild(el('span', 'rr-spacer')); foot.appendChild(close);
      card.appendChild(head); card.appendChild(body); card.appendChild(foot); aiCfgModal.appendChild(bd); aiCfgModal.appendChild(card); document.body.appendChild(aiCfgModal);
      bd.addEventListener('click', closeAiCfgModal); x.addEventListener('click', closeAiCfgModal); close.addEventListener('click', closeAiCfgModal);
      document.addEventListener('keydown', function (e){ if (e.key === 'Escape' && aiCfgModal && !aiCfgModal.hidden){ e.stopPropagation(); closeAiCfgModal(); } }, true);
      aiCfgModal._body = body;
    }
    if (document.querySelector('.rr-modal:not([hidden])')) return;   // never two modals at once
    var b = aiCfgModal._body; b.innerHTML = '';
    b.appendChild(el('p', 'rr-analyze-help', 'Which model and how much reasoning effort each assistant uses when the app launches it — for the flow buttons and the Terminal ▾ launches alike. Saved in this browser.'));
    aiSelectorInto(b, { open: true });
    // screen-reader mode: xterm mirrors the terminal into a live region so a reader
    // can follow the assistant. Off by default (it announces every redraw).
    var srWrap = el('label', 'rr-aicfg-sr');
    var srBox = el('input'); srBox.type = 'checkbox'; srBox.checked = srMode();
    srWrap.appendChild(srBox);
    srWrap.appendChild(el('span', '', 'Screen-reader mode in the terminal — announce the assistant’s output'));
    srBox.addEventListener('change', function (){
      lsSet(LS_SR, srBox.checked ? '1' : '0');
      if (term) { try { term.options.screenReaderMode = srBox.checked; } catch (e) {} }
    });
    b.appendChild(srWrap);
    aiCfgModal.hidden = false; document.body.classList.add('rr-modal-open');
  }
  function closeAiCfgModal(){
    if (!aiCfgModal || aiCfgModal.hidden) return;
    aiCfgModal.hidden = true;
    if (!document.querySelector('.rr-modal:not([hidden])')) document.body.classList.remove('rr-modal-open');
  }
  window.RR_openAssistantSettings = openAiCfgModal;
  // multi-select checklist of catalogued papers (for Compare). → getter (array of ids)
  // opts.search: a search box above the list (title / venue / year / id, case-
  // insensitive substring). Filtering only hides rows — selections survive it.
  function paperChecklistInto(card, opts){
    opts = opts || {};
    var search = null;
    if (opts.search){
      search = el('input', 'rr-analyze-input rr-flow-search'); search.type = 'text'; search.autocomplete = 'off'; search.spellcheck = false;
      search.placeholder = 'Search your papers — title, venue, year or id'; search.setAttribute('aria-label', 'Search your papers');
      card.appendChild(search);
    }
    var wrap = el('div', 'rr-flow-list'); card.appendChild(wrap);
    var count = el('div', 'rr-flow-count', ''); card.appendChild(count);
    var selected = {}; (opts.preselect || []).forEach(function (id){ selected[id] = true; });
    var rows = [];                                   // { el, key } for the search filter
    var noMatch = el('div', 'rr-flow-empty', 'No matches'); noMatch.hidden = true;
    function get(){ return Object.keys(selected).filter(function (k){ return selected[k]; }); }
    function refresh(){ count.textContent = get().length + ' selected' + (opts.hint ? (' · ' + opts.hint) : ''); if (opts.onchange) opts.onchange(get()); }
    function applyFilter(){
      var q = search ? search.value.trim().toLowerCase() : '', shown = 0;
      rows.forEach(function (r){ var hit = !q || !!selected[r.id] || r.key.indexOf(q) !== -1; r.el.hidden = !hit; if (hit) shown++; });   // a ticked paper always stays visible
      noMatch.hidden = !(rows.length && !shown);
    }
    wrap.appendChild(el('div', 'rr-flow-empty', 'Loading your papers…'));
    reportsList().then(function (list){
      wrap.innerHTML = '';
      if (!list.length){ wrap.appendChild(el('div', 'rr-flow-empty', 'No papers yet — analyze one first.')); refresh(); return; }
      list.forEach(function (p){
        var rowLbl = el('label', 'rr-flow-row');
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!selected[p.id];
        cb.addEventListener('change', function (){ selected[p.id] = cb.checked; refresh(); });
        var txt = el('div', '');
        var t = el('div', 'rr-flow-ttl'); t.textContent = p.title; txt.appendChild(t);
        var meta = [p.venue, p.year].filter(Boolean).join(' · ');
        if (meta){ var mm = el('div', 'rr-flow-meta'); mm.textContent = meta; txt.appendChild(mm); }
        rowLbl.appendChild(cb); rowLbl.appendChild(txt); wrap.appendChild(rowLbl);
        rows.push({ el: rowLbl, id: p.id, key: [p.title, p.venue, p.year, p.id].filter(Boolean).join(' ').toLowerCase() });
      });
      wrap.appendChild(noMatch);
      applyFilter();
      refresh();
    });
    if (search) search.addEventListener('input', applyFilter);
    refresh();
    return get;
  }
  // single-select <select> of catalogued papers (for Deep dive / Discuss). → getter (id)
  function paperSelectInto(card, opts){
    opts = opts || {};
    var sel = el('select', 'rr-analyze-input rr-flow-select'); sel.appendChild(new Option('Loading…', ''));
    card.appendChild(sel);
    reportsList().then(function (list){
      sel.innerHTML = '';
      if (!list.length){ sel.appendChild(new Option('No papers yet — analyze one first', '')); sel.disabled = true; if (opts.onchange) opts.onchange(''); return; }
      list.forEach(function (p){ var meta = [p.venue, p.year].filter(Boolean).join(' · '); sel.appendChild(new Option(p.title + (meta ? ('  (' + meta + ')') : ''), p.id)); });
      if (opts.preselect && list.some(function (p){ return p.id === opts.preselect; })) sel.value = opts.preselect;
      if (opts.onchange) opts.onchange(sel.value);
    });
    sel.addEventListener('change', function (){ if (opts.onchange) opts.onchange(sel.value); });
    return function (){ return sel.value; };
  }

  /* ---- Analyze: /explain-paper <input> --approve → new report ---- */
  var analyzePrefill = '';                       // set by RR_openAnalyze (graph ghost nodes etc.)
  var analyzeQueue = null;                       // { list, idx, ai, opts, done } while a stack runs
  function openAnalyze(prefill){
    analyzePrefill = clean1(prefill || '');
    openFlow('Analyze a paper', renderAnalyzeForm);
  }
  // Upload a PDF from this machine into papers/ and analyze that path. Outside ML most
  // papers are a file on disk behind a paywall — and this window has no file browser.
  function uploadPdf(file){
    return fetch('/api/paper-upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
      .then(function (r){ return r.json().catch(function (){ return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (j){ if (!j || !j.ok) throw new Error((j && j.error) || 'upload failed'); return j; });
  }
  function analyzeFlags(opts){
    var f = '';
    if (!opts) return f;
    if (opts.depth) f += ' --depth ' + opts.depth;
    if (opts.audience) f += ' --audience ' + opts.audience;
    if (opts.focus) f += ' --focus "' + opts.focus.replace(/["\\]/g, '') + '"';
    return f;
  }
  function renderAnalyzeForm(card){
    heads(card, 'Analyze a paper', 'Add a paper to your library — I read it and write the report for you.');
    labelInto(card, 'Paper').setAttribute('for', 'rr-analyze-input');
    var row = el('div', 'rr-analyze-row');
    var input = el('input', 'rr-analyze-input'); input.id = 'rr-analyze-input';   // id: label pairing + stable hook
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'arXiv ID, URL, or path to a PDF   (e.g. 1706.03762)';
    var pick = el('button', 'rr-wm-btn rr-analyze-pick', ICO_PDF + '<span>Choose PDF…</span>'); pick.type = 'button';
    pick.title = 'Analyze a PDF from this computer';
    var file = el('input'); file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.multiple = true; file.hidden = true;
    row.appendChild(input); row.appendChild(pick); row.appendChild(file);
    card.appendChild(row);
    card.appendChild(el('div', 'rr-analyze-help', 'An arXiv id or URL, a direct PDF link, or a PDF from this computer — <b>drop one anywhere on this panel</b>. You can add flags by hand too, e.g. <code>2010.11929 --depth deep</code>.'));

    // the queue: everything added so far, analyzed one after another
    var items = [];                                // { value, label }
    var queueWrap = el('div', 'rr-queue'); queueWrap.hidden = true; card.appendChild(queueWrap);
    var upMsg = el('div', 'rr-analyze-help rr-queue-msg'); upMsg.hidden = true; card.appendChild(upMsg);
    function drawQueue(){
      queueWrap.innerHTML = '';
      queueWrap.hidden = !items.length;
      if (!items.length) return;
      var h = el('div', 'rr-queue-head'); h.textContent = items.length + ' paper' + (items.length === 1 ? '' : 's') + ' queued — they run one after another';
      queueWrap.appendChild(h);
      items.forEach(function (it, i){
        var chip = el('div', 'rr-queue-item');
        var t = el('span', 'rr-queue-ttl'); t.textContent = it.label; chip.appendChild(t);
        var x = el('button', 'rr-queue-x', ICO_X); x.type = 'button'; x.title = 'Remove from the queue';
        x.addEventListener('click', function (){ items.splice(i, 1); drawQueue(); refresh(); });
        chip.appendChild(x); queueWrap.appendChild(chip);
      });
    }
    function addItem(value, label){
      value = clean1(value); if (!value) return;
      if (items.some(function (x){ return x.value === value; })) return;
      items.push({ value: value, label: label || value });
      drawQueue(); refresh();
    }
    function takeInput(){ var v = input.value.trim(); if (v){ addItem(v, v); input.value = ''; } }

    var busy = 0;
    function uploadFiles(list){
      var pdfs = Array.prototype.filter.call(list || [], function (f){ return /\.pdf$/i.test(f.name || ''); });
      var skipped = (list ? list.length : 0) - pdfs.length;
      if (!pdfs.length){
        upMsg.hidden = false; upMsg.textContent = skipped ? 'Only PDF files can be analyzed from disk.' : '';
        return;
      }
      pdfs.forEach(function (f){
        busy++; refresh();
        upMsg.hidden = false; upMsg.textContent = 'Copying ' + f.name + ' into your library…';
        uploadPdf(f).then(function (j){
          busy--; addItem(j.path, f.name);
          upMsg.textContent = 'Added ' + j.path + (busy ? ' — still copying…' : '');
          refresh();
        }, function (e){
          busy--; upMsg.textContent = 'Couldn’t add ' + f.name + ' — ' + e.message; refresh();
        });
      });
    }
    pick.addEventListener('click', function (){ file.click(); });
    file.addEventListener('change', function (){ uploadFiles(file.files); file.value = ''; });
    // drag & drop onto the whole panel
    ['dragenter', 'dragover'].forEach(function (ev){
      card.addEventListener(ev, function (e){ e.preventDefault(); e.stopPropagation(); card.classList.add('rr-drop'); });
    });
    ['dragleave', 'drop'].forEach(function (ev){
      card.addEventListener(ev, function (e){ e.preventDefault(); e.stopPropagation(); if (ev === 'dragleave' && card.contains(e.relatedTarget)) return; card.classList.remove('rr-drop'); });
    });
    card.addEventListener('drop', function (e){ if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files); });

    // per-run options — the reader's profile defaults apply when these are left alone
    var opts = el('details', 'rr-opts');
    var sum = el('summary', 'rr-opts-sum', 'Options — depth, audience, a focus'); opts.appendChild(sum);
    var obody = el('div', 'rr-opts-body');
    function sel(label, name, choices){
      var w = el('label', 'rr-opt');
      w.appendChild(el('span', 'rr-opt-l', label));
      var s = el('select', 'rr-analyze-input rr-opt-s');
      choices.forEach(function (c){ s.appendChild(new Option(c[1], c[0])); });
      w.appendChild(s); obody.appendChild(w);
      return s;
    }
    var depth = sel('Depth', 'depth', [['', 'From your profile'], ['skim', 'Skim'], ['standard', 'Standard'], ['deep', 'Deep']]);
    var audience = sel('Audience', 'audience', [['', 'From your profile'], ['peer', 'Peer'], ['newcomer', 'Newcomer']]);
    var focusW = el('label', 'rr-opt rr-opt-wide');
    focusW.appendChild(el('span', 'rr-opt-l', 'Focus (optional)'));
    var focus = el('input', 'rr-analyze-input'); focus.type = 'text'; focus.placeholder = 'e.g. the stability proof';
    focusW.appendChild(focus); obody.appendChild(focusW);
    opts.appendChild(obody); card.appendChild(opts);

    var getAi = aiSelectorInto(card);
    var actions = el('div', 'rr-analyze-actions');
    var add = el('button', 'rr-wm-btn', ICO_DOC + '<span>Add another</span>'); add.type = 'button';
    add.title = 'Queue this one and type the next';
    var go = el('button', 'rr-wm-btn rr-wm-primary rr-analyze-go', ICO_DOC + '<span>Analyze</span>'); go.type = 'button'; go.disabled = true;
    actions.appendChild(add); actions.appendChild(go); card.appendChild(actions);
    card.appendChild(noteEl('Runs <code>/explain-paper … --approve</code> in a hidden assistant session. Generating a report needs internet and can take a few minutes; if the assistant asks for permission, use <b>Show terminal</b>.'));

    function count(){ return items.length + (input.value.trim() ? 1 : 0); }
    function refresh(){
      var n = count();
      go.disabled = !n || busy > 0;
      add.disabled = !input.value.trim();
      go.querySelector('span').textContent = n > 1 ? ('Analyze ' + n + ' papers') : 'Analyze';
    }
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', function (e){ if (e.key === 'Enter' && input.value.trim()){ e.preventDefault(); go.click(); } });
    add.addEventListener('click', function (){ takeInput(); input.focus(); });
    go.addEventListener('click', function (){
      takeInput();
      if (!items.length) return;
      var o = { depth: depth.value, audience: audience.value, focus: clean1(focus.value) };
      var list = items.slice();
      items = []; drawQueue(); refresh();
      if (list.length === 1) startAnalyze(list[0].value, getAi(), o);
      else startAnalyzeQueue(list, getAi(), o);
    });
    if (analyzePrefill){ input.value = analyzePrefill; analyzePrefill = ''; }   // e.g. a ghost node's id
    refresh();
    setTimeout(function (){ input.focus(); }, 40);
  }
  // one paper at a time: the server registers a single run (its rollback is scoped to
  // one artifact), so the queue starts the next only once this one has landed
  function startAnalyzeQueue(list, ai, opts){
    analyzeQueue = { list: list, idx: 0, ai: ai, opts: opts, done: [] };
    queueNext();
  }
  function queueNext(){
    var q = analyzeQueue;
    if (!q) return;
    if (q.idx >= q.list.length){ analyzeQueue = null; showQueueDone(q); return; }
    startAnalyze(q.list[q.idx].value, q.ai, q.opts, q);
  }
  function showQueueDone(q){
    var n = q.done.length;
    if (!(flowOv && flowOv.classList.contains('rr-show'))){
      toast(n === 1 ? ('Report ready — ' + q.done[0]) : (n + ' reports ready'), 'Open library', function (){ location.href = '/library.html'; });
      return;
    }
    var card = flowOv._card; card.innerHTML = '';
    flowOv._title.textContent = 'Analyze papers'; flowOv._showTerm.hidden = false;
    var done = el('div', 'rr-analyze-run');
    done.appendChild(el('div', 'rr-analyze-check', '✓'));
    var st = el('div', 'rr-analyze-status'); st.textContent = 'Added ' + n + ' paper' + (n === 1 ? '' : 's') + ' to your library.'; done.appendChild(st);
    var list = el('div', 'rr-queue');
    q.done.forEach(function (id){
      var a = el('a', 'rr-queue-item rr-queue-link'); a.href = '/papers/' + encodeURIComponent(id) + '/';
      a.appendChild(el('span', 'rr-queue-ttl', esc(id)));
      list.appendChild(a);
    });
    done.appendChild(list);
    var actions = el('div', 'rr-analyze-actions rr-analyze-actions--center');
    var lib = el('button', 'rr-wm-btn rr-wm-primary', ICO_DOC + '<span>Open library</span>'); lib.type = 'button';
    lib.addEventListener('click', function (){ location.href = '/library.html'; });
    var again = el('button', 'rr-wm-btn', ICO_DOC + '<span>Analyze more</span>'); again.type = 'button';
    again.addEventListener('click', function (){ openAnalyze(); });
    actions.appendChild(lib); actions.appendChild(again);
    done.appendChild(actions); card.appendChild(done);
    flowOv._status = null;
  }
  function startAnalyze(input, ai, opts, q){
    input = clean1(input); if (!input) return;
    // an arXiv id already in the library? then /explain-paper REWRITES that report:
    // the server keeps the old digest for a Stop, and "done" is a report-changed for it
    var mid = input.match(/(\d{4}\.\d{4,5})(?:v\d+)?/);
    reportsList().then(function (list){
      var known = (mid && list.some(function (p){ return p.id === mid[1]; })) ? mid[1] : null;
      startAnalyzeJob(input, ai, known, opts, q);
    }, function (){ startAnalyzeJob(input, ai, null, opts, q); });
  }
  function startAnalyzeJob(input, ai, known, opts, q){
    // flags the reader typed by hand win — never pass --depth twice
    var extra = analyzeFlags({
      depth: /--depth\b/.test(input) ? '' : (opts && opts.depth),
      audience: /--audience\b/.test(input) ? '' : (opts && opts.audience),
      focus: /--focus\b/.test(input) ? '' : (opts && opts.focus),
    });
    var pos = q ? ('Paper ' + (q.idx + 1) + ' of ' + q.list.length + ': ') : '';
    runJob({
      kind: 'analyze', id: known || undefined, ai: ai, title: q ? 'Analyze papers' : 'Analyze a paper',
      cmd: '/explain-paper ' + input + extra + ' --approve',
      working: pos + (known ? 'Re-analyzing “' : 'Analyzing “') + input + '” — this can take a few minutes.',
      building: pos + 'Writing the report page …',
      watch: function (m){
        if (m.type === 'report-added') return m.id;
        if (known && m.type === 'report-changed' && m.id === known) return known;
        return null;
      },
      verify: function (id){ return headOk('/papers/' + encodeURIComponent(id) + '/index.html'); },
      openUrl: function (id){ return '/papers/' + encodeURIComponent(id) + '/'; }, openLabel: 'Open report',
      doneText: function (id){ return 'Added ' + id + ' to your library.'; }, doneToast: function (id){ return 'Report ready — ' + id; },
      // a queue keeps going instead of showing the single-paper done card
      onDone: q ? function (id){ q.done.push(id); q.idx++; setTimeout(queueNext, 600); return true; } : null,
      onStopped: q ? function (){ analyzeQueue = null; } : null,
      again: function (){ openAnalyze(); }, againLabel: 'Analyze another',   // wrapped: a raw handler would pass the click event as prefill
    });
  }

  /* ---- Compare: /compare <id> <id> [<id>] [--focus "…"] --approve → new comparison ---- */
  function openCompare(){ openFlow('Compare papers', renderCompareForm); }
  function renderCompareForm(card){
    heads(card, 'Compare papers', 'Pick 2 or 3 papers already in your library for a side-by-side breakdown.');
    var actions = el('div', 'rr-analyze-actions'); var go = el('button', 'rr-wm-btn rr-wm-primary', ICO_CMP + '<span>Compare</span>'); go.type = 'button'; go.disabled = true; actions.appendChild(go);
    // use the ids the checklist passes (it fires onchange synchronously during build,
    // before `getSel` is assigned — so don't call getSel() from here at construction).
    function refresh(ids){ var n = (ids || (getSel ? getSel() : [])).length; go.disabled = !(n >= 2 && n <= 3); }
    var getSel = paperChecklistInto(card, { preselect: REPORT_ID ? [REPORT_ID] : [], hint: 'pick 2–3', onchange: refresh, search: true });
    // an optional question the comparison is organised around (→ /compare --focus "…")
    labelInto(card, 'Question or topic (optional)').classList.add('rr-analyze-label--gap');
    var focus = el('input', 'rr-analyze-input'); focus.type = 'text'; focus.autocomplete = 'off';
    focus.placeholder = 'what to compare them on — e.g. which handles long sequences better, and at what cost?'; card.appendChild(focus);
    var getAi = aiSelectorInto(card);
    card.appendChild(actions);
    card.appendChild(noteEl('Runs <code>/compare … --approve</code> in a hidden assistant session. Compares analyzed papers only; a question makes the framing, dimensions and verdict answer it.'));
    go.addEventListener('click', function (){ var ids = getSel(); if (ids.length >= 2 && ids.length <= 3) startCompare(ids, focus.value, getAi()); });
    focus.addEventListener('keydown', function (e){ if (e.key === 'Enter' && !go.disabled){ e.preventDefault(); go.click(); } });
    refresh();
  }
  function startCompare(ids, focus, ai){
    // single line, and no double quotes inside the quoted --focus value
    focus = clean1(focus).replace(/"/g, "'");
    var cmd = '/compare ' + ids.join(' ') + (focus ? (' --focus "' + focus + '"') : '') + ' --approve';
    runJob({
      kind: 'compare', ai: ai, title: 'Compare papers', cmd: cmd,
      working: 'Building the comparison — a few minutes.',
      building: 'Writing the comparison page …',
      watch: function (m){ return m.type === 'compare-added' ? m.slug : null; },
      verify: function (slug){ return headOk('/compare/' + encodeURIComponent(slug) + '/index.html'); },
      openUrl: function (slug){ return '/compare/' + encodeURIComponent(slug) + '/'; }, openLabel: 'Open comparison',
      doneText: function (){ return 'Comparison ready.'; }, doneToast: function (){ return 'Comparison ready'; },
      again: openCompare, againLabel: 'Compare more',
    });
  }

  /* ---- Deep dive: /deep-dive <id> <topic> [--into <key> | --append] --approve ---- */
  // Modifies an existing digest (append to deepdives, or merge into a section), so
  // "done" is a content diff (not a new file): watch report-changed, then poll the
  // digest until deepdives grew / the target section changed.
  function openDeepDive(){ openFlow('Deep dive', renderDeepDiveForm); }
  function renderDeepDiveForm(card){
    heads(card, 'Deep dive', 'Author a worked derivation, proof, or mechanism trace and add it to a report.');
    var curId = '', curDigest = null;
    labelInto(card, 'Paper');
    paperSelectInto(card, { preselect: REPORT_ID || '', onchange: function (id){ curId = id; loadSections(id); } });
    labelInto(card, 'Topic');
    var topic = el('input', 'rr-analyze-input'); topic.type = 'text'; topic.autocomplete = 'off';
    topic.placeholder = 'what to go deep on — e.g. derive the attention gradient step by step'; card.appendChild(topic);
    // placement: new tab (append) vs merge into a section
    var place = el('div', 'rr-flow-place');
    var r1l = el('label'); var r1 = el('input'); r1.type = 'radio'; r1.name = 'rr-dd-place'; r1.checked = true; r1l.appendChild(r1); r1l.appendChild(document.createTextNode(' New Deep dive tab'));
    var r2l = el('label'); var r2 = el('input'); r2.type = 'radio'; r2.name = 'rr-dd-place'; r2l.appendChild(r2); r2l.appendChild(document.createTextNode(' Merge into section '));
    var sectionSel = el('select', 'rr-analyze-input rr-flow-select'); sectionSel.disabled = true; r2l.appendChild(sectionSel);
    place.appendChild(r1l); place.appendChild(r2l); card.appendChild(place);
    function syncPlace(){ sectionSel.disabled = !r2.checked; }
    r1.addEventListener('change', syncPlace); r2.addEventListener('change', syncPlace);
    var getAi = aiSelectorInto(card);
    var actions = el('div', 'rr-analyze-actions'); var go = el('button', 'rr-wm-btn rr-wm-primary', ICO_DIVE + '<span>Go deep</span>'); go.type = 'button'; go.disabled = true; actions.appendChild(go); card.appendChild(actions);
    card.appendChild(noteEl('Runs <code>/deep-dive … --approve</code> in a hidden assistant session on an <b>already-catalogued</b> paper. A few minutes; if it asks for permission, use <b>Show terminal</b>.'));
    function loadSections(id){
      sectionSel.innerHTML = ''; curDigest = null;
      if (!id) { refresh(); return; }
      fetch('/api/digest?id=' + encodeURIComponent(id)).then(function (r){ return r.json(); }).then(function (j){
        if (!j || !j.ok || !j.digest) return;
        curDigest = j.digest;
        var secs = j.digest.sections || {};
        Object.keys(secs).forEach(function (k){ sectionSel.appendChild(new Option((secs[k] && secs[k].title) || k, k)); });
        refresh();
      }).catch(function (){});
    }
    function refresh(){ go.disabled = !(curId && topic.value.trim()); }
    topic.addEventListener('input', refresh);
    go.addEventListener('click', function (){
      var id = curId, t = topic.value; if (!id || !t.trim()) return;
      var mode = r2.checked ? 'into' : 'append';
      var key = sectionSel.value;
      if (mode === 'into' && !key) return;
      var before = mode === 'into'
        ? { html: (curDigest && curDigest.sections && curDigest.sections[key] && curDigest.sections[key].html) || '' }
        : { count: (curDigest && curDigest.deepdives ? curDigest.deepdives.length : 0) };
      startDeepDive(id, t, mode, key, before, getAi());
    });
    refresh();
  }
  function startDeepDive(id, topic, mode, key, before, ai){
    topic = clean1(topic);
    var cmd = '/deep-dive ' + id + ' ' + topic + (mode === 'into' ? (' --into ' + key) : ' --append') + ' --approve';
    runJob({
      kind: 'deepdive', id: id, ai: ai, title: 'Deep dive', cmd: cmd,
      working: 'Working through “' + topic + '” — a few minutes.',
      building: 'Adding it to the report …',
      watch: function (m){ return (m.type === 'report-changed' && m.id === id) ? id : null; },
      verify: function (){ return fetch('/api/digest?id=' + encodeURIComponent(id)).then(function (r){ return r.json(); }).then(function (j){
        if (!j || !j.ok || !j.digest) return false;
        var d = j.digest;
        if (mode === 'into'){ var h = (d.sections && d.sections[key] && d.sections[key].html) || ''; return h !== before.html; }
        return (d.deepdives ? d.deepdives.length : 0) > before.count;
      }).catch(function (){ return false; }); },
      openUrl: function (){ return '/papers/' + encodeURIComponent(id) + '/'; }, openLabel: 'Open report',
      doneText: function (){ return 'Deep dive added to ' + id + '.'; }, doneToast: function (){ return 'Deep dive ready — ' + id; },
      again: openDeepDive, againLabel: 'Another deep dive',
    });
  }

  /* ---- Discuss: /learn <id> [topic] --approve → VISIBLE terminal (a conversation) ---- */
  var discussPrefill = '';                       // set by RR_openDiscuss (graph / report shortcuts)
  function openDiscuss(prefillId){
    discussPrefill = clean1(prefillId || '');
    openFlow('Discuss a paper', renderDiscussForm);
  }
  function renderDiscussForm(card){
    heads(card, 'Discuss a paper', 'Have a live back-and-forth about a paper. It opens in the terminal; when you’re done, hit End chat to save it as a Discussion.');
    labelInto(card, 'Paper');
    var getPaper = paperSelectInto(card, { preselect: discussPrefill || REPORT_ID || '' });
    discussPrefill = '';
    labelInto(card, 'Opening question (optional)');
    var topic = el('input', 'rr-analyze-input'); topic.type = 'text'; topic.autocomplete = 'off';
    topic.placeholder = 'where to start — e.g. why does this beat RNNs on long sequences?'; card.appendChild(topic);
    var getAi = aiSelectorInto(card);
    var actions = el('div', 'rr-analyze-actions'); var go = el('button', 'rr-wm-btn rr-wm-primary', ICO_LEARN + '<span>Start discussion</span>'); go.type = 'button'; actions.appendChild(go); card.appendChild(actions);
    card.appendChild(noteEl('Opens <code>/learn</code> in the terminal (this one you talk to). Type your questions; <b>End chat</b> compacts it into a saved Discussion.'));
    go.addEventListener('click', function (){ var id = getPaper(); if (id) startDiscuss(id, topic.value, getAi()); });
  }
  function startDiscuss(id, topic, ai){
    topic = clean1(topic);
    var cmd = '/learn ' + id + (topic ? (' ' + topic) : '') + ' --approve';
    closeFlow();
    if (job) stopJob('user');                                   // one shared pty: a hidden run can't survive the respawn
    discuss = { id: id, started: false };
    // visible (not headless): openDrawer, launch the assistant, send /learn after boot
    launchAgent(ai, { then: function (){ activeArm = armSend(flowCommand(ai, cmd), function (){
      if (!discuss || discuss.id !== id) return;
      discuss.started = true; markAiSeen(ai);
      send({ type: 'job-start', kind: 'discuss', id: id });    // server: snapshot chats/ for a rollback
      setHint('discussion started — ask away, then End chat to save');
    }); } });
    // AFTER launchAgent (it hides End chat for a plain launch): a /learn discussion is now running
    endChatBtn.hidden = false; stopChatBtn.hidden = false;
    setHint('discussing — ask questions, then End chat to save');
  }
  // the running discussion was compacted (chat-added): the server can drop its snapshot
  function discussSaved(){
    if (discuss && discuss.started) send({ type: 'job-end', token: discuss.token });
    discuss = null; endChatBtn.hidden = true; stopChatBtn.hidden = true;
    setHint('discussion saved');
  }
  // the discussion's assistant is gone (pty exit, or quit in the terminal) before End chat
  function discussOnExit(text){
    if (!discuss) return;
    var d = discuss; discuss = null;
    if (activeArm){ activeArm.cancel(); activeArm = null; }
    afterFlush = null;
    endChatBtn.hidden = true; stopChatBtn.hidden = true;
    if (d.started) withToken(d, function (token){ send({ type: 'job-stop', reason: 'exited', token: token }); });   // roll back a half-written chat
    setHint('discussion ended without saving');
    toast(text || 'The discussion ended before it was saved — nothing was added to your library.');
  }
  // Stop discussion: abandon it — the server kills the assistant and rolls back (nothing saved)
  function stopDiscussion(){
    if (!discuss){ stopChatBtn.hidden = true; return; }
    var d = discuss; discuss = null;
    if (activeArm){ activeArm.cancel(); activeArm = null; }
    afterFlush = null;
    endChatBtn.hidden = true; stopChatBtn.hidden = true;
    // started → prove ownership with the token (rollback of the half-written chat);
    // not started → no token: the server just kills the booting assistant
    if (d.started) withToken(d, function (token){ send({ type: 'job-stop', reason: 'user', token: token }); });
    else send({ type: 'job-stop', reason: 'user' });
    setHint('discussion stopped — nothing was saved'); keepHintUntil = Date.now() + 5000;   // the pty exit that follows must not overwrite it
    toast('Discussion stopped — nothing was saved.');
  }
  stopChatBtn.addEventListener('click', stopDiscussion);

  function noteEl(html){ var n = el('div', 'rr-analyze-note'); n.innerHTML = html; return n; }

  document.addEventListener('keydown', function (e){ if (e.key === 'Escape' && flowOv && flowOv.classList.contains('rr-show')) closeFlow(); });

  /* ================================ Updates =================================
     git-based, no API: the server fetches origin and reports what's new; applying
     is a fast-forward pull (+ npm install when the app's own dependencies changed)
     + rebuild, streamed as update-progress broadcasts, then a restart (exit 75 →
     the launcher relaunches the server) when files under workmode/ changed. The
     modal reuses the account modals' classes (.rr-modal …, base.css) so it looks
     like Profile / Setup / Back up. The reader's data is never touched.
     ========================================================================== */
  var updModal = null, updState = 'idle', updInfo = null, updProg = null, updResult = null, updFail = null, updPoll = null;
  var UPD_STEPS = [['pull', 'Downloading the update'], ['install', 'Installing dependencies'], ['build', 'Rebuilding the site']];
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function updCanClose(){ return updState !== 'applying' && updState !== 'restarting'; }
  function buildUpdModal(){
    if (updModal) return updModal;
    updModal = el('div', 'rr-modal rr-upd-modal'); updModal.id = 'rr-update-modal'; updModal.hidden = true;
    var bd = el('div', 'rr-modal-backdrop');
    var card = el('div', 'rr-modal-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'rr-upd-title');
    var head = el('div', 'rr-modal-head');
    var h = el('h2', 'rr-modal-title'); h.id = 'rr-upd-title'; h.textContent = 'Updates';
    var x = el('button', 'rr-modal-x', '&#10005;'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    head.appendChild(h); head.appendChild(x);
    var body = el('div', 'rr-modal-body rr-upd-body');
    var foot = el('div', 'rr-modal-foot');
    card.appendChild(head); card.appendChild(body); card.appendChild(foot);
    updModal.appendChild(bd); updModal.appendChild(card);
    document.body.appendChild(updModal);
    bd.addEventListener('click', closeUpd);
    x.addEventListener('click', closeUpd);
    updModal._title = h; updModal._body = body; updModal._foot = foot; updModal._x = x;
    return updModal;
  }
  function openUpd(){
    buildUpdModal();
    updModal.hidden = false;
    document.body.classList.add('rr-modal-open');
    var f = updModal.querySelector('.rr-btn-go, .rr-btn') || updModal._x; if (f) f.focus();
  }
  function closeUpd(){
    if (!updModal || updModal.hidden || !updCanClose()) return;
    updModal.hidden = true;
    if (!document.querySelector('.rr-modal:not([hidden])')) document.body.classList.remove('rr-modal-open');
    if (updState !== 'installed') updState = 'idle';    // an installed-but-not-restarted update keeps its state
  }
  // Esc: the account block closes ANY open .rr-modal — take ours first (capture) so a
  // running update can't be dismissed mid-pull and its state stays consistent
  document.addEventListener('keydown', function (e){
    if (e.key !== 'Escape' || !updModal || updModal.hidden) return;
    e.stopPropagation(); closeUpd();
  }, true);

  function updRender(){
    var M = buildUpdModal(), b = M._body, f = M._foot, r = updInfo || {};
    b.innerHTML = ''; f.innerHTML = '';
    M._x.hidden = !updCanClose();
    function btn(label, cls, fn){ var x = el('button', 'rr-btn' + (cls ? ' ' + cls : '')); x.type = 'button'; x.textContent = label; if (fn) x.addEventListener('click', fn); f.appendChild(x); return x; }
    function p(html, cls){ var d = el('div', 'rr-upd-p' + (cls ? ' ' + cls : '')); d.innerHTML = html; b.appendChild(d); return d; }
    var have = r.local && r.local.version, want = r.remote && r.remote.version;
    if (updState === 'checking'){
      M._title.textContent = 'Updates';
      p('<span class="rr-analyze-spinner rr-upd-spin"></span> Checking for updates…', 'rr-muted rr-upd-row');
      btn('Close', 'rr-btn-ghost', closeUpd);
    }
    else if (updState === 'available'){
      M._title.textContent = 'Update available';
      var n = r.behind || (r.changes ? r.changes.length : 0);
      p((want && want !== have) ? ('<b>Reading Room ' + esc(want) + '</b> is available — you have ' + (have ? esc(have) : 'an older version') + '.')
             : ('<b>' + n + ' new change' + (n === 1 ? '' : 's') + '</b> ' + (n === 1 ? 'is' : 'are') + ' available.'));
      if (r.changes && r.changes.length){
        var ul = el('ul', 'rr-upd-list');
        r.changes.forEach(function (c){ var li = el('li'); li.innerHTML = (c.sha ? '<code>' + esc(c.sha) + '</code> ' : '') + esc(c.subject); ul.appendChild(li); });
        b.appendChild(ul);
        if (r.behind > r.changes.length) p('… and ' + (r.behind - r.changes.length) + ' more.', 'rr-muted');
      }
      if (r.upgradingChanged) p('This update comes with maintainer notes (<code>UPGRADING.md</code>). After installing, run <code>/update</code> with your assistant if anything needs migrating.', 'rr-upd-note');
      if (r.git && r.ahead) p('Your copy has ' + r.ahead + ' local change' + (r.ahead === 1 ? '' : 's') + ' not on the update server. Updating only fast-forwards, so it may need the assistant.', 'rr-upd-note');
      if (job || discuss || stopping) p('A run is in progress — updating restarts the assistant, so let it finish (or stop it) first.', 'rr-upd-note');
      p((r.method === 'zip' ? 'This copy was downloaded as a ZIP: the update downloads the new version and replaces the app’s own files in place. ' : '') + 'Your library, notes and settings are never touched by an update.', 'rr-muted');
      // Skip this version: never again for THIS version (a newer one is offered again);
      // Later: not until the app is launched again
      btn('Skip this version', 'rr-btn-ghost', function (){ lsSet('rr-update-skipped', updId(r)); closeUpd(); toast('Skipped ' + (want || 'this version') + ' — you’ll hear about the next one'); });
      btn('Later', 'rr-btn-ghost', function (){ lsSet('rr-update-later', JSON.stringify({ id: updId(r), startedAt: serverStartedAt || '' })); closeUpd(); });
      btn('Update now', 'rr-btn-go', updApply);
    }
    else if (updState === 'uptodate'){
      M._title.textContent = 'Updates';
      p('You’re up to date' + (have ? ' (' + esc(have) + ')' : '') + '.');
      if (r.checked) p('Last checked ' + esc(new Date(r.checked).toLocaleString()) + '.', 'rr-muted');
      btn('Close', 'rr-btn-ghost', closeUpd);
      btn('Check again', '', function (){ window.RR_openUpdates(true); });
    }
    else if (updState === 'unavailable'){
      M._title.textContent = 'Updates';
      p(esc(r.error || 'Updates aren’t available for this copy of Reading Room.'));
      if (have) p('You have ' + esc(have) + '.', 'rr-muted');
      btn('Close', 'rr-btn-ghost', closeUpd);
      btn('Check again', '', function (){ window.RR_openUpdates(true); });
    }
    else if (updState === 'applying'){
      M._title.textContent = 'Updating…';
      var ol = el('ol', 'rr-upd-steps'), pr = updProg || {};
      UPD_STEPS.forEach(function (s){
        var li = el('li'); var st = pr.done[s[0]] ? 'done' : (pr.step === s[0] ? 'active' : 'todo');
        li.className = 'rr-upd-step rr-upd-step--' + st;
        li.innerHTML = '<span class="rr-upd-mark">' + (st === 'done' ? '✓' : (st === 'active' ? '<span class="rr-analyze-spinner rr-upd-spin"></span>' : '·')) + '</span> ' + esc(s[1])
          + (st === 'active' && pr.msg ? ' <span class="rr-muted">— ' + esc(pr.msg) + '</span>' : '');
        ol.appendChild(li);
      });
      b.appendChild(ol);
      p('Keep this window open — it only takes a moment.', 'rr-muted');
    }
    else if (updState === 'installed'){
      M._title.textContent = 'Update installed';
      var res = updResult || {};
      var ver = res.to ? (' (' + esc(res.from || '') + ' → ' + esc(res.to) + ')') : '';
      if (res.restartNeeded && res.restartable === false){
        p('<b>Installed' + ver + '.</b> This server wasn’t started by the Reading Room launcher, so it can’t restart itself: stop it (Ctrl-C in its terminal) and start it again to finish.');
        if (res.upgradingChanged) p('This update comes with maintainer notes — after restarting, run <code>/update</code> with your assistant to complete any migration.', 'rr-upd-note');
        btn('Close', 'rr-btn-ghost', closeUpd);
      } else if (res.restartNeeded){
        p('<b>Installed' + ver + '.</b> Restart Reading Room to finish.');
        if (res.upgradingChanged) p('This update comes with maintainer notes — after restarting, run <code>/update</code> with your assistant to complete any migration.', 'rr-upd-note');
        btn('Later', 'rr-btn-ghost', closeUpd);
        btn('Restart now', 'rr-btn-go', updRestart);
      } else {
        p('<b>Installed' + ver + '.</b> Reload to see the changes.');
        if (res.upgradingChanged) p('This update comes with maintainer notes — run <code>/update</code> with your assistant to complete any migration.', 'rr-upd-note');
        btn('Later', 'rr-btn-ghost', closeUpd);
        btn('Reload', 'rr-btn-go', function (){ location.reload(); });
      }
      if (res.upgradingChanged) btn('Let the assistant finish', 'rr-btn-ghost', updViaAssistant);
    }
    else if (updState === 'restarting'){
      M._title.textContent = 'Restarting…';
      p('<span class="rr-analyze-spinner rr-upd-spin"></span> Restarting Reading Room — this page reloads by itself when it’s back.', 'rr-upd-row');
    }
    else if (updState === 'restart-timeout'){
      M._title.textContent = 'Restarting…';
      p('Reading Room hasn’t come back yet. Close and reopen the app (double-click it again), then reload this page.');
      btn('Close', 'rr-btn-ghost', closeUpd);
      btn('Reload', '', function (){ location.reload(); });
    }
    else if (updState === 'failed'){
      M._title.textContent = 'Update not applied';
      var fl = updFail || {};
      p('The update could not be applied' + (fl.stage ? ' (' + esc(fl.stage) + ' step)' : '') + '. Nothing in your library was changed.');
      if (fl.error) { var pre = el('pre', 'rr-upd-err'); pre.textContent = fl.error; b.appendChild(pre); }
      p('Your assistant can sort it out: it runs <code>/update</code> in the terminal, keeps your data, and takes the new code for everything else.', 'rr-muted');
      btn('Close', 'rr-btn-ghost', closeUpd);
      if (fl.needsAssistant !== false) btn('Let the assistant do it', 'rr-btn-go', updViaAssistant);
    }
  }
  function updApply(){
    if (updState === 'applying') return;
    updState = 'applying'; updProg = { step: null, msg: 'Starting…', done: {} }; updRender();
    fetch('/api/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r){ return r.json(); })
      .then(function (j){
        if (updState !== 'applying') return;
        if (!j || !j.ok){ updFail = { error: (j && j.error) || 'The update could not be applied.', stage: j && j.stage, needsAssistant: !j || j.needsAssistant !== false }; updState = 'failed'; }
        else { updResult = j; updState = 'installed'; UPD_STEPS.forEach(function (s){ updProg.done[s[0]] = true; }); }
        updRender(); openUpd();                      // re-show in case Esc hid it meanwhile
      })
      .catch(function (e){ if (updState !== 'applying') return; updFail = { error: 'Could not reach the app: ' + e.message, needsAssistant: true }; updState = 'failed'; updRender(); openUpd(); });
  }
  // update-progress broadcast: {step:'pull'|'install'|'build', msg}
  function updProgress(m){
    if (updState === 'applying' && updProg){
      var seen = false;
      UPD_STEPS.forEach(function (s){ if (s[0] === m.step) seen = true; else if (!seen) updProg.done[s[0]] = true; });
      updProg.step = m.step; updProg.msg = m.msg || '';
      updRender();
    } else setHint('updating — ' + (m.msg || m.step || ''));   // another page started it
  }
  function updRestart(){
    if (job || discuss || stopping){
      // a run is in progress: stop it properly first (kill + rollback), then restart
      abandonRuns();
      var tries = 0, iv = setInterval(function (){ if ((!job && !discuss && !stopping) || ++tries > 60){ clearInterval(iv); updRestart(); } }, 250);
      toast('Stopping the running assistant before restarting…');
      return;
    }
    updState = 'restarting'; updRender(); openUpd();
    // know the CURRENT startedAt before asking, so a null baseline can't trigger an instant reload
    var base = serverStartedAt ? Promise.resolve(serverStartedAt)
      : fetch('/api/status', { cache: 'no-store' }).then(function (r){ return r.json(); }).then(function (s){ return (s && s.startedAt) || null; }).catch(function (){ return null; });
    base.then(function (before){
      serverStartedAt = before;
      fetch('/api/update/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function (){});
      updWaitForRestart(before);
    });
  }
  // poll /api/status until a NEW server (different startedAt) answers, then reload
  function updWaitForRestart(before){
    if (updPoll) clearInterval(updPoll);
    var tries = 0;
    updPoll = setInterval(function (){
      tries++;
      fetch('/api/status', { cache: 'no-store' }).then(function (r){ return r.json(); }).then(function (s){
        if (s && s.startedAt && s.startedAt !== before){ clearInterval(updPoll); updPoll = null; location.reload(); }
      }).catch(function (){});
      if (tries >= 90 && updPoll){ clearInterval(updPoll); updPoll = null; updState = 'restart-timeout'; updRender(); openUpd(); }
    }, 1000);
  }
  // 'restarting' broadcast — the server is about to exit(75) (this page or another asked)
  function updRestarting(){
    if (updState === 'restarting') return;
    setHint('Reading Room is restarting…');
    toast('Reading Room is restarting — this page reloads when it’s back');
    updWaitForRestart(serverStartedAt);
  }
  // hand the update to the reader's assistant: visible terminal, `/update` armed like Discuss
  function updViaAssistant(){
    updState = 'idle'; closeUpd();
    var ai = chosenAi();
    setHint('launching ' + ai + ' to run /update …');
    abandonRuns();                                   // a hidden run or discussion can't survive the respawn
    launchAgent(ai, { then: function (){ activeArm = armSend(flowCommand(ai, '/update'), function (){ setHint('/update is running — follow along here'); }); } });
  }
  // avatar menu "Updates" (force → refresh=1 re-fetches origin)
  window.RR_openUpdates = function (force){
    if (!updCanClose()){ openUpd(); return; }       // an update is running: just show it
    if (updState === 'installed'){ updRender(); openUpd(); return; }
    updState = 'checking'; updRender(); openUpd();
    fetch('/api/update' + (force ? '?refresh=1' : ''), { cache: 'no-store' }).then(function (r){ return r.json(); }).then(function (r){
      updInfo = r || {};
      if (updState !== 'checking') return;          // closed meanwhile
      if (r && r.ok && r.available) updState = 'available';
      else if (r && r.ok && !r.error) updState = 'uptodate';
      else updState = 'unavailable';
      updRender();
    }).catch(function (e){
      updInfo = { error: 'Could not check for updates: ' + e.message };
      if (updState === 'checking'){ updState = 'unavailable'; updRender(); }
    });
  };
  // On load: if an update is available (and not skipped, and this isn't the first run,
  // and no modal is open, and nothing is running) offer it once per tab session.
  // what identifies "this update" for the dismiss buttons: the published version (ZIP
  // copies, and git copies once VERSION is bumped) — else the remote commit
  function updId(r){
    if (!r || !r.remote) return '';
    var v = r.remote.version, have = r.local && r.local.version;
    if (r.method === 'git' && (!v || v === have)) return r.remote.commit || '';   // commits without a version bump
    return v || r.remote.commit || '';
  }
  function updAutoCheck(){
    Promise.all([
      fetch('/api/update').then(function (r){ return r.json(); }).catch(function (){ return null; }),
      aiStatus(),
    ]).then(function (res){
      var r = res[0], s = res[1];
      if (!r || !r.ok || !r.available) return;
      var id = updId(r); if (!id) return;
      if (lsGet('rr-update-skipped', '') === id) return;                 // "Skip this version"
      var later = null; try { later = JSON.parse(lsGet('rr-update-later', '') || 'null'); } catch (e) {}
      if (later && later.id === id && s && s.startedAt && later.startedAt === s.startedAt) return;   // "Later": until the next launch
      if (lsGet('rr-tutorial-seen@wm:' + WM.root, '') !== '1') return;   // first run: tutorial + Setup come first
      var shown = ''; try { shown = sessionStorage.getItem('rr-update-shown') || ''; } catch (e) {}
      if (shown === id) return;                                           // already offered in this tab session
      setTimeout(function (){
        if (document.querySelector('.rr-modal:not([hidden])')) return;
        if (job || discuss || stopping || updState !== 'idle') return;
        try { sessionStorage.setItem('rr-update-shown', id); } catch (e) {}
        updInfo = r; updState = 'available'; updRender(); openUpd();
      }, 1200);
    }).catch(function (){});
  }

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
  aiStatus().then(function (s){
    if (!s) return;
    if (s.startedAt) serverStartedAt = s.startedAt;   // baseline for restart detection
    if (s.pythonOk === false) toast('Python 3 was not found — install it (python.org; macOS: xcode-select --install), then reopen Reading Room. Nothing can be built until then.');
    if (s.job && s.job.token) adoptJob(s.job);         // a run started from another page is still going
    if (s.restartPending && !s.job){                   // "Later" on an installed update — remind until restarted (not mid-run)
      if (s.restartable) toast('An update is installed — restart Reading Room to finish', 'Restart now', updRestart);
      else toast('An update is installed — stop the server (Ctrl-C) and start it again to finish');
    }
  });
  // A hidden run registered by a previous page (the reader navigated mid-run): keep
  // owning it here — completion still toasts "Open", the flow buttons show its card
  // with Stop instead of silently starting a second run over it.
  function adoptJob(sj){
    if (job || discuss || stopping) return;
    var id = sj.id || '';
    if (sj.kind === 'discuss'){
      discuss = { id: id, started: true, token: sj.token };
      endChatBtn.hidden = false; stopChatBtn.hidden = false;
      setHint('a discussion is running — End chat saves it, Stop discussion discards it');
      return;
    }
    var spec = null;
    if (sj.kind === 'analyze') spec = {
      kind: 'analyze', id: id || undefined, title: 'Analyze a paper', cmd: '',
      working: 'A paper analysis started from another page is still running.', building: 'Writing the report page …',
      watch: function (m){ if (m.type === 'report-added') return m.id; if (id && m.type === 'report-changed' && m.id === id) return id; return null; },
      verify: function (rid){ return headOk('/papers/' + encodeURIComponent(rid) + '/index.html'); },
      openUrl: function (rid){ return '/papers/' + encodeURIComponent(rid) + '/'; }, openLabel: 'Open report',
      doneText: function (rid){ return 'Added ' + rid + ' to your library.'; }, doneToast: function (rid){ return 'Report ready — ' + rid; },
      again: function (){ openAnalyze(); }, againLabel: 'Analyze another' };
    else if (sj.kind === 'compare') spec = {
      kind: 'compare', title: 'Compare papers', cmd: '',
      working: 'A comparison started from another page is still being written.', building: 'Writing the comparison page …',
      watch: function (m){ return m.type === 'compare-added' ? m.slug : null; },
      verify: function (slug){ return headOk('/compare/' + encodeURIComponent(slug) + '/index.html'); },
      openUrl: function (slug){ return '/compare/' + encodeURIComponent(slug) + '/'; }, openLabel: 'Open comparison',
      doneText: function (){ return 'Comparison ready.'; }, doneToast: function (){ return 'Comparison ready'; },
      again: openCompare, againLabel: 'Compare more' };
    else if (sj.kind === 'deepdive') spec = {
      kind: 'deepdive', id: id || undefined, title: 'Deep dive', cmd: '',
      working: 'A deep dive started from another page is still being written.', building: 'Adding it to the report …',
      watch: function (m){ return (m.type === 'report-changed' && m.id === id) ? id : null; },
      verify: function (){ return headOk('/papers/' + encodeURIComponent(id) + '/index.html'); },
      openUrl: function (){ return '/papers/' + encodeURIComponent(id) + '/'; }, openLabel: 'Open report',
      doneText: function (){ return 'Deep dive added to ' + id + '.'; }, doneToast: function (){ return 'Deep dive ready — ' + id; },
      again: openDeepDive, againLabel: 'Another deep dive' };
    if (!spec) return;
    jobStatusText = spec.working;
    // no watchdog: this page isn't attached to the pty (no output to measure quiet against)
    job = { spec: spec, resultId: null, poll: null, sentAt: Date.now(), warned: false, dog: null, started: true, token: sj.token, wait: null, adopted: true };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updAutoCheck); else updAutoCheck();
  // The terminal drawer NEVER opens itself — not on page load, not on navigation.
  // It appears only on an explicit action (Terminal button, starting a Discussion,
  // a "Show terminal" escape hatch, End chat). App-first: the terminal is a tool
  // of last resort, and a drawer that reappears on every page change reads as a bug.
})();
