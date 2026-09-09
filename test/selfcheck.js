// Self-check for the PaceCore block in index.html. Run: node test/selfcheck.js
// Feeds the synthetic sequences from SPEC.md section 4 plus the GPX fixture. Exits 1 on any failure.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const sandbox = { module: { exports: {} } };
vm.runInNewContext(src, sandbox);
const PaceCore = sandbox.module.exports;
const VT = 1000 / 232;

// feed a list of [duration_s, speed] segments at 1 Hz; returns per-fix records
function replay(core, segments, opts = {}) {
  const out = []; let t = opts.t0 ?? 1000;
  for (const [dur, speed] of segments) {
    for (let i = 0; i < dur; i++, t++) {
      const r = core.onFix({ t, lat: 60 + t * 4e-5, lon: -30, speed, acc: opts.acc ?? 8 }, t);
      out.push({ t, speed, v: core.s.v, state: core.s.state, events: r.events, accepted: r.accepted });
    }
  }
  return out;
}
let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

check('auto-start: go on 3rd consecutive at-pace fix, t0 back-dated to the first', () => {
  const core = PaceCore.create();
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.4 - 2.0) * i / 19]);
  const rec = replay(core, [...ramp, [60, 4.4]]);
  const goIdx = rec.findIndex(r => r.events.includes('go'));
  assert(goIdx > 0, 'no go event');
  // independent expectation: first run of 3 consecutive v >= VT after ARMED (3 fixes)
  let run = 0, expectGo = -1;
  for (let i = 3; i < rec.length; i++) { run = rec[i].v >= VT ? run + 1 : 0; if (run === 3) { expectGo = i; break; } }
  assert.strictEqual(goIdx, expectGo, `go at fix ${goIdx}, expected ${expectGo}`);
  assert.strictEqual(core.s.t0, rec[goIdx - 2].t, 't0 not back-dated to first of the three');
  assert.strictEqual(core.s.state, 'RUNNING');
  console.log(`     go at ${goIdx - 20} s into the hold (ramp is 20 s), t0 = ${core.s.t0 - rec[0].t} s after first fix`);
});

check('tones: +5% silent, +12% rising, -1% falling, -10% falling every 1 s, +20% rising every 1 s', () => {
  const c = PaceCore.DEF;
  assert.strictEqual(PaceCore.toneFor(0.05, c), null);
  assert.strictEqual(PaceCore.toneFor(0.12, c).kind, 'rise');
  assert.strictEqual(PaceCore.toneFor(0.12, c).period, 2);
  assert.strictEqual(PaceCore.toneFor(-0.01, c).kind, 'fall');
  assert.strictEqual(PaceCore.toneFor(-0.10, c).period, 1);
  assert.strictEqual(PaceCore.toneFor(0.20, c).period, 1);
  assert.strictEqual(PaceCore.toneFor(0.0, c), null);
  assert.strictEqual(PaceCore.toneFor(-0.015, { ...c, underTol: 0.02 }), null);
  // glide: 20% off = one octave either side
  assert(Math.abs(PaceCore.glideHz(0.2, c) - 1200) < 1e-6);
  assert(Math.abs(PaceCore.glideHz(-0.2, c) - 300) < 1e-6);
  assert(PaceCore.glideHz(-0.005, c) < 600 && PaceCore.glideHz(0.005, c) > 600, 'glide floor keeps direction');
});

check('stop rule: no end during a 15 s stop, end ~46 s after EMA reaches half speed, held_s ~135', () => {
  const core = PaceCore.create();
  const rec = replay(core, [[60, 4.4], [15, 0], [60, 4.4], [120, 2.0]]);
  const endIdx = rec.findIndex(r => r.events.includes('end'));
  assert(endIdx > 0, 'never ended');
  assert(endIdx >= 135, `ended during the stop, at fix ${endIdx}`);
  const intoLast = endIdx - 135;
  // EMA needs ~8 s to fall from 4.4 to 2.15, then 46 s of slow time
  assert(intoLast >= 46 && intoLast <= 60, `ended ${intoLast} s into the last segment`);
  const r = core.s.result;
  assert(r.held_s >= 132 && r.held_s <= 146, `held_s ${r.held_s}`);
  assert.strictEqual(r.reason, 'auto');
  assert(r.on_pace_s > 100 && r.on_pace_s < 130, `on_pace_s ${r.on_pace_s}`);
  console.log(`     end ${intoLast} s into the 2.0 m/s segment, held_s ${r.held_s.toFixed(1)}, on_pace_s ${r.on_pace_s.toFixed(1)}, dist ${r.dist_m.toFixed(0)} m`);
});

