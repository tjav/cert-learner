import { renderMarkdown } from './render';

/** Public presentation data only. Never pass a Quiz or an ungraded explanation here. */
export interface QuizPublicQuestion {
	id: string;
	prompt: string;
	options: readonly { id: string; text: string }[];
	requiredSelections: number;
}

export interface QuizPublicFeedback {
	correct: boolean;
	selectedIds: readonly string[];
	correctChoices: readonly { id: string; text: string }[];
	explanation: string;
}

export interface QuizViewState {
	title: string;
	courseTitle: string;
	unitTitle: string;
	sourceAvailable: boolean;
	total: number;
	answered: number;
	correct: number;
	notice?: string;
	content:
		| { kind: 'question'; number: number; question: QuizPublicQuestion; feedback?: QuizPublicFeedback }
		| { kind: 'summary'; results: readonly boolean[] }
		| { kind: 'unavailable' }
		| { kind: 'loading' };
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[character]!));
}

function button(action: string, label: string, enabled = true, primary = false): string {
	return `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-action="${action}"${enabled ? '' : ' disabled'}>${label}</button>`;
}

function questionView(content: Extract<QuizViewState['content'], { kind: 'question' }>, total: number): string {
	const { question, feedback, number } = content;
	const multi = question.requiredSelections > 1;
	const choices = question.options.map((option, index) => {
		// DOM IDs are generated indexes, never author-controlled IDs or markup.
		const chosen = feedback?.selectedIds.includes(option.id) ?? false;
		return `<div class="quiz-choice${chosen ? ' is-selected' : ''}">
<input id="choice-${index}" type="${multi ? 'checkbox' : 'radio'}" name="quiz-choice" value="${escapeHtml(option.id)}" aria-labelledby="choice-label-${index} choice-text-${index}"${chosen ? ' checked' : ''}${feedback ? ' disabled' : ''}>
<div class="quiz-choice-body"><label id="choice-label-${index}" for="choice-${index}"><span class="quiz-choice-marker">${escapeHtml(option.id)}</span><span class="sr-only">. </span></label><div class="lesson quiz-choice-text" id="choice-text-${index}">${renderMarkdown(option.text)}</div></div>
</div>`;
	}).join('\n');
	const instructions = multi
		? `Select exactly ${question.requiredSelections} choices, then check your answer.`
		: 'Select one choice. Your answer is checked immediately.';
	return `<section class="quiz-card" aria-labelledby="question-heading">
<h2 id="question-heading" tabindex="-1">Question ${number} of ${total}</h2>
<div class="lesson quiz-prompt" id="question-prompt">${renderMarkdown(question.prompt)}</div>
<fieldset id="quiz-choices" data-required="${question.requiredSelections}" data-graded="${Boolean(feedback)}" aria-describedby="question-prompt selection-help">
<legend>${multi ? 'Choose multiple answers' : 'Choose one answer'}</legend>
<p class="muted" id="selection-help">${instructions}</p>
<div class="quiz-options">${choices}</div>
${multi ? `<div class="quiz-check"><p id="selection-count" role="status" aria-live="polite" aria-atomic="true">${feedback?.selectedIds.length ?? 0} of ${question.requiredSelections} selected</p>${button('submit', 'Check answer', false, true)}</div>` : ''}
</fieldset>
</section>
${feedback ? `<section class="quiz-feedback ${feedback.correct ? 'is-correct' : 'is-incorrect'}" aria-labelledby="feedback-heading" aria-live="polite" aria-atomic="true">
<h2 id="feedback-heading" tabindex="-1"><span aria-hidden="true">${feedback.correct ? '✓' : '✕'}</span> ${feedback.correct ? 'Correct' : 'Incorrect'}</h2>
<p class="muted">Source-author answer · Not an official exam guarantee.</p>
<h3>Correct ${feedback.correctChoices.length === 1 ? 'choice' : 'choices'}</h3>
<ul class="quiz-correct-choices">${feedback.correctChoices.map(option => `<li><strong>${escapeHtml(option.id)}</strong><div class="lesson">${renderMarkdown(option.text)}</div></li>`).join('')}</ul>
<h3>Explanation</h3><div class="lesson">${renderMarkdown(feedback.explanation)}</div>
</section>` : ''}`;
}

