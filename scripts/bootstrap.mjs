// Guided setup for the desktop app: `pnpm bootstrap`. Checks what building it needs (Node.js, pnpm, Rust and the
// system's build tools and webview libraries), gets browsy-app next to this folder and sets it up with its own
// `pnpm bootstrap` (which takes care of browsy-core and the automation extension), then installs this app's tools and
// assembles it. Run it again any time: everything it does is skipped when it's already done. Plain JavaScript, so an
// old Node.js is told how to update instead of failing to start.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parent = dirname(desktop)
const windows = process.platform === 'win32'
const mac = process.platform === 'darwin'
const APP_REPO = 'https://github.com/SheikhAminul/browsy-app.git'

const HELP = `Sets up the Browsy desktop app for development: the tools it needs, browsy-app (with browsy-core and the
automation extension) next to this folder, and this app.

  pnpm bootstrap [--app <folder>] [--yes]

  --app <folder>   Where browsy-app is (default: next to this folder, or downloaded there; BROWSY_APP_DIR)
  --yes, -y        Don't ask: download what's missing
  --help`

const options = { app: process.env.BROWSY_APP_DIR || undefined, yes: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
	const [flag, inline] = argv[i].split(/=(.*)/s)
	if (flag === '--help' || flag === '-h') {
		console.log(HELP)
		process.exit(0)
	} else if (flag === '--yes' || flag === '-y') options.yes = true
	else if (flag === '--app' && (inline ?? argv[i + 1])) options.app = inline ?? argv[++i]
	else {
		console.error(`Unknown option: ${argv[i]}\n\n${HELP}`)
		process.exit(2)
	}
}

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)
const [bold, dim, red, green, yellow, cyan] = ['1', '2', '31', '32', '33', '36'].map(paint)
const step = (n, title) => console.log(`\n${cyan(bold(`[${n}/3]`))} ${bold(title)}`)
const ok = (text) => console.log(`  ${green('✔')} ${text}`)
const info = (text) => console.log(`  ${dim('•')} ${text}`)
const warn = (text) => console.log(`  ${yellow('!')} ${text}`)

class SetupError extends Error {
	constructor(message, hint) {
		super(message)
		this.hint = hint
	}
}
const fail = (message, hint) => {
	throw new SetupError(message, hint)
}

const interactive = !options.yes && !!process.stdin.isTTY
let prompt = null
const closePrompt = () => {
	prompt?.close()
	prompt = null
}
const ask = (question, fallback = '') => {
	if (!interactive) return Promise.resolve(fallback)
	if (!prompt) {
		prompt = createInterface({ input: process.stdin, output: process.stdout })
		prompt.on('SIGINT', () => process.exit(130))
	}
	return new Promise((answer) => prompt.question(`  ${yellow('?')} ${question} `, (text) => answer(text.trim() || fallback)))
}
const confirm = async (question, yes = true) => /^y(es)?$/i.test(await ask(`${question} ${dim(yes ? '[Y/n]' : '[y/N]')}`, yes ? 'y' : 'n'))

const isFile = (path) => {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}
const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
}
const which = (name) => {
	const extensions = windows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : ['']
	for (const dir of (process.env.PATH || '').split(delimiter))
		for (const extension of extensions) if (dir && existsSync(join(dir, name + extension))) return join(dir, name + extension)
	return null
}
/** How to run a program: Windows runs .cmd files through its shell. */
const tool = (path, prefix = []) => ({ command: path, prefix, shell: windows && /\.(cmd|bat)$/i.test(path) })
const quote = (arg) => (/^[\w\-.:/\\=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`)

const run = (t, args, cwd, env = process.env) =>
	new Promise((done, reject) => {
		closePrompt()
		const all = [...t.prefix, ...args]
		info(
			`${dim('$')} ${basename(t.prefix[0] ?? t.command).replace(/\.(exe|cmd|bat|[cm]?js)$/i, '')} ${args.join(' ')} ${dim(`(in ${cwd})`)}`,
		)
		const child = spawn(t.shell ? quote(t.command) : t.command, t.shell ? all.map(quote) : all, {
			cwd,
			env,
			stdio: 'inherit',
			shell: t.shell,
		})
		const ignore = () => {}
		process.on('SIGINT', ignore)
		child.on('error', (e) => reject(new SetupError(`Couldn't run ${t.command}: ${e.message}`)))
		child.on('exit', (code) => {
			process.off('SIGINT', ignore)
			if (code === 0) done()
			else reject(new SetupError(`${basename(t.command)} ${args.join(' ')} failed (exit code ${code}).`, 'Its output is above.'))
		})
	})
