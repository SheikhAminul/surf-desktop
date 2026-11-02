// Stages what the desktop app ships besides its own small executable (`pnpm assemble`; Tauri runs it before `dev`
// and `build`):
//
// - src-tauri/resources/app/: browsy-app's server bundled into one file (with @browsy/core and their dependencies),
//   its built UI and the automation extension. Nothing of browsy-app is copied by hand or changed: the desktop app runs
//   exactly the `browsy` command, with `--embedded`.
// - src-tauri/binaries/browsy-node-<target>: the Node.js runtime it runs on, the version in .node-version, from nodejs.org
//   (checksum verified), or BROWSY_NODE (a node binary of that version, for offline builds).
//
// browsy-app, and with it browsy-core and the extension, is brought up to date first by its own `pnpm bootstrap`.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauri = join(root, 'src-tauri')
const windows = process.platform === 'win32'

const fail = (message: string): never => {
	console.error(`assemble: ${message}`)
	process.exit(1)
}
const say = (message: string) => console.log(`assemble: ${message}`)
const readJson = (path: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
}

// ── browsy-app ───────────────────────────────────────────────────────────────────────────────────────────────────

const app = resolve(process.env.BROWSY_APP_DIR || join(root, '..', 'browsy-app'))
if (readJson(join(app, 'package.json'))?.name !== 'browsy') fail(`browsy-app isn't at ${app}: run pnpm bootstrap, or set BROWSY_APP_DIR.`)

/** pnpm, as the one running this script (`pnpm assemble`, or Tauri's `pnpm assemble`), or from the PATH. */
const pnpm = (args: string[], cwd: string) => {
	const self = process.env.npm_execpath
	const [command, prefix, shell] =
		self && /pnpm/i.test(basename(self))
			? /\.[cm]?js$/i.test(self)
				? [process.execPath, [self], false]
				: [self, [], false]
			: ['pnpm', [], windows]
	const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit', shell })
	if (result.status !== 0) fail(`pnpm ${args.join(' ')} failed in ${cwd}`)
}

if (process.env.BROWSY_ASSEMBLE_SKIP_BOOTSTRAP !== '1') {
	say(`bringing browsy-app up to date (${app})`)
	pnpm(['bootstrap', '--yes'], app)
}
const core = realpathSync(join(app, 'node_modules', '@browsy', 'core'))
for (const [what, path] of [
	['browsy-app', join(app, 'dist', 'web', 'index.html')],
	['browsy-core', join(core, 'dist', 'index.js')],
] as const) {
	if (!existsSync(path)) fail(`${what} isn't built (${path} is missing): run pnpm bootstrap.`)
}

// ── The app: bundled server, UI, extension ──────────────────────────────────────────────────────────────────────

const out = join(tauri, 'resources', 'app')
rmSync(out, { recursive: true, force: true })
await build({
	absWorkingDir: app,
	entryPoints: [join(app, 'server', 'cli.ts')],
	outfile: join(out, 'server', 'browsy.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node26',
	// ws's optional native speed-ups: it works without them.
	external: ['bufferutil', 'utf-8-validate'],
	// Dependencies written as CommonJS still call require().
	banner: { js: "import { createRequire as browsyRequire } from 'node:module'; const require = browsyRequire(import.meta.url);" },
	legalComments: 'linked',
	logLevel: 'warning',
})
// browsy-app finds its UI (../web) and @browsy/core its extension (../extension) next to the server, and both read
// their version from ../package.json: the desktop app's version, the one people see and update.
cpSync(join(app, 'dist', 'web'), join(out, 'web'), { recursive: true })
const version = String(readJson(join(tauri, 'tauri.conf.json'))?.version ?? fail('tauri.conf.json has no version'))
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'browsy-desktop', version, private: true }, null, '\t')}\n`)
const extension = join(core, 'extension')
if (existsSync(join(extension, 'manifest.json'))) cpSync(extension, join(out, 'extension'), { recursive: true })
else if (process.env.TAURI_ENV_DEBUG === 'false') fail(`the automation extension isn't in browsy-core (${extension}): run pnpm bootstrap.`)
else say('no automation extension in browsy-core: automation sessions are unavailable in this build')
say(`app assembled (${out})`)

// ── Node.js ──────────────────────────────────────────────────────────────────────────────────────────────────────

const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8').trim()
const target =
	process.env.TAURI_ENV_TARGET_TRIPLE ||
	(/host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1] ?? fail("can't tell the target (rustc -vV)"))
const os = target.includes('windows') ? 'win' : target.includes('apple-darwin') ? 'darwin' : target.includes('linux') ? 'linux' : null
const arch = target.startsWith('x86_64') ? 'x64' : target.startsWith('aarch64') ? 'arm64' : null
if (!os || !arch) fail(`Node.js isn't published for ${target}`)
const binaries = join(tauri, 'binaries')
// Its own name: Linux packages install it in /usr/bin, where `node` may be another Node.js.
const binary = join(binaries, `browsy-node-${target}${os === 'win' ? '.exe' : ''}`)
const stamp = `${binary}.version`

const nodeVersionOf = (path: string) => execFileSync(path, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '')

if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, 'utf8') === nodeVersion) {
	say(`Node.js ${nodeVersion} for ${target} is in place`)
} else {
	mkdirSync(binaries, { recursive: true })
	const local = process.env.BROWSY_NODE
	if (local) {
		const found = nodeVersionOf(local)
		if (found !== nodeVersion) fail(`BROWSY_NODE is Node.js ${found}; .node-version asks for ${nodeVersion}`)
		copyFileSync(local, binary)
	} else {
		const name = `node-v${nodeVersion}-${os}-${arch}`
		const file = `${name}.${os === 'win' ? 'zip' : os === 'darwin' ? 'tar.gz' : 'tar.xz'}`
		const base = `https://nodejs.org/dist/v${nodeVersion}`
		const cache = join(root, '.cache', 'node')
		const archive = join(cache, file)
		const get = async (url: string) => {
			const response = await fetch(url)
			if (!response.ok) fail(`couldn't download ${url} (HTTP ${response.status})`)
			return Buffer.from(await response.arrayBuffer())
		}
		const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8')
		const expected = new RegExp(`^([0-9a-f]{64})\\s+${file.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1] ?? fail(`no checksum for ${file}`)
		const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
		if (!existsSync(archive) || sha256(readFileSync(archive)) !== expected) {
			say(`downloading ${base}/${file}`)
			const data = await get(`${base}/${file}`)
			if (sha256(data) !== expected) fail(`${file} doesn't match its published checksum`)
			mkdirSync(cache, { recursive: true })
			writeFileSync(archive, data)
		}
		// tar reads .tar.xz and .tar.gz everywhere, and .zip on Windows (bsdtar).
		const scratch = mkdtempSync(join(cache, 'extract-'))
		try {
			const member = `${name}/${os === 'win' ? 'node.exe' : 'bin/node'}`
			execFileSync('tar', ['-xf', archive, '-C', scratch, member], { stdio: 'inherit' })
			copyFileSync(join(scratch, member), binary)
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	}
	chmodSync(binary, 0o755)
	writeFileSync(stamp, nodeVersion)
	say(`Node.js ${nodeVersion} for ${target} in place`)
}
