import { open } from 'node:fs/promises';

/** Copy only bounded JSON data; never evaluate accessors or retain caller-owned objects. */
export function jsonSnapshot(input: unknown, maxBytes: number, label: string): unknown {
	let bytes = 0;
	let nodes = 0;
	const ancestors = new Set<object>();
	const fail = (): never => { throw new Error(`${label} must be bounded, plain JSON data.`); };
	const charge = (text: string): void => {
		bytes += Buffer.byteLength(text, 'utf8');
		if (bytes > maxBytes) { fail(); }
	};
	const visit = (value: unknown, depth: number): unknown => {
		if (++nodes > 100_000 || depth > 32) { return fail(); }
		if (value === null || typeof value === 'boolean') {
			charge(JSON.stringify(value));
			return value;
		}
		if (typeof value === 'string') {
			if (value.length > maxBytes) { return fail(); }
			charge(JSON.stringify(value));
			return value;
		}
		if (typeof value === 'number' && Number.isFinite(value)) {
			charge(JSON.stringify(value));
			return value;
		}
		if (typeof value !== 'object' || value === null || ancestors.has(value)) { return fail(); }
		const array = Array.isArray(value);
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) { return fail(); }
		const keys = Reflect.ownKeys(value);
		if (keys.length > 20_001 || keys.some(key => typeof key !== 'string')) { return fail(); }
		ancestors.add(value);
		charge(array ? '[]' : '{}');
		let result: unknown;
		if (array) {
			if (value.length > 20_000 || keys.length !== value.length + 1) { return fail(); }
			const copy: unknown[] = [];
			for (let i = 0; i < value.length; i++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
				if (!descriptor || !('value' in descriptor)) { return fail(); }
				charge(',');
				copy.push(visit(descriptor.value, depth + 1));
			}
			result = copy;
		} else {
			const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
			for (const key of keys as string[]) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) { return fail(); }
				charge(`${JSON.stringify(key)}:,`);
				copy[key] = visit(descriptor.value, depth + 1);
			}
			result = copy;
		}
		ancestors.delete(value);
		return result;
	};
	return visit(input, 0);
}

/** Read at most limit + 1 bytes, even if a file grows after stat(). */
export async function readJsonFile(file: string, limit: number, label: string): Promise<unknown> {
	const handle = await open(file, 'r');
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > limit) {
			throw new Error(`${label} must be a regular file no larger than ${limit} bytes.`);
		}
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, null);
			if (read.bytesRead === 0) { break; }
			size += read.bytesRead;
		}
		if (size > limit) { throw new Error(`${label} exceeds the ${limit}-byte limit.`); }
		try {
			// Reject invalid UTF-8 instead of silently replacing bytes.
			const text = buffer.subarray(0, size).toString('utf8');
			if (!Buffer.from(text, 'utf8').equals(buffer.subarray(0, size))) { throw new Error(); }
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error(`${label} is not valid UTF-8 JSON.`);
		}
	} finally {
		await handle.close();
	}
}

export function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

export function record(input: unknown, label: string): Record<string, unknown> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new Error(`${label} must be an object.`);
	}
	return input as Record<string, unknown>;
}

export function onlyKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	if (Object.keys(input).some(key => !allowed.includes(key))) {
		throw new Error(`${label} contains unsupported fields; remove them before importing or saving.`);
	}
}

export function identifier(input: unknown, label: string): string {
	if (typeof input !== 'string' || input.length === 0 || input.length > 128 ||
		input.trim() !== input || /[\u0000-\u001f\u007f]/u.test(input)) {
		throw new Error(`${label} must be a nonempty identifier of at most 128 characters without surrounding whitespace or controls.`);
	}
	return input;
}