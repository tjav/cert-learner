import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type { Context } from 'mocha';
import { loadCourse, resolveResource, safeHttps, validateManifest } from '../core/course';
import type { Course, CourseManifest } from '../core/course';
import { activityKey, exportProgress, parseLegacyProgress, parsePortableProgress, parseProgress, ProgressStore } from '../core/progress';
import type { Progress } from '../core/progress';

const WHEN = '2026-09-06T10:20:30.000Z';
const FIRST = activityKey('unit', 'activity');
const SECOND = activityKey('unit', 'second');
const OTHER = activityKey('other', 'activity');

function manifest(): CourseManifest {
	return {
		format: 'cert-learner', schemaVersion: 1, contentVersion: '1.0', courseId: 'ai103', title: 'Course title',
		studyGuideUrl: 'https://example.com/guide', studyGuideVersion: '2026-09', language: 'en',
		references: [{ title: 'Reference', url: 'https://example.com/reference' }],
		resources: [{ title: 'Notes', path: 'notes.md' }],
		units: [
			{
				unitId: 'unit', displayNumber: '1', title: 'Unit one', domain: null,
				resources: { lesson: 'lesson.md', lab: 'lab.ipynb', quiz: 'quiz.md' },
				activities: [
					{ activityId: 'activity', title: 'First', objectives: ['Read the lesson'] },
					{ activityId: 'second', title: 'Second', objectives: [], completion: 'check', check: { runtime: 'node', file: 'checks/check.js', cwd: 'checks', timeoutSeconds: 10 } }
				]
			},
			{
				unitId: 'other', displayNumber: '2', title: 'Unit two', resources: { lesson: 'lesson.md' },
				activities: [{ activityId: 'activity', title: 'Other', objectives: [] }]
			}
		]
	};
}

function payload(course: Course): Progress {
	return { schemaVersion: 1, courseId: course.id, contentVersion: course.manifest.contentVersion, revision: 0, completions: {} };
}

function legacyPayload() {
	return {
		version: 1,
		position: { courseId: 'ai103', unitId: 'unit', activityId: 'second' },
		completions: {
			ai103__unit__unit__activity: { completedAt: WHEN, source: 'manual' },
			ai103__unit__unit__second: '2026-09-06T12:20:30+02:00'
		},
		startedAt: '2026-09-01T08:00:00Z'
	};
}

function portablePayload(course: Course) {
	return {
		format: 'cert-learner-progress', schemaVersion: 1, courseId: course.manifest.courseId,
		contentVersion: course.manifest.contentVersion,
		position: { unitId: 'unit', activityId: 'second' },
		completions: { [FIRST]: { completedAt: WHEN, source: 'verified', attempts: 2 } }
	};
}

/** Match the documented private storage naming, without adding a public filesystem API. */
function progressFile(directory: string, course: Course): string {
	return path.join(directory, `${createHash('sha256').update(course.id).digest('hex')}.json`);
}

async function linkOrSkip(context: Context, target: string, link: string, directory = false): Promise<void> {
	try { await symlink(target, link, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); } catch (error) {
		if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(String(error.code))) {
			context.skip();
		}
		throw error;
	}
}

