import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { Course } from './course';
import { identifier, isErrno, jsonSnapshot, onlyKeys, record } from './validation';

export interface ActivityProgress {
	completedAt?: string;
	source?: 'manual' | 'verified' | 'imported';
	lastResult?: 'passed' | 'failed' | 'blocked';
	attempts?: number;
}

export interface Progress {
	schemaVersion: 1;
	/** The root-bound Course.id, NOT the manifest's portable courseId. */
	courseId: string;
	contentVersion: string;
	revision: number;
	position?: { unitId: string; activityId: string };
	completions: Record<string, ActivityProgress>;
}

const MAX_PROGRESS_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETIONS = 10_000;
const queues = new Map<string, Promise<void>>();

export function activityKey(unitId: string, activityId: string): string {
	return JSON.stringify([unitId, activityId]);
}

function keyParts(key: string): [string, string] {
	let parts: unknown;
	try { parts = JSON.parse(key) as unknown; } catch { throw new Error('Invalid completion key; expected a JSON [unitId, activityId] pair.'); }
	if (!Array.isArray(parts) || parts.length !== 2) { throw new Error('Invalid completion key; expected two IDs.'); }
	const unitId = identifier(parts[0], 'Completion unitId');
	const activityId = identifier(parts[1], 'Completion activityId');
	if (activityKey(unitId, activityId) !== key) { throw new Error('Completion keys must use the canonical activityKey encoding.'); }
	return [unitId, activityId];
}

function knownKeys(course: Course): Set<string> {
	return new Set(course.manifest.units.flatMap(unit => unit.activities.map(activity => activityKey(unit.unitId, activity.activityId))));
}

function integer(input: unknown, label: string, maximum: number): number {
	if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > maximum) {
		throw new Error(`${label} must be a nonnegative safe integer no larger than ${maximum}.`);
	}
	return input;
}

/** RFC3339 timestamps (seconds required, up to millisecond precision), normalized to UTC. */
function timestamp(input: unknown, label = 'completedAt'): string {
	if (typeof input !== 'string' || input.length > 32 ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(input)) {
		throw new Error(`${label} must be a valid RFC3339 timestamp with a timezone.`);
	}
	const local = new Date(`${input.slice(0, 19)}Z`);
	const instant = new Date(input);
	if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== input.slice(0, 19) ||
		!Number.isFinite(instant.getTime()) || !/^\d{4}-/u.test(instant.toISOString())) {
		throw new Error(`${label} contains an invalid date or time.`);
	}
	return instant.toISOString();
}

function parseActivity(input: unknown): ActivityProgress {
	const data = record(input, 'Activity progress');
	onlyKeys(data, ['completedAt', 'source', 'lastResult', 'attempts'], 'Activity progress');
	const result: ActivityProgress = {};
	if ('completedAt' in data) { result.completedAt = timestamp(data.completedAt); }
	if ('source' in data) {
		if (data.source !== 'manual' && data.source !== 'verified' && data.source !== 'imported') {
			throw new Error('Unknown activity progress source.');
		}
		result.source = data.source;
	}
	if ('lastResult' in data) {
		if (data.lastResult !== 'passed' && data.lastResult !== 'failed' && data.lastResult !== 'blocked') {
			throw new Error('Unknown activity progress lastResult.');
		}
		result.lastResult = data.lastResult;
	}
	if ('attempts' in data) { result.attempts = integer(data.attempts, 'attempts', 1_000_000); }
	return result;
}

