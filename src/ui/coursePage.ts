import { randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveResource, safeHttps } from '../core/course';
import { getCoursePages } from '../core/pages';
import type { CoursePageSelection } from '../core/pages';
import { renderMarkdown } from './render';

const MAX_PAGE_BYTES = 1024 * 1024;

interface RenderState {
	id: string;
	selection: CoursePageSelection;
	available: boolean;
	busy: boolean;
}

interface PageContent {
	html: string;
	error: string;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[character]!));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : 'The requested page could not be read.';
}

function canonicalSelection(input: CoursePageSelection): CoursePageSelection {
	const page = getCoursePages(input.course).find(candidate => candidate.id === input.page.id);
	if (!page) { throw new Error('The selected page no longer exists in this course.'); }
	// Never use a caller-supplied path or title instead of the declared page.
	return { course: input.course, page };
}

async function resolvePage(selection: CoursePageSelection): Promise<string> {
	const file = await resolveResource(selection.course.root, selection.page.path);
	if (path.extname(selection.page.path).toLowerCase() !== '.md' || path.extname(file).toLowerCase() !== '.md') {
		throw new Error('Course pages must be Markdown (.md) files, including symlink targets.');
	}
	return file;
}

/** Bounded even if a page grows after stat(); recheck its resolved path before publication. */
async function readPage(selection: CoursePageSelection): Promise<string> {
	const file = await resolvePage(selection);
	const handle = await open(file, 'r');
	try {
		const info = await handle.stat();
		if (!info.isFile()) { throw new Error('The course page must be a regular file.'); }
		if (info.size > MAX_PAGE_BYTES) { throw new Error('The course page exceeds the 1 MB limit.'); }
		const bytes = Buffer.alloc(MAX_PAGE_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, null);
			if (result.bytesRead === 0) { break; }
			length += result.bytesRead;
		}
		if (length > MAX_PAGE_BYTES) { throw new Error('The course page exceeds the 1 MB limit.'); }
		if (await resolvePage(selection) !== file) {
			throw new Error('The page path changed while reading. Reopen the page.');
		}
		return bytes.subarray(0, length).toString('utf8');
	} finally { await handle.close(); }
}

