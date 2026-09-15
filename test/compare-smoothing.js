// Compares pace-estimation variants on a synthetic run with realistic GPS noise, or on a real
// exported run: node test/compare-smoothing.js [exported-run.json]
//
// Why it exists: the first phone test said the pace number builds up slowly and drops on a couple
// of missteps. The question was whether to keep 1 Hz smoothing or switch to "decide the pace every
// X metres". This measures both instead of guessing. Metrics are printed as a table; the numbers
// behind every claim in README's "Smoothing, measured" section come from here.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(/<script id="core">([\s\S]*?)<\/script>/.exec(html)[1], sandbox);
const PaceCore = sandbox.module.exports;
const VT = 1000 / 232;                       // 4.31 m/s, the 3:52/km target

// ---- reproducible gaussian noise
let seed = 12345;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

// ---- truth profile, 1 Hz. Segments are [duration_s, speed_m_s], ramps interpolate.
const PROFILE = [
  { dur: 20, from: 2.0, to: VT },            // build-up
  { dur: 120, from: VT, to: VT },            // steady at target: the chirp window
  { dur: 30, from: VT * 0.94, to: VT * 0.94 },  // a real 6% fade: the falling tone should find it
  { dur: 90, from: VT, to: VT },
  { dur: 30, from: VT * 1.125, to: VT * 1.125 }, // a real surge past the +10% threshold
  { dur: 90, from: VT, to: VT },
  { dur: 20, from: 2.0, to: 2.0 }
];
const truth = [];
for (const seg of PROFILE)
  for (let i = 0; i < seg.dur; i++) truth.push(seg.from + (seg.to - seg.from) * (seg.dur > 1 ? i / (seg.dur - 1) : 0));
const N = truth.length;
const STEADY = [25, 140];                    // indices where truth sits exactly on target
const FADE = 140, SURGE = 260;               // indices where a real change begins

// ---- two measurement models.
// doppler: chipset velocity, white noise, a few percent (RESEARCH.md lane B estimate 0.2 to 0.4 m/s).
// posdiff: no chipset speed, so speed = distance/time between fixes. Position error is not white; it
// is an AR(1) wander with a time constant of about 20 s, which is what makes 1 Hz differencing noisy.
// Positions always carry the AR(1) wander (every phone has it); the models differ in where the
// speed comes from, so a segment variant is judged on noisy positions in both cases.
function measure(model, sigmaSpeed, sigmaPos = 3) {
  const sp = [], pos = []; let d = 0, e = 0, ePrev = 0;
  const rho = Math.exp(-1 / 20);
  for (let i = 0; i < N; i++) {
    d += truth[i];
    ePrev = e; e = rho * e + Math.sqrt(1 - rho * rho) * gauss() * sigmaPos;
    pos.push(d + e);
    sp.push(Math.max(0, model === 'doppler' ? truth[i] + gauss() * sigmaSpeed : truth[i] + (e - ePrev)));
  }
  return { sp, pos };
}

// ---- variants. Each returns the per-second estimate the runner would see and hear.
const ema = tau => ({ sp }) => {
  const a = 1 - Math.exp(-1 / tau); let v = null;
  return sp.map(x => (v = v == null ? x : v + a * (x - v)));
};
const medianEma = (k, tau) => ({ sp }) => {
  const a = 1 - Math.exp(-1 / tau); let v = null;
  return sp.map((_, i) => {
    const w = sp.slice(Math.max(0, i - k + 1), i + 1).slice().sort((p, q) => p - q);
    const m = w[Math.floor(w.length / 2)];
    return (v = v == null ? m : v + a * (m - v));
  });
};
// "decide the pace every X metres": hold the last segment's average until the next segment closes.
const segment = metres => ({ sp, pos }) => {
  const out = []; let startI = 0, v = null;
  for (let i = 0; i < N; i++) {
    if (pos[i] - pos[startI] >= metres) {
      v = (pos[i] - pos[startI]) / (i - startI);
      startI = i;
    }
    out.push(v == null ? sp[0] : v);
  }
  return out;
};

const VARIANTS = [
  ['EMA tau 1.5 s', ema(1.5)], ['EMA tau 2 s', ema(2)], ['EMA tau 3 s (shipped)', ema(3)],
  ['EMA tau 5 s', ema(5)], ['median 5 + EMA 2 s', medianEma(5, 2)],
  ['segment 25 m', segment(25)], ['segment 50 m', segment(50)]
];

// ---- metrics
const toneOf = (v, underTol) => {
  const t = PaceCore.toneFor((v - VT) / VT, Object.assign({}, PaceCore.DEF, { underTol }));
  return t ? t.kind : 'none';
};

