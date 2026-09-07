import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type { Context } from 'mocha';
import { loadCourse, validateManifest } from '../core/course';
import type { Course, CourseManifest } from '../core/course';
import { getCoursePages } from '../core/pages';
import type { CoursePageSelection } from '../core/pages';

function manifest(): CourseManifest {
	return {
		format: 'cert-learner', schemaVersion: 1, contentVersion: '1.0', courseId: 'pages', title: 'Course title',
		units: [{
			unitId: 'unit', displayNumber: '1', title: 'Unit one', resources: { lesson: 'lesson.md' },
			activities: [{ activityId: 'read', title: 'Read the lesson', objectives: [] }]
		}]
	};
}

function course(input = manifest()): Course {
	// Deliberately not a filesystem path: the page projection must never access it.
	return { id: 'course-root-identity', root: 'not-an-existing-course-root', manifest: input };
}

async function linkOrSkip(context: Context, target: string, link: string, directory = false): Promise<void> {
	try { await symlink(target, link, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); } catch (error) {
		if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(String(error.code))) {
			context.skip();
		}
		throw error;
	}
}

describe('core: pure course pages (no VS Code runtime)', () => {
	it('keeps legacy courses without an overview or resources page-free', () => {
		const input = course();
		assert.deepEqual(getCoursePages(input), []);
		assert.equal(input.overview, undefined);
		assert.equal(input.manifest.overview, undefined);
	});

	it('uses the loaded overview first and root resources in declared order with verbatim titles', () => {
		const input = course();
		input.overview = 'README.md';
		input.manifest.overview = 'old-overview.md';
		input.manifest.resources = [
			{ title: '  Summary & <details>  ', path: 'reference/summary.md' },
			{ title: 'Cheatsheet', path: 'reference/cheatsheet.md' },
			{ title: 'Teardown', path: 'maintenance/teardown.md' }
		];
		const pages = getCoursePages(input);
		assert.deepEqual(pages.map(({ title, path, kind }) => ({ title, path, kind })), [
			{ title: 'Course overview', path: 'README.md', kind: 'overview' },
			{ title: '  Summary & <details>  ', path: 'reference/summary.md', kind: 'reference' },
			{ title: 'Cheatsheet', path: 'reference/cheatsheet.md', kind: 'reference' },
			{ title: 'Teardown', path: 'maintenance/teardown.md', kind: 'reference' }
		]);
		const selection: CoursePageSelection = { course: input, page: pages[0] };
		assert.equal(selection.page.path, 'README.md');
	});

	it('uses manifest overview for callers that construct courses without loading them', () => {
		const input = course({ ...manifest(), overview: 'welcome/intro.MD' });
		assert.deepEqual(getCoursePages(input), [{
			id: JSON.stringify(['overview', 'welcome/intro.MD']), title: 'Course overview', path: 'welcome/intro.MD', kind: 'overview'
		}]);
	});

	it('deduplicates overview and resource paths, preserving the first reference title', () => {
		const input = course({ ...manifest(), overview: 'README.md', resources: [
			{ title: 'Duplicate README', path: 'README.md' },
			{ title: 'First summary', path: 'summary.md' },
			{ title: 'Repeated summary', path: 'summary.md' },
			{ title: 'Another README', path: 'README.md' }
		] });
		const pages = getCoursePages(input);
		assert.deepEqual(pages.map(page => page.path), ['README.md', 'summary.md']);
		assert.deepEqual(pages.map(page => page.title), ['Course overview', 'First summary']);
	});

	it('does not guess overview, summary, cheatsheet, teardown, or unit resource pages', () => {
		const input = course();
		input.manifest.references = [{ title: 'Remote guide', url: 'https://example.com' }];
		input.manifest.units[0].resources = { lesson: 'README.md', lab: 'lab.ipynb', quiz: 'quiz.md' };
		assert.deepEqual(getCoursePages(input), []);
		input.manifest.resources = [{ title: 'Declared README', path: 'README.md' }];
		assert.equal(getCoursePages(input)[0].kind, 'reference');
		assert.equal(getCoursePages(input)[0].title, 'Declared README');
	});

	it('has stable collision-free kind/path IDs independent of title, order, or root', () => {
		const input = course({ ...manifest(), resources: [
			{ title: 'Same title', path: 'a/b.md' },
			{ title: 'Same title', path: 'a__b.md' },
			{ title: 'Same title', path: 'a,b.md' },
			{ title: 'Same title', path: 'overview.md' }
		] });
		const original = getCoursePages(input);
		assert.equal(new Set(original.map(page => page.id)).size, original.length);
		for (const page of original) { assert.deepEqual(JSON.parse(page.id), [page.kind, page.path]); }
		input.id = 'another-course-root';
		input.manifest.resources!.reverse();
		input.manifest.resources![0].title = 'Renamed';
		for (const page of getCoursePages(input)) {
			assert.equal(page.id, original.find(candidate => candidate.path === page.path)!.id);
		}
		input.overview = 'overview.md';
		assert.notEqual(getCoursePages(input)[0].id, original.find(page => page.path === 'overview.md')!.id);
	});

	it('returns fresh values without mutating manifest, course, or activity structure', () => {
		const input = course({ ...manifest(), overview: 'README.md', resources: [{ title: 'Notes', path: 'notes.md' }] });
		const before = structuredClone(input);
		const pages = getCoursePages(input);
		pages[0].path = 'changed.md';
		pages[1].title = 'Changed';
		pages.pop();
		assert.deepEqual(input, before);
		assert.deepEqual(getCoursePages(input).map(page => page.path), ['README.md', 'notes.md']);
	});
});

