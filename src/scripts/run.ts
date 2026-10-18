/**
 * CLI: read a local replay VOD and write the frame-timeline document.
 * No DB, no R2 — the loop for tracker and resolution work.
 *
 *   pnpm run run -- \
 *     --input ./match.mp4 --out ./doc.json [--ffmpeg /path/to/ffmpeg] [--start 10 --duration 30]
 *
 * `--ffmpeg` defaults to `ffmpeg` on PATH; pass the `ffmpeg-static`
 * binary (see `lib/ffmpeg-bin`) when there is no system ffmpeg.
 */
import { writeFileSync } from "node:fs"

import { createFfmpegSource, probeVideo } from "../lib/node-ffmpeg-source"
import { buildFrameTimeline } from "../lib/timeline"
import { MeterTracker } from "../lib/tracker"

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
	const input = arg("input")
	const out = arg("out")
	if (!input || !out) {
		console.error(
			"usage: run.ts --input <video> --out <doc.json> [--ffmpeg bin] [--start s] [--duration s]",
		)
		process.exit(1)
	}
	const ffmpegBin = arg("ffmpeg") ?? "ffmpeg"
	const t0 = Date.now()
	const probe = await probeVideo(input, ffmpegBin)
	const source = createFfmpegSource({
		input,
		ffmpegBin,
		width: probe.width,
		height: probe.height,
		startSec: arg("start") ? Number(arg("start")) : undefined,
		durationSec: arg("duration") ? Number(arg("duration")) : undefined,
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
	writeFileSync(out, JSON.stringify(doc))
	console.log(
		JSON.stringify({
			...probe,
			...result.meta,
			rounds: doc.rounds.length,
			spans: doc.lanes.p1.length + doc.lanes.p2.length,
			pauses: doc.pauses.length,
			calibrated: geo.calibrated,
			secondsElapsed: (Date.now() - t0) / 1000,
		}),
	)
}

void main()
