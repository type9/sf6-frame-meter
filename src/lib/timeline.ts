import type { CellClass } from "./classify"
import {
	FRAME_TIMELINE_VERSION,
	HITSTOP_MAX_FRAMES,
	HITSTOP_MIN_FRAMES,
	ROUND_HIDDEN_BRIDGE_FRAMES,
	ROUND_MIN_WRITE_FRAMES,
	SCORE_CHANGE_STABLE_FRAMES,
} from "./constants"
import type { TrackerResult } from "./tracker"

/** A coloured run on one player's lane, in VIDEO time. Gaps between spans are neutral. */
export interface LaneSpan {
	startMs: number
	durMs: number
	cls: Exclude<CellClass, "empty" | "unknown">
}

export interface PauseSpan {
	startMs: number
	durMs: number
	kind: "hitstop" | "freeze" | "ko"
}

export interface TimeRange {
	startMs: number
	durMs: number
}

export interface RoundRange extends TimeRange {
	index: number
	/** 1-based round number as the player counts it. */
	number: number
	/** Round wins shown beside the timer when the round started. */
	score: { p1: number; p2: number }
}

/**
 * The output artifact (persist it as JSON). Semantic and renderer-
 * agnostic on purpose: lanes are classes plus times, so palette, lane
 * heights and any derived readout are display concerns that ship with
 * the consuming app and never require re-processing. Only tracker or
 * shape changes bump `FRAME_TIMELINE_VERSION`.
 *
 * Times are video milliseconds (frame / fps), NOT meter frames, so the
 * document overlays a player clock directly (apply any clip start
 * offset on the consumer side).
 *
 * Lane holds: a FREEZE (hitstop, super flash) keeps the lane's colour;
 * a STOP (both players neutral) leaves the lane dark; the KO freeze
 * ends the round's lanes where it begins.
 */
export interface FrameTimelineDocument {
	version: number
	source: {
		width: number
		height: number
		fps: number
		videoFrames: number
		durationMs: number
	}
	geometry: {
		cellPitch: number
		firstCellX: number
		rowY: [number, number]
		calibrated: boolean
	}
	rounds: RoundRange[]
	lanes: { p1: LaneSpan[]; p2: LaneSpan[] }
	pauses: PauseSpan[]
	hidden: TimeRange[]
	stats: {
		meterFrames: number
		dupFrames: number
		pausedFrames: number
		anomalies: number
	}
}

export interface BuildTimelineOptions {
	fps: number
	width: number
	height: number
	geometry: FrameTimelineDocument["geometry"]
}

/**
 * Visibility with hysteresis: hidden gaps shorter than
 * `ROUND_HIDDEN_BRIDGE_FRAMES` are bridged so a one-frame flicker of
 * the gate does not split a round or pepper the lane with holes.
 */
export function bridgedVisibility(states: readonly string[]): boolean[] {
	const n = states.length
	// A duplicated video frame shows what the previous frame showed, so
	// it inherits that frame's visibility. Static transition cards
	// re-encode into long runs of duplicates; counting those as
	// visible chopped the hidden stretch into pieces short enough to
	// bridge, and two rounds read as one.
	const vis: boolean[] = new Array(n)
	for (let v = 0; v < n; v++) {
		const s = states[v]
		vis[v] = s === "dup" ? (v > 0 ? vis[v - 1]! : true) : s !== "hidden"
	}
	let i = 0
	while (i < n) {
		if (vis[i]) {
			i++
			continue
		}
		let j = i
		while (j < n && !vis[j]) j++
		const touchesEdge = i === 0 || j === n
		if (!touchesEdge && j - i < ROUND_HIDDEN_BRIDGE_FRAMES) {
			for (let k = i; k < j; k++) vis[k] = true
		}
		i = j
	}
	return vis
}

/**
 * Visible stretches with enough meter activity to be a round, as
 * [first video frame, last video frame] of the stretch. Trimming to
 * the meter's own activity (first write → last write / KO) happens in
 * `buildFrameTimeline`, which also knows the pauses.
 */
export function segmentRounds(
	states: readonly string[],
): Array<[number, number]> {
	const vis = bridgedVisibility(states)
	const out: Array<[number, number]> = []
	let start: number | null = null
	let writes = 0
	for (let v = 0; v <= states.length; v++) {
		const visible = v < states.length && vis[v]
		if (visible && start === null) {
			start = v
			writes = 0
		}
		if (visible && states[v] === "write") writes++
		if (!visible && start !== null) {
			if (writes >= ROUND_MIN_WRITE_FRAMES) out.push([start, v - 1])
			start = null
		}
	}
	return out
}

