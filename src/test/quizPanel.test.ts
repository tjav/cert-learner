import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext, runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type * as vscode from 'vscode';
import { contributes } from '../../package.json';
import { loadCourse } from '../core/course';
import type { Course, CourseManifest } from '../core/course';
import type { Quiz, QuizSelection } from '../core/quiz';
import type { CertLearnerApi } from '../extension';
import type { QuizPanel } from '../ui/quizPanel';
import { renderQuizView } from '../ui/quizRender';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const drain = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
function subscribe<T>(listeners: Set<T>, listener: T): vscode.Disposable {
	listeners.add(listener);
	return { dispose: () => { listeners.delete(listener); } };
}
interface UriValue { scheme: string; fsPath: string; toString(): string }
const uri = (fsPath: string): UriValue => ({ scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).href });
const virtualUri = (): UriValue => ({
	scheme: 'agent-host-copilotcli', toString: () => 'agent-host-copilotcli:/workspace',
	get fsPath(): never { throw new Error('Virtual paths must never reach the filesystem'); }
});
type Receiver = (message: unknown) => void;

class CapturedPanel {
	readonly receivers = new Set<Receiver>();
	readonly disposals = new Set<() => void>();
	readonly posted: unknown[] = [];
	viewColumn = 1;
	disposed = false;
	private pending: ReturnType<typeof deferred<void>> | undefined;
	readonly webview = {
		html: '', cspSource: 'https://webview.invalid',
		asWebviewUri: (value: UriValue) => value,
		onDidReceiveMessage: (receiver: Receiver) => subscribe(this.receivers, receiver),
		postMessage: async (message: unknown) => {
			assert.equal(this.disposed, false);
			this.posted.push(message);
			const pending = this.pending;
			this.pending = undefined;
			pending?.resolve();
			return true;
		}
	};
	constructor(readonly viewType: string, public title: string, readonly options: Record<string, unknown>) {}
	onDidDispose(listener: () => void): vscode.Disposable { return subscribe(this.disposals, listener); }
	reveal(): void { /* No editor state is touched by the mock. */ }
	receive(message: unknown): void { for (const receiver of this.receivers) { receiver(message); } }
	get renderId(): string { return this.attribute('render-id'); }
	get questionId(): string { return this.attribute('question-id'); }
	private attribute(name: string): string {
		const match = new RegExp(`<body\\b[^>]*\\bdata-${name}="([^"]*)"`, 'u').exec(this.webview.html);
		assert.ok(match, `Actual document supplies ${name}`);
		return match[1];
	}
	message(action: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
		return { action, renderId: this.renderId, questionId: this.questionId, ...fields };
	}
	async dispatch(action: string, fields: Record<string, unknown> = {}): Promise<void> {
		assert.equal(this.pending, undefined);
		const pending = this.pending = deferred<void>();
		const renderId = this.renderId;
		this.receive(this.message(action, fields));
		await pending.promise;
		assert.deepEqual(this.posted.at(-1), { type: 'actionFinished', renderId });
		await drain();
	}
	async ignore(message: unknown): Promise<void> {
		const count = this.posted.length;
		this.receive(message);
		await drain();
		assert.equal(this.posted.length, count);
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
	readonly confirmations: { message: string; options: { modal: boolean; detail: string }; buttons: string[] }[] = [];
	confirm: (buttons: string[]) => Promise<string | undefined> = async buttons => buttons[0];
	readonly api = {
		ViewColumn: { One: 1 },
		Uri: {
			file: uri, joinPath: (base: UriValue, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)),
			parse: (value: string) => ({ fsPath: '', toString: () => new URL(value).href })
		},
		window: {
			createWebviewPanel: (type: string, title: string, _column: number, options: Record<string, unknown>) => {
				const panel = new CapturedPanel(type, title, options);
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
	expectError(pattern: RegExp): void { assert.equal(this.errors.length, 1); assert.match(this.errors.shift()!, pattern); }
}

/** Real compiled panel + real renderer, loader, grader, and filesystem. Only vscode is mocked. */
function loadPanel(host: HostMock): typeof import('../ui/quizPanel') {
	return loadModule('../ui/quizPanel.js', { vscode: host.api }) as typeof import('../ui/quizPanel');
}

function loadModule(file: string, replacements: Record<string, unknown>): unknown {
	assert.equal(path.extname(__filename), '.js', 'Run this suite from compile-tests output');
	const filename = path.resolve(__dirname, file);
	const requireFromFile = createRequire(filename);
	const module: { exports: Record<string, unknown> } = { exports: {} };
	const execute = runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${readFileSync(filename, 'utf8')}\n})`, { filename }) as
		(exports: object, require: (id: string) => unknown, module: object, filename: string, dirname: string) => void;
	execute(module.exports, id => Object.hasOwn(replacements, id) ? replacements[id] : requireFromFile(id), module, filename, path.dirname(filename));
	return module.exports;
}

function quiz(): Quiz {
	return { schemaVersion: 1, title: 'Local knowledge check', questions: [
		{ id: '1', prompt: 'Which is correct? [Reference](https://example.com/guide?a=1&b=2)',
			options: [{ id: 'A', text: '**First choice**' }, { id: 'B', text: 'Second choice' }, { id: 'C', text: 'Third choice' }],
			correctOptionIds: ['A'], explanation: 'SECRET_EXPLANATION_ONE **Full authored explanation.** [Answer reference](https://example.com/answer)' },
		{ id: '2', prompt: 'Choose two correct options. HIDDEN_QUESTION_TWO',
			options: [{ id: 'A', text: 'Alpha' }, { id: 'B', text: 'Bravo' }, { id: 'C', text: 'Charlie' }],
			correctOptionIds: ['A', 'C'], explanation: 'SECRET_EXPLANATION_TWO All authored details remain here.' }
	] };
}
function markdown(value = quiz()): string {
	return `# ${value.title}\n\n${value.questions.map(question => `**${question.id}.** ${question.prompt}\n\n${question.options.map(option => `- ${option.id}. ${option.text}`).join('\n')}\n\n---`).join('\n\n')}\n\n## Answers\n\n${value.questions.map(question => `**${question.id} — ${question.correctOptionIds.join(' and ')}.** ${question.explanation}`).join('\n\n')}\n`;
}
function selection(course: Course): QuizSelection { return { course, unit: course.manifest.units[0] }; }
function score(panel: CapturedPanel, correct: number, answered: number): void {
	assert.match(panel.webview.html, new RegExp(`id="quiz-score">${correct} / ${answered}<`, 'u'));
}
function enabled(panel: CapturedPanel, action: string, value: boolean): void {
	const tag = [...panel.webview.html.matchAll(/<button\b[^>]*>/gu)].find(match => match[0].includes(`data-action="${action}"`));
	assert.ok(tag);
	assert.equal(/\sdisabled(?:\s|>)/u.test(tag[0]), !value);
}

describe('interactive quiz: actual compiled host panel', function () {
	this.timeout(15_000);
	let temporary: string;
	let host: HostMock;
	let controller: QuizPanel;
	let sources: QuizSelection[];
	let onSource: (selection: QuizSelection) => Promise<void>;
	let context: vscode.ExtensionContext;
	let extensionDisposables: vscode.Disposable[];
	beforeEach(async () => {
		temporary = await mkdtemp(path.join(tmpdir(), 'cert-learner-quiz-panel-'));
		host = new HostMock();
		extensionDisposables = [];
		sources = [];
		onSource = async selected => { sources.push(selected); };
		// Deliberately no workspaceState/globalState/storageUri: attempting persistence fails.
		context = { extensionUri: uri(path.resolve(__dirname, '../../..')) } as unknown as vscode.ExtensionContext;
		controller = new (loadPanel(host).QuizPanel)(context, selected => onSource(selected));
	});
	afterEach(async () => {
		try {
			for (const disposable of extensionDisposables) { disposable.dispose(); }
			controller?.dispose();
			await drain();
			assert.deepEqual(host.errors, [], 'All asynchronous errors must be asserted');
			for (const panel of host.panels) {
				assert.equal(panel.receivers.size, 0);
				assert.equal(panel.disposals.size, 0);
			}
		} finally { await rm(temporary, { recursive: true, force: true }); }
	});
	async function fixture(name = 'first'): Promise<Course> {
		const root = path.join(temporary, name);
		await mkdir(root);
		const manifest: CourseManifest = {
			format: 'cert-learner', schemaVersion: 1, courseId: 'portable-id', contentVersion: '1', title: `${name} course`,
			units: [{ unitId: 'unit', displayNumber: '01', title: 'Local unit', resources: { lesson: 'lesson.md', quiz: 'quiz.md' },
				activities: [{ activityId: 'read', title: 'Read', objectives: [] }] }]
		};
		await Promise.all([
			writeFile(path.join(root, 'course.json'), JSON.stringify(manifest)),
			writeFile(path.join(root, 'quiz.md'), markdown()), writeFile(path.join(root, 'lesson.md'), 'DO_NOT_READ_LESSON'),
			writeFile(path.join(root, 'progress.json'), '{"current":"unchanged","completion":false}')
		]);
		return loadCourse(path.join(root, 'course.json'));
	}
	async function show(course?: Course): Promise<CapturedPanel> {
		const selectedCourse = course ?? await fixture();
		await controller.show(selection(selectedCourse));
		return host.latest;
	}
	async function submit(panel: CapturedPanel, selectedIds: string[]): Promise<void> { await panel.dispatch('submit', { selectedIds }); }

	/** Real parent registry, queue, progress store, and quiz panel. Unrelated activity
	 * UI/check/GitHub adapters are inert; no global require cache or VS Code patching.
	 */
	async function parent(course: Course, options: { folders?: UriValue[]; storage?: UriValue; failCommand?: string } = {}) {
		const commands = new Map<string, (input?: unknown) => Promise<unknown>>();
		const picks: { choices: { id?: string; unitId?: string }[]; title: string }[] = [];
		let pick: (choices: { id?: string; unitId?: string }[]) => Promise<unknown> = async choices => choices[0];
		let openDocument: (value: UriValue) => Promise<UriValue> = async value => value;
		let failCommand = options.failCommand;
		const documents: string[] = [];
		const effects: string[] = [];
		const folderListeners = new Set<() => void>();
		const watchers = new Set<object>();
		const outputs = new Set<object>();
		const views: { disposed: boolean; message?: string; provider: vscode.TreeDataProvider<vscode.TreeItem> }[] = [];
		const actions: ((action: string, selected: unknown) => Promise<unknown>)[] = [];
		const stateAccess: string[] = [];
		const noop = () => ({ dispose: () => undefined });
		const editor = {
			...host.api,
			UIKind: { Desktop: 1, Web: 2 },
			TreeItemCollapsibleState: { None: 0 },
			TreeItem: class { constructor(readonly label: string, readonly collapsibleState: number) {} },
			commands: { registerCommand: (id: string, callback: (input?: unknown) => Promise<unknown>) => {
				if (failCommand === id) { failCommand = undefined; throw new Error('EXPECTED_REGISTRATION_FAILURE'); }
				assert.equal(commands.has(id), false, `No overlapping command registrations: ${id}`);
				commands.set(id, callback); return { dispose: () => commands.delete(id) };
			}, executeCommand: async (id: string) => { effects.push(id); } },
			workspace: {
				workspaceFolders: (options.folders ?? []).map(uri => ({ uri })), isTrusted: false,
				onDidChangeWorkspaceFolders: (listener: () => void) => subscribe(folderListeners, listener),
				createFileSystemWatcher: () => {
					const watcher = { dispose: () => { watchers.delete(watcher); }, onDidCreate: noop, onDidChange: noop, onDidDelete: noop };
					watchers.add(watcher); return watcher;
				},
				openTextDocument: (value: UriValue) => openDocument(value),
				openNotebookDocument: async () => { effects.push('openNotebookDocument'); throw new Error('Unexpected notebook access'); }
			},
			RelativePattern: class {},
			window: { ...host.api.window,
				createOutputChannel: () => {
					const output = { appendLine: () => undefined, dispose: () => { outputs.delete(output); } };
					outputs.add(output); return output;
				},
				createTreeView: (_id: string, options: { treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem> }) => {
					assert.equal(views.some(view => !view.disposed), false, 'Retire the old tree before creating the next');
					const view = { disposed: false, provider: options.treeDataProvider, dispose: () => { view.disposed = true; } };
					views.push(view); return view;
				},
				showOpenDialog: async () => { effects.push('showOpenDialog'); return undefined; },
				showWarningMessage: host.api.window.showInformationMessage,
				showTextDocument: async (value: UriValue) => { documents.push(value.fsPath); },
				showQuickPick: async (choices: { id?: string; unitId?: string }[], options: { title: string }) => {
					picks.push({ choices, title: options.title }); return pick(choices);
				}
			}
		};
		class InertPanel { async show(): Promise<void> {} dispose(): void {} }
		const module = loadModule('../extension.js', {
			vscode: editor, './ui/quizPanel': loadPanel(host),
			'./unsupportedWorkspace': loadModule('../unsupportedWorkspace.js', { vscode: editor }),
			'./ui/panel': { ActivityPanel: class extends InertPanel {
				constructor(_context: unknown, action: (action: string, selected: unknown) => Promise<unknown>) { super(); actions.push(action); }
			} }, './ui/coursePage': { CoursePagePanel: InertPanel },
			'./ui/tree': { CourseTree: class { setCourses(): void {} refresh(): void {} dispose(): void {} } },
			'./runner': { runCheck: async () => { effects.push('runCheck'); } },
			'./githubCourse': { cloneGitHubCourse: async () => { effects.push('cloneGitHubCourse'); } }
		}) as typeof import('../extension');
		const values = new Map<string, unknown>([['coursePaths', [path.join(course.root, 'course.json')]]]);
		const activationContext = {
			...context, storageUri: options.storage ?? uri(path.join(temporary, 'state')), subscriptions: extensionDisposables,
			workspaceState: { get: (key: string, fallback: unknown) => { stateAccess.push(`get:${key}`); return values.get(key) ?? fallback; },
				update: async (key: string, value: unknown) => { stateAccess.push(`update:${key}`); values.set(key, value); } }
		};
		const api: CertLearnerApi = await module.activate(activationContext as unknown as vscode.ExtensionContext);
		return { api, commands, picks, documents, effects, folderListeners, watchers, outputs, views, actions, stateAccess, values,
			deactivate: () => module.deactivate(),
			changeFolders: (...folders: UriValue[]) => {
				editor.workspace.workspaceFolders = folders.map(uri => ({ uri }));
				for (const listener of [...folderListeners]) { listener(); }
			},
			setStorage: (storage: UriValue) => { activationContext.storageUri = storage; },
			failNextCommand: (id: string) => { failCommand = id; },
			setPick: (callback: typeof pick) => { pick = callback; },
			setOpenDocument: (callback: typeof openDocument) => { openDocument = callback; },
			unregister: () => { values.set('coursePaths', []); }
		};
	}

	async function savedFiles(): Promise<[string, string][]> {
		const files = await readdir(temporary, { recursive: true, withFileTypes: true });
		const entries = await Promise.all(files.filter(entry => entry.isFile()).map(async entry => {
			const file = path.join(entry.parentPath, entry.name);
			return [path.relative(temporary, file), await readFile(file, 'utf8')] as [string, string];
		}));
		return entries.sort(([a], [b]) => a.localeCompare(b));
	}

	it('folder removal retires learning before recovery, fencing queued mutations, old handlers and pending quiz dialogs', async () => {
		const course = await fixture();
		const second = await fixture('second');
		const virtual = virtualUri();
		const owner = await parent(course, { folders: [virtual, uri(course.root)] });
		const { api, commands, changeFolders } = owner;
		const ids = { courseId: course.id, unitId: 'unit', activityId: 'read' };
		await commands.get('certLearner.open')!(ids);
		const selected = { course, unit: course.manifest.units[0], activity: course.manifest.units[0].activities[0] };
		await owner.actions[0]('complete', selected);
		await api.openUnitResource(ids, 'quiz');
		const panel = host.latest;
		await submit(panel, ['A']);
		const state = await api.getState();
		const before = await savedFiles();
		const registrations = [...owner.values];
		const oldCommands = new Map(commands);
		const oldReceive = [...panel.receivers][0];
		const oldSource = panel.message('source');
		const confirmation = deferred<void>(); const answer = deferred<string | undefined>();
		host.confirm = async () => { confirmation.resolve(); return answer.promise; };
		panel.receive(panel.message('link', { href: 'https://example.com/guide?a=1&b=2' }));
		await confirmation.promise;
		const accesses = owner.stateAccess.length;
		const notices = host.confirmations.length;
		const queuedRefresh = assert.rejects(api.refresh(), /disposed/u);
		const queuedAdd = assert.rejects(api.addCourse(second.root), /disposed/u);
		const queuedOpen = oldCommands.get('certLearner.open')!(ids);
		const queuedComplete = owner.actions[0]('complete', selected);
		changeFolders(virtual);
		assert.equal(panel.disposed, true, 'Retire quiz and its attempts synchronously');
		assert.equal(owner.outputs.size, 0);
		assert.equal(owner.watchers.size, 0);
		assert.equal(owner.folderListeners.size, 1, 'Only the coordinator owns the folder subscription');
		assert.equal(owner.views[0].disposed, true);
		assert.match(owner.views.at(-1)!.message!, /local desktop folder/u);
		assert.deepEqual([...commands.keys()].sort(), contributes.commands.map(item => item.command).sort());
		const recovery = await api.getState();
		assert.deepEqual(recovery.courses, []);
		assert.equal(recovery.current, undefined);
		assert.match(recovery.unavailable!, /local desktop folder/u);
		assert.deepEqual(await commands.get('certLearner.getState')!(), recovery);
		assert.deepEqual(api.getCourses(), []);
		await assert.rejects(api.openUnitResource(ids, 'quiz'), /local desktop folder/u);
		await assert.rejects(api.openPage({ courseId: course.id, pageId: 'overview' }), /local desktop folder/u);
		await assert.rejects(api.addCourse(second.root), /local desktop folder/u);
		await assert.rejects(api.refresh(), /local desktop folder/u);
		for (const command of oldCommands.values()) { await command(ids); }
		oldReceive(oldSource);
		answer.resolve('Open website');
		await Promise.all([queuedRefresh, queuedAdd, queuedOpen, queuedComplete]);
		await drain();
		assert.equal(host.confirmations.length, notices, 'No transition popup or stale command dialogs');
		assert.equal(owner.stateAccess.length, accesses, 'Recovery and retired queues never access registrations');
		assert.deepEqual([...owner.values], registrations);
		assert.deepEqual(await savedFiles(), before, 'No course or progress bytes changed');
		assert.deepEqual(owner.effects, []);
		assert.deepEqual(owner.documents, []);
		assert.deepEqual(host.external, []);
		assert.equal(host.panels.length, 1);
		changeFolders(virtual, uri(course.root));
		const restored = await api.getState();
		assert.deepEqual(restored.courses, state.courses, 'The same progress is reopened, not relocated or reset');
		assert.equal(restored.current, undefined, 'A new session does not reopen an old activity automatically');
		await api.openUnitResource(ids, 'quiz');
		assert.notEqual(host.latest, panel);
		score(host.latest, 0, 0);
		assert.deepEqual(await savedFiles(), before);
	});

	it('adding local roots upgrades the stable recovery API and leaves mixed/local folder edits in the same learning mode', async () => {
		const course = await fixture();
		const second = await fixture('second');
		const virtual = virtualUri();
		const owner = await parent(course, { folders: [virtual] });
		const { getState, getCourses, openUnitResource, refresh } = owner.api;
		assert.ok((await getState()).unavailable);
		assert.deepEqual(getCourses(), []);
		assert.deepEqual(owner.stateAccess, []);
		assert.equal(owner.outputs.size, 0);
		assert.equal(owner.watchers.size, 0);
		assert.deepEqual(host.confirmations, []);
		const recoveryCommand = owner.commands.get('certLearner.addGitHub')!;
		const recoveryTree = owner.views[0];
		const children = await recoveryTree.provider.getChildren();
		assert.equal(children?.length, 1);
		assert.equal(children![0].command?.command, 'certLearner.add');
		owner.setStorage(uri(path.join(temporary, 'do-not-relocate')));
		owner.changeFolders(virtual, uri(course.root));
		const state = await getState(); // Queues behind the automatic transition refresh.
		assert.equal(state.unavailable, undefined);
		assert.equal(state.courses.length, 1);
		assert.deepEqual(getCourses().map(item => item.id), [course.id]);
		assert.equal(recoveryTree.disposed, true);
		assert.equal(owner.outputs.size, 1);
		assert.equal(owner.watchers.size, 1);
		assert.equal(owner.folderListeners.size, 1);
		assert.deepEqual([...owner.commands.keys()].sort(), contributes.commands.map(item => item.command).sort());
		await recoveryCommand();
		assert.deepEqual(host.confirmations, [], 'Captured recovery handlers become inert');
		const openQuiz = owner.commands.get('certLearner.openQuiz')!;
		await openQuiz({ courseId: course.id, unitId: 'unit' });
		await submit(host.latest, ['A']);
		assert.deepEqual(await getState(), state);
		owner.changeFolders(virtual, uri(course.root), uri(second.root));
		assert.equal(owner.commands.get('certLearner.openQuiz'), openQuiz);
		await refresh();
		assert.equal(getCourses().length, 2);
		score(host.latest, 1, 1);
		owner.changeFolders(uri(course.root), uri(second.root));
		await refresh();
		assert.equal(owner.views.length, 2, 'Same-capability folder changes only refresh, never re-register');
		assert.equal(owner.commands.get('certLearner.openQuiz'), openQuiz);
		await openUnitResource({ courseId: second.id, unitId: 'unit' }, 'quiz');
		assert.match(host.latest.webview.html, /second course/u);
		await owner.commands.get('certLearner.open')!({ courseId: course.id, unitId: 'unit', activityId: 'read' });
		// Opening the first activity matches fresh state and need not persist. Make
		// an explicit completion change to verify the original storage location.
		await owner.actions[0]('complete', { course, unit: course.manifest.units[0], activity: course.manifest.units[0].activities[0] });
		assert.ok((await readdir(path.join(temporary, 'state'))).some(file => file.endsWith('.json')));
		await assert.rejects(readdir(path.join(temporary, 'do-not-relocate')), { code: 'ENOENT' });
		assert.deepEqual(owner.effects, []);
		assert.deepEqual(owner.documents, []);
		assert.deepEqual(host.confirmations, []);
	});

	it('folder transitions drop pending unit choices, reset confirmations and source-document handoffs', async () => {
		const course = await fixture();
		const owner = await parent(course);
		const picked = deferred<void>(); const choice = deferred<unknown>();
		owner.setPick(async choices => {
			if ('unitId' in choices[0]) { picked.resolve(); return choice.promise; }
			return choices[0];
		});
		const opening = owner.commands.get('certLearner.openQuiz')!();
		await picked.promise;
		const resetStarted = deferred<void>(); const resetAnswer = deferred<string | undefined>();
		host.confirm = async () => { resetStarted.resolve(); return resetAnswer.promise; };
		const resetting = owner.commands.get('certLearner.reset')!();
		await resetStarted.promise;
		await owner.api.openUnitResource({ courseId: course.id, unitId: 'unit' }, 'quiz');
		const sourceStarted = deferred<void>(); const sourceDocument = deferred<UriValue>();
		owner.setOpenDocument(async () => { sourceStarted.resolve(); return sourceDocument.promise; });
		host.latest.receive(host.latest.message('source'));
		await sourceStarted.promise;
		const before = await savedFiles();
		const notices = host.confirmations.length;
		owner.changeFolders(virtualUri());
		choice.resolve({ unitId: 'unit' });
		resetAnswer.resolve('Reset progress');
		sourceDocument.resolve(uri(path.join(course.root, 'quiz.md')));
		await Promise.all([opening, resetting]);
		await drain();
		assert.deepEqual(await savedFiles(), before);
		assert.deepEqual(owner.documents, []);
		assert.deepEqual(owner.effects, []);
		assert.equal(host.confirmations.length, notices);
		assert.equal(host.panels.length, 1);
		assert.equal(host.latest.disposed, true);
	});

	it('rapid folder changes retire a pending refresh; deactivate and context disposal remove the coordinator', async () => {
		const course = await fixture();
		const virtual = virtualUri();
		const owner = await parent(course, { folders: [virtual] });
		owner.changeFolders(virtual, uri(course.root));
		owner.changeFolders(virtual); // Retire the queued initial refresh before it starts.
		await drain();
		assert.ok((await owner.api.getState()).unavailable);
		assert.deepEqual(owner.stateAccess, []);
		assert.equal(owner.watchers.size, 0);
		owner.changeFolders(virtual, uri(course.root));
		assert.equal((await owner.api.getState()).courses.length, 1);
		owner.deactivate();
		for (const item of extensionDisposables) { item.dispose(); }
		assert.equal(owner.folderListeners.size, 0);
		assert.equal(owner.commands.size, 0);
		assert.equal(owner.watchers.size, 0);
		assert.equal(owner.outputs.size, 0);
		assert.ok(owner.views.every(view => view.disposed));
		const accesses = owner.stateAccess.length;
		owner.changeFolders(virtual);
		owner.changeFolders(uri(course.root));
		assert.equal(owner.commands.size, 0);
		assert.equal(owner.stateAccess.length, accesses);
		assert.deepEqual(owner.api.getCourses(), []);
		await assert.rejects(owner.api.getState(), /disposed/u);
	});

	it('local folder addition cannot bypass nonlocal storage, and context-only disposal removes recovery handlers', async () => {
		const course = await fixture();
		const virtual = virtualUri();
		const owner = await parent(course, { folders: [virtual], storage: virtual });
		const handler = owner.commands.get('certLearner.openQuiz');
		owner.changeFolders(virtual, uri(course.root));
		assert.equal(owner.commands.get('certLearner.openQuiz'), handler);
		assert.ok((await owner.api.getState()).unavailable);
		assert.deepEqual(owner.stateAccess, []);
		assert.deepEqual(owner.effects, []);
		assert.equal(owner.outputs.size, 0);
		assert.equal(owner.watchers.size, 0);
		assert.deepEqual(host.confirmations, []);
		for (const item of extensionDisposables) { item.dispose(); }
		assert.equal(owner.folderListeners.size, 0);
		assert.equal(owner.commands.size, 0);
		assert.ok(owner.views.every(view => view.disposed));
		owner.changeFolders(uri(course.root));
		assert.equal(owner.commands.size, 0);
	});

	it('transition constructor failure releases partial registrations and leaves guarded recovery until reload', async () => {
		const course = await fixture();
		const virtual = virtualUri();
		const owner = await parent(course, { folders: [virtual] });
		owner.failNextCommand('certLearner.openPage');
		owner.changeFolders(virtual, uri(course.root));
		await drain();
		host.expectError(/could not restart.*reload the window/u);
		assert.deepEqual([...owner.commands.keys()].sort(), contributes.commands.map(item => item.command).sort());
		assert.equal(owner.outputs.size, 0);
		assert.equal(owner.watchers.size, 0);
		assert.equal(owner.views.filter(view => !view.disposed).length, 1);
		assert.deepEqual(owner.stateAccess, [], 'A partial constructor must not start refreshing');
		assert.ok((await owner.api.getState()).unavailable);
		await assert.rejects(owner.api.addCourse(course.root), /local desktop folder/u);
		owner.changeFolders(virtual);
		owner.changeFolders(virtual, uri(course.root));
		assert.ok((await owner.api.getState()).unavailable, 'A failed transition stays guarded until reload');
		assert.deepEqual(owner.effects, []);
		assert.deepEqual(host.confirmations, []);
	});

	it('initial full constructor failures still reject activation with the original diagnostic', async () => {
		const course = await fixture();
		await assert.rejects(parent(course, { failCommand: 'certLearner.openPage' }), /EXPECTED_REGISTRATION_FAILURE/u);
		host.expectError(/could not activate.*EXPECTED_REGISTRATION_FAILURE/u);
	});

	it('initial HTML exposes one public question, no answers/explanations, strict CSP and bundled assets only', async () => {
		const panel = await show();
		assert.equal(panel.viewType, 'certLearner.quiz');
		assert.equal(panel.options.enableScripts, true);
		assert.equal(panel.options.enableForms, false);
		assert.equal(panel.options.enableCommandUris, false);
		assert.deepEqual((panel.options.localResourceRoots as UriValue[]).map(value => path.basename(value.fsPath)), ['media']);
		assert.match(panel.webview.html, /Question 1 of 2/u);
		assert.match(panel.webview.html, /first course/u);
		assert.match(panel.webview.html, /01 · Local unit/u);
		assert.match(panel.webview.html, /No auto-complete/u);
		assert.match(panel.webview.html, /not saved across extension restarts/u);
		assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION|HIDDEN_QUESTION_TWO|correctOptionIds|Answer reference|DO_NOT_READ_LESSON/u);
		assert.match(panel.webview.html, /<fieldset[^>]*>[\s\S]*<legend>Choose one answer/u);
		assert.equal((panel.webview.html.match(/type="radio"/gu) ?? []).length, 3);
		assert.match(panel.webview.html, /aria-labelledby="choice-label-0 choice-text-0"/u);
		assert.match(panel.webview.html, /data-focus="question-heading"/u);
		assert.match(panel.webview.html, /default-src &#39;none&#39;/u);
		assert.match(panel.webview.html, /connect-src &#39;none&#39;/u);
		assert.match(panel.webview.html, /learning\.css[^]*quiz\.css/u);
		assert.equal((panel.webview.html.match(/<script\b/gu) ?? []).length, 1);
		assert.match(panel.webview.html, /<script nonce="[^"]+" src="[^"]+\/quiz\.js" defer><\/script>/u);
		assert.doesNotMatch(panel.webview.html, /<img\b|<form\b|<iframe\b|unsafe-inline/u);
		score(panel, 0, 0);
		enabled(panel, 'previous', false); enabled(panel, 'next', false); enabled(panel, 'summary', false); enabled(panel, 'source', true);
	});

	for (const [answer, correct] of [['A', true], ['B', false]] as const) {
		it(`grades single choice ${correct ? 'correct' : 'incorrect'} once, with full feedback and disabled choices`, async () => {
			const panel = await show();
			const replay = panel.message('submit', { selectedIds: [answer] });
			await submit(panel, [answer]);
			score(panel, correct ? 1 : 0, 1);
			assert.match(panel.webview.html, new RegExp(`</span> ${correct ? 'Correct' : 'Incorrect'}</h2>`, 'u'));
			assert.match(panel.webview.html, /SECRET_EXPLANATION_ONE/u);
			assert.match(panel.webview.html, /<strong>Full authored explanation\.<\/strong>/u);
			assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION_TWO/u);
			assert.match(panel.webview.html, /Source-author answer · Not an official exam guarantee/u);
			assert.match(panel.webview.html, /data-focus="feedback-heading"/u);
			assert.equal([...panel.webview.html.matchAll(/<input\b[^>]*>/gu)].every(match => match[0].includes(' disabled')), true);
			enabled(panel, 'next', true);
			await panel.ignore(replay);
			await submit(panel, ['C']); // Even a fresh render ID cannot replace a grade.
			score(panel, correct ? 1 : 0, 1);
			assert.match(panel.webview.html, new RegExp(`value="${answer}"[^>]* checked disabled`, 'u'));
		});
	}

	for (const [answers, correct] of [[['A', 'C'], true], [['B', 'A'], false]] as const) {
		it(`grades multi-select ${correct ? 'right' : 'wrong'}, navigates back, finishes and reports correct/N`, async () => {
			const panel = await show();
			await submit(panel, ['A']);
			await panel.dispatch('next');
			assert.equal(panel.questionId, '2');
			assert.match(panel.webview.html, /Question 2 of 2/u);
			assert.equal((panel.webview.html.match(/type="checkbox"/gu) ?? []).length, 3);
			assert.match(panel.webview.html, /0 of 2 selected/u);
			enabled(panel, 'submit', false);
			assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION/u);
			await submit(panel, [...answers]);
			assert.match(panel.webview.html, /SECRET_EXPLANATION_TWO/u);
			const totalCorrect = correct ? 2 : 1;
			score(panel, totalCorrect, 2);
			await panel.dispatch('previous');
			assert.match(panel.webview.html, /SECRET_EXPLANATION_ONE/u);
			score(panel, totalCorrect, 2);
			await panel.dispatch('next');
			assert.match(panel.webview.html, /SECRET_EXPLANATION_TWO/u);
			await panel.dispatch('next');
			assert.equal(panel.questionId, '');
			assert.match(panel.webview.html, /Quiz results/u);
			assert.match(panel.webview.html, new RegExp(`<strong>${totalCorrect} / 2</strong> correct`, 'u'));
			assert.match(panel.webview.html, /Retry quiz/u);
			assert.match(panel.webview.html, /data-focus="results-heading"/u);
			assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION/u);
			await panel.dispatch('previous');
			assert.equal(panel.questionId, '2');
			await panel.dispatch('summary');
			assert.equal(panel.questionId, '');
		});
	}

