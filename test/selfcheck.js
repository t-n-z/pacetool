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

check('auto-start: the clock starts after 3 s at pace and is back-dated to the first of them', () => {
  const core = PaceCore.create();
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.4 - 2.0) * i / 19]);
  const rec = replay(core, [...ramp, [60, 4.4]]);
  const goIdx = rec.findIndex(r => r.events.includes('go'));
  assert(goIdx > 0, 'no go event');
  // independent expectation: the first fix at or above target, then startHold seconds of it
  const firstAt = rec.findIndex((r, i) => i >= 3 && r.v >= VT);
  assert(firstAt > 0, 'never reached target in the replay');
  assert.strictEqual(core.s.t0, rec[firstAt].t, 't0 must be the FIRST second at pace, not the confirmed one');
  assert.strictEqual(rec[goIdx].t - core.s.t0, PaceCore.DEF.startHold, 'go fired at the wrong time');
  assert.strictEqual(core.s.state, 'RUNNING');
  assert.strictEqual(core.armCountdown(rec[goIdx].t), null, 'the countdown must clear once running');
  // the countdown itself: 3, 2, 1, and never 0
  const solo = PaceCore.create();
  replay(solo, ramp);
  const shown = [];
  let ts = solo.s.lastT;
  while (solo.s.state === 'RAMP' && ts < solo.s.lastT + 40) {
    ts++;
    solo.onFix({ t: ts, lat: 60 + ts * 4e-5, lon: -30, speed: 4.6, acc: 8 }, ts);
    const n = solo.armCountdown(ts);
    if (n != null) shown.push(n);              // only once the smoothed pace has actually arrived
  }
  assert.deepStrictEqual(shown, [3, 2, 1], `countdown showed ${JSON.stringify(shown)}`);
  assert.strictEqual(solo.s.state, 'RUNNING');
  console.log(`     go ${rec[goIdx].t - core.s.t0} s after first touching target, t0 back-dated ${rec[goIdx].t - core.s.t0} s`);
});

check('auto-start: dropping under target restarts the countdown', () => {
  const core = PaceCore.create();
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.4 - 2.0) * i / 19]);
  replay(core, ramp);
  let t = core.s.lastT;
  while (core.armCountdown(t) == null && t < core.s.lastT + 40) {    // run on until the pace registers
    t++;
    core.onFix({ t, lat: 60 + t * 4e-5, lon: -30, speed: 4.6, acc: 8 }, t);
  }
  assert.strictEqual(core.armCountdown(t), 3, 'the countdown should start at 3');
  const attempt1 = core.s.atpaceT;
  core.onFix({ t: ++t, lat: 60 + t * 4e-5, lon: -30, speed: 0.5, acc: 8 }, t);   // fell away
  assert.strictEqual(core.armCountdown(t), null, 'the countdown must clear when pace is lost');
  assert.strictEqual(core.s.state, 'RAMP');
  for (let k = 0; k < 25 && core.s.state === 'RAMP'; k++) { t++; core.onFix({ t, lat: 60 + t * 4e-5, lon: -30, speed: 5.2, acc: 8 }, t); }
  assert.strictEqual(core.s.state, 'RUNNING', 'never restarted');
  assert(core.s.t0 > attempt1, 't0 must come from the second attempt, not the first');
});