/** Most frequent score pair over a window of frames. */
function modeScore(
	wins: ReadonlyArray<[number, number]>,
	from: number,
	to: number,
): { p1: number; p2: number } {
	const counts = new Map<string, number>()
	for (let v = from; v < to && v < wins.length; v++) {
		const w = wins[v]
		if (!w) continue
		const key = `${w[0]},${w[1]}`
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	let best = "0,0"
	let bestN = -1
	for (const [k, n] of counts) {
		if (n > bestN) {
			best = k
			bestN = n
		}
	}
	const [p1, p2] = best.split(",").map(Number)
	return { p1: p1 ?? 0, p2: p2 ?? 0 }
}

export function buildFrameTimeline(
	result: TrackerResult,
	opts: BuildTimelineOptions,
): FrameTimelineDocument {
	const msPerFrame = 1000 / opts.fps
	const toMs = (vf: number) => Math.round(vf * msPerFrame * 1000) / 1000
	const { states, meterIdx, wins } = result.video
	const n = states.length
	const vis = bridgedVisibility(states)

	// ── Pauses (freezes only; stops are not pauses) ────────────────
	// Raw pause spans in frames; kinds are assigned below once the
	// rounds are known: a pause nothing is written after (inside its
	// round) is the KO freeze, otherwise duration says hitstop or
	// freeze. Duration alone cannot name the KO — a Super Art cinematic
	// freezes the meter for longer than the KO sequence does.
	const rawPauses: Array<[number, number]> = [] // [start, endExclusive]
	let p0: number | null = null
	const flushPause = (endExclusive: number) => {
		if (p0 !== null && endExclusive - p0 >= HITSTOP_MIN_FRAMES)
			rawPauses.push([p0, endExclusive])
		p0 = null
	}
	for (let v = 0; v < n; v++) {
		const paused =
			states[v] === "pause" || (states[v] === "dup" && p0 !== null)
		if (paused && p0 === null) p0 = v
		if (!paused) flushPause(v)
	}
	flushPause(n)

	// ── Rounds: visible stretch trimmed to the meter's own activity ──
	// Start = first write. End = the KO: the winner's badge lights up
	// beside the timer, so the first LASTING change of the score inside
	// the stretch ends the round. Fallback when the badges are not
	// readable: the frame after the last write (the KO freeze begins
	// right after it and runs until the meter leaves the screen).
	const rounds: RoundRange[] = []
	const cutAt = new Map<number, number>() // round start frame → cut frame (exclusive)
	const koStarts = new Set<number>()
	for (const [a, b] of segmentRounds(states)) {
		let first = -1
		let last = -1
		for (let v = a; v <= b; v++) {
			if (states[v] === "write") {
				if (first < 0) first = v
				last = v
			}
		}
		if (first < 0) continue
		// The badges are constant for the body of the round and only
		// change at the KO, so the mode over the round is the score
		// going in.
		const score = modeScore(wins, first, last + 1)
		const sameScore = (w: [number, number] | undefined) =>
			!w || (w[0] === score.p1 && w[1] === score.p2)
		// The KO badge stays lit from the KO until the meter leaves the
		// screen, so the cut is the frame after the LAST frame that still
		// shows the going-in score — provided the new score then holds
		// to the end of the stretch for long enough to not be a flash.
		let koAt = -1
		let lastSame = -1
		for (let v = first; v <= b; v++) if (sameScore(wins[v])) lastSame = v
		if (lastSame >= first && b - lastSame >= SCORE_CHANGE_STABLE_FRAMES)
			koAt = lastSame + 1
		const endExclusive = koAt >= 0 ? Math.min(koAt, last + 1) : last + 1
		cutAt.set(first, endExclusive)
		for (const [ps] of rawPauses)
			if (ps >= endExclusive - 1 && ps <= b) koStarts.add(ps)
		const index = rounds.length
		rounds.push({
			index,
			number: index + 1,
			startMs: toMs(first),
			durMs: toMs(endExclusive) - toMs(first),
			score,
		})
	}
	const pauses: PauseSpan[] = rawPauses.map(([ps, pe]) => ({
		startMs: toMs(ps),
		durMs: toMs(pe) - toMs(ps),
		kind: koStarts.has(ps)
			? "ko"
			: pe - ps <= HITSTOP_MAX_FRAMES
				? "hitstop"
				: "freeze",
	}))
	// Frames that belong to no round (pre-FIGHT, KO aftermath, cards)
	// draw nothing.
	const inRound = new Uint8Array(n)
	for (const [start, end] of cutAt)
		for (let v = start; v < end; v++) inRound[v] = 1

	// ── Lanes ──────────────────────────────────────────────────────
	const lanes = { p1: [] as LaneSpan[], p2: [] as LaneSpan[] }
	for (const [key, col] of [
		["p1", result.meter.p1],
		["p2", result.meter.p2],
	] as const) {
		let runCls: CellClass | null = null
		let runStart = 0
		const flush = (endExclusive: number) => {
			if (runCls && runCls !== "empty" && runCls !== "unknown") {
				lanes[key].push({
					startMs: toMs(runStart),
					durMs: toMs(endExclusive) - toMs(runStart),
					cls: runCls,
				})
			}
		}
		for (let v = 0; v < n; v++) {
			const idx = meterIdx[v]!
			const st = states[v]
			// Freezes hold the last drawn class; a duplicated video frame
			// shows whatever the previous frame showed (so a duplicate
			// inside a stop stays dark); stops and anything outside a
			// round draw nothing.
			const cls: CellClass | null =
				st === "dup"
					? runCls
					: !inRound[v] ||
						  st === "hidden" ||
						  st === "stopped" ||
						  idx < 0
						? null
						: (col[idx] ?? "empty")
			if (cls !== runCls) {
				flush(v)
				runCls = cls
				runStart = v
			}
		}
		flush(n)
	}

	// ── Hidden ranges (bridged) ────────────────────────────────────
	const hidden: TimeRange[] = []
	let h0: number | null = null
	for (let v = 0; v <= n; v++) {
		const isHidden = v < n && !vis[v]
		if (isHidden && h0 === null) h0 = v
		if (!isHidden && h0 !== null) {
			hidden.push({ startMs: toMs(h0), durMs: toMs(v) - toMs(h0) })
			h0 = null
		}
	}

	return {
		version: FRAME_TIMELINE_VERSION,
		source: {
			width: opts.width,
			height: opts.height,
			fps: opts.fps,
			videoFrames: n,
			durationMs: toMs(n),
		},
		geometry: opts.geometry,
		rounds,
		lanes,
		pauses,
		hidden,
		stats: {
			meterFrames: result.meta.meterFrames,
			dupFrames: result.meta.duplicateVideoFrames,
			pausedFrames: result.meta.pausedFrames,
			anomalies: result.meta.anomalies,
		},
	}
}
