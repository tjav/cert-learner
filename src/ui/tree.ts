import * as vscode from 'vscode';
import type { Activity, Course, Unit } from '../core/course';
import { getCoursePages } from '../core/pages';
import type { CoursePage } from '../core/pages';
import { activityKey } from '../core/progress';
import type { Progress } from '../core/progress';
import { activityLabel, activityStatus, boundProgress, completionSummary, unitLabel } from './status';

export type Selection = { course: Course; unit: Unit; activity: Activity };
export type TreeEntry = { course: Course; unit?: Unit; activity?: Activity; page?: CoursePage };

export class CourseTree implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable {
	private courses: Course[] = [];
	private readonly changes = new vscode.EventEmitter<TreeEntry | undefined | null | void>();
	readonly onDidChangeTreeData = this.changes.event;

	constructor(private readonly progress: (course: Course) => Progress | undefined) {}

	setCourses(courses: Course[]): void {
		this.courses = [...courses];
		this.refresh();
	}

	refresh(): void { this.changes.fire(); }

	getChildren(entry?: TreeEntry): TreeEntry[] {
		if (!entry) { return this.courses.map(course => ({ course })); }
		if (entry.activity || entry.page) { return []; }
		if (entry.unit) {
			return entry.unit.activities.map(activity => ({ course: entry.course, unit: entry.unit, activity }));
		}
		const course = entry.course;
		const pages = getCoursePages(course);
		return [
			...pages.filter(page => page.kind === 'overview').map(page => ({ course, page })),
			...course.manifest.units.map(unit => ({ course, unit })),
			...pages.filter(page => page.kind === 'reference').map(page => ({ course, page }))
		];
	}

	getParent(entry: TreeEntry): TreeEntry | undefined {
		if (entry.page) { return { course: entry.course }; }
		if (entry.activity && entry.unit) { return { course: entry.course, unit: entry.unit }; }
		if (entry.unit) { return { course: entry.course }; }
		return undefined;
	}

	getTreeItem(entry: TreeEntry): vscode.TreeItem {
		const { course, unit, activity, page } = entry;
		if (page) {
			const item = new vscode.TreeItem(page.title, vscode.TreeItemCollapsibleState.None);
			item.id = `certLearner.page:${JSON.stringify([course.id, page.id])}`;
			item.contextValue = 'certLearner.page';
			item.iconPath = new vscode.ThemeIcon(page.kind === 'overview' ? 'home' : 'file-text');
			item.description = 'Reference · Not tracked';
			item.tooltip = `${page.title}\nReference page · Not tracked. Opening this page never runs code or performs cleanup.`;
			item.command = {
				command: 'certLearner.openPage', title: 'Open course page',
				arguments: [{ courseId: course.id, pageId: page.id }]
			};
			item.accessibilityInformation = { label: `${page.title}, ${item.description}` };
			return item;
		}
		const progress = boundProgress(course, this.progress(course));
		const stale = progress !== undefined && progress.contentVersion !== course.manifest.contentVersion;
		const versionNote = stale
			? `\nContent version changed: progress ${progress.contentVersion}; current ${course.manifest.contentVersion}. Historical completions have not been revalidated.`
			: '';
		if (unit && activity) {
			const record = progress?.completions[activityKey(unit.unitId, activity.activityId)];
			const status = activityStatus(record);
			const item = new vscode.TreeItem(activityLabel(unit, activity), vscode.TreeItemCollapsibleState.None);
			item.id = JSON.stringify([course.id, unit.unitId, activity.activityId]);
			item.contextValue = 'certLearner.activity';
			item.iconPath = new vscode.ThemeIcon(status.icon);
			const current = progress?.position?.unitId === unit.unitId && progress.position.activityId === activity.activityId;
			item.description = `${current ? 'Current · ' : ''}${status.label}`;
			item.tooltip = `${activity.title}\n${status.label}${record?.completedAt ? `\nCompleted: ${record.completedAt}` : ''}` +
				`${record?.lastResult ? `\nLast check: ${record.lastResult}` : ''}\n` +
				(activity.completion === 'check' ? 'A passing check is required; manual completion is unavailable.' : 'Manual completion is available.') +
				versionNote;
			const selection: Selection = { course, unit, activity };
			item.command = { command: 'certLearner.open', title: 'Open activity', arguments: [selection] };
			item.accessibilityInformation = { label: `${item.label}, ${item.description}` };
			return item;
		}
		const summary = completionSummary(course, progress, unit);
		const item = new vscode.TreeItem(unit ? unitLabel(unit) : course.manifest.title,
			unit ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
		item.id = JSON.stringify(unit ? [course.id, unit.unitId] : [course.id]);
		item.contextValue = unit ? 'certLearner.unit' : 'certLearner.course';
		item.description = `${summary.completed}/${summary.total} completed${stale ? ' · Content version changed' : ''}`;
		item.iconPath = new vscode.ThemeIcon(stale ? 'warning' : unit ? 'book' : 'library');
		item.tooltip = `${unit ? unitLabel(unit) : course.manifest.title}\n${summary.completed} of ${summary.total} current activities completed. Activity counts, not an exam score.${versionNote}`;
		return item;
	}

	dispose(): void {
		this.courses = [];
		this.changes.dispose();
	}
}