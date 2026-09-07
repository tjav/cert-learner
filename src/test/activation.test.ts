import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInThisContext } from 'node:vm';
import { describe, it } from 'mocha';
import type * as vscode from 'vscode';
import { capabilities, contributes } from '../../package.json';
import type { CertLearnerApi } from '../extension';

class TestUri {
	constructor(readonly scheme: string, readonly path = '/do-not-read') {}
	get fsPath(): string { assert.equal(this.scheme, 'file', 'Never coerce virtual URIs into local paths'); return this.path; }
	toString(): string { return `${this.scheme}:${this.path}`; }
}

class Host {
	readonly commands = new Map<string, (...args: unknown[]) => unknown>();
	readonly notices: string[] = [];
	readonly warnings: string[] = [];
	readonly executed: { command: string; args: unknown[] }[] = [];
	readonly forbidden: string[] = [];
	readonly dialogs: vscode.OpenDialogOptions[] = [];
	readonly folderListeners = new Set<() => void>();
	readonly views: { message?: string; disposed: boolean; provider: vscode.TreeDataProvider<vscode.TreeItem> }[] = [];
	tutor: vscode.ChatRequestHandler | undefined;
	answer: () => Promise<string | undefined> = async () => undefined;
	pick: () => Promise<TestUri[] | undefined> = async () => undefined;
	failTree = false;
	failChat = false;
	failOpen = false;
	readonly context = {
		storageUri: new TestUri('agent-host-copilotcli') as TestUri | undefined,
		globalStorageUri: new TestUri('file', '/private-global'), extensionUri: new TestUri('file', '/extension'),
		subscriptions: [] as vscode.Disposable[],
		workspaceState: { get: () => this.deny('workspaceState.get'), update: () => this.deny('workspaceState.update') },
		globalState: { get: () => this.deny('globalState.get'), update: () => this.deny('globalState.update') }
	};
	readonly workspace = {
		onDidChangeWorkspaceFolders: (listener: () => void) => {
			this.folderListeners.add(listener);
			return { dispose: () => { this.folderListeners.delete(listener); } };
		},
		workspaceFolders: [{ uri: new TestUri('agent-host-copilotcli') }] as { uri: TestUri }[] | undefined,
		workspaceFile: undefined as TestUri | undefined,
		isTrusted: true
	};
	readonly env = { remoteName: undefined as string | undefined, uiKind: 1 };
	readonly api = {
		workspace: this.workspace, env: this.env, UIKind: { Desktop: 1, Web: 2 },
		Uri: { file: (value: string) => new TestUri('file', value), joinPath: (base: TestUri, ...parts: string[]) => new TestUri(base.scheme, path.posix.join(base.path, ...parts)) },
		TreeItemCollapsibleState: { None: 0 },
		TreeItem: class { constructor(readonly label: string, readonly collapsibleState: number) {} },
		commands: {
			registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
				assert.equal(this.commands.has(command), false, 'No duplicate command registrations');
				this.commands.set(command, callback);
				return { dispose: () => { this.commands.delete(command); } };
			},
			executeCommand: async (command: string, ...args: unknown[]) => {
				this.executed.push({ command, args });
				if (this.failOpen) { throw new Error('HOST_PATH_OR_TOKEN_MUST_NOT_APPEAR'); }
			}
		},
		window: {
			createOutputChannel: () => this.deny('learning constructor'),
			createTreeView: (_id: string, options: { treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem> }) => {
				if (this.failTree) { throw new Error('Tree UI unavailable'); }
				const view = { disposed: false, provider: options.treeDataProvider };
				this.views.push(view);
				return Object.assign(view, { dispose: () => { view.disposed = true; } });
			},
			showInformationMessage: async (message: string) => { this.notices.push(message); return this.answer(); },
			showWarningMessage: async (message: string) => { this.warnings.push(message); },
			showErrorMessage: () => this.deny('activation error'),
			showOpenDialog: async (options: vscode.OpenDialogOptions) => {
				this.dialogs.push(options);
				assert.equal(options.defaultUri?.scheme, 'file', 'Recovery must choose the local picker, not the current virtual provider');
				return this.pick();
			}
		},
		chat: { createChatParticipant: (_id: string, handler: vscode.ChatRequestHandler) => {
			if (this.failChat) { throw new Error('Chat unavailable'); }
			this.tutor = handler;
			return { dispose: () => { this.tutor = undefined; } };
		} }
	};
	deny(name: string): never { this.forbidden.push(name); throw new Error(`Unexpected access: ${name}`); }
	async command(name: string, ...args: unknown[]): Promise<unknown> {
		const handler = this.commands.get(`certLearner.${name}`);
		assert.ok(handler, `${name} must be registered`);
		return handler(...args);
	}
}

/** Real compiled activation and relative modules, isolated VS Code boundary.
 * Filesystem/process operations from the extension fail; no global cache mutation.
 */
