/* Pickleball serve-inference scoring engine.
 * Traditional side-out scoring, doubles and singles.
 * The camera reports who is serving (team, court R/L, player); the engine
 * works out what happened in the rally(s) since the last serve it saw.
 * Pure functions, no DOM: runs in the browser and in Node for tests.
 */
(function (root) {
  'use strict';
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function newGame(cfg, opts) {
    opts = opts || {};
    const first = opts.firstServe == null ? 0 : opts.firstServe;
    const dbl = cfg.mode === 'doubles';
    return {
      cfg,
      gameNo: opts.gameNo || 1,
      games: opts.games || [0, 0],
      firstServe: first,
      score: [0, 0],
      serving: first,
      serverNum: dbl ? 2 : 1,     // doubles opens 0-0-2
      server: 0,                  // index of serving player within serving team
      pos: [{ R: 0, L: 1 }, { R: 0, L: 1 }], // player index in each court (doubles)
      winner: null,
      servesSeen: 0,
      lastServe: null,            // {team, player, court, at}
      rallyCount: 0
    };
  }

  const isDbl = (s) => s.cfg.mode === 'doubles';

  /** Where the next serve must come from, given the state. */
  function predictServe(s) {
    const t = s.serving;
    if (isDbl(s)) {
      const court = s.pos[t].R === s.server ? 'R' : 'L';
      return { team: t, player: s.server, court };
    }
    return { team: t, player: 0, court: s.score[t] % 2 === 0 ? 'R' : 'L' };
  }

  /** Apply one rally result. servingWon=true: serving team won the rally. */
  function applyRally(s0, servingWon) {
    const s = clone(s0);
    if (s.winner != null) return s;
    const st = s.serving, rt = 1 - st;
    s.rallyCount++;
    if (servingWon) {
      s.score[st]++;
      if (isDbl(s)) { const p = s.pos[st]; const r = p.R; p.R = p.L; p.L = r; }
      const a = s.score[st], b = s.score[rt];
      if (a >= s.cfg.target && a - b >= 2) { s.winner = st; s.games[st]++; }
      return Object.assign(s, { lastEvent: 'point' });
    }
    if (isDbl(s) && s.serverNum === 1) {
      s.serverNum = 2; s.server = 1 - s.server;
      return Object.assign(s, { lastEvent: 'second' });
    }
    s.serving = rt; s.serverNum = 1; s.server = isDbl(s) ? s.pos[rt].R : 0;
    return Object.assign(s, { lastEvent: 'sideout' });
  }

  const sig = (s) => [s.score.join(','), s.serving, s.server, s.serverNum,
    s.pos.map((p) => p.R + '' + p.L).join('|'), s.winner].join(';');

  function matches(pred, obs) {
    if (obs.team != null && obs.team !== pred.team) return false;
    if (obs.court != null && obs.court !== pred.court) return false;
    if (obs.player != null && obs.player !== pred.player) return false;
    return true;
  }

  /**
   * Resolve a newly observed serve.
   * obs: {team?, court?, player?}  (null/undefined = unknown)
   * opts.newRally: true if we are sure a rally happened since the last serve
   *                (so an identical serve is not a duplicate).
   * returns {status:'ok'|'first'|'duplicate'|'ambiguous'|'nomatch', state?, candidates?, path?}
   */
  function resolveServe(s, obs, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 3;
    const stamp = (st, path) => {
      const out = clone(st);
      const p = predictServe(out);
      out.servesSeen++;
      out.lastServe = { team: p.team, player: p.player, court: p.court, at: opts.at || Date.now() };
      out.lastPath = path;
      return out;
    };

    if (s.winner != null) return { status: 'nomatch', reason: 'game over' };

    // First serve of the game: must match the opening server.
    if (s.servesSeen === 0) {
      if (matches(predictServe(s), obs)) return { status: 'first', state: stamp(s, []), path: [] };
      // Allow a missed opening rally or two.
    } else if (!opts.newRally && matches(predictServe(s), obs)) {
      return { status: 'duplicate' };
    }

    let frontier = [{ st: s, path: [] }];
    for (let d = 1; d <= maxDepth; d++) {
      const next = [];
      for (const n of frontier) {
        if (n.st.winner != null) continue;
        for (const won of [true, false]) {
          const st = applyRally(n.st, won);
          next.push({ st, path: n.path.concat(won ? 'S' : 'R') });
        }
      }
      const hits = new Map();
      for (const n of next) {
        if (n.st.winner != null) continue; // a serve can't follow a game-winning point
        if (matches(predictServe(n.st), obs)) {
          const k = sig(n.st);
          if (!hits.has(k)) hits.set(k, n);
        }
      }
      if (hits.size === 1) {
        const n = [...hits.values()][0];
        return { status: 'ok', state: stamp(n.st, n.path), path: n.path, depth: d };
      }
      if (hits.size > 1) {
        return {
          status: 'ambiguous', depth: d,
          candidates: [...hits.values()].map((n) => ({
            path: n.path, state: stamp(n.st, n.path), serve: predictServe(n.st)
          }))
        };
      }
      frontier = next;
    }
    return { status: 'nomatch' };
  }

  /** Score call as players say it: server score, receiver score, server # (doubles). */
  function scoreCall(s) {
    const st = s.serving;
    const parts = [s.score[st], s.score[1 - st]];
    if (isDbl(s)) parts.push(s.serverNum);
    return parts;
  }

  /** Is the serving team one rally from winning? */
  function atGamePoint(s) {
    const st = s.serving, a = s.score[st] + 1, b = s.score[1 - st];
    return a >= s.cfg.target && a - b >= 2;
  }

  /** Plain-English description of a path of rally results. */
  function describePath(s, path) {
    let st = s; const out = [];
    for (const r of path) {
      st = applyRally(st, r === 'S');
      out.push(st.lastEvent === 'point' ? 'point' : st.lastEvent === 'second' ? 'second server' : 'side out');
    }
    return out;
  }

  const api = { newGame, predictServe, applyRally, resolveServe, scoreCall, atGamePoint, describePath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PBEngine = api;
})(typeof self !== 'undefined' ? self : this);
