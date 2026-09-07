import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Course } from '../core/course';
import { getCoursePages } from '../core/pages';
import type { CertLearnerApi } from '../extension';
import { CourseTree } from '../ui/tree';

function assertPageTree(course: Course): void {
	let progressReads = 0;
	const tree = new CourseTree(() => { progressReads++; return undefined; });
	try {
		tree.setCourses([course]);
		const [root] = tree.getChildren();
		const pages = getCoursePages(course);
		const children = tree.getChildren(root);
		assert.deepEqual(children, [
			...pages.filter(page => page.kind === 'overview').map(page => ({ course, page })),
			...course.manifest.units.map(unit => ({ course, unit })),
			...pages.filter(page => page.kind === 'reference').map(page => ({ course, page }))
		]);
		for (const entry of children.filter(child => 'page' in child)) {
			const page = entry.page!;
			const item = tree.getTreeItem(entry);
			assert.deepEqual(tree.getChildren(entry), [], 'Pages are leaves, never activities');
			assert.deepEqual(tree.getParent(entry), root);
			assert.equal(item.label, page.title, 'Use the provided reference title verbatim');
			assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
			assert.equal(item.contextValue, 'certLearner.page');
			assert.equal(item.description, 'Reference · Not tracked');
			assert.match(String(item.tooltip), /Not tracked/u);
			assert.equal(item.command?.command, 'certLearner.openPage');
			assert.deepEqual(item.command.arguments, [{ courseId: course.id, pageId: page.id }]);
		}
		assert.equal(progressReads, 0, 'Page items do not even consult activity progress');
		const total = course.manifest.units.reduce((count, unit) => count + unit.activities.length, 0);
		assert.equal(tree.getTreeItem(root).description, `0/${total} completed`, 'Pages do not count as activities');
		for (const entry of children.filter(child => 'unit' in child)) {
			assert.equal(tree.getTreeItem(entry).description, `0/${entry.unit!.activities.length} completed`);
		}
	} finally { tree.dispose(); }
}

suite('Certification Learning host integration', () => {
	let api: CertLearnerApi;
	let first: Course;
	let second: Course;
	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension('tjav.cert-learner');
		assert.ok(extension, 'Extension is installed in the test host');
		api = await extension.activate();
		first = await api.addCourse(path.join(extension.extensionPath, 'examples/foundations/course.json'));
		second = await api.addCourse(path.join(extension.extensionPath, 'examples/second-course/course.json'));
	});

	test('registers native learning commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['add', 'resume', 'open', 'openPage', 'portalWalkthrough', 'revertUnit', 'getState', 'export', 'import', 'reset']) {
			assert.ok(commands.includes(`certLearner.${command}`), command);
		}
	});
	test('opens every registered page before selecting an activity without changing state or starting tasks', async () => {
		assert.deepEqual(getCoursePages(first).map(page => [page.kind, page.path, page.title]), [
			['overview', 'lesson.md', 'Course overview'], ['reference', 'quiz.md', 'Local reasoning quiz']
		]);
		assert.equal(getCoursePages(second).length, 1, 'The second sample also has a registered reference');
		const before = await api.getState();
		assert.equal(before.current, undefined, 'No activity has been opened in this extension session');
		const state = JSON.stringify(before);
		const taskCount = vscode.tasks.taskExecutions.length;
		for (const course of api.getCourses()) {
			for (const page of getCoursePages(course)) {
				await api.openPage({ courseId: course.id, pageId: page.id });
				assert.equal(JSON.stringify(await api.getState()), state, page.title);
				assert.equal(vscode.tasks.taskExecutions.length, taskCount, page.title);
			}
		}
	});
	test('renders overview first, units next and reference leaves last with activity-only counts', () => {
		assertPageTree(first);
		assertPageTree(second);
	});
	test('keeps overview, summary, cheatsheet and teardown untracked without registering a third course', () => {
		const clone = structuredClone(first);
		clone.root = 'tree-only-no-filesystem-access';
		clone.overview = 'overview.md';
		clone.manifest.resources = [
			{ title: '  Summary & details  ', path: 'summary.md' },
			{ title: 'Custom cheatsheet', path: 'cheatsheet.md' },
			{ title: 'Teardown — review before cleanup', path: 'teardown.md' }
		];
		assert.equal(getCoursePages(clone).length, 4);
		assertPageTree(clone);
		assert.equal(api.getCourses().length, 2);
	});
	test('rejects forged page IDs and never reads caller-supplied page paths', async () => {
		const state = JSON.stringify(await api.getState());
		const taskCount = vscode.tasks.taskExecutions.length;
		await assert.rejects(api.openPage({
			courseId: first.id, pageId: JSON.stringify(['reference', '.env'])
		}), /not declared/u);
		const suppliedPath = { courseId: first.id, pageId: 'forged', path: 'lesson.md' };
		await assert.rejects(api.openPage(suppliedPath), /not declared/u);
		await assert.rejects(api.openPage({ courseId: 'unregistered', pageId: getCoursePages(first)[0].id }), /no longer registered/u);
		const validIdsOnly = {
			courseId: first.id, pageId: getCoursePages(first)[0].id,
			get path(): never { throw new Error('Caller-supplied paths must not be read'); },
			get page(): never { throw new Error('Caller-supplied page metadata must not be read'); }
		};
		await api.openPage(validIdsOnly);
		assert.equal(JSON.stringify(await api.getState()), state);
		assert.equal(vscode.tasks.taskExecutions.length, taskCount);
	});
	test('loads two independent course packs and opens a lesson without running a check', async () => {
		assert.notEqual(first.id, second.id);
		assert.equal(api.getCourses().length, 2);
		const unit = first.manifest.units[0];
		await vscode.commands.executeCommand('certLearner.open', { course: first, unit, activity: unit.activities[0] });
		const state = JSON.stringify(await vscode.commands.executeCommand('certLearner.getState'));
		assert.ok(state.includes(first.manifest.courseId));
		assert.equal(state.includes(first.root), false, 'Public state excludes local course paths');
		assert.equal(vscode.tasks.taskExecutions.length, 0, 'Opening never runs course code');
		await api.refresh();
		assert.equal(api.getCourses().length, 2);
	});
	test('opening pages also preserves an existing activity selection and resume position', async () => {
		const before = await api.getState();
		assert.equal(before.current?.activityId, first.manifest.units[0].activities[0].activityId);
		const state = JSON.stringify(before);
		const taskCount = vscode.tasks.taskExecutions.length;
		for (const course of api.getCourses()) {
			for (const page of getCoursePages(course)) {
				await api.openPage({ courseId: course.id, pageId: page.id });
				assert.equal(JSON.stringify(await api.getState()), state, page.title);
				assert.equal(vscode.tasks.taskExecutions.length, taskCount);
			}
		}
	});
});
