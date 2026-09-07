'use strict';

// Manual, opt-in live validation; deliberately NOT included in any npm test command.
// Requires --run --url https://github.com/tjav/ai103-learning
//          --git "C:/Program Files/Git/cmd/git.exe"
// Only VS Code is shimmed. The optional stderr observer delegates to real spawn,
// preserving argv, environment, cancellation, and every production safety setting.
// Never log raw errors, process options/environment, auth config stdout, or helpers.
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const Module = require('node:module');
const { parseArgs } = require('node:util');
const { createHash } = require('node:crypto');

const ALLOWED = new Map([
	['https://github.com/tjav/ai103-learning.git', { courseId: 'ai103', units: 17, activities: 62 }]
]);
const nativeSpawn = childProcess.spawn;
const LIMIT = 64 * 1024;
class ValidationError extends Error {}
function check(condition, message) {
	if (!condition) { throw new ValidationError(message); }
}
function emit(value) { console.log(JSON.stringify(value)); }
function osCode(error) {
	return ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EEXIST', 'ETIMEDOUT'].includes(error?.code)
		? error.code : 'withheld';
}

// Fixed-vocabulary diagnostics only: no substring of stderr is ever printed.
function gitReasons(text) {
	const rules = [
		[/authentication failed/iu, 'authentication-failed'],
		[/could not read (?:Username|Password).*terminal prompts disabled/iu, 'credentials-unavailable-terminal-prompts-disabled'],
		[/cannot prompt because user interactivity has been disabled|interactive prompts disabled/iu, 'interactive-authentication-disabled'],
		[/repository not found/iu, 'repository-not-found-or-no-access'],
		[/requested URL returned error: 401/iu, 'http-401'],
		[/requested URL returned error: 403/iu, 'http-403'],
		[/requested URL returned error: 404/iu, 'http-404'],
		[/requested URL returned error: 429/iu, 'http-429'],
		[/SSL certificate problem|certificate verify failed|schannel:.*(?:failed|error)/iu, 'tls-certificate-validation-failed'],
		[/could not resolve host/iu, 'dns-host-resolution-failed'],
		[/could not resolve proxy/iu, 'dns-proxy-resolution-failed'],
		[/failed to connect|connection refused/iu, 'connection-failed'],
		[/connection timed out|operation timed out/iu, 'network-timeout'],
		[/permission denied|access is denied/iu, 'permission-denied'],
		[/already exists and is not an empty directory/iu, 'destination-exists'],
		[/unable to create file|invalid path/iu, 'checkout-path-error'],
		[/not a git repository/iu, 'not-a-git-repository'],
		[/unable to find remote helper|is not a git command/iu, 'git-command-or-helper-unavailable'],
		[/early EOF|invalid index-pack output|fetch-pack:.*unexpected disconnect/iu, 'incomplete-transfer'],
		[/unable to access/iu, 'remote-access-failed']
	];
	const found = rules.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
	return found.length ? found : ['unclassified-stderr-withheld'];
}
function observeStderr(child, record) {
	let bytes = 0;
	const chunks = [];
	child.stderr?.on('data', chunk => {
		const count = Math.min(chunk.length, LIMIT - bytes);
		if (count > 0) { chunks.push(Buffer.from(chunk.subarray(0, count))); bytes += count; }
		if (count < chunk.length) { record.stderrTruncated = true; }
		chunk.fill(0);
	});
	child.once('error', error => { record.osCode = osCode(error); });
	child.once('close', (code, signal) => {
		record.exitCode = code;
		record.signaled = signal !== null;
		const buffer = Buffer.concat(chunks);
		if (code !== 0 && buffer.length) { record.reasons = gitReasons(buffer.toString('utf8')); }
		buffer.fill(0);
		for (const chunk of chunks) { chunk.fill(0); }
	});
}

const WARNING_RULES = [
	['Destination could not be created exclusively.', 'destination-exists-refused'],
	['Git could not finish.', 'git-failed'],
	['No valid course.json was found', 'root-course-validation-failed'],
	['Cloning cancelled.', 'cancelled'],
	['Cloning timed out after 10 minutes.', 'timeout'],
	['Cloning a course requires a trusted workspace.', 'workspace-not-trusted'],
	['The destination changed.', 'destination-changed'],
	['The selected parent folder changed.', 'parent-changed'],
	['The course was validated, but its temporary Git safety directory could not be removed.', 'safety-directory-cleanup-failed']
];
function warningCode(message) {
	return WARNING_RULES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? 'warning-withheld';
}