function parse(input: unknown, course: Course, historical: boolean): Progress {
	const data = record(jsonSnapshot(input, MAX_PROGRESS_BYTES, 'Progress'), 'Progress');
	onlyKeys(data, ['schemaVersion', 'courseId', 'contentVersion', 'revision', 'position', 'completions'], 'Progress');
	if (data.schemaVersion !== 1) { throw new Error('Unsupported progress schemaVersion; use a compatible version of Cert Learner.'); }
	if (data.courseId !== course.id) { throw new Error('Progress course ID does not match this course/root.'); }
	const contentVersion = identifier(data.contentVersion, 'Progress contentVersion');
	const known = knownKeys(course);
	const allowRemoved = historical && contentVersion !== course.manifest.contentVersion;
	const requireKnown = (key: string): void => {
		if (!known.has(key) && !allowRemoved) { throw new Error('Unknown unit/activity ID in progress; no data was saved.'); }
	};
	const progress: Progress = {
		schemaVersion: 1,
		courseId: course.id,
		contentVersion,
		revision: integer(data.revision, 'revision', Number.MAX_SAFE_INTEGER),
		completions: {}
	};
	if ('position' in data) {
		const position = record(data.position, 'Progress position');
		onlyKeys(position, ['unitId', 'activityId'], 'Progress position');
		const unitId = identifier(position.unitId, 'Position unitId');
		const activityId = identifier(position.activityId, 'Position activityId');
		requireKnown(activityKey(unitId, activityId));
		progress.position = { unitId, activityId };
	}
	const completions = record(data.completions, 'Progress completions');
	const keys = Object.keys(completions).sort();
	if (keys.length > MAX_COMPLETIONS) { throw new Error(`Progress exceeds ${MAX_COMPLETIONS} completion records.`); }
	for (const key of keys) {
		keyParts(key);
		requireKnown(key);
		progress.completions[key] = parseActivity(completions[key]);
	}
	return progress;
}

/** Validate an import/export payload without filesystem access; IDs must be currently known. */
export function parseProgress(input: unknown, course: Course): Progress {
	return parse(input, course, false);
}

/** Detached portable envelope; preserve the stored version, including historical progress. */
export function exportProgress(course: Course, p: Progress): object {
	const progress = parse(p, course, true);
	return {
		format: 'cert-learner-progress', schemaVersion: 1, courseId: course.manifest.courseId,
		contentVersion: progress.contentVersion,
		...(progress.position ? { position: progress.position } : {}),
		completions: progress.completions
	};
}

/** Portable imports require the selected manifest's version and currently known IDs. */
export function parsePortableProgress(course: Course, input: unknown): Progress {
	const data = record(jsonSnapshot(input, MAX_PROGRESS_BYTES, 'Portable progress'), 'Portable progress');
	onlyKeys(data, ['format', 'schemaVersion', 'courseId', 'contentVersion', 'position', 'completions'], 'Portable progress');
	if (data.format !== 'cert-learner-progress') { throw new Error('Unsupported portable progress format.'); }
	if (data.schemaVersion !== 1) { throw new Error('Unsupported portable progress schemaVersion.'); }
	if (data.courseId !== course.manifest.courseId) { throw new Error('Portable progress logical course ID does not match the selected course.'); }
	const contentVersion = identifier(data.contentVersion, 'Portable progress contentVersion');
	if (contentVersion !== course.manifest.contentVersion) {
		throw new Error('Portable progress contentVersion does not match the selected course. Load matching content or migrate explicitly before importing.');
	}
	return parseProgress({
		schemaVersion: 1, courseId: course.id, contentVersion, revision: 0,
		...('position' in data ? { position: data.position } : {}), completions: data.completions
	}, course);
}

function firstPosition(course: Course, unitId?: string): Progress['position'] {
	for (const unit of course.manifest.units) {
		if (unitId !== undefined && unit.unitId !== unitId) { continue; }
		const activity = unit.activities[0];
		if (activity) { return { unitId: unit.unitId, activityId: activity.activityId }; }
	}
	return undefined;
}

function emptyProgress(course: Course): Progress {
	const result: Progress = {
		schemaVersion: 1, courseId: course.id, contentVersion: course.manifest.contentVersion,
		revision: 0, completions: {}
	};
	const position = firstPosition(course);
	if (position) { result.position = position; }
	return result;
}

function encode(progress: Progress): string {
	const text = `${JSON.stringify(progress)}\n`;
	if (Buffer.byteLength(text, 'utf8') > MAX_PROGRESS_BYTES) { throw new Error('Serialized progress exceeds the size limit.'); }
	return text;
}

/** Merge explicit records only; imported claims never acquire a locally verified source. */
function merge(progress: Progress, incoming: Record<string, ActivityProgress>): void {
	for (const [key, item] of Object.entries(incoming)) {
		if (Object.keys(item).length === 0) { continue; }
		const existing = progress.completions[key] ?? {};
		const merged: ActivityProgress = { ...item, ...existing };
		if (item.attempts !== undefined || existing.attempts !== undefined) {
			merged.attempts = Math.max(item.attempts ?? 0, existing.attempts ?? 0);
		}
		if (!existing.completedAt && item.completedAt) {
			merged.completedAt = item.completedAt;
			merged.source = 'imported';
		} else if (!existing.source && item.source) {
			merged.source = 'imported';
		}
		progress.completions[key] = merged;
	}
}

