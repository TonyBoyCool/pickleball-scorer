/* App wiring: setup, camera, calibration, scoring display, corrections. */
(function () {
  'use strict';
  const E = window.PBEngine;
  const $ = (id) => document.getElementById(id);
  const KEY = 'pb-cam-scorer-v1';

  const DEF_CFG = { mode: 'doubles', target: 11, first: 0, end0Team: 0, quality: 'normal',
    teams: [{ name: 'Team A', players: ['Ray', 'Sam'] }, { name: 'Team B', players: ['Jo', 'Lee'] }] };

  let cfg, state, hist = [], calib = null, flip = false, voice = false;
  let stream = null, wake = null, modelReady = false, calibrating = null, snoozeUntil = 0;

  // ---------- persistence ----------
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.cfg && d.state) { cfg = d.cfg; state = d.state; hist = d.hist || []; calib = d.calib || null; flip = !!d.flip; voice = !!d.voice; return; }
    } catch (e) { /* first run or storage blocked */ }
    cfg = JSON.parse(JSON.stringify(DEF_CFG));
    state = E.newGame(engineCfg(), { firstServe: cfg.first });
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ cfg, state, hist: hist.slice(-150), calib, flip, voice })); } catch (e) {}
  }
  const engineCfg = () => ({ mode: cfg.mode, target: cfg.target });

  // ---------- vision ----------
  const vision = new PBVision({
    video: $('video'), overlay: $('overlay'),
    onServe: handleServe,
    onInfo: (i) => {
      const p = $('pill');
      p.classList.toggle('live', true); p.classList.toggle('form', i.formation);
      $('pillText').textContent = `${i.text}${i.formation ? ' · serve set-up' : ''} · ${i.fps.toFixed(0)} fps`;
    }
  });
  function syncVision() {
    vision.setConfig({ mode: cfg.mode, end0Team: cfg.end0Team, flip, names: cfg.teams.map((t) => t.players) });
    if (calib) vision.setCalibration(calib);
  }

  const name = (t, i) => (cfg.teams[t].players[i] || `Player ${i + 1}`);
  const tname = (t) => cfg.teams[t].name;

  // ---------- scoring ----------
  function commit(next, evtText, fromCamera) {
    hist.push(JSON.stringify(state));
    state = next; save(); render(evtText);
    if (fromCamera) vision.learn(state); // positions are only trustworthy at a camera-seen serve
    if (state.winner != null) showWin();
    speak();
  }

  function eventText(s0, path) {
    if (!path || !path.length) return 'First serve of the game';
    const parts = E.describePath(s0, path);
    const nice = parts.map((p) => (p === 'point' ? 'point' : p === 'second server' ? 'second server' : 'side out'));
    return (parts.length > 1 ? `Missed ${parts.length - 1} serve${parts.length > 2 ? 's' : ''}: ` : 'Last rally: ') + nice.join(', then ');
  }

  function handleServe(obs, meta) {
    if (state.winner != null) return;
    const base = state;
    if (base.pendingConfirm) {
      // after a hand fix the next serve should be the predicted one: just record who served
      const r = E.resolveServe(Object.assign({}, base, { servesSeen: 0 }), obs, { at: meta.at });
      if (r.status === 'first') {
        r.state.servesSeen = base.servesSeen + 1; delete r.state.pendingConfirm;
        commit(r.state, 'Serve matches the fixed score', true); return;
      }
    }
    const res = E.resolveServe(base, obs, { newRally: meta.newRally, at: meta.at });
    if (res.status === 'duplicate') return;
    if (res.status === 'first' || res.status === 'ok') {
      closeAsk();
      commit(res.state, eventText(base, res.path), true);
      return;
    }
    if (res.status === 'ambiguous') {
      const c = res.candidates;
      const samePlace = c.every((x) => x.serve.team === c[0].serve.team && x.serve.court === c[0].serve.court);
      if (samePlace && new Set(c.map((x) => x.serve.player)).size === c.length) {
        ask(`Who is serving for ${tname(c[0].serve.team)}?`, c.map((x) => ({
          label: name(x.serve.team, x.serve.player),
          fn: () => commit(x.state, eventText(base, x.path), true)
        })));
      } else {
        ask('Which happened?', c.map((x) => ({
          label: `${E.describePath(base, x.path).join(', ')} → ${E.scoreCall(x.state).join('-')}`,
          fn: () => commit(x.state, eventText(base, x.path), true)
        })));
      }
      return;
    }
    toast('Saw a serve that does not fit the score. Check it under Fix the score.');
  }

  function manualRally(servingWon) {
    const next = E.applyRally(state, servingWon);
    const p = E.predictServe(next);
    next.lastServe = state.lastServe; // camera will confirm the next serve
    if (next.servesSeen === 0) next.servesSeen = 1;
    next.pendingConfirm = true;
    commit(next, `Fixed by hand: ${next.lastEvent === 'point' ? 'point' : next.lastEvent === 'second' ? 'second server' : 'side out'} · next: ${name(p.team, p.player)}`);
  }

  function undo() {
    if (!hist.length) { toast('Nothing to undo'); return; }
    state = JSON.parse(hist.pop()); save(); render('Undone'); $('winSheet').hidden = true; closeAsk();
  }

  // ---------- render ----------
  function render(evtText) {
    const st = state.serving, dbl = cfg.mode === 'doubles';
    $('gameLabel').textContent = `Game ${state.gameNo} · to ${cfg.target} · ${dbl ? 'Doubles' : 'Singles'}`;
    $('callNum').innerHTML = E.scoreCall(state).map((v, i) => (i === 2 ? `<span class="sn">${v}</span>` : v)).join('<span class="sep">–</span>');
    $('teams').innerHTML = [0, 1].map((t) => `<div class="tm ${t === st ? 'serving' : ''}"><div class="sw" style="background:var(--team${t ? 'B' : 'A'})"></div>
      <div class="nm">${esc(tname(t))}${t === st ? ' · serving' : ''}${state.games[t] ? ` · ${state.games[t]}g` : ''}</div><div class="sc">${state.score[t]}</div></div>`).join('');
    const L = state.lastServe;
    if (L) {
      $('lastWho').textContent = `${name(L.team, L.player)} · ${tname(L.team)}`;
      $('lastMeta').textContent = `Served from the ${L.court === 'R' ? 'right' : 'left'} court at ${new Date(L.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
    } else {
      const p = E.predictServe(state);
      $('lastWho').textContent = 'Waiting for the first serve';
      $('lastMeta').textContent = `Opening server: ${name(p.team, p.player)} (${tname(p.team)}), ${p.court === 'R' ? 'right' : 'left'} court`;
    }
    if (evtText != null) $('lastEvt').textContent = evtText;
    $('voiceBtn').textContent = `Call score: ${voice ? 'on' : 'off'}`;
    $('flipBtn').textContent = `Flip right/left${flip ? ' (flipped)' : ''}`;
  }

  // ---------- prompts ----------
  function ask(q, choices) {
    $('askQ').textContent = q;
    const box = $('askChoices'); box.innerHTML = '';
    for (const c of choices) {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = c.label;
      b.onclick = () => { closeAsk(); c.fn(); }; box.appendChild(b);
    }
    $('ask').hidden = false;
  }
  function closeAsk() { $('ask').hidden = true; }

  let tt; function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 2600); }

  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three'];
  function speak() {
    if (!voice || !window.speechSynthesis) return;
    try {
      const txt = state.winner != null ? `Game, ${tname(state.winner)}` : E.scoreCall(state).map((n) => words[n] || n).join(', ');
      speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(txt));
    } catch (e) {}
  }

  // The last point of a game has no serve after it, so ask when a game-point rally goes quiet.
  setInterval(() => {
    if (state.winner != null || !state.lastServe || !E.atGamePoint(state) || !$('ask').hidden) return;
    const now = Date.now();
    if (now - state.lastServe.at > 35000 && now > snoozeUntil) {
      ask(`Game point. Did ${tname(state.serving)} win the game?`, [
        { label: `Yes, ${tname(state.serving)} won`, fn: () => commit(E.applyRally(state, true), 'Game point won') },
        { label: 'Not yet', fn: () => { snoozeUntil = Date.now() + 30000; } }
      ]);
    }
  }, 2000);

  function showWin() {
    const w = state.winner;
    $('winScore').textContent = `${state.score[w]}–${state.score[1 - w]}`;
    $('winName').textContent = `${tname(w)} wins`;
    $('winNote').textContent = `Games: ${tname(0)} ${state.games[0]}, ${tname(1)} ${state.games[1]}. Next game the teams switch ends and ${tname(1 - state.firstServe)} serves first.`;
    $('winSheet').hidden = false;
  }
  $('nextGame').onclick = () => {
    cfg.end0Team = 1 - cfg.end0Team;
    state = E.newGame(engineCfg(), { firstServe: 1 - state.firstServe, games: state.games, gameNo: state.gameNo + 1 });
    hist = []; vision.reset(); syncVision(); save(); render('New game'); $('winSheet').hidden = true;
  };
  $('winUndo').onclick = undo;

  // ---------- camera ----------
  async function startCamera(fileUrl) {
    const v = $('video');
    try {
      if (fileUrl) {
        if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
        v.srcObject = null; v.src = fileUrl; v.loop = true; v.muted = true; await v.play();
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        v.removeAttribute('src'); v.srcObject = stream; await v.play();
      }
    } catch (e) {
      $('stageMsg').hidden = false;
      $('stageMsg').innerHTML = `<b>Camera not available.</b> ${esc(e.message || e)}. The app needs camera permission and must be opened over https.`;
      return;
    }
    $('camBtn').textContent = 'Stop camera';
    requestWake();
    if (!modelReady) {
      $('stageMsg').hidden = false; $('stageMsg').innerHTML = '<b>Loading the player detector…</b> First load downloads about 10 MB.';
      try { await vision.loadModel(cfg.quality); modelReady = true; } catch (e) {
        $('stageMsg').innerHTML = `<b>Could not load the detector.</b> ${esc(e.message || e)}`; return;
      }
    }
    syncVision();
    vision.start();
    if (!calib) beginCalibration();
    else $('stageMsg').hidden = true;
  }
  function stopCamera() {
    vision.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; $('video').srcObject = null; $('video').pause();
    $('camBtn').textContent = 'Start camera'; $('pill').className = 'pill'; $('pillText').textContent = 'Camera off';
  }
  $('camBtn').onclick = () => (stream || $('video').src ? (stopCamera(), $('video').removeAttribute('src')) : startCamera());
  $('fileBtn').onclick = () => $('fileIn').click();
  $('fileIn').onchange = (e) => { const f = e.target.files[0]; if (f) startCamera(URL.createObjectURL(f)); };

  // Fit the stage to the video's shape inside its box.
  function fitStage() {
    const v = $('video'), st = $('stage'), wrap = st.parentElement;
    if (!v.videoWidth) return;
    const ar = v.videoWidth / v.videoHeight, W = wrap.clientWidth, H = wrap.clientHeight;
    const w = Math.min(W, H * ar);
    st.style.width = w + 'px'; st.style.height = (w / ar) + 'px'; st.style.aspectRatio = 'auto';
  }
  $('video').addEventListener('loadedmetadata', fitStage);
  window.addEventListener('resize', fitStage);

  // ---------- calibration ----------
  const CAL_STEPS = [
    'Tap <b>corner 1</b>: one end of a baseline (usually the one nearest the camera).',
    'Tap <b>corner 2</b>: the other end of that same baseline.',
    'Tap <b>corner 3</b>: the far-baseline corner on the same sideline as corner 2.',
    'Tap <b>corner 4</b>: the last corner.'
  ];
  function beginCalibration() {
    if (!$('video').videoWidth) { toast('Start the camera first'); return; }
    calibrating = []; vision.H = null; vision.calib = [];
    $('stageMsg').hidden = false; $('stageMsg').innerHTML = CAL_STEPS[0];
  }
  $('calBtn').onclick = beginCalibration;
  $('overlay').addEventListener('pointerdown', (e) => {
    if (!calibrating) return;
    const r = e.currentTarget.getBoundingClientRect(), v = $('video');
    const x = (e.clientX - r.left) * v.videoWidth / r.width, y = (e.clientY - r.top) * v.videoHeight / r.height;
    calibrating.push([x, y]); vision.calib = calibrating;
    if (calibrating.length < 4) { $('stageMsg').innerHTML = CAL_STEPS[calibrating.length]; return; }
    try {
      calib = calibrating; calibrating = null; vision.setCalibration(calib); save();
      $('stageMsg').innerHTML = `Court lines drawn. Check the <b>right / left</b> labels match a player at each baseline facing the net; if not, tap <b>Flip right/left</b>. ${esc(tname(cfg.end0Team))} should be at the corner 1–2 baseline (change in Match setup). Tap here to close.`;
      $('stageMsg').onclick = () => { $('stageMsg').hidden = true; $('stageMsg').onclick = null; };
    } catch (err) { toast(err.message); beginCalibration(); }
  });
  $('flipBtn').onclick = () => { flip = !flip; save(); syncVision(); render(); };

  // ---------- setup ----------
  let draft;
  function seg(id, key, num) {
    const el = $(id);
    const sync = () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v) === String(draft[key])));
    el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; draft[key] = num ? +b.dataset.v : b.dataset.v; sync(); if (key === 'mode') syncMode(); };
    return sync;
  }
  function syncMode() { document.querySelectorAll('.dbl').forEach((d) => (d.hidden = draft.mode !== 'doubles')); }
  const syncs = [seg('modeSeg', 'mode'), seg('targetSeg', 'target', 1), seg('firstSeg', 'first', 1), seg('endSeg', 'end0Team', 1)];
  function openSetup() {
    draft = JSON.parse(JSON.stringify(cfg)); syncs.forEach((f) => f()); syncMode();
    const T = draft.teams;
    $('tA').value = T[0].name; $('tB').value = T[1].name;
    $('pA0').value = T[0].players[0]; $('pA1').value = T[0].players[1];
    $('pB0').value = T[1].players[0]; $('pB1').value = T[1].players[1];
    $('quality').value = draft.quality; $('setup').hidden = false;
  }
  $('setupBtn').onclick = openSetup;
  $('cancelSetup').onclick = () => ($('setup').hidden = true);
  $('setupForm').onsubmit = (e) => {
    e.preventDefault();
    const v = (id, d) => $(id).value.trim() || d;
    draft.teams = [{ name: v('tA', 'Team A'), players: [v('pA0', 'A1'), v('pA1', 'A2')] },
      { name: v('tB', 'Team B'), players: [v('pB0', 'B1'), v('pB1', 'B2')] }];
    const qChanged = draft.quality !== $('quality').value;
    draft.quality = $('quality').value;
    cfg = draft; hist = [];
    state = E.newGame(engineCfg(), { firstServe: cfg.first });
    vision.reset(); vision.refs = [[null, null], [null, null]]; vision.trackMap.clear();
    if (qChanged && modelReady) { modelReady = false; vision.detector = null; vision.loadModel(cfg.quality).then(() => (modelReady = true)); }
    syncVision(); save(); render('New match'); closeAsk();
    $('setup').hidden = true; $('winSheet').hidden = true;
  };

  // ---------- fixes & misc ----------
  $('undoBtn').onclick = undo;
  $('mPoint').onclick = () => manualRally(true);
  $('mLost').onclick = () => manualRally(false);
  $('gameOverBtn').onclick = () => {
    ask('Who won the game?', [0, 1].map((t) => ({ label: tname(t), fn: () => {
      const next = JSON.parse(JSON.stringify(state)); next.winner = t; next.games[t]++; commit(next, 'Game ended by hand');
    } })));
  };
  $('swapEndsBtn').onclick = () => { cfg.end0Team = 1 - cfg.end0Team; vision.reset(); syncVision(); save(); toast(`${tname(cfg.end0Team)} now at the corner 1–2 baseline`); };
  $('voiceBtn').onclick = () => { voice = !voice; save(); render(); if (voice) speak(); };

  async function requestWake() { try { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); } } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && stream) requestWake(); });

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  load(); syncVision(); render();
  if (state.winner != null) showWin();
})();
