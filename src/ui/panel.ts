import { randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import * as vscode from 'vscode';
import { resolveResource, safeHttps } from '../core/course';
import { activityKey } from '../core/progress';
import type { Progress } from '../core/progress';
import { renderMarkdown } from './render';
import { activityLabel, activityStatus, completionSummary, unitLabel } from './status';
import type { Selection } from './tree';

const MAX_LESSON_BYTES = 1024 * 1024;
const ACTIONS = ['previous', 'next', 'complete', 'lab', 'quiz', 'check', 'explain', 'hint', 'reset', 'outputs'] as const;
type Action = typeof ACTIONS[number];
const TRUSTED_ACTIONS = new Set<Action>(['check', 'explain', 'hint', 'outputs']);

interface RenderState {
	id: string;
	selection: Selection;
	progress: Progress;
	blocked: Record<Action, string | undefined>;
	busy: boolean;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[character]!));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : 'The requested operation could not be completed.';
}

async function available(selection: Selection, relative: string | undefined): Promise<boolean> {
	if (!relative) { return false; }
	try { await resolveResource(selection.course.root, relative); return true; } catch { return false; }
}

/** Bounded reads also handle a file that grows after stat(), without allocating its full size. */
async function readLesson(selection: Selection): Promise<string> {
	const file = await resolveResource(selection.course.root, selection.unit.resources.lesson);
	const handle = await open(file, 'r');
	try {
		const info = await handle.stat();
		if (!info.isFile()) { throw new Error('The lesson must be a regular file.'); }
		if (info.size > MAX_LESSON_BYTES) { throw new Error('The lesson exceeds the 1 MB limit.'); }
		const bytes = Buffer.alloc(MAX_LESSON_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, null);
			if (result.bytesRead === 0) { break; }
			length += result.bytesRead;
		}
		if (length > MAX_LESSON_BYTES) { throw new Error('The lesson exceeds the 1 MB limit.'); }
		// Do not publish a read if a resource link was retargeted during the read.
		if (await resolveResource(selection.course.root, selection.unit.resources.lesson) !== file) {
			throw new Error('The lesson path changed while reading. Reopen the activity.');
		}
		return bytes.subarray(0, length).toString('utf8');
	} finally { await handle.close(); }
}

function canonicalSelection(selection: Selection): Selection {
	const unit = selection.course.manifest.units.find(candidate => candidate.unitId === selection.unit.unitId);
	const activity = unit?.activities.find(candidate => candidate.activityId === selection.activity.activityId);
	if (!unit || !activity) { throw new Error('The selected activity no longer exists in this course.'); }
	return { course: selection.course, unit, activity };
}

function resourceForAction(action: Action, selection: Selection): string | undefined {
	switch (action) {
		case 'complete': case 'explain': case 'hint': return selection.unit.resources.lesson;
		case 'lab': case 'outputs': return selection.unit.resources.lab;
		case 'quiz': return selection.unit.resources.quiz;
		case 'check': return selection.activity.check?.file;
		default: return undefined;
	}
}

