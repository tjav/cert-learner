import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Ajv from 'ajv';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type { Context } from 'mocha';
import quizSchema from '../../schemas/quiz.schema.json';
import { loadCourse } from '../core/course';
import type { Course, CourseManifest } from '../core/course';
import { gradeQuestion, loadQuiz, parseMarkdownQuiz, validateQuiz } from '../core/quiz';
import type { Quiz, QuizSelection } from '../core/quiz';

const LIMIT = 1024 * 1024;
// Source-authored test content, not assertions about a cloud service or SDK.
const MARKDOWN = `# 01.2 — Local review: quiz

2 questions. Answers at the bottom. Review the explanations.

---

**1.** A local document must keep its original text.
Which option is suitable?

- A. Keep the \`original\` text
- B. Replace every word
- C. Store only the title
- D. Remove the document

---

**2.** Which statements describe this fictional format? Choose
two.

- A. It stores **text**
- B. It runs an executable automatically
- C. It preserves the [source](https://example.com/reference) in a
  read-only view
- D. It always requires a network connection
- E. It deletes the source

---
---
## Answers

**1 — A.** Keeping the original preserves its text.
The other options discard source-authored content.

**2 — A and C.** The example stores text and offers a read-only view.
**B** is not a capability of this fictional format.

---

## Lab exercise solutions

**1. Explanation for an unscored lab**

\`\`\`text
## Answers
**999.** This is never a scored question.
- X. Not an option
**1 — H.** Not a scored answer.
\`\`\`
`;

function quiz(): Quiz {
	return {
		schemaVersion: 1, title: 'Source-authored quiz',
		questions: [{
			id: 'q1', prompt: 'Which local option?',
			options: [{ id: 'A', text: 'Original' }, { id: 'B', text: 'Replacement' }, { id: 'C', text: 'Copy' }],
			correctOptionIds: ['A'], explanation: 'The source author chose the original.'
		}]
	};
}

function single(prompt = 'Which option?', key = 'A', explanation = 'Source-authored explanation.'): string {
	return `# Quiz\n\n**1.** ${prompt}\n\n- A. First\n- B. Second\n- C. Third\n\n---\n\n## Answers\n\n**1 — ${key}.** ${explanation}\n`;
}

