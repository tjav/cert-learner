import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import Ajv from 'ajv';
import quizSchema from '../../schemas/quiz.schema.json';
import { resolveResource } from './course';
import type { Course, Unit } from './course';
import { identifier, jsonSnapshot } from './validation';

export interface QuizOption { id: string; text: string }
export interface QuizQuestion {
	id: string;
	prompt: string;
	options: QuizOption[];
	correctOptionIds: string[];
	explanation: string;
}
export interface Quiz { schemaVersion: 1; title: string; questions: QuizQuestion[] }
export interface QuizSelection { course: Course; unit: Unit }

const MAX_QUIZ_BYTES = 1024 * 1024;
const LABELS = 'ABCDEFGH';
const OPEN_SOURCE = 'Use Open source to inspect the quiz.';
const ajv = new Ajv({ allErrors: true, ownProperties: true });
const checkQuiz = ajv.compile<Quiz>(quizSchema);

/** Validate static JSON only, then return a detached JSON-shaped copy. No coercion or rendering. */
export function validateQuiz(input: unknown): Quiz {
	const quiz = jsonSnapshot(input, MAX_QUIZ_BYTES, 'Quiz');
	if (!checkQuiz(quiz)) {
		const errors = (checkQuiz.errors ?? []).slice(0, 8)
			.map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
		throw new Error(`Invalid quiz: ${errors}`);
	}
	const questions = new Set<string>();
	for (const question of quiz.questions) {
		identifier(question.id, 'Question ID');
		if (questions.has(question.id)) { throw new Error('Invalid quiz: duplicate question ID.'); }
		questions.add(question.id);
		const options = new Set<string>();
		for (const option of question.options) {
			identifier(option.id, 'Option ID');
			if (options.has(option.id)) { throw new Error('Invalid quiz: duplicate option ID.'); }
			options.add(option.id);
		}
		for (const id of question.correctOptionIds) {
			identifier(id, 'Correct option ID');
			if (!options.has(id)) { throw new Error('Invalid quiz: correctOptionIds must be a nonempty subset of the options.'); }
		}
	}
	// Explicit fields keep prototypes/metadata out; jsonSnapshot never calls toJSON or getters.
	return {
		schemaVersion: 1, title: quiz.title,
		questions: quiz.questions.map(question => ({
			id: question.id, prompt: question.prompt,
			options: question.options.map(option => ({ id: option.id, text: option.text })),
			correctOptionIds: [...question.correctOptionIds], explanation: question.explanation
		}))
	};
}

function unsupported(reason: string): never {
	throw new Error(`Unsupported quiz format: ${reason}. ${OPEN_SOURCE}`);
}

