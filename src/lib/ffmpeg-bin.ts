/**
 * Locate the `ffmpeg-static` binary (an optional peer dependency) by
 * walking the filesystem from this module's directory. Server / CLI
 * only; imported by subpath (`sf6-frame-meter/lib/ffmpeg-bin`). Any
 * other ffmpeg works too: pass its path straight to `probeVideo` /
 * `createFfmpegSource` and skip this helper.
 *
 * Why a walk and not `import ffmpegPath from "ffmpeg-static"` or
 * `createRequire().resolve`: bundlers (webpack in particular) inline
 * the package's index — so its `__dirname` becomes the bundle's — and
 * rewrite `require.resolve` to a module id. The filesystem walk is
 * the one approach bundlers have no opinion about. `fs.realpathSync`
 * follows the pnpm symlink to the real binary.
 *
 * Serverless deployments: make sure the binary is traced into the
 * function output (Next.js: `outputFileTracingIncludes` for every
 * route that spawns ffmpeg), or it is not on disk at runtime.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

let cached: string | null = null

/**
 * This module's directory in both module systems: the published
 * build is ESM (`import.meta.url`); bundlers that compile the source
 * as CommonJS still provide `__dirname`.
 */
function moduleDir(): string {
	if (typeof __dirname !== "undefined") return __dirname
	return path.dirname(fileURLToPath(import.meta.url))
}

export function getFfmpegBin(): string {
	if (cached) return cached
	const tried: string[] = []
	const bin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
	// Two walk roots: this module's directory (real for non-bundled
	// code) and `process.cwd()` (the app dir — where `ffmpeg-static`
	// is a direct dependency — when a bundler has replaced the module
	// path with a virtual one).
	const here = moduleDir()
	for (const start of [here, process.cwd()]) {
		let dir = start
		for (;;) {
			const candidate = path.join(
				dir,
				"node_modules",
				"ffmpeg-static",
				bin,
			)
			tried.push(candidate)
			if (fs.existsSync(candidate)) {
				cached = fs.realpathSync(candidate)
				return cached
			}
			const parent = path.dirname(dir)
			if (parent === dir) break
			dir = parent
		}
	}
	throw new Error(
		`ffmpeg-static binary not found via filesystem walk from ${here}. Tried: ${tried.join(", ")}`,
	)
}
