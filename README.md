# Pace tool, build folder

Stage 1 of the plan in `D:\SynologyDrive\Claude\Projects\PaceTool\SPEC.md` (read `START-HERE.md`
there first). Brief, research, spec and changelog live in that folder; only the code and its checks
live here.

| File | Holds |
|------|-------|
| `index.html` | The whole product: one page, no dependencies, no backend. Serve over HTTPS. |
| `test/selfcheck.js` | Node self-check of the algorithm block inside `index.html`. Run `node test/selfcheck.js`. |
| `test/compare-smoothing.js` | Measures pace-estimation variants. No argument: synthetic runs with two GPS noise models. `--gpx`: the real fixture. `run.json`: a run exported from the phone. |
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

- `node test/selfcheck.js`: 21 checks, exits 1 on failure. Covers auto-start with back-dating, the
  asymmetric tone thresholds and glide mapping, the 46 s stop rule with a 15 s stop that must not
  end the run, ramp timeout, the accuracy and ordering gate, dropout freeze, manual finish, km
  splits, clock-offset independence, stillness detection, the tone hold, target-pace entry,
  tolerance independence of the clock, the countdown (including ending when GPS has stopped), the
  chart geometry and scale, the voice markers and their spoken phrasing, and the GPX fixture at two
  targets. Several were written by mutation: break the code, watch the check fail, put it back.
- Simulator in the browser: open `index.html#sim` (1x) or `index.html#sim=10` (10x). Fake GPS with a
  fixed profile: 20 s ramp, 60 s at 4.5 m/s, 20 s at 4.0, 15 s at 5.0, then 2.0 m/s until the
  auto-end. At 10x the run takes about 20 s and exercises every state and tone. The simulator runs
  its own clock, so held time and distance scale with it.
- Local preview: `python -m http.server 8765` in this folder, then `http://localhost:8765/index.html`.
  `localhost` counts as a secure context, so the real geolocation path can be exercised on the
  laptop too (it will report no speed; the position-differencing fallback then applies).

## Smoothing, measured

The first phone test said the pace number builds up slowly and drops on a couple of missteps. Rather
than guess, `test/compare-smoothing.js` replays a 400 s synthetic run at the target pace through
seven estimators under two noise models, 200 noise seeds each, and scores four things: error against
the true speed, tone changes per minute while genuinely holding target (the chirping), seconds to
read target during the build-up, and seconds to call a real 6 % fade or 12.5 % surge and hold the
call. Numbers below are for chipset Doppler speed, the normal case.

| Variant | Error m/s | Tone changes per min | Build s | Fade called s | Surge called s |
|---|---|---|---|---|---|
| EMA 1.5 s | 0.17 | 20.0 | 28 | 1 | 11 |
| EMA 3 s, as shipped | 0.12 | 14.3 | 28 | 1 | 11 |
| EMA 5 s | 0.10 | 11.3 | 32 | 1 | 15 |
| Decide every 25 m | 0.34 | 5.8 | 25 | 4 | 8 |
| Decide every 50 m | 0.33 | 3.1 | 34 | 6 | 17 |
| EMA 3 s, tone held 3 fixes | 0.12 | 5.2 | 28 | 1 | 7 |

What it says:

- **Sampling every X metres is not an upgrade.** A 25 m segment is nearly three times noisier than
  the 3 s filter, because GPS position error wanders over about 20 s and a 6 s segment cannot average
  it out. Its only advantage, calm, comes from updating rarely, and it pays for that by taking 4 s
  rather than 1 s to call a real fade.
- **The filter length was never the problem.** Build-up time is the same 28 s for every filter from
  1.5 s to 5 s, because it is dominated by the runner's own acceleration and by GPS settling, not by
  smoothing.
- **The chirping was the problem, and it is a threshold problem, not an averaging one.** At exactly
  target pace, noise sits on both sides of the line, so the tone flips about every 4 s however the
  speed is smoothed. Requiring a tone state to persist for 3 fixes before it is played cuts that from
  14 to 5 changes per minute, keeps fade detection at 1 s, and improves surge detection, because a
  latched tone stops flickering. That is `toneHold` in `PaceCore.DEF`.

So: 1 Hz sampling and the 3 s filter stay; the tone is what got fixed.

### Checked against a real run, not only against my noise model

`node test/compare-smoothing.js --gpx` scores the same variants over `test/cooper-fixture.gpx`, a
real 12-minute maximal run. It carries position only, so it exercises the position-differencing path,
and its fixes are 3.7 s apart rather than 1 Hz. There is no true speed to compare against, so the
reference is the same filter run forwards and then backwards over the whole file, which removes noise
without the lag any causal filter must have.

| Variant | Error m/s | Tone changes per min, no hold | With a 3 s hold |
|---|---|---|---|
| EMA 3 s, as shipped | 0.18 | 8.3 | 2.1 |
| EMA 5 s | 0.12 | 6.7 | 1.3 |
| Decide every 25 m | 0.36 | 5.4 | 4.6 |
| Decide every 50 m | 0.31 | 0.8 | 0.8 |

Counted over the 50 fixes where the runner was genuinely within 5 % of the 3:52 target, which is
where chirping matters. Real GPS agrees with the synthetic result and sharpens it: deciding the pace
every 25 m is twice as noisy as the shipped filter on real data and the hold barely helps it, because
its updates are already too far apart to be confirmed. The 50 m variant is calm only because it
speaks every 13 s.