const succeeds = (command, args) => spawnSync(command, args, { stdio: 'ignore', shell: false }).status === 0

/** Offer to install something with the computer's package manager. */
const offer = async (name, { winget, brew, manual }) => {
	const manager =
		windows && winget && which('winget')
			? {
					t: tool(which('winget')),
					args: ['install', '--id', winget, '--exact', '--accept-source-agreements', '--accept-package-agreements'],
				}
			: mac && brew && which('brew')
				? { t: tool(which('brew')), args: ['install', brew] }
				: null
	if (manager && (await confirm(`Install ${name} now?`))) {
		await run(manager.t, manager.args, desktop)
		return true
	}
	info(`To install ${name}: ${manual}`)
	return false
}

// ── Prerequisites ────────────────────────────────────────────────────────────────────────────────────────────────

const checkNode = async () => {
	const required = Number(/\d+/.exec(readJson(join(desktop, 'package.json'))?.engines?.node ?? '26')?.[0] ?? 26)
	if (Number(process.versions.node.split('.')[0]) >= required) return ok(`Node.js ${process.versions.node}`)
	warn(`Node.js ${process.versions.node} is too old: building Browsy needs Node.js ${required} or later.`)
	await offer(`Node.js ${required}`, { winget: 'OpenJS.NodeJS.LTS', brew: 'node', manual: 'https://nodejs.org' })
	fail(`Node.js ${required} or later is needed.`, 'Open a new terminal and run pnpm bootstrap again.')
}

const findPnpm = () => {
	const self = process.env.npm_execpath
	if (self && /pnpm/i.test(basename(self)) && isFile(self)) return /\.[cm]?js$/i.test(self) ? tool(process.execPath, [self]) : tool(self)
	const found = which('pnpm')
	return found ? tool(found) : fail('pnpm is needed.', 'Install it (https://pnpm.io/installation), then run: pnpm bootstrap')
}

const checkRust = async () => {
	const cargo = which('cargo') ?? [join(homedir(), '.cargo', 'bin', windows ? 'cargo.exe' : 'cargo')].find(isFile)
	if (cargo) {
		const version = spawnSync(cargo, ['--version'], { encoding: 'utf8' }).stdout?.trim()
		return ok(version || 'Rust')
	}
	warn("Rust isn't installed: the desktop app's native part is written in it.")
	await offer('Rust', {
		winget: 'Rustlang.Rustup',
		manual: "https://rustup.rs (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)",
	})
	fail('Rust is needed.', 'Open a new terminal (so it finds Rust) and run pnpm bootstrap again.')
}