check('road crossing: 20 s stop then resume does not end and slow counter resets', () => {
  const core = PaceCore.create();
  replay(core, [[30, 4.4], [20, 0], [30, 4.4]]);
  assert.strictEqual(core.s.state, 'RUNNING');
  assert.strictEqual(core.s.slowS, 0, 'slow counter not reset after resume');
  assert.strictEqual(core.s.tSlow0, null);
});

check('ramp timeout: warning at 60 s in RAMP, never auto-ends', () => {
  const core = PaceCore.create();
  const rec = replay(core, [[130, 2.0]]);
  const warns = rec.filter(r => r.events.includes('warn')).map(r => r.t - rec[0].t);
  assert.deepStrictEqual(warns, [62, 122], `warns at ${warns}`);   // 3 fixes ARMED then 60 s
  assert.strictEqual(core.s.state, 'RAMP');
});

check('gate: bad accuracy, null speed without position, and out-of-order fixes are ignored, not zero', () => {
  const core = PaceCore.create();
  replay(core, [[10, 4.4]]);
  const v = core.s.v;
  assert.strictEqual(core.onFix({ t: 2000, speed: 0, acc: 50 }, 2000).accepted, false);
  assert.strictEqual(core.onFix({ t: 2001, speed: null, acc: 5 }, 2001).accepted, false);
  assert.strictEqual(core.onFix({ t: 1009, speed: 0, acc: 5 }, 2002).accepted, false);   // same timestamp as the last accepted fix
  assert.strictEqual(core.onFix({ t: 1005, speed: 0, acc: 5 }, 2003).accepted, false);   // earlier than it
  assert.strictEqual(core.s.v, v, 'rejected fix changed the EMA');
});

check('timekeeping: results depend only on fix timestamps, not on the phone clock', () => {
  const a = PaceCore.create(), b = PaceCore.create();
  const segs = [[40, 4.4], [80, 2.0]];
  let t = 5000;
  for (const [dur, speed] of segs) for (let i = 0; i < dur; i++, t++) {
    a.onFix({ t, speed, acc: 8 }, t);            // phone clock equals GPS time
    b.onFix({ t, speed, acc: 8 }, t + 37.25);    // phone clock 37 s ahead of GPS time
  }
  assert.strictEqual(a.s.state, 'END'); assert.strictEqual(b.s.state, 'END');
  assert.strictEqual(a.s.result.held_s, b.s.result.held_s);
  assert.strictEqual(a.s.result.on_pace_s, b.s.result.on_pace_s);
  assert.strictEqual(a.s.result.t0, b.s.result.t0);
  assert.strictEqual(a.s.result.t_end, b.s.result.t_end);
});

check('dropout: tick reports it once, gap freezes counters, ramp timer pauses', () => {
  const core = PaceCore.create();
  replay(core, [[30, 4.4]]);
  const dist = core.s.dist, held0 = core.s.t0;
  assert.strictEqual(core.tick(1030 + 3), null);
  assert.strictEqual(core.tick(1030 + 6), 'dropout');
  assert.strictEqual(core.tick(1030 + 7), null, 'dropout reported twice');
  core.onFix({ t: 1050, speed: 4.4, acc: 8 }, 1050);            // 20 s gap
  assert.strictEqual(core.s.dropped, false);
  assert.strictEqual(core.s.dist, dist, 'gap added distance');
  assert.strictEqual(core.s.t0, held0);
  const c2 = PaceCore.create();
  replay(c2, [[30, 2.0]]);                                        // RAMP, 27 s in
  c2.onFix({ t: 1030 + 20, speed: 2.0, acc: 8 });                 // 20 s gap
  const rec = replay(c2, [[40, 2.0]], { t0: 1051 });
  const warnT = rec.find(r => r.events.includes('warn'))?.t;
  assert.strictEqual(warnT, 1083, `warn at ${warnT}; 27 s RAMP before the gap + 33 s after = 60 s`);
});

