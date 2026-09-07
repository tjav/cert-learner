import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInThisContext } from 'node:vm';
import { describe, it } from 'mocha';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type * as vscode from 'vscode';
import { assertGitPath, buildCheckoutArgs, buildCloneArgs, buildCredentialQueryArgs, buildCredentialQueryEnvironment, buildGitEnvironment, parseCredentialConfig, parseGitHubRepository } from '../core/githubCourse';
import type { CredentialSetting } from '../core/githubCourse';

const ROOT = path.resolve('github-course-test-root');
const PARENT = path.join(ROOT, 'parent folder');
const DESTINATION = path.join(PARENT, 'course');
const TEMPLATE = path.join(ROOT, 'template');
const GLOBAL = path.join(ROOT, 'empty.gitconfig');
const URL = 'https://github.com/owner/course';
const TRACE_OFF = { GIT_TRACE: '0', GIT_TRACE_PACKET: '0', GIT_TRACE_CURL: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0',
	GIT_TRACE2_CONFIG_PARAMS: '', GIT_TRACE2_ENV_VARS: '' };
// Obvious dummy values only: no host credential configuration is ever read in these tests.
const AUTH_SETTINGS: readonly CredentialSetting[] = [
	{ key: 'credential.helper', value: 'dummy-first' },
	{ key: 'credential.usehttppath', value: 'false' },
	{ key: 'credential.username', value: 'DUMMY_DEFAULT_USER' },
	{ key: 'credential.helper', value: '' },
	{ key: 'credential.helper', value: 'dummy-helper --fixture=雪' },
	{ key: 'credential.https://github.com.helper', value: '' },
	{ key: 'credential.https://github.com.helper', value: '!"DUMMY-gh" auth git-credential' },
	{ key: 'credential.https://github.com.usehttppath', value: 'true' },
	{ key: 'credential.https://github.com.username', value: 'DUMMY_GITHUB_USER' },
	{ key: 'credential.https://github.com/Owner/Repo.git.helper', value: '!f() {\n echo DUMMY_AUTH_FIXTURE;\n}; f' },
	{ key: 'credential.https://github.com/Owner/Repo.git.username', value: 'DUMMY_PATH_USER' },
	{ key: 'credential.helper', value: 'dummy-last' },
	{ key: 'credential.https://EXAMPLE.invalid/Team/Repo.helper', value: 'dummy-other-host' },
	{ key: 'credential.https://EXAMPLE.invalid/Team/Repo.usehttppath', value: 'false' },
	{ key: 'credential.https://EXAMPLE.invalid/Team/Repo.username', value: '' }
];
const CONFIG_QUERY = ['config', '--null', '--get-regexp', '^credential(\\..*)?\\.(helper|usehttppath|username)$'];
const FORBIDDEN_CONFIG_KEYS = ['credential.password', 'credential.https://github.com.password', 'credential.token',
	'credential.https://github.com.oauthToken', 'credential.interactive', 'credential.https://github.com.helperSuffix',
	'credentials.helper', 'other.credential.helper', 'http.https://github.com.extraheader', 'http.sslverify',
	'url.ssh://dummy.invalid/.insteadof', 'core.hooksPath', 'hook.dummy.command', 'filter.dummy.smudge', 'include.path'];
const configOutput = (settings: readonly CredentialSetting[]): string => settings.map(({ key, value }) => `${key}\n${value}\0`).join('');
const manifest = { format: 'cert-learner', schemaVersion: 1, contentVersion: '1', courseId: 'fixture', title: 'Fixture',
	units: [{ unitId: 'intro', displayNumber: '1', title: 'Intro', resources: { lesson: 'lesson.md' },
		activities: [{ activityId: 'read', title: 'Read', objectives: [] }] }] };

