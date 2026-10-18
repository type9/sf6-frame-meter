/**
 * Node frame source: decode with ffmpeg and yield one Sample per video
 * frame. Server / CLI only (child_process) — deliberately NOT on the
 * package barrel so client bundles never see it; import via
 * `sf6-frame-meter/lib/node-ffmpeg-source`.
 *
 * ffmpeg does the cropping so the pipe carries only what the tracker
 * reads, stacked into one frame:
 *   A  the meter rows plus the readout text above them
 *   B  the HUD band with the round-win squares beside the timer
 *   C  a nearest-neighbour thumbnail of the whole picture for duplicate
 *      detection (a true subsample, not an area average — smoothing
 *      pulls real motion under the duplicate threshold)
 * ~0.6 MB per 720p frame instead of 2.7 MB.
 */
import { spawn } from "node:child_process"

import { CELL_COUNT } from "./constants"
import {
	applyCalibration,
	calibrateGeometry,
	geometryFor,
	type Geometry,
} from "./geometry"
import { rowLuminance, sampleFromReader, type Sample } from "./sample"

export interface VideoProbe {
	width: number
	height: number
	fps: number
}

/**
 * Read the stream header only (`-frames:v 0`) and parse size + fps
 * from ffmpeg's banner. ffmpeg-static ships no ffprobe, so this is
 * the cheapest reliable probe.
 */
export async function probeVideo(
	input: string,
	ffmpegBin: string,
): Promise<VideoProbe> {
	const stderr = await new Promise<string>((resolve, reject) => {
		const ff = spawn(
			ffmpegBin,
			["-hide_banner", "-i", input, "-frames:v", "0", "-f", "null", "-"],
			{ stdio: ["ignore", "ignore", "pipe"] },
		)
		let out = ""
		ff.stderr.on("data", (c: Buffer) => {
			out += c.toString()
		})
		ff.on("error", reject)
		ff.on("close", () => resolve(out))
	})
	const size = /Video:[^\n]*?\s(\d{2,5})x(\d{2,5})/.exec(stderr)
	const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
	if (!size)
		throw new Error(
			`could not read video size from ffmpeg output: ${stderr.slice(0, 400)}`,
		)
	return {
		width: Number(size[1]),
		height: Number(size[2]),
		fps: fps ? Number(fps[1]) : 60,
	}
}

export interface FfmpegSourceOptions {
	input: string
	ffmpegBin: string
	width: number
	height: number
	/** Seconds into the file to start (ffmpeg -ss). */
	startSec?: number
	/** Seconds to read (ffmpeg -t). */
	durationSec?: number
	/** Frames to try calibration on before settling (default 600). */
	calibrationWindow?: number
	/** Minimum calibration confidence to override the scaled geometry. */
	calibrationMinConfidence?: number
}

export interface FfmpegSource {
	geometry: Geometry
	frames: AsyncIterable<Sample>
	/** Resolved after the iterator finishes: the geometry actually used. */
	finalGeometry: () => Geometry
}

/** Thumbnail size for duplicate detection and its sparse stride. */
const PIC_W = 320
const PIC_H = 180
const PIC_STRIDE = 4

/**
 * Create the source. Region bounds derive from the geometry with a
 * margin so a calibration shift stays inside the crop.
 */
