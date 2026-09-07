import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveResource, safeHttps } from '../core/course';
import type { Course } from '../core/course';
import { gradeQuestion, loadQuiz, validateQuiz } from '../core/quiz';
import type { Quiz, QuizSelection } from '../core/quiz';
import { identifier, jsonSnapshot } from '../core/validation';
import { renderQuizView } from './quizRender';
import type { QuizPublicFeedback, QuizViewState } from './quizRender';

type Action = 'submit' | 'next' | 'previous' | 'summary' | 'restart' | 'source' | 'link';
interface Message { action: Action; renderId: string; questionId: string; selectedIds?: string[]; href?: string }
interface Attempt {
	quiz: Quiz;
	revision: string;
	position: number; // quiz.questions.length is the results screen.
	grades: Map<string, QuizPublicFeedback>;
}
interface RenderState {
	id: string;
	selection?: QuizSelection;
	attempt?: Attempt;
	sourceAvailable: boolean;
	busy: boolean;
	links: Set<string>;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[character]!));
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) { freeze(child); }
		Object.freeze(value);
	}
	return value;
}

/** The host passes a loaded Course. No manifest/lesson/progress files are read here.
 * Only the unit ID is accepted from the caller's unit; all metadata comes from a
 * detached, immutable snapshot of that registered course.
 */
function canonicalSelection(input: QuizSelection): QuizSelection {
	const descriptor = input?.unit && Object.getOwnPropertyDescriptor(input.unit, 'unitId');
	const unitId = identifier(descriptor && 'value' in descriptor ? descriptor.value : undefined, 'Quiz unit');
	const course = jsonSnapshot(input.course, 3 * 1024 * 1024, 'Loaded course') as Course;
	identifier(course.id, 'Course ID');
	if (typeof course.root !== 'string' || !path.isAbsolute(course.root) || !Array.isArray(course.manifest?.units)) {
		throw new Error('A loaded local course is required.');
	}
	const units = course.manifest.units.filter(unit => unit.unitId === unitId);
	if (units.length !== 1) { throw new Error('The quiz unit is not declared in this course.'); }
	return freeze({ course, unit: units[0] });
}

async function resolveSource(selection: QuizSelection): Promise<string> {
	const relative = selection.unit.resources.quiz;
	if (!relative || !/\.(?:md|json)$/iu.test(relative)) { throw new Error('No supported quiz source is declared.'); }
	const resolved = await resolveResource(selection.course.root, relative);
	if (path.extname(relative).toLowerCase() !== path.extname(resolved).toLowerCase()) {
		throw new Error('Quiz source extension changed.');
	}
	return resolved;
}

function parseMessage(input: unknown): Message | undefined {
	// Reject prototypes, accessors, sparse/extra-key arrays, symbols, and oversized
	// payloads without ever evaluating caller code. Unknown envelope keys fail closed.
	try {
		const message = jsonSnapshot(input, 8192, 'Quiz message') as Record<string, unknown>;
		if (!message || typeof message !== 'object' || Array.isArray(message)) { return; }
		const { action, renderId, questionId } = message;
		if (typeof action !== 'string' || !['submit', 'next', 'previous', 'summary', 'restart', 'source', 'link'].includes(action) ||
			typeof renderId !== 'string' || typeof questionId !== 'string') { return; }
		const keys = ['action', 'renderId', 'questionId', ...(action === 'submit' ? ['selectedIds'] : action === 'link' ? ['href'] : [])];
		if (Object.keys(message).length !== keys.length || Object.keys(message).some(key => !keys.includes(key))) { return; }
		if (action === 'submit' && (!Array.isArray(message.selectedIds) || message.selectedIds.length > 8 ||
			message.selectedIds.some(id => typeof id !== 'string' || id.length > 128))) { return; }
		if (action === 'link' && typeof message.href !== 'string') { return; }
		return message as unknown as Message;
	} catch { return; } // Malformed untrusted messages are not actions.
}

/** One interactive panel; grades never leave host memory except current feedback.
 * Dispose the controller with the extension. Closing only its webview retains attempts.
 */
