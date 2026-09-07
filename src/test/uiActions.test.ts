import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext, runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type * as vscode from 'vscode';
import { loadCourse } from '../core/course';
import type { Course, CourseManifest } from '../core/course';
import { getCoursePages } from '../core/pages';
import type { CoursePageSelection } from '../core/pages';
import type { Progress } from '../core/progress';
import type { ActivityPanel } from '../ui/panel';
import type { CoursePagePanel } from '../ui/coursePage';
import type { Selection } from '../ui/tree';

const TOOLS = ['portal-walkthrough', 'revert-unit'] as const;
type Receiver = (message: unknown) => void;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

// Event draining, not a timing assumption about filesystem work. Accepted actions
// are awaited via the real panel's actionFinished message instead.
const drain = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

function subscribe<T>(listeners: Set<T>, listener: T): vscode.Disposable {
	listeners.add(listener);
	return { dispose: () => { listeners.delete(listener); } };
}

interface UriValue { fsPath: string; toString(): string }
const uri = (fsPath: string): UriValue => ({ fsPath, toString: () => pathToFileURL(fsPath).href });

class CapturedPanel {
	readonly receivers = new Set<Receiver>();
	readonly disposals = new Set<() => void>();
	readonly posted: unknown[] = [];
	viewColumn = 1;
	disposed = false;
	reveals = 0;
	private finished: ReturnType<typeof deferred<void>> | undefined;
	readonly webview = {
		html: '', cspSource: 'https://webview.invalid',
		asWebviewUri: (value: UriValue) => value,
		onDidReceiveMessage: (listener: Receiver) => subscribe(this.receivers, listener),
		postMessage: async (message: unknown) => {
			assert.equal(this.disposed, false, 'No messages may be posted to a disposed webview');
			this.posted.push(message);
			const pending = this.finished;
			this.finished = undefined;
			pending?.resolve();
			return true;
		}
	};

	constructor(readonly viewType: string, public title: string, readonly options: Record<string, unknown>) {}
	onDidDispose(listener: () => void): vscode.Disposable { return subscribe(this.disposals, listener); }
	reveal(): void { this.reveals++; }
	receive(message: unknown): void { for (const listener of this.receivers) { listener(message); } }
	get renderId(): string {
		const match = /<body\b[^>]*\bdata-render-id="([^"]+)"/u.exec(this.webview.html);
		assert.ok(match, 'Use the render ID from the actual rendered HTML body');
		return match[1];
	}
	async dispatch(action: string, fields: Record<string, unknown> = {}): Promise<void> {
		assert.equal(this.finished, undefined, 'The previous accepted action must finish first');
		const pending = deferred<void>();
		this.finished = pending;
		const renderId = this.renderId;
		this.receive({ action, renderId, ...fields });
		await pending.promise;
		assert.deepEqual(this.posted.at(-1), { type: 'actionFinished', renderId });
		await drain();
	}
	async ignore(message: unknown): Promise<void> {
		const count = this.posted.length;
		this.receive(message);
		await drain();
		assert.equal(this.posted.length, count, 'Rejected envelopes must not start an action');
	}
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const listener of [...this.disposals]) { listener(); }
	}
}

class HostMock {
	readonly panels: CapturedPanel[] = [];
	readonly errors: string[] = [];
	readonly external: string[] = [];
	readonly trustListeners = new Set<() => void>();
	readonly confirmations: { message: string; options: { modal: boolean; detail: string }; buttons: string[] }[] = [];
	confirm: (buttons: string[]) => Promise<string | undefined> = async buttons => buttons[0];
	readonly workspace = {
		isTrusted: true,
		onDidGrantWorkspaceTrust: (listener: () => void) => subscribe(this.trustListeners, listener)
	};
	readonly api = {
		workspace: this.workspace,
		ViewColumn: { One: 1 },
		Uri: {
			file: uri,
			joinPath: (base: UriValue, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)),
			parse: (value: string) => ({ fsPath: '', toString: () => new URL(value).href })
		},
		window: {
			createWebviewPanel: (viewType: string, title: string, _column: number, options: Record<string, unknown>) => {
				const panel = new CapturedPanel(viewType, title, options);
				this.panels.push(panel);
				return panel;
			},
			showErrorMessage: async (message: string) => { this.errors.push(message); },
			showInformationMessage: async (message: string, options: { modal: boolean; detail: string }, ...buttons: string[]) => {
				this.confirmations.push({ message, options, buttons });
				return this.confirm(buttons);
			}
		},
		env: { openExternal: async (value: UriValue) => { this.external.push(value.toString()); return true; } }
	};
	get latest(): CapturedPanel { assert.ok(this.panels.length); return this.panels[this.panels.length - 1]; }
	expectError(pattern: RegExp): void {
		assert.equal(this.errors.length, 1, 'Exactly one handled error, with no late or unrelated errors');
		assert.match(this.errors.shift()!, pattern);
	}
}