check('tones: silent inside both tolerances, rising above +10%, falling below -10%, 1 s when far out', () => {
  const c = PaceCore.DEF;                                  // defaults: 10% either side
  assert.strictEqual(PaceCore.toneFor(0.05, c), null);
  assert.strictEqual(PaceCore.toneFor(-0.05, c), null, 'inside the slow tolerance must be silent');
  assert.strictEqual(PaceCore.toneFor(0.0, c), null);
  assert.strictEqual(PaceCore.toneFor(0.12, c).kind, 'rise');
  assert.strictEqual(PaceCore.toneFor(0.12, c).period, 2);
  assert.strictEqual(PaceCore.toneFor(-0.12, c).kind, 'fall');
  assert.strictEqual(PaceCore.toneFor(-0.12, c).period, 1);   // already past the 10% "far out" mark
  assert.strictEqual(PaceCore.toneFor(0.20, c).period, 1);
  assert.strictEqual(PaceCore.toneFor(-0.01, { ...c, underTol: 0 }).kind, 'fall');   // zero tolerance still works
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

check('tone hold: one stray fix never changes the tone, three consecutive do', () => {
  const core = PaceCore.create();                      // toneHold 3 by default
  replay(core, [[20, 4.4], [30, 4.4]]);                // running, silent (between target and +10%)
  assert.strictEqual(core.s.state, 'RUNNING');
  assert.strictEqual(core.toneNow(), null, 'tone before any sustained deviation');
  let t = core.s.lastT;
  core.onFix({ t: ++t, lat: 60.1, lon: -30, speed: 3.0, acc: 8 }, t);     // one slow fix
  assert.strictEqual(core.toneNow(), null, 'a single slow fix played a tone');
  replay(core, [[30, 4.4]], { t0: ++t });                                  // back on pace
  assert.strictEqual(core.toneNow(), null);
  const rec = replay(core, [[10, 3.4]], { t0: core.s.lastT + 1 });         // a real fade, 3 fixes in
  assert.strictEqual(rec[2].v < VT, true);
  assert.strictEqual(core.toneNow().kind, 'fall', 'sustained slow did not latch the falling tone');
  const fast = PaceCore.create({ toneHold: 0 });                           // 0 = react to every fix
  replay(fast, [[20, 4.4], [20, 5.6]]);
  assert.strictEqual(fast.toneNow().kind, 'rise');

  // The hold is a time, not a count: a phone giving one fix every 4 s must not turn 3 s into 12 s.
  const slow = PaceCore.create();
  let ts = 5000;
  for (let i = 0; i < 12; i++, ts += 4) slow.onFix({ t: ts, lat: 60 + i * 1.7e-4, lon: -30, speed: 4.4, acc: 8 }, ts);
  assert.strictEqual(slow.s.state, 'RUNNING');
  const before = slow.s.lastT;
  for (let i = 0; i < 2; i++, ts += 4) slow.onFix({ t: ts, lat: 61 + i * 1.3e-4, lon: -30, speed: 3.4, acc: 8 }, ts);
  assert.strictEqual(slow.toneNow().kind, 'fall', 'two fixes over 4 s apart should already satisfy a 3 s hold');
  assert(slow.s.lastT - before <= 8, 'latched later than two fixes');
});

check('target entry: digits shift in from the right, seconds past 59 carry into minutes', () => {
  const t = raw => PaceCore.paceDigits(raw).text;
  assert.strictEqual(t('3'), '0:03');
  assert.strictEqual(t('35'), '0:35');
  assert.strictEqual(t('352'), '3:52');      // 3, 5, 2 typed in order
  assert.strictEqual(t('3525'), '35:25');    // a fourth digit pushes the rest left
  assert.strictEqual(t('365'), '4:05');      // 3:65 carries
  assert.strictEqual(t('3:65'), '4:05');     // whatever is in the field, digits only
  assert.strictEqual(t('9999'), '99:59');    // clamped, never wraps to a small number
  assert.strictEqual(t(''), '');
  assert.strictEqual(PaceCore.paceDigits('').sec, null);
  assert.strictEqual(PaceCore.paceDigits('352').sec, 232);
  assert.strictEqual(PaceCore.paceDigits('35').digits, '35');   // re-feeding the text is stable
  assert.strictEqual(t(PaceCore.paceDigits('352').text), '3:52');
});

check('a loose tolerance moves the tones only, never the clock or the recorded time', () => {
  const loose = PaceCore.create({ underTol: 0.10 }), strict = PaceCore.create({ underTol: 0 });
  const segs = [[10, 2.0], [40, VT * 0.95], [40, VT * 1.02]];   // 40 s just under target, then just over
  for (const core of [loose, strict]) replay(core, segs);
  assert.strictEqual(loose.s.t0, strict.s.t0, 'auto-start moved with the tolerance');
  assert.strictEqual(Math.round(loose.s.onPace), Math.round(strict.s.onPace), 'time on pace moved with the tolerance');
  assert(loose.s.onPace < 45, `on pace ${loose.s.onPace}s: the 95% segment must not count`);
  assert.strictEqual(PaceCore.toneFor(-0.05, loose.c), null);          // but the tone is quiet
  assert.strictEqual(PaceCore.toneFor(-0.05, strict.c).kind, 'fall');
});

check('countdown: ends the run at the limit, held time capped, no countdown when unset', () => {
  const core = PaceCore.create({ limitS: 60 });
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.4 - 2.0) * i / 19]);
  const rec = replay(core, [...ramp, [120, 4.4]]);
  const endIdx = rec.findIndex(r => r.events.includes('end'));
  assert(endIdx > 0, 'countdown never ended the run');
  assert.strictEqual(core.s.result.reason, 'timer');
  assert.strictEqual(core.s.result.t_end - core.s.result.t0, 60, 'ended off the limit');
  assert.strictEqual(core.s.result.held_s, 60, `held_s ${core.s.result.held_s}, must equal the countdown`);
  assert.strictEqual(core.s.result.limit_s, 60);
  // Fixes that do not divide the countdown: the fix that trips it lands PAST the end, which is the
  // only case where the cap does anything. Without the cap this records 63 s of a 60 s countdown.
  const sparse = PaceCore.create({ limitS: 60 });
  let st = 2000;
  for (let i = 0; i < 40; i++, st += 7) sparse.onFix({ t: st, lat: 60 + i * 3.1e-4, lon: -30, speed: 4.5, acc: 8 }, st);
  assert.strictEqual(sparse.s.result.reason, 'timer');
  assert.strictEqual(sparse.s.result.held_s, 60, `held_s ${sparse.s.result.held_s} with fixes 7 s apart`);
  assert.strictEqual(sparse.s.result.t_end - sparse.s.result.t0, 60);
  const none = PaceCore.create();
  replay(none, [...ramp, [120, 4.4]]);
  assert.strictEqual(none.s.state, 'RUNNING', 'a run with no countdown must not end');
  assert.strictEqual(none.remaining(1e9), null, 'no countdown means no remaining time');
  const waiting = PaceCore.create({ limitS: 720 });
  assert.strictEqual(waiting.remaining(1e9), 720, 'before the clock starts the whole countdown remains');
});

