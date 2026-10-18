import { classify, type CellClass, type Classified } from "./classify"
import {
	CELL_CHANGE_THRESHOLD,
	CELL_COUNT,
	CLEAR_MAX_OTHER_CHANGES,
	CLEAR_MIN_CELLS,
	DUP_THRESHOLD,
	GLYPH_MAX_CELLS,
	MAX_FORWARD_JUMP,
	MAX_FORWARD_SLACK,
	NON_TERMINAL_CLASSES,
	RESTART_MAX_CELL,
	RESTART_MIN_CURSOR,
	RESYNC_MAX_BACK,
	SEPARATOR_MAX_LUM,
	TEXT_MIN_BRIGHT_FRACTION,
	WRAP_CHANGE_MIN,
} from "./constants"
import type { Sample } from "./sample"

/**
 * What one video frame was, once the tracker has resolved it:
 *   write   — the meter advanced (one or more cells drawn)
 *   idle    — the meter advanced but drew black for both players
 *   pause   — the game froze the meter mid-action (hitstop, super
 *             flash, KO); the lane holds its last colour
 *   stopped — the meter stopped because BOTH players went neutral;
 *             the lane goes dark (nothing is happening)
 *   dup     — the capture repeated the previous picture; no game time
 *   hidden  — the meter is not on screen (round transition, win card)
 */
export type FrameState =
	| "write"
	| "idle"
	| "pause"
	| "stopped"
	| "dup"
	| "hidden"

export interface TrackerResult {
	meta: {
		videoFrames: number
		duplicateVideoFrames: number
		meterHiddenFrames: number
		meterFrames: number
		pauseEvents: number
		pausedFrames: number
		restarts: number
		wraps: number
		anomalies: number
	}
	/** Per video frame. `meterIdx` is -1 while hidden. `wins` = lit round-win squares [p1, p2]. */
	video: {
		states: FrameState[]
		meterIdx: number[]
		wins: Array<[number, number]>
	}
	/** Per meter frame: the class drawn for each player, and the video frame it was first seen on. */
	meter: { p1: CellClass[]; p2: CellClass[]; videoFrame: number[] }
	/** [meter index, frames paused] */
	pauses: Array<[number, number]>
	restarts: number[]
	wraps: number[]
	anomalies: Array<{ vf: number; cursor: number; writes: number[] }>
}

/**
 * ── The on-screen meter, as measured ────────────────────────────────
 * The game writes exactly one cell per game frame, left to right, and
 * a black eraser cell leads the cursor by one. At cell 79 the whole
 * bar is re-drawn dimmed (the ghost of the previous pass) in the same
 * frame the last cell is written, then writing continues from cell 0.
 * When both players are neutral and someone acts, the bar clears and
 * restarts at cell 0. Neutral frames are drawn black. Hitstop and
 * freezes are NOT drawn: both bars stop while the picture keeps
 * changing. A run's length is printed as a white digit glyph over its
 * last cells once the run ends, and the glyph follows the cursor
 * while the run grows.
 *
 * ── How the tracker reads it ─────────────────────────────────────────
 * Feed one Sample per video frame. A write is a black-or-ghost cell
 * turning a fresh colour; an eraser is a coloured cell turning black
 * (cursor = eraser - 1). The cursor may only advance as far as the
 * elapsed frames allow, which keeps the moving glyph and ghost
 * flicker from yanking it. Frames with no visible change are buffered
 * and resolved by the next write: resuming at the next cell means the
 * gap was a pause; resuming d cells ahead means d-1 idle frames; a
 * restart from cell 0 means idle. Counting written cells therefore
 * gives game frames directly, immune to the capture's dropped or
 * duplicated frames.
 */