function metrics(est, hold, underTol) {
  // tone state with a "must persist for `hold` fixes before it changes" confirmation
  const tones = []; let cur = 'none', run = 0, want = 'none';
  for (const v of est) {
    const t = toneOf(v, underTol);
    if (t === want) run++; else { want = t; run = 1; }
    if (run >= hold) cur = want;
    tones.push(cur);
  }
  const flips = (a, b) => { let n = 0; for (let i = a + 1; i < b; i++) if (tones[i] !== tones[i - 1]) n++; return n; };
  const rms = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += (est[i] - truth[i]) ** 2; return Math.sqrt(s / (b - a)); };
  // A detection counts only if it sticks for `persist` seconds, so a noise chirp that happens to land
  // on the right side does not score as an instant, correct warning.
  const firstSustained = (from, pred, persist) => {
    let run = 0;
    for (let i = from; i < N; i++) {
      run = pred(i) ? run + 1 : 0;
      if (run >= persist) return i - persist + 1 - from;
    }
    return Infinity;
  };
  return {
    rms: rms(STEADY[0], STEADY[1]),
    chirp: flips(STEADY[0], STEADY[1]) / ((STEADY[1] - STEADY[0]) / 60),
    build: firstSustained(0, i => est[i] >= VT * 0.98, 5),
    fade: firstSustained(FADE, i => tones[i] === 'fall', 5),
    surge: firstSustained(SURGE, i => tones[i] === 'rise', 5)
  };
}

const RUNS = 200;   // one seed is one roll of the dice; every number below is a mean over this many
function mean(model, sigma, variant, hold, underTol) {
  const acc = { rms: 0, chirp: 0, build: 0, fade: 0, surge: 0 };
  for (let k = 0; k < RUNS; k++) {
    seed = 1000 + k * 7919;
    const m = metrics(variant(measure(model, sigma)), hold, underTol);
    for (const key in acc) acc[key] += isFinite(m[key]) ? m[key] : 120;   // a miss counts as the whole window
  }
  for (const key in acc) acc[key] /= RUNS;
  return acc;
}

const COLS = '  RMS m/s   chirps/min   build s   fade s   surge s';
const row = (label, m) => console.log('  ' + label.padEnd(22) + m.rms.toFixed(2).padStart(8) +
  m.chirp.toFixed(1).padStart(13) + m.build.toFixed(0).padStart(10) +
  m.fade.toFixed(0).padStart(9) + m.surge.toFixed(0).padStart(9));

// ---- real-data mode.
// A synthetic run proves a filter against a noise model I chose; this proves it against GPS as it
// actually behaved on a real 12-minute run. The fixture carries position only (no chipset speed), so
// it exercises the position-differencing path, and its fixes are 2 to 6 s apart rather than 1 Hz.
// There is no true speed to compare against, so the reference is a zero-phase filter: the same EMA
// run forwards and then backwards over the whole file, which removes noise without the lag a causal
// filter must have. Causal variants are scored against that.
function loadFixes(gpxPath) {
  const xml = fs.readFileSync(gpxPath, 'utf8');
  const out = [];
  const re = /<trkpt lat="([-\d.]+)" lon="([-\d.]+)">[\s\S]*?<time>([^<]+)<\/time>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ lat: +m[1], lon: +m[2], t: Date.parse(m[3]) / 1000 });
  return out;
}

function realSpeeds(fixes) {
  const sp = [];
  for (let i = 0; i < fixes.length; i++) {
    if (i === 0) { sp.push(null); continue; }
    const dt = fixes[i].t - fixes[i - 1].t;
    sp.push(dt > 0 ? PaceCore.haversine(fixes[i - 1], fixes[i]) / dt : sp[i - 1]);
  }
  sp[0] = sp[1];
  return sp;
}

// dt-aware EMA, identical in form to the one in PaceCore
function emaOver(sp, dts, tau) {
  let v = null;
  return sp.map((x, i) => {
    const a = 1 - Math.exp(-Math.min(dts[i], 10) / tau);
    return (v = v == null ? x : v + a * (x - v));
  });
}
function zeroPhase(sp, dts, tau) {
  const f = emaOver(sp, dts, tau);
  const b = emaOver(f.slice().reverse(), dts.slice().reverse(), tau).reverse();
  return b;
}
// "decide the pace every X metres" over the real track
function segmentOver(fixes, metres) {
  const out = []; let startI = 0, v = null, acc = 0;
  for (let i = 0; i < fixes.length; i++) {
    if (i > 0) acc += PaceCore.haversine(fixes[i - 1], fixes[i]);
    if (acc >= metres) { v = acc / (fixes[i].t - fixes[startI].t); startI = i; acc = 0; }
    out.push(v);
  }
  const first = out.find(x => x != null) ?? 0;
  return out.map(x => (x == null ? first : x));
}