check('countdown: still ends when GPS stops, and counts down on the phone clock', () => {
  const core = PaceCore.create({ limitS: 60 });
  let t = 1000, wall = 5000;                       // phone clock deliberately offset from GPS time
  const feed = (speed, n) => { for (let i = 0; i < n; i++, t++, wall++) core.onFix({ t, lat: 60 + t * 4e-5, lon: -30, speed, acc: 8 }, wall); };
  feed(4.4, 25);
  assert.strictEqual(core.s.state, 'RUNNING');
  const atStart = core.remaining(wall);
  assert(atStart > 30 && atStart <= 60, `remaining ${atStart} just after the start`);
  assert.strictEqual(core.tick(wall + 3), null, 'ended early');   // 3 s: inside the dropout window too
  const r30 = core.remaining(wall + 30);           // fixes have stopped: the display must keep counting
  assert(Math.abs(r30 - (atStart - 30)) < 1.5, `countdown froze while fixes were not arriving: ${r30} vs ${atStart - 30}`);
  assert.strictEqual(core.tick(wall + 600), 'limit', 'GPS stopped and the countdown never fired');
  assert.strictEqual(core.s.result.reason, 'timer');
  assert.strictEqual(core.s.result.t_end - core.s.result.t0, 60);
  assert.strictEqual(core.remaining(wall + 600), 0, 'remaining must read zero once it has ended');
});