function hostShim(url, parent, destination, git, canonicalUrl, state) {
	return {
		workspace: { isTrusted: true },
		ProgressLocation: { Notification: 15 },
		extensions: {
			getExtension(id) {
				check(id === 'vscode.git', 'Unexpected extension requested.');
				state.gitApiCalls++;
				return { isActive: true, exports: { getAPI(version) {
					check(version === 1, 'Unexpected built-in Git API version.');
					return { git: { path: git } };
				} } };
			}
		},
		window: {
			async showInputBox(options) {
				check(await options.validateInput(url) === undefined, 'Production URL validation rejected the allowlisted URL.');
				state.inputs++;
				return url;
			},
			async showOpenDialog(options) {
				check(options.canSelectFolders && !options.canSelectFiles && !options.canSelectMany, 'Unexpected destination picker options.');
				state.folders++;
				return [{ scheme: 'file', authority: '', fsPath: parent }];
			},
			async showInformationMessage(message, options, ...buttons) {
				check(message === 'Clone this GitHub course?' && options.modal === true &&
					buttons.length === 1 && buttons[0] === 'Clone course' &&
					options.detail.includes(`Repository: ${canonicalUrl}\nExact destination: ${destination}\n`),
					'Unexpected clone confirmation.');
				state.confirmations++;
				return 'Clone course';
			},
			async showWarningMessage(message) {
				const warning = warningCode(message);
				state.warnings.push(warning);
				emit({ warning });
			},
			async withProgress(options, task) {
				check(options.cancellable === true && options.location === 15, 'Unexpected progress options.');
				state.progressCalls++;
				return task({ report() {} }, {
					isCancellationRequested: false,
					onCancellationRequested() {
						state.listeners++;
						let disposed = false;
						return { dispose() { if (!disposed) { state.listeners--; disposed = true; } } };
					}
				});
			}
		}
	};
}

// Read metadata only, including .git and hidden files. Never open .env, key files,
// Git objects, or course code. Exclude atime because inspection can update it.
async function metadataSnapshot(root) {
	const digest = createHash('sha256');
	let entries = 0;
	async function visit(relative) {
		const file = path.join(root, relative);
		const info = await fs.lstat(file, { bigint: true });
		digest.update(JSON.stringify([relative, info.dev.toString(), info.ino.toString(),
			info.mode.toString(), info.nlink.toString(), info.size.toString(),
			info.mtimeNs.toString(), info.ctimeNs.toString(), info.birthtimeNs.toString()]));
		entries++;
		if (info.isDirectory() && !info.isSymbolicLink()) {
			for (const name of (await fs.readdir(file)).sort()) { await visit(path.join(relative, name)); }
		}
	}
	await visit('');
	return { entries, digest: digest.digest('hex') };
}

