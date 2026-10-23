// Run: node engine.test.js
const E = require('./engine.js');
const assert = require('assert');
let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

const D = { mode: 'doubles', target: 11 };
const S = { mode: 'singles', target: 11 };

// 1. Opening serve is 0-0-2, player in right court.
let s = E.newGame(D);
ok(E.scoreCall(s).join('-') === '0-0-2', 'opening call');
let r = E.resolveServe(s, { team: 0, court: 'R', player: 0 });
ok(r.status === 'first', 'first serve accepted');
s = r.state;

// 2. Same server from left court => point.
r = E.resolveServe(s, { team: 0, court: 'L', player: 0 });
ok(r.status === 'ok' && r.path.join('') === 'S', 'point inferred');
s = r.state; ok(E.scoreCall(s).join('-') === '1-0-2', 'call 1-0-2');

// 3. Other team serves => side out (opening team had only one server).
r = E.resolveServe(s, { team: 1, court: 'R', player: 0 });
ok(r.status === 'ok' && r.path.join('') === 'R', 'side out inferred');
s = r.state; ok(E.scoreCall(s).join('-') === '0-1-1', 'call 0-1-1');

// 4. Partner serves => second server.
r = E.resolveServe(s, { team: 1, court: 'L', player: 1 });
ok(r.status === 'ok' && s.serverNum === 1 && r.state.serverNum === 2, 'second server inferred');
s = r.state;

// 5. Identical serve again without a confirmed rally is a duplicate.
ok(E.resolveServe(s, { team: 1, court: 'L', player: 1 }).status === 'duplicate', 'duplicate ignored');

// 6. Without player identity, point vs second server is ambiguous.
let t = E.newGame(D, { firstServe: 0 }); t = E.resolveServe(t, { team: 0, court: 'R', player: 0 }).state;
t = E.resolveServe(t, { team: 1, court: 'R', player: 0 }).state; // side out -> team1 server1 in R
r = E.resolveServe(t, { team: 1, court: 'L' });
ok(r.status === 'ambiguous' && r.candidates.length === 2, 'ambiguous without identity');

// 7. Randomised full games: feed true serves, sometimes dropping one, compare state.
function simulate(cfg, seed, dropRate, knowPlayer) {
  let x = seed; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  let truth = E.newGame(cfg, { firstServe: seed % 2 });
  let est = truth;
  const serveOf = (st) => { const p = E.predictServe(st); return { team: p.team, court: p.court, player: knowPlayer ? p.player : null }; };
  let res = E.resolveServe(est, serveOf(truth)); est = res.state;
  let amb = 0, wrong = 0, skipped = false, misses = 0;
  while (truth.winner == null) {
    truth = E.applyRally(truth, rnd() < 0.55);
    if (truth.winner != null) break;
    if (rnd() < dropRate) { skipped = true; misses++; continue; } // camera missed this serve
    res = E.resolveServe(est, serveOf(truth), { newRally: skipped });
    skipped = false;
    if (res.status === 'ok') est = res.state;
    else if (res.status === 'ambiguous') { amb++; est = res.candidates.find((c) => E.scoreCall(c.state).join() === E.scoreCall(truth).join() && c.state.server === truth.server)?.state || res.candidates[0].state; }
    else if (res.status === 'nomatch') { wrong++; est = Object.assign(JSON.parse(JSON.stringify(truth)), { servesSeen: est.servesSeen + 1, lastServe: est.lastServe }); }
    if (E.scoreCall(est).join() !== E.scoreCall(truth).join() || est.serving !== truth.serving || est.server !== truth.server) {
      wrong++; // count once, then resync as if the player fixed it with Undo/correct
      est = Object.assign(JSON.parse(JSON.stringify(truth)), { servesSeen: est.servesSeen, lastServe: est.lastServe });
    }
  }
  return { amb, wrong, misses };
}
let tot = { games: 0, amb: 0, wrong: 0 };
for (let seed = 1; seed <= 300; seed++) {
  const a = simulate(D, seed, 0, true);
  ok(a.wrong === 0 && a.amb === 0, 'doubles perfect info seed ' + seed);
  const b = simulate(S, seed, 0, true);
  ok(b.wrong === 0 && b.amb === 0, 'singles perfect info seed ' + seed);
  const c = simulate(D, seed, 0.15, true); tot.games++; tot.amb += c.amb; tot.wrong += c.wrong; tot.misses=(tot.misses||0)+c.misses;
}
console.log(`missed-serve sim: ${tot.games} games, ${tot.misses} missed serves -> ${tot.wrong} needed a correction, ${tot.amb} prompts`);
let noId = { amb: 0, wrong: 0 };
for (let seed = 1; seed <= 100; seed++) { const z = simulate(D, seed, 0, false); noId.amb += z.amb; noId.wrong += z.wrong; }
console.log(`no player identity: ${noId.amb} prompts over 100 games, ${noId.wrong} wrong states`);
console.log(`${pass} checks passed`);