check('stillness: drifting fixes while standing read as speed 0, walking and running do not', () => {
  const core = PaceCore.create();
  replay(core, [[20, 4.4]]);                                        // moving 4.45 m per fix
  assert.strictEqual(core.s.still, false);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let t = 1020; t < 1040; t++)                                 // stand still, GPS drifts up to about 1.5 m
    core.onFix({ t, lat: 60.0408 + rnd() * 2.7e-5, lon: -30 + rnd() * 5.4e-5, speed: 0.4 + rnd() * 0.8, acc: 8 }, t);
  assert.strictEqual(core.s.still, true, 'not detected as still');
  assert(core.s.v < 0.05, `smoothed speed ${core.s.v} while standing`);
  assert.strictEqual(core.s.log[core.s.log.length - 1].speed > 0, true, 'raw speed must stay in the log');
  const walk = PaceCore.create();
  let t = 1000, lat = 60;
  for (; t < 1020; t++) { lat += 1.3 / 111000; walk.onFix({ t, lat, lon: -30, speed: 1.3, acc: 8 }, t); }
  assert.strictEqual(walk.s.still, false, 'walking flagged as still');
  assert(walk.s.v > 1.2);
});

check('manual finish: held_s counts to last fix, reason manual', () => {
  const core = PaceCore.create();
  replay(core, [[50, 4.4]]);
  const r = core.finish(1060);
  assert.strictEqual(r.reason, 'manual');
  assert(Math.abs(r.held_s - (1049 - core.s.t0)) < 1e-9, `held_s ${r.held_s}`);
  assert.strictEqual(core.s.state, 'END');
  assert.strictEqual(core.onFix({ t: 1061, speed: 4, acc: 5 }, 1061).events.length, 0);
});

check('splits: km times from integrated distance', () => {
  const core = PaceCore.create({ targetSec: 250 });
  replay(core, [[600, 4.0]]);                                       // 4 m/s = 250 s/km
  const r = core.finish(1600);
  assert.strictEqual(r.splits.length, 2, `splits ${JSON.stringify(r.splits)}`);
  assert(r.splits.every(x => Math.abs(x.s - 250) <= 2), `splits ${JSON.stringify(r.splits)}`);
});

check('fixture: cooper-fixture.gpx replayed with position-differenced speed', () => {
  const gpx = fs.readFileSync(path.join(__dirname, 'cooper-fixture.gpx'), 'utf8');
  const pts = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">[\s\S]*?<time>([^<]+)<\/time>/g)]
    .map(m => ({ lat: +m[1], lon: +m[2], t: Date.parse(m[3]) / 1000 }));
  assert.strictEqual(pts.length, 197);
  let raw = 0; for (let i = 1; i < pts.length; i++) raw += PaceCore.haversine(pts[i - 1], pts[i]);
  assert(Math.abs(raw - 2737.2) < 1, `haversine total ${raw.toFixed(1)} m, fixture README says 2737.2`);
  // The run averaged 4:23/km and its first two 400 m took 97.8 and 96.6 s (target 92.9 s), so at
  // 3:52/km the auto-start is late and little time is on pace; at 4:10/km it starts within 40 s.
  function run(targetSec) {
    const core = PaceCore.create({ targetSec });
    let go = null;
    for (const p of pts) { const r = core.onFix({ ...p, speed: null, acc: 10 }, p.t); if (r.events.includes('go')) go = p.t - pts[0].t; }
    assert.strictEqual(core.s.state, 'RUNNING', 'fixture must not auto-end (never falls to half speed)');
    const r = core.finish(pts[pts.length - 1].t);
    const gaps = r.log.filter(e => e.gap).length, rejected = r.log.filter(e => !e.ok).length;
    console.log(`     target ${targetSec} s/km: go at ${go} s, held ${r.held_s.toFixed(0)} s, on pace ${r.on_pace_s.toFixed(0)} s, dist ${r.dist_m.toFixed(0)} m from t0, ${gaps} gap(s) > 5 s, ${rejected} rejected, splits ${r.splits.map(x => x.s).join('/')} s`);
    return { go, r };
  }
  const a = run(232);
  assert(a.go > 100, `3:52 target started at ${a.go} s; the fixture never holds that pace early`);
  assert(a.r.on_pace_s < 200, `on_pace_s ${a.r.on_pace_s}`);
  const b = run(250);
  assert(b.go != null && b.go <= 45, `4:10 target auto-start at ${b.go} s`);
  assert(b.r.dist_m > 2737 * 0.85 && b.r.dist_m < 2737 * 1.02, `dist ${b.r.dist_m.toFixed(0)}`);
  assert.strictEqual(b.r.splits.length, 2);
  // README splits are haversine from the very first point; ours integrate smoothed speed from t0 and the
  // five 6 s sample gaps are frozen by the gap rule (about 25 m each), so allow 8 %.
  assert(Math.abs(b.r.splits[0].s - 242) < 20 && Math.abs(b.r.splits[1].s - 268) < 22, `km splits ${JSON.stringify(b.r.splits)} vs README 242/268`);
});

console.log(`\n${pass} passed${process.exitCode ? ', with failures' : ''}`);
