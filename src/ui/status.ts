import type { Activity, Course, Unit } from '../core/course';
import { activityKey } from '../core/progress';
import type { ActivityProgress, Progress } from '../core/progress';

/** Never mix progress from another copy/root of the same portable course. */
export function boundProgress(course: Course, progress: Progress | undefined): Progress | undefined {
	return progress?.courseId === course.id ? progress : undefined;
}

export function activityStatus(record: ActivityProgress | undefined): { label: string; icon: string; tone: string } {
	if (record?.completedAt) {
		if (record.source === 'verified') { return { label: 'Completed · verified', icon: 'verified', tone: 'success' }; }
		if (record.source === 'manual') { return { label: 'Completed · manual', icon: 'check', tone: 'success' }; }
		if (record.source === 'imported') { return { label: 'Completed · imported (not locally verified)', icon: 'history', tone: 'neutral' }; }
		return { label: 'Completed · source unspecified', icon: 'check', tone: 'neutral' };
	}
	if (record?.lastResult === 'failed') { return { label: 'Not complete · last check failed', icon: 'error', tone: 'danger' }; }
	if (record?.lastResult === 'blocked') { return { label: 'Not complete · last check blocked', icon: 'shield', tone: 'warning' }; }
	return { label: 'Not complete', icon: 'circle-outline', tone: 'neutral' };
}

/** Count current manifest activities only, not removed historical IDs or exam points. */
export function completionSummary(course: Course, input: Progress | undefined, unit?: Unit): { completed: number; total: number } {
	const progress = boundProgress(course, input);
	let completed = 0;
	let total = 0;
	for (const current of unit ? [unit] : course.manifest.units) {
		for (const activity of current.activities) {
			total++;
			if (progress?.completions[activityKey(current.unitId, activity.activityId)]?.completedAt) { completed++; }
		}
	}
	return { completed, total };
}

export function unitLabel(unit: Unit): string {
	return `${unit.displayNumber} · ${unit.title}`;
}

export function activityLabel(unit: Unit, activity: Activity): string {
	const index = unit.activities.findIndex(candidate => candidate.activityId === activity.activityId);
	return `${unit.displayNumber}.${index + 1} · ${activity.title}`;
}