check('chart: paths span the run, break at gaps, and the target line sits inside the box', () => {
  const core = PaceCore.create();
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.4 - 2.0) * i / 19]);
  replay(core, [...ramp, [60, 4.4]]);
  const t = core.s.lastT + 30;                                        // a 30 s hole: no fixes at all
  for (let i = 0; i < 30; i++) core.onFix({ t: t + i, lat: 61 + i * 4e-5, lon: -30, speed: 3.6, acc: 8 }, t + i);
  const r = core.finish(core.s.lastT);
  const c = PaceCore.chartPaths(r, 340, 190);
  assert(c, 'no chart from a run with 110 fixes');
  const moves = (c.smooth.match(/M/g) || []).length;
  assert.strictEqual(moves, 2, `line should break once at the gap, got ${moves} segments`);
  assert(c.smooth.includes('L'), 'no drawn segments');
  const xs = [...c.smooth.matchAll(/[ML]([\d.]+) /g)].map(m => +m[1]);
  const ys = [...c.smooth.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(m => +m[1]);
  assert(Math.min(...xs) >= c.m.l - 0.1 && Math.max(...xs) <= 340 - c.m.r + 0.1, 'x outside the plot box');
  assert(Math.min(...ys) >= c.m.t - 0.1 && Math.max(...ys) <= 190 - c.m.b + 0.1, 'y outside the plot box');
  assert(c.targetY > c.m.t && c.targetY < 190 - c.m.b, 'target line outside the plot box');
  assert(c.startX != null && c.startX >= c.m.l, 'no mark for where the clock started');
  assert(c.yTicks.length > 0 && c.yTicks.every(tk => /^\d+:\d\d$/.test(tk.label)), 'y axis must be labelled in pace');
  assert(c.xTicks.length > 1);
  // faster must plot higher: find the fastest and slowest logged points
  const pts = r.log.filter(e => e.ok && e.v != null);
  const fast = pts.reduce((a, b) => (b.v > a.v ? b : a)), slow = pts.reduce((a, b) => (b.v < a.v ? b : a));
  const yOf = e => { const i = pts.indexOf(e); return ys[i] ?? null; };
  if (yOf(fast) != null && yOf(slow) != null) assert(yOf(fast) < yOf(slow), 'faster must be higher on the chart');
  // The scale must come from the target, not from the extremes of the data: one accepted GPS spike
  // or the stop at the end of every run would otherwise squash the whole run around the target line.
  const mk = extra => {
    const c2 = PaceCore.create();
    replay(c2, [...Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.5 - 2.0) * i / 19]), [60, 4.5]]);
    if (extra) { const tt = c2.s.lastT + 1; c2.onFix({ t: tt, lat: 61, lon: -30, speed: 7.9, acc: 8 }, tt); }
    const tail = c2.s.lastT + 1;
    for (let i = 0; i < 60; i++) c2.onFix({ t: tail + i, lat: 62, lon: -30, speed: 0.2, acc: 8 }, tail + i);
    return PaceCore.chartPaths(c2.s.result ?? c2.finish(c2.s.lastT), 340, 190);
  };
  const plain = mk(false), spiked = mk(true);
  assert(Math.abs(plain.targetY - spiked.targetY) < 0.2, 'one fast fix moved the whole scale');
  const yAt = c2 => +[...c2.smooth.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(m => +m[1])[30];
  assert(Math.abs(yAt(plain) - yAt(spiked)) < 1, 'an outlier squashed the rest of the run');
  const box = 190 - plain.m.t - plain.m.b;
  assert(Math.abs(yAt(plain) - plain.targetY) < box * 0.25, 'the on-pace line should sit near the target line');
  assert(plain.targetY > box * 0.25 && plain.targetY < box * 0.9, 'the target line should sit inside the plot, not at an edge');
  // the axis must be labelled for slow targets too, not only fast ones
  const walker = PaceCore.create({ targetSec: 1200 });
  let ts = 3000;
  for (let i = 0; i < 40; i++, ts++) walker.onFix({ t: ts, lat: 60 + i * 7.5e-6, lon: -30, speed: 0.85, acc: 8 }, ts);
  const cs = PaceCore.chartPaths(walker.finish(ts), 340, 190);
  assert(cs && cs.yTicks.length > 0, 'a 20:00/km target drew an axis with no labels');
  assert.strictEqual(PaceCore.chartPaths({ log: [], target_s_per_km: 232 }, 340, 190), null, 'empty run must not draw');
  assert.strictEqual(PaceCore.chartPaths({ target_s_per_km: 232 }, 340, 190), null, 'a run with no log must not draw');
});