export class MeterTracker {
	private states: FrameState[] = []
	private meterIdx: number[] = []
	private wins: Array<[number, number]> = []
	/** Last class drawn for each player — what the meter shows while stopped. */
	private lastCls: [CellClass, CellClass] = ["empty", "empty"]
	private p1: CellClass[] = []
	private p2: CellClass[] = []
	private meterVf: number[] = []
	private pauses: Array<[number, number]> = []
	private restarts: number[] = []
	private wraps: number[] = []
	private anomalies: Array<{ vf: number; cursor: number; writes: number[] }> =
		[]
	private cursor: number | null = null
	private prevCells: Float32Array | null = null
	private prevPic: Uint8Array | null = null
	private gap = 0
	private gapVfs: number[] = []
	private gapStartVf = 0
	private vf = 0
	private dupCount = 0
	private hiddenCount = 0

	get meterFrames(): number {
		return this.meterVf.length
	}

	private append(c1: CellClass, c2: CellClass, vf: number): void {
		this.p1.push(c1)
		this.p2.push(c2)
		this.meterVf.push(vf)
		this.lastCls = [c1, c2]
	}

	/**
	 * A gap the cursor resumed from at the very next cell is either a
	 * freeze (the game held both players mid-action) or a stop (both
	 * players went neutral and the meter has nothing to draw). Freeze
	 * iff a player was in a state they cannot be idle in, or a player's
	 * action visibly continues across the gap (same class before and
	 * after, e.g. the white of a super flash, the stun of a juggle).
	 */
	private static isFreeze(
		before: [CellClass, CellClass],
		after: [CellClass, CellClass],
	): boolean {
		for (let i = 0; i < 2; i++) {
			const b = before[i]!
			if ((NON_TERMINAL_CLASSES as readonly string[]).includes(b))
				return true
			if (b !== "empty" && b === after[i]) return true
		}
		return false
	}

	/**
	 * A gap that ends in a restart or in the meter leaving the screen
	 * was both players standing neutral: the bar had stopped. Nothing
	 * is appended (no meter frames passed) and the frames read as
	 * `stopped` so the lanes go dark.
	 */
	private flushGapAsStopped(): void {
		for (const g of this.gapVfs) this.states[g] = "stopped"
		this.gapVfs.length = 0
		this.gap = 0
	}

	/** Class of a cell the cursor passed over; ghosts are not data, except on the wrap frame. */
	private static passedClass(c: Classified, wrap: boolean): CellClass {
		return (c.fresh || wrap) && c.cls !== "unknown" ? c.cls : "empty"
	}

	/** Class of the cell written this frame; a label glyph may already sit on it, so fresh is not required. */
	private static writtenClass(c: Classified): CellClass {
		return c.cls !== "unknown" ? c.cls : "empty"
	}

