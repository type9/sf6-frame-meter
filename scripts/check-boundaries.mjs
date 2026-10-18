#!/usr/bin/env node
/**
 * Public-package boundary check — the enforcement half of
 * OPEN_SOURCE_STANDARD.md.
 *
 * A workspace package is ENROLLED as public when its package.json has
 * an explicit `"private": false`. For every enrolled package this
 * script fails if:
 *
 *   1. any file under src/ mentions a private workspace scope
 *      (`@colorchordsapp/`) — imports AND comments, so stale internal
 *      references cannot leak into a published build;
 *   2. any src file imports a forbidden module: DMNO, or a proprietary
 *      service SDK (Mux, Stripe, better-auth, Ably, Neon, R2/S3,
 *      Resend, Sentry, Next.js internals);
 *   3. any src file reads `process.env` (public packages take config
 *      as arguments);
 *   4. a non-relative import is not declared in dependencies /
 *      peerDependencies / optionalDependencies (node: builtins exempt;
 *      src/scripts/** may use devDependencies);
 *   5. a declared dependency uses the `workspace:` protocol;
 *   6. required metadata is missing: license, description, repository
 *      (the PUBLIC repo url), files, publishConfig.access === "public",
 *      a build script, `type: module`, LICENSE + README.md +
 *      CHANGELOG.md on disk.
 *
 * Usage (from the repo root — paths resolve against process.cwd()):
 *         node scripts/opensource/check-boundaries.mjs [packages/<dir> ...]
 *         (no args = every enrolled package; in an exported public repo
 *         the package IS the root: `node scripts/check-boundaries.mjs .`)
 * Exit 0 = clean, 1 = violations (listed), 2 = usage error.
 *
 * Zero dependencies on purpose: it must run anywhere node runs,
 * including the public repo's CI (the export copies it there).
 */
import fs from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"

const ROOT = process.cwd()
const WORKSPACE_DIRS = ["packages", "apps"]

/** Scopes that are private to this monorepo. Never allowed in a public package. */
const PRIVATE_SCOPES = ["@colorchordsapp/"]

/** Module specifiers (exact or prefix) a public package may not import. */
const FORBIDDEN_IMPORTS = [
	"dmno",
	"@dmno/",
	"@mux/",
	"stripe",
	"@stripe/",
	"better-auth",
	"ably",
	"@neondatabase/",
	"@aws-sdk/client-s3",
	"resend",
	"@sentry/",
	"next",
	"next/",
	"server-only",
	"drizzle-orm",
]

const REQUIRED_FILES = ["LICENSE", "README.md", "CHANGELOG.md"]

const SRC_EXT = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".mjs",
	".cjs",
	".jsx",
])
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

/* ───────────────────────── helpers ───────────────────────── */

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"))
}

function* walk(dir) {
	if (!fs.existsSync(dir)) return
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) yield* walk(full)
		else if (SRC_EXT.has(path.extname(entry.name))) yield full
	}
}

