import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import Ajv from 'ajv';
import courseSchema from '../../schemas/course.schema.json';
import { identifier, jsonSnapshot, readJsonFile } from './validation';

export interface Check {
	runtime: 'node' | 'python' | 'pwsh';
	file: string;
	cwd?: string;
	timeoutSeconds?: number;
}

export interface Activity {
	activityId: string;
	title: string;
	objectives: string[];
	completion?: 'manual' | 'check';
	check?: Check;
}

export interface Unit {
	unitId: string;
	displayNumber: string;
	title: string;
	domain?: string | null;
	resources: { lesson: string; lab?: string; quiz?: string };
	activities: Activity[];
}

export interface CourseManifest {
	format: 'cert-learner';
	schemaVersion: 1;
	contentVersion: string;
	courseId: string;
	title: string;
	units: Unit[];
	overview?: string;
	studyGuideUrl?: string;
	studyGuideVersion?: string;
	language?: string;
	references?: { title: string; url: string }[];
	resources?: { title: string; path: string }[];
}

export interface Course {
	id: string;
	root: string;
	/** Exact registered manifest when not the conventional root course.json. */
	manifestPath?: string;
	manifest: CourseManifest;
	/** Validated root-relative overview path, including an automatically discovered README.md. */
	overview?: string;
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ajv = new Ajv({ allErrors: true, useDefaults: true, strictRequired: false });
const checkSchema = ajv.compile<CourseManifest>(courseSchema);

/** HTTPS URLs only, without URL-parser whitespace/backslash repairs or userinfo. */
export function safeHttps(input: string): boolean {
	if (typeof input !== 'string' || input.length > 4096 ||
		!/^https:\/\//iu.test(input) || /[\s\u0000-\u001f\u007f\\]/u.test(input)) { return false; }
	const authority = input.slice('https://'.length).split(/[/?#]/u)[0];
	if (!authority || authority.includes('@')) { return false; }
	try {
		const url = new URL(input);
		return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** Resource paths use portable forward slashes and cannot name credential material. */
function validateRelative(relative: string): void {
	if (typeof relative !== 'string' || relative.length === 0 || relative.length > 1024 ||
		path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
		/[\u0000-\u001f\u007f\\:<>"|?*]/u.test(relative)) {
		throw new Error('Unsafe resource path: use a relative, forward-slash path inside the course.');
	}
	for (const segment of relative.split('/')) {
		if (!segment || segment.startsWith('.') || segment.trim() !== segment || segment.endsWith('.') ||
			/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment) ||
			/^(?:credentials?|secrets?|tokens?|passwords?|kubeconfig|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:[._-]|$)/iu.test(segment) ||
			/^(?:service[._-]?account|private[._-]?key)(?:[._-]|$)/iu.test(segment) ||
			/\.(?:pem|key|pfx|p12|keystore)$/iu.test(segment)) {
			throw new Error('Unsafe resource path: traversal, hidden paths, reserved names, and credential filenames are forbidden.');
		}
	}
}

function assertContained(root: string, candidate: string): void {
	const relative = path.relative(root, candidate);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error('Resource escapes the course root (including a possible symlink escape).');
	}
	if (relative) { validateRelative(relative.split(path.sep).join('/')); }
}

async function resolveContained(root: string, relative: string, directory: boolean): Promise<string> {
	validateRelative(relative);
	const canonicalRoot = await realpath(path.resolve(root));
	const candidate = path.resolve(canonicalRoot, relative);
	assertContained(canonicalRoot, candidate);
	// Check each prefix too: an intermediate link must not leave the root and re-enter it.
	let prefix = canonicalRoot;
	let resolved = canonicalRoot;
	for (const segment of relative.split('/')) {
		prefix = path.join(prefix, segment);
		resolved = await realpath(prefix);
		assertContained(canonicalRoot, resolved);
	}
	const info = await stat(resolved);
	if (directory ? !info.isDirectory() : !info.isFile()) {
		throw new Error(`Course resource must be a regular ${directory ? 'directory' : 'file'}.`);
	}
	return resolved;
}

/** Resolve an existing regular file, checking lexical paths and every realpath prefix. */
export async function resolveResource(root: string, relative: string): Promise<string> {
	return resolveContained(root, relative, false);
}

/** Validate and clone; optional completion is normalized to manual without mutating input. */
export function validateManifest(input: unknown): CourseManifest {
	const manifest = jsonSnapshot(input, MAX_MANIFEST_BYTES, 'Course manifest');
	if (!checkSchema(manifest)) {
		const errors = (checkSchema.errors ?? []).slice(0, 8)
			.map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
		throw new Error(`Invalid course manifest: ${errors}`);
	}
	identifier(manifest.courseId, 'courseId');
	identifier(manifest.contentVersion, 'contentVersion');
	const units = new Set<string>();
	let count = 0;
	for (const unit of manifest.units) {
		identifier(unit.unitId, 'unitId');
		if (units.has(unit.unitId)) { throw new Error(`Duplicate unitId: ${unit.unitId}`); }
		units.add(unit.unitId);
		for (const resource of [unit.resources.lesson, unit.resources.lab, unit.resources.quiz]) {
			if (resource !== undefined) { validateRelative(resource); }
		}
		const activities = new Set<string>();
		for (const activity of unit.activities) {
			if (++count > 10_000) { throw new Error('Course has more than 10000 activities.'); }
			identifier(activity.activityId, 'activityId');
			if (activities.has(activity.activityId)) { throw new Error(`Duplicate activityId in unit ${unit.unitId}: ${activity.activityId}`); }
			activities.add(activity.activityId);
			if (activity.check) {
				validateRelative(activity.check.file);
				if (activity.check.cwd !== undefined && activity.check.cwd !== '.') { validateRelative(activity.check.cwd); }
			}
		}
	}
	if (manifest.overview !== undefined) { validateRelative(manifest.overview); }
	for (const resource of manifest.resources ?? []) { validateRelative(resource.path); }
	for (const url of [manifest.studyGuideUrl, ...(manifest.references ?? []).map(reference => reference.url)]) {
		if (url !== undefined && !safeHttps(url)) { throw new Error('Course links must be safe HTTPS URLs without embedded credentials.'); }
	}
	return manifest;
}

export async function loadCourse(manifestPath: string): Promise<Course> {
	const canonicalManifest = await realpath(path.resolve(manifestPath));
	const root = await realpath(path.dirname(canonicalManifest));
	const manifest = validateManifest(await readJsonFile(canonicalManifest, MAX_MANIFEST_BYTES, 'Course manifest'));
	const files = new Map<string, string | undefined>((manifest.resources ?? []).map(resource => [resource.path, '.md']));
	let overview = manifest.overview;
	if (overview === undefined) {
		// Only absence is optional. lstat notices dangling links too, so resolving an
		// unsafe or broken README below cannot be mistaken for a missing overview.
		try {
			await lstat(path.join(root, 'README.md'));
			overview = 'README.md';
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { throw error; }
		}
	}
	if (overview !== undefined) { files.set(overview, '.md'); }
	const directories = new Set<string>();
	for (const unit of manifest.units) {
		files.set(unit.resources.lesson, '.md');
		if (unit.resources.lab) { files.set(unit.resources.lab, '.ipynb'); }
		if (unit.resources.quiz) { files.set(unit.resources.quiz, '.md'); }
		for (const activity of unit.activities) {
			if (activity.check) {
				if (!files.has(activity.check.file)) { files.set(activity.check.file, undefined); }
				if (activity.check.cwd && activity.check.cwd !== '.') { directories.add(activity.check.cwd); }
			}
		}
	}
	for (const [file, extension] of files) {
		const resolved = await resolveResource(root, file);
		if (extension !== undefined && path.extname(resolved).toLowerCase() !== extension) {
			throw new Error(`Resolved course content must be a ${extension} file, including symlink targets.`);
		}
	}
	for (const directory of directories) { await resolveContained(root, directory, true); }
	const identityRoot = process.platform === 'win32' ? root.toLowerCase() : root;
	const id = createHash('sha256').update(JSON.stringify([identityRoot, manifest.courseId])).digest('hex');
	return { id, root, manifest, ...(overview === undefined ? {} : { overview }),
		...(path.basename(canonicalManifest) === 'course.json' ? {} : { manifestPath: canonicalManifest }) };
}