/** One read-only reference panel. No progress access, completion writes, or code execution. */
export class CoursePagePanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private current: RenderState | undefined;
	private generation = '';
	private disposed = false;
	private panelListeners: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onOpenSource: (selection: CoursePageSelection) => Promise<void>
	) {}

	private getPanel(): vscode.WebviewPanel {
		if (this.panel) { return this.panel; }
		const panel = vscode.window.createWebviewPanel('certLearner.page', 'Course page', vscode.ViewColumn.One, {
			enableScripts: true,
			enableForms: false,
			enableCommandUris: false,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			retainContextWhenHidden: false,
			enableFindWidget: true
		});
		this.panel = panel;
		this.panelListeners = [
			panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(panel, message); }),
			panel.onDidDispose(() => {
				if (this.panel !== panel) { return; }
				this.panel = undefined;
				this.current = undefined;
				this.generation = '';
				for (const listener of this.panelListeners.splice(0)) { listener.dispose(); }
			})
		];
		return panel;
	}

	async show(input: CoursePageSelection): Promise<void> {
		if (this.disposed) { return; }
		const generation = randomUUID();
		this.generation = generation;
		this.current = undefined;
		const panel = this.getPanel();
		panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One);
		try {
			const selection = canonicalSelection(input);
			panel.title = selection.page.title;
			panel.webview.html = this.document(panel.webview, generation, selection.page.title,
				`<main aria-busy="true">${this.header(selection)}<p role="status">Loading local course page…</p></main>`);
			const content = await readPage(selection).then(
				source => ({ html: renderMarkdown(source), error: '' }),
				(error: unknown) => ({ html: '', error: errorText(error) })
			);
			if (this.disposed || this.generation !== generation || this.panel !== panel) { return; }
			const state: RenderState = { id: generation, selection, available: !content.error, busy: false };
			this.current = state;
			panel.webview.html = this.document(panel.webview, generation, selection.page.title, this.content(state, content));
		} catch (error) {
			if (this.disposed || this.generation !== generation || this.panel !== panel) { return; }
			this.current = undefined;
			panel.title = 'Course page unavailable';
			panel.webview.html = this.document(panel.webview, generation, 'Course page unavailable',
				`<main><h1>Course page unavailable</h1><p role="alert">${escapeHtml(errorText(error))}</p><p>Reopen the page to try again.</p>${this.notice()}</main>`);
		}
	}

	private isCurrent(panel: vscode.WebviewPanel, state: RenderState): boolean {
		return !this.disposed && this.panel === panel && this.current === state && this.generation === state.id;
	}

	private async receive(panel: vscode.WebviewPanel, input: unknown): Promise<void> {
		const state = this.current;
		if (!state || !this.isCurrent(panel, state) || state.busy || !input || typeof input !== 'object' || Array.isArray(input)) { return; }
		const prototype: unknown = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) { return; }
		const keys = Reflect.ownKeys(input);
		// Reject extra fields, symbols, and accessor-backed messages before reading values.
		if (keys.some(key => typeof key !== 'string' || !['action', 'renderId', 'href'].includes(key) ||
			!Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input, key), 'value'))) { return; }
		const message = input as Record<string, unknown>;
		if (message.renderId !== state.id || (message.action !== 'source' && message.action !== 'link')) { return; }
		const link = message.action === 'link';
		if (keys.length !== (link ? 3 : 2) || (!link && keys.includes('href'))) { return; }
		state.busy = true;
		try {
			if (link) {
				const href = message.href;
				if (typeof href !== 'string' || !safeHttps(href)) { throw new Error('Only safe HTTPS links can be opened.'); }
				const hostname = new URL(href).hostname;
				const answer = await vscode.window.showInformationMessage(`Open external website: ${hostname}?`, {
					modal: true,
					detail: `This leaves Cert Learner and opens your browser.\n\n${href}`
				}, 'Open website');
				if (answer === 'Open website' && this.isCurrent(panel, state)) {
					if (!await vscode.env.openExternal(vscode.Uri.parse(href, true))) { throw new Error('The external website could not be opened.'); }
				}
				return;
			}
			if (!state.available) { throw new Error('The course page is unavailable. Reopen the page to try again.'); }
			await resolvePage(state.selection);
			if (!this.isCurrent(panel, state)) { return; }
			// The host validates this captured selection against freshly loaded course data.
			await this.onOpenSource(state.selection);
		} catch (error) {
			if (this.isCurrent(panel, state)) { await vscode.window.showErrorMessage(`Cert Learner: ${errorText(error)}`); }
		} finally {
			state.busy = false;
			if (this.isCurrent(panel, state)) {
				try { await panel.webview.postMessage({ type: 'actionFinished', renderId: state.id }); } catch { /* Panel may have closed. */ }
			}
		}
	}

	private document(webview: vscode.Webview, renderId: string, title: string, content: string): string {
		const nonce = randomBytes(24).toString('base64');
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'learning.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'learning.js'));
		const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(css.toString())}">
<script nonce="${nonce}" src="${escapeHtml(script.toString())}" defer></script>
</head>
<body data-render-id="${escapeHtml(renderId)}">${content}</body>
</html>`;
	}

	private notice(): string {
		return '<aside class="notice" role="note"><strong>Reference page · Not tracked.</strong> Reading or opening the source does not change learning progress. This panel never runs code or performs cleanup. Any commands or cleanup instructions in this page must be reviewed and run separately by you.</aside>';
	}

	private header(selection: CoursePageSelection): string {
		return `<header class="activity-header"><p class="eyebrow">${escapeHtml(selection.course.manifest.title)}</p><h1>${escapeHtml(selection.page.title)}</h1><div class="badges"><span class="badge">Reference · Not tracked</span></div></header>${this.notice()}`;
	}

	private content(state: RenderState, page: PageContent): string {
		return `<a class="skip-link" href="#lesson">Skip to page content</a>
<main>
${this.header(state.selection)}
<div class="actions" role="group" aria-label="Page source">
<button type="button" class="secondary" data-action="source"${state.available ? '' : ' disabled'} title="${state.available ? 'Open source' : 'The course page is unavailable.'}" aria-label="Open source">Open source</button>
</div>
<p class="muted">External links require confirmation. Images and local links are not loaded.</p>
<article class="lesson" id="lesson" tabindex="-1" aria-labelledby="page-heading">
<h2 id="page-heading">Page content</h2>
${page.error ? `<div class="notice danger" role="alert"><strong>Page unavailable.</strong> ${escapeHtml(page.error)}<p>Reopen the page to try again.</p></div>` : page.html}
</article>
<p id="action-status" class="muted" role="status" aria-live="polite" aria-atomic="true"></p>
</main>`;
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.current = undefined;
		this.generation = '';
		this.panel?.dispose();
		this.panel = undefined;
		for (const listener of this.panelListeners.splice(0)) { listener.dispose(); }
	}
}