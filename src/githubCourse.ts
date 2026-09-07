import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadCourse } from './core/course';
import { assertGitPath, buildCheckoutArgs, buildCloneArgs, buildCredentialQueryArgs, buildCredentialQueryEnvironment, buildGitEnvironment, MAX_CREDENTIAL_CONFIG_BYTES, parseCredentialConfig, parseGitHubRepository } from './core/githubCourse';
import type { CredentialSetting } from './core/githubCourse';

const GIT_HINT = 'Git could not finish. Ensure Git is installed and that you have repository access. For a private repository, sign in manually using Git/Git Credential Manager, then retry. Never paste tokens here.';
class CloneError extends Error {}

function requireTrust(): void {
	if (!vscode.workspace.isTrusted) { throw new CloneError('Cloning a course requires a trusted workspace.'); }
}

async function gitExecutable(): Promise<string> {
	requireTrust();
	let executable = 'git';
	try {
		const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
		const api = extension && (extension.isActive ? extension.exports : await extension.activate());
		executable = api?.getAPI(1).git.path || 'git';
	} catch { /* Disabled/unavailable Git extension: use the user's installed Git on PATH. */ }
	if (executable !== 'git') {
		try { assertGitPath(executable); } catch { throw new CloneError('Configure Git with a local native executable path in trusted user settings.'); }
		if (/\.(?:cmd|bat|ps1)$/iu.test(executable) || !(await stat(executable)).isFile()) { throw new CloneError(GIT_HINT); }
	}
	return executable;
}

/** Kill only this operation's process tree. The caller still awaits the Git close event. */
async function terminate(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) { return; }
	const fallback = (): void => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } };
	if (process.platform !== 'win32') {
		try { process.kill(-child.pid, 'SIGKILL'); } catch { fallback(); }
		return;
	}
	await new Promise<void>(resolve => {
		try {
			// Never run through a shell or search the cloned working tree for taskkill.
			const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
				['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
			killer.once('error', fallback);
			killer.once('close', code => { if (code !== 0) { fallback(); } resolve(); });
		} catch { fallback(); resolve(); }
	});
}

async function runGit(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, captureConfig = false): Promise<string> {
	if (signal.aborted) { throw new CloneError('Cloning cancelled.'); }
	let child: ChildProcess;
	try {
		child = spawn(executable, args, { cwd, env, shell: false, stdio: captureConfig ? ['ignore', 'pipe', 'ignore'] : 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
	} catch { throw new CloneError(GIT_HINT); }
	let failed = false;
	let bytes = 0;
	const output: Buffer[] = [];
	let termination: Promise<void> | undefined;
	const cancel = (): void => { termination ??= terminate(child); };
	const capture = (chunk: Buffer): void => {
		if (failed) { return; }
		bytes += chunk.length;
		if (bytes > MAX_CREDENTIAL_CONFIG_BYTES) { failed = true; cancel(); return; }
		output.push(chunk);
	};
	if (captureConfig) { child.stdout?.on('data', capture); }
	// Ignore raw errors and stderr, which can contain credentials or helper output.
	const closed = new Promise<number | null>(resolve => {
		child.once('error', () => { failed = true; });
		child.once('close', resolve);
	});
	const timer = captureConfig ? setTimeout(() => { failed = true; cancel(); }, 10000) : undefined;
	signal.addEventListener('abort', cancel, { once: true });
	if (signal.aborted) { cancel(); }
	try {
		const code = await closed;
		await termination;
		if (signal.aborted) { throw new CloneError('Cloning cancelled.'); }
		if (failed || code !== 0) { throw new CloneError(GIT_HINT); }
		return Buffer.concat(output, bytes).toString('utf8');
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
		signal.removeEventListener('abort', cancel);
		child.stdout?.removeListener('data', capture);
		for (const chunk of output) { chunk.fill(0); }
	}
}

/** Keep selected auth settings private, preserving original keys/order/empty resets.
 * Unreadable, oversized or malformed config yields no settings, never arbitrary live config.
 */
async function readCredentialSettings(executable: string, emptyDirectory: string, signal: AbortSignal): Promise<CredentialSetting[]> {
	try {
		const output = await runGit(executable, buildCredentialQueryArgs(emptyDirectory),
			buildCredentialQueryEnvironment(process.env, emptyDirectory), emptyDirectory, signal, true);
		return parseCredentialConfig(output);
	} catch {
		if (signal.aborted) { throw new CloneError('Cloning cancelled.'); }
		return [];
	}
}

async function cloneConfirmed(context: vscode.ExtensionContext, url: string, parent: string, destination: string): Promise<string | undefined> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Clone GitHub course', cancellable: true }, async (progress, token) => {
		const controller = new AbortController();
		let stopped = 'Cloning cancelled.';
		const cancel = (): void => { controller.abort(); };
		const subscription = token.onCancellationRequested(cancel);
		const lifetime = { dispose: cancel };
		context.subscriptions.push(lifetime);
		const timer = setTimeout(() => { stopped = 'Cloning timed out after 10 minutes.'; cancel(); }, 10 * 60 * 1000);
		if (token.isCancellationRequested) { cancel(); }
		let temporary: string | undefined;
		let created = false;
		let result: string | undefined;
		let failure: string | undefined;
		let cleanupFailed = false;
		const guard = (): void => {
			if (controller.signal.aborted) { throw new CloneError(stopped); }
			requireTrust();
		};
		try {
			guard();
			if (await realpath(parent) !== parent || !(await stat(parent)).isDirectory()) { throw new CloneError('The selected parent folder changed. Choose it again.'); }
			guard();
			try { await mkdir(destination, { mode: 0o700 }); created = true; }
			catch { throw new CloneError('Destination could not be created exclusively. Existing files or folders are never overwritten; choose a different parent folder.'); }
			const original = await lstat(destination);
			const checkDestination = async (): Promise<void> => {
				guard();
				const current = await lstat(destination);
				if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino ||
					await realpath(destination) !== destination) { throw new CloneError('The destination changed. Clone stopped to protect local files.'); }
				guard();
			};
			await checkDestination();
			assertGitPath(tmpdir());
			temporary = await mkdtemp(path.join(tmpdir(), 'cert-learner-github-'));
			const template = path.join(temporary, 'empty-template');
			const globalConfig = path.join(temporary, 'empty.gitconfig');
			await mkdir(template, { mode: 0o700 });
			await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
			const executable = await gitExecutable();
			await checkDestination();
			const authSettings = await readCredentialSettings(executable, template, controller.signal);
			await checkDestination();
			progress.report({ message: 'Fetching the default branch only (shallow clone)…' });
			await runGit(executable, buildCloneArgs(url, destination, template), buildGitEnvironment(process.env, globalConfig, authSettings), template, controller.signal);
			await checkDestination();
			progress.report({ message: 'Materializing files without hooks, filters, or submodules…' });
			await runGit(executable, buildCheckoutArgs(destination, template), buildGitEnvironment(process.env, globalConfig), template, controller.signal);
			await checkDestination();
			progress.report({ message: 'Validating the root course manifest…' });
			try {
				const manifest = path.join(destination, 'course.json');
				const info = await lstat(manifest);
				if (!info.isFile() || info.isSymbolicLink()) { throw new Error(); }
				const course = await loadCourse(manifest);
				if (course.root !== destination) { throw new Error(); }
				result = course.root;
			} catch { throw new CloneError('No valid course.json was found at the repository root. The clone is retained; use Add local course to select a course subfolder if applicable.'); }
			await checkDestination();
		} catch (error) {
			failure = error instanceof CloneError ? error.message : GIT_HINT;
		} finally {
			// Every Git process awaits close (and taskkill) before cleanup. NEVER remove destination.
			if (temporary) {
				try { await rm(temporary, { recursive: true, force: true }); } catch { cleanupFailed = true; }
			}
			clearTimeout(timer);
			subscription.dispose();
			const index = context.subscriptions.indexOf(lifetime);
			if (index >= 0) { context.subscriptions.splice(index, 1); }
		}
		if (controller.signal.aborted) { failure = stopped; }
		if (!vscode.workspace.isTrusted) { failure = 'Cloning a course requires a trusted workspace.'; }
		if (failure) {
			await vscode.window.showWarningMessage(`${failure}${created ? `\n\nThe clone destination remains (possibly partial) and was not registered:\n${destination}` : ''}`);
		} else if (cleanupFailed) {
			await vscode.window.showWarningMessage('The course was validated, but its temporary Git safety directory could not be removed.');
		}
		return failure ? undefined : result;
	});
}