/** One reusable panel. Execution, completion writes, and destructive confirmations belong to the host callback. */
export class ActivityPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private current: RenderState | undefined;
	private generation = '';
	private disposed = false;
	private panelListeners: vscode.Disposable[] = [];
	private readonly listeners: vscode.Disposable[];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onAction: (action: string, selection: Selection) => Promise<void>
	) {
		this.listeners = [vscode.workspace.onDidGrantWorkspaceTrust(() => {
			const current = this.current;
			if (current) { void this.show(current.selection, current.progress); }
		})];
	}

	private getPanel(): vscode.WebviewPanel {
		if (this.panel) { return this.panel; }
		const panel = vscode.window.createWebviewPanel('certLearner.activity', 'Learning activity', vscode.ViewColumn.One, {
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

	async show(input: Selection, progress: Progress): Promise<void> {
		if (this.disposed) { return; }
		const generation = randomUUID();
		this.generation = generation;
		this.current = undefined;
		try {
			const selection = canonicalSelection(input);
			if (progress.courseId !== selection.course.id) { throw new Error('Progress belongs to a different course/root.'); }
			const panel = this.getPanel();
			panel.title = selection.activity.title;
			panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One);
			panel.webview.html = this.document(panel.webview, generation, selection.activity.title,
				'<main aria-busy="true"><h1>Loading lesson…</h1><p role="status">Reading local course content.</p></main>');
			const [lesson, lab, quiz, check] = await Promise.all([
				readLesson(selection).then(source => ({ html: renderMarkdown(source), error: '' }),
					(error: unknown) => ({ html: '', error: errorText(error) })),
				available(selection, selection.unit.resources.lab),
				available(selection, selection.unit.resources.quiz),
				available(selection, selection.activity.check?.file)
			]);
			if (this.disposed || this.generation !== generation || this.panel !== panel) { return; }
			const activities = selection.course.manifest.units.flatMap(unit => unit.activities.map(activity => ({ unit, activity })));
			const index = activities.findIndex(candidate => candidate.unit.unitId === selection.unit.unitId &&
				candidate.activity.activityId === selection.activity.activityId);
			const completed = progress.completions[activityKey(selection.unit.unitId, selection.activity.activityId)]?.completedAt;
			const blocked: RenderState['blocked'] = {
				previous: index <= 0 ? 'This is the first activity.' : undefined,
				next: index >= activities.length - 1 ? 'This is the last activity.' : undefined,
				complete: selection.activity.completion === 'check' ? 'A passing check is required; manual completion is disabled.' :
					completed ? 'This activity is already complete.' : lesson.error ? 'The lesson is unavailable.' : undefined,
				lab: lab ? undefined : 'No accessible lab is declared for this unit.',
				quiz: quiz ? undefined : 'No accessible quiz is declared for this unit.',
				check: check ? undefined : 'No accessible check is declared for this activity.',
				explain: lesson.error ? 'The lesson is unavailable.' : undefined,
				hint: lesson.error ? 'The lesson is unavailable.' : undefined,
				reset: undefined,
				outputs: lab ? undefined : 'No accessible lab is declared for this unit.'
			};
			if (!vscode.workspace.isTrusted) {
				for (const action of TRUSTED_ACTIONS) {
					blocked[action] = [blocked[action], 'A trusted workspace is required.'].filter(Boolean).join(' ');
				}
			}
			const state: RenderState = { id: generation, selection, progress, blocked, busy: false };
			this.current = state;
			panel.webview.html = this.document(panel.webview, generation, selection.activity.title,
				this.content(state, lesson, index, activities.length), selection.course.manifest.language);
		} catch (error) {
			if (this.disposed || this.generation !== generation) { return; }
			this.current = undefined;
			if (this.panel) {
				this.panel.webview.html = this.document(this.panel.webview, generation, 'Activity unavailable',
					`<main><h1>Activity unavailable</h1><p role="alert">${escapeHtml(errorText(error))}</p><p>Reopen the activity to try again.</p></main>`);
			}
			await this.report(error);
		}
	}

	private isCurrent(panel: vscode.WebviewPanel, state: RenderState): boolean {
		return !this.disposed && this.panel === panel && this.current === state;
	}

	private async receive(panel: vscode.WebviewPanel, input: unknown): Promise<void> {
		const state = this.current;
		if (!state || !this.isCurrent(panel, state) || state.busy || !input || typeof input !== 'object' || Array.isArray(input)) { return; }
		const message = input as Record<string, unknown>;
		if (message.renderId !== state.id || typeof message.action !== 'string') { return; }
		const link = message.action === 'link';
		const keys = Object.keys(message);
		if (keys.length !== (link ? 3 : 2) || keys.some(key => !['action', 'renderId', ...(link ? ['href'] : [])].includes(key))) { return; }
		if (!link && !ACTIONS.includes(message.action as Action)) { return; }
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
			const action = message.action as Action;
			if (TRUSTED_ACTIONS.has(action) && !vscode.workspace.isTrusted) { throw new Error('This action requires a trusted workspace.'); }
			if (state.blocked[action]) { throw new Error(state.blocked[action]); }
			if (action === 'complete' && state.selection.activity.completion === 'check') { throw new Error('This activity requires a passing check.'); }
			const resource = resourceForAction(action, state.selection);
			if (resource) { await resolveResource(state.selection.course.root, resource); }
			if (!this.isCurrent(panel, state)) { return; }
			// Capture the selection from THIS render, never look it up after asynchronous work.
			await this.onAction(action, state.selection);
		} catch (error) {
			await this.report(error);
		} finally {
			state.busy = false;
			if (this.isCurrent(panel, state)) {
				try { await panel.webview.postMessage({ type: 'actionFinished', renderId: state.id }); } catch { /* Panel may have closed. */ }
			}
		}
	}

	private async report(error: unknown): Promise<void> {
		await vscode.window.showErrorMessage(`Cert Learner: ${errorText(error)}`);
	}

	private document(webview: vscode.Webview, renderId: string, title: string, content: string, language = 'en'): string {
		const nonce = randomBytes(24).toString('base64');
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'learning.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'learning.js'));
		const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
		return `<!DOCTYPE html>
<html lang="${escapeHtml(language)}">
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

	private button(state: RenderState, action: Action, label: string, primary = false): string {
		const reason = state.blocked[action];
		return `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-action="${action}"${reason ? ' disabled' : ''} title="${escapeHtml(reason ?? label)}" aria-label="${escapeHtml(reason ? `${label}. ${reason}` : label)}">${escapeHtml(label)}</button>`;
	}

	private content(state: RenderState, lesson: { html: string; error: string }, index: number, total: number): string {
		const { course, unit, activity } = state.selection;
		const { progress } = state;
		const record = progress.completions[activityKey(unit.unitId, activity.activityId)];
		const status = activityStatus(record);
		const summary = completionSummary(course, progress);
		const versionWarning = progress.contentVersion !== course.manifest.contentVersion
			? `<aside class="notice warning" role="note"><strong>Content version changed.</strong> Progress version: ${escapeHtml(progress.contentVersion)}. Current version: ${escapeHtml(course.manifest.contentVersion)}. Counts include only current activities; historical completions have not been revalidated.</aside>` : '';
		const outline = course.manifest.units.map(currentUnit => `<li><span class="unit-title">${escapeHtml(unitLabel(currentUnit))}</span><ol>${currentUnit.activities.map(currentActivity => {
			const current = currentUnit.unitId === unit.unitId && currentActivity.activityId === activity.activityId;
			const currentStatus = activityStatus(progress.completions[activityKey(currentUnit.unitId, currentActivity.activityId)]);
			return `<li${current ? ' aria-current="step"' : ''}><span>${escapeHtml(activityLabel(currentUnit, currentActivity))}</span><span class="outline-status">${current ? 'Current · ' : ''}${escapeHtml(currentStatus.label)}</span></li>`;
		}).join('')}</ol></li>`).join('');
		return `<a class="skip-link" href="#lesson">Skip to lesson</a>
<main>
<header class="activity-header">
<p class="eyebrow">${escapeHtml(course.manifest.title)}</p>
<p class="muted">${escapeHtml(unitLabel(unit))}${unit.domain ? ` · ${escapeHtml(unit.domain)}` : ''}</p>
<h1>${escapeHtml(activity.title)}</h1>
<div class="badges"><span class="badge ${status.tone}">${escapeHtml(status.label)}</span><span class="badge">${activity.completion === 'check' ? 'Check required' : 'Manual completion available'}</span><span class="badge">Activity ${index + 1} of ${total}</span></div>
${record?.lastResult ? `<p class="muted">Last check: ${escapeHtml(record.lastResult)}${record.attempts !== undefined ? ` · Attempts: ${record.attempts}` : ''}</p>` : ''}
</header>
${versionWarning}
<section class="progress-card" aria-labelledby="progress-heading">
<h2 id="progress-heading">Learning progress</h2>
<p><strong>${summary.completed} of ${summary.total}</strong> current activities completed. Activity counts, not an exam score.</p>
<progress max="${Math.max(1, summary.total)}" value="${summary.completed}" aria-label="Current course activities completed">${summary.completed} of ${summary.total}</progress>
<details class="outline"><summary>Ordered course progress</summary><ol>${outline}</ol></details>
</section>
<section class="objectives" aria-labelledby="objectives-heading">
<h2 id="objectives-heading">Current objectives</h2>
${activity.objectives.length ? `<ul>${activity.objectives.map(objective => `<li>${escapeHtml(objective)}</li>`).join('')}</ul>` : '<p class="muted">No objectives were declared for this activity.</p>'}
</section>
<aside class="notice" id="trust-notice" role="note">${vscode.workspace.isTrusted
			? 'Trusted workspace. Checks, Explain, Hint, and clearing lab outputs are handled by the extension, with any required confirmations. This panel never runs code.'
			: '<strong>Restricted Mode.</strong> Reading, navigation, manual completion, opening learning resources, and progress reset are permitted. Checks, Explain, Hint, and clearing lab outputs require a trusted workspace.'}</aside>
<section aria-labelledby="tools-heading">
<h2 id="tools-heading">Activity tools</h2>
<div class="actions" role="group" aria-label="Learning resources">
${this.button(state, 'lab', 'Open lab')}${this.button(state, 'quiz', 'Open quiz')}${this.button(state, 'explain', 'Explain')}${this.button(state, 'hint', 'Hint')}
</div>
<p class="muted">Unavailable resources are disabled. Labs open as native notebooks; opening a lab does not run cells. External lesson links require confirmation. Images and local links are not loaded.</p>
</section>
<article class="lesson" id="lesson" tabindex="-1" aria-labelledby="lesson-heading">
<h2 id="lesson-heading">Lesson</h2>
${lesson.error ? `<div class="notice danger" role="alert"><strong>Lesson unavailable.</strong> ${escapeHtml(lesson.error)}</div>` : lesson.html}
</article>
<section class="completion-card" aria-labelledby="completion-heading">
<h2 id="completion-heading">Completion</h2>
<p>${activity.completion === 'check' ? 'Only a passing check can complete this activity. Manual completion is disabled.' : 'Mark complete when ready. Manual completion is a self-reported learning record, not a verified check result.'}</p>
<div class="actions">${this.button(state, 'complete', 'Mark complete', true)}${this.button(state, 'check', 'Run check')}</div>
</section>
<nav class="activity-navigation" aria-label="Activity navigation">
${this.button(state, 'previous', 'Previous activity')}${this.button(state, 'next', 'Next activity', true)}
</nav>
<p class="muted">Previous and Next only navigate; they never mark an activity complete.</p>
<details class="maintenance"><summary>Progress and notebook maintenance</summary><p>Resetting progress removes completion records. Clearing lab outputs changes the notebook and requires trust. The extension handles confirmation before changes.</p><div class="actions">${this.button(state, 'reset', 'Reset progress')}${this.button(state, 'outputs', 'Clear lab outputs')}</div></details>
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
		for (const listener of this.listeners) { listener.dispose(); }
	}
}