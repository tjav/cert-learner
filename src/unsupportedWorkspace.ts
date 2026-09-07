import * as vscode from 'vscode';
import { contributes } from '../package.json';
import type { CertLearnerApi } from './extension';

export const LOCAL_WORKSPACE_GUIDANCE = 'Cert Learner needs a local desktop folder and local extension storage. ' +
	'Agent Host/Copilot virtual workspaces and remote workspaces are not supported for learning. ' +
	'Open a folder on this computer in a regular VS Code window (File > Open Folder), then run Learning: Add Course. ' +
	'No courses or progress were loaded or changed.';

/** Check schemes before touching fsPath; never relocate nonlocal progress to global storage. */
export function needsLocalWorkspace(context: vscode.ExtensionContext, storage: vscode.Uri): boolean {
	const folders = vscode.workspace.workspaceFolders ?? [];
	return storage.scheme !== 'file' || context.extensionUri.scheme !== 'file' ||
		Boolean(vscode.env.remoteName) || vscode.env.uiKind === vscode.UIKind.Web ||
		(folders.length > 0 && folders.every(folder => folder.uri.scheme !== 'file')) ||
		Boolean(vscode.workspace.workspaceFile && !['file', 'untitled'].includes(vscode.workspace.workspaceFile.scheme));
}

/** Recovery UI only: no filesystem, course registry, checks, cloning, or state access. */
export class UnsupportedWorkspace implements CertLearnerApi, vscode.Disposable {
	private readonly listeners: vscode.Disposable[] = [];
	private disposed = false;
	private pending: Promise<void> | undefined;

	constructor() {
		// The manifest is bundled data, not a read of a workspace file. Cover every
		// advertised command so forced activation in unusual hosts cannot leave dead commands.
		for (const { command } of contributes.commands) {
			this.listeners.push(vscode.commands.registerCommand(command, () =>
				command === 'certLearner.getState' ? this.getState() : this.explain()));
		}
		try {
			const item = new vscode.TreeItem('Open a local folder to use Cert Learner', vscode.TreeItemCollapsibleState.None);
			item.command = { command: 'certLearner.add', title: 'Open a local folder' };
			item.tooltip = LOCAL_WORKSPACE_GUIDANCE;
			const treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
				getTreeItem: entry => entry,
				getChildren: entry => entry ? [] : [item]
			};
			const view = vscode.window.createTreeView('certLearner.courses', { treeDataProvider });
			this.listeners.push(view);
			view.message = LOCAL_WORKSPACE_GUIDANCE;
		} catch { /* Some Agent Hosts have no tree UI. Keep commands usable. */ }
		try {
			if (typeof vscode.chat?.createChatParticipant === 'function') {
				this.listeners.push(vscode.chat.createChatParticipant('certLearner.tutor', async (_request, _history, stream) => {
					if (!this.disposed) { stream.markdown(LOCAL_WORKSPACE_GUIDANCE); }
				}));
			}
		} catch { /* The tutor is optional; recovery must not depend on chat support. */ }
	}

	private explain(): Promise<void> {
		if (this.disposed) { return Promise.resolve(); }
		this.pending ??= this.openLocalFolder().finally(() => { this.pending = undefined; });
		return this.pending;
	}

	private async openLocalFolder(): Promise<void> {
		try {
			const answer = await vscode.window.showInformationMessage(LOCAL_WORKSPACE_GUIDANCE, 'Open local folder...');
			if (this.disposed || answer !== 'Open local folder...') { return; }
			const folders = await vscode.window.showOpenDialog({
				// A file-scheme root selects the local picker, not the virtual workspace provider.
				// Do not derive this from a remote home, storage path, or workspace URI.
				defaultUri: vscode.Uri.file('/'),
				canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
				openLabel: 'Open local folder in new window', title: 'Choose a local folder for Cert Learner'
			});
			if (this.disposed || !folders?.[0]) { return; }
			if (folders[0].scheme !== 'file') {
				await vscode.window.showWarningMessage('Choose a folder on your local filesystem, not a virtual or remote folder. ' + LOCAL_WORKSPACE_GUIDANCE);
				return;
			}
			// Preserve the current window and its unsaved work. Never auto-clone or
			// transfer course registrations/progress into the new workspace.
			await vscode.commands.executeCommand('vscode.openFolder', folders[0], { forceNewWindow: true });
		} catch {
			if (!this.disposed) {
				await Promise.resolve(vscode.window.showWarningMessage('The host could not open a local folder. ' + LOCAL_WORKSPACE_GUIDANCE)).catch(() => undefined);
			}
		}
	}

	async refresh(): Promise<never> { throw new Error(LOCAL_WORKSPACE_GUIDANCE); }
	async addCourse(): Promise<never> { throw new Error(LOCAL_WORKSPACE_GUIDANCE); }
	async openPage(): Promise<never> { throw new Error(LOCAL_WORKSPACE_GUIDANCE); }
	async openUnitResource(): Promise<never> { throw new Error(LOCAL_WORKSPACE_GUIDANCE); }
	getCourses(): [] { return []; }
	async getState() { return { courses: [], current: undefined, unavailable: LOCAL_WORKSPACE_GUIDANCE }; }

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const disposable of this.listeners.splice(0)) {
			try { disposable.dispose(); } catch { /* Release the remaining subscriptions. */ }
		}
	}
}