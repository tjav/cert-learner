import type { Course } from './course';

export interface CoursePage {
	id: string;
	title: string;
	path: string;
	kind: 'overview' | 'reference';
}

export type CoursePageSelection = { course: Course; page: CoursePage };

/** Pure projection: discovery and filesystem validation belong to loadCourse. */
export function getCoursePages(course: Course): CoursePage[] {
	const pages: CoursePage[] = [];
	const seen = new Set<string>();
	const add = (kind: CoursePage['kind'], title: string, path: string): void => {
		if (seen.has(path)) { return; }
		seen.add(path);
		// Tuple encoding is collision-free and independent of titles or list order.
		pages.push({ id: JSON.stringify([kind, path]), title, path, kind });
	};
	const overview = course.overview ?? course.manifest.overview;
	if (overview !== undefined) { add('overview', 'Course overview', overview); }
	for (const resource of course.manifest.resources ?? []) {
		add('reference', resource.title, resource.path);
	}
	return pages;
}