function load<T>(entry: string, host: Host): T {
	const cache = new Map<string, { exports: unknown }>();
	function source(filename: string): unknown {
		if (cache.has(filename)) { return cache.get(filename)!.exports; }
		const module = { exports: {} };
		cache.set(filename, module);
		const requireFile = createRequire(filename);
		const execute = runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${readFileSync(filename, 'utf8')}\n})`,
			{ filename }) as (exports: object, require: (id: string) => unknown, module: object, filename: string, dirname: string) => void;
		execute(module.exports, id => {
			if (id === 'vscode') { return host.api; }
			if (['node:fs/promises', 'node:child_process'].includes(id)) {
				return new Proxy({}, { get: (_target, property) => property === '__esModule' ? false : () => host.deny(`${id}.${String(property)}`) });
			}
			if (id.startsWith('.') && !id.endsWith('.json')) { return source(requireFile.resolve(id)); }
			return requireFile(id);
		}, module, filename, path.dirname(filename));
		return module.exports;
	}
	return source(path.join(__dirname, '..', entry)) as T;
}

async function activated(host: Host): Promise<{ module: typeof import('../extension'); api: CertLearnerApi }> {
	const module = load<typeof import('../extension')>('extension.js', host);
	const api = await module.activate(host.context as unknown as vscode.ExtensionContext);
	return { module, api };
}

describe('Activation in unsupported virtual/Agent Host workspaces', () => {
	it('declares recovery-only virtual capability rather than promising virtual learning', () => {
		assert.equal(capabilities.virtualWorkspaces.supported, 'limited');
		assert.match(capabilities.virtualWorkspaces.description, /Recovery guidance only/u);
	});

	for (const scheme of ['agent-host-copilotcli', 'vscode-remote', 'vscode-vfs']) {
		it(`registers every contributed command for ${scheme} storage without filesystem or state access`, async () => {
			const host = new Host();
			host.context.storageUri = new TestUri(scheme);
			const { module, api } = await activated(host);
			try {
				assert.deepEqual([...host.commands.keys()].sort(), contributes.commands.map(x => x.command).sort());
				assert.deepEqual(host.notices, [], 'No startup popup or automatic folder selection');
				const state = await api.getState();
				assert.match(state.unavailable!, /local desktop folder/u);
				assert.deepEqual(state.courses, []);
				assert.equal(state.current, undefined);
				assert.equal(JSON.stringify(state).includes('/private-global'), false);
				for (const { command } of contributes.commands) { await host.command(command.slice('certLearner.'.length), { root: 'do-not-read' }); }
				assert.equal(host.notices.length, contributes.commands.length - 1, 'getState is quiet, UI commands explain');
				assert.deepEqual(host.dialogs, []);
				assert.deepEqual(host.executed, []);
				assert.deepEqual(host.forbidden, []);
			} finally { module.deactivate(); }
			for (const item of host.context.subscriptions) { item.dispose(); }
			assert.equal(host.commands.size, 0);
			assert.equal(host.folderListeners.size, 0);
			assert.equal(host.views[0].disposed, true);
			assert.equal(host.tutor, undefined);
		});
	}

	it('does not fall back to global storage when workspace storage is virtual', async () => {
		const host = new Host();
		host.workspace.workspaceFolders = [{ uri: new TestUri('file') }];
		const { module, api } = await activated(host);
		try { assert.ok((await api.getState()).unavailable); assert.deepEqual(host.forbidden, []); }
		finally { module.deactivate(); }
	});

	it('handles virtual global storage with no workspace storage', async () => {
		const host = new Host();
		host.context.storageUri = undefined;
		host.context.globalStorageUri = new TestUri('agent-host-copilotcli');
		host.workspace.workspaceFolders = undefined;
		const { module, api } = await activated(host);
		try { assert.ok((await api.getState()).unavailable); assert.deepEqual(host.forbidden, []); }
		finally { module.deactivate(); }
	});

	it('blocks virtual-only roots even when extension storage happens to be local', async () => {
		const host = new Host();
		host.context.storageUri = new TestUri('file');
		const { module, api } = await activated(host);
		try { assert.ok((await api.getState()).unavailable); assert.deepEqual(host.forbidden, []); }
		finally { module.deactivate(); }
	});

	it('retains local, mixed-root and empty-window selection without inspecting virtual fsPath', () => {
		const host = new Host();
		const { needsLocalWorkspace } = load<typeof import('../unsupportedWorkspace')>('unsupportedWorkspace.js', host);
		const context = host.context as unknown as vscode.ExtensionContext;
		const storage = new TestUri('file') as unknown as vscode.Uri;
		for (const folders of [undefined, [], [{ uri: new TestUri('file') }], [{ uri: new TestUri('file') }, { uri: new TestUri('agent-host-copilotcli') }]]) {
			host.workspace.workspaceFolders = folders;
			assert.equal(needsLocalWorkspace(context, storage), false);
		}
		host.workspace.workspaceFile = new TestUri('untitled');
		assert.equal(needsLocalWorkspace(context, storage), false);
		host.workspace.workspaceFile = new TestUri('agent-host-copilotcli');
		assert.equal(needsLocalWorkspace(context, storage), true);
		host.workspace.workspaceFile = undefined;
		host.env.remoteName = 'ssh-remote';
		assert.equal(needsLocalWorkspace(context, storage), true);
		host.env.remoteName = undefined;
		host.env.uiKind = 2;
		assert.equal(needsLocalWorkspace(context, storage), true);
		host.env.uiKind = 1;
		host.context.extensionUri = new TestUri('agent-host-copilotcli');
		assert.equal(needsLocalWorkspace(context, storage), true);
	});

	it('renders actionable tree guidance and an inert tutor without loading courses', async () => {
		const host = new Host();
		const { module, api } = await activated(host);
		try {
			const view = host.views[0];
			assert.match(view.message!, /File > Open Folder/u);
			const children = await view.provider.getChildren();
			assert.equal(children!.length, 1);
			const item = await view.provider.getTreeItem(children![0]);
			assert.equal(item.command!.command, 'certLearner.add');
			assert.deepEqual(await view.provider.getChildren(item), []);
			const messages: unknown[] = [];
			await host.tutor!({} as vscode.ChatRequest, {} as vscode.ChatContext,
				{ markdown: (text: unknown) => { messages.push(text); } } as unknown as vscode.ChatResponseStream, {} as vscode.CancellationToken);
			assert.deepEqual(messages, [(await api.getState()).unavailable]);
			assert.deepEqual(host.forbidden, []);
		} finally { module.deactivate(); }
	});

	it('rejects programmatic mutations explicitly and returns detached empty snapshots', async () => {
		const host = new Host();
		const { module, api } = await activated(host);
		try {
			for (const call of [() => api.refresh(), () => api.addCourse('/do-not-read'),
				() => api.openPage({ courseId: 'x', pageId: 'x' }), () => api.openUnitResource({ courseId: 'x', unitId: 'x' }, 'lab')]) {
				await assert.rejects(call(), /local desktop folder/u);
			}
			assert.notEqual(api.getCourses(), api.getCourses());
			assert.notEqual(await api.getState(), await api.getState());
			assert.deepEqual(host.forbidden, []);
		} finally { module.deactivate(); }
	});

	it('opens only an explicitly chosen file folder in a NEW window without registrations or transfers', async () => {
		const host = new Host();
		host.answer = async () => 'Open local folder...';
		const folder = new TestUri('file', '/chosen-folder');
		host.pick = async () => [folder];
		const { module } = await activated(host);
		try {
			await host.command('addGitHub');
			assert.equal(host.dialogs[0].canSelectFiles, false);
			assert.equal(host.dialogs[0].canSelectFolders, true);
			assert.equal(host.dialogs[0].canSelectMany, false);
			assert.deepEqual(host.executed, [{ command: 'vscode.openFolder', args: [folder, { forceNewWindow: true }] }]);
			assert.deepEqual(host.forbidden, []);
		} finally { module.deactivate(); }
	});

	it('handles canceled and virtual folder selections, without opening or coercing paths', async () => {
		const host = new Host();
		host.answer = async () => 'Open local folder...';
		const { module } = await activated(host);
		try {
			await host.command('add');
			host.pick = async () => [new TestUri('agent-host-copilotcli')];
			await host.command('add');
			assert.equal(host.warnings.length, 1);
			assert.deepEqual(host.executed, []);
			assert.deepEqual(host.forbidden, []);
		} finally { module.deactivate(); }
	});

	it('survives missing tree/chat APIs and sanitizes open-folder host failures', async () => {
		const host = new Host();
		host.failTree = true; host.failChat = true; host.failOpen = true;
		host.answer = async () => 'Open local folder...';
		host.pick = async () => [new TestUri('file')];
		const { module } = await activated(host);
		try {
			await host.command('add');
			assert.match(host.warnings[0], /host could not open a local folder/u);
			assert.equal(host.warnings[0].includes('HOST_PATH_OR_TOKEN'), false);
			assert.equal(host.commands.size, contributes.commands.length);
		} finally { module.deactivate(); }
	});

	it('coalesces concurrent commands and ignores a pending dialog after disposal', async () => {
		const host = new Host();
		let resolve!: (answer: string) => void;
		host.answer = () => new Promise(done => { resolve = done; });
		const { module } = await activated(host);
		const first = host.command('add');
		const second = host.command('sample');
		assert.equal(host.notices.length, 1);
		module.deactivate();
		resolve('Open local folder...');
		await Promise.all([first, second]);
		assert.deepEqual(host.dialogs, []);
		assert.deepEqual(host.executed, []);
		assert.equal(host.commands.size, 0);
	});
});