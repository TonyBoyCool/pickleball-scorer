// Run: node vision.test.js  — geometry + formation logic with synthetic players (no camera)
global.self = global;
global.document = { createElement: () => ({ getContext: () => ({}) }) };
require('./vision.js');
const E = require('./engine.js');
const V = global.PBVision, assert = require('assert');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; };

// Homography: a skewed camera view maps back to court feet.
const img = [[310, 690], [1610, 700], [1180, 260], [720, 255]];
const H = V.solveHomography(img, [[0, 0], [20, 0], [20, 44], [0, 44]]);
const Hi = V.solveHomography([[0, 0], [20, 0], [20, 44], [0, 44]], img);
for (const [x, y] of [[10, 22], [3, 15], [17, 40], [0, 0]]) {
  const [u, v] = V.applyH(Hi, x, y), [x2, y2] = V.applyH(H, u, v);
  ok(Math.abs(x - x2) < 1e-6 && Math.abs(y - y2) < 1e-6, 'homography round trip');
}

// Build the pre-serve set-up a real doubles game would show for an engine state.
const vis = new V({ video: {}, overlay: {} });
function scene(state, end0Team, jitter) {
  const pred = E.predictServe(state), st = state.serving, rt = 1 - st;
  const endOf = (t) => (t === end0Team ? 0 : 1);
  const xFor = (e, C) => ((e === 0) === (C === 'R') ? 15 : 5);           // right = +x at end 0, -x at end 1
  const yFor = (e, d) => (e === 0 ? 22 - d : 22 + d);
  const players = [];
  for (const C of ['R', 'L']) {
    const e = endOf(st);
    players.push({ end: e, x: xFor(e, C) + jitter(), y: yFor(e, 23 + jitter()), id: `${st}${state.pos[st][C]}` });
    const er = endOf(rt), isRecv = C === pred.court;               // receiver diagonal, partner up at kitchen
    const d = isRecv ? 22 + jitter() : 6 + jitter();
    players.push({ end: er, x: xFor(er, C) + jitter(), y: yFor(er, d), id: `${rt}${state.pos[rt][C]}` });
  }
  players.forEach((p) => { p.d = Math.abs(p.y - 22); p.letter = vis.letter(p.end, p.x); });
  return players;
}
let x = 7; const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
const jitter = () => (rnd() - 0.5) * 3;
let checked = 0;
for (const end0Team of [0, 1]) {
  vis.setConfig({ mode: 'doubles', end0Team, flip: false });
  for (let g = 0; g < 40; g++) {
    let s = E.newGame({ mode: 'doubles', target: 11 }, { firstServe: g % 2 });
    while (s.winner == null) {
      const P = scene(s, end0Team, jitter), F = vis.doublesFormation(P), pred = E.predictServe(s);
      ok(F, 'formation found');
      ok(vis.teamOfEnd(F.servingEnd) === pred.team, 'serving team');
      ok(F.court === pred.court, 'serve court');
      ok(F.server.id === `${pred.team}${pred.player}`, 'server is the right person');
      checked++;
      s = E.applyRally(s, rnd() < 0.55);
    }
  }
}
// Mid-rally positions (everyone at the kitchen) must not look like a serve.
const rally = [0, 1].flatMap((e) => [{ end: e, x: 5, y: e ? 30 : 14 }, { end: e, x: 15, y: e ? 29 : 15 }]);
rally.forEach((p) => { p.d = Math.abs(p.y - 22); p.letter = vis.letter(p.end, p.x); });
ok(vis.doublesFormation(rally) === null, 'dink rally ignored');
console.log(`${checked} serve set-ups identified correctly; ${pass} checks passed`);