/** Execute tsc's actual CommonJS output with only its vscode import replaced.
 * The wrapper shares JS intrinsics with incoming messages (including plain-object
 * checks). No Module._load, global, or require.cache mutation needs restoring;
 * each test gets fresh panel classes and the real filesystem/core/renderer code.
 */
function loadPanel<T>(file: string, host: HostMock): T {
	const filename = path.join(__dirname, '..', 'ui', file);
	assert.equal(path.extname(__filename), '.js', 'Run this suite from compile-tests output');
	const requireFromFile = createRequire(filename);
	const module: { exports: Record<string, unknown> } = { exports: {} };
	const execute = runInThisContext(`(function (exports, require, module, __filename, __dirname) {\n${readFileSync(filename, 'utf8')}\n})`,
		{ filename }) as (exports: object, require: (id: string) => unknown, module: object, filename: string, dirname: string) => void;
	execute(module.exports, id => id === 'vscode' ? host.api : requireFromFile(id), module, filename, path.dirname(filename));
	return module.exports as T;
}

function selection(course: Course, index = 0): Selection {
	const unit = course.manifest.units[0];
	return { course, unit, activity: unit.activities[index] };
}

function progress(course: Course): Progress {
	return { schemaVersion: 1, courseId: course.id, contentVersion: course.manifest.contentVersion, revision: 0, completions: {} };
}

function button(panel: CapturedPanel, action: string): string {
	const found = [...panel.webview.html.matchAll(/<button\b[^>]*>/gu)].find(match => match[0].includes(`data-action="${action}"`));
	assert.ok(found, `Actual HTML includes the ${action} button`);
	return found[0];
}

function assertEnabled(panel: CapturedPanel, action: string, enabled: boolean): void {
	assert.equal(/\sdisabled(?:\s|>)/u.test(button(panel, action)), !enabled, `${action} enabled=${enabled}`);
}

