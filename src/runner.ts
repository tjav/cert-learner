import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MAX_CHECK_RESULT_BYTES, validateCheckResult } from './checkResult';
import type { CheckResult, CheckStatus } from './checkResult';
import { resolveResource, validateManifest } from './core/course';
import type { Check } from './core/course';
import type { Selection } from './ui/tree';

export { validateCheckResult } from './checkResult';

const TASK_TYPE = 'certLearner.check';
const DEFAULT_TIMEOUT_SECONDS = 60;

function assertTaskLiteral(value: string): void {
	// VS Code task variable expansion must not turn course paths into commands/secrets.
	if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value) || value.includes('${')) {
		throw new Error('Check paths and executables must be literal strings without control characters or task variables.');
	}
}

function assertInside(root: string, candidate: string): void {
	const relative = path.relative(root, candidate);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error('Check working directory escapes the course.');
	}
}

/** The manifest helper has already validated every lexical path segment. */
async function checkedPaths(root: string, check: Check): Promise<{ script: string; cwd: string }> {
	const canonicalRoot = await realpath(root);
	// Loaded courses have canonical roots; do not accept a replaced root symlink.
	if (path.relative(path.resolve(root), canonicalRoot) !== '') {
		throw new Error('The course root has changed; reopen the course before running checks.');
	}
	const script = await resolveResource(canonicalRoot, check.file);
	const extensions: Record<Check['runtime'], readonly string[]> = {
		node: ['.js', '.cjs'], python: ['.py'], pwsh: ['.ps1']
	};
	if (!extensions[check.runtime].includes(path.extname(check.file).toLowerCase()) ||
		!extensions[check.runtime].includes(path.extname(script).toLowerCase())) {
		throw new Error('The check script extension does not match its runtime.');
	}
	let cwd = canonicalRoot;
	let prefix = canonicalRoot;
	if (check.cwd !== undefined && check.cwd !== '.') {
		for (const segment of check.cwd.split('/')) {
			prefix = path.join(prefix, segment);
			cwd = await realpath(prefix);
			assertInside(canonicalRoot, cwd);
		}
	}
	if (!(await stat(cwd)).isDirectory()) { throw new Error('Check cwd must be a directory.'); }
	assertTaskLiteral(script);
	assertTaskLiteral(cwd);
	return { script, cwd };
}

async function runtimeExecutable(runtime: Check['runtime'], folder: vscode.WorkspaceFolder | undefined): Promise<string> {
	const configuration = vscode.workspace.getConfiguration('certLearner', folder?.uri);
	const key = `runtimes.${runtime}`;
	const configured = configuration.get<string>(key);
	const origin = configuration.inspect<string>(key);
	// Package registration should additionally use scope: machine and restricted: true.
	// Fail closed on workspace/folder/language overrides even in a trusted workspace.
	if (origin?.workspaceValue !== undefined || origin?.workspaceFolderValue !== undefined ||
		origin?.workspaceLanguageValue !== undefined || origin?.workspaceFolderLanguageValue !== undefined ||
		origin?.globalLanguageValue !== undefined ||
		(configured !== undefined && (!origin || configured !== (origin.globalValue ?? origin.defaultValue)))) {
		throw new Error('Configure check runtimes in user/machine settings only, not workspace or language settings.');
	}
	const executable = configured === undefined ? runtime : configured;
	if (typeof executable !== 'string' || !executable || executable.trim() !== executable ||
		executable.length > 4096 || /["'`]/u.test(executable)) {
		throw new Error('A runtime must be one unquoted executable name or absolute executable path, without arguments.');
	}
	assertTaskLiteral(executable);
	if (path.isAbsolute(executable)) {
		// An actual file permits spaces in installation paths, but never a command line.
		if (!(await stat(executable)).isFile()) { throw new Error('The configured runtime is not an executable file.'); }
	} else if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(executable)) {
		throw new Error('Runtime arguments, shell options and relative executable paths are not allowed.');
	}
	if (/\.(?:bat|cmd|ps1)$/iu.test(executable)) {
		throw new Error('Configure a native runtime executable, not a shell script.');
	}
	return executable;
}

async function confirmCheck(detail: string, token: vscode.CancellationToken): Promise<boolean> {
	let complete!: (accepted: boolean) => void;
	const response = new Promise<boolean>(resolve => { complete = resolve; });
	const cancellation = token.onCancellationRequested(() => complete(false));
	try {
		if (token.isCancellationRequested) { return false; }
		void Promise.resolve(vscode.window.showInformationMessage('Run this course check?', {
			modal: true, detail
		}, 'Run check')).then(choice => complete(choice === 'Run check'), () => complete(false));
		return await response;
	} finally {
		cancellation.dispose();
	}
}