/** Bare package name from a specifier: `@scope/pkg/sub` → `@scope/pkg`. */
function packageName(spec) {
	const parts = spec.split("/")
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(source) {
	const out = []
	for (const m of source.matchAll(IMPORT_RE)) {
		const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
		if (spec) out.push(spec)
	}
	return out
}

function enrolledPackages() {
	const found = []
	for (const ws of WORKSPACE_DIRS) {
		const base = path.join(ROOT, ws)
		if (!fs.existsSync(base)) continue
		for (const name of fs.readdirSync(base)) {
			const pj = path.join(base, name, "package.json")
			if (!fs.existsSync(pj)) continue
			if (readJson(pj).private === false) found.push(path.join(ws, name))
		}
	}
	return found
}

/* ───────────────────────── checks ────────────────────────── */

function checkPackage(relDir) {
	const dir = path.join(ROOT, relDir)
	const pj = path.join(dir, "package.json")
	const problems = []
	const problem = (msg) => problems.push(msg)

	if (!fs.existsSync(pj)) return [`${relDir}: no package.json`]
	const pkg = readJson(pj)

	/* metadata */
	if (pkg.private !== false)
		problem(`package.json: "private" must be exactly false to enroll`)
	if (!pkg.license) problem(`package.json: missing "license"`)
	if (!pkg.description) problem(`package.json: missing "description"`)
	if (!pkg.repository?.url) problem(`package.json: missing "repository.url"`)
	else if (/colorchordsapp/i.test(pkg.repository.url))
		problem(
			`package.json: repository.url points at the private monorepo — it must be the PUBLIC repo (npm provenance verifies it against the publishing repo)`,
		)
	if (!Array.isArray(pkg.files) || pkg.files.length === 0)
		problem(`package.json: missing "files" allowlist`)
	if (pkg.publishConfig?.access !== "public")
		problem(`package.json: publishConfig.access must be "public"`)
	if (!pkg.scripts?.build)
		problem(
			`package.json: missing "build" script (published artifact must be built)`,
		)
	if (pkg.type !== "module") problem(`package.json: "type" must be "module"`)
	for (const f of REQUIRED_FILES) {
		if (!fs.existsSync(path.join(dir, f))) problem(`missing ${f}`)
	}

	/* declared deps */
	const runtimeDeps = {
		...(pkg.dependencies ?? {}),
		...(pkg.peerDependencies ?? {}),
		...(pkg.optionalDependencies ?? {}),
	}
	const devDeps = pkg.devDependencies ?? {}
	for (const [name, spec] of Object.entries({ ...runtimeDeps, ...devDeps })) {
		if (String(spec).startsWith("workspace:"))
			problem(`dependency ${name} uses workspace: protocol`)
		if (PRIVATE_SCOPES.some((s) => name.startsWith(s)))
			problem(`dependency ${name} is a private workspace package`)
	}

	/* sources */
	const srcDir = path.join(dir, "src")
	for (const file of walk(srcDir)) {
		const rel = path.relative(dir, file)
		const text = fs.readFileSync(file, "utf8")
		const isScript = rel.startsWith(`src${path.sep}scripts${path.sep}`)

		for (const scope of PRIVATE_SCOPES) {
			if (text.includes(scope)) {
				const line =
					text.split("\n").findIndex((l) => l.includes(scope)) + 1
				problem(
					`${rel}:${line}: mentions private scope "${scope}" (import or comment)`,
				)
			}
		}
		if (/\bprocess\.env\b/.test(text)) {
			const line =
				text.split("\n").findIndex((l) => /\bprocess\.env\b/.test(l)) +
				1
			problem(
				`${rel}:${line}: reads process.env — take configuration as arguments`,
			)
		}

		for (const spec of importsOf(text)) {
			if (spec.startsWith(".") || spec.startsWith("/")) continue
			if (BUILTINS.has(spec)) continue
			if (
				FORBIDDEN_IMPORTS.some(
					(f) =>
						spec === f ||
						spec.startsWith(f.endsWith("/") ? f : `${f}/`),
				)
			) {
				problem(`${rel}: imports forbidden module "${spec}"`)
				continue
			}
			const name = packageName(spec)
			if (name in runtimeDeps) continue
			if (isScript && name in devDeps) continue
			problem(
				`${rel}: imports "${spec}" but "${name}" is not declared in dependencies/peerDependencies${isScript ? "/devDependencies" : ""}`,
			)
		}
	}

	return problems.map((p) => `${relDir}: ${p}`)
}

/* ───────────────────────── main ──────────────────────────── */

const args = process.argv.slice(2)
const targets = args.length
	? args.map((a) => a.replace(/\/$/, ""))
	: enrolledPackages()

if (targets.length === 0) {
	console.log(
		'check-boundaries: no enrolled public packages (none with "private": false)',
	)
	process.exit(0)
}

let failed = false
for (const t of targets) {
	const problems = checkPackage(t)
	if (problems.length) {
		failed = true
		console.error(`✖ ${t}`)
		for (const p of problems) console.error(`    ${p}`)
	} else {
		console.log(`✔ ${t}`)
	}
}
process.exit(failed ? 1 : 0)
