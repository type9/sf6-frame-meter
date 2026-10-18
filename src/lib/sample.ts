import {
	CELL_COUNT,
	TEXT_BRIGHT_LUM,
	WIN_LIT_BRIGHT_LUM,
	WIN_LIT_MIN_CHROMA,
} from "./constants"
import type { Geometry } from "./geometry"

/**
 * Everything the tracker reads from one video frame. Adapters build
 * this from targeted pixel reads — roughly 160 small patches, 162
 * separator pixels, a 62x14 text patch and a sparse picture sample;
 * the rest of the frame is never touched.
 */
export interface Sample {
	/** Mean RGB per cell, rows P1 then P2: length 2 * CELL_COUNT * 3. */
	cells: Float32Array
	/** Mean r+g+b over the separator pixels of each row. */
	sepLum: [number, number]
	/** Fraction of bright pixels in the readout text patch. */
	text: number
	/** Sparse whole-picture luminance sample, same layout every frame. */
	pic: Uint8Array
	/** Lit round-win squares per player (the score shown beside the timer). */
	wins: [number, number]
}

export type PixelReader = (
	x: number,
	y: number,
) => readonly [number, number, number]

/** Build a Sample from a pixel reader in full-frame coordinates. */
export function sampleFromReader(
	px: PixelReader,
	pic: Uint8Array,
	geo: Geometry,
): Sample {
	const cells = new Float32Array(2 * CELL_COUNT * 3)
	const P = geo.patch
	const area = (2 * P + 1) * (2 * P + 1)
	for (let r = 0; r < 2; r++) {
		const y0 = geo.rowY[r]!
		for (let j = 0; j < CELL_COUNT; j++) {
			const x0 = geo.cellX[j]!
			let R = 0
			let G = 0
			let B = 0
			for (let dy = -P; dy <= P; dy++) {
				for (let dx = -P; dx <= P; dx++) {
					const c = px(x0 + dx, y0 + dy)
					R += c[0]
					G += c[1]
					B += c[2]
				}
			}
			const o = (r * CELL_COUNT + j) * 3
			cells[o] = R / area
			cells[o + 1] = G / area
			cells[o + 2] = B / area
		}
	}
	const sepLum = geo.rowY.map((y) => {
		let acc = 0
		for (const x of geo.sepX) {
			const c = px(x, y)
			acc += c[0] + c[1] + c[2]
		}
		return acc / geo.sepX.length
	}) as [number, number]
	let bright = 0
	let total = 0
	for (let y = geo.text.y0; y < geo.text.y1; y++) {
		for (let x = geo.text.x0; x < geo.text.x1; x++) {
			const c = px(x, y)
			total++
			if (c[0] + c[1] + c[2] > TEXT_BRIGHT_LUM) bright++
		}
	}
	const wins = [geo.wins.p1, geo.wins.p2].map((squares) => {
		let lit = 0
		for (const q of squares) {
			let R = 0
			let G = 0
			let B = 0
			let n = 0
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -3; dx <= 3; dx++) {
					const c = px(q.x + dx, q.y + dy)
					R += c[0]
					G += c[1]
					B += c[2]
					n++
				}
			}
			const r = R / n
			const g = G / n
			const b = B / n
			const lum = r + g + b
			const chroma = Math.max(r, g, b) - Math.min(r, g, b)
			if (chroma > WIN_LIT_MIN_CHROMA || lum > WIN_LIT_BRIGHT_LUM) lit++
		}
		return lit
	}) as [number, number]
	return { cells, sepLum, text: total ? bright / total : 0, pic, wins }
}

/** Luminance of one full-width row at the P1 cell row, for `calibrateGeometry`. */
export function rowLuminance(px: PixelReader, geo: Geometry): Float32Array {
	const y = geo.rowY[0]
	const out = new Float32Array(geo.width)
	for (let x = 0; x < geo.width; x++) {
		const c = px(x, y)
		out[x] = c[0] + c[1] + c[2]
	}
	return out
}
