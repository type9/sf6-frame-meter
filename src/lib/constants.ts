/**
 * Central constants for the SF6 frame-meter reader — the ONLY place
 * these live (no magic values at call sites, per house rule).
 *
 * Every pixel number is expressed for the 1280x720 reference capture
 * the reader was measured on; `geometryFor()` scales them to the
 * source's actual size, and `calibrateGeometry()` refines them from
 * a real frame. Thresholds are per-pixel means, so they do not scale.
 */

/**
 * Bumped whenever the tracker's output or the document shape changes.
 * Consumers that persist documents should store the version a
 * document was built with and re-process anything below the current
 * value, so a parser fix reaches every stored document without a
 * manual backfill. Display-only changes (colours, lane heights) must
 * NOT bump it — the document is semantic.
 */
export const FRAME_TIMELINE_VERSION = 3

/** Cells per meter row. SF6 draws 80, not the 60 the readout suggests. */
export const CELL_COUNT = 80

/** Reference capture the pixel coordinates below were measured on. */
export const BASE_WIDTH = 1280
export const BASE_HEIGHT = 720

/** Cell pitch and first cell centre / first separator, reference px. */
export const BASE_CELL_PITCH = 10
export const BASE_FIRST_CELL_X = 244
export const BASE_FIRST_SEP_X = 239

/** Cell centre rows for P1 and P2, reference px. */
export const BASE_ROW_Y: readonly [number, number] = [543, 570]

/** Half-size of the colour patch sampled at each cell centre (3 → 7x7). */
export const BASE_PATCH_RADIUS = 3

/**
 * The "Startup …" readout above the P1 row. Its white text is the
 * meter-visible gate together with the dark cell separators: the
 * round-end and win screens have neither.
 */
export const BASE_TEXT_PATCH = { x0: 238, y0: 516, x1: 300, y1: 530 } as const

/** r+g+b above this counts as readout text; below `SEPARATOR_MAX_LUM` as separator. */
export const TEXT_BRIGHT_LUM = 600
export const SEPARATOR_MAX_LUM = 150
/** Minimum bright fraction of the text patch for the meter to count as on screen. */
export const TEXT_MIN_BRIGHT_FRACTION = 0.03

/**
 * Fresh colour references (r, g, b): the per-class MEDIAN of cell
 * samples the classifier called fresh, measured over 5-35 s of both
 * reference VODs on the capture AND on Mux's capped-1080p re-encode
 * (the two agree within a few units). The brightness matters as much
 * as the hue: `fresh` is a ratio against the reference's r+g+b, so a
 * reference darker than the real paint (the original startup teal
 * was) lets the dimmed ghost of the previous pass pass as fresh, and
 * the tracker then reads the old bar the cursor is running over as
 * live data. Armor is unmeasured (no parries in either VOD).
 */
export const CLASS_COLOURS = {
	stun: [248, 254, 64],
	recovery: [15, 115, 176],
	startup: [19, 195, 143],
	noncounter: [92, 253, 241],
	active: [179, 26, 97],
	white: [210, 211, 211],
	projectile: [187, 127, 13],
	armor: [110, 40, 130],
} as const

/** r+g+b below this is a black (empty / eraser) cell. */
export const EMPTY_MAX_LUM = 120
/** A cell at least this fraction of its class brightness is the current pass, else a ghost. */
export const FRESH_MIN_RATIO = 0.8
/**
 * The ghost of the previous pass is painted at ~0.72-0.74 of fresh,
 * so a sample is plausible for a class only when its brightness falls
 * between a dimmed ghost and a slightly over-bright fresh cell. Hue
 * alone cannot tell non-counter cyan at a third of its paint from
 * recovery blue; implausible candidates are only considered when no
 * plausible one is in range.
 */
export const GHOST_MIN_RATIO = 0.55
export const FRESH_MAX_RATIO = 1.25
/**
 * Hue, not colour. The run-length label is white digits with a dark
 * outline drawn OVER the last cells of a run, and the re-encode blurs
 * its strokes wide; a cell's mean colour is therefore its paint plus
 * some white (the strokes) times some dimming (the outline). White
 * adds the same amount to every channel and dimming scales all three,
 * so the paint's HUE — the colour with its smallest channel removed,
 * normalised to unit sum — survives both. Classes are matched on
 * that; brightness alone decides fresh vs ghost. A cell whose chroma
 * (max − min) is under `WHITE_MAX_CHROMA` has no hue: it is white
 * paint (invincible) or a label on black. Hue further than
 * `HUE_MAX_DISTANCE` (unit-sum L1) from every class is unknown.
 */
export const WHITE_MAX_CHROMA = 40
export const HUE_MAX_DISTANCE = 0.45