describe('GitHub course pure helpers', () => {
	it('accepts only repository URLs and canonicalizes the host and optional Git suffix', () => {
		for (const suffix of ['', '/', '.git', '.git/']) {
			assert.deepEqual(parseGitHubRepository(`${URL}${suffix}`), { owner: 'owner', repo: 'course', url: `${URL}.git` });
		}
		assert.deepEqual(parseGitHubRepository('HTTPS://GITHUB.COM/Owner-1/my_course.v2.GIT/'),
			{ owner: 'Owner-1', repo: 'my_course.v2', url: 'https://github.com/Owner-1/my_course.v2.git' });
		assert.equal(parseGitHubRepository('https://github.com/a/_course').repo, '_course');
	});
	it('rejects parser repairs, credentials, ports, encoding, traversal, options and extra paths', () => {
		for (const value of [
			'', 'git@github.com:owner/course', '//github.com/owner/course', 'http://github.com/owner/course',
			'https://example.com/owner/course', 'https://github.com.evil.test/owner/course',
			'https://user@github.com/owner/course', 'https://user:password@github.com/owner/course',
			'https://github.com:443/owner/course', 'https://github.com:/owner/course', 'https://github.com./owner/course',
			`${URL}?`, `${URL}?token=placeholder`, `${URL}#`, `${URL}#main`, `${URL}//`,
			`${URL}/tree/main`, `${URL}/blob/main/course.json`, `${URL}/course.json`, `${URL}/.git`,
			`${URL}/..`, `${URL}/../other`, 'https://github.com/owner/./course',
			'https://github.com/owner/../course', 'https://github.com/owner/%2e%2e',
			'https://github.com/owner/cour%73e', 'https://github.com/owner/course%2fother',
			'https://github.com/owner/-option', 'https://github.com/-owner/course', 'https://github.com/owner-/course',
			'https://github.com/owner/.git', 'https://github.com/owner/.hidden', 'https://github.com/owner/course..v2',
			'https://github.com/owner/course.', 'https://github.com/owner/con', 'https://github.com/owner/LPT1.git',
			'https://github.com/owner/course;echo', 'https://github.com/owner/course$HOME',
			'httpſ://github.com/owner/course', 'https://github.com/owner/courſe', 'https://github.com/owner/Kourse',
			`${URL} `, ` ${URL}`, `${URL}\n`, `${URL}\r\n`, `${URL}\u0000`, `${URL}\u2028`,
			'https://github.com\\owner\\course', 'https://github.com//owner/course',
			`https://github.com/${'a'.repeat(40)}/course`, `https://github.com/owner/${'a'.repeat(101)}`
		]) { assert.throws(() => parseGitHubRepository(value), /repository URL/u, JSON.stringify(value)); }
		assert.throws(() => parseGitHubRepository(null as unknown as string));
	});
	it('builds literal argument arrays with all clone/checkout safeguards', () => {
		const args = buildCloneArgs(`${URL}/`, DESTINATION, TEMPLATE);
		assert.deepEqual(args.slice(-3), ['--', `${URL}.git`, DESTINATION]);
		for (const option of ['--depth=1', '--single-branch', '--no-tags', '--no-checkout', '--no-recurse-submodules', `--template=${TEMPLATE}`]) {
			assert.ok(args.includes(option), option);
		}
		const checkout = buildCheckoutArgs(DESTINATION, TEMPLATE);
		assert.deepEqual(checkout.slice(0, 2), ['-C', DESTINATION]);
		assert.deepEqual(checkout.slice(-3), ['reset', '--hard', 'HEAD']);
		for (const command of [args, checkout]) {
			for (const setting of [`core.hooksPath=${TEMPLATE}`, 'core.fsmonitor=false', 'submodule.recurse=false',
				'fetch.recurseSubmodules=false', 'gc.auto=0', 'maintenance.auto=false', 'protocol.allow=never',
				'protocol.https.allow=always', 'protocol.file.allow=never', 'protocol.ext.allow=never',
				'hook.reference-transaction.enabled=false', 'trace2.normalTarget=0', 'trace2.eventTarget=0', 'trace2.perfTarget=0']) {
				assert.equal(command[command.indexOf(setting) - 1], '-c', setting);
			}
		}
		assert.ok(args.includes('http.followRedirects=false'));
		assert.ok(args.includes('http.sslVerify=true'));
		assert.ok(checkout.includes('core.symlinks=false'));
		assert.throws(() => buildCloneArgs('--upload-pack=bad', DESTINATION, TEMPLATE));
	});
	it('rejects path expansion and option-like relative inputs but preserves spaces as one argument', () => {
		for (const value of ['--config=bad', 'relative', `${ROOT}\n`, `${ROOT}\u0000`, path.join(ROOT, '$HOME'),
			path.join(ROOT, '${env:TOKEN}'), path.join(ROOT, '%USERPROFILE%'), path.join(ROOT, '`command`'),
			`${ROOT}${path.sep}..${path.sep}elsewhere`, `${ROOT}${path.sep}.${path.sep}child`, '//server/share']) {
			assert.throws(() => assertGitPath(value), /local absolute path/u, value);
			assert.throws(() => buildCheckoutArgs(value, TEMPLATE));
			assert.throws(() => buildCloneArgs(URL, DESTINATION, value));
			assert.throws(() => buildGitEnvironment({}, value));
		}
		if (process.platform === 'win32') {
			for (const value of ['\\relative-to-drive', '/relative-to-drive', `${ROOT}:stream`]) { assert.throws(() => assertGitPath(value)); }
		}
		assert.doesNotThrow(() => assertGitPath(PARENT));
	});
	it('drops all inherited injection case-insensitively and forces trace off for every phase', () => {
		const source: NodeJS.ProcessEnv = { PATH: '/trusted/bin', HOME: '/trusted/home', USERPROFILE: 'C:\\Users\\learner',
			XDG_CONFIG_HOME: '/trusted/config', SystemRoot: 'C:\\Windows' };
		const safe = { ...source };
		for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_EXEC_PATH', 'GIT_CONFIG',
			'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
			'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TEMPLATE_DIR', 'GIT_PROXY_COMMAND', 'GIT_SSH_COMMAND',
			'GIT_ASKPASS', 'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_TRACE_CURL', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF',
			'GIT_TRACE2_CONFIG_PARAMS', 'GIT_TRACE2_ENV_VARS', 'GIT_TRACE_SETUP', 'GIT_CEILING_DIRECTORIES',
			'GIT_OBJECT_DIRECTORY', 'GIT_ALLOW_PROTOCOL',
			'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_LFS_SKIP_SMUDGE', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE',
			'GCM_TRACE', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_EXTRA_ARGS', 'SSH_ASKPASS', 'NODE_OPTIONS',
			'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'CDPATH']) {
			source[key] = 'injected'; source[key.toLowerCase()] = 'injected';
		}
		const before = JSON.stringify(source);
		const expected = { ...safe, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_LFS_SKIP_SMUDGE: '1', GIT_ATTR_NOSYSTEM: '1', ...TRACE_OFF };
		assert.deepEqual(buildCredentialQueryEnvironment(source, TEMPLATE), { ...expected, GIT_CEILING_DIRECTORIES: ROOT });
		const isolated = { ...expected, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL };
		assert.deepEqual(buildGitEnvironment(source, GLOBAL), isolated);
		const fetch = buildGitEnvironment(source, GLOBAL, AUTH_SETTINGS);
		const whitelist: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(AUTH_SETTINGS.length) };
		AUTH_SETTINGS.forEach(({ key, value }, index) => { whitelist[`GIT_CONFIG_KEY_${index}`] = key; whitelist[`GIT_CONFIG_VALUE_${index}`] = value; });
		assert.deepEqual(fetch, { ...isolated, ...whitelist });
		assert.equal(JSON.stringify(source), before);
	});
	it('queries only helper/useHttpPath/username with original generic and URL-scoped keys', () => {
		const args = buildCredentialQueryArgs(TEMPLATE);
		assert.deepEqual(args.slice(-4), CONFIG_QUERY);
		assert.equal(args.includes('--global'), false, 'Read system and global, not just global');
		assert.equal(args.includes('fill'), false);
		for (const setting of ['trace2.normalTarget=0', 'trace2.eventTarget=0', 'trace2.perfTarget=0']) { assert.ok(args.includes(setting)); }
		assert.throws(() => buildCredentialQueryArgs('relative'));
		assert.throws(() => buildCredentialQueryEnvironment({}, 'relative'));
	});
	it('parses name-LF-value-NUL records without trimming, sorting, flattening keys or splitting multiline values', () => {
		const settings = [...AUTH_SETTINGS, { key: 'credential.username', value: '  DUMMY_USER  ' },
			{ key: 'credential.helper', value: '\n!echo DUMMY_HELPER\n' }];
		assert.deepEqual(parseCredentialConfig(configOutput(settings)), settings);
		assert.deepEqual(parseCredentialConfig('credential.helper\n\0'), [{ key: 'credential.helper', value: '' }]);
	});
	it('rejects malformed/unselected records atomically and prevents arbitrary environment replay', () => {
		const valid = configOutput(AUTH_SETTINGS);
		for (const record of ['', '\0', '\nvalue\0', 'credential.helper\0', 'credential.helper\nmissing terminator',
			...FORBIDDEN_CONFIG_KEYS.map(key => `${key}\nDUMMY_SECRET\0`),
			'CREDENTIAL.helper\nvalue\0', 'credential.useHttpPath\ntrue\0', 'credential.helper\r\nvalue\0']) {
			assert.deepEqual(parseCredentialConfig(record), []);
			if (record) { assert.deepEqual(parseCredentialConfig(valid + record), [], 'Never accept a partial selection'); }
		}
		for (const key of [...FORBIDDEN_CONFIG_KEYS, 'credential.helper\n', 'credential.https://github.com\0.helper',
			'credential.https://github.com\n.helper', 'CREDENTIAL.helper', 'credential.useHttpPath']) {
			assert.throws(() => buildGitEnvironment({}, GLOBAL, [...AUTH_SETTINGS, { key, value: 'DUMMY_SECRET' }]),
				/^Error: Invalid selected Git authentication settings\.$/u);
		}
		assert.throws(() => buildGitEnvironment({}, GLOBAL, [{ key: 'credential.helper', value: 'dummy\0helper' }]));
	});
	it('bounds parsing and replay by UTF-8 bytes including names, newlines and NUL terminators', () => {
		const key = 'credential.helper';
		const available = 64 * 1024 - Buffer.byteLength(key) - 2;
		const value = '雪'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
		const settings = [{ key, value }];
		assert.equal(Buffer.byteLength(configOutput(settings)), 64 * 1024);
		assert.deepEqual(parseCredentialConfig(configOutput(settings)), settings);
		assert.equal(buildGitEnvironment({}, GLOBAL, settings).GIT_CONFIG_VALUE_0, value);
		const oversized = [...settings, { key: 'credential.username', value: '' }];
		assert.deepEqual(parseCredentialConfig(configOutput(oversized)), []);
		assert.throws(() => buildGitEnvironment({}, GLOBAL, oversized), /size limit/u);
		assert.deepEqual(parseCredentialConfig(configOutput([{ key, value: value + 'x' }])), []);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const drain = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** Entire filesystem boundary is in memory: tests make no files, Git calls, or remote requests.
 * The production loadCourse/validation/resource code still executes without a bypass.
 */
class Files {
	readonly entries = new Map<string, { directory: boolean; bytes: Buffer; ino: number; symlink?: boolean }>();
	readonly reads: string[] = [];
	readonly removed: string[] = [];
	readonly writes: string[] = [];
	private next = 1;
	put(file: string, content?: string): void {
		this.entries.set(file, { directory: content === undefined, bytes: Buffer.from(content ?? ''), ino: this.next++ });
	}
	info(file: string) {
		this.reads.push(file);
		const entry = this.entries.get(file);
		if (!entry) { throw Object.assign(new Error('PRIVATE_FILESYSTEM_ERROR'), { code: 'ENOENT' }); }
		return { dev: 1, ino: entry.ino, size: entry.bytes.length, isDirectory: () => entry.directory,
			isFile: () => !entry.directory, isSymbolicLink: () => !!entry.symlink };
	}
	readonly api = {
		realpath: async (file: string) => { this.info(file); return file; },
		stat: async (file: string) => this.info(file), lstat: async (file: string) => this.info(file),
		mkdir: async (file: string, options?: { recursive?: boolean; mode?: number }) => {
			assert.notEqual(options?.recursive, true, 'No recursive mkdir may bypass exclusive creation');
			if (this.entries.has(file)) { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }
			assert.ok(this.info(path.dirname(file)).isDirectory()); this.put(file);
		},
		mkdtemp: async (prefix: string) => { const file = `${prefix}${this.next}`; this.put(file); return file; },
		writeFile: async (file: string, content: string, options: { flag: string; mode: number }) => {
			assert.equal(options.flag, 'wx'); assert.equal(options.mode, 0o600);
			this.writes.push(content);
			assert.equal(this.entries.has(file), false); this.put(file, content);
		},
		open: async (file: string) => ({ stat: async () => this.info(file), close: async () => {},
			read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
				const source = this.entries.get(file)!.bytes;
				assert.equal(position, null);
				return { bytesRead: source.copy(buffer, offset, offset, Math.min(source.length, offset + length)) };
			} }),
		rm: async (file: string) => {
			this.removed.push(file);
			assert.notEqual(file, DESTINATION, 'Clone contents must NEVER be removed');
			for (const key of this.entries.keys()) { if (key === file || key.startsWith(`${file}${path.sep}`)) { this.entries.delete(key); } }
		}
	};
}

class Child extends EventEmitter {
	readonly stdout = new EventEmitter();
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	constructor(readonly pid: number) { super(); }
	kill(): boolean { this.killed = true; return true; }
	finish(code = 0): void { this.exitCode = code; this.emit('exit', code, null); this.emit('close', code, null); }
}
interface Launch { executable: string; args: string[]; options: { shell: boolean; stdio: string | string[]; cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean }; child: Child }

class Host {
	readonly fs = new Files();
	readonly launches: Launch[] = [];
	readonly started = deferred<Launch>();
	readonly queryStarted = deferred<Launch>();
	readonly killStarted = deferred<Launch>();
	readonly kills: [number, string][] = [];
	readonly warnings: string[] = [];
	readonly dialogs: string[] = [];
	readonly logs: unknown[][] = [];
	readonly reports: unknown[] = [];
	readonly listeners = new Set<() => void>();
	readonly timers = new Map<object, { callback: () => void; ms: number }>();
	readonly context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
	readonly workspace = { isTrusted: true };
	readonly env: NodeJS.ProcessEnv = { PATH: '/trusted/bin', HOME: '/trusted/home', SystemRoot: 'C:\\Windows',
		GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.hostile.smudge', GIT_CONFIG_VALUE_0: 'DO_NOT_RUN' };
	input: string | undefined = URL;
	folders: { scheme: string; authority: string; fsPath: string }[] | undefined = [{ scheme: 'file', authority: '', fsPath: PARENT }];
	answer: string | undefined = 'Clone course';
	cancelled = false;
	platform: string = process.platform;
	progressCalls = 0;
	extensionCalls = 0;
	confirmation = '';
	inputOptions: vscode.InputBoxOptions | undefined;
	onConfirm = (): void => {};
	extension: { isActive: boolean; exports?: unknown; activate?: () => Promise<unknown> } | undefined;
	checkoutFiles: Record<string, string> = { 'course.json': JSON.stringify(manifest), 'lesson.md': '# Lesson',
		'check.cjs': 'throw new Error("MUST_NOT_EXECUTE");', '.gitattributes': '* filter=hostile' };
	queryBehavior = (launch: Launch): void => {
		launch.child.stdout.emit('data', Buffer.from('credential.helper\nmanager\0'));
		launch.child.finish();
	};
	behavior = (launch: Launch): void => {
		if (launch.args.includes('clone')) { this.fs.put(path.join(DESTINATION, '.git')); }
		if (launch.args.includes('reset')) {
			for (const [name, content] of Object.entries(this.checkoutFiles)) { this.fs.put(path.join(DESTINATION, name), content); }
		}
		launch.child.finish();
	};
	constructor() { for (const directory of [ROOT, PARENT, path.join(ROOT, 'tmp')]) { this.fs.put(directory); } }
	cancel(): void { this.cancelled = true; for (const listener of this.listeners) { listener(); } }
	readonly api = {
		workspace: this.workspace, ProgressLocation: { Notification: 15 },
		extensions: { getExtension: (id: string) => { assert.equal(id, 'vscode.git'); this.extensionCalls++; return this.extension; } },
		window: {
			showInputBox: async (options: vscode.InputBoxOptions) => { this.dialogs.push('input'); this.inputOptions = options; return this.input; },
			showOpenDialog: async (options: vscode.OpenDialogOptions) => {
				this.dialogs.push('picker');
				assert.equal(options.canSelectFiles, false); assert.equal(options.canSelectFolders, true); assert.equal(options.canSelectMany, false);
				return this.folders;
			},
			showInformationMessage: async (_message: string, options: { modal: boolean; detail: string }, ...buttons: string[]) => {
				this.dialogs.push('confirmation');
				assert.equal(options.modal, true); assert.deepEqual(buttons, ['Clone course']);
				this.confirmation = options.detail; this.onConfirm(); return this.answer;
			},
			showWarningMessage: async (message: string) => { this.warnings.push(message); },
			withProgress: async (options: vscode.ProgressOptions, task: (progress: object, token: object) => Promise<unknown>) => {
				this.progressCalls++; assert.equal(options.cancellable, true);
				const host = this;
				return task({ report: (value: unknown) => { this.reports.push(value); } }, { get isCancellationRequested() { return host.cancelled; },
					onCancellationRequested: (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; } });
			}
		}
	};
	readonly spawn = (executable: string, args: string[], options: Launch['options']): Child => {
		const launch = { executable, args, options, child: new Child(50000 + this.launches.length) };
		this.launches.push(launch);
		assert.equal(options.shell, false);
		assert.deepEqual(options.stdio, args.includes('config') ? ['ignore', 'pipe', 'ignore'] : 'ignore');
		if (executable.endsWith('taskkill.exe')) { this.killStarted.resolve(launch); }
		else {
			const template = args.find(arg => arg.startsWith('core.hooksPath='))!.slice('core.hooksPath='.length);
			assert.ok(this.fs.info(template).isDirectory(), 'Hooks/template directory already exists');
			assert.equal([...this.fs.entries.keys()].some(file => file.startsWith(`${template}${path.sep}`)), false, 'Template is empty');
			if (args.includes('config')) {
				assert.deepEqual(args.slice(-4), CONFIG_QUERY);
				assert.equal(options.cwd, template);
				assert.equal(options.env?.GIT_CEILING_DIRECTORIES, path.dirname(template), 'No enclosing repository discovery');
				this.queryStarted.resolve(launch); queueMicrotask(() => this.queryBehavior(launch));
			} else {
				assert.equal(options.env?.GIT_CONFIG_NOSYSTEM, '1');
				assert.equal(this.fs.entries.get(options.env!.GIT_CONFIG_GLOBAL!)!.bytes.length, 0, 'Every fetch/checkout uses an existing empty global config');
				this.started.resolve(launch); queueMicrotask(() => this.behavior(launch));
			}
			for (const [key, value] of Object.entries(TRACE_OFF)) { assert.equal(options.env?.[key], value); }
		}
		return launch.child;
	};
	async run(signal?: AbortSignal): Promise<string | undefined> {
		const operation = this.load().cloneGitHubCourse(this.context, signal);
		try { return await operation; } finally {
			assert.equal(this.listeners.size, 0); assert.equal(this.timers.size, 0); assert.equal(this.context.subscriptions.length, 0);
			if (signal) { assert.equal(getEventListeners(signal, 'abort').length, 0, 'No retained owner cancellation listener'); }
		}
	}
	private load(): typeof import('../githubCourse') {
		const extension = path.extname(__filename);
		const entry = path.join(__dirname, '..', `githubCourse${extension}`);
		const cache = new Map<string, object>();
		const load = (filename: string): object => {
			const cached = cache.get(filename); if (cached) { return cached; }
			const requireFromFile = createRequire(filename);
			const source = readFileSync(filename, 'utf8');
			const code = extension === '.ts' ? transpileModule(source, { compilerOptions: {
				module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true
			}, fileName: filename }).outputText : source;
			const module = { exports: {} }; cache.set(filename, module.exports);
			const execute = runInThisContext(`(function(exports, require, module, __filename, __dirname, process, setTimeout, clearTimeout, console) {\n${code}\n})`, { filename }) as (...args: unknown[]) => void;
			execute(module.exports, (id: string) => {
				if (id === 'vscode') { return this.api; }
				if (id === 'node:child_process') { return { spawn: this.spawn }; }
				if (id === 'node:fs/promises') { return this.fs.api; }
				if (id === 'node:os') { return { tmpdir: () => path.join(ROOT, 'tmp') }; }
				if (id.startsWith('.') && !path.extname(id)) { return load(path.resolve(path.dirname(filename), `${id}${extension}`)); }
				return requireFromFile(id);
			}, module, filename, path.dirname(filename), filename === entry ? { platform: this.platform,
				env: this.env,
				kill: (pid: number, signal: string) => { this.kills.push([pid, signal]); }
			} : process,
			(callback: () => void, ms: number) => { const key = {}; this.timers.set(key, { callback, ms }); return key; },
			(key: object) => { this.timers.delete(key); }, Object.fromEntries(['log', 'warn', 'error', 'debug', 'info'].map(key => [key, (...args: unknown[]) => { this.logs.push(args); }])));
			return module.exports;
		};
		return load(entry) as typeof import('../githubCourse');
	}
}

describe('GitHub auth config with real local Git (isolated fixtures, no helpers or network)', () => {
	it('round-trips ordered scoped settings through Git and leaves URL matching to Git', async function () {
		this.timeout(20000);
		const root = await mkdtemp(path.join(tmpdir(), 'cert-learner-git-config-test-'));
		try {
			const home = path.join(root, 'home');
			const xdg = path.join(root, 'xdg');
			const empty = path.join(root, 'empty');
			const global = path.join(root, 'empty.gitconfig');
			await mkdir(home); await mkdir(path.join(xdg, 'git'), { recursive: true }); await mkdir(empty);
			await writeFile(global, '', { flag: 'wx' });
			// Only OS executable lookup/runtime variables are inherited; never HOME or auth config.
			const source: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
				.filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/iu.test(key)));
			Object.assign(source, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, LC_ALL: 'C' });
			const queryEnv = { ...buildCredentialQueryEnvironment(source, empty),
				// Production deliberately removes these overrides; the TEST boundary must restore them.
				GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: global };
			const isolatedEnv = { ...buildGitEnvironment(source, global), GIT_CEILING_DIRECTORIES: root };
			const git = (args: string[], env: NodeJS.ProcessEnv, expectedStatus = 0): string => {
				assert.ok(args.includes('config') || args.includes('init'), 'Only local config/init, never credential/clone/fetch');
				assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home); assert.equal(env.XDG_CONFIG_HOME, xdg);
				assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
				const result = spawnSync('git', args, { cwd: empty, env, shell: false, windowsHide: true,
					stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 });
				assert.equal(result.error === undefined, true, 'Local Git fixture command must launch (Git is required)');
				assert.equal(result.status, expectedStatus, 'Local Git fixture command status');
				return result.stdout;
			};
			const render = (settings: readonly CredentialSetting[]): string => settings.map(({ key, value }) => {
				const first = key.indexOf('.'); const last = key.lastIndexOf('.');
				// Deliberately mixed case: Git normalizes the section and field, NOT the subsection.
				return `[${key.slice(0, first).toUpperCase()}${first === last ? '' : ` ${JSON.stringify(key.slice(first + 1, last))}`}]\n` +
					`${key.slice(last + 1).toUpperCase()} = ${JSON.stringify(value)}\n`;
			}).join('');
			// An enclosing repo must not contribute credentials to a query from the empty directory.
			git(['init', '--quiet', '--initial-branch=main', `--template=${empty}`, root], isolatedEnv);
			await writeFile(path.join(root, '.git', 'config'), '\n[credential]\nhelper = DUMMY_LOCAL_MUST_NOT_READ\n', { flag: 'a' });
			await writeFile(path.join(xdg, 'git', 'config'), render(AUTH_SETTINGS.slice(0, 3)), { flag: 'wx' });
			await writeFile(path.join(home, 'included.gitconfig'), render(AUTH_SETTINGS.slice(8, 12)), { flag: 'wx' });
			const excluded = FORBIDDEN_CONFIG_KEYS.map(key => ({ key, value: 'DUMMY_SECRET_NOT_SELECTED' }));
			await writeFile(path.join(home, '.gitconfig'), render(AUTH_SETTINGS.slice(3, 8)) +
				'[include]\npath = included.gitconfig\n' + render(AUTH_SETTINGS.slice(12)) + render(excluded) +
				`[credential]\npassword = DUMMY_SECRET_${'x'.repeat(64 * 1024)}\n`, { flag: 'wx' });
			const queryArgs = buildCredentialQueryArgs(empty);
			assert.deepEqual(queryArgs.slice(-4), CONFIG_QUERY);
			const raw = git(queryArgs, queryEnv);
			assert.doesNotMatch(raw, /DUMMY_SECRET|DUMMY_LOCAL/u);
			assert.equal(raw, configOutput(AUTH_SETTINGS), 'Git returns only selected fields in effective config order');
			const selected = parseCredentialConfig(raw);
			assert.deepEqual(selected, AUTH_SETTINGS);
			const cloneEnv = { ...buildGitEnvironment(source, global, selected), GIT_CEILING_DIRECTORIES: root };
			assert.equal(git(queryArgs, cloneEnv), raw, 'Original keys, resets and multiline values survive environment replay');
			// These config-only lookups exercise Git URL matching without invoking ANY helper.
			for (const [url, username, useHttpPath] of [
				['https://github.com/Owner/Repo.git', 'DUMMY_PATH_USER', 'true'],
				['https://github.com/owner/repo.git', 'DUMMY_GITHUB_USER', 'true'],
				['https://unrelated.invalid/Owner/Repo.git', 'DUMMY_DEFAULT_USER', 'false']
			]) {
				for (const [field, expected] of [['username', username], ['useHttpPath', useHttpPath]]) {
					const args = ['config', '--null', '--get-urlmatch', `credential.${field}`, url];
					assert.equal(git(args, cloneEnv), `${expected}\0`);
					assert.equal(git(args, queryEnv), git(args, cloneEnv));
				}
			}
			assert.equal(git(queryArgs, isolatedEnv, 1), '', 'Checkout environment contains no selected auth settings');
			assert.doesNotMatch(git(['config', '--null', '--list'], cloneEnv), /DUMMY_SECRET|DUMMY_LOCAL/u);
			// Feed real Git output through the production capture/parser and mock only network/checkout.
			const host = new Host();
			host.queryBehavior = ({ child }) => { child.stdout.emit('data', Buffer.from(raw)); child.finish(); };
			assert.equal(await host.run(), DESTINATION);
			assert.equal(host.launches[1].options.env?.GIT_CONFIG_COUNT, String(selected.length));
			selected.forEach(({ key, value }, index) => {
				assert.equal(host.launches[1].options.env?.[`GIT_CONFIG_KEY_${index}`], key);
				assert.equal(host.launches[1].options.env?.[`GIT_CONFIG_VALUE_${index}`], value);
			});
			assert.equal(host.launches[2].options.env?.GIT_CONFIG_COUNT, undefined);
			assert.deepEqual(host.logs, []); assert.deepEqual(host.warnings, []);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});

describe('GitHub clone host contract (no real Git, network, credentials, or filesystem writes)', () => {
	it('returns a root only after real loadCourse validation and uses isolated phase configurations', async () => {
		const host = new Host();
		const lifetime = new AbortController();
		assert.equal(await host.run(lifetime.signal), DESTINATION);
		lifetime.abort(); // A completed flow no longer belongs to the owner.
		assert.deepEqual(host.kills, []);
		assert.deepEqual(host.warnings, []);
		assert.equal(host.launches.length, 3);
		const [query, clone, checkout] = host.launches;
		assert.equal(clone.executable, 'git');
		assert.equal(query.options.env?.GIT_CONFIG_NOSYSTEM, undefined, 'Local query reads effective system/global helpers');
		assert.equal(query.options.env?.GIT_CONFIG_GLOBAL, undefined);
		assert.equal(query.options.env?.GIT_CONFIG_COUNT, undefined);
		assert.equal(clone.options.env?.GIT_CONFIG_NOSYSTEM, '1');
		assert.equal(clone.options.env?.GIT_CONFIG_GLOBAL, checkout.options.env?.GIT_CONFIG_GLOBAL);
		assert.equal(clone.options.env?.GIT_CONFIG_COUNT, '1');
		assert.equal(clone.options.env?.GIT_CONFIG_KEY_0, 'credential.helper');
		assert.equal(clone.options.env?.GIT_CONFIG_VALUE_0, 'manager');
		assert.equal(checkout.options.env?.GIT_CONFIG_NOSYSTEM, '1');
		assert.equal(checkout.options.env?.GIT_CONFIG_COUNT, undefined, 'No inherited filter definition survives');
		assert.equal(checkout.options.env?.GIT_CONFIG_VALUE_0, undefined);
		assert.ok(checkout.options.env?.GIT_CONFIG_GLOBAL?.endsWith('empty.gitconfig'));
		assert.equal(clone.options.cwd, checkout.options.cwd);
		assert.equal(query.options.cwd, clone.options.cwd);
		assert.notEqual(clone.options.cwd, DESTINATION);
		assert.match(host.confirmation, /Default branch only/u);
		assert.match(host.confirmation, /Only selected authentication settings \(credential helper, useHttpPath, and username, including URL-scoped settings\) from system\/global Git configuration/u);
		assert.match(host.confirmation, /Git applies URL scoping/u);
		assert.match(host.confirmation, /trusted user-installed Git credential helpers may run.*including shell helpers/u);
		assert.match(host.confirmation, /authentication settings are not used for checkout/u);
		assert.ok(host.confirmation.includes(`Exact destination: ${DESTINATION}`));
		assert.match(host.inputOptions!.prompt!, /not a file or folder link/u);
		assert.equal(host.fs.removed.length, 1);
		assert.equal(host.fs.entries.has(host.fs.removed[0]), false);
		assert.equal(host.fs.entries.has(DESTINATION), true);
		assert.deepEqual(host.fs.writes, [''], 'No credential values are written to disk');
		assert.deepEqual(host.logs, []);
	});
	it('preserves ordered generic and scoped auth settings, empty resets and multiline helpers only in clone env', async () => {
		const host = new Host();
		const injection = ['url.ssh://dummy.invalid/.insteadOf', 'http.https://github.com/.followRedirects', 'http.sslVerify',
			'core.hooksPath', 'hook.dummy.command', 'hook.dummy.event', 'trace2.eventTarget', 'filter.dummy.smudge', 'credential.helper'];
		host.env.GIT_CONFIG_COUNT = String(injection.length);
		injection.forEach((key, index) => {
			host.env[`GIT_CONFIG_KEY_${index}`] = key;
			host.env[`GIT_CONFIG_VALUE_${index}`] = `DUMMY_INJECTED_${index}`;
		});
		for (const key of ['git_config_parameters', 'git_trace2_event', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_SSH_COMMAND', 'GCM_TRACE']) {
			host.env[key] = 'DUMMY_INJECTED_OVERRIDE';
		}
		const before = JSON.stringify(host.env);
		host.queryBehavior = ({ child }) => {
			// Deliberately split in the middle of a multibyte character as well as between records.
			const data = Buffer.from(configOutput(AUTH_SETTINGS));
			const split = data.indexOf(Buffer.from('雪')) + 1;
			child.stdout.emit('data', data.subarray(0, split));
			child.stdout.emit('data', data.subarray(split));
			child.finish();
		};
		assert.equal(await host.run(), DESTINATION);
		const [query, clone, checkout] = host.launches;
		assert.equal(query.options.env?.GIT_CONFIG_COUNT, undefined);
		assert.equal(clone.options.env?.GIT_CONFIG_COUNT, String(AUTH_SETTINGS.length));
		const retained = Object.entries(clone.options.env!).filter(([key]) => /^GIT_CONFIG_(?:KEY|VALUE)_/u.test(key));
		assert.deepEqual(retained, AUTH_SETTINGS.flatMap(({ key, value }, index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]]));
		assert.equal(checkout.options.env?.GIT_CONFIG_COUNT, undefined);
		assert.equal(Object.keys(checkout.options.env!).some(key => /^GIT_CONFIG_(?:KEY|VALUE)_/u.test(key)), false);
		assert.doesNotMatch(JSON.stringify(host.launches.map(launch => [launch.args, launch.options.env])), /DUMMY_INJECTED|DO_NOT_RUN/u);
		const publicOutput = JSON.stringify([host.launches.map(launch => launch.args), host.fs.writes, host.logs, host.warnings, host.reports, host.confirmation]);
		assert.doesNotMatch(publicOutput, /DUMMY_|dummy-helper/u);
		assert.deepEqual(host.fs.writes, ['']);
		assert.deepEqual(host.logs, []);
		assert.equal(JSON.stringify(host.env), before);
	});
	it('unexpected config fields discard the whole selection without replay or disclosure', async () => {
		for (const key of FORBIDDEN_CONFIG_KEYS) {
			const host = new Host();
			host.queryBehavior = ({ child }) => {
				child.stdout.emit('data', Buffer.from(configOutput([...AUTH_SETTINGS, { key, value: 'DUMMY_SECRET' }])));
				child.finish();
			};
			assert.equal(await host.run(), DESTINATION);
			assert.equal(host.launches[1].options.env?.GIT_CONFIG_COUNT, undefined);
			assert.equal(host.launches[2].options.env?.GIT_CONFIG_COUNT, undefined);
			assert.doesNotMatch(JSON.stringify([host.launches.map(({ args, options }) => [args, options.env]),
				host.warnings, host.logs, host.reports, host.fs.writes]), /DUMMY_SECRET|DUMMY_AUTH_FIXTURE/u);
		}
	});
	it('config read failures discard partial auth settings with a clear sanitized auth failure', async () => {
		for (const scenario of ['no-helper', 'nonzero', 'spawn-error', 'malformed', 'empty']) {
			const host = new Host();
			host.queryBehavior = ({ child }) => {
				if (!['no-helper', 'empty'].includes(scenario)) {
					child.stdout.emit('data', Buffer.from(`credential.https://github.com.helper\n!echo DUMMY_PRIVATE_HELPER${scenario === 'malformed' ? '' : '\0'}`));
				}
				if (scenario === 'spawn-error') { child.emit('error', new Error('DUMMY_PRIVATE_PROCESS_ERROR')); }
				child.finish(['malformed', 'empty'].includes(scenario) ? 0 : 1);
			};
			host.behavior = ({ child }) => { child.emit('error', new Error('DUMMY_PRIVATE_AUTH_ERROR')); child.finish(128); };
			assert.equal(await host.run(), undefined);
			assert.equal(host.launches.length, 2, 'Query failure may fetch without helpers but auth failure must not checkout');
			const clone = host.launches[1];
			assert.equal(clone.options.env?.GIT_CONFIG_COUNT, undefined);
			assert.equal(clone.options.env?.GIT_CONFIG_VALUE_0, undefined);
			assert.equal(clone.options.env?.GIT_CONFIG_NOSYSTEM, '1');
			assert.ok(clone.options.env?.GIT_CONFIG_GLOBAL);
			assert.match(host.warnings[0], /repository access.*private repository.*sign in manually/su);
			assert.doesNotMatch(JSON.stringify([host.warnings, host.logs, host.reports, host.fs.writes, clone.options.env, clone.args]), /DUMMY_PRIVATE/u);
			assert.deepEqual(host.logs, []);
		}
	});
	it('caps the private config capture at 64 KiB (including keys and delimiters)', async () => {
		for (const extra of [0, 1]) {
			const host = new Host(); host.platform = 'linux';
			const key = 'credential.https://github.com.helper';
			const length = 64 * 1024 - Buffer.byteLength(key) - 2;
			host.queryBehavior = ({ child }) => {
				child.stdout.emit('data', Buffer.from(`${key}\n${'x'.repeat(length + extra)}\0`));
				child.finish();
			};
			assert.equal(await host.run(), DESTINATION);
			assert.equal(host.launches[1].options.env?.GIT_CONFIG_COUNT, extra ? undefined : '1');
			assert.equal(host.launches[1].options.env?.GIT_CONFIG_VALUE_0?.length, extra ? undefined : length);
			assert.deepEqual(host.kills, extra ? [[-host.launches[0].child.pid, 'SIGKILL']] : []);
			assert.deepEqual(host.warnings, []); assert.deepEqual(host.logs, []);
		}
	});
	for (const platform of ['win32', 'linux']) {
		for (const reason of ['overflow', 'timeout', 'cancel', 'dispose', 'owner']) {
			it(`${platform}: query ${reason} waits for process exit before network or cleanup`, async () => {
				const host = new Host(); host.platform = platform; host.queryBehavior = () => {};
				const lifetime = new AbortController();
				const operation = host.run(reason === 'owner' ? lifetime.signal : undefined); const query = await host.queryStarted.promise;
				query.child.stdout.emit('data', Buffer.from('credential.https://github.com.helper\n!echo DUMMY_PRIVATE_HELPER\0'));
				if (reason === 'overflow') { query.child.stdout.emit('data', Buffer.alloc(64 * 1024)); }
				if (reason === 'timeout') {
					const timeout = [...host.timers.values()].find(timer => timer.ms === 10000);
					assert.ok(timeout); timeout.callback();
				}
				if (reason === 'cancel') { host.cancel(); }
				if (reason === 'dispose') { host.context.subscriptions[0].dispose(); }
				if (reason === 'owner') { lifetime.abort(); }
				await drain();
				assert.equal(host.launches.some(launch => launch.args.includes('clone')), false);
				assert.deepEqual(host.fs.removed, []);
				if (platform === 'win32') {
					const killer = await host.killStarted.promise;
					assert.deepEqual(killer.args, ['/PID', String(query.child.pid), '/T', '/F']);
					query.child.finish(1); await drain();
					assert.equal(host.launches.some(launch => launch.args.includes('clone')), false);
					assert.deepEqual(host.fs.removed, []);
					killer.child.finish();
				} else {
					assert.deepEqual(host.kills, [[-query.child.pid, 'SIGKILL']]); query.child.finish(1);
				}
				const cancelled = reason === 'cancel' || reason === 'dispose' || reason === 'owner';
				assert.equal(await operation, cancelled ? undefined : DESTINATION);
				const clone = host.launches.find(launch => launch.args.includes('clone'));
				if (cancelled) {
					assert.equal(clone, undefined);
					if (reason === 'owner') { assert.deepEqual(host.warnings, []); }
					else { assert.match(host.warnings[0], /cancelled/u); }
				}
				else { assert.ok(clone); assert.equal(clone.options.env?.GIT_CONFIG_COUNT, undefined); }
				assert.equal(host.fs.removed.length, 1);
				assert.equal(host.fs.entries.has(DESTINATION), true);
				assert.doesNotMatch(JSON.stringify([host.warnings, host.logs, host.reports, host.fs.writes, clone?.options.env]), /DUMMY_PRIVATE/u);
				assert.deepEqual(host.logs, []);
			});
		}
	}
	it('uses the built-in Git API v1 executable after activation', async () => {
		const host = new Host(); const executable = path.join(ROOT, 'Program Files', 'git.exe'); host.fs.put(executable, '');
		let activated = 0;
		host.extension = { isActive: false, activate: async () => { activated++; return { getAPI: (version: number) => {
			assert.equal(version, 1); return { git: { path: executable } };
		} }; } };
		assert.equal(await host.run(), DESTINATION); assert.equal(activated, 1);
		assert.ok(host.launches.every(launch => launch.executable === executable));
	});
	it('an already-retired owner never prompts or touches the filesystem', async () => {
		const host = new Host(); const lifetime = new AbortController(); lifetime.abort();
		assert.equal(await host.run(lifetime.signal), undefined);
		assert.deepEqual(host.dialogs, []); assert.deepEqual(host.warnings, []);
		assert.deepEqual(host.fs.reads, []); assert.deepEqual(host.fs.writes, []);
		assert.deepEqual(host.launches, []); assert.equal(host.progressCalls, 0);
	});
	for (const stage of ['input', 'picker', 'confirmation']) {
		it(`owner cancellation ignores a pending ${stage} result without further dialogs, filesystem access or Git`, async () => {
			const host = new Host(); const lifetime = new AbortController();
			const pending = deferred<void>(); const resume = deferred<void>();
			const hold = <A extends unknown[], T>(prompt: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
				const result = await prompt(...args);
				pending.resolve(); await resume.promise; return result;
			};
			if (stage === 'input') { host.api.window.showInputBox = hold(host.api.window.showInputBox); }
			if (stage === 'picker') { host.api.window.showOpenDialog = hold(host.api.window.showOpenDialog); }
			if (stage === 'confirmation') { host.api.window.showInformationMessage = hold(host.api.window.showInformationMessage); }
			const operation = host.run(lifetime.signal);
			await pending.promise;
			const reads = [...host.fs.reads]; const dialogs = [...host.dialogs];
			lifetime.abort(); resume.resolve();
			assert.equal(await operation, undefined);
			assert.deepEqual(host.dialogs, dialogs); assert.deepEqual(host.warnings, []);
			assert.deepEqual(host.fs.reads, reads); assert.deepEqual(host.fs.writes, []);
			assert.equal(host.fs.entries.has(DESTINATION), false); assert.deepEqual(host.fs.removed, []);
			assert.deepEqual(host.launches, []); assert.equal(host.extensionCalls, 0); assert.equal(host.progressCalls, 0);
		});
	}
	it('owner cancellation during Git extension activation stops before executable inspection or Git', async () => {
		const host = new Host(); const lifetime = new AbortController();
		const pending = deferred<void>(); const activation = deferred<unknown>();
		const executable = path.join(ROOT, 'git.exe'); host.fs.put(executable, '');
		host.extension = { isActive: false, activate: async () => { pending.resolve(); return activation.promise; } };
		const operation = host.run(lifetime.signal);
		await pending.promise;
		const reads = [...host.fs.reads];
		lifetime.abort(); activation.resolve({ getAPI: () => ({ git: { path: executable } }) });
		assert.equal(await operation, undefined);
		assert.deepEqual(host.fs.reads, reads); assert.deepEqual(host.launches, []); assert.deepEqual(host.warnings, []);
		assert.equal(host.fs.removed.length, 1); assert.equal(host.fs.entries.has(DESTINATION), true);
	});
	it('owner cancellation during cleanup suppresses both clone failures and cleanup warnings', async () => {
		for (const invalid of [false, true]) {
			const host = new Host(); const lifetime = new AbortController();
			if (invalid) { host.checkoutFiles = {}; }
			host.fs.api.rm = async () => { lifetime.abort(); throw new Error('PRIVATE_CLEANUP_ERROR'); };
			assert.equal(await host.run(lifetime.signal), undefined);
			assert.deepEqual(host.warnings, []); assert.deepEqual(host.logs, []);
			assert.equal(host.fs.entries.has(DESTINATION), true);
		}
	});
	it('cancelled input, picker, confirmation and already-cancelled progress never spawn', async () => {
		for (const stage of ['input', 'picker', 'confirmation', 'progress']) {
			const host = new Host();
			if (stage === 'input') { host.input = undefined; }
			if (stage === 'picker') { host.folders = undefined; }
			if (stage === 'confirmation') { host.answer = undefined; }
			if (stage === 'progress') { host.cancelled = true; }
			assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 0);
			assert.equal(host.fs.entries.has(DESTINATION), false); assert.equal(host.extensionCalls, 0);
		}
	});
	it('enforces trust before prompting and after confirmation', async () => {
		for (const initial of [true, false]) {
			const host = new Host(); host.workspace.isTrusted = initial;
			host.onConfirm = () => { host.workspace.isTrusted = false; };
			assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 0);
			assert.match(host.warnings[0], /trusted workspace/u);
			if (!initial) { assert.equal(host.inputOptions, undefined); }
		}
	});
	it('rejects bad URLs and nonlocal/missing/file parent folders without writes', async () => {
		for (const scenario of ['url', 'remote', 'authority', 'missing', 'file', 'variable']) {
			const host = new Host();
			if (scenario === 'url') { host.input = `${URL}/tree/main`; }
			if (scenario === 'remote') { host.folders![0].scheme = 'vscode-remote'; }
			if (scenario === 'authority') { host.folders![0].authority = 'server'; }
			if (scenario === 'missing') { host.fs.entries.delete(PARENT); }
			if (scenario === 'file') { host.fs.put(PARENT, 'file'); }
			if (scenario === 'variable') { host.folders![0].fsPath = path.join(ROOT, '$HOME'); }
			assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 0);
			assert.equal(host.fs.entries.has(DESTINATION), false); assert.equal(host.warnings.length, 1);
		}
	});
	it('refuses every existing destination, including an empty folder or a confirmation-time race', async () => {
		for (const kind of ['empty', 'file', 'symlink', 'race']) {
			const host = new Host();
			const create = () => { host.fs.put(DESTINATION, kind === 'file' ? 'user edits' : undefined); };
			if (kind === 'race') { host.onConfirm = create; } else { create(); }
			if (kind === 'symlink') { host.fs.entries.get(DESTINATION)!.symlink = true; }
			assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 0);
			assert.match(host.warnings[0], /exclusively.*never overwritten/u); assert.deepEqual(host.fs.removed, []);
			assert.equal(host.fs.entries.has(DESTINATION), true);
		}
	});
	it('retains missing, invalid, and nested-only courses without searching subfolders or exposing raw errors', async () => {
		const cases: Record<string, string>[] = [{}, { 'course.json': 'PRIVATE_INVALID_MANIFEST' },
			{ 'sub/course.json': JSON.stringify(manifest) }, { 'course.json': JSON.stringify(manifest) }];
		for (const files of cases) {
			const host = new Host(); host.checkoutFiles = files;
			assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 3);
			assert.match(host.warnings[0], /root.*retained.*Add local course.*subfolder/su);
			assert.match(host.warnings[0], /not registered/u); assert.doesNotMatch(host.warnings[0], /PRIVATE_/u);
			assert.equal(host.fs.entries.has(DESTINATION), true);
		}
	});
	it('sanitizes nonzero and spawn-error failures and never starts checkout afterward', async () => {
		for (const error of [false, true]) {
			const host = new Host();
			host.behavior = ({ child }) => { if (error) { child.emit('error', new Error('PRIVATE_PROCESS_ERROR')); } child.finish(128); };
			assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 2);
			assert.match(host.warnings[0], /Git is installed.*sign in manually.*not registered/su);
			assert.doesNotMatch(host.warnings[0], /PRIVATE_PROCESS_ERROR/u); assert.equal(host.fs.entries.has(DESTINATION), true);
		}
	});
	it('stops before checkout when the owned destination was replaced', async () => {
		const host = new Host(); host.behavior = ({ child }) => { host.fs.put(DESTINATION); child.finish(); };
		assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 2);
		assert.match(host.warnings[0], /destination changed/u); assert.equal(host.fs.entries.has(DESTINATION), true);
	});
	it('cancels during checkout without returning a root or cleaning temporary files before exit', async () => {
		const host = new Host(); host.platform = 'linux';
		const checkoutStarted = deferred<Launch>();
		host.behavior = launch => {
			if (launch.args.includes('clone')) { launch.child.finish(); } else { checkoutStarted.resolve(launch); }
		};
		const operation = host.run(); const checkout = await checkoutStarted.promise;
		host.cancel(); await drain();
		assert.deepEqual(host.kills, [[-checkout.child.pid, 'SIGKILL']]);
		assert.deepEqual(host.fs.removed, []);
		checkout.child.finish(1);
		assert.equal(await operation, undefined); assert.equal(host.launches.length, 3);
		assert.match(host.warnings[0], /cancelled.*not registered/su);
	});
	it('retains clone contents on checkout failure and rejects non-native Git paths before spawn', async () => {
		const host = new Host();
		host.behavior = launch => { launch.child.finish(launch.args.includes('clone') ? 0 : 128); };
		assert.equal(await host.run(), undefined); assert.equal(host.launches.length, 3);
		assert.equal(host.fs.entries.has(DESTINATION), true); assert.match(host.warnings[0], /not registered/u);
		const scriptHost = new Host(); const executable = path.join(ROOT, 'git.cmd'); scriptHost.fs.put(executable, 'do not run');
		scriptHost.extension = { isActive: true, exports: { getAPI: () => ({ git: { path: executable } }) } };
		assert.equal(await scriptHost.run(), undefined); assert.deepEqual(scriptHost.launches, []);
	});
	for (const platform of ['win32', 'linux']) {
		for (const reason of ['cancel', 'timeout', 'dispose', 'owner']) {
			it(`${platform}: ${reason} kills only the owned tree and waits for exit before cleanup`, async () => {
				const host = new Host(); host.platform = platform; host.behavior = () => {};
				const lifetime = new AbortController();
				let settled = false; const operation = host.run(reason === 'owner' ? lifetime.signal : undefined).then(value => { settled = true; return value; });
				const launch = await host.started.promise;
				assert.equal(launch.options.detached, platform !== 'win32');
				const [timer] = host.timers.values(); assert.equal(timer.ms, 600000);
				if (reason === 'cancel') { host.cancel(); }
				if (reason === 'timeout') { timer.callback(); }
				if (reason === 'dispose') { host.context.subscriptions[0].dispose(); }
				if (reason === 'owner') { lifetime.abort(); }
				await drain(); assert.equal(settled, false); assert.deepEqual(host.fs.removed, []);
				if (platform === 'win32') {
					const killer = await host.killStarted.promise;
					assert.deepEqual(killer.args, ['/PID', String(launch.child.pid), '/T', '/F']);
					assert.deepEqual(host.kills, []);
					launch.child.finish(1); await drain(); assert.equal(settled, false); assert.deepEqual(host.fs.removed, []);
					killer.child.finish();
				} else {
					assert.deepEqual(host.kills, [[-launch.child.pid, 'SIGKILL']]); launch.child.finish(1);
				}
				assert.equal(await operation, undefined); assert.equal(host.fs.removed.length, 1);
				assert.equal(host.fs.entries.has(DESTINATION), true);
				if (reason === 'owner') { assert.deepEqual(host.warnings, []); }
				else {
					assert.match(host.warnings[0], reason === 'timeout' ? /timed out after 10 minutes/u : /cancelled/u);
					assert.match(host.warnings[0], /possibly partial.*not registered/u);
				}
			});
		}
	}
});