describe('core: safe course overview loading (no VS Code runtime)', function () {
	this.timeout(15_000);
	let temporary: string;
	let root: string;
	let file: string;

	beforeEach(async () => {
		temporary = await mkdtemp(path.join(tmpdir(), 'cert-learner-pages-'));
		root = path.join(temporary, 'course');
		await mkdir(root);
		file = path.join(root, 'course.json');
		await writeFile(path.join(root, 'lesson.md'), '# Lesson');
		await writeManifest(manifest());
	});

	afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

	async function writeManifest(input: CourseManifest): Promise<void> {
		await writeFile(file, JSON.stringify(input));
	}

	it('preserves the legacy Course object shape when the root README is absent', async () => {
		const loaded = await loadCourse(file);
		assert.deepEqual(Object.keys(loaded).sort(), ['id', 'manifest', 'root']);
		assert.equal(loaded.overview, undefined);
		assert.deepEqual(loaded.manifest, validateManifest(manifest()));
		assert.deepEqual(getCoursePages(loaded), []);
	});

	it('discovers only root README.md without changing the manifest or course identity', async () => {
		const before = await loadCourse(file);
		await writeFile(path.join(root, 'README.md'), '# Course introduction');
		const loaded = await loadCourse(file);
		assert.equal(loaded.overview, 'README.md');
		assert.equal(loaded.manifest.overview, undefined);
		assert.equal(loaded.id, before.id);
		assert.deepEqual(loaded.manifest, before.manifest);
		assert.equal(getCoursePages(loaded)[0].title, 'Course overview');
	});

	it('does not discover nested README or conventional reference folders', async () => {
		await mkdir(path.join(root, 'summary'));
		await writeFile(path.join(root, 'summary', 'README.md'), '# Not an implicit overview');
		await writeFile(path.join(root, 'summary.md'), '# Undeclared summary');
		const loaded = await loadCourse(file);
		assert.equal(loaded.overview, undefined);
		assert.deepEqual(getCoursePages(loaded), []);
	});

	it('uses an explicit safe Markdown overview instead of root README', async () => {
		await mkdir(path.join(root, 'welcome'));
		await writeFile(path.join(root, 'welcome', 'intro.MD'), '# Explicit overview');
		// A directory at README.md must not be examined when overview is explicit.
		await mkdir(path.join(root, 'README.md'));
		const input = { ...manifest(), overview: 'welcome/intro.MD' };
		await writeManifest(input);
		const loaded = await loadCourse(file);
		assert.equal(loaded.overview, 'welcome/intro.MD');
		assert.equal(loaded.manifest.overview, input.overview);
		assert.deepEqual(loaded.manifest.units, validateManifest(input).units);
	});

	it('deduplicates a discovered README declared again among root references', async () => {
		await writeFile(path.join(root, 'README.md'), '# Overview');
		await writeFile(path.join(root, 'notes.md'), '# Notes');
		await writeManifest({ ...manifest(), resources: [
			{ title: 'README', path: 'README.md' },
			{ title: 'Summary', path: 'notes.md' },
			{ title: 'Same notes', path: 'notes.md' }
		] });
		const pages = getCoursePages(await loadCourse(file));
		assert.deepEqual(pages.map(page => [page.title, page.kind]), [['Course overview', 'overview'], ['Summary', 'reference']]);
	});

	it('keeps declared references usable without any overview', async () => {
		await writeFile(path.join(root, 'notes.md'), '# Notes');
		await writeManifest({ ...manifest(), resources: [{ title: 'Custom reference', path: 'notes.md' }] });
		const loaded = await loadCourse(file);
		assert.equal(loaded.overview, undefined);
		assert.deepEqual(getCoursePages(loaded).map(page => [page.title, page.path, page.kind]), [
			['Custom reference', 'notes.md', 'reference']
		]);
	});

	it('rejects a missing explicit overview instead of silently falling back', async () => {
		await writeFile(path.join(root, 'README.md'), '# Fallback must not be used');
		await writeManifest({ ...manifest(), overview: 'missing.md' });
		await assert.rejects(loadCourse(file), /ENOENT/);
	});

	it('rejects unsafe overview paths in both validation and loading', async () => {
		for (const overview of ['../outside.md', 'sub/../../outside.md', '/outside.md', 'C:/outside.md',
			'sub\\intro.md', 'sub//intro.md', '.hidden/intro.md', 'secrets.md', 'NUL.md', 'notes.md:stream.md']) {
			const input = { ...manifest(), overview };
			assert.throws(() => validateManifest(input), /Unsafe resource path/, overview);
			await writeManifest(input);
			await assert.rejects(loadCourse(file), /Unsafe resource path/, overview);
		}
	});

	it('rejects notebooks, non-Markdown paths and invalid overview types', async () => {
		for (const overview of ['lab.ipynb', 'intro.html', 'intro.js', 'README.md ', '']) {
			const input = { ...manifest(), overview };
			assert.throws(() => validateManifest(input), /Invalid course manifest/, overview);
			await writeManifest(input);
			await assert.rejects(loadCourse(file), /Invalid course manifest/, overview);
		}
		for (const overview of [null, 42, {}, []]) {
			assert.throws(() => validateManifest({ ...manifest(), overview }), /Invalid course manifest/);
		}
	});

	it('rejects a directory masquerading as fallback or explicit overview', async () => {
		await mkdir(path.join(root, 'README.md'));
		await assert.rejects(loadCourse(file), /regular file/);
		await writeManifest({ ...manifest(), overview: 'README.md' });
		await assert.rejects(loadCourse(file), /regular file/);
	});

	it('rejects an escaping fallback README symlink instead of suppressing it', async function () {
		const outside = path.join(temporary, 'outside.md');
		await writeFile(outside, '# Outside root');
		await linkOrSkip(this, outside, path.join(root, 'README.md'));
		await assert.rejects(loadCourse(file), /escapes/);
	});

	it('rejects a dangling fallback README symlink instead of treating it as absent', async function () {
		await linkOrSkip(this, path.join(temporary, 'absent.md'), path.join(root, 'README.md'));
		await assert.rejects(loadCourse(file), /ENOENT/);
	});

	it('rejects overview directory symlinks or junctions that leave the root', async function () {
		const outside = path.join(temporary, 'outside');
		await mkdir(outside);
		await writeFile(path.join(outside, 'intro.md'), '# Outside root');
		await linkOrSkip(this, outside, path.join(root, 'linked'), true);
		await writeManifest({ ...manifest(), overview: 'linked/intro.md' });
		await assert.rejects(loadCourse(file), /escapes/);
	});

	it('accepts internal Markdown aliases with a root-relative overview path', async function () {
		await linkOrSkip(this, path.join(root, 'lesson.md'), path.join(root, 'README.md'));
		assert.equal((await loadCourse(file)).overview, 'README.md');
		await writeManifest({ ...manifest(), overview: 'README.md' });
		assert.equal((await loadCourse(file)).overview, 'README.md');
	});

	it('rejects a fallback or explicit .md alias whose real target is a notebook', async function () {
		await writeFile(path.join(root, 'lab.ipynb'), '{"cells":[]}');
		await linkOrSkip(this, path.join(root, 'lab.ipynb'), path.join(root, 'README.md'));
		await assert.rejects(loadCourse(file), /Resolved course content must be a .md file/);
		await writeManifest({ ...manifest(), overview: 'README.md' });
		await assert.rejects(loadCourse(file), /Resolved course content must be a .md file/);
	});

	it('rejects a fallback alias to hidden credential content', async function () {
		await writeFile(path.join(root, '.env'), 'TEST_ONLY=not-a-real-secret');
		await linkOrSkip(this, path.join(root, '.env'), path.join(root, 'README.md'));
		await assert.rejects(loadCourse(file), /hidden|credential/);
	});
});