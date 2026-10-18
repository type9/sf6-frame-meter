import { defineConfig } from "tsup"

/**
 * Publish build. The workspace consumes `src/` directly (see
 * `exports` in package.json); `publishConfig.exports` swaps to this
 * `dist/` output at `pnpm publish` time. One entry per public subpath
 * so `<pkg>/lib/<name>` resolves to its own file — the barrel stays
 * runtime-neutral while the Node (child_process) and browser
 * (OffscreenCanvas) frame sources ship as opt-in subpaths.
 */
export default defineConfig({
	entry: ["src/index.ts", "src/lib/*.ts"],
	format: ["esm"],
	target: "es2022",
	platform: "neutral",
	// The shared tsconfig sets `incremental`, which tsc rejects for a
	// declaration-only emit; override it for the dts pass.
	dts: { compilerOptions: { incremental: false } },
	sourcemap: true,
	clean: true,
	splitting: true,
	treeshake: true,
	external: ["ffmpeg-static"],
})