**The real run also caught a flaw in the fix.** The hold was first written as a count of fixes, which
on this run's 3.7 s spacing turned a 3 s confirmation into an 11 s delay, and made the improvement
look like 20x rather than 4x. It is now a time: a tone state must persist for 3 s and at least two
fixes. At 1 Hz that is what it always was, and a phone delivering fixes slowly no longer turns it
into a long silence.

## What the multi-agent review found

The countdown and chart were reviewed by 82 agents across four dimensions, every finding then put to
three independent skeptics told to refute it. 26 findings, 10 survived. What they caught, all fixed:

- **The countdown quietly broke the project's cornerstone rule.** Capping the held time at the end of
  the run was right for a countdown end, but the manual End button reaches the same line with the
  PHONE clock, so on a phone reading 40 s behind GPS time a 296 s run recorded 256 s, and one reading
  400 s behind recorded zero. The cap is now taken against the countdown's own fix-time end, and the
  manual stop passes fix time like every other path. Five of the ten findings were this one bug seen
  from four angles.
- **The chart scale came from the data.** Every auto-ended run holds 46 s at or below half speed, so
  the whole interesting part collapsed towards the target line. Now the scale comes from the target.
- **Two ends could save one run twice.** The run screen stays up for 2.5 s after the end, so a
  hold-to-end already in flight when the countdown expired saved a second copy. `stopRun` is now
  idempotent.
- **The clear button on the new rows was unstyled**, because the rule was bound to one id. At 375 px
  the countdown field was crushed to 22 px with a full-width green cross below it.
- **Three of my own checks did not check anything.** The held-time cap assertion passed with the cap
  deleted, because 1 Hz fixes make it a no-op; the countdown's phone-clock branch could be removed
  with nothing failing; and the axis labels vanish entirely for targets slower than 15:00/km, which
  no check covered. All three now fail when the code is broken.

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
- Tone hold (added 2026-09-15, measured as above): a tone state must persist for 3 s and at least two
  fixes before it is played. `toneHold` in `PaceCore.DEF`, in seconds; 0 restores the spec's
  react-to-every-fix behaviour.
- Tolerances move the tones only (changed 2026-09-15). The spec tied auto-start and `on_pace_s` to
  `underTol`; with the tolerance now defaulting to 10 %, that would have started the clock at 4:18/km
  and counted time there as time at pace. Auto-start and `on_pace_s` use the target itself, so a
  loose tolerance can quiet the tones but can never flatter the recorded result.
- Defaults changed 2026-09-15 at the user's request: slow tolerance 10 % (was 0), fast threshold 10 %
  (unchanged).
- Target pace entry is digits-only (added 2026-09-15). A phone's numeric keypad has no colon, so
  digits shift in from the right like a stopwatch: 3, 5, 2 gives 3:52, a fourth digit pushes the rest
  left, seconds past 59 carry into minutes, and the cross clears. `PaceCore.paceDigits`.
- The field is re-read on `pageshow` (added 2026-09-15). Browsers restore form values after the
  script runs, which had left the field showing one pace while the run used another.
- Cadence metronome (added 2026-09-15): opt-in tickbox, default 170 steps per minute, a 30 ms
  vibration where the browser supports it and a short click where it does not (iOS Safari has no
  Vibration API). Self-correcting schedule, so it cannot drift over a 12-minute run.
- Countdown (added 2026-09-15): blank by default, entered with the same digit-shift entry as the
  target pace. It starts when the clock starts, at target pace and back-dated with it, and ends the
  run when it runs out. Two paths end it: `onFix` on fix time, which is what gets recorded, and
  `tick` on the phone clock, so a GPS dropout in the last seconds cannot overrun the countdown. The
  recorded end is always `t0 + limit` in fix time, and `held_s` is capped at the end of the run.
- Voice announcements (added 2026-09-15): blank by default, set in metres. At every multiple the
  browser's own speech synthesiser says the distance covered and the pace over that segment, as
  minutes and seconds per kilometre: "500 metres, pace 3 minutes 52 seconds", then "1000 metres, 500
  metre pace 4 minutes 5 seconds". The crossing almost never lands on a fix, so its time is
  interpolated between the two fixes that straddle it, the same way the km splits are. The phrase
  itself is `PaceCore.markPhrase`, pure and tested. iOS will not speak unless the first utterance
  follows a tap, so Start primes it with a silent one.
- Run chart (added 2026-09-15): tapping a finished run opens the whole run as an inline SVG line
  chart. Speed is plotted so faster is higher, but the axis is labelled in pace, which is the number
  a runner thinks in. The bright line is the smoothed speed the tones used, the faint line is the raw
  fix-by-fix speed, which is also the quickest way to see whether a phone is giving chipset Doppler
  speed or falling back to position differencing. A data gap breaks the line rather than drawing a
  straight line across missing time. Geometry is `PaceCore.chartPaths`, kept pure so the self-check
  covers it. The vertical scale runs from half to one and a half times target pace and is set by the
  target, never by the data: almost every run ends stopped or walking, and one slow tail or one
  accepted GPS spike would otherwise squash the whole run into a few pixels around the target line.
- Tones use one short-lived oscillator per note rather than one long-running oscillator. Simpler,
  same autoplay behaviour once the AudioContext is resumed in the Start tap.
- End button needs a 1 s hold, in place of a separate touch-swallowing overlay. The run screen is
  already full-screen with `touch-action: none`.

## Not yet done

- Real-phone verification: `coords.speed` populated on the user's Android, iOS silent switch with
  `audioSession.type = "playback"`, wake lock behaviour, tone audibility at pace.
- Optional `manifest.json` and service worker for offline load.
- GPX export (the JSON export carries the track).
