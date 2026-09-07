import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { MAX_CHECK_RESULT_BYTES, validateCheckResult } from '../checkResult';
import type { CheckResult, CheckStatus } from '../checkResult';

const RUN_ID = 'bc494ae2-6502-4c4b-9b32-0b14ab76e1c6';

function result(status: CheckStatus = 'passed'): CheckResult {
	return { schemaVersion: 1, runId: RUN_ID, status, checks: [{ id: 'required', status }] };
}

describe('runner: pure check-result validation (no VS Code runtime)', () => {
	it('accepts a nonempty all-passed result for this exact run', () => {
		const input = result();
		input.checks.push({ id: 'second', status: 'passed', message: 'Ready' });
		assert.equal(validateCheckResult(input, RUN_ID), true);
	});

	it('accepts valid failed and blocked schemas without treating them as passed', () => {
		for (const status of ['failed', 'blocked'] as const) {
			const input = result(status);
			input.checks.push({ id: 'ready', status: 'passed' });
			assert.equal(validateCheckResult(input, RUN_ID), true);
			assert.notEqual(input.status, 'passed');
		}
	});

	it('rejects malformed top-level data and JSON text rather than parsing/coercing it', () => {
		for (const input of [null, undefined, true, false, 1, 'passed', JSON.stringify(result()), [], {}, () => result()]) {
			assert.equal(validateCheckResult(input, RUN_ID), false);
		}
	});

	it('requires every top-level field', () => {
		for (const key of ['schemaVersion', 'runId', 'status', 'checks']) {
			const input: Record<string, unknown> = { ...result() };
			delete input[key];
			assert.equal(validateCheckResult(input, RUN_ID), false, key);
		}
	});

	it('rejects wrong/replayed run IDs, empty expected IDs and boxed string coercion', () => {
		for (const runId of ['', 'other-run', RUN_ID.toUpperCase(), null, 1, new String(RUN_ID)]) {
			assert.equal(validateCheckResult({ ...result(), runId }, RUN_ID), false);
		}
		assert.equal(validateCheckResult(result(), ''), false);
		assert.equal(validateCheckResult({ ...result(), runId: '' }, ''), false);
	});

	it('does not coerce version, status, checks, IDs or messages', () => {
		for (const schemaVersion of ['1', true, 0, 2, null, new Number(1)]) {
			assert.equal(validateCheckResult({ ...result(), schemaVersion }, RUN_ID), false);
		}
		for (const status of ['pass', 'Passed', 'PASSED', 'success', 'skipped', ' passed', '', true, 1, null]) {
			assert.equal(validateCheckResult({ ...result(), status }, RUN_ID), false);
			assert.equal(validateCheckResult({ ...result(), checks: [{ id: 'one', status }] }, RUN_ID), false);
		}
		for (const checks of [null, {}, { 0: { id: 'one', status: 'passed' }, length: 1 }, 'passed']) {
			assert.equal(validateCheckResult({ ...result(), checks }, RUN_ID), false);
		}
		for (const id of [1, true, null, {}, '']) {
			assert.equal(validateCheckResult({ ...result(), checks: [{ id, status: 'passed' }] }, RUN_ID), false);
		}
		for (const message of [null, undefined, false, 1, [], {}]) {
			assert.equal(validateCheckResult({ ...result(), checks: [{ id: 'one', status: 'passed', message }] }, RUN_ID), false);
		}
	});

	it('rejects false passes when any required check failed or was blocked', () => {
		for (const status of ['failed', 'blocked'] as const) {
			const input = result();
			input.checks.push({ id: 'not-ready', status });
			assert.equal(validateCheckResult(input, RUN_ID), false);
			assert.equal(validateCheckResult({ ...result(status), status: 'passed' }, RUN_ID), false);
		}
	});

	it('rejects empty or oversized arrays even when every entry would pass', () => {
		for (const status of ['passed', 'failed', 'blocked'] as const) {
			assert.equal(validateCheckResult({ ...result(status), checks: [] }, RUN_ID), false);
		}
		const checks = Array.from({ length: 1001 }, (_, index) => ({ id: String(index), status: 'passed' }));
		assert.equal(validateCheckResult({ ...result(), checks }, RUN_ID), false);
		assert.equal(validateCheckResult({ ...result(), checks: new Array(1_000_000) }, RUN_ID), false);
	});

	it('rejects sparse arrays, invalid entries and incomplete check objects', () => {
		assert.equal(validateCheckResult({ ...result(), checks: new Array(1) }, RUN_ID), false);
		for (const entry of [null, [], 'passed', {}, { id: 'one' }, { status: 'passed' }]) {
			assert.equal(validateCheckResult({ ...result(), checks: [entry] }, RUN_ID), false);
		}
	});

	it('rejects extra fields at every level, including required:false bypass attempts', () => {
		for (const extras of [{ extra: true }, { exitCode: 0 }, { stdout: 'private' }, { schema: 1 }, { extra: undefined }]) {
			assert.equal(validateCheckResult({ ...result(), ...extras }, RUN_ID), false);
		}
		for (const extras of [{ extra: true }, { required: false }, { secret: 'private' }, { message: 'fine', extra: undefined }]) {
			assert.equal(validateCheckResult({ ...result(), checks: [{ id: 'one', status: 'passed', ...extras }] }, RUN_ID), false);
		}
		const arrayWithExtra = Object.assign([...result().checks], { ignored: true });
		assert.equal(validateCheckResult({ ...result(), checks: arrayWithExtra }, RUN_ID), false);
	});

	it('requires unique, bounded, nonblank check IDs without control characters', () => {
		const input = result();
		input.checks.push({ ...input.checks[0] });
		assert.equal(validateCheckResult(input, RUN_ID), false);
		for (const id of [' ', ' leading', 'trailing ', 'line\nbreak', 'nul\u0000', 'x'.repeat(129)]) {
			assert.equal(validateCheckResult({ ...result(), checks: [{ id, status: 'passed' }] }, RUN_ID), false);
		}
	});

	it('enforces an exact 64 KiB UTF-8 JSON limit, including messages and array contents', () => {
		const input = result();
		input.checks[0].message = '';
		const overhead = Buffer.byteLength(JSON.stringify(input), 'utf8');
		input.checks[0].message = 'x'.repeat(MAX_CHECK_RESULT_BYTES - overhead);
		assert.equal(Buffer.byteLength(JSON.stringify(input), 'utf8'), MAX_CHECK_RESULT_BYTES);
		assert.equal(validateCheckResult(input, RUN_ID), true);
		input.checks[0].message += 'x';
		assert.equal(validateCheckResult(input, RUN_ID), false);
		input.checks[0].message = '界'.repeat(24_000);
		assert.equal(validateCheckResult(input, RUN_ID), false);
		const checks = Array.from({ length: 20 }, (_, index) => ({ id: String(index), status: 'passed', message: 'x'.repeat(4000) }));
		assert.equal(validateCheckResult({ ...result(), checks }, RUN_ID), false);
	});

	it('rejects getters and serialization hooks without invoking them', () => {
		let calls = 0;
		const input = result();
		Object.defineProperty(input, 'status', { enumerable: true, get: () => { calls++; return 'passed'; } });
		assert.equal(validateCheckResult(input, RUN_ID), false);
		const entry = { id: 'one', status: 'passed' };
		Object.defineProperty(entry, 'message', { enumerable: true, get: () => { calls++; return 'secret'; } });
		assert.equal(validateCheckResult({ ...result(), checks: [entry] }, RUN_ID), false);
		assert.equal(validateCheckResult({ ...result(), toJSON: () => { calls++; return result(); } }, RUN_ID), false);
		assert.equal(calls, 0);
	});

	it('rejects cycles, inherited properties, symbols and hidden extra keys', () => {
		const circular = result();
		Object.assign(circular.checks[0], { message: circular });
		assert.equal(validateCheckResult(circular, RUN_ID), false);
		assert.equal(validateCheckResult(Object.create(result()), RUN_ID), false);
		const symbol = Object.assign(result(), { [Symbol('extra')]: true });
		assert.equal(validateCheckResult(symbol, RUN_ID), false);
		const hidden = result();
		Object.defineProperty(hidden, 'extra', { value: true });
		assert.equal(validateCheckResult(hidden, RUN_ID), false);
	});

	it('does not mutate or normalize caller data', () => {
		const input = result();
		input.checks[0].message = '';
		const before = JSON.stringify(input);
		Object.freeze(input.checks[0]);
		Object.freeze(input.checks);
		Object.freeze(input);
		assert.equal(validateCheckResult(input, RUN_ID), true);
		assert.equal(JSON.stringify(input), before);
	});
});