/** What Tauri builds against: the webview and build tools of each system. */
const checkSystem = async () => {
	if (windows) {
		const vswhere = join(
			process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
			'Microsoft Visual Studio',
			'Installer',
			'vswhere.exe',
		)
		const found =
			isFile(vswhere) &&
			spawnSync(
				vswhere,
				['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
				{
					encoding: 'utf8',
				},
			).stdout?.trim()
		if (found) return ok('Visual Studio C++ build tools (WebView2 comes with Windows)')
		warn("The Visual Studio C++ build tools aren't installed: Rust needs them on Windows.")
		info('Install "Desktop development with C++" from https://visualstudio.microsoft.com/visual-cpp-build-tools/')
		fail('The C++ build tools are needed.', 'Install them, then run pnpm bootstrap again.')
	}
	if (mac) {
		if (succeeds('xcode-select', ['-p'])) return ok('Xcode command line tools')
		warn("The Xcode command line tools aren't installed.")
		if (await confirm('Install them now (xcode-select --install)?')) spawnSync('xcode-select', ['--install'], { stdio: 'inherit' })
		fail('The Xcode command line tools are needed.', 'When their installer finishes, run pnpm bootstrap again.')
	}
	if (succeeds('pkg-config', ['--exists', 'webkit2gtk-4.1', 'gtk+-3.0', 'librsvg-2.0'])) return ok('WebKitGTK and GTK libraries')
	const apt =
		'libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev build-essential file pkg-config'
	warn("The libraries Tauri builds against on Linux aren't installed.")
	if (which('apt-get') && (await confirm('Install them now with apt (asks for your password)?'))) {
		await run(tool(which('sudo') ?? 'sudo'), ['apt-get', 'install', '-y', ...apt.split(' ')], desktop)
		return ok('WebKitGTK and GTK libraries')
	}
	info(`Debian/Ubuntu: sudo apt install ${apt}`)
	info('Others: https://v2.tauri.app/start/prerequisites/#linux')
	fail('The WebKitGTK libraries are needed.', 'Install them, then run pnpm bootstrap again.')
}

// ── browsy-app ───────────────────────────────────────────────────────────────────────────────────────────────────

const isApp = (dir) => readJson(join(dir, 'package.json'))?.name === 'browsy'

const findApp = async () => {
	if (options.app) {
		const dir = resolve(options.app)
		return isApp(dir) ? dir : fail(`${dir} isn't browsy-app.`, 'Its package.json should be named "browsy".')
	}
	const found = [join(parent, 'browsy-app'), join(parent, 'browsy-app-main')].find(isApp)
	if (found) return found
	const target = join(parent, 'browsy-app')
	warn("browsy-app isn't next to this folder: the desktop app is built from it.")
	for (;;) {
		const answer = await ask(`Type the folder where it is, or press Enter to download it into ${target}:`)
		if (answer) {
			const dir = resolve(answer.replace(/^(['"])(.*)\1$/, '$2').replace(/^~(?=$|[/\\])/, homedir()))
			if (isApp(dir)) return dir
			warn(`${dir} isn't browsy-app.`)
			continue
		}
		if (existsSync(target)) fail(`${target} is in the way.`, 'Move it, or pass --app <folder>.')
		const git = which('git')
		if (!git) fail('Downloading browsy-app needs Git.', 'Install Git (https://git-scm.com/downloads), or pass --app <folder>.')
		await run(tool(git), ['clone', APP_REPO, target], parent)
		if (isApp(target)) return target
		if (!interactive) fail("browsy-app couldn't be downloaded.", 'Clone it next to this folder, or pass --app <folder>.')
	}
}

// ── Setup ────────────────────────────────────────────────────────────────────────────────────────────────────────

const main = async () => {
	console.log(`${bold('Browsy desktop setup')} ${dim('· tools, browsy-app, and the desktop app')}`)

	step(1, 'Tools')
	await checkNode()
	const pnpm = findPnpm()
	ok('pnpm')
	await checkRust()
	await checkSystem()

	step(2, 'browsy-app (with browsy-core and the automation extension)')
	const app = await findApp()
	ok(`Found at ${app}`)
	await run(pnpm, ['bootstrap', '--no-start', ...(options.yes ? ['--yes'] : [])], app)

	step(3, 'The desktop app')
	await run(pnpm, ['install'], desktop)
	await run(pnpm, ['assemble'], desktop, { ...process.env, BROWSY_APP_DIR: app, BROWSY_ASSEMBLE_SKIP_BOOTSTRAP: '1' })

	console.log(`\n${green(bold('Ready.'))}`)
	console.log(`  ${bold('pnpm dev')}        run the desktop app (the first build of its Rust part takes a few minutes)`)
	console.log(`  ${bold('pnpm build')}      make installers (src-tauri/target/release/bundle)`)
	console.log(`  ${bold('pnpm bootstrap')}  again after pulling changes here or in browsy-app`)
	if (app !== join(parent, 'browsy-app'))
		console.log(dim(`  browsy-app isn't next to this folder: set BROWSY_APP_DIR=${app} for pnpm dev and pnpm build.`))
}

main()
	.catch((e) => {
		console.error(`\n${red('✖')} ${e instanceof SetupError ? e.message : `Setup stopped: ${e?.stack ?? e}`}`)
		if (e?.hint) console.error(`  ${e.hint}`)
		process.exitCode = 1
	})
	.finally(closePrompt)
