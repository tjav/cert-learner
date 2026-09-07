import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Course } from '../core/course';

suite('Certification Learning host integration', () => {
	let api: { addCourse(file: string): Promise<Course>; getCourses(): Course[]; refresh(): Promise<void>; getState(): Promise<unknown> };
	let root: string;
	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension('tjav.cert-learner');
		assert.ok(extension, 'Extension is installed in the test host');
		root = extension.extensionPath;
		api = await extension.activate();
	});

	test('registers native learning commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['add', 'resume', 'open', 'getState', 'export', 'import', 'reset']) {
			assert.ok(commands.includes(`certLearner.${command}`), command);
		}
	});
	test('loads two independent course packs and opens a lesson without running a check', async () => {
		const first = await api.addCourse(path.join(root, 'examples/foundations/course.json'));
		const second = await api.addCourse(path.join(root, 'examples/second-course/course.json'));
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
});
