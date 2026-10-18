# sf6-frame-meter

Read the **Street Fighter 6** replay viewer's on-screen frame meter out of a
video and turn it into a semantic frame timeline: per-player runs of startup /
active / recovery / stun / armor / projectile / invincible frames, hitstop and
freeze pauses, round boundaries and the score going into each round, all in
video time.

Pure logic. The barrel has no Node or DOM dependency, so it is safe in server
code, workers and client bundles alike. The two frame sources that bind to a
runtime (ffmpeg via `child_process`, or a `<video>` element via
`OffscreenCanvas`) ship as opt-in subpaths.

> **Status:** 0.x. The reader is validated against 720p60 replay captures and
> their 1080p re-encodes; other layouts (Classic HUD variants, 4:3 captures,
> heavy overlays) are untested. Expect the document shape to be stable and the
> tracker heuristics to keep improving — `FRAME_TIMELINE_VERSION` tells you when
> a stored document is stale.

## Install

```sh
pnpm add @type9/sf6-frame-meter
# Node processing without a system ffmpeg on PATH:
pnpm add ffmpeg-static
```

`ffmpeg-static` is an optional peer dependency — only the `lib/ffmpeg-bin`
helper looks for it. Any ffmpeg ≥ 4 works if you pass its path yourself.

## Usage

### Node: video file → timeline document

```ts
import { buildFrameTimeline, MeterTracker } from "@type9/sf6-frame-meter"
import { getFfmpegBin } from "@type9/sf6-frame-meter/lib/ffmpeg-bin"
import {
	createFfmpegSource,
	probeVideo,
} from "@type9/sf6-frame-meter/lib/node-ffmpeg-source"

const ffmpegBin = getFfmpegBin() // or "ffmpeg" / "/usr/bin/ffmpeg"
const probe = await probeVideo("match.mp4", ffmpegBin)

const source = createFfmpegSource({
	input: "match.mp4",
	ffmpegBin,
	width: probe.width,
	height: probe.height,
	// optional: startSec, durationSec, calibrationWindow
})

const tracker = new MeterTracker()
for await (const sample of source.frames) tracker.feed(sample)
const result = tracker.finish()

const geo = source.finalGeometry()
const doc = buildFrameTimeline(result, {
	fps: probe.fps,
	width: probe.width,
	height: probe.height,
	geometry: {
		cellPitch: geo.sepX[1]! - geo.sepX[0]!,
		firstCellX: geo.cellX[0]!,
		rowY: geo.rowY,
		calibrated: geo.calibrated,
	},
})
```

ffmpeg does the cropping, so the pipe carries only the meter rows, the HUD band
with the round-win squares and a small thumbnail for duplicate-frame detection
(~0.6 MB per 720p frame instead of 2.7 MB). A 10-minute 720p60 VOD processes in
well under real time on a laptop.

### Browser: `<video>` element → tracker

```ts
import { buildFrameTimeline } from "@type9/sf6-frame-meter"
import { trackVideoElement } from "@type9/sf6-frame-meter/lib/browser-source"

const tracker = trackVideoElement(videoEl, {
	onDone: (result) => {
		/* buildFrameTimeline(result, …) as above */
	},
})
videoEl.play()
```

Driven by `requestVideoFrameCallback`; keep `playbackRate <= 1` so no presented
frame is skipped. For guaranteed every-frame access, decode with WebCodecs and
call `tracker.feed(sampleFromReader(...))` per `VideoFrame` instead.

### The document

```ts
interface FrameTimelineDocument {
	version: number // FRAME_TIMELINE_VERSION it was built with
	source: { width; height; fps; videoFrames; durationMs }
	geometry: { cellPitch; firstCellX; rowY: [p1, p2]; calibrated }
	rounds: RoundRange[] // index, number, score going in, start/dur
	lanes: { p1: LaneSpan[]; p2: LaneSpan[] } // cls + startMs + durMs
	pauses: PauseSpan[] // kind: "hitstop" | "freeze" | "ko"
	hidden: TimeRange[] // meter off screen (between rounds)
	stats: { meterFrames; dupFrames; pausedFrames; anomalies }
}
```

All times are **video milliseconds**. Lanes are semantic (`CellClass` plus a
span); palette, lane heights, markers and derived readouts are display concerns
— `CLASS_COLOURS` exports the measured on-screen colours if you want to match
the game.

## How the meter is read

- The meter draws **80 cells per row** (P1 above P2), one cell per **game**
  frame, left to right, wrapping at cell 79 with a dimmed ghost of the previous
  pass left behind. Captures drop and duplicate frames (~10% on the reference
  VOD), so the tracker **counts cells, not video frames** and resolves unseen
  stretches by where the cursor resumes.
- Cells are classified by **hue** (smallest channel removed, unit sum) against
  measured fresh medians, with a brightness-ratio band to tell live paint from
  the ghost pass. Run-length digit glyphs over the last cells of a run are
  folded back into the run.
- Hitstop, super freezes and both-players-neutral stops are not drawn; the
  tracker tells a _freeze_ (a player is in a state they cannot be idle in, or an
  action continues across the gap) from a _stop_ (both neutral) by what was on
  the bar — a freeze holds the lane colour, a stop goes dark.
- Rounds are the visible stretches of the meter; the win badges beside the timer
  give the score going into each round and, when the winner's badge lights
  before the meter hides, the KO frame.
- Pixel geometry is expressed for a 1280x720 reference and scaled to the source
  size; `calibrateGeometry()` refines it from a frame where the bar has colour
  (the Node source does this automatically over the first `calibrationWindow`
  frames).

## Data-source notes

The reader needs **no external frame data** — it reads what the game draws. If
you want to join the timeline to move names or canonical frame data, these are
the sources we know of:

- **sfstats.app** has a public replay API, but it sits behind a Cloudflare
  browser challenge that rejects non-browser clients (curl, fetch, headless
  browsers), so it is not usable as an automated data source.
- **MMDK** (`alphazolam/MMDK`, REFramework mod) ships per-character dumps of the
  game's own action tables (`Names.json`, `moves_dict`, `HIT_DT`): action id →
  name, startup/active/recovery windows, cancel windows, hitstun/hitstop per
  outcome. This is game-truth, dumped from the running game.
- **sf6-remake** (`colefoster/sf6-remake`) is a headless frame-data engine whose
  ADRs document the frame identities (blockstun, counter and punish-counter
  bonuses, Drive Rush cancel freeze) and bundles a FAT frame-data export.

Treat community frame-data sites as derived; the dumps above are the reference
when numbers disagree.

## Regression check

There is no test runner yet. Re-run a reference VOD and compare the run labels
the game prints in the bar against the lanes at the same timestamp:

```sh
pnpm run run -- --input match.mp4 --out doc.json
pnpm exec tsx src/scripts/debug-states.ts --input match.mp4 --from 11.8 --to 13.2
```

Meter-frame count, the pause histogram (hitstop clusters at 9–13 frames) and the
anomaly count are the numbers to watch.

## License

MIT © Lossless. Street Fighter and its frame meter are the property of Capcom;
this project reads a video of the game's UI and is not affiliated with or
endorsed by Capcom.