describe('quiz: bounded structured JSON and static marking', () => {
	it('compiles the draft-7 schema using Ajv 8 and accepts the version 1 shape', () => {
		const check = new Ajv({ strict: true }).compile(quizSchema);
		assert.equal(check(quiz()), true);
		assert.equal(check({ ...quiz(), schemaVersion: '1' }), false);
		assert.equal(check({ ...quiz(), metadata: {} }), false);
		for (const id of [' leading', 'trailing ', 'trailing\n', 'trailing\u2028', 'nul\u0000', 'del\u007f']) {
			const input = quiz();
			input.questions[0].id = id;
			assert.equal(check(input), false, 'The standalone schema also rejects whitespace/control IDs');
		}
	});

	it('returns detached ordinary JSON objects without mutating or defaulting the input', () => {
		const input = quiz();
		const before = JSON.stringify(input);
		for (const option of input.questions[0].options) { Object.freeze(option); }
		Object.freeze(input.questions[0].options);
		Object.freeze(input.questions[0].correctOptionIds);
		Object.freeze(input.questions[0]);
		Object.freeze(input.questions);
		Object.freeze(input);
		const copy = validateQuiz(input);
		assert.deepEqual(copy, input);
		copy.questions[0].options[0].text = 'Changed';
		copy.questions[0].correctOptionIds.push('C');
		assert.equal(JSON.stringify(input), before);
		assert.equal(Object.getPrototypeOf(copy), Object.prototype);
		assert.equal(Object.getPrototypeOf(copy.questions[0]), Object.prototype);
		assert.equal(Object.getPrototypeOf(copy.questions[0].options[0]), Object.prototype);
		assert.deepEqual(validateQuiz(Object.assign(Object.create(null), quiz())), input);
	});

	it('does not coerce primitive, boxed, or malicious metadata types', () => {
		for (const input of [null, undefined, true, 1, '1', JSON.stringify(quiz()), [], {}, new String('quiz'), () => quiz()]) {
			assert.throws(() => validateQuiz(input));
		}
		for (const value of [null, undefined, false, 2, {}, [], new String('text')]) {
			assert.throws(() => validateQuiz({ ...quiz(), title: value }));
			for (const field of ['id', 'prompt', 'explanation']) {
				const input = quiz();
				Object.assign(input.questions[0], { [field]: value });
				assert.throws(() => validateQuiz(input));
			}
			for (const field of ['id', 'text']) {
				const input = quiz();
				Object.assign(input.questions[0].options[0], { [field]: value });
				assert.throws(() => validateQuiz(input));
			}
		}
		for (const schemaVersion of ['1', true, null, 0, 2, new Number(1)]) {
			assert.throws(() => validateQuiz({ ...quiz(), schemaVersion }));
		}
	});

	it('requires all fields and rejects unknown fields at every object level', () => {
		for (const level of ['quiz', 'question', 'option']) {
			const input = quiz();
			const target = level === 'quiz' ? input : level === 'question' ? input.questions[0] : input.questions[0].options[0];
			for (const key of Object.keys(target)) {
				const fresh = quiz();
				const object = (level === 'quiz' ? fresh : level === 'question' ? fresh.questions[0] : fresh.questions[0].options[0]) as unknown as Record<string, unknown>;
				delete object[key];
				assert.throws(() => validateQuiz(fresh), `${level}.${key}`);
			}
			for (const key of ['metadata', 'weight', 'script', 'required', '__proto__', 'constructor', 'toString']) {
				Object.defineProperty(target, key, { enumerable: true, configurable: true, value: false });
				assert.throws(() => validateQuiz(input), /additional properties/);
				Reflect.deleteProperty(target, key);
			}
		}
	});

	it('requires bounded nonblank IDs, unique questions/options and a nonempty answer subset', () => {
		for (const id of ['', ' ', ' leading', 'trailing ', 'x\ny', 'x\u0000', 'x\u007f', 'x'.repeat(129)]) {
			const input = quiz();
			input.questions[0].id = id;
			assert.throws(() => validateQuiz(input));
			input.questions[0].id = 'q1';
			input.questions[0].options[0].id = id;
			assert.throws(() => validateQuiz(input));
		}
		const duplicate = quiz();
		duplicate.questions.push({ ...duplicate.questions[0] });
		assert.throws(() => validateQuiz(duplicate), /duplicate question ID/);
		duplicate.questions.pop();
		duplicate.questions[0].options.push({ ...duplicate.questions[0].options[0] });
		assert.throws(() => validateQuiz(duplicate), /duplicate option ID/);
		for (const ids of [[], ['A', 'A'], ['unknown'], ['A', 'B', 'C', 'D'], [1], [null], 'A', {}]) {
			const input = quiz();
			Object.assign(input.questions[0], { correctOptionIds: ids });
			assert.throws(() => validateQuiz(input));
		}
	});

	it('enforces 1–200 questions, 2–8 options, text caps and aggregate byte bounds', () => {
		const input = quiz();
		input.questions = Array.from({ length: 200 }, (_, i) => ({ ...quiz().questions[0], id: String(i) }));
		assert.equal(validateQuiz(input).questions.length, 200);
		input.questions.push({ ...quiz().questions[0], id: 'extra' });
		assert.throws(() => validateQuiz(input));
		assert.throws(() => validateQuiz({ ...quiz(), questions: [] }));
		for (const length of [0, 1, 2, 8, 9]) {
			const input = quiz();
			input.questions[0].options = Array.from({ length }, (_, i) => ({ id: String(i), text: 'Option' }));
			input.questions[0].correctOptionIds = ['0'];
			if (length === 2 || length === 8) { assert.doesNotThrow(() => validateQuiz(input)); }
			else { assert.throws(() => validateQuiz(input)); }
		}
		for (const [field, max] of [['title', 1024], ['prompt', 16384], ['text', 8192], ['explanation', 32768]] as const) {
			const input = quiz();
			const target = field === 'title' ? input : field === 'text' ? input.questions[0].options[0] : input.questions[0];
			Object.assign(target, { [field]: 'x'.repeat(max) });
			assert.doesNotThrow(() => validateQuiz(input));
			for (const text of ['', ' \t\n', 'x'.repeat(max + 1)]) {
				Object.assign(target, { [field]: text });
				assert.throws(() => validateQuiz(input));
			}
		}
		input.questions = Array.from({ length: 100 }, (_, i) => ({ ...quiz().questions[0], id: String(i), explanation: '界'.repeat(8192) }));
		assert.throws(() => validateQuiz(input), /bounded/);
	});

	it('rejects accessors, hooks, prototypes, hidden/symbol keys, sparse arrays and cycles without executing them', () => {
		let calls = 0;
		const getter = () => { calls++; return 'A'; };
		const accessor = quiz();
		Object.defineProperty(accessor.questions[0].options[0], 'text', { enumerable: true, get: getter });
		const hidden = quiz();
		Object.defineProperty(hidden, 'extra', { value: true });
		const cycle = quiz();
		Object.assign(cycle, { cycle });
		for (const input of [accessor, hidden, cycle, Object.create(quiz()),
			{ ...quiz(), toJSON: getter }, Object.assign(quiz(), { [Symbol('extra')]: true }),
			{ ...quiz(), questions: new Array(1) }, { ...quiz(), questions: Object.assign(quiz().questions, { extra: true }) }]) {
			assert.throws(() => validateQuiz(input));
		}
		const selected = ['A'];
		Object.defineProperty(selected, '0', { enumerable: true, get: getter });
		assert.throws(() => gradeQuestion(quiz().questions[0], selected));
		assert.equal(calls, 0);
	});

	it('marks single and multiple selections by exact unordered set and returns detached answers', () => {
		const question = validateQuiz(quiz()).questions[0];
		assert.deepEqual(gradeQuestion(question, ['A']), { correct: true, correctOptionIds: ['A'], explanation: question.explanation });
		assert.equal(gradeQuestion(question, ['B']).correct, false);
		question.correctOptionIds = ['C', 'A'];
		assert.equal(gradeQuestion(question, ['A', 'C']).correct, true);
		assert.equal(gradeQuestion(question, ['C', 'B']).correct, false);
		const selected = Object.freeze(['A', 'C']);
		const result = gradeQuestion(question, selected);
		result.correctOptionIds.length = 0;
		assert.deepEqual(question.correctOptionIds, ['C', 'A']);
		assert.deepEqual(selected, ['A', 'C']);
	});

	it('rejects empty, duplicate, unknown, coerced and wrong-cardinality submissions', () => {
		const question = quiz().questions[0];
		for (const selected of [null, undefined, 'A', {}, [], [1], [new String('A')], [' A'], ['a'], ['Z'], ['A', 'A'], ['A', 'B']]) {
			assert.throws(() => gradeQuestion(question, selected));
		}
		question.correctOptionIds = ['A', 'C'];
		for (const selected of [[], ['A'], ['A', 'A'], ['A', 'B', 'C'], ['A', 'Z']]) {
			assert.throws(() => gradeQuestion(question, selected));
		}
		question.correctOptionIds = ['missing'];
		assert.throws(() => gradeQuestion(question, ['missing']), /subset/);
		assert.throws(() => gradeQuestion(Object.create(quiz().questions[0]), ['A']));
	});

	it('keeps prototype-shaped IDs as inert strings and does not interpret or execute Markdown/HTML', () => {
		const input = quiz();
		input.questions[0].id = '__proto__';
		input.questions[0].options = ['__proto__', 'constructor', 'toString'].map(id => ({ id, text: '<script>throw new Error("never execute")</script>' }));
		input.questions[0].correctOptionIds = ['constructor'];
		input.questions[0].explanation = '[source](command:not-executed)';
		const copy = validateQuiz(input);
		assert.deepEqual(copy, input);
		assert.equal(gradeQuestion(copy.questions[0], ['constructor']).correct, true);
		assert.equal(gradeQuestion(copy.questions[0], ['__proto__']).correct, false);
	});
});

