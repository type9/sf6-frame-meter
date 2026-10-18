/**
 * Debug: print the tracker's per-video-frame state and both players'
 * classes for a time window, plus the win-square readings. The loop
 * for "why does the lane show X at 0:12".
 *
 *   pnpm exec tsx src/scripts/debug-states.ts \
 *     --input ./match.mp4 --from 11.8 --to 13.2 [--ffmpeg bin]
 */
import { createFfmpegSource, probeVideo } from "../lib/node-ffmpeg-source"
import { MeterTracker } from "../lib/tracker"

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
	const input = arg("input")
	if (!input) throw new Error("--input required")
	const from = Number(arg("from") ?? 0)
	const to = Number(arg("to") ?? from + 2)
	const ffmpegBin = arg("ffmpeg") ?? "ffmpeg"
	const probe = await probeVideo(input, ffmpegBin)
	const source = createFfmpegSource({
		input,
		ffmpegBin,
		width: probe.width,
		height: probe.height,
	})
	const tracker = new MeterTracker()
	for await (const s of source.frames) tracker.feed(s)
	const r = tracker.finish()
	// One letter per class, by lane colour: Yellow stun, Green startup,
	// Blue recovery, Cyan non-counter, Red active, White, Orange
	// projectile, Purple armor; "." empty, "?" unknown.
	const LETTER: Record<string, string> = {
		stun: "Y",
		startup: "G",
		recovery: "B",
		noncounter: "C",
		active: "R",
		white: "W",
		projectile: "O",
		armor: "P",
		empty: ".",
	}
	const short = (c: string) => LETTER[c] ?? "?"
	console.log("vf      t(s)   state    idx  p1 p2  wins")
	for (
		let v = Math.floor(from * probe.fps);
		v <= Math.ceil(to * probe.fps) && v < r.video.states.length;
		v++
	) {
		const idx = r.video.meterIdx[v]!
		const p1 = idx >= 0 ? short(r.meter.p1[idx]!) : "-"
		const p2 = idx >= 0 ? short(r.meter.p2[idx]!) : "-"
		const w = r.video.wins[v]!
		console.log(
			`${String(v).padStart(6)} ${(v / probe.fps).toFixed(2).padStart(7)}  ${r.video.states[v]!.padEnd(8)} ${String(idx).padStart(5)}  ${p1}  ${p2}   ${w[0]}-${w[1]}`,
		)
	}
}

void main()