	feed(sample: Sample): void {
		const vf = this.vf++
		this.wins.push(sample.wins)
		// 1. Duplicated video frame → no game time passed.
		if (this.prevPic) {
			let acc = 0
			const n = sample.pic.length
			for (let i = 0; i < n; i++)
				acc += Math.abs(sample.pic[i]! - this.prevPic[i]!)
			if (acc / n < DUP_THRESHOLD) {
				this.prevPic = sample.pic
				this.dupCount++
				this.states.push("dup")
				this.meterIdx.push(this.meterFrames - 1)
				return
			}
		}
		this.prevPic = sample.pic
		// 2. Meter on screen?
		if (
			Math.max(sample.sepLum[0], sample.sepLum[1]) >= SEPARATOR_MAX_LUM ||
			sample.text <= TEXT_MIN_BRIGHT_FRACTION
		) {
			if (this.cursor !== null) this.flushGapAsStopped()
			this.hiddenCount++
			this.cursor = null
			this.prevCells = null
			this.states.push("hidden")
			this.meterIdx.push(-1)
			return
		}
		// 3. Classify cells; find writes and erasers.
		const cells = sample.cells
		const cls: Classified[][] = [[], []]
		for (let r = 0; r < 2; r++) {
			for (let j = 0; j < CELL_COUNT; j++) {
				const o = (r * CELL_COUNT + j) * 3
				cls[r]![j] = classify(cells[o]!, cells[o + 1]!, cells[o + 2]!)
			}
		}
		const writes = new Set<number>()
		const erasers = new Set<number>()
		let nchanged = 0
		if (this.prevCells) {
			const prev = this.prevCells
			for (let r = 0; r < 2; r++) {
				for (let j = 0; j < CELL_COUNT; j++) {
					const o = (r * CELL_COUNT + j) * 3
					const d =
						Math.abs(cells[o]! - prev[o]!) +
						Math.abs(cells[o + 1]! - prev[o + 1]!) +
						Math.abs(cells[o + 2]! - prev[o + 2]!)
					if (d <= CELL_CHANGE_THRESHOLD) continue
					nchanged++
					const k = cls[r]![j]!
					const pk = classify(prev[o]!, prev[o + 1]!, prev[o + 2]!)
					if (
						k.cls !== "empty" &&
						k.cls !== "unknown" &&
						k.fresh &&
						(pk.cls === "empty" || !pk.fresh)
					) {
						writes.add(j)
					} else if (k.cls === "empty" && pk.cls !== "empty") {
						erasers.add(j)
					}
				}
			}
		}
		// Two whole-bar events look alike in count and differ in what the
		// cells became: at the WRAP the previous pass is re-drawn dimmed
		// (ghosts); at a CLEAR — the game restarting the bar after both
		// players stood idle — every cell goes black. A clear means the
		// gap was a stop, nothing is appended, and the next write (at a
		// low cell) starts a fresh pass.
		const toEmpty = erasers.size
		const wholeBar = nchanged > WRAP_CHANGE_MIN
		const clear =
			(wholeBar && toEmpty * 2 > nchanged) ||
			(toEmpty >= CLEAR_MIN_CELLS &&
				nchanged - toEmpty <= CLEAR_MAX_OTHER_CHANGES)
		if (clear) {
			this.flushGapAsStopped()
			this.cursor = null
			if (!writes.size) {
				this.prevCells = Float32Array.from(cells)
				this.states.push("stopped")
				this.meterIdx.push(this.meterFrames - 1)
				return
			}
			// The first cell of the new pass was written in the clear
			// frame itself: fall through with no cursor so it is taken
			// as the start.
			erasers.clear()
		}
		const wrap = wholeBar && !clear
		if (wrap) {
			this.wraps.push(this.meterFrames)
			for (const j of [...writes]) if (j >= 3) writes.delete(j)
			for (const j of [...erasers]) if (j >= 4) erasers.delete(j)
		}
		const cands = new Set<number>(writes)
		for (const j of erasers) cands.add((j + CELL_COUNT - 1) % CELL_COUNT)
		// 4. Choose the cursor target.
		let target: number | null = null
		let restart = false
		if (cands.size) {
			if (this.cursor === null) {
				target = Math.max(...(writes.size ? writes : cands))
			} else {
				const cursor = this.cursor
				const maxd = Math.min(
					MAX_FORWARD_JUMP,
					this.gap + 1 + MAX_FORWARD_SLACK,
				)
				let bestD = 0
				for (const c of cands) {
					const d = (c - cursor + CELL_COUNT) % CELL_COUNT
					if (d >= 1 && d <= maxd && d > bestD) {
						bestD = d
						target = c
					}
				}
				if (target === null && writes.size) {
					if (
						Math.min(...writes) <= RESTART_MAX_CELL &&
						cursor >= RESTART_MIN_CURSOR
					) {
						restart = true
					} else {
						this.anomalies.push({
							vf,
							cursor,
							writes: [...writes].sort((a, b) => a - b),
						})
						let back = CELL_COUNT
						let bc: number | null = null
						for (const c of writes) {
							const d = (cursor - c + CELL_COUNT) % CELL_COUNT
							if (d < back) {
								back = d
								bc = c
							}
						}
						if (back <= RESYNC_MAX_BACK && bc !== null)
							this.cursor = bc
					}
				}
			}
		}
		// 5. Apply.
		let advanced = false
		if (restart || (this.cursor === null && cands.size)) {
			this.flushGapAsStopped()
			if (restart) this.restarts.push(this.meterFrames)
			const list = writes.size
				? [...writes].sort((a, b) => a - b)
				: [Math.max(...cands)]
			for (const j of list) {
				this.append(
					MeterTracker.passedClass(cls[0]![j]!, wrap),
					MeterTracker.passedClass(cls[1]![j]!, wrap),
					vf,
				)
			}
			this.cursor = list[list.length - 1]!
			advanced = true
		} else if (target !== null && this.cursor !== null) {
			const d = (target - this.cursor + CELL_COUNT) % CELL_COUNT
			const idle = d - 1
			for (let k = 1; k < d; k++) {
				const j = (this.cursor + k) % CELL_COUNT
				this.append(
					MeterTracker.passedClass(cls[0]![j]!, wrap),
					MeterTracker.passedClass(cls[1]![j]!, wrap),
					this.gapStartVf,
				)
			}
			const paused = this.gap - idle
			const after: [CellClass, CellClass] = [
				MeterTracker.writtenClass(cls[0]![target]!),
				MeterTracker.writtenClass(cls[1]![target]!),
			]
			const freeze =
				paused > 0 && MeterTracker.isFreeze(this.lastCls, after)
			if (freeze) this.pauses.push([this.meterFrames - idle, paused])
			const firstIdleCell = this.meterFrames - idle
			this.gapVfs.forEach((g, i) => {
				this.states[g] =
					i < paused ? (freeze ? "pause" : "stopped") : "idle"
				// Idle frames belong to the black cells the cursor passed, so
				// the lane reads empty there rather than the pre-gap colour.
				if (i >= paused && idle > 0)
					this.meterIdx[g] = Math.min(
						this.meterFrames - 1,
						firstIdleCell + (i - paused),
					)
			})
			this.gapVfs.length = 0
			this.gap = 0
			this.append(
				MeterTracker.writtenClass(cls[0]![target]!),
				MeterTracker.writtenClass(cls[1]![target]!),
				vf,
			)
			this.cursor = target
			advanced = true
		} else if (this.cursor !== null) {
			if (this.gap === 0) this.gapStartVf = vf
			this.gap++
			this.gapVfs.push(vf)
		}
		this.prevCells = Float32Array.from(cells)
		this.states.push(advanced ? "write" : "idle")
		this.meterIdx.push(this.meterFrames - 1)
	}

