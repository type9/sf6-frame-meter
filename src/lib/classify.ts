import {
	CLASS_COLOURS,
	EMPTY_MAX_LUM,
	FRESH_MAX_RATIO,
	FRESH_MIN_RATIO,
	GHOST_MIN_RATIO,
	HUE_MAX_DISTANCE,
	WHITE_MAX_CHROMA,
} from "./constants"

/**
 * What a meter cell is painted as. The first eight are the game's own
 * legend; `empty` is a black cell (neutral frame, or the eraser ahead
 * of the cursor); `unknown` is a hue too far from any reference
 * (compression noise, a transition).
 */
export type CellClass = keyof typeof CLASS_COLOURS | "empty" | "unknown"

export interface Classified {
	cls: CellClass
	/** Current pass at full brightness (true) or the dimmed ghost of the previous pass (false). */
	fresh: boolean
}

const WHITE_SUM =
	CLASS_COLOURS.white[0] + CLASS_COLOURS.white[1] + CLASS_COLOURS.white[2]

/** The chromatic classes with their hue (min channel removed, unit sum) and paint brightness. */
const HUE_CLASSES = (
	Object.keys(CLASS_COLOURS) as Array<keyof typeof CLASS_COLOURS>
)
	.filter((k) => k !== "white")
	.map((k) => {
		const [r, g, b] = CLASS_COLOURS[k]
		const m = Math.min(r, g, b)
		const c = r + g + b - 3 * m
		return { cls: k, hue: [(r - m) / c, (g - m) / c, (b - m) / c], sum: r + g + b }
	})

/**
 * Classify a cell's mean colour. Hue (see `WHITE_MAX_CHROMA` in the
 * constants) picks the class — a label's white strokes and dark
 * outline cannot move it — and brightness against the class's paint
 * decides fresh vs ghost. Candidates whose implied brightness ratio
 * falls outside the ghost..fresh band are only used when nothing
 * plausible is in range.
 */
export function classify(r: number, g: number, b: number): Classified {
	const lum = r + g + b
	if (lum < EMPTY_MAX_LUM) return { cls: "empty", fresh: true }
	const m = Math.min(r, g, b)
	const chroma = Math.max(r, g, b) - m
	if (chroma < WHITE_MAX_CHROMA)
		return { cls: "white", fresh: lum > FRESH_MIN_RATIO * WHITE_SUM }
	const c = lum - 3 * m
	const hr = (r - m) / c
	const hg = (g - m) / c
	const hb = (b - m) / c
	// Nearest hue among brightness-plausible classes; a class outside
	// the band only wins when no plausible one is within range (a
	// label's white over active paint is over-bright but still red).
	let best = -1
	let bd = Infinity
	let fallback = -1
	let fd = Infinity
	for (let i = 0; i < HUE_CLASSES.length; i++) {
		const k = HUE_CLASSES[i]!
		const d =
			Math.abs(hr - k.hue[0]!) +
			Math.abs(hg - k.hue[1]!) +
			Math.abs(hb - k.hue[2]!)
		if (d > HUE_MAX_DISTANCE) continue
		const s = lum / k.sum
		if (s >= GHOST_MIN_RATIO && s <= FRESH_MAX_RATIO) {
			if (d < bd) {
				bd = d
				best = i
			}
		} else if (d < fd) {
			fd = d
			fallback = i
		}
	}
	if (best < 0) best = fallback
	if (best < 0) return { cls: "unknown", fresh: true }
	const k = HUE_CLASSES[best]!
	return { cls: k.cls, fresh: lum > FRESH_MIN_RATIO * k.sum }
}