type TaskOutcome = { exitCode: number } | 'blocked';
type EndEvent = { execution: vscode.TaskExecution; exitCode?: number; process: boolean };

/** Event callbacks are synchronous; file IO and result validation happen after this resolves. */
async function executeCheckTask(task: vscode.Task, timeoutSeconds: number, token: vscode.CancellationToken): Promise<TaskOutcome> {
	const disposables: vscode.Disposable[] = [];
	const expected = { ...task.definition };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let execution: vscode.TaskExecution | undefined;
	let settled = false;
	let aborted = false;
	let pending: EndEvent[] = [];
	let complete!: (outcome: TaskOutcome) => void;
	const outcome = new Promise<TaskOutcome>(resolve => { complete = resolve; });
	const finish = (result: TaskOutcome): void => {
		if (!settled) { settled = true; complete(result); }
	};
	const terminate = (): void => {
		try { execution?.terminate(); } catch { /* Task may already have ended. */ }
	};
	const abort = (): void => {
		aborted = true;
		finish('blocked');
		// Settle first: terminate can synchronously emit task-end events.
		terminate();
	};
	const definitionMatches = (candidate: vscode.TaskExecution): boolean => {
		const definition = candidate.task.definition;
		return definition.type === expected.type && definition.runId === expected.runId &&
			definition.courseId === expected.courseId && definition.unitId === expected.unitId &&
			definition.activityId === expected.activityId;
	};
	const receive = (event: EndEvent): void => {
		if (settled || !definitionMatches(event.execution)) { return; }
		if (!execution) {
			// A fast task can finish before executeTask resolves. Never accept another execution.
			if (pending.length < 32) { pending.push(event); }
			return;
		}
		if (event.execution !== execution) { return; }
		if (token.isCancellationRequested || !vscode.workspace.isTrusted) { abort(); return; }
		if (!event.process || event.exitCode === undefined || !Number.isInteger(event.exitCode)) {
			finish('blocked'); // Ended without a process, or was terminated without an exit code.
		} else {
			finish({ exitCode: event.exitCode });
		}
	};
	try {
		disposables.push(vscode.tasks.onDidEndTaskProcess(event => {
			receive({ execution: event.execution, exitCode: event.exitCode, process: true });
		}));
		disposables.push(vscode.tasks.onDidEndTask(event => {
			receive({ execution: event.execution, process: false });
		}));
		disposables.push(token.onCancellationRequested(abort));
		timer = setTimeout(abort, timeoutSeconds * 1000);
		if (token.isCancellationRequested || !vscode.workspace.isTrusted) { abort(); }
		if (!settled) {
			// Do not await launch: cancellation/timeout must also work while launch is pending.
			void Promise.resolve(vscode.tasks.executeTask(task)).then(started => {
				execution = started;
				if (aborted || token.isCancellationRequested) { abort(); return; }
				if (!definitionMatches(started)) { abort(); return; }
				const earlyEvents = pending;
				pending = [];
				for (const event of earlyEvents) { receive(event); }
			}).catch(abort);
		}
		return await outcome;
	} catch {
		abort();
		return 'blocked';
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
		pending = [];
		for (const disposable of disposables) {
			try { disposable.dispose(); } catch { /* Dispose remaining listeners too. */ }
		}
	}
}

async function readResult(directory: string, resultPath: string, runId: string): Promise<CheckStatus> {
	if (await realpath(directory) !== directory) { return 'blocked'; }
	const before = await lstat(resultPath);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_CHECK_RESULT_BYTES) {
		return 'blocked';
	}
	// O_NONBLOCK also prevents a file swapped for a FIFO from hanging the host on open.
	// POSIX flags supplement lstat/identity checks, which also cover Windows.
	const flags = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const handle = await open(resultPath, constants.O_RDONLY | flags);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
			opened.size > MAX_CHECK_RESULT_BYTES) { return 'blocked'; }
		const buffer = Buffer.alloc(MAX_CHECK_RESULT_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, null);
			if (read.bytesRead === 0) { break; }
			size += read.bytesRead;
		}
		const after = await handle.stat();
		const current = await lstat(resultPath);
		if (size > MAX_CHECK_RESULT_BYTES || size !== opened.size || after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
			!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
			current.dev !== opened.dev || current.ino !== opened.ino ||
			await realpath(resultPath) !== resultPath) { return 'blocked'; }
		const bytes = buffer.subarray(0, size);
		const text = bytes.toString('utf8');
		if (!Buffer.from(text, 'utf8').equals(bytes)) { return 'blocked'; }
		const result: unknown = JSON.parse(text);
		return validateCheckResult(result, runId) ? (result as CheckResult).status : 'blocked';
	} finally {
		await handle.close();
	}
}

