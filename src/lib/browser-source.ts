/**
 * Browser frame source: drive a <video> through requestVideoFrameCallback,
 * draw the same three regions the Node source uses (meter rows, HUD
 * band with the win squares, picture thumbnail) to an OffscreenCanvas
 * and feed the tracker. Not exercised by the server pipeline; kept
 * beside the Node source so a client-side path (process-at-upload) can
 * reuse the same core. Keep playbackRate <= 1 so no presented frame is
 * skipped; for guaranteed every-frame access use WebCodecs and call
 * `feed` per decoded VideoFrame instead.
 */
import { CELL_COUNT } from "./constants"
import { geometryFor } from "./geometry"
import { sampleFromReader } from "./sample"
import { MeterTracker, type TrackerResult } from "./tracker"

export interface TrackVideoOptions {
	onDone?: (result: TrackerResult) => void
}

const PIC_W = 320
const PIC_H = 180
const PIC_STRIDE = 4

export function trackVideoElement(
	video: HTMLVideoElement,
	{ onDone }: TrackVideoOptions = {},
): MeterTracker {
	const geo = geometryFor(video.videoWidth, video.videoHeight)
	const margin = 16
	const cx0 = Math.max(0, geo.text.x0 - margin)
	const cy0 = Math.max(0, geo.text.y0 - margin)
	const CW = Math.min(video.videoWidth, geo.sepX[CELL_COUNT]! + margin) - cx0
	const CH =
		Math.min(video.videoHeight, geo.rowY[1] + geo.patch + margin) - cy0
	const hx0 = Math.max(0, geo.hud.x0)
	const hy0 = Math.max(0, geo.hud.y0)
	const HW = Math.min(video.videoWidth, geo.hud.x1) - hx0
	const HH = Math.min(video.videoHeight, geo.hud.y1) - hy0
	const FW = Math.max(CW, HW, PIC_W)
	const canvas = new OffscreenCanvas(FW, CH + HH + PIC_H)
	const ctx = canvas.getContext("2d", { willReadFrequently: true })
	if (!ctx) throw new Error("2d context unavailable")
	const tracker = new MeterTracker()
	let lastPresented = -1

	const onFrame: VideoFrameRequestCallback = (_now, meta) => {
		if (video.ended) return
		ctx.drawImage(video, cx0, cy0, CW, CH, 0, 0, CW, CH)
		ctx.drawImage(video, hx0, hy0, HW, HH, 0, CH, HW, HH)
		ctx.drawImage(
			video,
			0,
			0,
			video.videoWidth,
			video.videoHeight,
			0,
			CH + HH,
			PIC_W,
			PIC_H,
		)
		const data = ctx.getImageData(0, 0, FW, CH + HH + PIC_H).data
		const px = (
			x: number,
			y: number,
		): readonly [number, number, number] => {
			let lx = x - cx0
			let ly = y - cy0
			let o = -1
			if (lx >= 0 && ly >= 0 && lx < CW && ly < CH) {
				o = (ly * FW + lx) * 4
			} else {
				lx = x - hx0
				ly = y - hy0
				if (lx >= 0 && ly >= 0 && lx < HW && ly < HH)
					o = ((CH + ly) * FW + lx) * 4
			}
			if (o < 0) return [0, 0, 0]
			return [data[o]!, data[o + 1]!, data[o + 2]!]
		}
		const pic = new Uint8Array((PIC_W / PIC_STRIDE) * (PIC_H / PIC_STRIDE))
		let k = 0
		for (let y = 0; y < PIC_H; y += PIC_STRIDE) {
			for (let x = 0; x < PIC_W; x += PIC_STRIDE) {
				const o = ((CH + HH + y) * FW + x) * 4
				pic[k++] = (data[o]! + data[o + 1]! + data[o + 2]!) / 3
			}
		}
		if (meta.presentedFrames !== lastPresented) {
			tracker.feed(sampleFromReader(px, pic, geo))
			lastPresented = meta.presentedFrames
		}
		video.requestVideoFrameCallback(onFrame)
	}
	video.requestVideoFrameCallback(onFrame)
	video.addEventListener("ended", () => onDone?.(tracker.finish()), {
		once: true,
	})
	return tracker
}