describe('core: courses and local progress (no VS Code runtime)', function () {
	this.timeout(15_000);
	let temporary: string;
	let stateDirectory: string;

	beforeEach(async () => {
		temporary = await mkdtemp(path.join(tmpdir(), 'cert-learner-core-'));
		stateDirectory = path.join(temporary, 'progress');
	});

	afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

	async function fixture(name = 'course', input = manifest()): Promise<{ course: Course; file: string }> {
		const root = path.join(temporary, name);
		await mkdir(path.join(root, 'checks'), { recursive: true });
		await Promise.all([
			writeFile(path.join(root, 'lesson.md'), '# Private lesson body: never put this in progress'),
			writeFile(path.join(root, 'notes.md'), '# Private notes'),
			writeFile(path.join(root, 'quiz.md'), '# Quiz'),
			writeFile(path.join(root, 'lab.ipynb'), '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}'),
			writeFile(path.join(root, 'checks/check.js'), 'process.exitCode = 0;')
		]);
		const file = path.join(root, 'course.json');
		await writeFile(file, JSON.stringify(input));
		return { course: await loadCourse(file), file };
	}

	describe('manifest and resources', () => {
		it('normalizes manual completion without mutating input and preserves AI103 metadata', () => {
			const input = manifest();
			Object.assign(input, { $comment: 'existing metadata', weight: 10 });
			Object.assign(input.units[0], { $comment: 'unit metadata', weight: 5 });
			Object.assign(input.units[0].activities[0], { weight: 2 });
			const validated = validateManifest(input);
			assert.equal(input.units[0].activities[0].completion, undefined);
			assert.equal(validated.units[0].activities[0].completion, 'manual');
			assert.equal((validated as unknown as Record<string, unknown>).$comment, 'existing metadata');
			assert.equal((validated.units[0] as unknown as Record<string, unknown>).weight, 5);
			validated.units[0].title = 'changed';
			assert.equal(input.units[0].title, 'Unit one');
		});

		it('rejects malformed schemas, empty required arrays, duplicate IDs and missing checks', () => {
			for (const input of [null, {}, { ...manifest(), schemaVersion: 2 }, { ...manifest(), units: [] }]) {
				assert.throws(() => validateManifest(input), /manifest/i);
			}
			const duplicateUnit = manifest();
			duplicateUnit.units.push(duplicateUnit.units[0]);
			assert.throws(() => validateManifest(duplicateUnit), /Duplicate unitId/);
			const duplicateActivity = manifest();
			duplicateActivity.units[0].activities.push(duplicateActivity.units[0].activities[0]);
			assert.throws(() => validateManifest(duplicateActivity), /Duplicate activityId/);
			const missing = manifest();
			missing.units[0].activities[0].completion = 'check';
			assert.throws(() => validateManifest(missing), /check/);
		});

		it('allows activity IDs repeated in different units, with collision-free composite keys', () => {
			const input = manifest();
			assert.equal(input.units[1].activities[0].activityId, input.units[0].activities[0].activityId);
			assert.doesNotThrow(() => validateManifest(input));
			assert.equal(activityKey('a', 'b'), '["a","b"]');
			assert.notEqual(activityKey('a__b', 'c'), activityKey('a', 'b__c'));
			assert.notEqual(activityKey('a"', 'b'), activityKey('a', '"b'));
		});

		it('check objects allow only the declared runtime/file/cwd/timeout fields', () => {
			for (const extras of [{ command: 'echo nope' }, { args: [] }, { env: {} }, { shell: true }, { weight: 1 }]) {
				const input = manifest();
				Object.assign(input.units[0].activities[1].check!, extras);
				assert.throws(() => validateManifest(input), /additional properties/);
			}
			for (const timeout of [0, -1, 1.5, 3601]) {
				const input = manifest();
				input.units[0].activities[1].check!.timeoutSeconds = timeout;
				assert.throws(() => validateManifest(input), /timeoutSeconds/);
			}
			for (const runtime of ['node', 'python', 'pwsh'] as const) {
				const input = manifest();
				input.units[0].activities[1].check!.runtime = runtime;
				assert.equal(validateManifest(input).units[0].activities[1].check!.runtime, runtime);
			}
		});

		it('accepts only explicit credential-free HTTPS links', () => {
			assert.equal(safeHttps('https://example.com/path?q=1#section'), true);
			assert.equal(safeHttps('HTTPS://example.com:443/'), true);
			for (const url of ['http://example.com', 'javascript:alert(1)', 'file:///private', '//example.com',
				'https://user:password@example.com', 'https://@example.com', ' https://example.com',
				'https:///example.com', 'https://example.com\\evil', 'https://example.com\n', 'https://']) {
				assert.equal(safeHttps(url), false, url);
				assert.throws(() => validateManifest({ ...manifest(), studyGuideUrl: url }), /HTTPS/);
			}
			const input = manifest();
			input.references![0].url = 'https://user@example.com';
			assert.throws(() => validateManifest(input), /HTTPS/);
		});

		it('rejects traversal, absolute/drive paths, ADS, hidden paths and credential names', async () => {
			const { course } = await fixture();
			for (const relative of ['../lesson.md', 'sub/../../lesson.md', '/lesson.md', 'C:/lesson.md', 'C:lesson.md',
				'\\\\server\\share\\lesson.md', 'sub\\lesson.md', 'lesson.md:stream', '.env', '.hidden/lesson.md',
				'sub/./lesson.md', 'sub//lesson.md', 'credentials.json', 'credentials.md', 'secrets.yaml', 'id_rsa',
				'private.key', 'service-account.json', 'NUL.md', 'CON', 'lesson.md ', 'lesson.md.', 'bad\u0000.md']) {
				await assert.rejects(resolveResource(course.root, relative), /Unsafe resource path/, relative);
			}
			assert.equal(await resolveResource(course.root, 'lesson.md'), path.join(course.root, 'lesson.md'));
			await assert.rejects(resolveResource(course.root, 'checks'), /regular file/);
		});

		it('enforces markdown lessons/quizzes/resources and notebook labs', () => {
			for (const [key, value] of [['lesson', 'lesson.html'], ['quiz', 'quiz.js'], ['lab', 'lab.md']] as const) {
				const input = manifest();
				input.units[0].resources[key] = value;
				assert.throws(() => validateManifest(input), /pattern/);
			}
			const input = manifest();
			input.resources![0].path = 'notes.ipynb';
			assert.throws(() => validateManifest(input), /pattern/);
		});

		it('loads every referenced file and check cwd, not merely the lesson', async () => {
			const { course, file } = await fixture();
			for (const relative of ['lesson.md', 'lab.ipynb', 'quiz.md', 'notes.md', 'checks/check.js']) {
				const original = path.join(course.root, relative);
				await rename(original, `${original}.saved`);
				await assert.rejects(loadCourse(file), /ENOENT/);
				await rename(`${original}.saved`, original);
			}
			const input = manifest();
			input.units[0].activities[1].check!.cwd = 'missing-directory';
			await writeFile(file, JSON.stringify(input));
			await assert.rejects(loadCourse(file), /ENOENT/);
			input.units[0].activities[1].check!.cwd = 'lesson.md';
			await writeFile(file, JSON.stringify(input));
			await assert.rejects(loadCourse(file), /regular directory/);
			input.units[0].activities[1].check!.cwd = '.';
			await writeFile(file, JSON.stringify(input));
			await assert.doesNotReject(loadCourse(file));
		});

		it('canonicalizes root identity and excludes contentVersion from the course hash', async () => {
			const { course, file } = await fixture();
			assert.equal(course.root, await realpath(path.dirname(file)));
			assert.equal((await loadCourse(path.join(course.root, 'checks', '..', 'course.json'))).id, course.id);
			const input = manifest();
			input.contentVersion = '2.0';
			await writeFile(file, JSON.stringify(input));
			assert.equal((await loadCourse(file)).id, course.id);
			input.courseId = 'different';
			await writeFile(file, JSON.stringify(input));
			assert.notEqual((await loadCourse(file)).id, course.id);
			assert.notEqual((await fixture('different-root')).course.id, course.id);
		});

		it('rejects file symlinks escaping to a sibling with the same root prefix', async function () {
			const { course } = await fixture();
			const sibling = path.join(temporary, 'course-extra');
			await mkdir(sibling);
			await writeFile(path.join(sibling, 'outside.md'), '# outside');
			await linkOrSkip(this, path.join(sibling, 'outside.md'), path.join(course.root, 'escape.md'));
			await assert.rejects(resolveResource(course.root, 'escape.md'), /escapes/);
		});

		it('rejects escaping directory symlinks or Windows junctions', async function () {
			const { course } = await fixture();
			const outside = path.join(temporary, 'outside');
			await mkdir(outside);
			await writeFile(path.join(outside, 'lesson.md'), '# outside');
			await linkOrSkip(this, outside, path.join(course.root, 'linked-directory'), true);
			await assert.rejects(resolveResource(course.root, 'linked-directory/lesson.md'), /escapes/);
		});

		it('allows internal aliases but rejects aliases to hidden or wrongly typed content', async function () {
			const { course, file } = await fixture();
			await linkOrSkip(this, path.join(course.root, 'lesson.md'), path.join(course.root, 'alias.md'));
			assert.equal(await resolveResource(course.root, 'alias.md'), path.join(course.root, 'lesson.md'));
			await writeFile(path.join(course.root, '.env'), 'DO_NOT_READ=this-is-test-data');
			await linkOrSkip(this, path.join(course.root, '.env'), path.join(course.root, 'hidden-alias.md'));
			await assert.rejects(resolveResource(course.root, 'hidden-alias.md'), /hidden|credential/);
			await linkOrSkip(this, path.join(course.root, 'checks/check.js'), path.join(course.root, 'wrong-type.md'));
			const input = manifest();
			input.units[0].resources.lesson = 'wrong-type.md';
			await writeFile(file, JSON.stringify(input));
			await assert.rejects(loadCourse(file), /Resolved course content/);
		});

		it('gives the same identity when opened through a directory alias', async function () {
			const { course } = await fixture();
			const alias = path.join(temporary, 'course-alias');
			await linkOrSkip(this, course.root, alias, true);
			assert.equal((await loadCourse(path.join(alias, 'course.json'))).id, course.id);
		});

		it('rejects oversized, circular and accessor-bearing manifest inputs', async () => {
			const input = manifest();
			Object.assign(input, { extra: 'x'.repeat(2 * 1024 * 1024) });
			assert.throws(() => validateManifest(input), /bounded/);
			const circular = manifest();
			Object.assign(circular, { self: circular });
			assert.throws(() => validateManifest(circular), /bounded/);
			const accessor = manifest();
			let called = false;
			Object.defineProperty(accessor, 'extra', { enumerable: true, get() { called = true; return 'x'; } });
			assert.throws(() => validateManifest(accessor), /bounded/);
			assert.equal(called, false);
			const { file } = await fixture();
			await writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
			await assert.rejects(loadCourse(file), /no larger/);
		});
	});

	describe('progress persistence and concurrency', () => {
		it('reloads progress, keeps revisions, and isolates roots sharing the same manifest courseId', async () => {
			const { course } = await fixture();
			const other = (await fixture('other-course')).course;
			const store = new ProgressStore(stateDirectory);
			const initial = await store.read(course);
			assert.equal(initial.revision, 0);
			assert.equal(initial.courseId, course.id);
			assert.deepEqual(initial.position, { unitId: 'unit', activityId: 'activity' });
			const saved = await store.update(course, progress => {
				progress.completions[FIRST] = { completedAt: WHEN, source: 'manual' };
				progress.position = { unitId: 'unit', activityId: 'second' };
			});
			assert.equal(saved.revision, 1);
			assert.deepEqual(await new ProgressStore(stateDirectory).read(course), saved);
			assert.deepEqual((await store.read(other)).completions, {});
			saved.completions[FIRST].source = 'imported';
			assert.equal((await store.read(course)).completions[FIRST].source, 'manual');
		});

		it('serializes concurrent updates across ProgressStore instances without losing increments', async () => {
			const { course } = await fixture();
			const stores = [new ProgressStore(stateDirectory), new ProgressStore(stateDirectory)];
			const results = await Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % 2].update(course, progress => {
				progress.completions[FIRST] = { attempts: (progress.completions[FIRST]?.attempts ?? 0) + 1, lastResult: 'failed' };
			})));
			assert.deepEqual(results.map(result => result.revision).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
			const latest = await stores[0].read(course);
			assert.equal(latest.completions[FIRST].attempts, 20);
			assert.equal(latest.revision, 20);
			assert.equal((await readdir(stateDirectory)).some(name => /\.(?:lock|tmp)$/u.test(name)), false);
		});

		it('refuses an existing wx lock promptly and leaves the other writer\'s lock untouched', async () => {
			const { course } = await fixture();
			await mkdir(stateDirectory);
			const file = progressFile(stateDirectory, course);
			const lock = await open(`${file}.lock`, 'wx');
			await lock.writeFile('another writer');
			try {
				const store = new ProgressStore(stateDirectory);
				await assert.rejects(store.update(course, progress => { progress.completions[FIRST] = { attempts: 1 }; }), /locked/);
				assert.equal(await readFile(`${file}.lock`, 'utf8'), 'another writer');
				await assert.rejects(lstat(file), /ENOENT/);
			} finally { await lock.close(); }
		});

		it('detects external byte/revision changes during a mutation, preserving primary and backup', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			await store.update(course, p => { p.completions[FIRST].attempts = 2; });
			const file = progressFile(stateDirectory, course);
			const original = await readFile(file, 'utf8');
			const backup = await readFile(`${file}.bak`, 'utf8');
			const external = JSON.parse(original) as Progress;
			for (const replacement of [
				JSON.stringify({ ...external, completions: { [OTHER]: { attempts: 7 } } }), // Same revision.
				JSON.stringify({ ...external, revision: external.revision + 1 }),
				`${original}\n`, // Same parsed content; raw bytes differ.
				'{external-incomplete-write'
			]) {
				await writeFile(file, original);
				await assert.rejects(store.update(course, p => {
					p.completions[SECOND] = { attempts: 1 };
					writeFileSync(file, replacement);
				}), /changed outside|Refusing to overwrite/);
				assert.equal(await readFile(file, 'utf8'), replacement);
				assert.equal(await readFile(`${file}.bak`, 'utf8'), backup);
				assert.equal((await readdir(stateDirectory)).some(name => /\.(?:lock|tmp)$/u.test(name)), false);
			}
			await writeFile(file, original);
			assert.equal((await store.update(course, p => { p.completions[SECOND] = { attempts: 1 }; })).revision, 3);
		});

		it('detects external creation, deletion and changes during a no-op transaction', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const file = progressFile(stateDirectory, course);
			const external = JSON.stringify({ ...payload(course), completions: { [OTHER]: { attempts: 4 } } });
			await assert.rejects(store.update(course, p => {
				p.completions[FIRST] = { attempts: 1 };
				writeFileSync(file, external);
			}), /changed outside/);
			assert.equal(await readFile(file, 'utf8'), external);
			await assert.rejects(lstat(`${file}.bak`), /ENOENT/);
			await assert.rejects(store.update(course, () => { writeFileSync(file, `${external}\n`); }), /changed outside/);
			assert.equal(await readFile(file, 'utf8'), `${external}\n`);
			await assert.rejects(store.update(course, p => {
				p.completions[FIRST] = { attempts: 1 };
				unlinkSync(file);
			}), /changed outside/);
			await assert.rejects(lstat(file), /ENOENT/);
			assert.deepEqual(await readdir(stateDirectory), []);
		});

		it('rechecks after staging the primary, not just before writing the backup', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			const file = progressFile(stateDirectory, course);
			const external = JSON.stringify({ ...payload(course), revision: 1, completions: { [OTHER]: { attempts: 9 } } });
			// Fault injection at the private replacement boundary: no timers or filesystem polling.
			const writer = store as unknown as {
				atomicWrite(file: string, text: string, beforeReplace?: () => Promise<void>, guard?: () => boolean): Promise<void>;
			};
			const originalWrite = writer.atomicWrite.bind(store);
			writer.atomicWrite = (target, text, beforeReplace, guard) => originalWrite(target, text, async () => {
				// The store canonicalizes the directory (including Windows short names/junctions).
				if (path.basename(target) === path.basename(file)) { await writeFile(file, external); }
				if (beforeReplace) { await beforeReplace(); }
			}, guard);
			await assert.rejects(store.update(course, p => { p.completions[SECOND] = { attempts: 1 }; }), /changed outside/);
			assert.equal(await readFile(file, 'utf8'), external);
			assert.equal((await readdir(stateDirectory)).some(name => /\.(?:lock|tmp)$/u.test(name)), false);
		});

		it('rejects an invalid guard at transaction start without invoking the mutation', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			let mutated = false;
			await assert.rejects(store.update(course, () => { mutated = true; }, () => false), /Progress update was cancelled/);
			assert.equal(mutated, false);
			assert.deepEqual(await readdir(stateDirectory), []);
		});

		for (const savedUpdates of [0, 1, 2]) {
			it(`cancels after primary staging/external check, preserving both originals (${savedUpdates} prior saves)`, async () => {
				const { course } = await fixture();
				const store = new ProgressStore(stateDirectory);
				for (let attempt = 1; attempt <= savedUpdates; attempt++) {
					await store.update(course, p => { p.completions[FIRST] = { attempts: attempt }; });
				}
				const before = await store.read(course);
				const file = progressFile(stateDirectory, course);
				const originals = (await readdir(stateDirectory)).sort();
				const originalBytes = await Promise.all(originals.map(name => readFile(path.join(stateDirectory, name))));
				const completion = { completedAt: WHEN, source: 'verified' as const, lastResult: 'passed' as const, attempts: 1 };
				let cancelled = false;
				let guardCalls = 0;
				const writer = store as unknown as {
					atomicWrite(file: string, text: string, beforeReplace?: () => Promise<void>, guard?: () => boolean): Promise<void>;
				};
				const originalWrite = writer.atomicWrite.bind(store);
				writer.atomicWrite = (target, text, beforeReplace, guard) => originalWrite(target, text, async () => {
					if (beforeReplace) { await beforeReplace(); }
					if (path.basename(target) === path.basename(file)) {
						// Deterministically cancel AFTER the existing external-state check and fsync/close.
						// No timers or polling: verify the passing completion really is staged, not committed.
						const staged = (await readdir(stateDirectory)).filter(name => name.endsWith('.tmp'));
						assert.equal(staged.length, savedUpdates > 0 ? 2 : 1);
						const primary = staged.find(name => !name.startsWith(`${path.basename(file)}.bak.`));
						assert.ok(primary);
						const draft = JSON.parse(await readFile(path.join(stateDirectory, primary), 'utf8')) as Progress;
						assert.deepEqual(draft.completions[SECOND], completion);
						cancelled = true;
					}
				}, guard);
				try {
					await assert.rejects(store.update(course, p => { p.completions[SECOND] = completion; }, () => {
						guardCalls++;
						return !cancelled;
					}), /Progress update was cancelled/);
				} finally { writer.atomicWrite = originalWrite; }
				assert.equal(cancelled, true);
				assert.equal(guardCalls, 2);
				assert.deepEqual((await readdir(stateDirectory)).sort(), originals);
				assert.deepEqual(await Promise.all(originals.map(name => readFile(path.join(stateDirectory, name)))), originalBytes);
				assert.deepEqual(await store.read(course), before);
				// Cancellation is per-update: an ordinary write still succeeds on the same queue/store.
				const other = await store.update(course, p => { p.completions[OTHER] = { completedAt: WHEN, source: 'manual' }; });
				assert.equal(other.revision, before.revision + 1);
				assert.equal(other.completions[OTHER].source, 'manual');
				assert.equal(other.completions[SECOND], undefined);
				assert.deepEqual(await store.read(course), other);
				assert.equal((await readdir(stateDirectory)).some(name => /\.(?:lock|tmp)$/u.test(name)), false);
			});
		}

		it('keeps a committed update and publishes its backup if cancelled after primary rename', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			const before = await store.update(course, p => { p.completions[FIRST].attempts = 2; });
			const file = progressFile(stateDirectory, course);
			let cancelled = false;
			const writer = store as unknown as {
				atomicWrite(file: string, text: string, beforeReplace?: () => Promise<void>, guard?: () => boolean): Promise<void>;
			};
			const originalWrite = writer.atomicWrite.bind(store);
			writer.atomicWrite = async (target, text, beforeReplace, guard) => {
				await originalWrite(target, text, beforeReplace, guard);
				if (path.basename(target) === path.basename(file)) { cancelled = true; }
			};
			let committed: Progress;
			try {
				committed = await store.update(course, p => {
					p.completions[SECOND] = { completedAt: WHEN, source: 'verified', lastResult: 'passed', attempts: 1 };
				}, () => !cancelled);
			} finally { writer.atomicWrite = originalWrite; }
			assert.equal(cancelled, true);
			assert.equal(committed.revision, before.revision + 1);
			assert.equal(committed.completions[SECOND].completedAt, WHEN);
			assert.deepEqual(await store.read(course), committed);
			assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')) as Progress, before);
			assert.equal((await readdir(stateDirectory)).some(name => /\.(?:lock|tmp)$/u.test(name)), false);
		});

		it('recovers its in-process queue and own lock after a throwing mutation', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await assert.rejects(store.update(course, progress => {
				progress.completions[FIRST] = { completedAt: WHEN };
				throw new Error('callback failed');
			}), /callback failed/);
			assert.deepEqual((await store.read(course)).completions, {});
			assert.equal((await store.update(course, progress => { progress.completions[FIRST] = { attempts: 1 }; })).revision, 1);
		});

		it('keeps a last-good atomic backup and refuses corrupt/future state rather than resetting', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const first = await store.update(course, progress => { progress.completions[FIRST] = { completedAt: WHEN, source: 'manual' }; });
			await store.update(course, progress => { progress.completions[SECOND] = { attempts: 1, lastResult: 'blocked' }; });
			const file = progressFile(stateDirectory, course);
			const backup = await readFile(`${file}.bak`, 'utf8');
			assert.deepEqual(JSON.parse(backup) as unknown, first);
			for (const content of ['{broken', JSON.stringify({ ...payload(course), schemaVersion: 99 }), JSON.stringify({ ...payload(course), unexpected: 'output' })]) {
				await writeFile(file, content);
				await assert.rejects(store.read(course), /Refusing to overwrite/);
				await assert.rejects(store.update(course, progress => { progress.completions = {}; }), /Refusing to overwrite/);
				await assert.rejects(store.reset(course), /Refusing to overwrite/);
				await assert.rejects(store.import(course, payload(course)), /Refusing to overwrite/);
				assert.equal(await readFile(file, 'utf8'), content);
				assert.equal(await readFile(`${file}.bak`, 'utf8'), backup);
			}
		});

		it('refuses missing primaries with backups and refuses unsupported backup files', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			await store.update(course, p => { p.completions[FIRST].attempts = 2; });
			const file = progressFile(stateDirectory, course);
			const original = await readFile(file, 'utf8');
			await rm(file);
			await assert.rejects(store.reset(course), /backup exists/);
			await assert.rejects(lstat(file), /ENOENT/);
			await writeFile(file, original);
			await writeFile(`${file}.bak`, JSON.stringify({ ...payload(course), schemaVersion: 2 }));
			await assert.rejects(store.update(course, p => { p.completions = {}; }), /unsupported progress/);
			assert.equal(await readFile(file, 'utf8'), original);
		});

		it('rejects symlinked state files without writing through them', async function () {
			const { course } = await fixture();
			await mkdir(stateDirectory);
			const target = path.join(temporary, 'outside-state.json');
			const original = JSON.stringify(payload(course));
			await writeFile(target, original);
			await linkOrSkip(this, target, progressFile(stateDirectory, course));
			await assert.rejects(new ProgressStore(stateDirectory).reset(course), /symlinks/);
			assert.equal(await readFile(target, 'utf8'), original);
		});

		it('reset clears only the requested unit/course and resets position to that scope', async () => {
			const { course } = await fixture();
			const otherCourse = (await fixture('other-course')).course;
			const store = new ProgressStore(stateDirectory);
			await store.update(course, progress => {
				for (const key of [FIRST, SECOND, OTHER]) { progress.completions[key] = { completedAt: WHEN, source: 'manual' }; }
				progress.position = { unitId: 'other', activityId: 'activity' };
			});
			const untouched = await store.update(otherCourse, progress => { progress.completions[FIRST] = { completedAt: WHEN }; });
			const partial = await store.reset(course, 'unit');
			assert.deepEqual(Object.keys(partial.completions), [OTHER]);
			assert.deepEqual(partial.position, { unitId: 'unit', activityId: 'activity' });
			assert.deepEqual(await store.read(otherCourse), untouched);
			await assert.rejects(store.reset(course, 'missing'), /unknown unit/);
			assert.deepEqual(await store.read(course), partial);
			const all = await store.reset(course);
			assert.deepEqual(all.completions, {});
			assert.deepEqual(all.position, { unitId: 'unit', activityId: 'activity' });
			assert.deepEqual(await store.read(otherCourse), untouched);
		});

		it('preserves stale contentVersion on read, navigation, completion and reset', async () => {
			const { course, file } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, progress => { progress.completions[FIRST] = { completedAt: WHEN }; });
			const input = manifest();
			input.contentVersion = '2.0';
			await writeFile(file, JSON.stringify(input));
			const changed = await loadCourse(file);
			assert.equal(changed.id, course.id);
			assert.equal((await store.read(changed)).contentVersion, '1.0');
			const navigated = await store.update(changed, progress => {
				progress.position = { unitId: 'unit', activityId: 'second' };
				progress.completions[SECOND] = { attempts: 1 };
			});
			assert.equal(navigated.contentVersion, '1.0');
			await assert.rejects(store.update(changed, progress => { progress.contentVersion = '2.0'; }), /cannot be changed/);
			assert.equal((await store.reset(changed)).contentVersion, '1.0');
		});

		it('preserves removed historical IDs in stale content without accepting new unknown IDs', async () => {
			const { course, file } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, progress => { progress.completions[FIRST] = { completedAt: WHEN }; });
			const input = manifest();
			input.contentVersion = '2.0';
			input.units[0].activities.shift();
			await writeFile(file, JSON.stringify(input));
			const changed = await loadCourse(file);
			assert.equal((await store.read(changed)).completions[FIRST].completedAt, WHEN);
			const navigated = await store.update(changed, progress => { progress.position = { unitId: 'unit', activityId: 'second' }; });
			assert.equal(navigated.completions[FIRST].completedAt, WHEN);
			await assert.rejects(store.update(changed, progress => { progress.completions[activityKey('unit', 'unknown')] = { attempts: 1 }; }), /unknown historical/);
			await assert.rejects(store.import(changed, navigated), /Unknown unit\/activity/);
			assert.deepEqual((await store.reset(changed, 'unit')).completions, {});
		});
	});

	describe('progress validation and imports', () => {
		it('merges explicit completions, preserves local completion/position, and does not trust verified imports', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, progress => {
				progress.completions[FIRST] = { completedAt: WHEN, source: 'verified', attempts: 2, lastResult: 'passed' };
				progress.position = { unitId: 'other', activityId: 'activity' };
			});
			const input = payload(course);
			input.revision = 900;
			input.position = { unitId: 'unit', activityId: 'second' };
			input.completions[FIRST] = { completedAt: '2026-09-05T09:00:00Z', source: 'imported', attempts: 1 };
			input.completions[SECOND] = { completedAt: WHEN, source: 'verified', attempts: 3, lastResult: 'passed' };
			const merged = await store.import(course, input);
			assert.equal(merged.revision, 2);
			assert.deepEqual(merged.position, { unitId: 'other', activityId: 'activity' });
			assert.equal(merged.completions[FIRST].completedAt, WHEN);
			assert.equal(merged.completions[FIRST].source, 'verified');
			assert.equal(merged.completions[FIRST].attempts, 2);
			assert.equal(merged.completions[SECOND].source, 'imported');
			assert.equal(merged.completions[OTHER], undefined);
			assert.deepEqual(await store.import(course, input), merged);
		});

		it('rejects cross-course, version mismatch, unknown units/activities, noncanonical keys and extra fields before saving', async () => {
			const { course } = await fixture();
			const other = (await fixture('different-root')).course;
			const store = new ProgressStore(stateDirectory);
			await store.update(course, progress => { progress.completions[FIRST] = { completedAt: WHEN }; });
			const file = progressFile(stateDirectory, course);
			const before = await readFile(file, 'utf8');
			const bad: unknown[] = [payload(other), { ...payload(course), contentVersion: '99' },
				{ ...payload(course), output: 'DO_NOT_PERSIST' },
				{ ...payload(course), position: { unitId: 'unknown', activityId: 'second' } },
				{ ...payload(course), position: { unitId: 'unit', activityId: 'missing' } },
				...['["unit", "second"]', activityKey('unknown', 'second'), activityKey('unit', 'missing'), '__proto__'].map(key => ({
					...payload(course), completions: { [FIRST]: { completedAt: WHEN }, [key]: { completedAt: WHEN } }
				})),
				{ ...payload(course), completions: { [SECOND]: { completedAt: WHEN, stdout: 'DO_NOT_PERSIST' } } }
			];
			for (const input of bad) {
				await assert.rejects(store.import(course, input));
				assert.equal(await readFile(file, 'utf8'), before);
			}
		});

		it('allows stale-version imports only when they match stored progress, not by upgrading it', async () => {
			const { course, file } = await fixture();
			const store = new ProgressStore(stateDirectory);
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			const input = manifest();
			input.contentVersion = '2.0';
			await writeFile(file, JSON.stringify(input));
			const changed = await loadCourse(file);
			await assert.rejects(store.import(changed, payload(changed)), /contentVersion does not match/);
			const old = payload(course);
			old.completions[SECOND] = { completedAt: WHEN };
			assert.equal((await store.import(changed, old)).contentVersion, '1.0');
			await assert.rejects(new ProgressStore(path.join(temporary, 'fresh-state')).import(changed, old), /contentVersion does not match/);
		});

		it('legacy v1 imports the full envelope with unprefixed IDs, doubled keys and position idempotently', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const input = legacyPayload();
			const first = await store.importLegacy(course, input);
			assert.deepEqual(Object.keys(first.completions).sort(), [FIRST, SECOND].sort());
			assert.equal(first.completions[FIRST].source, 'imported');
			assert.equal(first.completions[SECOND].completedAt, WHEN);
			assert.deepEqual(first.position, { unitId: 'unit', activityId: 'second' });
			assert.equal(first.contentVersion, course.manifest.contentVersion);
			assert.equal('startedAt' in first, false);
			assert.deepEqual(parseLegacyProgress(input, course), first.completions);
			const file = progressFile(stateDirectory, course);
			const original = await readFile(file, 'utf8');
			assert.deepEqual(await store.importLegacy(course, input), first);
			assert.equal(await readFile(file, 'utf8'), original);
		});

		it('rejects unknown/near-matching legacy IDs atomically, instead of partially importing', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			for (const key of ['ai103__unit__missing', 'ai103__unit__unit__activity__extra', 'other__unit__unit__activity']) {
				await assert.rejects(store.importLegacy(course, { ...legacyPayload(), completions: {
					ai103__unit__unit__activity: { completedAt: WHEN }, [key]: { completedAt: WHEN }
				} }), /Unknown legacy/);
				await assert.rejects(lstat(progressFile(stateDirectory, course)), /ENOENT/);
			}
			await assert.rejects(store.importLegacy(course, { version: 2, completions: {} }), /version: 1/);
			const other = manifest();
			other.courseId = 'other';
			const different = (await fixture('other', other)).course;
			await assert.rejects(store.importLegacy(different, { version: 1, completions: {} }), /only be imported into/);
		});

		it('validates every legacy envelope field before creating or changing progress', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const input = legacyPayload();
			const bad: unknown[] = [
				{ ...input, rawOutput: 'secret' }, { ...input, secret: 'secret' },
				...['bad', '', '2026-02-30T00:00:00Z', '2026-09-01T08:00:00', 'x'.repeat(33), null, 0, {}]
					.map(startedAt => ({ ...input, startedAt })),
				...[null, {}, { ...input.position, courseId: 'other' }, { ...input.position, unitId: 'missing' },
					{ ...input.position, activityId: 'unit__second' }, { ...input.position, output: 'secret' }]
					.map(position => ({ ...input, position })),
				{ ...input, completions: { ai103__unit__unit__activity: { completedAt: 'bad' } } },
				{ ...input, completions: { ai103__unit__unit__activity: { completedAt: WHEN, stdout: 'secret' } } }
			];
			for (const value of bad) {
				assert.throws(() => parseLegacyProgress(value, course));
				await assert.rejects(store.importLegacy(course, value));
				await assert.rejects(lstat(stateDirectory), /ENOENT/);
			}
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			await store.update(course, p => { p.completions[FIRST].attempts = 2; });
			const file = progressFile(stateDirectory, course);
			const before = await readFile(file, 'utf8');
			const backup = await readFile(`${file}.bak`, 'utf8');
			for (const value of bad) {
				await assert.rejects(store.importLegacy(course, value));
				assert.equal(await readFile(file, 'utf8'), before);
				assert.equal(await readFile(`${file}.bak`, 'utf8'), backup);
			}
		});

		it('accepts generated single-unit aliases and delimiter IDs without guessing or order-dependent merges', async () => {
			const { course } = await fixture();
			const expected = { [FIRST]: { completedAt: WHEN, source: 'imported' } };
			assert.deepEqual(parseLegacyProgress({ version: 1, completions: { ai103__unit__activity: WHEN } }, course), expected);
			assert.deepEqual(parseLegacyProgress({ version: 1, completions: {
				ai103__unit__activity: WHEN, ai103__unit__unit__activity: WHEN
			} }, course), expected);
			const store = new ProgressStore(stateDirectory);
			await assert.rejects(store.importLegacy(course, { ...legacyPayload(), completions: {
				ai103__unit__activity: WHEN, ai103__unit__unit__activity: '2026-09-05T10:00:00Z'
			} }), /Conflicting legacy aliases/);
			await assert.rejects(lstat(stateDirectory), /ENOENT/);
			const input = manifest();
			input.units[0].unitId = 'unit__one';
			input.units[0].activities[0].activityId = 'read__lesson';
			const delimited = (await fixture('delimited', input)).course;
			assert.deepEqual(parseLegacyProgress({ version: 1, completions: {
				ai103__unit__one__unit__one__read__lesson: WHEN
			} }, delimited), { [activityKey('unit__one', 'read__lesson')]: expected[FIRST] });
		});

		it('detects inherently ambiguous legacy delimiter keys rather than choosing a match', async () => {
			const input = manifest();
			input.units[0].unitId = 'a__b';
			input.units[0].activities[0].activityId = 'c';
			input.units[1].unitId = 'a';
			input.units[1].activities[0].activityId = 'b__c';
			const { course } = await fixture('ambiguous', input);
			assert.throws(() => parseLegacyProgress({ version: 1, completions: {} }, course), /Ambiguous legacy/);
			const aliasCollision = manifest();
			aliasCollision.units[0].activities[1].activityId = 'unit__activity';
			const collision = (await fixture('alias-collision', aliasCollision)).course;
			await assert.rejects(new ProgressStore(stateDirectory).importLegacy(collision, {
				version: 1, completions: { ai103__unit__unit__activity: WHEN }
			}), /Ambiguous legacy/);
			await assert.rejects(lstat(stateDirectory), /ENOENT/);
		});

		it('relocates portable progress between roots of the same logical course, not internal payloads', async () => {
			const { course } = await fixture();
			const relocated = (await fixture('another-machine-root')).course;
			const store = new ProgressStore(stateDirectory);
			await store.update(course, p => { p.completions[FIRST] = { completedAt: WHEN, source: 'verified' }; });
			const original = await store.update(course, p => { p.position = { unitId: 'unit', activityId: 'second' }; });
			const exported = exportProgress(course, original);
			const wire: unknown = JSON.parse(JSON.stringify(exported));
			const parsed = parsePortableProgress(relocated, wire);
			assert.notEqual(relocated.id, course.id);
			assert.equal(parsed.courseId, relocated.id);
			assert.equal(parsed.revision, 0);
			assert.deepEqual(parsed.position, original.position);
			await assert.rejects(store.import(relocated, original), /course ID does not match/);
			const imported = await store.import(relocated, wire);
			assert.equal(imported.courseId, relocated.id);
			assert.equal(imported.contentVersion, original.contentVersion);
			assert.equal(imported.revision, 1);
			assert.deepEqual(imported.position, original.position);
			assert.deepEqual(imported.completions[FIRST], { completedAt: WHEN, source: 'imported' });
			assert.deepEqual(await store.read(course), original);
			assert.deepEqual(await new ProgressStore(stateDirectory).read(relocated), imported);
			assert.deepEqual(await store.import(relocated, wire), imported);
		});

		it('rejects invalid portable envelopes and raw-output/secret fields at every level before writes', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const input = portablePayload(course);
			const bad: unknown[] = [null, [],
				{ ...input, format: 'other' }, { ...input, schemaVersion: 2 },
				{ ...input, courseId: 'wrong-logical-course' }, { ...input, courseId: course.id },
				{ ...input, contentVersion: '99' }, { ...input, contentVersion: '' },
				...['format', 'schemaVersion', 'courseId', 'contentVersion', 'completions'].map(key =>
					Object.fromEntries(Object.entries(input).filter(([name]) => name !== key))),
				...['revision', 'root', 'hash', 'output', 'rawOutput', 'secret', 'password'].map(key => ({ ...input, [key]: 'DO_NOT_PERSIST' })),
				...[null, {}, { unitId: 'unknown', activityId: 'second' }, { unitId: 'unit', activityId: 'missing' }]
					.map(position => ({ ...input, position })),
				...['stdout', 'stderr', 'rawOutput', 'secret', 'courseId'].map(key => ({ ...input, position: { ...input.position, [key]: 'DO_NOT_PERSIST' } })),
				...['stdout', 'stderr', 'output', 'secret', 'env'].map(key => ({ ...input, completions: { [FIRST]: { completedAt: WHEN, [key]: 'DO_NOT_PERSIST' } } })),
				...['["unit", "second"]', activityKey('unknown', 'second'), activityKey('unit', 'missing'), '__proto__'].map(key => ({
					...input, completions: { ...input.completions, [key]: { completedAt: WHEN } }
				})),
				{ ...input, completions: { [FIRST]: { completedAt: '2026-02-30T00:00:00Z' } } },
				{ ...input, completions: { [FIRST]: { attempts: 1_000_001 } } }
			];
			for (const value of bad) {
				assert.throws(() => parsePortableProgress(course, value));
				await assert.rejects(store.import(course, value));
				await assert.rejects(lstat(stateDirectory), /ENOENT/);
			}
			const otherManifest = manifest();
			otherManifest.courseId = 'another-course';
			const other = (await fixture('different-logical-course', otherManifest)).course;
			assert.throws(() => parsePortableProgress(other, input), /logical course ID/);
			await assert.rejects(store.import(other, input), /logical course ID/);
			await assert.rejects(lstat(stateDirectory), /ENOENT/);
			await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			await store.update(course, p => { p.completions[FIRST].attempts = 2; });
			const file = progressFile(stateDirectory, course);
			const before = await readFile(file, 'utf8');
			const backup = await readFile(`${file}.bak`, 'utf8');
			for (const value of bad) {
				await assert.rejects(store.import(course, value));
				assert.equal(await readFile(file, 'utf8'), before);
				assert.equal(await readFile(`${file}.bak`, 'utf8'), backup);
			}
		});

		it('preserves exported historical versions and never advances versions during portable or legacy import', async () => {
			const { course, file } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const old = await store.update(course, p => { p.completions[FIRST] = { attempts: 1 }; });
			const changedManifest = manifest();
			changedManifest.contentVersion = '2.0';
			await writeFile(file, JSON.stringify(changedManifest));
			const changed = await loadCourse(file);
			const exported = exportProgress(changed, await store.read(changed));
			assert.equal((exported as Record<string, unknown>).contentVersion, '1.0');
			assert.throws(() => parsePortableProgress(changed, exported), /contentVersion does not match/);
			await assert.rejects(store.import(changed, exported), /contentVersion does not match/);
			await assert.rejects(store.import(changed, portablePayload(changed)), /contentVersion does not match stored progress/);
			const freshDirectory = path.join(temporary, 'fresh-portable');
			await assert.rejects(new ProgressStore(freshDirectory).import(changed, exported), /contentVersion does not match/);
			await assert.rejects(lstat(freshDirectory), /ENOENT/);
			assert.deepEqual(await store.read(changed), old);
			const migrated = await store.importLegacy(changed, legacyPayload());
			assert.equal(migrated.contentVersion, '1.0');
			assert.deepEqual(migrated.position, old.position);
			// A matching old manifest at a new root can consume that portable version.
			const matching = (await fixture('matching-old-content')).course;
			assert.equal((await store.import(matching, exported)).contentVersion, '1.0');
		});

		it('adopts imported position only at revision zero with no completions, for all import formats', async () => {
			const { course } = await fixture();
			const position = { unitId: 'unit', activityId: 'second' };
			const localPosition = { unitId: 'other', activityId: 'activity' };
			for (const format of ['internal', 'portable', 'legacy']) {
				const importInto = (store: ProgressStore): Promise<Progress> => format === 'legacy'
					? store.importLegacy(course, { ...legacyPayload(), completions: {} })
					: store.import(course, format === 'portable'
						? { ...portablePayload(course), completions: {} }
						: { ...payload(course), revision: 900, position });
				const fresh = new ProgressStore(path.join(temporary, `${format}-fresh`));
				await fresh.read(course);
				const imported = await importInto(fresh);
				assert.equal(imported.revision, 1);
				assert.deepEqual(imported.position, position);
				assert.deepEqual(imported.completions, {});
				assert.deepEqual(await importInto(fresh), imported);
				const existing = new ProgressStore(path.join(temporary, `${format}-existing`));
				const navigated = await existing.update(course, p => { p.position = localPosition; });
				assert.deepEqual(await importInto(existing), navigated); // Revision > 0, even without completions.
				const directory = path.join(temporary, `${format}-revision-zero`);
				await mkdir(directory);
				const seeded = { ...payload(course), position: localPosition, completions: { [FIRST]: { attempts: 1 } } };
				await writeFile(progressFile(directory, course), JSON.stringify(seeded));
				assert.deepEqual(await importInto(new ProgressStore(directory)), seeded); // Revision 0, but not empty.
			}
		});

		it('validates timestamps, states, attempt/revision bounds and schema versions', async () => {
			const { course } = await fixture();
			for (const completedAt of ['yesterday', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-06',
				'2026-09-06T24:00:00Z', '2026-09-06T10:00:00', '2026-09-06T10:00:00+25:00']) {
				assert.throws(() => parseProgress({ ...payload(course), completions: { [FIRST]: { completedAt } } }, course), /completedAt/);
			}
			for (const item of [{ source: 'auto' }, { lastResult: 'success' }, { attempts: -1 }, { attempts: 0.5 },
				{ attempts: 1_000_001 }, { attempts: Number.NaN }, { completedAt: null }]) {
				assert.throws(() => parseProgress({ ...payload(course), completions: { [FIRST]: item } }, course));
			}
			for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				assert.throws(() => parseProgress({ ...payload(course), revision }, course), /revision/);
			}
			assert.throws(() => parseProgress({ ...payload(course), schemaVersion: 2 }, course), /schemaVersion/);
			const parsed = parseProgress({ ...payload(course), completions: { [FIRST]: { completedAt: '2026-09-06T12:20:30+02:00' } } }, course);
			assert.equal(parsed.completions[FIRST].completedAt, WHEN);
		});

		it('exports only the progress allowlist, with no paths, lesson content, outputs or secrets', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			const progress = await store.update(course, p => { p.completions[FIRST] = { completedAt: WHEN, source: 'manual', lastResult: 'passed', attempts: 1 }; });
			const portable = exportProgress(course, progress);
			const exported = JSON.stringify(portable);
			assert.deepEqual(portable, {
				format: 'cert-learner-progress', schemaVersion: 1, courseId: 'ai103', contentVersion: '1.0',
				position: { unitId: 'unit', activityId: 'activity' },
				completions: { [FIRST]: { completedAt: WHEN, source: 'manual', lastResult: 'passed', attempts: 1 } }
			});
			assert.deepEqual(Object.keys(portable).sort(), ['format', 'schemaVersion', 'courseId', 'contentVersion', 'position', 'completions'].sort());
			for (const forbidden of ['lesson.md', 'Private lesson body', course.root, course.id, 'revision', 'Course title', 'checks/check.js', 'stdout', 'password']) {
				assert.equal(exported.includes(forbidden), false, forbidden);
			}
			assert.deepEqual(parsePortableProgress(course, JSON.parse(exported) as unknown), { ...progress, revision: 0 });
			assert.throws(() => exportProgress(course, { ...progress, output: 'secret' } as Progress), /unsupported fields/);
			assert.throws(() => exportProgress(course, { ...progress, completions: { [FIRST]: { ...progress.completions[FIRST], stdout: 'secret' } } } as unknown as Progress), /unsupported fields/);
			progress.position!.activityId = 'second';
			progress.completions[FIRST].attempts = 99;
			assert.equal(JSON.stringify(portable), exported); // No retained caller-owned objects.
			const noPosition = exportProgress(course, payload(course));
			assert.equal('position' in noPosition, false);
			assert.deepEqual(parsePortableProgress(course, noPosition), payload(course));
			const file = progressFile(stateDirectory, course);
			const original = await readFile(file, 'utf8');
			await assert.rejects(store.update(course, p => { Object.assign(p.completions[FIRST], { output: 'secret-value' }); }), /unsupported fields/);
			await assert.rejects(store.update(course, p => { Object.assign(p, { manifest: course.manifest }); }), /unsupported fields/);
			assert.equal(await readFile(file, 'utf8'), original);
			assert.deepEqual(parseProgress(JSON.parse(original) as unknown, course), await store.read(course));
		});

		it('rejects oversized/unbounded input and disk files without touching existing progress', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			assert.throws(() => parseProgress({ ...payload(course), extra: 'x'.repeat(2 * 1024 * 1024) }, course), /bounded/);
			const circular = payload(course);
			Object.assign(circular, { cycle: circular });
			await assert.rejects(store.import(course, circular), /bounded/);
			for (const format of ['portable', 'legacy']) {
				const input = format === 'portable' ? portablePayload(course) : legacyPayload();
				const parseInput = (value: unknown) => format === 'portable' ? parsePortableProgress(course, value) : parseLegacyProgress(value, course);
				const importInput = (value: unknown) => format === 'portable' ? store.import(course, value) : store.importLegacy(course, value);
				const oversized = { ...input, output: 'x'.repeat(2 * 1024 * 1024) };
				assert.throws(() => parseInput(oversized), /bounded/);
				await assert.rejects(importInput(oversized), /bounded/);
				const excessive = { ...input, completions: Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`key-${i}`, {}])) };
				assert.throws(() => parseInput(excessive), /completion records/);
				await assert.rejects(importInput(excessive), /completion records/);
				let called = false;
				Object.defineProperty(input, 'position', { enumerable: true, get() { called = true; throw new Error('accessor must not run'); } });
				assert.throws(() => parseInput(input), /bounded/);
				await assert.rejects(importInput(input), /bounded/);
				assert.equal(called, false);
				await assert.rejects(lstat(stateDirectory), /ENOENT/);
			}
			await mkdir(stateDirectory, { recursive: true });
			const file = progressFile(stateDirectory, course);
			const oversized = ' '.repeat(2 * 1024 * 1024 + 1);
			await writeFile(file, oversized);
			await assert.rejects(store.reset(course), /Refusing to overwrite/);
			assert.equal(await readFile(file, 'utf8'), oversized);
		});

		it('forbids mutations of store-owned metadata and asynchronous mutations', async () => {
			const { course } = await fixture();
			const store = new ProgressStore(stateDirectory);
			for (const change of [{ revision: 1 }, { schemaVersion: 2 }, { courseId: 'other' }, { contentVersion: 'other' }]) {
				await assert.rejects(store.update(course, p => { Object.assign(p, change); }), /cannot be changed/);
			}
			await assert.rejects(store.update(course, async p => {
				await Promise.resolve();
				p.completions[FIRST] = { completedAt: WHEN };
			}), /must be synchronous/);
			assert.equal((await store.read(course)).revision, 0);
		});
	});
});