	it('rejects forged envelopes, hidden questions, stale IDs, extra keys, symbols and accessors', async () => {
		const panel = await show();
		const before = panel.webview.html;
		const valid = panel.message('submit', { selectedIds: ['A'] });
		let getterRan = false;
		const selectedIds: unknown[] = [];
		Object.defineProperty(selectedIds, '0', { get: () => { getterRan = true; throw new Error('Do not invoke'); }, enumerable: true });
		for (const message of [
			null, [], {}, { action: 'submit' }, { ...valid, action: 'complete' },
			{ ...valid, renderId: 'stale' }, { ...valid, questionId: '2' }, { ...valid, questionId: '' },
			{ ...valid, selectedIds: 'A' }, { ...valid, selectedIds }, { ...valid, [Symbol('extra')]: 1 },
			{ ...valid, get action() { getterRan = true; return 'submit'; } },
			Object.assign(Object.create({ inherited: true }) as object, valid),
			...['score', 'correct', 'answers', 'correctOptionIds', 'path', 'selection', 'command'].map(key => ({ ...valid, [key]: 'forged' }))
		]) { await panel.ignore(message); }
		assert.equal(getterRan, false);
		assert.equal(panel.webview.html, before);
		await panel.dispatch('next');
		assert.equal(panel.questionId, '1', 'Cannot skip an ungraded question');
		await panel.dispatch('summary');
		assert.equal(panel.questionId, '1', 'Cannot jump to incomplete results');
		await submit(panel, ['A']);
		await panel.dispatch('next');
		await panel.ignore(valid);
		await panel.ignore(panel.message('submit', { questionId: '1', selectedIds: ['A'] }));
		score(panel, 1, 1);
	});