describe('quiz: strict current AI103 Markdown adapter', () => {
	it('parses single/multi answers, wrapped Choose two, continued options, and Markdown bodies', () => {
		const parsed = parseMarkdownQuiz(MARKDOWN);
		assert.equal(parsed.title, '01.2 — Local review: quiz');
		assert.deepEqual(parsed.questions.map(question => question.id), ['1', '2']);
		assert.deepEqual(parsed.questions.map(question => question.correctOptionIds), [['A'], ['A', 'C']]);
		assert.equal(parsed.questions[0].prompt, 'A local document must keep its original text.\nWhich option is suitable?');
		assert.equal(parsed.questions[1].options[2].text, 'It preserves the [source](https://example.com/reference) in a\nread-only view');
		assert.equal(parsed.questions[0].explanation, 'Keeping the original preserves its text.\nThe other options discard source-authored content.');
		assert.equal(parsed.questions[1].explanation, 'The example stores text and offers a read-only view.\n**B** is not a capability of this fictional format.');
		assert.doesNotMatch(JSON.stringify(parsed), /---|999|unscored|Not a scored|Lab exercise solutions/u);
		assert.equal(parsed.questions[1].options.length, 5);
	});

	it('accepts CRLF and preserves ordered lists in stems without making extra questions', () => {
		assert.deepEqual(parseMarkdownQuiz(MARKDOWN.replace(/\n/gu, '\r\n')), parseMarkdownQuiz(MARKDOWN));
		const prompt = 'Put the local steps in order.\n\n1. Read the document\n2. Open the folder\n3. Close the document';
		const parsed = parseMarkdownQuiz(single(prompt));
		assert.equal(parsed.questions.length, 1);
		assert.equal(parsed.questions[0].prompt, prompt);
	});

	it('accepts contiguous A–H labels, choose/select two/2/three/3 and two-option questions', () => {
		for (const verb of ['Choose', 'Select', 'choose', 'SELECT']) {
			for (const count of ['two', '2', 'three', '3']) {
				const triple = count === 'three' || count === '3';
				const parsed = parseMarkdownQuiz(single(`${verb}\n${count}.`, triple ? 'A and B and C' : 'A and C'));
				assert.equal(parsed.questions[0].correctOptionIds.length, triple ? 3 : 2);
			}
		}
		const eight = single().replace('- C. Third', '- C. Third\n- D. Fourth\n- E. Fifth\n- F. Sixth\n- G. Seventh\n- H. Eighth');
		assert.equal(parseMarkdownQuiz(eight).questions[0].options.length, 8);
		assert.equal(parseMarkdownQuiz(single().replace('- C. Third\n', '')).questions[0].options.length, 2);
	});

	it('stops at the next exact second-level section after answers and ignores its complete tail', () => {
		for (const header of ['## Lab exercise solutions', '## References', '## Next']) {
			const text = MARKDOWN.replace('## Lab exercise solutions', header);
			assert.deepEqual(parseMarkdownQuiz(text), parseMarkdownQuiz(MARKDOWN));
		}
		assert.deepEqual(parseMarkdownQuiz(`${single()}\n## Next\n\n\`\`\`\n**1 — X.**\n`), parseMarkdownQuiz(single()));
	});

	it('preserves wrapped explanations starting with a distractor letter or numeric range', () => {
		for (const explanation of ['The source author rejects\nB. On the next line the same paragraph continues.',
			'The fictional score uses the\n0–7 range (A), not a question or answer marker.']) {
			assert.equal(parseMarkdownQuiz(single('Which option?', 'A', explanation)).questions[0].explanation, explanation);
		}
	});

	it('rejects absent/wrong headings, unexpected pre-answer headings and unsupported free-form quizzes', () => {
		for (const source of ['', '# Quiz\nExplain the topic.', MARKDOWN.replace('# 01.2', '## 01.2'),
			MARKDOWN.replace('## Answers', '## Answer key'), MARKDOWN.replace('## Answers', '## answers'),
			MARKDOWN.replace('## Answers', ' ## Answers'), MARKDOWN.replace('**1.**', '## Questions\n\n**1.**'),
			MARKDOWN.replace('**2.**', '### More questions\n\n**2.**'), single().replace('## Answers', '## Lab exercise solutions')]) {
			assert.throws(() => parseMarkdownQuiz(source), /unsupported quiz format.*Open source/is);
		}
	});

	it('rejects duplicate/skipped/reordered question IDs and missing, extra or duplicate answer keys', () => {
		for (const source of [MARKDOWN.replace('**2.**', '**1.**'), MARKDOWN.replace('**2.**', '**3.**'),
			MARKDOWN.replace('**1.**', '**01.**'), MARKDOWN.replace('**1.**', '**2.**'),
			MARKDOWN.replace('**2 — A and C.**', '**1 — A and C.**'), MARKDOWN.replace('**2 — A and C.**', '**3 — A and C.**'),
			MARKDOWN.replace('**1 — A.**', '**2 — A.**'), MARKDOWN.replace('**1 — A.**', '**01 — A.**'),
			`${single()}\n**1 — A.** Duplicate.`, `${single()}\n**2 — A.** Extra.`,
			MARKDOWN.slice(0, MARKDOWN.indexOf('**2 —')), MARKDOWN.slice(0, MARKDOWN.indexOf('**1 —')),
			MARKDOWN.replace('**2 — A and C.**', '## Next\n**2 — A and C.**')]) {
			assert.throws(() => parseMarkdownQuiz(source), /unsupported quiz format/i);
		}
	});

	it('rejects malformed answer markers instead of appending them to an explanation', () => {
		for (const marker of ['**2 - A and C.**', '**2 – A and C.**', '**2 — A & C.**', '**2 — A, C.**',
			'**2 — a and C.**', '**2 — A and C**', '*2 — A and C.*', '2. A and C.', '2 — A and C.', ' **2 — A and C.**', '**2.**']) {
			assert.throws(() => parseMarkdownQuiz(MARKDOWN.replace('**2 — A and C.**', marker)), /unsupported quiz format/i);
		}
		assert.throws(() => parseMarkdownQuiz(`${single()}2 — A. Unbolded key in the same paragraph.`), /unsupported quiz format/i);
	});

	it('rejects empty, malformed, duplicate, noncontiguous and unbounded options or bad continuations', () => {
		for (const replacement of ['- B. First', '- a. First', '- A) First', '+ A. First', '* A. First',
			'- A.First', '- A. ', '- A.', 'A. First', ' - A. First', '- I. First', '- AA. First']) {
			assert.throws(() => parseMarkdownQuiz(single().replace('- A. First', replacement)), /unsupported quiz format/i);
		}
		for (const source of [single().replace('- B. Second', '- A. Second'), single().replace('- B. Second\n', ''),
			single().replace('- B. Second\n- C. Third\n', ''), single().replace('- C. Third', '- C. Third\n- D. '),
			single().replace('- C. Third', '- C. Third\nunindented continuation'),
			MARKDOWN.replace('  read-only view', ' read-only view'), MARKDOWN.replace('  read-only view', '   read-only view'),
			MARKDOWN.replace('  read-only view', '  - D. disguised option'), MARKDOWN.replace('  read-only view', '\n  read-only view')]) {
			assert.throws(() => parseMarkdownQuiz(source), /unsupported quiz format/i);
		}
	});

	it('requires one/two standalone separators and rejects stray text after completed options', () => {
		for (const separator of ['', '----', ' ---', '***', '---\n---\n---', '---\nUnexpected prose']) {
			assert.throws(() => parseMarkdownQuiz(single().replace('---', separator)), /unsupported quiz format/i);
		}
		assert.throws(() => parseMarkdownQuiz(single().replace('- A. First', '---\n- A. First')), /unsupported quiz format/i);
	});

	it('checks explicit cardinality and known unique answer labels without guessing', () => {
		for (const source of [single('Choose two.', 'A'), single('Choose three.', 'A and B'),
			single('Which options?', 'A and C'), single('Choose two.', 'A and A'), single('Choose two.', 'A and H'),
			single('Choose two. Select three.', 'A and C'), single('Choose four.', 'A and B and C'), single('Which?', 'H')]) {
			assert.throws(() => parseMarkdownQuiz(source), /unsupported quiz format/i);
		}
	});

	it('requires nonempty one-paragraph explanations and never imports code or later questions', () => {
		for (const source of [single('Which?', 'A', ''), single('Which?', 'A', '   '),
			`${single()}\nSecond paragraph.`, `${single()}\n- A. Answer-side option`, `${single()}\n**2.** Answer-side question`,
			`${single()}\n### Unexpected heading`, `${single()}\n\`\`\`js\nthrow 1;\n\`\`\``, `${single()}\n## Answers`,
			single().replace('Which option?', '\`\`\`text\n**1.**\n\`\`\`')]) {
			assert.throws(() => parseMarkdownQuiz(source), /unsupported quiz format/i);
		}
	});

	it('bounds the whole Markdown source including ignored tails and limits parsed questions to 200', () => {
		assert.throws(() => parseMarkdownQuiz(`${MARKDOWN}${'x'.repeat(LIMIT)}`), /unsupported quiz format/i);
		assert.throws(() => parseMarkdownQuiz('界'.repeat(Math.ceil(LIMIT / 3))), /unsupported quiz format/i);
		assert.throws(() => parseMarkdownQuiz(null as unknown as string), /unsupported quiz format/i);
		assert.throws(() => parseMarkdownQuiz(MARKDOWN.replace('text.', 'text.\rBare return')), /unsupported quiz format/i);
		const many = (count: number) => `# Quiz\n${Array.from({ length: count }, (_, i) => `\n**${i + 1}.** Prompt\n- A. One\n- B. Two\n---\n`).join('')}\n## Answers\n${Array.from({ length: count }, (_, i) => `\n**${i + 1} — A.** Explanation.\n`).join('')}`;
		assert.equal(parseMarkdownQuiz(many(200)).questions.length, 200);
		assert.throws(() => parseMarkdownQuiz(many(201)), /at most 200/);
	});
});