function importPosition(progress: Progress, incoming: Pick<Progress, 'position'>): void {
	// Even a navigation-only save (revision > 0) is existing local progress.
	if (progress.revision === 0 && Object.keys(progress.completions).length === 0 && incoming.position) {
		progress.position = { ...incoming.position };
	}
}

/**
 * Accept the full AI103 v1 envelope (position, completions, startedAt), as well as
 * older completion-only envelopes. startedAt is validated, but is not persisted.
 * Generate exact doubled-unit keys and single-unit aliases; never split IDs.
 */
function parseLegacyEnvelope(input: unknown, course: Course): Pick<Progress, 'position' | 'completions'> {
	const data = record(jsonSnapshot(input, MAX_PROGRESS_BYTES, 'Legacy progress'), 'Legacy progress');
	onlyKeys(data, ['version', 'position', 'completions', 'startedAt'], 'Legacy progress');
	if (data.version !== 1) { throw new Error('Legacy progress requires version: 1.'); }
	if (course.manifest.courseId !== 'ai103') { throw new Error('Legacy AI103 progress can only be imported into the ai103 course.'); }
	if ('startedAt' in data) { timestamp(data.startedAt, 'Legacy startedAt'); }
	const result: Pick<Progress, 'position' | 'completions'> = { completions: {} };
	if ('position' in data) {
		const position = record(data.position, 'Legacy position');
		onlyKeys(position, ['courseId', 'unitId', 'activityId'], 'Legacy position');
		if (position.courseId !== 'ai103') { throw new Error('Legacy position course ID must be ai103.'); }
		const unitId = identifier(position.unitId, 'Legacy position unitId');
		const activityId = identifier(position.activityId, 'Legacy position activityId');
		if (!knownKeys(course).has(activityKey(unitId, activityId))) { throw new Error('Unknown legacy position unit/activity ID.'); }
		result.position = { unitId, activityId };
	}
	const map = new Map<string, string>();
	for (const unit of course.manifest.units) {
		for (const activity of unit.activities) {
			const target = activityKey(unit.unitId, activity.activityId);
			for (const legacyKey of [
				`ai103__${unit.unitId}__${unit.unitId}__${activity.activityId}`,
				`ai103__${unit.unitId}__${activity.activityId}`
			]) {
				if (map.has(legacyKey) && map.get(legacyKey) !== target) {
					throw new Error('Ambiguous legacy IDs or aliases in the manifest; migration cannot be performed safely.');
				}
				map.set(legacyKey, target);
			}
		}
	}
	const completions = record(data.completions, 'Legacy completions');
	if (Object.keys(completions).length > MAX_COMPLETIONS) { throw new Error('Too many legacy completion records.'); }
	for (const [key, value] of Object.entries(completions)) {
		const target = map.get(key);
		if (target === undefined) { throw new Error('Unknown legacy completion key; check the exact course, unit, and activity IDs. Nothing was imported.'); }
		const item = parseActivity(typeof value === 'string' ? { completedAt: value } : value);
		if (item.completedAt || item.source) { item.source = 'imported'; }
		if (target in result.completions && JSON.stringify(result.completions[target]) !== JSON.stringify(item)) {
			throw new Error('Conflicting legacy aliases for the same activity; nothing was imported.');
		}
		result.completions[target] = item;
	}
	return result;
}

/** Backcompatible completion-map API; the entire envelope is still validated. */
export function parseLegacyProgress(input: unknown, course: Course): Record<string, ActivityProgress> {
	return parseLegacyEnvelope(input, course).completions;
}

async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const tail = new Promise<void>(resolve => { release = resolve; });
	queues.set(key, tail);
	await previous;
	try { return await work(); } finally {
		release();
		if (queues.get(key) === tail) { queues.delete(key); }
	}
}

/** Local-only state. Filenames hash Course.id, not titles, paths, or source content. */
export class ProgressStore {
	constructor(private readonly directory: string) {}