	it('rejects unknown, duplicate and wrong-count option IDs without grades or answer disclosure, then unlocks', async () => {
		const panel = await show();
		for (const ids of [[], ['Z'], ['A', 'B'], ['A', 'A']]) {
			await submit(panel, ids);
			host.expectError(/unique known strings/u);
			score(panel, 0, 0);
			assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION/u);
		}
		await submit(panel, ['B']);
		await panel.dispatch('next');
		for (const ids of [[], ['A'], ['A', 'A'], ['A', 'Z'], ['A', 'B', 'C']]) {
			await submit(panel, ids);
			host.expectError(/unique known strings/u);
			score(panel, 0, 1);
			assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION/u);
		}
		await submit(panel, ['C', 'A']);
		score(panel, 1, 2);
	});

	it('suppresses duplicate in-flight submits before any filesystem await', async () => {
		const panel = await show();
		const message = panel.message('submit', { selectedIds: ['A'] });
		const done = submit(panel, ['A']);
		panel.receive(message);
		panel.receive({ ...message, selectedIds: ['B'] });
		await done;
		assert.equal(panel.posted.length, 1);
		score(panel, 1, 1);
	});

	it('retains answers/navigation on reopen, isolates course roots and clears all state on controller dispose', async () => {
		const first = await fixture();
		const second = await fixture('second');
		const panel = await show(first);
		await submit(panel, ['A']);
		await panel.dispatch('next');
		const oldReceive = [...panel.receivers][0];
		panel.dispose();
		await show(first);
		assert.notEqual(host.latest, panel);
		assert.equal(host.latest.questionId, '2');
		score(host.latest, 1, 1);
		oldReceive(host.latest.message('submit', { selectedIds: ['A', 'C'] }));
		await drain();
		score(host.latest, 1, 1);
		await show(second); score(host.latest, 0, 0);
		await show(first); score(host.latest, 1, 1);
		await host.latest.dispatch('previous');
		assert.match(host.latest.webview.html, /SECRET_EXPLANATION_ONE/u);
		controller.dispose();
		await controller.show(selection(first));
		assert.equal(host.panels.length, 2, 'Disposed controller cannot reopen');
		controller = new (loadPanel(host).QuizPanel)(context, onSource);
		await show(first); score(host.latest, 0, 0);
	});

	it('invalidates all units and nested JSON revisions exactly, preserves other courses, and denies stale/source actions', async () => {
		const first = await fixture();
		// IDs may contain JSON punctuation. Prefix/string matching is not identity.
		first.id = 'course["quoted\\id"]';
		first.manifest.units[0].unitId = 'unit["one\\id"]';
		first.manifest.units.push({ ...structuredClone(first.manifest.units[0]), unitId: 'unit["two"]' });
		const second = await fixture('second');
		second.id = `${first.id}-other`;
		const panel = await show(first);
		await submit(panel, ['A']);
		await controller.show({ course: first, unit: first.manifest.units[1] });
		await submit(panel, ['B']);
		await show(second); await submit(panel, ['A']);
		await show(first);
		const stale = ['source', 'next', 'restart', 'summary', 'previous'].map(action => panel.message(action));
		stale.push(panel.message('submit', { selectedIds: ['A'] }));
		controller.invalidateCourse(first.id);
		const unavailable = panel.webview.html;
		assert.match(unavailable, /course changed or was removed[\s\S]*Reopen the quiz/u);
		assert.doesNotMatch(unavailable, /SECRET_EXPLANATION|quiz-score|data-action="restart"/u);
		enabled(panel, 'source', false);
		for (const message of stale) { await panel.ignore(message); }
		await panel.ignore(panel.message('source'));
		await panel.ignore(panel.message('submit', { selectedIds: ['A'] }));
		assert.equal(panel.webview.html, unavailable);
		assert.deepEqual(sources, []);
		await show(second); score(panel, 1, 1);
		const otherRender = panel.renderId;
		controller.invalidateCourse(first.id);
		assert.equal(panel.renderId, otherRender, 'Other course render remains active');
		for (const unit of first.manifest.units) {
			await controller.show({ course: first, unit }); score(panel, 0, 0);
			assert.doesNotMatch(panel.webview.html, /Quiz source changed/u, 'Revisions were cleared too');
		}
		await submit(panel, ['A']); panel.dispose();
		controller.invalidateCourse(first.id);
		await controller.show({ course: first, unit: first.manifest.units[1] });
		score(host.latest, 0, 0);
	});

	it('invalidation fences pending initial reads and pending confirmations', async () => {
		const course = await fixture();
		const pending = controller.show(selection(course));
		const panel = host.latest;
		assert.match(panel.webview.html, /Loading local quiz/u);
		controller.invalidateCourse(course.id);
		const unavailable = panel.webview.html;
		await pending;
		assert.equal(panel.webview.html, unavailable, 'Pending load cannot recreate a cleared attempt');
		await show(course); await submit(panel, ['A']);
		const started = deferred<void>(); const answer = deferred<string | undefined>();
		host.confirm = async () => { started.resolve(); return answer.promise; };
		panel.receive(panel.message('restart'));
		await started.promise;
		controller.invalidateCourse(course.id);
		const invalidated = panel.webview.html;
		answer.resolve('Restart quiz'); await drain();
		assert.equal(panel.webview.html, invalidated);
		await show(course); score(panel, 0, 0);
	});

	for (const change of ['manifest', 'overview', 'references', 'quiz path', 'unit removal', 'course removal'] as const) {
		it(`parent refresh invalidates a submitted quiz on ${change} before replacing the registry`, async () => {
			const course = await fixture();
			const { api, unregister, documents } = await parent(course);
			const ids = { courseId: course.id, unitId: course.manifest.units[0].unitId };
			await api.openUnitResource(ids, 'quiz');
			const panel = host.latest;
			await submit(panel, ['A']);
			const oldSource = panel.message('source');
			const oldNext = panel.message('next');
			const manifest = structuredClone(course.manifest);
			switch (change) {
				case 'manifest': manifest.title = 'Changed title'; break;
				case 'overview': manifest.overview = 'lesson.md'; break;
				case 'references': manifest.resources = [{ title: 'Reference', path: 'lesson.md' }]; break;
				case 'quiz path':
					await writeFile(path.join(course.root, 'new-quiz.md'), markdown());
					manifest.units[0].resources.quiz = 'new-quiz.md'; break;
				case 'unit removal': manifest.units[0].unitId = 'replacement-unit'; break;
				case 'course removal': unregister(); break;
			}
			if (change !== 'course removal') { await writeFile(path.join(course.root, 'course.json'), JSON.stringify(manifest)); }
			await api.refresh();
			assert.match(panel.webview.html, /course changed or was removed[\s\S]*Reopen the quiz/u);
			enabled(panel, 'source', false);
			await panel.ignore(oldSource); await panel.ignore(oldNext); await panel.ignore(panel.message('source'));
			assert.deepEqual(documents, [], 'Neither the frozen nor newly registered source can be opened by the stale render');
			if (change === 'course removal' || change === 'unit removal') {
				await assert.rejects(api.openUnitResource(ids, 'quiz'), /no longer registered/u);
				host.expectError(/no longer registered/u);
			} else {
				await api.openUnitResource(ids, 'quiz'); score(panel, 0, 0);
				assert.doesNotMatch(panel.webview.html, /Quiz source changed/u);
				await panel.dispatch('source');
				assert.deepEqual(documents, [path.join(course.root, manifest.units[0].resources.quiz!)]);
			}
		});
	}

	it('parent unchanged refresh and generic progress reset preserve the submitted attempt and render', async () => {
		const course = await fixture();
		const { api, commands } = await parent(course);
		await api.openUnitResource({ courseId: course.id, unitId: 'unit' }, 'quiz');
		const panel = host.latest;
		await submit(panel, ['A']);
		const rendered = panel.webview.html;
		await api.refresh();
		assert.equal(panel.webview.html, rendered);
		await commands.get('certLearner.reset')!();
		assert.ok(host.confirmations.some(item => item.buttons.includes('Reset progress')));
		assert.equal(panel.webview.html, rendered);
		await panel.dispatch('next'); score(panel, 1, 1);
	});

	it('confirmed removal invalidates the open quiz and closed attempt before deleting the registration', async () => {
		const course = await fixture();
		const { api, commands, documents } = await parent(course);
		const ids = { courseId: course.id, unitId: 'unit' };
		await api.openUnitResource(ids, 'quiz');
		const panel = host.latest;
		await submit(panel, ['A']);
		const old = panel.message('source');
		await commands.get('certLearner.remove')!();
		assert.equal(api.getCourses().length, 0);
		assert.match(panel.webview.html, /course changed or was removed/u);
		await panel.ignore(old); await panel.ignore(panel.message('source'));
		assert.deepEqual(documents, []);
		await api.addCourse(course.root);
		await api.openUnitResource(ids, 'quiz'); score(panel, 0, 0);
	});

	it('palette commands explicitly pick course/unit with no current selection, then use current IDs without changing progress', async () => {
		const course = await fixture();
		const { api, commands, picks, setPick } = await parent(course);
		const before = JSON.stringify(await api.getState());
		await commands.get('certLearner.openQuiz')!();
		assert.deepEqual(picks.map(item => item.title), ['Select a certification course', 'Select a unit to open its quiz']);
		assert.equal(JSON.stringify(await api.getState()), before);
		assert.match(host.latest.webview.html, /Question 1 of 2/u);
		setPick(async () => undefined);
		const rendered = host.latest.webview.html;
		await commands.get('certLearner.openQuiz')!();
		assert.equal(picks.length, 3, 'Cancelling course pick never selects a unit');
		assert.equal(host.latest.webview.html, rendered);
		setPick(async choices => 'unitId' in choices[0] ? undefined : choices[0]);
		await commands.get('certLearner.openQuiz')!();
		assert.equal(picks.length, 5);
		assert.equal(host.latest.webview.html, rendered);
		await commands.get('certLearner.open')!({ courseId: course.id, unitId: 'unit', activityId: 'read' });
		const selected = JSON.stringify(await api.getState());
		await commands.get('certLearner.openQuiz')!();
		assert.equal(picks.length, 5, 'Current unit bypasses both pickers');
		await commands.get('certLearner.openLab')!();
		host.expectError(/No lab is declared/u);
		assert.equal(picks.length, 5);
		assert.equal(JSON.stringify(await api.getState()), selected);
	});

	it('palette selection does not lock refresh and revalidates IDs after the unit picker', async () => {
		const course = await fixture();
		const { api, commands, setPick, unregister } = await parent(course);
		const started = deferred<void>(); const chosen = deferred<unknown>();
		setPick(async choices => {
			if ('unitId' in choices[0]) { started.resolve(); return chosen.promise; }
			return choices[0];
		});
		const opening = commands.get('certLearner.openQuiz')!();
		await started.promise;
		unregister(); await api.refresh();
		chosen.resolve({ unitId: 'unit' }); await opening;
		host.expectError(/no longer registered/u);
		assert.equal(host.panels.length, 0);
	});

	it('confirms graded restart and retry, honors cancel, and does not confirm a fresh restart', async () => {
		const panel = await show();
		await panel.dispatch('restart');
		assert.equal(host.confirmations.length, 0);
		await submit(panel, ['B']);
		host.confirm = async () => undefined;
		await panel.dispatch('restart');
		score(panel, 0, 1);
		assert.match(panel.webview.html, /SECRET_EXPLANATION_ONE/u);
		assert.equal(host.confirmations[0].options.modal, true);
		host.confirm = async buttons => buttons[0];
		const stale = panel.message('submit', { selectedIds: ['B'] });
		await panel.dispatch('restart');
		score(panel, 0, 0);
		assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION/u);
		await panel.ignore(stale);
		await submit(panel, ['A']); await panel.dispatch('next'); await submit(panel, ['A', 'C']); await panel.dispatch('next');
		await panel.dispatch('restart');
		assert.equal(panel.questionId, '1'); score(panel, 0, 0);
	});

	it('drops stale restart modal results after a new selection and keeps the old attempt intact', async () => {
		const first = await fixture();
		const second = await fixture('second');
		const panel = await show(first);
		await submit(panel, ['A']);
		const started = deferred<void>();
		const answer = deferred<string | undefined>();
		host.confirm = async () => { started.resolve(); return answer.promise; };
		panel.receive(panel.message('restart'));
		await started.promise;
		await show(second);
		answer.resolve('Restart quiz'); await drain();
		score(panel, 0, 0);
		await show(first); score(panel, 1, 1);
	});

	it('detects source revision on show and before submitting/navigation and never grades a new revision with an old click', async () => {
		const course = await fixture();
		const panel = await show(course);
		await submit(panel, ['A']);
		const changed = quiz(); changed.questions[0].correctOptionIds = ['B'];
		await writeFile(path.join(course.root, 'quiz.md'), markdown(changed));
		await panel.dispatch('next');
		score(panel, 0, 0); assert.equal(panel.questionId, '1');
		assert.match(panel.webview.html, /Quiz source changed.*reset/u);
		await submit(panel, ['B']); score(panel, 1, 1);
		changed.questions[0].explanation += ' Source revision two.';
		await writeFile(path.join(course.root, 'quiz.md'), markdown(changed));
		await show(course); score(panel, 0, 0);
		assert.match(panel.webview.html, /Quiz source changed.*reset/u);
		changed.questions[0].explanation += ' Source revision three.';
		await writeFile(path.join(course.root, 'quiz.md'), markdown(changed));
		await submit(panel, ['B']); score(panel, 0, 0);
		assert.doesNotMatch(panel.webview.html, /SECRET_EXPLANATION/u);
	});

	it('handles invalid Markdown without leaking source, keeps safe Open source, and clears old attempts', async () => {
		const course = await fixture();
		const panel = await show(course);
		await submit(panel, ['A']);
		await writeFile(path.join(course.root, 'quiz.md'), '# Unrecognized\nSECRET_RAW_ANSWER');
		await panel.dispatch('next');
		assert.match(panel.webview.html, /Interactive quiz unavailable/u);
		assert.match(panel.webview.html, /previous attempt has been cleared/u);
		assert.doesNotMatch(panel.webview.html, /SECRET_RAW_ANSWER|SECRET_EXPLANATION|correctOptionIds/u);
		enabled(panel, 'source', true);
		await panel.dispatch('source');
		assert.equal(sources.length, 1);
		assert.equal(sources[0].unit.resources.quiz, 'quiz.md');
		await writeFile(path.join(course.root, 'quiz.md'), markdown());
		await show(course); score(panel, 0, 0);
	});

	it('supports structured JSON at the loaded-course boundary and safely falls back for invalid JSON', async () => {
		const course = await fixture();
		// The parent owns widening loadCourse's Markdown-only manifest contract.
		// Exercise this panel's existing loadQuiz JSON API with a registered snapshot.
		course.manifest.units[0].resources.quiz = 'quiz.json';
		await writeFile(path.join(course.root, 'quiz.json'), JSON.stringify(quiz()));
		const panel = await show(course);
		score(panel, 0, 0); await submit(panel, ['A']); score(panel, 1, 1);
		for (const source of ['{ "SECRET_RAW_ANSWER":', JSON.stringify({ ...quiz(), extra: 'SECRET_RAW_ANSWER' })]) {
			await writeFile(path.join(course.root, 'quiz.json'), source);
			await show(course);
			assert.match(panel.webview.html, /Interactive quiz unavailable/u);
			assert.doesNotMatch(panel.webview.html, /SECRET_RAW_ANSWER|SECRET_EXPLANATION|correctOptionIds/u);
			enabled(panel, 'source', true);
			await panel.dispatch('source');
		}
		assert.equal(sources.length, 2);
	});

	it('uses detached canonical selection, ignores forged unit paths, and leaves all course/progress files unchanged', async () => {
		const course = await fixture();
		const files = ['course.json', 'lesson.md', 'quiz.md', 'progress.json'];
		const before = await Promise.all(files.map(file => readFile(path.join(course.root, file), 'utf8')));
		const chosen = selection(course);
		await controller.show({ course, unit: { ...chosen.unit, title: 'FORGED_TITLE', resources: { lesson: '.env', quiz: '.env' } } });
		const panel = host.latest;
		assert.doesNotMatch(panel.webview.html, /FORGED_TITLE/u);
		course.manifest.units[0].resources.quiz = 'other.md'; // Caller mutation cannot retarget an existing render.
		await panel.dispatch('source');
		assert.equal(sources[0].unit.resources.quiz, 'quiz.md');
		assert.equal(Object.isFrozen(sources[0].course.manifest.units[0].resources), true);
		assert.throws(() => { sources[0].unit.resources.quiz = '.env'; }, TypeError);
		await submit(panel, ['A']); await panel.dispatch('next'); await submit(panel, ['A', 'C']); await panel.dispatch('next');
		await panel.dispatch('restart');
		assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(course.root, file), 'utf8'))), before);
	});

	it('disables missing/unsafe sources, rechecks deletion at click time, and never invokes the callback', async () => {
		const course = await fixture();
		const panel = await show(course);
		await submit(panel, ['A']);
		await rm(path.join(course.root, 'quiz.md'));
		await panel.dispatch('source');
		assert.match(panel.webview.html, /Interactive quiz unavailable/u);
		enabled(panel, 'source', false);
		await writeFile(path.join(course.root, 'quiz.md'), markdown());
		await show(course);
		score(panel, 0, 0);
		await rm(path.join(course.root, 'quiz.md'));
		for (const relative of ['quiz.md', '../outside.md', '.env', 'quiz.txt', 'lesson.md/missing.md']) {
			course.manifest.units[0].resources.quiz = relative;
			await show(course); enabled(panel, 'source', false);
			assert.match(panel.webview.html, /Interactive quiz unavailable/u);
		}
		await controller.show({ course, unit: { ...course.manifest.units[0], unitId: 'undeclared' } });
		enabled(panel, 'source', false);
		assert.deepEqual(sources, []);
	});

	it('awaits source callbacks, reports failures, acknowledges completion and unlocks retry', async () => {
		const panel = await show();
		const started = deferred<void>();
		const release = deferred<void>();
		onSource = async selected => { sources.push(selected); started.resolve(); await release.promise; };
		const done = panel.dispatch('source');
		await started.promise;
		await panel.ignore(panel.message('source'));
		assert.equal(sources.length, 1);
		release.resolve(); await done;
		onSource = async () => { throw new Error('EXPECTED_SOURCE_FAILURE'); };
		await panel.dispatch('source'); host.expectError(/EXPECTED_SOURCE_FAILURE/u);
		onSource = async selected => { sources.push(selected); };
		await panel.dispatch('source'); assert.equal(sources.length, 2);
	});

	it('only opens safe links actually displayed, confirms/cancels, then allows revealed explanation links', async () => {
		const panel = await show();
		const href = 'https://example.com/guide?a=1&b=2';
		await panel.dispatch('link', { href });
		assert.deepEqual(host.external, [href]);
		assert.equal(host.confirmations[0].options.modal, true);
		host.confirm = async () => undefined;
		await panel.dispatch('link', { href }); assert.equal(host.external.length, 1);
		for (const href of ['command:bad', 'http://example.com', 'https://example.com/answer', 'https://example.com/not-in-view']) {
			await panel.dispatch('link', { href }); host.expectError(/Only safe HTTPS/u);
		}
		await submit(panel, ['A']);
		host.confirm = async buttons => buttons[0];
		await panel.dispatch('link', { href: 'https://example.com/answer' });
		assert.equal(host.external.length, 2);
	});

	it('drops link confirmations and in-flight loads after disposal or superseding show', async () => {
		const first = await fixture();
		const second = await fixture('second');
		const panel = await show(first);
		const started = deferred<void>(); const answer = deferred<string | undefined>();
		host.confirm = async () => { started.resolve(); return answer.promise; };
		panel.receive(panel.message('link', { href: 'https://example.com/guide?a=1&b=2' }));
		await started.promise;
		await show(second);
		answer.resolve('Open website'); await drain();
		assert.deepEqual(host.external, []);
		const pendingFirst = controller.show(selection(first));
		const pendingSecond = controller.show(selection(second));
		await Promise.all([pendingFirst, pendingSecond]);
		assert.match(panel.webview.html, /second course/u);
		const pendingClosed = controller.show(selection(first));
		controller.dispose(); await pendingClosed;
		assert.equal(panel.disposed, true);
	});

	it('sanitizes authored question/option/explanation controls, links, scripts and remote images', async () => {
		const course = await fixture();
		course.manifest.units[0].resources.quiz = 'quiz.json';
		const malicious = quiz();
		const injection = '<script>BAD_SCRIPT()</script><input name="quiz-choice" value="forged"><button data-action="submit">fake</button><iframe src="https://evil.test"></iframe><img src="https://evil.test/x"><a href="command:bad">bad</a><a href="https://example.com/safe" onclick="BAD_HANDLER()">safe</a>';
		malicious.questions[0].prompt += injection;
		malicious.questions[0].options[0].text += injection;
		malicious.questions[0].explanation += injection;
		await writeFile(path.join(course.root, 'quiz.json'), JSON.stringify(malicious));
		const panel = await show(course);
		for (const graded of [false, true]) {
			if (graded) { await submit(panel, ['A']); }
			assert.equal((panel.webview.html.match(/<input\b/gu) ?? []).length, 3);
			assert.equal((panel.webview.html.match(/<script\b/gu) ?? []).length, 1);
			assert.doesNotMatch(panel.webview.html, /BAD_SCRIPT|BAD_HANDLER|onclick=|<iframe\b|<img\b|value="forged"|href="command:/u);
			assert.match(panel.webview.html, /data-href="https:\/\/example.com\/safe" role="link" tabindex="0"/u);
			assert.doesNotMatch(panel.webview.html, /<button[^>]*>fake/u);
		}
	});
});

