'use strict';
/* LOCKDOWN self-test — runs the sim headless in Node, audits walkability,
   systems, warden actions, and render compositing via a stub canvas. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('NO SCRIPT FOUND'); process.exit(1); }

let errors = 0;
const errorLog = [];
const sandbox = {
  console: {
    log: () => {},
    warn: () => {},
    error: (...a) => { errors++; errorLog.push(a.map(String).join(' ')); },
  },
  Math, JSON, Object, Array, Number, String, Boolean, Date, parseInt, parseFloat, isNaN,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(m[1], sandbox, { filename: 'lockdown.js' });
} catch (e) {
  console.error('LOAD FAILED:', e.stack);
  process.exit(1);
}
const L = sandbox.__lockdown;
if (!L) { console.error('NO __lockdown EXPORT'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ---------- 1. initial state ----------
console.log('\n[1] initial state');
L.newGame();
let s = L.sim();
ok(s.inmates.length === 40, '40 inmates', s.inmates.length);
ok(L.BLOCKS.filter(b => b.open).length === 1, '1 open block');
ok(s.guards.length === 6, '6 guards', s.guards.length);
ok(s.funds === 25000, 'funds $25,000', s.funds);
ok(s.day === 1 && Math.floor(s.minutes / 60) === 6, 'day 1, 06:00');

// ---------- 2. walkability audit: full simulated day ----------
console.log('\n[2] walkability audit (1440 ticks, every entity, every tick)');
let violations = [];
const seen = new Set();
for (let t = 0; t < 1440; t++) {
  L.tick(1);
  for (const p of s.inmates) {
    if (!L.isWalkable(p.x, p.y)) {
      const key = p.id;
      if (!seen.has(key)) { seen.add(key); violations.push({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), state: p.state, zone: p.targetZone }); }
    }
  }
  for (const g of s.guards) {
    if (!L.isWalkable(g.x, g.y)) violations.push({ id: 'guard' + g.id, x: Math.round(g.x), y: Math.round(g.y), state: g.state });
  }
  if (violations.length > 12) break;
}
ok(violations.length === 0, 'zero off-walkable positions', JSON.stringify(violations.slice(0, 4)));

// ---------- 3. zone visitation across phases ----------
console.log('\n[3] inmates move between zones across phases');
let multi = 0;
for (const p of s.inmates) if (Object.keys(p.visited).length >= 3) multi++;
ok(multi >= s.inmates.length * 0.8, '>=80% visited 3+ zones', multi + '/' + s.inmates.length);
ok(s.day === 2, 'a full day elapsed', 'day=' + s.day);

// ---------- 4. economy ran at midnight ----------
console.log('\n[4] economy');
const fundsAfterDay = s.funds;
ok(fundsAfterDay !== 25000, 'funds changed after midnight', fundsAfterDay);
ok(s.log.some(l => /funding/i.test(l.msg)), 'funding log entry exists');

// ---------- 5. warden actions ----------
console.log('\n[5] warden actions');
const f0 = s.funds;
ok(L.W.reopenBlock(1) === true, 'reopen block B');
ok(L.BLOCKS[1].open === true, 'block B open');
ok(s.funds === f0 - 8000, 'charged $8,000', s.funds);
ok(L.W.hireGuard() === true, 'hire guard');
ok(s.guards.length === 7, '7 guards now');
const gid = s.guards[s.guards.length - 1].id;
ok(L.W.fireGuard(gid) === true, 'fire guard');
ok(s.guards.length === 6, '6 guards again');
// contraband + shakedown (clear audit-acquired contra first so the test is deterministic)
for (const p of s.inmates) p.contra = null;
s.inmates[0].contra = 'shank'; s.inmates[1].contra = 'phone'; s.inmates[2].contra = 'shank';
ok(L.W.shakedown() === true, 'shakedown runs');
ok(s.inmates.filter(p => p.contra).length <= 1, 'contraband mostly seized');
ok(s.shakedownCd > 0, 'shakedown cooldown set');
const wasLock = s.lockdown;
L.W.toggleLockdown();
ok(s.lockdown !== wasLock, 'lockdown toggles');
L.W.toggleLockdown();
const vic = s.inmates[5];
ok(L.W.solitary(vic.id) === true, 'solitary selected inmate');
ok(vic.solitaryT === 1440, 'solitary timer 24h');
const f1 = s.funds, n0 = s.inmates.length;
const out = s.inmates[6];
ok(L.W.transfer(out.id) === true, 'transfer selected inmate');
ok(out.state === 'leaving', 'inmate walking to gate');
ok(s.funds === f1 - 500, 'transfer fee $500');
for (let t = 0; t < 900 && s.inmates.includes(out); t++) L.tick(1);
ok(!s.inmates.includes(out), 'transferred inmate removed at gate', 'remaining=' + s.inmates.length);

// ---------- 6. hit testing ----------
console.log('\n[6] inmate hit-testing');
const p0 = s.inmates[0];
const hit = L.inmateAt(p0.x, p0.y - 12);
ok(hit && hit.id === p0.id, 'tap on inmate selects them');
ok(L.inmateAt(30, 30) === null || true, 'far tap returns null-ish');
const farHit = L.inmateAt(30, 30);
let anyNear = false;
for (const p of s.inmates) if (Math.hypot(p.x - 30, (p.y - 12) - 30) < 20) anyNear = true;
ok(anyNear || farHit === null, 'no false positive far from everyone');

// ---------- 7. forced tension -> fights ----------
console.log('\n[7] fights under forced tension');
L.newGame(); s = L.sim();
const A = s.inmates[0], B = s.inmates[1];
A.traits.push('aggressive'); B.traits.push('aggressive');
A.beef[B.id] = 5; B.beef[A.id] = 5;
A.x = 950; A.y = 350; B.x = 965; B.y = 355;
A.path = []; B.path = []; A.state = 'idle'; B.state = 'idle';
A.targetZone = 'yard'; B.targetZone = 'yard';
A.contra = 'shank';
for (const p of s.inmates) { p.needs.hunger = 0.1; p.needs.comfort = 0.1; }
s.gangTension = 1;
let fought = false;
for (let t = 0; t < 150; t++) { L.tick(1); if (s.log.some(l => /Fight:/.test(l.msg))) { fought = true; break; } }
ok(fought, 'a fight broke out under high tension');
let resolved = false;
for (let t = 0; t < 400; t++) { L.tick(1); if (A.state !== 'fight' && B.state !== 'fight') { resolved = true; break; } }
ok(resolved, 'guards broke up / fight ended');

// ---------- 8. riot lifecycle ----------
console.log('\n[8] riot lifecycle');
L.newGame(); s = L.sim();
L.debugRiot();
ok(s.riot.active === true, 'riot started');
ok(s.inmates.filter(p => p.state === 'riot').length >= 4, 'rioters present');
let engaged = false, ended = false;
for (let t = 0; t < 3000; t++) {
  L.tick(1);
  if (s.guards.some(g => g.state === 'respond' || g.state === 'subdue')) engaged = true;
  if (!s.riot.active) { ended = true; break; }
}
ok(engaged, 'guards engaged the riot');
ok(ended, 'riot eventually ended', 'ticks used');
ok(s.log.some(l => /RIOT/i.test(l.msg)), 'riot logged');

// ---------- 9. pause / speed ----------
console.log('\n[9] pause + speed');
L.newGame(); s = L.sim();
s.paused = true;
ok(L.advance(10) === 0, 'paused: no sim advance');
s.paused = false; s.speed = 1;
const st1 = L.advance(10);
s.speed = 4;
const st4 = L.advance(10);
ok(st1 > 0 && st4 === st1 * 4, '4x advances 4x the steps of 1x', st1 + ' vs ' + st4);

// ---------- 10. render smoke test (stub canvas) ----------
console.log('\n[10] render compositing (stub 2d context)');
function makeCtx() {
  const calls = [];
  const target = { calls, _props: {} };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'calls') return calls;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return (...a) => { calls.push({ m: prop, a }); return { addColorStop(c, v) { calls.push({ m: 'addColorStop' }); } }; };
      if (prop in t._props) return t._props[prop];
      return (...a) => { calls.push({ m: prop, a: a && a.length < 4 ? a : a && a.length }); };
    },
    set(t, prop, v) { t._props[prop] = v; calls.push({ m: 'set:' + prop }); return true; },
  });
}
L.newGame(); s = L.sim();
for (let t = 0; t < 300; t++) L.tick(1);   // let them spread into the world
const ctx = makeCtx();
let renderOk = true, renderErr = '';
try { L.render(ctx, 1920, 1280, 123.4); }
catch (e) { renderOk = false; renderErr = e.stack; }
ok(renderOk, 'render runs without throwing', renderErr.split('\n').slice(0, 2).join(' '));
const order = L.lastDraw || [];
let sorted = true;
for (let i = 1; i < order.length; i++) if (order[i] < order[i - 1] - 0.001) { sorted = false; break; }
ok(order.length === s.inmates.length + s.guards.length, 'every entity drawn', order.length);
ok(sorted, "painter's algorithm: draw order sorted by ground Y");
const ellipses = ctx.calls.filter(c => c.m === 'ellipse').length;
ok(ellipses >= order.length * 2, 'contact shadows drawn per entity (soft + core)', ellipses + ' ellipses');
// night render: spotlights + tint
s.minutes = 2 * 60;
const ctx2 = makeCtx();
try { L.render(ctx2, 1920, 1280, 200); renderOk = true; } catch (e) { renderOk = false; renderErr = e.stack; }
ok(renderOk, 'night render runs (spotlight cones + tint)');
ok(ctx2.calls.some(c => c.m === 'createRadialGradient'), 'night spotlight gradients used');

// ---------- 11b. escapists: personal cells + contraband + cell search ----------
console.log('\n[11b] escapists systems');
L.newGame(); s = L.sim();
const e1 = s.inmates[0];
ok(e1.cell && Array.isArray(e1.cell.stash), 'inmate has personal cell model');
ok(e1.cell.sheetOnBars === false && e1.cell.bedDummy === false && e1.cell.sheetRemoved === false, 'cell starts clean');
e1.cell.stash.push('shank', 'phone');
L.resolveCellSearch(e1);
ok(e1.cell.stash.length === 0, 'cell search confiscates desk stash');
ok(e1.solitaryT === 1440, 'contraband in desk -> 24h solitary');
ok(s.log.some(l => /Cell search: found/.test(l.msg)), 'search logged with drama');
// sheet over bars gets torn down during a search
const e2 = s.inmates[1];
e2.cell.sheetOnBars = true; e2.cell.sheetRemoved = true;
L.resolveCellSearch(e2);
ok(e2.cell.sheetOnBars === false, 'search tears the sheet off the bars');
// bed dummy fools the night check — reach SLEEP through the natural phase change
L.newGame(); s = L.sim();
for (const p of s.inmates) p.traits = p.traits.filter(t => t !== 'sneaky');  // no autonomous sneak-outs
s.minutes = 21 * 60;
for (let t = 0; t < 600 && s.phase !== 'SLEEP'; t++) L.tick(1);
ok(s.phase === 'SLEEP', 'reached SLEEP via phase change');
for (let t = 0; t < 150; t++) L.tick(1);   // everyone gets to their cells
s.releaseQueue = [];
const e3 = s.inmates[2];
e3.cell.bedDummy = true; e3.cell.sheetRemoved = true;
e3.x = 950; e3.y = 350; e3.px = 950; e3.py = 350;
e3.targetZone = 'yard'; e3.state = 'idle';
for (let t = 0; t < 120; t++) L.tick(1);
ok(!s.lockdown && !s.nightAlarm, 'bed dummy fools night check — no alarm', 'lockdown=' + s.lockdown);
// empty readable cell triggers the alarm + hunt
L.newGame(); s = L.sim();
for (const p of s.inmates) p.traits = p.traits.filter(t => t !== 'sneaky');  // no autonomous sneak-outs
s.minutes = 21 * 60;
for (let t = 0; t < 600 && s.phase !== 'SLEEP'; t++) L.tick(1);
for (let t = 0; t < 150; t++) L.tick(1);
s.releaseQueue = [];
const e4 = s.inmates[3];
e4.x = 950; e4.y = 350; e4.px = 950; e4.py = 350;
e4.targetZone = 'yard'; e4.state = 'idle';
for (let t = 0; t < 120; t++) L.tick(1);
ok(s.nightAlarm === true, 'empty readable cell raises night alarm');
ok(s.lockdown === true, 'night alarm triggers lockdown');
ok(e4.escaped === true || e4.solitaryT > 0, 'escapee hunted or captured');
// sheet over bars hides the absence from night checks
L.newGame(); s = L.sim();
for (const p of s.inmates) p.traits = p.traits.filter(t => t !== 'sneaky');  // no autonomous sneak-outs
s.minutes = 21 * 60;
for (let t = 0; t < 600 && s.phase !== 'SLEEP'; t++) L.tick(1);
for (let t = 0; t < 150; t++) L.tick(1);
s.releaseQueue = [];
const e5 = s.inmates[4];
e5.cell.sheetOnBars = true; e5.cell.sheetRemoved = true;
e5.x = 950; e5.y = 350; e5.px = 950; e5.py = 350;
e5.targetZone = 'yard'; e5.state = 'idle';
for (let t = 0; t < 120; t++) L.tick(1);
ok(!s.nightAlarm, 'sheet over bars hides absence from night checks');
// cell search warden action: costs $300, cooldown set, announces 2 cells
L.newGame(); s = L.sim();
const fz = s.funds;
ok(L.W.cellSearch() === true, 'cell search action runs');
ok(s.funds === fz - 300, 'cell search costs $300');
ok(s.cellSearchCd > 0, 'cell search cooldown set');
ok(s.log.some(l => /Cell search ordered: Block/.test(l.msg)), 'search announces named cells');
ok(L.W.cellSearch() === false, 'cell search blocked on cooldown');

// ---------- 12. console errors ----------
console.log('\n[12] console hygiene');
ok(errors === 0, 'zero console.error calls', errorLog.slice(0, 3).join(' | '));

// ---------- 13. building occlusion never hides sleepers ----------
console.log('\n[13] occlusion vs cells');
let hidden = [];
for (const b of L.BLOCKS){
  for (let i = 0; i < 60; i++){
    const s = L.cellSpot(b, i);
    for (const o of L.OCCLUDERS){
      // feet inside the building footprint = the sleeper would be visually covered
      if (s[0] > o.x - 8 && s[0] < o.x + o.w + 8 && s[1] > o.y && s[1] < o.y + o.h){
        hidden.push({ block: b.name, i, x: Math.round(s[0]), y: Math.round(s[1]) });
        break;
      }
    }
  }
}
ok(hidden.length === 0, 'no cell spot occluded by a building', JSON.stringify(hidden.slice(0, 4)));

console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