/** Run only an explicitly confirmed task; callers alone own all progress mutations. */
export async function runCheck(selection: Selection, storageDir: string, token: vscode.CancellationToken): Promise<'passed' | 'failed' | 'blocked'> {
	let temporary: string | undefined;
	let completion: CheckStatus = 'blocked';
	try {
		if (!vscode.workspace.isTrusted || token.isCancellationRequested ||
			(!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length)) { return 'blocked'; }
		// Clone/revalidate instead of trusting a stale tree item or caller-supplied check object.
		const manifest = validateManifest(selection.course.manifest);
		const unit = manifest.units.find(candidate => candidate.unitId === selection.unit.unitId);
		const activity = unit?.activities.find(candidate => candidate.activityId === selection.activity.activityId);
		if (!unit || !activity || !activity.check) { return 'blocked'; }
		const root = selection.course.root;
		const check = activity.check;
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
		const scope = folder ?? vscode.TaskScope.Workspace;
		const executable = await runtimeExecutable(check.runtime, folder);
		const paths = await checkedPaths(root, check);
		if (token.isCancellationRequested) { return 'blocked'; }
		const consent = await confirmCheck(
			`Course: ${JSON.stringify(manifest.title)}\nUnit: ${JSON.stringify(unit.title)}\n` +
			`Activity: ${JSON.stringify(activity.title)}\nScript: ${JSON.stringify(paths.script)}\n` +
			`Runtime: ${check.runtime} (${JSON.stringify(executable)})\nCwd: ${JSON.stringify(paths.cwd)}\n\n` +
			'This check runs arbitrary course code. It may access local files and credentials, use the network or cloud services, ' +
			'and incur charges on your bill. It is not sandboxed. Run only code you trust.', token);
		if (!consent || token.isCancellationRequested || !vscode.workspace.isTrusted) { return 'blocked'; }
		await mkdir(storageDir, { recursive: true, mode: 0o700 });
		const storage = await realpath(storageDir);
		assertTaskLiteral(storage);
		temporary = await mkdtemp(path.join(storage, 'check-'));
		const resultPath = path.join(temporary, 'result.json');
		const runId = randomUUID();
		// Recheck after the modal/storage IO, and do not run different paths/settings than consent named.
		const current = await checkedPaths(root, check);
		if (current.script !== paths.script || current.cwd !== paths.cwd ||
			await runtimeExecutable(check.runtime, folder) !== executable || token.isCancellationRequested ||
			!vscode.workspace.isTrusted || (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length)) {
			return 'blocked';
		}
		const args = check.runtime === 'pwsh'
			? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', current.script]
			: ['--', current.script];
		args.push('--result', resultPath, '--run-id', runId);
		const task = new vscode.Task({
			type: TASK_TYPE, runId, courseId: selection.course.id, unitId: unit.unitId, activityId: activity.activityId
		}, scope, `Course check ${runId}`, 'Cert Learner',
			new vscode.ProcessExecution(executable, args, { cwd: current.cwd }), []);
		task.presentationOptions = {
			reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.New, echo: false, focus: false, showReuseMessage: false
		};
		const timeout = Math.max(1, Math.min(300, check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
		const outcome = await executeCheckTask(task, timeout, token);
		if (outcome === 'blocked' || token.isCancellationRequested) { return 'blocked'; }
		const status = await readResult(temporary, resultPath, runId);
		if (token.isCancellationRequested || !vscode.workspace.isTrusted || status === 'blocked') { return 'blocked'; }
		completion = outcome.exitCode === 0 ? status : 'failed';
	} catch {
		// Never surface raw script/result/error text through progress, export, or host logging.
		return 'blocked';
	} finally {
		if (temporary) {
			try {
				await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			} catch { /* Best effort if a terminated process still holds a file. */ }
		}
	}
	// Cancellation during asynchronous cleanup must not yield a passing completion either.
	return token.isCancellationRequested || !vscode.workspace.isTrusted ? 'blocked' : completion;
}