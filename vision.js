/* Pickleball camera vision: finds the pre-serve setup and reports who is serving.
 *
 * Pipeline per frame:
 *   MoveNet MultiPose (TensorFlow.js) -> people + keypoints (+ tracker ids)
 *   feet (ankles) -> court coordinates in feet through a homography from 4 tapped corners
 *   -> doubles: "serve formation" = receiving team has one player up at the kitchen and one back;
 *      the receiver is the back player, the server stands diagonally on the other end.
 *   -> singles: both players back on diagonal courts; the first one to swing is the server.
 *   -> server identity (which teammate) from tracker id, else shirt colour learned on the fly.
 *
 * Court frame: x = 0..20 ft across, y = 0..44 ft along, net at y = 22.
 * End 0 is the baseline between tapped corners 1 and 2.
 */
(function (root) {
  'use strict';

  const COURT = { W: 20, L: 44, NET: 22, KITCHEN: 7 };
  const KP = { LS: 5, RS: 6, LW: 9, RW: 10, LH: 11, RH: 12, LA: 15, RA: 16 };

  // ---------- geometry ----------
  function solveHomography(src, dst) {
    // src/dst: 4 points [x,y]; returns 3x3 H (row-major, h33 = 1) with dst ~ H*src
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      if (Math.abs(A[c][c]) < 1e-12) throw new Error('Corners are in a line; tap the four corners again.');
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  const CORNERS = [[0, 0], [COURT.W, 0], [COURT.W, COURT.L], [0, COURT.L]];

  // ---------- colour ----------
  function rgbToLab(r, g, b) {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    X = f(X); Y = f(Y); Z = f(Z);
    // Lightness down-weighted: shade and sun change L far more than hue.
    return [(116 * Y - 16) * 0.5, 500 * (X - Y), 200 * (Y - Z)];
  }
  const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  class PBVision {
    constructor(opts) {
      this.video = opts.video;
      this.overlay = opts.overlay;
      this.onServe = opts.onServe || (() => {});
      this.onInfo = opts.onInfo || (() => {});
      this.cfg = { mode: 'doubles', end0Team: 0, flip: false, names: [['A1', 'A2'], ['B1', 'B2']] };
      this.H = null; this.Hinv = null; this.calib = null;
      this.detector = null; this.running = false;
      this.refs = [[null, null], [null, null]];   // shirt colour per team/player (Lab)
      this.trackMap = new Map();                   // tracker id -> {team, player}
      this.sample = document.createElement('canvas');
      this.sctx = this.sample.getContext('2d', { willReadFrequently: true });
      this.reset();
    }

    reset() {
      this.cur = null;            // current candidate formation {sig, anchor, since}
      this.lastSig = null;        // signature of last registered serve
      this.regAnchor = null;      // positions at last registered serve
      this.moved = false;         // big movement since last registration
      this.absentSince = null;
      this.lastFormation = null;
      this.singles = { stableSince: null, sig: null, prevWrist: null };
      this.lastPlayers = [];
      this.fps = 0;
    }

    setConfig(c) { Object.assign(this.cfg, c); }

    setCalibration(pts) {
      this.calib = pts.map((p) => p.slice());
      this.H = solveHomography(pts, CORNERS);
      this.Hinv = solveHomography(CORNERS, pts);
    }

    async loadModel(quality) {
      if (!root.poseDetection) throw new Error('Pose model library did not load. Check your connection and reload.');
      try { await root.tf.setBackend('webgl'); } catch (e) { /* fall back to default */ }
      await root.tf.ready();
      const dim = quality === 'fast' ? 256 : quality === 'max' ? 640 : 448;
      this.detector = await root.poseDetection.createDetector(root.poseDetection.SupportedModels.MoveNet, {
        modelType: root.poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableTracking: true, trackerType: root.poseDetection.TrackerType.BoundingBox,
        multiPoseMaxDimension: dim, minPoseScore: 0.15
      });
    }

    start() {
      if (this.running) return; this.running = true;
      let t0 = performance.now(), frames = 0;
      const loop = async () => {
        if (!this.running) return;
        if (this.video.readyState >= 2 && this.detector && this.H) {
          try { await this.process(performance.now()); } catch (e) { console.error(e); }
          frames++;
          const now = performance.now();
          if (now - t0 > 1000) { this.fps = frames * 1000 / (now - t0); frames = 0; t0 = now; }
        } else if (this.H == null) { this.drawOverlay([]); }
        // requestVideoFrameCallback keeps us in step with the camera when available
        if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(() => loop());
        else requestAnimationFrame(loop);
      };
      loop();
    }
    stop() { this.running = false; }

    // court-relative helpers
    endOf(y) { return y < COURT.NET ? 0 : 1; }
    teamOfEnd(e) { return e === 0 ? this.cfg.end0Team : 1 - this.cfg.end0Team; }
    endOfTeam(t) { return t === this.cfg.end0Team ? 0 : 1; }
    letter(e, x) {
      // End 0 faces +y: their right is +x. End 1 faces -y: their right is -x.
      let right = e === 0 ? x > COURT.W / 2 : x < COURT.W / 2;
      if (this.cfg.flip) right = !right;
      return right ? 'R' : 'L';
    }
    distNet(y) { return Math.abs(y - COURT.NET); }

    async process(now) {
      const poses = await this.detector.estimatePoses(this.video, { flipHorizontal: false });
      const players = [];
      for (const p of poses) {
        const k = p.keypoints, good = (i) => k[i] && k[i].score > 0.25;
        let fx, fy;
        if (good(KP.LA) || good(KP.RA)) {
          const a = [KP.LA, KP.RA].filter(good).map((i) => k[i]);
          fx = a.reduce((s, q) => s + q.x, 0) / a.length; fy = Math.max(...a.map((q) => q.y));
        } else if (p.box) { fx = (p.box.xMin + p.box.xMax) / 2; fy = p.box.yMax; }
        else continue;
        const [cx, cy] = applyH(this.H, fx, fy);
        if (cx < -8 || cx > COURT.W + 8 || cy < -12 || cy > COURT.L + 12) continue; // spectators, next court
        const torso = (good(KP.LS) && good(KP.LH)) ? Math.hypot(k[KP.LS].x - k[KP.LH].x, k[KP.LS].y - k[KP.LH].y) : 40;
        const wr = [KP.LW, KP.RW].filter(good).map((i) => [k[i].x, k[i].y]);
        const e = this.endOf(cy);
        players.push({ id: p.id, k, fx, fy, x: cx, y: cy, end: e, d: this.distNet(cy), letter: this.letter(e, cx), torso, wr });
      }
      this.lastPlayers = players;

      let formation = null, info = '';
      if (this.cfg.mode === 'doubles') { formation = this.doublesFormation(players); }
      const counts = [0, 1].map((e) => players.filter((p) => p.end === e).length);
      info = `${players.length} on court (${counts[0]}|${counts[1]})`;

      if (this.cfg.mode === 'doubles') this.trackDoubles(formation, players, now);
      else formation = this.trackSingles(players, now);

      this.drawOverlay(players, formation);
      this.onInfo({ players: players.length, counts, formation: !!formation, fps: this.fps, text: info });
    }

    // ---------- doubles ----------
    doublesFormation(players) {
      const ends = [0, 1].map((e) => players.filter((p) => p.end === e));
      if (ends[0].length !== 2 || ends[1].length !== 2) return null;
      for (const re of [0, 1]) {
        const R = ends[re], S = ends[1 - re];
        const up = R.find((p) => p.d <= COURT.KITCHEN + 6), back = R.find((p) => p.d >= COURT.KITCHEN + 9);
        if (!up || !back || up === back) continue;
        if (!S.every((p) => p.d >= COURT.KITCHEN + 8)) continue; // serving team both back
        const recLetter = back.letter;
        // server stands on the matching (diagonal) court of the other end
        let server = S.find((p) => p.letter === recLetter);
        if (!server) continue;
        if (S.filter((p) => p.letter === recLetter).length > 1) {
          const cxWant = this.letter(1 - re, COURT.W * 0.75) === recLetter ? COURT.W * 0.75 : COURT.W * 0.25;
          server = S.slice().sort((a, b) => Math.abs(a.x - cxWant) - Math.abs(b.x - cxWant))[0];
        }
        return { servingEnd: 1 - re, court: recLetter, server, receiver: back, players: players.slice(), sig: (1 - re) + recLetter };
      }
      return null;
    }

    maxMove(a, b) {
      // nearest-neighbour distance per player, max over players
      let m = 0;
      for (const p of a) {
        let best = Infinity;
        for (const q of b) if (q.end === p.end) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        m = Math.max(m, best);
      }
      return m;
    }

    trackDoubles(F, players, now) {
      const STABLE_MS = 900;
      // movement since the last registered serve (evidence that a rally was played)
      if (this.regAnchor && players.length) {
        if (!F) { if (this.absentSince == null) this.absentSince = now; } else this.absentSince = null;
        const advanced = players.some((p) => {
          const near = this.regAnchor.filter((q) => q.end === p.end).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
          return near && near.d - p.d >= 8; // someone came 8+ ft toward the net
        });
        if (advanced && this.absentSince != null && now - this.absentSince > 1500) this.moved = true;
      }
      if (!F) { this.cur = null; return; }
      if (!this.cur || this.cur.sig !== F.sig || this.maxMove(F.players, this.cur.anchor) > 2.5) {
        this.cur = { sig: F.sig, anchor: F.players.map((p) => ({ x: p.x, y: p.y, end: p.end })), since: now, fired: false };
        return;
      }
      if (this.cur.fired || now - this.cur.since < STABLE_MS) return;
      this.cur.fired = true;
      const isNewSig = F.sig !== this.lastSig;
      if (!isNewSig && !this.moved) return; // same set-up, nothing happened
      const newRally = !isNewSig && this.moved;
      this.register(F, now, newRally);
    }

    register(F, now, newRally) {
      this.lastSig = F.sig;
      this.regAnchor = F.players.map((p) => ({ x: p.x, y: p.y, end: p.end, d: p.d }));
      this.moved = false; this.absentSince = null;
      this.lastFormation = F;
      this.grabColours(F.players);
      const team = this.teamOfEnd(F.servingEnd);
      const id = this.identify(team, F.server);
      this.onServe({ team, court: F.court, player: id.player }, { newRally, how: id.how, at: Date.now() });
    }

    // ---------- singles ----------
    trackSingles(players, now) {
      const S = this.singles;
      const ends = [0, 1].map((e) => players.filter((p) => p.end === e));
      if (ends[0].length !== 1 || ends[1].length !== 1) { S.stableSince = null; return null; }
      const [a, b] = [ends[0][0], ends[1][0]];
      const back = a.d >= 15 && b.d >= 15 && a.letter === b.letter;
      if (!back) { S.stableSince = null; S.armedAfterMove = true; return null; }
      const sig = a.letter;
      if (S.stableSince == null || S.anchorSig !== sig) { S.stableSince = now; S.anchorSig = sig; S.prevWrist = null; return null; }
      const F = { court: sig, players: [a, b], sig };
      if (now - S.stableSince < 700) return F;
      // first player to swing (wrist speed in torso lengths / s) is the server
      const speed = (p, prev) => {
        if (!prev || !p.wr.length || !prev.wr.length) return 0;
        const dt = (now - prev.t) / 1000; if (dt <= 0) return 0;
        return Math.max(...p.wr.map((w, i) => prev.wr[i] ? Math.hypot(w[0] - prev.wr[i][0], w[1] - prev.wr[i][1]) : 0)) / p.torso / dt;
      };
      const prev = S.prevWrist;
      S.prevWrist = { t: now, 0: { wr: a.wr }, 1: { wr: b.wr } };
      if (!prev) return F;
      const va = speed(a, prev[0]), vb = speed(b, prev[1]);
      const THR = 3.0;
      let srvEnd = null;
      if (va > THR && vb < THR * 0.5) srvEnd = 0; else if (vb > THR && va < THR * 0.5) srvEnd = 1;
      if (srvEnd == null) return F;
      const fsig = srvEnd + sig;
      if (fsig === this.lastSig && !S.armedAfterMove) return F;
      S.armedAfterMove = false; S.stableSince = null;
      this.lastSig = fsig;
      const team = this.teamOfEnd(srvEnd);
      this.lastFormation = { servingEnd: srvEnd, court: sig, server: srvEnd === 0 ? a : b, players: [a, b] };
      this.onServe({ team, court: sig, player: 0 }, { newRally: false, how: 'swing', at: Date.now() });
      return F;
    }

    // ---------- identity ----------
    grabColours(list) {
      const v = this.video, w = 480, h = Math.round(480 * v.videoHeight / v.videoWidth), s = w / v.videoWidth;
      this.sample.width = w; this.sample.height = h;
      this.sctx.drawImage(v, 0, 0, w, h);
      for (const p of list) {
        const k = p.k, pts = [KP.LS, KP.RS, KP.LH, KP.RH].map((i) => k[i]);
        if (pts.some((q) => !q || q.score < 0.2)) { p.lab = null; continue; }
        let R = 0, G = 0, B = 0, n = 0;
        for (let u = 0.25; u <= 0.76; u += 0.25) for (let t = 0.2; t <= 0.71; t += 0.25) {
          const top = [pts[0].x + (pts[1].x - pts[0].x) * u, pts[0].y + (pts[1].y - pts[0].y) * u];
          const bot = [pts[2].x + (pts[3].x - pts[2].x) * u, pts[2].y + (pts[3].y - pts[2].y) * u];
          const x = Math.round((top[0] + (bot[0] - top[0]) * t) * s), y = Math.round((top[1] + (bot[1] - top[1]) * t) * s);
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          const d = this.sctx.getImageData(x - 1, y - 1, 3, 3).data;
          for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
        }
        p.lab = n ? rgbToLab(R / n, G / n, B / n) : null;
      }
    }

    identify(team, p) {
      if (this.cfg.mode !== 'doubles') return { player: 0, how: 'singles' };
      const m = p.id != null && this.trackMap.get(p.id);
      if (m && m.team === team) return { player: m.player, how: 'tracked' };
      const r = this.refs[team];
      if (p.lab && r[0] && r[1]) {
        const d0 = labDist(p.lab, r[0]), d1 = labDist(p.lab, r[1]);
        const lo = Math.min(d0, d1), hi = Math.max(d0, d1);
        if (labDist(r[0], r[1]) > 12 && lo < hi * 0.6) return { player: d0 < d1 ? 0 : 1, how: 'shirt' };
      }
      return { player: null, how: 'unknown' };
    }

    /** After the engine settles a serve, learn who stood where (positions come from the engine). */
    learn(state) {
      const F = this.lastFormation; if (!F || state.cfg.mode !== 'doubles') return;
      for (const p of F.players) {
        const team = this.teamOfEnd(p.end);
        const player = state.pos[team][p.letter];
        if (player == null) continue;
        if (p.id != null) this.trackMap.set(p.id, { team, player });
        if (p.lab) {
          const r = this.refs[team][player];
          this.refs[team][player] = r ? r.map((v, i) => v * 0.7 + p.lab[i] * 0.3) : p.lab.slice();
        }
      }
      // drop tracker ids that now point at two people
      const seen = new Map();
      for (const [id, v] of this.trackMap) { const k = v.team + ':' + v.player; if (seen.has(k) && seen.get(k) !== id) this.trackMap.delete(seen.get(k)); seen.set(k, id); }
    }

    teammatesLookAlike() {
      return [0, 1].some((t) => this.refs[t][0] && this.refs[t][1] && labDist(this.refs[t][0], this.refs[t][1]) <= 12);
    }

    // ---------- drawing ----------
    drawOverlay(players, F) {
      const c = this.overlay, v = this.video;
      if (!v.videoWidth) return;
      if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
      const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
      const lw = Math.max(2, c.width / 400);
      if (this.Hinv) {
        const P = (x, y) => applyH(this.Hinv, x, y);
        const line = (a, b, col, w) => { g.strokeStyle = col; g.lineWidth = w || lw; g.beginPath(); g.moveTo(...P(...a)); g.lineTo(...P(...b)); g.stroke(); };
        const W = COURT.W, L = COURT.L, N = COURT.NET, K = COURT.KITCHEN;
        const c1 = 'rgba(255,255,255,.75)';
        line([0, 0], [W, 0], c1); line([W, 0], [W, L], c1); line([W, L], [0, L], c1); line([0, L], [0, 0], c1);
        line([0, N], [W, N], 'rgba(228,212,62,.9)', lw * 1.5);
        line([0, N - K], [W, N - K], c1); line([0, N + K], [W, N + K], c1);
        line([W / 2, 0], [W / 2, N - K], c1); line([W / 2, N + K], [W / 2, L], c1);
        g.font = `${Math.round(c.width / 40)}px system-ui,sans-serif`; g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.85)';
        for (const e of [0, 1]) for (const x of [W * 0.25, W * 0.75]) {
          const y = e === 0 ? 4 : L - 4; const [px, py] = P(x, y);
          g.fillText(this.letter(e, x) === 'R' ? 'right' : 'left', px, py);
        }
      }
      if (this.calib && !this.H) {
        g.fillStyle = '#e4d43e';
        this.calib.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, lw * 4, 0, 7); g.fill(); });
      }
      for (const p of players) {
        const isS = F && F.server === p, isR = F && F.receiver === p;
        g.beginPath(); g.arc(p.fx, p.fy, lw * 5, 0, 7);
        g.fillStyle = this.teamOfEnd(p.end) === 0 ? '#edb82b' : '#f2765e'; g.fill();
        if (isS || isR) { g.lineWidth = lw * 2; g.strokeStyle = isS ? '#e4d43e' : '#ffffff'; g.beginPath(); g.arc(p.fx, p.fy, lw * 9, 0, 7); g.stroke(); }
      }
    }
  }

  PBVision.COURT = COURT;
  PBVision.solveHomography = solveHomography;
  PBVision.applyH = applyH;
  root.PBVision = PBVision;
})(typeof self !== 'undefined' ? self : this);