describe('UI actions: compiled panels with only the VS Code boundary mocked', function () {
	this.timeout(15_000);
	let temporary: string;
	let host: HostMock;
	let activity: ActivityPanel;
	let page: CoursePagePanel;
	let calls: { action: string; selection: Selection }[];
	let sources: CoursePageSelection[];
	let act: (action: string, selected: Selection) => Promise<void>;

	beforeEach(async () => {
		temporary = await mkdtemp(path.join(tmpdir(), 'cert-learner-ui-actions-'));
		host = new HostMock();
		calls = [];
		sources = [];
		act = async (action, selected) => { calls.push({ action, selection: selected }); };
		const context = { extensionUri: uri(path.resolve(__dirname, '../../..')) } as unknown as vscode.ExtensionContext;
		const activityModule = loadPanel<typeof import('../ui/panel')>('panel.js', host);
		const pageModule = loadPanel<typeof import('../ui/coursePage')>('coursePage.js', host);
		activity = new activityModule.ActivityPanel(context, (action, selected) => act(action, selected));
		page = new pageModule.CoursePagePanel(context, async selected => { sources.push(selected); });
	});

	afterEach(async () => {
		try {
			activity?.dispose();
			page?.dispose();
			await drain();
			assert.deepEqual(host.errors, [], 'All asynchronous errors must be asserted, not silently swallowed');
			assert.equal(host.trustListeners.size, 0);
			for (const panel of host.panels) {
				assert.equal(panel.receivers.size, 0, 'Message subscription disposed');
				assert.equal(panel.disposals.size, 0, 'Panel lifecycle subscription disposed');
			}
		} finally { await rm(temporary, { recursive: true, force: true }); }
	});

	async function fixture(name = 'first'): Promise<Course> {
		const root = path.join(temporary, `${name} course`);
		await mkdir(path.join(root, '.github', 'prompts'), { recursive: true });
		const manifest: CourseManifest = {
			format: 'cert-learner', schemaVersion: 1, contentVersion: '1.0', courseId: 'same-portable-id', title: `${name} course`,
			overview: 'overview.md', resources: [
				{ title: `${name} summary`, path: 'summary.md' },
				{ title: `${name} cheatsheet`, path: 'cheatsheet.md' },
				{ title: `${name} teardown`, path: 'teardown.md' }
			],
			units: [{
				unitId: `${name}-unit`, displayNumber: '03B', title: `${name} unit`, resources: { lesson: 'lesson.md' },
				activities: [
					{ activityId: 'read', title: `${name} reading`, objectives: ['Read locally'], completion: 'manual' },
					{ activityId: 'verify', title: `${name} check`, objectives: [], completion: 'check',
						check: { runtime: 'node', file: 'check.cjs', cwd: '.', timeoutSeconds: 10 } }
				]
			}]
		};
		await Promise.all([
			writeFile(path.join(root, 'course.json'), JSON.stringify(manifest)),
			writeFile(path.join(root, 'check.cjs'), 'throw new Error("CHECK_MUST_NOT_RUN");'),
			...['lesson', 'overview', 'summary', 'cheatsheet', 'teardown'].map(name =>
				writeFile(path.join(root, `${name}.md`), `# ${name} fixture content\n[Reference](https://example.com/guide)`)),
			...TOOLS.map(tool => writeFile(path.join(root, '.github', 'prompts', `${tool}.prompt.md`), `# ${tool} draft`))
		]);
		return loadCourse(path.join(root, 'course.json'));
	}

	it('renders real tool buttons enabled with trusted, regular prompts, without changing fresh progress', async () => {
		const course = await fixture();
		const state = progress(course);
		const before = JSON.stringify(state);
		await activity.show(selection(course), state);
		const panel = host.latest;
		assert.equal(panel.viewType, 'certLearner.activity');
		assert.equal(panel.options.enableScripts, true);
		assert.equal(panel.options.enableCommandUris, false);
		assert.equal(panel.options.enableForms, false);
		for (const tool of TOOLS) { assertEnabled(panel, tool, true); }
		assert.match(panel.webview.html, /open a DRAFT in general Agent mode/u);
		assert.match(panel.webview.html, /lesson fixture content/u);
		assertEnabled(panel, 'complete', true);
		assertEnabled(panel, 'check', false);
		await activity.show(selection(course, 1), state);
		assert.equal(host.latest, panel, 'Rerenders reuse one panel');
		assertEnabled(panel, 'complete', false);
		assertEnabled(panel, 'check', true);
		assert.equal(JSON.stringify(state), before);
		assert.deepEqual(calls, []);
	});

	it('dispatches both tools with the canonical snapshot for each root, not caller-forged activity metadata', async () => {
		const courses = [await fixture(), await fixture('second')];
		assert.notEqual(courses[0].id, courses[1].id);
		for (const course of courses) {
			const chosen = selection(course);
			const state = progress(course);
			const before = JSON.stringify(state);
			await activity.show({ course,
				unit: { ...chosen.unit, title: 'FORGED_UNIT', resources: { lesson: '.env' } },
				activity: { ...chosen.activity, title: 'FORGED_ACTIVITY', objectives: ['FORGED_OBJECTIVE'] }
			}, state);
			for (const tool of TOOLS) {
				await host.latest.dispatch(tool);
				assert.deepEqual(calls.at(-1), { action: tool, selection: chosen });
				assert.equal(calls.at(-1)!.selection.unit, chosen.unit);
				assert.equal(calls.at(-1)!.selection.activity, chosen.activity);
			}
			assert.equal(JSON.stringify(state), before);
		}
		assert.equal(calls.length, 4);
		assert.deepEqual(host.confirmations, [], 'Draft preparation belongs to the host callback, not the panel');
	});

	it('disables missing prompts independently and rechecks a prompt removed after rendering', async () => {
		const course = await fixture();
		await rm(path.join(course.root, '.github', 'prompts', 'portal-walkthrough.prompt.md'));
		await activity.show(selection(course), progress(course));
		assertEnabled(host.latest, TOOLS[0], false);
		assertEnabled(host.latest, TOOLS[1], true);
		await host.latest.dispatch(TOOLS[0]);
		host.expectError(/does not provide.*Portal walkthrough/u);
		await rm(path.join(course.root, '.github', 'prompts', 'revert-unit.prompt.md'));
		await host.latest.dispatch(TOOLS[1]);
		host.expectError(/does not provide.*Revert unit/u);
		await activity.show(selection(course), progress(course));
		for (const tool of TOOLS) { assertEnabled(host.latest, tool, false); }
		assert.deepEqual(calls, []);
	});

	it('disables tools in restricted mode and rejects a trust change after enabled buttons were rendered', async () => {
		const course = await fixture();
		host.workspace.isTrusted = false;
		await activity.show(selection(course), progress(course));
		assert.match(host.latest.webview.html, /Restricted Mode/u);
		for (const tool of TOOLS) { assertEnabled(host.latest, tool, false); }
		host.workspace.isTrusted = true;
		await activity.show(selection(course), progress(course));
		for (const tool of TOOLS) { assertEnabled(host.latest, tool, true); }
		host.workspace.isTrusted = false;
		for (const tool of TOOLS) {
			await host.latest.dispatch(tool);
			host.expectError(/requires a trusted workspace/u);
		}
		assert.deepEqual(calls, []);
		host.workspace.isTrusted = true;
		await host.latest.dispatch(TOOLS[0]);
		assert.equal(calls.length, 1, 'Denied actions release the busy state');
	});

	it('ignores forged/stale render IDs, extra fields and source messages, then still accepts valid tools', async () => {
		const first = await fixture();
		const second = await fixture('second');
		await activity.show(selection(first), progress(first));
		const staleId = host.latest.renderId;
		await activity.show(selection(second), progress(second));
		const panel = host.latest;
		const renderId = panel.renderId;
		assert.notEqual(renderId, staleId);
		for (const tool of TOOLS) {
			for (const message of [
				null, [], { action: tool }, { action: tool, renderId: 'forged' }, { action: tool, renderId: staleId },
				...['path', 'selection', 'course', 'command', 'href'].map(key => ({ action: tool, renderId, [key]: '.env' }))
			]) { await panel.ignore(message); }
		}
		await panel.ignore({ action: 'source', renderId });
		assert.deepEqual(calls, []);
		assert.deepEqual(host.errors, []);
		for (const tool of TOOLS) {
			await panel.dispatch(tool);
			assert.deepEqual(calls.at(-1), { action: tool, selection: selection(second) });
		}
		assert.equal(calls.length, 2);
	});

	it('awaits the host callback, suppresses duplicate actions while busy, and recovers from callback errors', async () => {
		const course = await fixture();
		const started = deferred<void>();
		const release = deferred<void>();
		act = async (action, selected) => {
			calls.push({ action, selection: selected });
			started.resolve();
			await release.promise;
		};
		await activity.show(selection(course), progress(course));
		const panel = host.latest;
		const finished = panel.dispatch(TOOLS[0]);
		try {
			await started.promise;
			await panel.ignore({ action: TOOLS[1], renderId: panel.renderId });
			assert.equal(calls.length, 1);
			assert.deepEqual(panel.posted, [], 'No premature actionFinished');
		} finally { release.resolve(); await finished; }
		act = async () => { throw new Error('EXPECTED_CALLBACK_FAILURE'); };
		await panel.dispatch(TOOLS[1]);
		host.expectError(/EXPECTED_CALLBACK_FAILURE/u);
		act = async (action, selected) => { calls.push({ action, selection: selected }); };
		await panel.dispatch(TOOLS[1]);
		assert.equal(calls.length, 2);
	});

	it('renders all four actual Markdown pages with source only and dispatches canonical pages without any progress store', async () => {
		const course = await fixture();
		const pages = getCoursePages(course);
		assert.equal(pages.length, 4);
		const files = ['course.json', 'lesson.md', ...pages.map(page => page.path),
			...TOOLS.map(tool => `.github/prompts/${tool}.prompt.md`)];
		const before = await Promise.all(files.map(file => readFile(path.join(course.root, file), 'utf8')));
		let staleId = 'no-previous-page';
		for (const declared of pages) {
			await page.show({ course, page: { ...declared, title: 'FORGED_TITLE', path: '.env' } });
			const panel = host.latest;
			const renderId = panel.renderId;
			assert.equal(panel.viewType, 'certLearner.page');
			assert.equal(panel.title, declared.title);
			assert.match(panel.webview.html, /Reference page · Not tracked/u);
			assert.match(panel.webview.html, new RegExp(`${path.basename(declared.path, '.md')} fixture content`, 'u'));
			assert.doesNotMatch(panel.webview.html, /FORGED_TITLE|<progress\b|Activity \d+ of \d+/u);
			assert.deepEqual([...panel.webview.html.matchAll(/<button\b[^>]*data-action="([^"]+)"/gu)].map(match => match[1]), ['source']);
			assertEnabled(panel, 'source', true);
			for (const action of ['complete', 'reset', 'check', ...TOOLS]) { await panel.ignore({ action, renderId }); }
			await panel.ignore({ action: 'source', renderId: staleId });
			await panel.ignore({ action: 'source', renderId, path: 'lesson.md' });
			await panel.ignore({ action: 'source', renderId, href: 'https://example.com' });
			assert.equal(sources.length, pages.indexOf(declared));
			await panel.dispatch('source');
			assert.deepEqual(sources.at(-1), { course, page: declared });
			staleId = renderId;
		}
		assert.equal(host.panels.length, 1, 'All pages reuse the same read-only panel');
		assert.deepEqual(calls, []);
		assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(course.root, file), 'utf8'))), before);
	});

	it('rejects accessor/symbol-backed source messages and handles missing or undeclared pages without callbacks', async () => {
		const course = await fixture();
		const declared = getCoursePages(course)[0];
		await page.show({ course, page: declared });
		const panel = host.latest;
		const renderId = panel.renderId;
		await panel.ignore({ get action(): never { throw new Error('Must not invoke accessors'); }, renderId });
		await panel.ignore({ action: 'source', renderId, [Symbol('extra')]: 'ignored' });
		await panel.ignore(Object.assign(Object.create({ inherited: true }) as object, { action: 'source', renderId }));
		await rm(path.join(course.root, declared.path));
		await panel.dispatch('source');
		host.expectError(/ENOENT/u);
		await page.show({ course, page: declared });
		assertEnabled(panel, 'source', false);
		await panel.dispatch('source');
		host.expectError(/page is unavailable/u);
		await page.show({ course, page: { ...declared, id: 'forged' } });
		assert.match(panel.webview.html, /Course page unavailable/u);
		await panel.ignore({ action: 'source', renderId: panel.renderId });
		assert.deepEqual(sources, []);
	});

	for (const kind of ['activity', 'page'] as const) {
		it(`${kind} confirms safe links, honors cancel, rejects unsafe links and drops stale modal results`, async () => {
			const course = await fixture();
			const show = async (index: number) => kind === 'activity'
				? activity.show(selection(course, index), progress(course))
				: page.show({ course, page: getCoursePages(course)[index] });
			await show(0);
			const panel = host.latest;
			const href = 'https://example.com/guide';
			await panel.dispatch('link', { href });
			assert.deepEqual(host.external, [href]);
			assert.equal(host.confirmations[0].options.modal, true);
			assert.match(host.confirmations[0].message, /example\.com/u);
			assert.equal(host.confirmations[0].options.detail.includes(href), true);
			assert.deepEqual(host.confirmations[0].buttons, ['Open website']);
			host.confirm = async () => undefined;
			await panel.dispatch('link', { href });
			assert.equal(host.external.length, 1);
			await panel.dispatch('link', { href: 'command:workbench.action.terminal.new' });
			host.expectError(/Only safe HTTPS/u);
			assert.equal(host.confirmations.length, 2, 'Unsafe links never reach the modal');
			const started = deferred<void>();
			const answer = deferred<string | undefined>();
			host.confirm = async () => { started.resolve(); return answer.promise; };
			panel.receive({ action: 'link', renderId: panel.renderId, href });
			try { await started.promise; await show(1); } finally { answer.resolve('Open website'); await drain(); }
			assert.equal(host.external.length, 1, 'Confirmation from a superseded render cannot open a link');
			host.confirm = async buttons => buttons[0];
			await panel.dispatch('link', { href });
			assert.equal(host.external.length, 2, 'The newer render remains usable');
		});

		it(`${kind} disposes listeners, recreates a closed panel and rejects captured messages from the old panel`, async () => {
			const course = await fixture();
			const controller = kind === 'activity' ? activity : page;
			const action = kind === 'activity' ? TOOLS[0] : 'source';
			const show = async () => kind === 'activity' ? activity.show(selection(course), progress(course))
				: page.show({ course, page: getCoursePages(course)[0] });
			await show();
			const old = host.latest;
			const [receive] = old.receivers;
			assert.ok(receive);
			old.dispose();
			assert.equal(old.receivers.size, 0);
			await show();
			const current = host.latest;
			assert.notEqual(current, old);
			receive({ action, renderId: current.renderId });
			await drain();
			assert.deepEqual(calls, []);
			assert.deepEqual(sources, []);
			await current.dispatch(action);
			assert.equal(calls.length + sources.length, 1);
			controller.dispose();
			receive({ action, renderId: old.renderId });
			await show();
			await drain();
			assert.equal(host.panels.length, 2, 'Disposed controllers never reopen');
			assert.equal(calls.length + sources.length, 1);
		});
	}
});

