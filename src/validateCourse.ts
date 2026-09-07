import { loadCourse } from './core/course';

/** Headless validation uses exactly the extension's manifest/resource validation. */
async function main(): Promise<void> {
	const manifest = process.argv[2];
	if (!manifest) { throw new Error('Usage: validate-course <path-to-course.json>'); }
	const course = await loadCourse(manifest);
	const activities = course.manifest.units.flatMap(unit => unit.activities);
	console.log(JSON.stringify({
		courseId: course.manifest.courseId,
		units: course.manifest.units.length,
		activities: activities.length,
		objectives: activities.reduce((total, activity) => total + activity.objectives.length, 0)
	}, null, 2));
}

void main().catch((error: unknown) => {
	console.error(`Course validation failed: ${error instanceof Error ? error.message : 'Unknown validation error.'}`);
	process.exitCode = 1;
});