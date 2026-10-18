import {
	BASE_CELL_PITCH,
	BASE_FIRST_CELL_X,
	BASE_FIRST_SEP_X,
	BASE_HEIGHT,
	BASE_PATCH_RADIUS,
	BASE_ROW_Y,
	BASE_TEXT_PATCH,
	BASE_WIDTH,
	BASE_WIN_SQUARES,
	CELL_COUNT,
} from "./constants"

/** Pixel layout of the on-screen meter for one source size. */
export interface Geometry {
	width: number
	height: number
	/** Cell centre x per cell (CELL_COUNT entries). */
	cellX: number[]
	/** Separator x per boundary (CELL_COUNT + 1 entries). */
	sepX: number[]
	/** Cell centre y for P1 and P2. */
	rowY: [number, number]
	/** Half-size of the sampled colour patch. */
	patch: number
	/** Readout text patch used by the meter-visible gate. */
	text: { x0: number; y0: number; x1: number; y1: number }
	/** Round-win squares beside the timer, inner → outer, per player. */
	wins: {
		p1: Array<{ x: number; y: number }>
		p2: Array<{ x: number; y: number }>
	}
	/** Bounding box around the win squares — the second region a frame source must deliver. */
	hud: { x0: number; y0: number; x1: number; y1: number }
	/** True when `calibrateGeometry` overrode the scaled guess. */
	calibrated: boolean
}

/**
 * Why scale rather than hardcode: the SF6 HUD is laid out in
 * normalised screen coordinates, so a 1080p capture is the 720p
 * reference times 1.5 on both axes. Everything is derived from the
 * reference constants and two scale factors so a new size needs no
 * new numbers.
 */
export function geometryFor(width: number, height: number): Geometry {
	const sx = width / BASE_WIDTH
	const sy = height / BASE_HEIGHT
	const scaleQ = (q: { x: number; y: number }) => ({
		x: Math.round(q.x * sx),
		y: Math.round(q.y * sy),
	})
	const wins = {
		p1: BASE_WIN_SQUARES.p1.map(scaleQ),
		p2: BASE_WIN_SQUARES.p2.map(scaleQ),
	}
	const all = [...wins.p1, ...wins.p2]
	const pad = Math.max(4, Math.round(6 * sx))
	return {
		width,
		height,
		cellX: Array.from({ length: CELL_COUNT }, (_, i) =>
			Math.round((BASE_FIRST_CELL_X + BASE_CELL_PITCH * i) * sx),
		),
		sepX: Array.from({ length: CELL_COUNT + 1 }, (_, i) =>
			Math.round((BASE_FIRST_SEP_X + BASE_CELL_PITCH * i) * sx),
		),
		rowY: [Math.round(BASE_ROW_Y[0] * sy), Math.round(BASE_ROW_Y[1] * sy)],
		patch: Math.max(1, Math.round(BASE_PATCH_RADIUS * sx)),
		text: {
			x0: Math.round(BASE_TEXT_PATCH.x0 * sx),
			y0: Math.round(BASE_TEXT_PATCH.y0 * sy),
			x1: Math.round(BASE_TEXT_PATCH.x1 * sx),
			y1: Math.round(BASE_TEXT_PATCH.y1 * sy),
		},
		wins,
		hud: {
			x0: Math.min(...all.map((q) => q.x)) - pad,
			y0: Math.min(...all.map((q) => q.y)) - pad,
			x1: Math.max(...all.map((q) => q.x)) + pad,
			y1: Math.max(...all.map((q) => q.y)) + pad,
		},
		calibrated: false,
	}
}

export interface Calibration {
	pitch: number
	firstSepX: number
	/** Separator-vs-cell contrast, 0..1. Below ~0.3 the row was empty and nothing was learned. */
	confidence: number
}

/**
 * Fit the cell pitch and phase from one luminance row sampled across
 * the full width at the P1 cell row. The bar's separators are a
 * periodic dark comb; autocorrelation over the plausible pitch range
 * finds the period and the darkest phase gives the first separator.
 *
 * Only meaningful on a frame where the bar has colour (the comb is
 * invisible on a black bar) — callers should retry on later frames
 * until `confidence` clears the floor.
 */
export function calibrateGeometry(
	rowLum: ArrayLike<number>,
	geo: Geometry,
): Calibration | null {
	const guessPitch = (geo.sepX[1] ?? 0) - (geo.sepX[0] ?? 0)
	if (guessPitch <= 0) return null
	const lo = Math.max(3, Math.floor(guessPitch * 0.6))
	const hi = Math.ceil(guessPitch * 1.4)
	const x0 = Math.max(0, (geo.sepX[0] ?? 0) - guessPitch * 2)
	const x1 = Math.min(
		rowLum.length,
		(geo.sepX[CELL_COUNT] ?? 0) + guessPitch * 2,
	)
	const n = x1 - x0
	if (n < guessPitch * 10) return null
	const seg = new Float64Array(n)
	let mean = 0
	for (let i = 0; i < n; i++) {
		seg[i] = rowLum[x0 + i] ?? 0
		mean += seg[i]!
	}
	mean /= n
	for (let i = 0; i < n; i++) seg[i] = seg[i]! - mean
	let bestPitch = guessPitch
	let bestScore = -Infinity
	for (let p = lo; p <= hi; p++) {
		let acc = 0
		for (let i = 0; i + p < n; i++) acc += seg[i]! * seg[i + p]!
		const score = acc / (n - p)
		if (score > bestScore) {
			bestScore = score
			bestPitch = p
		}
	}
	// Phase: the offset within one pitch with the lowest mean luminance
	// is the separator comb.
	let bestPhase = 0
	let bestPhaseLum = Infinity
	let brightest = -Infinity
	for (let ph = 0; ph < bestPitch; ph++) {
		let acc = 0
		let count = 0
		for (let x = ph; x < n; x += bestPitch) {
			acc += rowLum[x0 + x] ?? 0
			count++
		}
		const avg = count ? acc / count : Infinity
		if (avg < bestPhaseLum) {
			bestPhaseLum = avg
			bestPhase = ph
		}
		if (avg > brightest) brightest = avg
	}
	const contrast = brightest > 0 ? (brightest - bestPhaseLum) / brightest : 0
	// Snap the first separator to the comb position nearest the guess.
	const guessFirst = geo.sepX[0] ?? 0
	const k = Math.round((guessFirst - (x0 + bestPhase)) / bestPitch)
	const firstSepX = x0 + bestPhase + k * bestPitch
	return {
		pitch: bestPitch,
		firstSepX,
		confidence: Math.max(0, Math.min(1, contrast)),
	}
}

/** Apply a calibration to a geometry, keeping rows and text patch. */
export function applyCalibration(geo: Geometry, cal: Calibration): Geometry {
	const half = cal.pitch / 2
	return {
		...geo,
		cellX: Array.from({ length: CELL_COUNT }, (_, i) =>
			Math.round(cal.firstSepX + half + cal.pitch * i),
		),
		sepX: Array.from({ length: CELL_COUNT + 1 }, (_, i) =>
			Math.round(cal.firstSepX + cal.pitch * i),
		),
		patch: Math.max(1, Math.round(cal.pitch * 0.3)),
		calibrated: true,
	}
}
