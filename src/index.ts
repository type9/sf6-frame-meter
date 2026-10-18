/**
 * Public surface of `sf6-frame-meter`.
 *
 * Reads the Street Fighter 6 replay viewer's on-screen frame meter
 * out of a video and turns it into a semantic timeline document.
 * Pure logic — no DB, no SDK clients, nothing Node- or DOM-specific
 * on this barrel, so it is safe in server actions, route handlers and
 * client bundles alike.
 *
 * Layering
 * ────────
 *   constants → classify / geometry / sample → tracker → timeline
 *
 * Frame SOURCES stay off the barrel because each binds to a runtime:
 *   - `./lib/node-ffmpeg-source` (child_process; server + CLI)
 *   - `./lib/browser-source`     (OffscreenCanvas; client)
 *
 * Typical importers: a server-side processing job (barrel + the Node
 * source) and a timeline renderer (types + palette keys only).
 */
export { classify } from "./lib/classify"
export type { CellClass, Classified } from "./lib/classify"
export {
	applyCalibration,
	calibrateGeometry,
	geometryFor,
} from "./lib/geometry"
export type { Calibration, Geometry } from "./lib/geometry"
export { rowLuminance, sampleFromReader } from "./lib/sample"
export type { PixelReader, Sample } from "./lib/sample"
export { MeterTracker, mergeGlyphs } from "./lib/tracker"
export type { FrameState, TrackerResult } from "./lib/tracker"
export {
	bridgedVisibility,
	buildFrameTimeline,
	segmentRounds,
} from "./lib/timeline"
export type {
	BuildTimelineOptions,
	FrameTimelineDocument,
	LaneSpan,
	PauseSpan,
	RoundRange,
	TimeRange,
} from "./lib/timeline"
export {
	CELL_COUNT,
	CLASS_COLOURS,
	DEFAULT_FPS,
	FRAME_TIMELINE_VERSION,
} from "./lib/constants"