describe('quiz renderer and media boundary', () => {
	it('exports a pure renderer accepting only public content, with no VS Code dependency', () => {
		const html = renderQuizView({ title: '<quiz>', courseTitle: 'Course', unitTitle: 'Unit', sourceAvailable: false,
			total: 1, answered: 0, correct: 0,
			content: { kind: 'question', number: 1, question: { id: '1', prompt: 'Public prompt', requiredSelections: 1,
				options: [{ id: 'A', text: 'Public A' }, { id: 'B', text: 'Public B' }] } } });
		assert.match(html, /&lt;quiz&gt;/u);
		assert.doesNotMatch(html, /correctOptionIds|explanation|<script/u);
	});

	it('copies the exact theme preamble, uses no storage/network/timers/inline code, and inherits cp theme colors', () => {
		const media = path.resolve(__dirname, '../../../media');
		const script = readFileSync(path.join(media, 'quiz.js'), 'utf8');
		const original = readFileSync(path.join(media, 'learning.js'), 'utf8');
		assert.equal(script.split(/\r?\n/u).slice(0, 6).join('\n'), original.split(/\r?\n/u).slice(0, 6).join('\n'));
		assert.doesNotMatch(script, /setState|getState|localStorage|sessionStorage|fetch\(|setTimeout|setInterval|correctOptionIds|innerHTML/u);
		const css = readFileSync(path.join(media, 'quiz.css'), 'utf8');
		assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|animation|transition|@import/iu);
		assert.match(css, /forced-colors/u);
	});

	for (const multi of [false, true]) {
		it(`runs real browser script: ${multi ? 'checkbox count/check gating' : 'radio click immediate submission'}, busy lock, stale acknowledgment and focus`, () => {
			class Element {
				disabled = false;
				checked = false;
				value = '';
				type = '';
				classList = { contains: () => false, toggle: () => undefined };
				constructor(readonly kind: string, readonly dataset: Record<string, string> = {}) {}
				closest(selector: string): Element | null {
					if (selector === 'button[data-action]' && this.kind === 'button') { return this; }
					if (selector === '.quiz-choice' && this.kind === 'input') { return this; }
					return null;
				}
				querySelector(): Element { return this; }
			}
			const inputs = ['A', 'B', 'C'].map(value => { const input = new Element('input'); input.value = value; input.type = multi ? 'checkbox' : 'radio'; return input; });
			const buttons = ['submit', 'source', 'next', 'forged'].map(action => new Element('button', { action }));
			buttons[0].disabled = true; buttons[2].disabled = true;
			const documentEvents = new Map<string, (event: unknown) => void>();
			const windowEvents = new Map<string, (event: unknown) => void>();
			const messages: unknown[] = [];
			const status = { textContent: '' }; const count = { textContent: '' };
			let focused = false;
			const main = { dataset: { focus: 'question-heading' }, setAttribute: () => undefined };
			runInNewContext(readFileSync(path.resolve(__dirname, '../../../media/quiz.js'), 'utf8'), {
				Element, URLSearchParams, MutationObserver: class { observe(): void {} },
				acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { messages.push(JSON.parse(JSON.stringify(message))); } }),
				window: { location: { search: '' }, matchMedia: () => ({ matches: false }),
					addEventListener: (name: string, listener: (event: unknown) => void) => { windowEvents.set(name, listener); } },
				document: {
					documentElement: { setAttribute: () => undefined }, body: { dataset: { renderId: 'render', questionId: '1' }, classList: { contains: () => false } },
					querySelector: () => main,
					querySelectorAll: (selector: string) => selector === 'button[data-action]' ? buttons : selector.startsWith('input') ? inputs : [],
					getElementById: (id: string) => id === 'quiz-choices' ? { dataset: { required: multi ? '2' : '1', graded: 'false' } }
						: id === 'action-status' ? status : id === 'selection-count' ? count : id === 'question-heading' ? { focus: () => { focused = true; } } : undefined,
					addEventListener: (name: string, listener: (event: unknown) => void) => { documentEvents.set(name, listener); }
				}
			});
			assert.equal(focused, true);
			const click = documentEvents.get('click')!; const change = documentEvents.get('change')!; const receive = windowEvents.get('message')!;
			inputs[0].checked = true;
			if (multi) {
				change({ target: inputs[0] }); assert.equal(buttons[0].disabled, true);
				assert.equal(count.textContent, '1 of 2 selected'); assert.equal(messages.length, 0);
				inputs[2].checked = true; change({ target: inputs[2] }); assert.equal(buttons[0].disabled, false);
				inputs[1].checked = true; change({ target: inputs[1] }); assert.equal(buttons[0].disabled, true);
				inputs[1].checked = false; change({ target: inputs[1] });
				click({ target: buttons[0] });
			} else { click({ target: inputs[0] }); }
			assert.deepEqual(messages, [{ action: 'submit', renderId: 'render', questionId: '1', selectedIds: multi ? ['A', 'C'] : ['A'] }]);
			assert.equal(status.textContent, 'Working…');
			click({ target: inputs[0] }); change({ target: inputs[0] }); click({ target: buttons[1] });
			assert.equal(messages.length, 1);
			receive({ data: { type: 'actionFinished', renderId: 'stale' } }); assert.equal(buttons[1].disabled, true);
			receive({ data: { type: 'actionFinished', renderId: 'render' } }); assert.equal(buttons[1].disabled, false);
			assert.equal(buttons[2].disabled, true);
			click({ target: buttons[3] }); assert.equal(messages.length, 1);
			click({ target: buttons[1] });
			assert.deepEqual(messages.at(-1), { action: 'source', renderId: 'render', questionId: '1' });
		});
	}
});