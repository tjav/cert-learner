import * as path from 'node:path';

export interface GitHubRepository { owner: string; repo: string; url: string }

export interface CredentialSetting { readonly key: string; readonly value: string }
export const MAX_CREDENTIAL_CONFIG_BYTES = 64 * 1024;
// Git lowercases section/field names, not URL subsections. Do not broaden to credential.*.
const CREDENTIAL_CONFIG_PATTERN = '^credential(\\..*)?\\.(helper|usehttppath|username)$';

function assertCredentialSettings(settings: readonly CredentialSetting[]): void {
	let bytes = 0;
	for (const setting of settings) {
		if (!setting || typeof setting.key !== 'string' || typeof setting.value !== 'string' ||
			/[\u0000\n]/u.test(setting.key) || !new RegExp(CREDENTIAL_CONFIG_PATTERN, 'u').test(setting.key) ||
			setting.value.includes('\0')) {
			throw new Error('Invalid selected Git authentication settings.');
		}
		bytes += Buffer.byteLength(setting.key, 'utf8') + Buffer.byteLength(setting.value, 'utf8') + 2;
		if (bytes > MAX_CREDENTIAL_CONFIG_BYTES) { throw new Error('Selected Git authentication settings exceed the size limit.'); }
	}
}

/** Parse only the selected config records (name LF value NUL). Split at the first LF so
 * shell helpers retain newlines. Reject the whole result on malformed/unselected data.
 * Preserve Git's original keys, ordering and empty resets; Git itself performs URL scoping.
 */
export function parseCredentialConfig(output: string): CredentialSetting[] {
	if (!output.endsWith('\0') || Buffer.byteLength(output, 'utf8') > MAX_CREDENTIAL_CONFIG_BYTES) { return []; }
	const settings: CredentialSetting[] = [];
	for (const record of output.slice(0, -1).split('\0')) {
		const separator = record.indexOf('\n');
		if (separator <= 0) { return []; }
		settings.push({ key: record.slice(0, separator), value: record.slice(separator + 1) });
	}
	try { assertCredentialSettings(settings); } catch { return []; }
	return settings;
}

/** Deliberately parse the spelling, not URL's normalization of traversal/ports. */
export function parseGitHubRepository(input: string): GitHubRepository {
	const match = typeof input === 'string' && input.length <= 512 && !/[^\u0021-\u007e]/u.test(input)
		? /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_][a-z0-9_.-]{0,103})\/?$/iu.exec(input)
		: null;
	const repo = match?.[2].replace(/\.git$/iu, '');
	if (!match || match[0] !== input || !repo || repo.length > 100 || repo.endsWith('.') || repo.includes('..') ||
		/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(repo)) {
		throw new Error('Enter an HTTPS GitHub repository URL: https://github.com/owner/repo (not a file, tree, or branch link).');
	}
	return { owner: match[1], repo, url: `https://github.com/${match[1]}/${repo}.git` };
}