function realReport(gpxPath, targetSec) {
  const fixes = loadFixes(gpxPath);
  const sp = realSpeeds(fixes);
  const dts = fixes.map((f, i) => (i === 0 ? 1 : f.t - fixes[i - 1].t));
  const total = fixes[fixes.length - 1].t - fixes[0].t;
  const vt = 1000 / targetSec;
  const ref = zeroPhase(sp, dts, 3);
  const near = ref.map(v => Math.abs(v - vt) / vt <= 0.05);          // the fixes where chirping matters

  const variants = [
    ['EMA tau 1.5 s', emaOver(sp, dts, 1.5)], ['EMA tau 2 s', emaOver(sp, dts, 2)],
    ['EMA tau 3 s (shipped)', emaOver(sp, dts, 3)], ['EMA tau 5 s', emaOver(sp, dts, 5)],
    ['segment 25 m', segmentOver(fixes, 25)], ['segment 50 m', segmentOver(fixes, 50)]
  ];

  console.log('');
  console.log('REAL RUN: ' + path.basename(gpxPath) + ', ' + fixes.length + ' fixes over ' + Math.round(total) +
    ' s, position only, ' + (total / (fixes.length - 1)).toFixed(1) + ' s between fixes');
  console.log('Target ' + Math.floor(targetSec / 60) + ':' + String(targetSec % 60).padStart(2, '0') +
    '/km. Reference is a zero-phase 3 s filter over the whole file. "near target" = the ' +
    near.filter(Boolean).length + ' fixes within 5% of it.');
  console.log('');
  console.log('  variant                 RMS m/s   tone changes/min: hold 0   hold 3 s   near target, hold 0   hold 3 s');
  for (const [name, est] of variants) {
    let sq = 0;
    for (let i = 0; i < est.length; i++) sq += (est[i] - ref[i]) ** 2;
    const rms = Math.sqrt(sq / est.length);
    const count = (hold, onlyNear) => {
      let cur = 'none', want = 'none', run = 0, wantT0 = 0, flips = 0, secs = 0;
      for (let i = 0; i < est.length; i++) {
        const t = PaceCore.toneFor((est[i] - vt) / vt, Object.assign({}, PaceCore.DEF, { targetSec }));
        const kind = t ? t.kind : 'none';
        if (kind === want) run++; else { want = kind; run = 1; wantT0 = fixes[i].t; }
        const prev = cur;
        if (hold <= 0 || (run >= 2 && fixes[i].t - wantT0 >= hold)) cur = want;
        if (onlyNear && !near[i]) continue;
        secs += dts[i];
        if (cur !== prev) flips++;
      }
      return secs > 0 ? flips / (secs / 60) : 0;
    };
    console.log('  ' + name.padEnd(22) + rms.toFixed(2).padStart(8) +
      count(0, false).toFixed(1).padStart(27) + count(3, false).toFixed(1).padStart(11) +
      count(0, true).toFixed(1).padStart(22) + count(3, true).toFixed(1).padStart(11));
  }
}

const gpxArg = process.argv.indexOf('--gpx');
if (gpxArg > -1) {
  const file = process.argv[gpxArg + 1] || path.join(__dirname, 'cooper-fixture.gpx');
  for (const target of [232, 263]) realReport(file, target);   // 3:52 (the test target) and 4:23 (this run's own pace)
  process.exit(0);
}

const runFile = process.argv[2];
if (runFile) {
  // A real exported run: no truth to compare against, so report what the raw fixes themselves say.
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const sp = run.log.filter(e => e.ok && e.speed != null).map(e => e.speed);
  const jump = sp.slice(1).reduce((a, b, i) => a + Math.abs(b - sp[i]), 0) / (sp.length - 1);
  console.log(`Real run: ${sp.length} accepted fixes with a speed, target ${run.target_s_per_km} s/km`);
  console.log(`Mean raw speed ${(sp.reduce((a, b) => a + b, 0) / sp.length).toFixed(2)} m/s`);
  console.log(`Fix-to-fix change, mean |delta| ${jump.toFixed(2)} m/s: ` +
    (jump < 0.4 ? 'chipset Doppler, the good case' : jump < 0.8 ? 'noisy Doppler' : 'position differencing, no chipset speed'));
  process.exit(0);
}

console.log('Synthetic 400 s run at a 3:52/km target, 1 Hz fixes, mean of ' + RUNS + ' noise seeds.');
console.log('RMS: error against the true speed while holding target. chirps/min: tone changes per');
console.log('minute while holding target, so lower is calmer. build: seconds to read target during the');
console.log('build-up. fade and surge: seconds to call a real 6% fade and a real 12.5% surge and hold');
console.log('the call for 5 s. A missed call scores 120.');

for (const [model, sigma, title] of [['doppler', 0.3, 'CHIPSET DOPPLER SPEED, sigma 0.3 m/s'],
                                     ['posdiff', 3, 'POSITION DIFFERENCING, 3 m AR(1) position error']]) {
  console.log('');
  console.log(title);
  console.log('');
  console.log('  Filters, judged as shipped: tone reacts to one fix, underspeed tolerance 0');
  console.log('  variant' + COLS);
  for (const [name, fn] of VARIANTS) row(name, mean(model, sigma, fn, 1, 0));

  console.log('');
  console.log('  EMA tau 2 s, sweeping the two quieting knobs');
  console.log('  hold s x underTol' + COLS);
  for (const hold of [1, 2, 3])
    for (const underTol of [0, 0.02])
      row(`${hold} s, ${(underTol * 100).toFixed(0)}% tol`, mean(model, sigma, ema(2), hold, underTol));
}
