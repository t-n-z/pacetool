# Pace tool, build folder

Stage 1 of the plan in `D:\SynologyDrive\Claude\Projects\PaceTool\SPEC.md` (read `START-HERE.md`
there first). Brief, research, spec and changelog live in that folder; only the code and its checks
live here.

| File | Holds |
|------|-------|
| `index.html` | The whole product: one page, no dependencies, no backend. Serve over HTTPS. |
| `test/selfcheck.js` | Node self-check of the algorithm block inside `index.html`. Run `node test/selfcheck.js`. |
| `test/cooper-fixture.gpx` | Copy of `PaceTool/fixtures/cooper-fixture.gpx`, replayed by the self-check. |
| `.claude/launch.json` | Local preview server (`python -m http.server 8765`) for the in-app browser. Not in the repo. |

## Where it runs

Public URL, any phone: **https://t-n-z.github.io/pacetool/** (GitHub Pages from the `main` branch
root of `github.com/t-n-z/pacetool`, public repo, set up 2026-09-10). Deploy is `git push`; Pages
rebuilds within about a minute. Check with `gh api repos/t-n-z/pacetool/pages/builds/latest`.

## How it is put together

`index.html` has two script blocks. The first, `<script id="core">`, is `PaceCore`: the state
machine (ARMED, RAMP, RUNNING, END), the smoothing, the tone decision, the stop rule and the result
record. It touches no browser API, so `test/selfcheck.js` extracts that block by its id and runs it
under Node. The second block is the page: geolocation, Web Audio, wake lock, screen updates,
`localStorage` and export. Change the algorithm in the first block only; keep the second block free
of pace logic so the self-check stays meaningful.

## Timekeeping

Every recorded time is a difference between GPS fix timestamps (`position.timestamp`): the
back-dated start `t0`, `held_s`, `on_pace_s`, the slow window, the splits. The phone clock is used
for one thing only, the "no fix for 5 s" dropout detector. A phone clock that is 37 s off GPS time
gives the same result (self-check "timekeeping"). Fixes must arrive in time order; a fix with a
timestamp at or before the last accepted one is rejected. `maximumAge: 0` stops the browser handing
over cached fixes.

## Testing without running

- `node test/selfcheck.js`: 12 checks, exits 1 on failure. Covers auto-start with back-dating, the
  asymmetric tone thresholds and glide mapping, the 46 s stop rule with a 15 s stop that must not
  end the run, ramp timeout, the accuracy and ordering gate, dropout freeze, manual finish, km
  splits, clock-offset independence, stillness detection, and the GPX fixture at two targets.
- Simulator in the browser: open `index.html#sim` (1x) or `index.html#sim=10` (10x). Fake GPS with a
  fixed profile: 20 s ramp, 60 s at 4.5 m/s, 20 s at 4.0, 15 s at 5.0, then 2.0 m/s until the
  auto-end. At 10x the run takes about 20 s and exercises every state and tone. The simulator runs
  its own clock, so held time and distance scale with it.
- Local preview: `python -m http.server 8765` in this folder, then `http://localhost:8765/index.html`.
  `localhost` counts as a secure context, so the real geolocation path can be exercised on the
  laptop too (it will report no speed; the position-differencing fallback then applies).

## Deviations from SPEC.md, and why

- Fix age gate (spec: reject fixes older than 2 s by the phone clock) replaced by `maximumAge: 0`
  plus the time-order check above. Comparing GPS time with the phone clock could reject every fix
  on a phone whose clock is off.
- Sample gap: the spec clamps `dt` to 3 s; here any gap over 5 s (the dropout threshold) adds
  nothing to any counter, and the EMA still updates. One rule for gaps instead of two.
- Glide floor: deviations under 2 semitones (about 3 %) are widened to 2 semitones so a 1 % miss
  still sounds directional. `minSemi` in `PaceCore.DEF`; 0 restores the pure spec mapping.
- Stillness detector (not in the spec, from the first phone test 2026-09-10): if every accepted fix
  in the last 5 s lies within 4 m of the newest, speed is taken as 0 and the display shows ∞ once
  the smoothed speed is under 0.5 m/s. Without it, GPS drift while standing reads as 15:00 to
  40:00/km and jumps about. `stillWindow`, `stillRadius` in `PaceCore.DEF` (tune). The raw speed
  stays in the log.
- Tones use one short-lived oscillator per note rather than one long-running oscillator. Simpler,
  same autoplay behaviour once the AudioContext is resumed in the Start tap.
- End button needs a 1 s hold, in place of a separate touch-swallowing overlay. The run screen is
  already full-screen with `touch-action: none`.

## Not yet done

- Real-phone verification: `coords.speed` populated on the user's Android, iOS silent switch with
  `audioSession.type = "playback"`, wake lock behaviour, tone audibility at pace.
- Optional `manifest.json` and service worker for offline load.
- GPX export (the JSON export carries the track).