	finish(): TrackerResult {
		if (this.cursor !== null) this.flushGapAsStopped()
		mergeGlyphs(this.p1)
		mergeGlyphs(this.p2)
		const pausedFrames = this.pauses.reduce((a, [, r]) => a + r, 0)
		return {
			meta: {
				videoFrames: this.vf,
				duplicateVideoFrames: this.dupCount,
				meterHiddenFrames: this.hiddenCount,
				meterFrames: this.meterFrames,
				pauseEvents: this.pauses.length,
				pausedFrames,
				restarts: this.restarts.length,
				wraps: this.wraps.length,
				anomalies: this.anomalies.length,
			},
			video: {
				states: this.states,
				meterIdx: this.meterIdx,
				wins: this.wins,
			},
			meter: { p1: this.p1, p2: this.p2, videoFrame: this.meterVf },
			pauses: this.pauses,
			restarts: this.restarts,
			wraps: this.wraps,
			anomalies: this.anomalies.slice(0, 50),
		}
	}
}

/**
 * A short white run inside or ending a coloured run is the game's
 * run-length label, not invincibility: invincible frames do not sit
 * alone between two frames of the same action.
 */
export function mergeGlyphs(col: CellClass[]): void {
	const n = col.length
	let i = 0
	while (i < n) {
		if (col[i] !== "white") {
			i++
			continue
		}
		let j = i
		while (j < n && col[j] === "white") j++
		const prev = i > 0 ? col[i - 1]! : "empty"
		if (
			j - i <= GLYPH_MAX_CELLS &&
			i > 0 &&
			prev !== "empty" &&
			prev !== "white"
		) {
			for (let k = i; k < j; k++) col[k] = prev
		}
		i = j
	}
}