/** Local absolute literals only; no expansion syntax, controls, UNC or dot segments. */
export function assertGitPath(value: string): void {
	if (typeof value !== 'string' || !value || value.length > 4096 || !path.isAbsolute(value) ||
		value.trim() !== value || /^[\\/]{2}/u.test(value) ||
		/[\u0000-\u001f\u007f\u2028\u2029$%`"<>|?*]/u.test(value) ||
		value.split(/[\\/]/u).some(segment => segment === '.' || segment === '..') ||
		(process.platform === 'win32' && (!/^[a-z]:[\\/]/iu.test(value) || value.slice(2).includes(':'))) ||
		(process.platform !== 'win32' && value.includes('\\'))) {
		throw new Error('Choose a local absolute path without control characters, traversal, or environment/task variables.');
	}
}

function safetyArgs(emptyTemplate: string): string[] {
	assertGitPath(emptyTemplate);
	return ['-c', `core.hooksPath=${emptyTemplate}`, '-c', 'core.fsmonitor=false',
		'-c', 'hook.reference-transaction.enabled=false',
		'-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
		'-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
		'-c', 'trace2.normalTarget=0', '-c', 'trace2.eventTarget=0', '-c', 'trace2.perfTarget=0',
		'-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
		'-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];
}

/** Query only helper/useHttpPath/username, generic and URL-scoped, in config order.
 * Never query password, tokens, HTTP headers, or other potentially secret config fields.
 * No repository discovery is allowed by buildCredentialQueryEnvironment; no helpers run here.
 */
export function buildCredentialQueryArgs(emptyDirectory: string): string[] {
	return [...safetyArgs(emptyDirectory), 'config', '--null', '--get-regexp', CREDENTIAL_CONFIG_PATTERN];
}

export function buildCloneArgs(repoUrl: string, destination: string, emptyTemplate: string): string[] {
	const repository = parseGitHubRepository(repoUrl);
	assertGitPath(destination);
	return [...safetyArgs(emptyTemplate), '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'core.askPass=',
		'clone', '--depth=1', '--single-branch', '--no-tags', '--no-checkout', '--no-recurse-submodules',
		`--template=${emptyTemplate}`, '--', repository.url, destination];
}

export function buildCheckoutArgs(destination: string, emptyTemplate: string): string[] {
	assertGitPath(destination);
	return ['-C', destination, ...safetyArgs(emptyTemplate), '-c', 'core.symlinks=false', 'reset', '--hard', 'HEAD'];
}

/** Remove ALL inherited Git overrides, including mixed-case Windows spellings and tracing.
 * PATH/HOME and the normal OS environment remain available to installed Git/auth helpers.
 */
function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (!/^(?:GIT_|GCM_|VSCODE_GIT_|SSH_ASKPASS|LD_|DYLD_)/iu.test(key) &&
			!/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|CDPATH)$/iu.test(key)) { env[key] = value; }
	}
	env.GIT_TERMINAL_PROMPT = '0';
	env.GCM_INTERACTIVE = 'Never';
	env.GIT_LFS_SKIP_SMUDGE = '1';
	// Removing inherited tracing is insufficient: system/global trace2 targets can enable it.
	for (const key of ['GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_TRACE_CURL', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) {
		env[key] = '0';
	}
	env.GIT_TRACE2_CONFIG_PARAMS = '';
	env.GIT_TRACE2_ENV_VARS = '';
	env.GIT_ATTR_NOSYSTEM = '1';
	return env;
}

/** Only for a local config query from a newly created empty directory, never a network command.
 * Normal system/global config (including their includes) is read; enclosing repositories are not.
 */
export function buildCredentialQueryEnvironment(source: NodeJS.ProcessEnv, emptyDirectory: string): NodeJS.ProcessEnv {
	assertGitPath(emptyDirectory);
	return { ...sanitizedEnvironment(source), GIT_CEILING_DIRECTORIES: path.dirname(emptyDirectory) };
}

/** Both network and checkout ignore system/global config. Only validated selected auth settings
 * enter clone's process environment: never argv or an on-disk config. Omit them for checkout.
 */
export function buildGitEnvironment(source: NodeJS.ProcessEnv, emptyGlobalConfig: string, credentialSettings: readonly CredentialSetting[] = []): NodeJS.ProcessEnv {
	assertGitPath(emptyGlobalConfig);
	assertCredentialSettings(credentialSettings);
	const env: NodeJS.ProcessEnv = { ...sanitizedEnvironment(source), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobalConfig };
	if (credentialSettings.length) {
		env.GIT_CONFIG_COUNT = String(credentialSettings.length);
		credentialSettings.forEach(({ key, value }, index) => {
			env[`GIT_CONFIG_KEY_${index}`] = key;
			env[`GIT_CONFIG_VALUE_${index}`] = value;
		});
	}
	return env;
}