async function linkOrSkip(context: Context, target: string, link: string, directory = false): Promise<void> {
	try { await symlink(target, link, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); } catch (error) {
		if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(String(error.code))) { context.skip(); }
		throw error;
	}
}

describe('quiz: safe local loading (no VS Code, notebooks or cloud execution)', function () {
	this.timeout(15_000);
	let temporary: string;
	let course: Course;
	let selection: QuizSelection;

	beforeEach(async () => {
		temporary = await mkdtemp(path.join(tmpdir(), 'cert-learner-quiz-'));
		const root = path.join(temporary, 'course');
		await mkdir(root);
		const manifest: CourseManifest = {
			format: 'cert-learner', schemaVersion: 1, contentVersion: '1', courseId: 'quiz-test', title: 'Local course',
			units: [{ unitId: 'one', displayNumber: '1', title: 'One', resources: { lesson: 'lesson.md', quiz: 'quiz.md' },
				activities: [{ activityId: 'read', title: 'Read', objectives: [] }] }]
		};
		await writeFile(path.join(root, 'course.json'), JSON.stringify(manifest));
		await writeFile(path.join(root, 'lesson.md'), '# Read locally');
		await writeFile(path.join(root, 'quiz.md'), MARKDOWN);
		course = await loadCourse(path.join(root, 'course.json'));
		selection = { course, unit: course.manifest.units[0] };
	});

	afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

	async function rejectsWithoutPath(pattern: RegExp = /Open source/): Promise<void> {
		await assert.rejects(loadQuiz(selection), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, pattern);
			assert.match(error.message, /Open source/);
			assert.equal(error.message.includes(temporary), false);
			assert.equal(error.message.includes(course.root), false);
			assert.equal(error.cause, undefined);
			return true;
		});
	}

	it('loads Markdown, hashes exact raw bytes, and returns only quiz/revision plus host-local sourcePath', async () => {
		const loaded = await loadQuiz(selection);
		assert.deepEqual(Object.keys(loaded).sort(), ['quiz', 'revision', 'sourcePath']);
		assert.deepEqual(loaded.quiz, parseMarkdownQuiz(MARKDOWN));
		assert.equal(loaded.revision, createHash('sha256').update(MARKDOWN).digest('hex'));
		assert.equal(loaded.sourcePath, await realpath(path.join(course.root, 'quiz.md')));
		await writeFile(loaded.sourcePath, MARKDOWN.replace(/\n/gu, '\r\n'));
		const changed = await loadQuiz(selection);
		assert.deepEqual(changed.quiz, loaded.quiz);
		assert.notEqual(changed.revision, loaded.revision);
		await writeFile(loaded.sourcePath, `${MARKDOWN}\nTail-only change`);
		assert.notEqual((await loadQuiz(selection)).revision, loaded.revision);
		loaded.quiz.questions[0].prompt = 'Caller mutation';
		assert.notEqual((await loadQuiz(selection)).quiz.questions[0].prompt, 'Caller mutation');
	});

	it('supports .json/.md case-insensitively without changing the course-manifest validator', async () => {
		for (const [relative, source] of [['data.json', JSON.stringify(quiz())], ['data.JSON', JSON.stringify(quiz())], ['review.MD', MARKDOWN]]) {
			await writeFile(path.join(course.root, relative), source);
			// Simulate the parent host's widened canonical manifest contract; no passed unit path is trusted.
			course.manifest.units[0].resources.quiz = relative;
			const loaded = await loadQuiz(selection);
			assert.equal(loaded.revision, createHash('sha256').update(source).digest('hex'));
			assert.deepEqual(loaded.quiz, relative.endsWith('.MD') ? parseMarkdownQuiz(MARKDOWN) : quiz());
		}
	});

	it('uses canonical manifest unit data, not forged selected paths or metadata/getters', async () => {
		let reads = 0;
		const forged = { ...selection.unit, title: 'FORGED', resources: { lesson: '../outside.md', quiz: '../outside.md' } };
		Object.defineProperty(forged, 'resources', { get: () => { reads++; throw new Error('Never read'); } });
		selection = { course, unit: forged };
		assert.equal((await loadQuiz(selection)).quiz.title, '01.2 — Local review: quiz');
		assert.equal(reads, 0);
		Object.defineProperty(forged, 'unitId', { get: () => { reads++; return 'one'; } });
		await rejectsWithoutPath(/selection/);
		assert.equal(reads, 0);
	});

	it('rejects missing/unknown/ambiguous selections and absent resources with recoverable errors', async () => {
		for (const id of ['unknown', '', null, 1, new String('one')]) {
			selection = { course, unit: { ...course.manifest.units[0], unitId: id } } as QuizSelection;
			await rejectsWithoutPath();
		}
		selection = { course, unit: course.manifest.units[0] };
		course.manifest.units.push({ ...selection.unit });
		await rejectsWithoutPath();
		course.manifest.units.pop();
		delete course.manifest.units[0].resources.quiz;
		await rejectsWithoutPath(/does not declare/);
	});

	it('rejects lexical traversal, absolute paths, hidden/credential paths and unsafe extensions', async () => {
		await writeFile(path.join(temporary, 'outside.md'), MARKDOWN);
		for (const relative of ['../outside.md', 'sub/../../outside.md', path.join(temporary, 'outside.md'),
			'C:/outside.md', '/outside.md', 'C:outside.md', 'sub\\outside.md', 'quiz.md:stream',
			'.hidden/quiz.md', '.env.md', 'secrets.md', 'NUL.md', 'quiz.txt', 'quiz.js', 'quiz.ipynb', 'quiz.md.exe']) {
			course.manifest.units[0].resources.quiz = relative;
			await rejectsWithoutPath();
		}
	});

	it('rejects missing files, directories and oversize files without leaking paths or blocking course loading', async () => {
		course.manifest.units[0].resources.quiz = 'missing.md';
		await rejectsWithoutPath(/regular file/);
		await mkdir(path.join(course.root, 'folder.md'));
		course.manifest.units[0].resources.quiz = 'folder.md';
		await rejectsWithoutPath(/regular file/);
		course.manifest.units[0].resources.quiz = 'quiz.md';
		for (const source of ['x'.repeat(LIMIT + 1), Buffer.alloc(LIMIT + 1), '# Unsupported\nA free-response quiz.']) {
			await writeFile(path.join(course.root, 'quiz.md'), source);
			await rejectsWithoutPath();
			assert.equal((await loadCourse(path.join(course.root, 'course.json'))).manifest.courseId, 'quiz-test');
		}
	});

	it('accepts an exactly 1 MiB file but rejects one more byte for either format', async () => {
		for (const [relative, text] of [['bounded.md', MARKDOWN], ['bounded.json', JSON.stringify(quiz())]]) {
			course.manifest.units[0].resources.quiz = relative;
			const source = text + ' '.repeat(LIMIT - Buffer.byteLength(text));
			await writeFile(path.join(course.root, relative), source);
			assert.equal((await loadQuiz(selection)).revision, createHash('sha256').update(source).digest('hex'));
			await writeFile(path.join(course.root, relative), `${source} `);
			await rejectsWithoutPath(/1048576 bytes/);
		}
	});

	it('enforces strict UTF-8 in both extensions, rejecting overlong, truncated, surrogate and stray bytes', async () => {
		for (const relative of ['invalid.md', 'invalid.json']) {
			course.manifest.units[0].resources.quiz = relative;
			for (const bytes of [[0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xff], [0x80]]) {
				await writeFile(path.join(course.root, relative), Buffer.from(bytes));
				await rejectsWithoutPath(/UTF-8/);
			}
		}
	});

	it('handles invalid JSON/schema, unknown metadata and unsupported Markdown as path-free fallback errors', async () => {
		course.manifest.units[0].resources.quiz = 'data.json';
		for (const source of ['{', JSON.stringify({ ...quiz(), schemaVersion: 2 }), JSON.stringify({ ...quiz(), [course.root]: true }),
			JSON.stringify({ ...quiz(), questions: [] }), '{"__proto__":{"polluted":true}}']) {
			await writeFile(path.join(course.root, 'data.json'), source);
			await rejectsWithoutPath(/not (?:valid JSON|a valid version 1)/);
		}
	});

	it('rejects escaping directory links and intermediate leave/re-enter links', async function () {
		const outside = path.join(temporary, 'outside');
		await mkdir(outside);
		await writeFile(path.join(outside, 'quiz.md'), MARKDOWN);
		await linkOrSkip(this, outside, path.join(course.root, 'escape'), true);
		course.manifest.units[0].resources.quiz = 'escape/quiz.md';
		await rejectsWithoutPath(/safely inside/);
		await linkOrSkip(this, course.root, path.join(outside, 'back'), true);
		course.manifest.units[0].resources.quiz = 'escape/back/quiz.md';
		await rejectsWithoutPath(/safely inside/);
	});

	it('accepts contained file aliases but rejects escaping, hidden, mismatched-extension and non-file targets', async function () {
		await linkOrSkip(this, path.join(course.root, 'quiz.md'), path.join(course.root, 'alias.md'));
		course.manifest.units[0].resources.quiz = 'alias.md';
		assert.equal((await loadQuiz(selection)).sourcePath, path.join(course.root, 'quiz.md'));
		for (const [target, relative] of [[path.join(temporary, 'outside.md'), 'escape.md'],
			[path.join(course.root, '.hidden.md'), 'hidden.md'], [path.join(course.root, 'other.json'), 'wrong.md']]) {
			await writeFile(target, MARKDOWN);
			await linkOrSkip(this, target, path.join(course.root, relative));
			course.manifest.units[0].resources.quiz = relative;
			await rejectsWithoutPath();
		}
		await linkOrSkip(this, course.root, path.join(course.root, 'directory.md'), true);
		course.manifest.units[0].resources.quiz = 'directory.md';
		await rejectsWithoutPath();
	});
});