/** Pure HTML body fragment for the real panel, tests, and local browser previews.
 * Wrap with the host's CSP document and load learning.css, quiz.css, then quiz.js.
 */
export function renderQuizView(state: QuizViewState): string {
	const { content } = state;
	const available = content.kind === 'question' || content.kind === 'summary';
	const focus = content.kind === 'question' ? content.feedback ? 'feedback-heading' : 'question-heading'
		: content.kind === 'summary' ? 'results-heading' : 'quiz-title';
	let body = '';
	if (content.kind === 'question') { body = questionView(content, state.total); }
	if (content.kind === 'summary') {
		body = `<section class="quiz-card quiz-results" aria-labelledby="results-heading">
<p class="eyebrow">Attempt results</p><h2 id="results-heading" tabindex="-1">Quiz results</h2>
<p class="quiz-result-score"><strong>${state.correct} / ${state.total}</strong> correct</p>
<p>${state.answered} of ${state.total} questions answered. This score is for this quiz attempt only.</p>
<ol class="quiz-result-list">${content.results.map((correct, index) => `<li>Question ${index + 1}: <strong><span aria-hidden="true">${correct ? '✓' : '✕'}</span> ${correct ? 'Correct' : 'Incorrect'}</strong></li>`).join('')}</ol>
${button('restart', 'Retry quiz', true, true)}
</section>`;
	}
	if (content.kind === 'unavailable') {
		body = '<section class="notice warning" role="alert"><h2>Interactive quiz unavailable</h2><p>The declared quiz is missing, unsafe, invalid JSON, or uses an unsupported Markdown format. No answers were guessed.</p><p>Open source is available only when the declared quiz safely resolves to an existing quiz file. Reopen this panel after fixing the source.</p></section>';
	}
	if (content.kind === 'loading') { body = '<p role="status">Loading local quiz…</p>'; }
	return `<a class="skip-link" href="#${focus}">Skip to quiz content</a>
<main data-focus="${focus}" aria-busy="${content.kind === 'loading'}">
<header class="activity-header quiz-header"><p class="eyebrow">${escapeHtml(state.courseTitle)}</p><p class="muted">${escapeHtml(state.unitTitle)}</p><h1 id="quiz-title" tabindex="-1">${escapeHtml(state.title)}</h1><span class="badge">Practice quiz · Not course completion</span></header>
<aside class="notice quiz-notice" role="note">No auto-complete: this quiz never changes course completion or your current learning position. Attempts stay in memory only during this extension session, including when this panel is closed. They are not saved across extension restarts.</aside>
<div class="actions quiz-toolbar" role="group" aria-label="Quiz tools">${button('source', 'Open source', state.sourceAvailable)}${available ? button('restart', 'Restart') : ''}</div>
${state.notice ? `<p class="notice warning" role="status">${escapeHtml(state.notice)}</p>` : ''}
${available ? `<section class="quiz-metrics" aria-label="Quiz attempt progress"><div><span class="muted">Questions answered</span><strong>${state.answered} / ${state.total}</strong></div><div><span class="muted">Score · correct / answered</span><strong id="quiz-score">${state.correct} / ${state.answered}</strong></div><progress max="${state.total}" value="${state.answered}" aria-label="Quiz questions answered, not course completion">${state.answered} of ${state.total}</progress></section>` : ''}
${body}
${available ? `<nav class="activity-navigation" aria-label="Quiz navigation">${button('previous', 'Previous', content.kind === 'summary' || content.number > 1)}<div class="actions">${button('summary', 'Summary', state.answered === state.total && content.kind !== 'summary')}${button('next', content.kind === 'question' && content.number === state.total ? 'Finish quiz' : 'Next', content.kind === 'question' && Boolean(content.feedback), true)}</div></nav>` : ''}
<p class="muted quiz-footer">Answers reflect the source author, not official exam guarantees. External links require confirmation; images and local links are not loaded.</p>
<p id="action-status" class="muted" role="status" aria-live="polite" aria-atomic="true"></p>
</main>`;
}