export class QuizPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private current: RenderState | undefined;
	private generation = '';
	private disposed = false;
	private listeners: vscode.Disposable[] = [];
	private readonly attempts = new Map<string, Attempt>();
	private readonly revisions = new Map<string, string>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onOpenSource: (selection: QuizSelection) => Promise<void>
	) {}

	/** Registry changes invalidate every unit/revision, including closed attempts.
	 * Progress-only resets and unchanged registry refreshes must not call this.
	 */
	invalidateCourse(courseId: string): void {
		const belongsToCourse = (base: string): boolean => {
			const [id] = JSON.parse(base) as [string, string];
			return id === courseId;
		};
		for (const key of this.attempts.keys()) {
			// Attempt keys contain a JSON-encoded course/unit key, not the course ID.
			const [base] = JSON.parse(key) as [string, string];
			if (belongsToCourse(base)) { this.attempts.delete(key); }
		}
		for (const base of this.revisions.keys()) {
			if (belongsToCourse(base)) { this.revisions.delete(base); }
		}
		if (!this.disposed && this.panel && this.current?.selection?.course.id === courseId) {
			this.generation = randomUUID(); // Fence pending loads, actions and confirmations.
			this.publish(this.panel, undefined, undefined, false,
				'This course changed or was removed. Its quiz attempts have been cleared. Reopen the quiz from the course list to use the current course.');
		}
	}

	private getPanel(): vscode.WebviewPanel {
		if (this.panel) { return this.panel; }
		const panel = vscode.window.createWebviewPanel('certLearner.quiz', 'Practice quiz', vscode.ViewColumn.One, {
			enableScripts: true, enableForms: false, enableCommandUris: false,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			retainContextWhenHidden: false, enableFindWidget: true
		});
		this.panel = panel;
		this.listeners = [
			panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(panel, message); }),
			panel.onDidDispose(() => {
				if (this.panel !== panel) { return; }
				this.panel = undefined;
				this.current = undefined;
				this.generation = '';
				for (const listener of this.listeners.splice(0)) { listener.dispose(); }
			})
		];
		return panel;
	}

	async show(input: QuizSelection): Promise<void> {
		if (this.disposed) { return; }
		const generation = this.generation = randomUUID();
		this.current = undefined;
		const panel = this.getPanel();
		panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One);
		let selection: QuizSelection;
		try { selection = canonicalSelection(input); } catch {
			this.publish(panel, undefined, undefined, false);
			return;
		}
		this.publish(panel, selection, undefined, false, undefined, true);
		const loaded = await this.read(selection);
		if (!this.active(panel, generation)) { return; }
		const cached = this.cache(selection, loaded);
		this.publish(panel, selection, cached.attempt, loaded.sourceAvailable, cached.notice);
	}

	private active(panel: vscode.WebviewPanel, generation: string): boolean {
		return !this.disposed && this.panel === panel && this.generation === generation;
	}

	private isCurrent(panel: vscode.WebviewPanel, state: RenderState): boolean {
		return !this.disposed && this.panel === panel && this.current === state;
	}

	private async read(selection: QuizSelection): Promise<{ loaded?: Awaited<ReturnType<typeof loadQuiz>>; sourceAvailable: boolean }> {
		try {
			const loaded = await loadQuiz(selection);
			loaded.quiz = validateQuiz(loaded.quiz);
			// Recheck canonical containment after reading, including a swapped symlink.
			if (await resolveSource(selection) !== loaded.sourcePath) { throw new Error('Quiz path changed while reading.'); }
			return { loaded, sourceAvailable: true };
		} catch {
			// Do not echo parser/filesystem errors or any raw source/answer material.
			// Failure is rendered explicitly; resolving for Open source reads no content.
			try { await resolveSource(selection); return { sourceAvailable: true }; }
			catch { return { sourceAvailable: false }; }
		}
	}

	private cache(selection: QuizSelection, result: Awaited<ReturnType<QuizPanel['read']>>): { attempt?: Attempt; notice?: string } {
		const base = JSON.stringify([selection.course.id, selection.unit.unitId]);
		const old = this.revisions.get(base);
		const revision = result.loaded?.revision;
		if (old !== undefined && old !== revision) { this.attempts.delete(JSON.stringify([base, old])); }
		if (!result.loaded) {
			this.revisions.delete(base);
			return old === undefined ? {} : { notice: 'Quiz source changed or became unavailable. The previous attempt has been cleared.' };
		}
		this.revisions.set(base, revision!);
		const key = JSON.stringify([base, revision]);
		let attempt = this.attempts.get(key);
		if (!attempt) {
			attempt = { quiz: result.loaded.quiz, revision: revision!, position: 0, grades: new Map() };
			this.attempts.set(key, attempt);
		}
		return { attempt, ...(old !== undefined && old !== revision ? { notice: 'Quiz source changed. This attempt has been reset to use the new revision.' } : {}) };
	}

	private questionId(state: RenderState): string {
		return state.attempt?.quiz.questions[state.attempt.position]?.id ?? '';
	}

	/** Revalidate the declared source before grading/navigation; never apply an old
	 * click to a new revision, even if the author reused the question's ID.
	 */
	private async refresh(panel: vscode.WebviewPanel, state: RenderState): Promise<boolean> {
		if (!state.selection) { return false; }
		const result = await this.read(state.selection);
		if (!this.isCurrent(panel, state)) { return false; }
		const cached = this.cache(state.selection, result);
		if (cached.attempt !== state.attempt || !cached.attempt) {
			this.publish(panel, state.selection, cached.attempt, result.sourceAvailable, cached.notice);
			return false;
		}
		return true;
	}

	private async receive(panel: vscode.WebviewPanel, input: unknown): Promise<void> {
		const state = this.current;
		const message = parseMessage(input);
		if (!state?.selection || !message || !this.isCurrent(panel, state) || state.busy || message.renderId !== state.id ||
			message.questionId !== this.questionId(state)) { return; }
		const generation = this.generation;
		state.busy = true;
		try {
			if (message.action === 'source') {
				if (!state.selection || !state.sourceAvailable) { throw new Error('The quiz source is unavailable. Reopen the quiz to try again.'); }
				try { await resolveSource(state.selection); } catch {
					if (this.isCurrent(panel, state)) {
						this.cache(state.selection, { sourceAvailable: false });
						this.publish(panel, state.selection, undefined, false, 'The quiz source is no longer safely available. The previous attempt has been cleared.');
					}
					return;
				}
				if (this.isCurrent(panel, state)) { await this.onOpenSource(state.selection); }
				return;
			}
			if (message.action === 'link') {
				const href = message.href!;
				if (!safeHttps(href) || !state.links.has(href)) { throw new Error('Only safe HTTPS links from the displayed quiz can be opened.'); }
				const answer = await vscode.window.showInformationMessage(`Open external website: ${new URL(href).hostname}?`, {
					modal: true, detail: `This leaves Cert Learner and opens your browser.\n\n${href}`
				}, 'Open website');
				if (answer === 'Open website' && this.isCurrent(panel, state) && !await vscode.env.openExternal(vscode.Uri.parse(href, true))) {
					throw new Error('The external website could not be opened.');
				}
				return;
			}
			if (!await this.refresh(panel, state)) { return; }
			const attempt = state.attempt!;
			const question = attempt.quiz.questions[attempt.position];
			switch (message.action) {
				case 'submit': {
					if (!question || attempt.grades.has(question.id)) { break; }
					// gradeQuestion validates cardinality, uniqueness, and known IDs before scoring.
					const result = gradeQuestion(question, message.selectedIds);
					attempt.grades.set(question.id, {
						correct: result.correct, selectedIds: [...message.selectedIds!], explanation: result.explanation,
						correctChoices: question.options.filter(option => result.correctOptionIds.includes(option.id)).map(option => ({ ...option }))
					});
					break;
				}
				case 'previous': attempt.position = Math.max(0, attempt.position - 1); break;
				case 'next':
					if (question && attempt.grades.has(question.id)) { attempt.position++; }
					break;
				case 'summary':
					if (attempt.grades.size === attempt.quiz.questions.length) { attempt.position = attempt.quiz.questions.length; }
					break;
				case 'restart': {
					if (attempt.grades.size) {
						const answer = await vscode.window.showInformationMessage('Restart this quiz attempt?', {
							modal: true, detail: 'This clears this quiz’s in-memory answers and score. Course progress and your learning position are unchanged.'
						}, 'Restart quiz');
						if (!this.isCurrent(panel, state)) { return; }
						if (!await this.refresh(panel, state)) { return; }
						if (answer !== 'Restart quiz') { return; }
					}
					attempt.grades.clear();
					attempt.position = 0;
					break;
				}
			}
			if (this.isCurrent(panel, state)) { this.publish(panel, state.selection, attempt, true); }
		} catch (error) {
			if (this.isCurrent(panel, state)) {
				const detail = error instanceof Error ? error.message : 'The quiz action could not be completed.';
				await vscode.window.showErrorMessage(`Cert Learner: ${detail}`);
			}
		} finally {
			state.busy = false;
			// A rerender also unlocks the UI; acknowledge the old ID for deterministic
			// callers. New documents ignore it. Superseded/disposed sessions get nothing.
			if (this.active(panel, generation)) {
				try { await panel.webview.postMessage({ type: 'actionFinished', renderId: state.id }); }
				catch {
					if (this.active(panel, generation)) { await vscode.window.showErrorMessage('Cert Learner: Quiz action completed, but the panel could not be notified. Reopen the quiz.'); }
				}
			}
		}
	}

	private view(selection: QuizSelection | undefined, attempt: Attempt | undefined, sourceAvailable: boolean, notice?: string, loading = false): QuizViewState {
		const question = attempt?.quiz.questions[attempt.position];
		return {
			title: attempt?.quiz.title ?? 'Practice quiz', courseTitle: selection?.course.manifest.title ?? 'Local course',
			unitTitle: selection ? `${selection.unit.displayNumber} · ${selection.unit.title}` : 'Quiz unavailable',
			sourceAvailable, total: attempt?.quiz.questions.length ?? 0, answered: attempt?.grades.size ?? 0,
			correct: attempt ? [...attempt.grades.values()].filter(grade => grade.correct).length : 0, notice,
			content: loading ? { kind: 'loading' } : !attempt ? { kind: 'unavailable' } : question ? {
				kind: 'question', number: attempt.position + 1,
				question: { id: question.id, prompt: question.prompt, options: question.options.map(option => ({ ...option })), requiredSelections: question.correctOptionIds.length },
				feedback: attempt.grades.get(question.id)
			} : { kind: 'summary', results: attempt.quiz.questions.map(question => attempt.grades.get(question.id)?.correct ?? false) }
		};
	}

	private publish(panel: vscode.WebviewPanel, selection: QuizSelection | undefined, attempt: Attempt | undefined, sourceAvailable: boolean, notice?: string, loading = false): void {
		const state: RenderState = { id: randomUUID(), selection, attempt, sourceAvailable, busy: loading, links: new Set() };
		const view = this.view(selection, attempt, sourceAvailable, notice, loading);
		const html = this.document(panel.webview, state.id, this.questionId(state), view);
		// Capture only links actually published by the sanitized renderer, not links
		// in unrevealed explanations, other questions, or caller-provided fields.
		for (const match of html.matchAll(/<a\b[^>]*data-href="([^"]+)"/gu)) {
			state.links.add(match[1].replace(/&(?:amp|lt|gt|quot|#39);/gu, entity => ({
				'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"
			}[entity]!)));
		}
		this.current = state;
		panel.title = attempt?.quiz.title ?? 'Interactive quiz unavailable';
		panel.webview.html = html;
	}

	private document(webview: vscode.Webview, renderId: string, questionId: string, view: QuizViewState): string {
		const nonce = randomBytes(24).toString('base64');
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const asset = (name: string) => escapeHtml(webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString());
		const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
		return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>${escapeHtml(view.title)}</title>
<link rel="stylesheet" href="${asset('learning.css')}"><link rel="stylesheet" href="${asset('quiz.css')}">
<script nonce="${nonce}" src="${asset('quiz.js')}" defer></script></head>
<body data-render-id="${escapeHtml(renderId)}" data-question-id="${escapeHtml(questionId)}">${renderQuizView(view)}</body></html>`;
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.current = undefined;
		this.generation = '';
		this.attempts.clear();
		this.revisions.clear();
		this.panel?.dispose();
		this.panel = undefined;
		for (const listener of this.listeners.splice(0)) { listener.dispose(); }
	}
}