// Optional, read-only corpus check; no machine-specific paths or cloud/notebook execution.
describe('quiz: optional source-authored AI103 corpus', () => {
	it('adapts every declared quiz and checks the independently counted source markers', async function () {
		const root = process.env.CERT_LEARNER_AI103_ROOT;
		if (!root) { this.skip(); }
		const course = await loadCourse(path.join(root, 'course.json'));
		let files = 0;
		let questions = 0;
		let options = 0;
		for (const unit of course.manifest.units) {
			if (!unit.resources.quiz) { continue; }
			const loaded = await loadQuiz({ course, unit });
			const bytes = await readFile(loaded.sourcePath);
			const source = bytes.toString('utf8');
			const scored = source.split('\n## Answers')[0];
			assert.equal(loaded.quiz.questions.length, [...scored.matchAll(/^\*\*\d+\.\*\*/gmu)].length);
			assert.equal(loaded.quiz.questions.reduce((sum, question) => sum + question.options.length, 0), [...scored.matchAll(/^- [A-H]\. /gmu)].length);
			assert.equal(loaded.revision, createHash('sha256').update(bytes).digest('hex'));
			assert.ok(loaded.quiz.questions.length <= 15);
			for (const question of loaded.quiz.questions) { assert.equal(gradeQuestion(question, [...question.correctOptionIds].reverse()).correct, true); }
			files++;
			questions += loaded.quiz.questions.length;
			options += loaded.quiz.questions.reduce((sum, question) => sum + question.options.length, 0);
		}
		assert.deepEqual({ files, questions, options }, { files: 17, questions: 245, options: 984 });
	});
});