export function createFfmpegSource(opts: FfmpegSourceOptions): FfmpegSource {
	let geo = geometryFor(opts.width, opts.height)
	const margin = Math.max(8, Math.round((geo.sepX[1]! - geo.sepX[0]!) * 1.5))
	// Region A: the meter rows plus the readout text above them.
	const cx0 = Math.max(0, geo.text.x0 - margin)
	const cx1 = Math.min(opts.width, geo.sepX[CELL_COUNT]! + margin)
	const cy0 = Math.max(0, geo.text.y0 - margin)
	const cy1 = Math.min(opts.height, geo.rowY[1] + geo.patch + margin)
	// Region B: the HUD band with the round-win squares.
	const hx0 = Math.max(0, geo.hud.x0)
	const hx1 = Math.min(opts.width, geo.hud.x1)
	const hy0 = Math.max(0, geo.hud.y0)
	const hy1 = Math.min(opts.height, geo.hud.y1)
	// Even dims keep every pixel format happy.
	const CW = (cx1 - cx0) & ~1
	const CH = (cy1 - cy0) & ~1
	const HW = (hx1 - hx0) & ~1
	const HH = (hy1 - hy0) & ~1
	const FW = Math.max(CW, HW, PIC_W)
	const FH = CH + HH + PIC_H
	const FRAME = FW * FH * 3

	const args = ["-v", "error"]
	if (opts.startSec) args.push("-ss", String(opts.startSec))
	args.push("-i", opts.input)
	if (opts.durationSec) args.push("-t", String(opts.durationSec))
	args.push(
		"-filter_complex",
		`[0:v]split=3[a][b][c];` +
			`[a]crop=${CW}:${CH}:${cx0}:${cy0},pad=${FW}:${CH}[m];` +
			`[b]crop=${HW}:${HH}:${hx0}:${hy0},pad=${FW}:${HH}[h];` +
			`[c]scale=${PIC_W}:${PIC_H}:flags=neighbor,pad=${FW}:${PIC_H}[s];` +
			`[m][h][s]vstack=inputs=3`,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		"-",
	)

	const calibrationWindow = opts.calibrationWindow ?? 600
	const minConfidence = opts.calibrationMinConfidence ?? 0.45
	let calibrated = false

	async function* iterate(): AsyncGenerator<Sample> {
		const ff = spawn(opts.ffmpegBin, args, {
			stdio: ["ignore", "pipe", "inherit"],
		})
		let pending: Buffer[] = []
		let pendingLen = 0
		let frameNo = 0
		const exit = new Promise<number | null>((resolve) =>
			ff.on("close", resolve),
		)
		for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
			pending.push(chunk)
			pendingLen += chunk.length
			while (pendingLen >= FRAME) {
				const buf =
					pending.length === 1
						? pending[0]!
						: Buffer.concat(pending, pendingLen)
				const frame = buf.subarray(0, FRAME)
				const rest = buf.subarray(FRAME)
				pending = rest.length ? [rest] : []
				pendingLen = rest.length
				const px = (
					x: number,
					y: number,
				): readonly [number, number, number] => {
					// Region A (meter) or region B (HUD band); anything else is black.
					let lx = x - cx0
					let ly = y - cy0
					let o = -1
					if (lx >= 0 && ly >= 0 && lx < CW && ly < CH) {
						o = (ly * FW + lx) * 3
					} else {
						lx = x - hx0
						ly = y - hy0
						if (lx >= 0 && ly >= 0 && lx < HW && ly < HH)
							o = ((CH + ly) * FW + lx) * 3
					}
					if (o < 0) return [0, 0, 0]
					return [frame[o]!, frame[o + 1]!, frame[o + 2]!]
				}
				if (!calibrated && frameNo < calibrationWindow) {
					const cal = calibrateGeometry(rowLuminance(px, geo), geo)
					if (cal && cal.confidence >= minConfidence) {
						geo = applyCalibration(geo, cal)
						calibrated = true
					}
				}
				const pic = new Uint8Array(
					(PIC_W / PIC_STRIDE) * (PIC_H / PIC_STRIDE),
				)
				let k = 0
				for (let y = 0; y < PIC_H; y += PIC_STRIDE) {
					for (let x = 0; x < PIC_W; x += PIC_STRIDE) {
						const o = ((CH + HH + y) * FW + x) * 3
						pic[k++] =
							(frame[o]! + frame[o + 1]! + frame[o + 2]!) / 3
					}
				}
				yield sampleFromReader(px, pic, geo)
				frameNo++
			}
		}
		const code = await exit
		if (code !== 0 && code !== null)
			throw new Error(`ffmpeg exited with code ${code}`)
	}

	return { geometry: geo, frames: iterate(), finalGeometry: () => geo }
}