describe('webview media action allowlist', () => {
	it('sends both draft actions and source, ignores unknown/disabled actions and matches actionFinished to the render', () => {
		class Element {
			disabled = false;
			constructor(readonly dataset: { action: string }) {}
			closest(selector: string): Element | null { return selector === 'button[data-action]' ? this : null; }
		}
		const buttons = [...TOOLS, 'source', 'forged', 'check'].map(action => new Element({ action }));
		buttons[4].disabled = true;
		const documentEvents = new Map<string, (event: unknown) => void>();
		const windowEvents = new Map<string, (event: unknown) => void>();
		const messages: unknown[] = [];
		const status = { textContent: '' };
		const attributes: Record<string, string> = {};
		const renderId = 'media-render';
		const source = readFileSync(path.resolve(__dirname, '../../../media/learning.js'), 'utf8');
		runInNewContext(source, {
			Element, URLSearchParams,
			MutationObserver: class { observe(): void {} },
			acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { messages.push(JSON.parse(JSON.stringify(message))); } }),
			window: {
				location: { search: '' }, matchMedia: () => ({ matches: false }),
				addEventListener: (name: string, listener: (event: unknown) => void) => { windowEvents.set(name, listener); }
			},
			document: {
				documentElement: { setAttribute: () => undefined },
				body: { dataset: { renderId }, classList: { contains: () => false } },
				querySelectorAll: (selector: string) => selector === 'button[data-action]' ? buttons : [],
				querySelector: () => ({ setAttribute: (name: string, value: string) => { attributes[name] = value; } }),
				getElementById: (id: string) => id === 'action-status' ? status : undefined,
				addEventListener: (name: string, listener: (event: unknown) => void) => { documentEvents.set(name, listener); }
			}
		});
		const click = documentEvents.get('click');
		const receive = windowEvents.get('message');
		assert.ok(click);
		assert.ok(receive);
		for (const target of buttons.slice(0, 3)) {
			click({ target, preventDefault: () => undefined });
			assert.deepEqual(messages.at(-1), { action: target.dataset.action, renderId });
			assert.equal(status.textContent, 'Working…');
			assert.equal(attributes['aria-busy'], 'true');
			const count = messages.length;
			click({ target, preventDefault: () => undefined });
			assert.equal(messages.length, count, 'Busy clicks are not dispatched twice');
			receive({ data: { type: 'actionFinished', renderId: 'stale' } });
			assert.equal(target.disabled, true);
			receive({ data: { type: 'actionFinished', renderId } });
			assert.equal(target.disabled, false);
			assert.equal(buttons[4].disabled, true, 'Originally disabled buttons stay disabled');
			assert.equal(status.textContent, 'Ready.');
			assert.equal(attributes['aria-busy'], 'false');
		}
		for (const target of buttons.slice(3)) { click({ target, preventDefault: () => undefined }); }
		assert.equal(messages.length, 3);
	});
});