check('voice: a marker every N metres, segment pace interpolated, phrase reads as speech', () => {
  const core = PaceCore.create({ voiceM: 100 });
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.5 - 2.0) * i / 19]);
  const rec = replay(core, [...ramp, [200, 4.5]]);           // 4.5 m/s: 100 m every 22.2 s
  const marks = rec.flatMap(r => r.events).filter(e => e && e.kind === 'mark');
  assert(marks.length >= 4, `only ${marks.length} markers in 200 s at target pace`);
  assert.deepStrictEqual(marks.slice(0, 4).map(m => m.total_m), [100, 200, 300, 400], 'markers must fall on multiples');
  assert.strictEqual(marks[0].first, true);
  assert.strictEqual(marks[1].first, false);
  for (const m of marks.slice(1)) {                           // at a steady target pace each 100 m is 23.2 s
    assert(Math.abs(m.seg_s - 22.2) < 2.5, `segment ${m.total_m} took ${m.seg_s.toFixed(1)}s, expected about 22.2`);
    assert(m.t > 0 && m.t <= core.s.lastT, 'marker time outside the run');
  }
  assert(Math.abs(marks.reduce((a, m) => a + m.seg_s, 0) - (marks[marks.length - 1].t - core.s.t0)) < 0.01,
    'segment times must add up to the time from the clock start to the last marker');
  // The spoken pace is per kilometre, not the segment's elapsed time: 500 m in 1:56 is a 3:52 pace.
  assert.strictEqual(PaceCore.markPhrase({ total_m: 500, seg_m: 500, seg_s: 116, first: true }),
    '500 metres, pace 3 minutes 52 seconds');
  assert.strictEqual(PaceCore.markPhrase({ total_m: 1000, seg_m: 500, seg_s: 122.5, first: false }),
    '1000 metres, 500 metre pace 4 minutes 5 seconds');       // spoken, so no leading zero on 05
  assert.strictEqual(PaceCore.markPhrase({ total_m: 1000, seg_m: 500, seg_s: 60.5, first: false }),
    '1000 metres, 500 metre pace 2 minutes 1 second');        // singular
  assert.strictEqual(PaceCore.markPhrase({ total_m: 400, seg_m: 400, seg_s: 48, first: true }),
    '400 metres, pace 2 minutes');                            // no "0 seconds"
  assert.strictEqual(PaceCore.markPhrase({ total_m: 100, seg_m: 100, seg_s: 22, first: true }),
    '100 metres, pace 3 minutes 40 seconds');                 // a short increment still speaks per km
  const silent = PaceCore.create();
  const rec2 = replay(silent, [...ramp, [200, 4.5]]);
  assert.strictEqual(rec2.flatMap(r => r.events).filter(e => e && e.kind === 'mark').length, 0,
    'no voice increment set, so nothing may be announced');
  assert.strictEqual(silent.finish(silent.s.lastT).marks.length, 0);
});