	private async transaction<T>(course: Course, work: (file: string) => Promise<T>): Promise<T> {
		identifier(course.id, 'Course identity');
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const directory = await realpath(path.resolve(this.directory));
		const name = createHash('sha256').update(course.id).digest('hex');
		const file = path.join(directory, `${name}.json`);
		const queueKey = process.platform === 'win32' ? file.toLowerCase() : file;
		return serialized(queueKey, async () => {
			const lockPath = `${file}.lock`;
			let lock;
			try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
				if (isErrno(error, 'EEXIST')) {
					throw new Error(`Progress is locked: ${lockPath}. Close the other writer and retry. If it crashed, verify no writer remains before manually removing this lock.`);
				}
				throw error;
			}
			try { return await work(file); } finally {
				try {
					const owned = await lock.stat();
					let current;
					try { current = await lstat(lockPath); } catch (error) {
						if (!isErrno(error, 'ENOENT')) { throw error; }
					}
					// Never delete a replaced lock (or a lock we failed to acquire).
					if (current && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
						await unlink(lockPath);
					}
				} finally { await lock.close(); }
			}
		});
	}

	private async readFile(file: string, course: Course): Promise<{ progress: Progress; hash: string } | undefined> {
		let info;
		try { info = await lstat(file); } catch (error) {
			if (isErrno(error, 'ENOENT')) { return undefined; }
			throw error;
		}
		try {
			if (info.isSymbolicLink() || !info.isFile()) { throw new Error('State files must be regular files, not symlinks.'); }
			const handle = await open(file, 'r');
			try {
				const opened = await handle.stat();
				if (!opened.isFile() || opened.size > MAX_PROGRESS_BYTES) {
					throw new Error(`Stored progress must be a regular file no larger than ${MAX_PROGRESS_BYTES} bytes.`);
				}
				// Parse and hash the SAME bounded bytes, including whitespace; never read twice for a snapshot.
				const buffer = Buffer.alloc(MAX_PROGRESS_BYTES + 1);
				let size = 0;
				while (size < buffer.length) {
					const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
					if (bytesRead === 0) { break; }
					size += bytesRead;
				}
				if (size > MAX_PROGRESS_BYTES) { throw new Error('Stored progress exceeds the size limit.'); }
				const bytes = buffer.subarray(0, size);
				const text = bytes.toString('utf8');
				if (!Buffer.from(text, 'utf8').equals(bytes)) { throw new Error('Stored progress is not valid UTF-8 JSON.'); }
				let data: unknown;
				try { data = JSON.parse(text) as unknown; } catch {
					// Native JSON errors may quote private file contents; keep the bounded reader's generic error.
					throw new Error('Stored progress is not valid UTF-8 JSON.');
				}
				return { progress: parse(data, course, true), hash: createHash('sha256').update(bytes).digest('hex') };
			} finally { await handle.close(); }
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'Invalid state';
			throw new Error(`Refusing to overwrite corrupt or unsupported progress at ${file}. ${reason} Preserve this file and inspect/restore a known-good .bak file manually, or use a compatible extension version.`);
		}
	}

	private async readState(file: string, course: Course): Promise<{ progress: Progress; persisted: boolean; hash?: string }> {
		const progress = await this.readFile(file, course);
		const backup = await this.readFile(`${file}.bak`, course);
		if (!progress && backup) {
			throw new Error(`Progress is missing but a backup exists at ${file}.bak. Restore the backup manually before continuing; it will not be silently discarded.`);
		}
		return { progress: progress?.progress ?? emptyProgress(course), persisted: progress !== undefined, hash: progress?.hash };
	}

	private async atomicWrite(file: string, text: string, beforeReplace?: () => Promise<void>, guard: () => boolean = () => true): Promise<void> {
		const temporary = `${file}.${randomUUID()}.tmp`;
		const handle = await open(temporary, 'wx', 0o600);
		let closed = false;
		try {
			await handle.writeFile(text, 'utf8');
			await handle.sync();
			await handle.close();
			closed = true;
			if (beforeReplace) { await beforeReplace(); }
			// The synchronous guard is the commit point: no await between it and rename.
			// Cancellation during/after rename cannot roll back a committed replacement.
			if (!guard()) { throw new Error('Progress update was cancelled; no progress was saved.'); }
			await rename(temporary, file);
		} finally {
			try { if (!closed) { await handle.close(); } } finally {
				try { await unlink(temporary); } catch (error) {
					if (!isErrno(error, 'ENOENT')) { throw error; }
				}
			}
		}
	}

	async read(course: Course): Promise<Progress> {
		return this.transaction(course, async file => (await this.readState(file, course)).progress);
	}

	/** Synchronous mutation/guard only. Identity, contentVersion, schemaVersion and revision are store-owned. */
	async update(course: Course, mutate: (p: Progress) => void, guard: () => boolean = () => true): Promise<Progress> {
		return this.transaction(course, async file => {
			if (!guard()) { throw new Error('Progress update was cancelled; no progress was saved.'); }
			const before = await this.readState(file, course);
			const draft = parse(before.progress, course, true);
			const returned: unknown = mutate(draft);
			if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') && 'then' in returned) {
				// Prevent an accidental async callback from becoming an unhandled rejection.
				void Promise.resolve(returned).catch(() => undefined);
				throw new Error('Progress mutations must be synchronous; perform asynchronous work before update().');
			}
			if (draft.courseId !== before.progress.courseId || draft.contentVersion !== before.progress.contentVersion ||
				draft.schemaVersion !== before.progress.schemaVersion || draft.revision !== before.progress.revision) {
				throw new Error('Progress identity, schemaVersion, contentVersion, and revision cannot be changed by a mutation.');
			}
			const next = parse(draft, course, true);
			// On stale content, preserve removed historical IDs but never introduce/modify unknown ones.
			const known = knownKeys(course);
			for (const [key, value] of Object.entries(next.completions)) {
				if (!known.has(key) && JSON.stringify(value) !== JSON.stringify(before.progress.completions[key])) {
					throw new Error('Cannot add or modify an unknown historical activity ID.');
				}
			}
			if (next.position && !known.has(activityKey(next.position.unitId, next.position.activityId)) &&
				JSON.stringify(next.position) !== JSON.stringify(before.progress.position)) {
				throw new Error('Cannot navigate to an unknown activity ID.');
			}
			const assertUnchanged = async (): Promise<void> => {
				const current = await this.readFile(file, course);
				if (current?.hash !== before.hash ||
					current?.progress.revision !== (before.persisted ? before.progress.revision : undefined)) {
					throw new Error('Progress changed outside this transaction; the external state was not replaced. Read it again before retrying.');
				}
			};
			await assertUnchanged();
			if (JSON.stringify(next) === JSON.stringify(before.progress)) { return next; }
			if (next.revision === Number.MAX_SAFE_INTEGER) { throw new Error('Progress revision is exhausted; preserve and migrate this file before saving.'); }
			next.revision++;
			const text = encode(next);
			// Optimistic checks supplement the lock, not a filesystem compare-and-swap:
			// a noncooperating writer can still race the final check-to-rename interval.
			const replacePrimary = (): Promise<void> => this.atomicWrite(file, text, assertUnchanged, guard);
			// Stage the backup first, but publish it only after the primary commits.
			// A rejected guard cleans both staged files without replacing either original.
			// Do not recheck cancellation after that commit, including while publishing the backup.
			if (before.persisted) { await this.atomicWrite(`${file}.bak`, encode(before.progress), replacePrimary); }
			else { await replacePrimary(); }
			return next;
		});
	}

	/** Portable envelopes rebind to this root; old internal payloads must already match Course.id. */
	async import(course: Course, input: unknown): Promise<Progress> {
		const data = record(jsonSnapshot(input, MAX_PROGRESS_BYTES, 'Imported progress'), 'Imported progress');
		const incoming = 'format' in data ? parsePortableProgress(course, data) : parseProgress(data, course);
		return this.update(course, progress => {
			if (incoming.contentVersion !== progress.contentVersion) {
				throw new Error('Imported contentVersion does not match stored progress (or the current course for a new store). Review/migrate versions explicitly before importing.');
			}
			importPosition(progress, incoming);
			merge(progress, incoming.completions);
		});
	}

	async importLegacy(course: Course, input: unknown): Promise<Progress> {
		const incoming = parseLegacyEnvelope(input, course);
		return this.update(course, progress => {
			importPosition(progress, incoming);
			merge(progress, incoming.completions);
		});
	}

	async reset(course: Course, unitId?: string): Promise<Progress> {
		if (unitId !== undefined && !course.manifest.units.some(unit => unit.unitId === unitId)) {
			throw new Error('Cannot reset an unknown unit ID.');
		}
		return this.update(course, progress => {
			if (unitId === undefined) { progress.completions = {}; } else {
				for (const key of Object.keys(progress.completions)) {
					if (keyParts(key)[0] === unitId) { delete progress.completions[key]; }
				}
			}
			const position = firstPosition(course, unitId);
			if (position) { progress.position = position; } else { delete progress.position; }
		});
	}
}