/** Caller registers the returned root; this function never executes course code or opens a workspace. */
export async function cloneGitHubCourse(context: vscode.ExtensionContext): Promise<string | undefined> {
	try {
		requireTrust();
		const input = await vscode.window.showInputBox({
			title: 'Add Course from GitHub', placeHolder: 'https://github.com/owner/repo',
			prompt: 'Repository URL, not a file or folder link. This version clones the default branch only. Do not enter credentials.',
			ignoreFocusOut: true,
			validateInput: value => { try { parseGitHubRepository(value); return undefined; } catch { return 'Use https://github.com/owner/repo, not a file, tree, or branch link. No credentials or URL parameters.'; } }
		});
		if (input === undefined) { return undefined; }
		let repository;
		try { repository = parseGitHubRepository(input); } catch { throw new CloneError('Enter an HTTPS GitHub repository URL, not a file, tree, or branch link. Do not include credentials or URL parameters.'); }
		requireTrust();
		const selected = await vscode.window.showOpenDialog({ title: 'Choose an existing local parent folder', canSelectFolders: true,
			canSelectFiles: false, canSelectMany: false, openLabel: 'Select parent folder' });
		if (!selected?.length) { return undefined; }
		if (selected.length !== 1 || selected[0].scheme !== 'file' || selected[0].authority) { throw new CloneError('Choose an existing local parent folder. Remote and network folders are not supported.'); }
		let parent: string;
		try {
			assertGitPath(selected[0].fsPath);
			parent = await realpath(selected[0].fsPath);
			assertGitPath(parent);
			if (!(await stat(parent)).isDirectory()) { throw new Error(); }
		} catch { throw new CloneError('Choose an existing local parent folder with a literal path, without environment/task variables.'); }
		const destination = path.join(parent, repository.repo);
		assertGitPath(destination);
		requireTrust();
		const answer = await vscode.window.showInformationMessage('Clone this GitHub course?', { modal: true,
			detail: `Repository: ${repository.url}\nExact destination: ${destination}\n\nDefault branch only, shallow clone. Existing destinations are refused. No fetched code, hooks, filters, submodules, or requirements are run. Only selected authentication settings (credential helper, useHttpPath, and username, including URL-scoped settings) from system/global Git configuration are used for cloning. Git applies URL scoping. Your trusted user-installed Git credential helpers may run for authentication (including shell helpers). These authentication settings are not used for checkout; other system/global Git settings are not used for cloning or checkout. Failed/cancelled clones remain unregistered for manual review.`
		}, 'Clone course');
		if (answer !== 'Clone course') { return undefined; }
		requireTrust();
		return await cloneConfirmed(context, repository.url, parent, destination);
	} catch (error) {
		await vscode.window.showWarningMessage(error instanceof CloneError ? error.message : GIT_HINT);
		return undefined;
	}
}