check('voice: one fix crossing several markers announces once, and the run carries its markers', () => {
  // Distance integrates the SMOOTHED speed, so at the 50 m minimum the page enforces, one fix can
  // never cross two markers. A 5 m increment and a 4 s gap between fixes can, which is what the
  // guard is for.
  const core = PaceCore.create({ voiceM: 5 });
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.5 - 2.0) * i / 19]);
  replay(core, [...ramp, [10, 4.5]]);
  assert.strictEqual(core.s.state, 'RUNNING');
  const before = core.s.marks.length;
  const t = core.s.lastT + 4;                                  // 4 s later: inside the 5 s dropout window
  const r = core.onFix({ t, lat: 60 + t * 4e-5, lon: -30, speed: 4.5, acc: 8 }, t);
  const announced = r.events.filter(e => e && e.kind === 'mark');
  assert(core.s.marks.length - before > 1, 'the test did not actually cross several markers');
  assert.strictEqual(announced.length, 1, 'one fix must not fire several announcements');
  assert.strictEqual(announced[0].total_m, core.s.marks[core.s.marks.length - 1].total_m, 'must announce the latest');
  const res = core.finish(core.s.lastT);
  assert.strictEqual(res.voice_m, 5);
  assert(res.marks.length > 1 && res.marks.every(m => m.total_m % 5 === 0), 'markers stored with the run');
  assert.deepStrictEqual(res.marks.map(m => m.total_m), res.marks.map((_, i) => (i + 1) * 5), 'markers must not skip');
});

check('a phone clock behind GPS time cannot shorten the recorded held time', () => {
  const core = PaceCore.create();
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.5 - 2.0) * i / 19]);
  replay(core, [...ramp, [120, 4.5]]);
  const truth = core.s.lastT - core.s.t0;
  const early = core.finish(core.s.lastT - 40);      // as a phone reading 40 s behind GPS time would
  assert.strictEqual(early.held_s, truth, `held_s ${early.held_s}, fix-time truth ${truth}`);
  const zero = PaceCore.create();
  replay(zero, [...ramp, [120, 4.5]]);
  assert.strictEqual(zero.finish(zero.s.t0 - 400).held_s, zero.s.lastT - zero.s.t0, 'a wildly wrong clock zeroed it');
});

check('the clear crosses are square, small, and every one of them is covered by the rule', () => {
  // Not a DOM test: this reads the stylesheet and the markup out of index.html. It exists because a
  // clear button was once styled by id alone, so a later row's cross fell back to the full-width
  // green button rule and crushed its field to 22 px on a phone.
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const rule = /([^{}]*Clear[^{}]*)\{([^}]*)\}/.exec(css);
  assert(rule, 'no style rule for the clear buttons');
  const selector = rule[1], body = rule[2];
  const decls = new Map(body.split(';').map(d => d.split(':')).filter(d => d.length === 2)
    .map(([k, v]) => [k.trim(), v.trim()]));
  const val = prop => decls.get(prop) ?? null;
  assert.strictEqual(val('width'), val('height'), `clear buttons are ${val('width')} by ${val('height')}, not square`);
  const px = parseFloat(val('width'));
  assert(px >= 44 && px <= 56, `${px}px: a cross should stay small but still be a comfortable tap target`);
  assert(/flex:\s*0 0/.test(body), 'without flex: 0 0 the cross stretches or shrinks with the row');
  // every clear button in the markup must be covered by that one selector
  const ids = [...html.matchAll(/<button id="(\w*Clear)"/g)].map(m => m[1]);
  assert(ids.length >= 3, `only ${ids.length} clear buttons found; the check needs updating`);
  for (const id of ids) assert(selector.includes('#' + id), `#${id} is not covered by the clear-button rule`);
});