// These guards reject near-matches instead of absorbing broken structure as prose.
const heading = /^\s*#{1,6}(?:\s|$)/u;
const fence = /^\s*(?:`{3,}|~{3,})/u;
const numericMarker = /^\s*(?:(?:\*{1,3}|__)\s*\d|\d+[.)]\*)/u;
const optionMarker = /^\s*(?:[-+*](?:\s|$)|[A-Za-z][.)](?:\s|$))/u;

function requiredChoices(prompt: string): number {
	const counts = [...prompt.replace(/\s+/gu, ' ').matchAll(/\b(?:choose|select) (two|2|three|3)\b/giu)]
		.map(match => /^(?:two|2)$/iu.test(match[1]) ? 2 : 3);
	if (new Set(counts).size > 1) { unsupported('conflicting selection cardinality in a question'); }
	return counts[0] ?? 1;
}

/** Strict adapter for the current AI103 grammar, not a general Markdown quiz importer. */
export function parseMarkdownQuiz(source: string): Quiz {
	if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_QUIZ_BYTES) {
		unsupported('source must be a string of at most 1048576 bytes');
	}
	const normalized = source.replace(/\r\n/gu, '\n');
	if (/[\r\u0000]/u.test(normalized)) { unsupported('invalid line endings or NUL characters'); }
	const lines = normalized.split('\n');
	let position = 0;
	while (position < lines.length && !lines[position].trim()) { position++; }
	const title = /^# (\S.*)$/u.exec(lines[position++] ?? '');
	if (!title) { unsupported('expected an H1 title'); }
	const questions: QuizQuestion[] = [];
	let current: QuizQuestion | undefined;
	let prompt: string[] = [];
	let separators = 0;
	let answersFound = false;
	const finishQuestion = (): void => {
		if (!current || !prompt.join('\n').trim() || current.options.length < 2 || separators < 1) {
			unsupported('each question needs a prompt, 2–8 contiguous options, and a --- separator');
		}
		current.prompt = prompt.join('\n').trim();
		questions.push(current);
	};
	for (; position < lines.length; position++) {
		const line = lines[position];
		if (line === '## Answers') {
			finishQuestion();
			answersFound = true;
			position++;
			break;
		}
		const start = /^\*\*([1-9]\d*)\.\*\*(?: (.*))?$/u.exec(line);
		if (start) {
			if (current) { finishQuestion(); }
			if (questions.length >= 200 || start[1] !== String(questions.length + 1)) {
				unsupported('question IDs must be consecutive 1–N, with at most 200 questions');
			}
			current = { id: start[1], prompt: '', options: [], correctOptionIds: [], explanation: '' };
			prompt = [start[2] ?? ''];
			separators = 0;
			continue;
		}
		if (heading.test(line) || fence.test(line) || numericMarker.test(line)) {
			unsupported('unexpected heading, code fence, or malformed question marker before Answers');
		}
		if (!line.trim()) {
			if (current && current.options.length === 0) { prompt.push(''); }
			continue;
		}
		if (line === '---') {
			if (++separators > 2 || (current && current.options.length < 2)) {
				unsupported('expected one or two --- separators after the options');
			}
			continue;
		}
		const option = /^- ([A-H])\. (.*)$/u.exec(line);
		if (option) {
			if (!current || separators || option[1] !== LABELS[current.options.length] || !option[2].trim()) {
				unsupported('option labels must be contiguous A–H with nonempty text');
			}
			current.options.push({ id: option[1], text: option[2] });
			continue;
		}
		if (optionMarker.test(line)) { unsupported('malformed option label'); }
		if (!current) {
			if (separators) { unsupported('unexpected preamble after its separator'); }
			continue; // Introductory prose, never converted into a question.
		}
		if (separators) { unsupported('unexpected text after a question separator'); }
		if (current.options.length) {
			if (!/^ {2}\S/u.test(line) || !lines[position - 1]?.trim()) {
				unsupported('option continuations must have exactly two spaces');
			}
			current.options[current.options.length - 1].text += `\n${line.slice(2)}`;
		} else {
			prompt.push(line); // Includes ordinary numbered lists inside the stem.
		}
	}
	if (!answersFound) { unsupported('missing exact ## Answers section'); }

	let answerCount = 0;
	let explanation: string[] = [];
	let paragraphEnded = false;
	separators = 0;
	const finishAnswer = (): void => {
		if (!answerCount || !explanation.join('\n').trim()) { unsupported('missing answer explanation'); }
		questions[answerCount - 1].explanation = explanation.join('\n').trim();
	};
	for (; position < lines.length; position++) {
		const line = lines[position];
		if (/^## \S/u.test(line)) {
			if (line === '## Answers') { unsupported('duplicate Answers section'); }
			break; // Entire solutions/next-section tail is opaque, even its fenced code and markers.
		}
		const answer = /^\*\*([1-9]\d*) — ([A-H](?: and [A-H]){0,2})\.\*\* (.*)$/u.exec(line);
		if (answer) {
			if (answerCount) { finishAnswer(); }
			if (answer[1] !== String(answerCount + 1) || answerCount >= questions.length || !answer[3].trim()) {
				unsupported('answer IDs must align consecutively with questions and include an explanation');
			}
			const question = questions[answerCount++];
			const ids = answer[2].split(' and ');
			if (new Set(ids).size !== ids.length || ids.some(id => !question.options.some(option => option.id === id))) {
				unsupported('answer labels must be unique known options');
			}
			if (ids.length !== requiredChoices(question.prompt)) { unsupported('answer cardinality does not match the question'); }
			question.correctOptionIds = ids;
			explanation = [answer[3]];
			paragraphEnded = false;
			separators = 0;
			continue;
		}
		// A wrapped paragraph can start with "B. On ..." (a source-authored
		// explanation of a distractor). Unlike question options, that is prose.
		if (heading.test(line) || fence.test(line) || numericMarker.test(line) ||
			/^\s*(?:[-+*](?:\s|$)|\d+(?:[.)]|\s*[-–—]\s+))/u.test(line)) {
			unsupported('malformed answer marker or unexpected answer structure');
		}
		if (!line.trim()) { paragraphEnded = answerCount > 0; continue; }
		if (line === '---') {
			if (!answerCount || ++separators > 2) { unsupported('unexpected answer separator'); }
			paragraphEnded = true;
			continue;
		}
		if (!answerCount || paragraphEnded) { unsupported('answer explanations must be a single paragraph of wrapped lines'); }
		explanation.push(line);
	}
	finishAnswer();
	if (answerCount !== questions.length) { unsupported('missing answer keys'); }
	try {
		return validateQuiz({ schemaVersion: 1, title: title[1].trim(), questions });
	} catch {
		unsupported('quiz fields exceed the structured quiz limits or are invalid');
	}
}

/** Host supplies the registered Course; only the unit ID is used from the selection. */
export async function loadQuiz(selection: QuizSelection): Promise<{ quiz: Quiz; revision: string; sourcePath: string }> {
	const descriptor = selection?.unit && Object.getOwnPropertyDescriptor(selection.unit, 'unitId');
	const unitId: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
	if (typeof unitId !== 'string' || !unitId) { throw new Error(`Invalid quiz unit selection. ${OPEN_SOURCE}`); }
	const matches = selection.course.manifest.units.filter(unit => unit.unitId === unitId);
	const relative = matches.length === 1 ? matches[0].resources.quiz : undefined;
	if (relative === undefined) { throw new Error(`The selected unit does not declare a quiz. ${OPEN_SOURCE}`); }
	const extension = path.extname(relative).toLowerCase();
	if (extension !== '.md' && extension !== '.json') {
		throw new Error(`Quiz source must be a .md or .json file. ${OPEN_SOURCE}`);
	}
	let sourcePath: string;
	let bytes: Buffer;
	try {
		sourcePath = await resolveResource(selection.course.root, relative);
		if (path.extname(sourcePath).toLowerCase() !== extension) { throw new Error(); }
		// NONBLOCK avoids hanging on a FIFO substituted after resolution; NOFOLLOW
		// rejects a last-component symlink substituted before open, where supported.
		const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_QUIZ_BYTES) { throw new Error(); }
			const buffer = Buffer.alloc(MAX_QUIZ_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
				if (!bytesRead) { break; }
				size += bytesRead;
			}
			if (size > MAX_QUIZ_BYTES) { throw new Error(); }
			bytes = buffer.subarray(0, size);
		} finally { await handle.close(); }
	} catch {
		// Never forward filesystem errors (or their causes): they contain absolute paths.
		throw new Error(`Quiz source must be a readable regular file of at most 1048576 bytes, safely inside the course root, with a matching .md or .json extension. ${OPEN_SOURCE}`);
	}
	const source = bytes.toString('utf8');
	if (!Buffer.from(source, 'utf8').equals(bytes)) { throw new Error(`Quiz source is not valid UTF-8. ${OPEN_SOURCE}`); }
	let quiz: Quiz;
	if (extension === '.md') {
		quiz = parseMarkdownQuiz(source);
	} else {
		let input: unknown;
		try { input = JSON.parse(source) as unknown; } catch { throw new Error(`Quiz source is not valid JSON. ${OPEN_SOURCE}`); }
		try { quiz = validateQuiz(input); } catch { throw new Error(`Quiz source is not a valid version 1 structured quiz. ${OPEN_SOURCE}`); }
	}
	return { quiz, revision: createHash('sha256').update(bytes).digest('hex'), sourcePath };
}

/** Strict static marking; a malformed submission is an error, not an incorrect attempt. */
export function gradeQuestion(question: QuizQuestion, selectedIds: unknown): { correct: boolean; correctOptionIds: string[]; explanation: string } {
	// Revalidate even previously validated data: callers can mutate their detached quiz.
	const validated = validateQuiz({ schemaVersion: 1, title: 'Quiz', questions: [question] }).questions[0];
	const selected = jsonSnapshot(selectedIds, 8192, 'Selected option IDs');
	if (!Array.isArray(selected) || selected.length !== validated.correctOptionIds.length ||
		selected.some(id => typeof id !== 'string' || !validated.options.some(option => option.id === id)) ||
		new Set(selected).size !== selected.length) {
		throw new Error(`Selected option IDs must be ${validated.correctOptionIds.length} unique known strings.`);
	}
	const chosen = new Set<unknown>(selected);
	return {
		correct: validated.correctOptionIds.every(id => chosen.has(id)),
		correctOptionIds: [...validated.correctOptionIds], explanation: validated.explanation
	};
}