async function main() {
	let values;
	try {
		({ values } = parseArgs({ options: {
			run: { type: 'boolean', default: false }, url: { type: 'string' }, git: { type: 'string' }
		}, allowPositionals: false, strict: true }));
	} catch { throw new ValidationError('Invalid arguments. Supply --run, --url and --git; argument values withheld.'); }
	if (!values.run) {
		emit({ result: 'SKIPPED', reason: 'No live operations without --run; --url and --git are also required.' });
		return;
	}
	check(Boolean(values.url && values.git), 'Live validation requires explicit --url and --git.');
	check(process.platform === 'win32', 'This validation harness requires Windows.');
	const root = await fs.realpath(path.resolve(__dirname, '..'));
	const core = require(path.join(root, 'out/src/core/githubCourse.js'));
	let repository;
	try { repository = core.parseGitHubRepository(values.url); core.assertGitPath(values.git); }
	catch { throw new ValidationError('Unsafe URL or Git executable path; supplied values withheld.'); }
	const expected = ALLOWED.get(repository.url);
	check(Boolean(expected), 'Repository is not in the explicitly approved allowlist.');
	check(path.basename(values.git).toLowerCase() === 'git.exe' && (await fs.stat(values.git)).isFile(), 'An existing native git.exe is required.');
	check(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version === '0.2.0', 'Expected cert-learner v0.2.0.');
	for (const relative of ['githubCourse', 'core/githubCourse', 'core/course', 'core/validation']) {
		check((await fs.stat(path.join(root, `out/src/${relative}.js`))).mtimeMs >=
			(await fs.stat(path.join(root, `src/${relative}.ts`))).mtimeMs, 'Compiled code is stale; compile locally before live validation.');
	}
	check((await fs.readFile(path.join(root, '.gitignore'), 'utf8')).split(/\r?\n/u).includes('.vscode-test/'), 'The disposable parent must be ignored.');
	const scratch = path.join(root, '.vscode-test');
	await fs.mkdir(scratch, { recursive: true });
	check(!(await fs.lstat(scratch)).isSymbolicLink() && await fs.realpath(scratch) === scratch, 'Disposable root must be a canonical local directory.');
	const parent = await fs.realpath(await fs.mkdtemp(path.join(scratch, 'verify-github-clone-')));
	const destination = path.join(parent, repository.repo);
	core.assertGitPath(parent);
	const hooks = path.join(parent, 'verification-empty-hooks');
	const config = path.join(parent, 'verification-empty.gitconfig');
	await fs.mkdir(hooks, { mode: 0o700 });
	await fs.writeFile(config, '', { flag: 'wx', mode: 0o600 });
	// These probes are local/read-only, use real production isolation, and never
	// query any auth config. The production clone alone selects the user's auth.
	async function localGit(directory, args, acceptable = [0]) {
		const record = { phase: 'local-verification' };
		const safety = core.buildCheckoutArgs(directory, hooks).slice(0, -3);
		const child = nativeSpawn(values.git, ['--no-optional-locks', ...safety, ...args], {
			cwd: hooks, env: core.buildGitEnvironment(process.env, config),
			shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
		});
		observeStderr(child, record);
		const chunks = [];
		let bytes = 0;
		let oversized = false;
		child.stdout.on('data', chunk => {
			bytes += chunk.length;
			if (bytes <= 2 * 1024 * 1024) { chunks.push(Buffer.from(chunk)); }
			else { oversized = true; }
			chunk.fill(0);
		});
		await new Promise(resolve => child.once('close', resolve));
		const buffer = Buffer.concat(chunks);
		try {
			if (oversized || record.osCode || !acceptable.includes(record.exitCode)) {
				emit(record);
				throw new ValidationError('A read-only local Git verification failed; raw output withheld.');
			}
			return { code: record.exitCode, output: buffer.toString('utf8') };
		} finally { buffer.fill(0); for (const chunk of chunks) { chunk.fill(0); } }
	}
	await localGit(root, ['check-ignore', '--quiet', '--no-index', '--', parent]);
	emit({ result: 'STARTED', repository: repository.url, parent, destination, artifact: 'out/src/githubCourse.js' });
	const state = { inputs: 0, folders: 0, confirmations: 0, progressCalls: 0, gitApiCalls: 0, listeners: 0, warnings: [] };
	const context = { subscriptions: [] };
	const launches = [];
	const shim = hostShim(values.url, parent, destination, values.git, repository.url, state);
	const originalLoad = Module._load;
	let cloneGitHubCourse;
	try {
		Module._load = function (request, parentModule, isMain) {
			if (request === 'vscode') { return shim; }
			return originalLoad.call(this, request, parentModule, isMain);
		};
		({ cloneGitHubCourse } = require(path.join(root, 'out/src/githubCourse.js')));
	} finally { Module._load = originalLoad; }
	check(typeof cloneGitHubCourse === 'function', 'Compiled clone export is missing.');
	childProcess.spawn = function (executable, args, options) {
		const phase = args.includes('clone') ? 'clone' : args.includes('reset') ? 'checkout'
			: args.includes('config') ? 'credential-config-query' : 'other';
		const record = { phase, explicitGit: executable === values.git };
		launches.push(record);
		// Do not read/copy/log auth stdout or inspect options.env. Only clone and
		// checkout stderr change from ignored to a privately drained pipe.
		const diagnostic = (phase === 'clone' || phase === 'checkout') && options.stdio === 'ignore';
		let child;
		try {
			child = nativeSpawn(executable, args, diagnostic ? { ...options, stdio: ['ignore', 'ignore', 'pipe'] } : options);
		} catch (error) { record.osCode = osCode(error); throw error; }
		observeStderr(child, record);
		return child;
	};
	try {
		const returned = await cloneGitHubCourse(context);
		emit({ attempt: 1, returnedExpectedRoot: returned === destination, launches });
		check(returned === destination, 'Actual cloneGitHubCourse did not return the expected course root.');
		check(state.warnings.length === 0, 'The initial clone produced a warning.');
		check(launches.map(item => item.phase).join(',') === 'credential-config-query,clone,checkout' &&
			launches.every(item => item.explicitGit) && launches.slice(1).every(item => item.exitCode === 0), 'Unexpected real Git execution sequence.');
		check(state.gitApiCalls === 1 && state.listeners === 0 && context.subscriptions.length === 0, 'Git API or lifecycle validation failed.');
		const { loadCourse } = require(path.join(root, 'out/src/core/course.js'));
		const course = await loadCourse(path.join(returned, 'course.json'));
		const units = course.manifest.units.length;
		const activities = course.manifest.units.reduce((total, unit) => total + unit.activities.length, 0);
		check(course.root === destination && course.manifest.courseId === expected.courseId &&
			units === expected.units && activities === expected.activities, 'Course identity or 17/62 counts did not match.');
		const identityRoot = course.root.toLowerCase();
		check(course.id === createHash('sha256').update(JSON.stringify([identityRoot, expected.courseId])).digest('hex'), 'Real core clone-specific ID did not match.');
		const remote = await localGit(destination, ['config', '--local', '--no-includes', '--get-all', 'remote.origin.url']);
		check(remote.output.trim() === repository.url, 'Origin does not equal the allowlisted URL; actual value withheld.');
		const tracked = (await localGit(destination, ['ls-files', '--cached', '-z'])).output.split('\0').filter(Boolean);
		check(!tracked.some(file => file.split('/').some(segment => segment.toLowerCase() === '.env')), 'A .env path is tracked; filenames and contents withheld.');
		check((await localGit(destination, ['rev-parse', '--is-shallow-repository'])).output.trim() === 'true', 'Clone is not shallow.');
		check((await localGit(destination, ['rev-list', '--count', 'HEAD'])).output.trim() === '1', 'Clone depth is not one.');
		const head = (await localGit(destination, ['rev-parse', '--verify', 'HEAD'])).output.trim();
		check(/^[a-f0-9]{40,64}$/u.test(head), 'Invalid HEAD object ID; output withheld.');
		emit({ courseId: course.manifest.courseId, cloneSpecificId: course.id, units, activities,
			remoteMatches: true, trackedEnvFiles: 0, shallow: true, depth: 1, head });
		const before = await metadataSnapshot(destination);
		const launchCount = launches.length;
		const second = await cloneGitHubCourse(context);
		const after = await metadataSnapshot(destination);
		check(second === undefined && state.warnings.length === 1 && state.warnings[0] === 'destination-exists-refused', 'Second attempt did not explicitly refuse the existing destination.');
		check(launches.length === launchCount, 'Second attempt unexpectedly started a process.');
		check(before.entries === after.entries && before.digest === after.digest, 'Clone filesystem metadata changed during collision refusal.');
		check(state.inputs === 2 && state.folders === 2 && state.confirmations === 2 && state.progressCalls === 2 &&
			state.gitApiCalls === 1 && state.listeners === 0 && context.subscriptions.length === 0, 'Second-attempt UI/lifecycle validation failed.');
		emit({ result: 'PASS', attempt2ReturnedUndefined: true, attempt2SpawnCount: 0,
			cloneMetadataUnchanged: true, metadataEntries: before.entries, metadataDigest: before.digest,
			retainedUnderIgnoredParent: parent,
			limits: ['VS Code UI/trust/Git API shimmed, not an extension-host UI test',
				'Unchanged check uses all-entry metadata and zero second-attempt spawns, not file-content hashes',
				'Only the .env filename is checked for tracking; no secret-content scan',
				'No course code executed; no cancellation, trust-loss, or alternate-auth scenarios exercised'] });
	} finally {
		childProcess.spawn = nativeSpawn;
		for (const subscription of context.subscriptions.splice(0)) { subscription.dispose(); }
	}
}

if (require.main === module) {
	main().catch(error => {
		emit({ result: 'FAIL', reason: error instanceof ValidationError ? error.message : 'Unexpected error; details withheld.', osCode: osCode(error) });
		process.exitCode = 1;
	});
}