check('every instruction block is collapsed behind its own i, and none is orphaned', () => {
  // The setup screen is short because the instructions are hidden behind small i buttons. This reads
  // index.html so a later setting cannot leave its text permanently on screen, or point an i at a
  // block that no longer exists.
  // markup only: the script also builds .hint divs for run data, which are not instructions
  const markup = html.slice(0, html.indexOf('<script id="core">'));
  const blocks = [...markup.matchAll(/<div class="[^"]*hint[^"]*"([^>]*)>/g)].map(m => m[1]);
  const ids = blocks.map(a => (/id="([^"]+)"/.exec(a) || [])[1]);
  assert(ids.length >= 7, `only ${ids.length} instruction blocks found`);
  for (let i = 0; i < blocks.length; i++) {
    if (ids[i] === 'support' || ids[i] === 'noRuns') {   // a warning and an empty-state line, not instructions
      if (ids[i] === 'support')
        assert(!/\bhidden\b/.test(blocks[i]), 'the support warning must stay visible');
      continue;
    }
    assert(ids[i], `an instruction block has no id: ${blocks[i]}`);
    assert(/\bhidden\b/.test(blocks[i]), `#${ids[i]} is not hidden, so its text is always on screen`);
    const buttons = [...markup.matchAll(new RegExp('data-for="' + ids[i] + '"', 'g'))];
    assert.strictEqual(buttons.length, 1, `#${ids[i]} has ${buttons.length} i buttons, expected exactly one`);
  }
  for (const m of markup.matchAll(/data-for="([^"]+)"/g))
    assert(ids.includes(m[1]), `an i points at #${m[1]}, which does not exist`);
  // the buttons must be real buttons that do not submit or steal the label's click
  for (const m of markup.matchAll(/<button class="info"([^>]*)>/g)) {
    assert(/type="button"/.test(m[1]), 'an i is missing type="button"');
    assert(/aria-expanded="false"/.test(m[1]), 'an i must start collapsed and say so');
    assert(/aria-label="[^"]+"/.test(m[1]), 'an i needs a label: "i" alone means nothing to a screen reader');
  }
  assert(markup.includes('<div id="setup">'), 'no setup screen');
});

check('every pace reads the same way, and a run averages over its own window', () => {
  assert.strictEqual(PaceCore.paceText(232), '3:52/km');
  assert.strictEqual(PaceCore.paceText(245), '4:05/km');        // leading zero here, unlike the voice
  assert.strictEqual(PaceCore.paceText(239.6), '4:00/km');      // rounds the total, never renders m:60
  assert.strictEqual(PaceCore.paceText(120), '2:00/km');
  assert.strictEqual(PaceCore.paceText(null), '--:--/km');
  assert.strictEqual(PaceCore.paceText(0), '--:--/km');
  assert.strictEqual(PaceCore.paceText(Infinity), '--:--/km');
  assert.strictEqual(PaceCore.paceText(5000), '--:--/km');      // slower than any real running pace
  // the average is the clock's own window over the distance covered in that window
  const core = PaceCore.create();
  const ramp = Array.from({ length: 20 }, (_, i) => [1, 2.0 + (4.5 - 2.0) * i / 19]);
  replay(core, [...ramp, [200, 4.5]]);
  const r = core.finish(core.s.lastT);
  const avg = PaceCore.avgPace(r);
  assert(Math.abs(avg - 1000 / 4.5) < 10, `averaged ${avg} s/km at a steady 4.5 m/s, expected about ${Math.round(1000 / 4.5)}`);
  assert(Math.abs(avg - (r.t_end - r.t0) / (r.dist_m / 1000)) < 1e-9, 'the average must use the run window, not a blend');
  assert.strictEqual(PaceCore.avgPace({ dist_m: 0, t0: 1, t_end: 2 }), null, 'no distance, no average');
  assert.strictEqual(PaceCore.avgPace(null), null);
  assert.strictEqual(PaceCore.paceText(PaceCore.avgPace({ dist_m: 0, t0: 1, t_end: 2 })), '--:--/km');
  // nothing that prints a recorded run may format a pace its own way
  const runStats = html.slice(html.indexOf('function showRun'), html.indexOf('// ---- simulator'));
  assert(!/fmtPace\(/.test(runStats), 'a run stat still formats its own pace instead of using paceText');
  assert((runStats.match(/paceText\(/g) || []).length >= 4, 'run stats should read their paces from one place');
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
  assert(r.splits.every(x => Math.abs(x.s - 250) <= 5), `splits ${JSON.stringify(r.splits)}`);
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