/** Per-cell L1 colour change that counts as the cell having been redrawn. */
export const CELL_CHANGE_THRESHOLD = 60
/** Mean abs luminance diff of the sparse picture sample below which a video frame is a duplicate. */
export const DUP_THRESHOLD = 1.0
/** More changed cells than this in one frame = the whole bar re-dimmed at the wrap. */
export const WRAP_CHANGE_MIN = 24
/**
 * At least this many cells going black in one frame, with at most
 * `CLEAR_MAX_OTHER_CHANGES` other cells changing, is the bar CLEARING even when the bar was too empty
 * to reach `WRAP_CHANGE_MIN`. The eraser blanks one cell per frame
 * and the meter-hidden gate catches the bar leaving the screen, so
 * nothing else blanks a run of cells at once.
 */
export const CLEAR_MIN_CELLS = 6
/** Cells that may change otherwise in a clear frame: the new pass's first cell and its eraser. */
export const CLEAR_MAX_OTHER_CHANGES = 2
/** Cells the cursor may jump beyond the elapsed frames (missed duplicates). */
export const MAX_FORWARD_SLACK = 4
/** Hard cap on a single cursor advance. */
export const MAX_FORWARD_JUMP = 40
/**
 * A write at or below this cell while the cursor sits at or past
 * `RESTART_MIN_CURSOR` is the bar restarting after a clear the tracker
 * did not see. The first write after a clear is cell 0 (1-2 if a
 * frame was dropped); anything higher is a stray cell change and must
 * not yank the cursor. The cursor floor only has to keep a restart
 * apart from the cursor's own next cell, which the forward window
 * already bounds.
 */
export const RESTART_MAX_CELL = 3
export const RESTART_MIN_CURSOR = 8
/** Writes this far below a far-ahead cursor estimate mean the estimate ran ahead: resync. */
export const RESYNC_MAX_BACK = 12
/** A white run of at most this many cells ending a coloured run is the run-length label. */
export const GLYPH_MAX_CELLS = 3

/**
 * Pause-length classes (video frames). Shorter than hitstop = duplicate
 * frames; longer than hitstop = a freeze (super flash, cinematic). The
 * KO is not a duration: it is the pause nothing is written after.
 */
export const HITSTOP_MIN_FRAMES = 4
export const HITSTOP_MAX_FRAMES = 20

/** Default source frame rate when the adapter cannot probe it. */
export const DEFAULT_FPS = 60

/**
 * Round segmentation hysteresis. The meter-visible gate flickers for
 * a frame or two on KO flashes and transition cards, so hidden gaps
 * shorter than the bridge are treated as visible, and a visible
 * stretch only counts as a round if the meter actually advanced in
 * it (the KO aftermath keeps the bar on screen but frozen).
 */
export const ROUND_HIDDEN_BRIDGE_FRAMES = 60
export const ROUND_MIN_WRITE_FRAMES = 120

/**
 * Classes a player cannot be idle in. If either player's last drawn
 * cell is one of these when the meter stops advancing, the stop is a
 * game freeze (hitstop, super flash, KO) and the lane holds; if both
 * players' last cells are terminal-capable (recovery end, invincible
 * wakeup end, dash/jump end, black) the meter stopped because both
 * went neutral, and the lane must go dark instead of holding.
 */
export const NON_TERMINAL_CLASSES = [
	"active",
	"startup",
	"stun",
	"armor",
	"projectile",
] as const

/**
 * Round-win indicator squares beside the round timer (reference px,
 * 1280x720), sampled on the empty square's own row. Two per side — a
 * best-of-three. No third candidate: where no square exists the
 * sample lands on the stage, which on bright stages reads as a lit
 * badge and inflates the score. Best-of-five support needs the
 * square count detected first. Listed inner → outer so a count is the
 * number of lit entries.
 */
export const BASE_WIN_SQUARES = {
	p1: [
		{ x: 547, y: 28 },
		{ x: 517, y: 28 },
	],
	p2: [
		{ x: 733, y: 28 },
		{ x: 763, y: 28 },
	],
} as const
/**
 * An empty square is a thin dull grey parallelogram the stage shows
 * through (r+g+b ≈ 150-270, chroma ≤ 60 on both reference stages). A
 * won round turns it into a bigger coloured badge whose hue depends on
 * how the round was won (super, OD, …), so the test is RELATIVE to the
 * grey: visibly saturated (chroma = max-min of the mean RGB) or so
 * bright it cannot be the grey even if the badge reads white.
 */
export const WIN_LIT_MIN_CHROMA = 75
export const WIN_LIT_BRIGHT_LUM = 380

/** The KO badge must stay lit this many frames (to the end of the stretch) to count. */
export const SCORE_CHANGE_STABLE_FRAMES = 30
