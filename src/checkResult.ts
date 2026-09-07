import { identifier, jsonSnapshot, onlyKeys, record } from './core/validation';

export type CheckStatus = 'passed' | 'failed' | 'blocked';

export interface CheckResult {
	schemaVersion: 1;
	runId: string;
	status: CheckStatus;
	checks: { id: string; status: CheckStatus; message?: string }[];
}

export const MAX_CHECK_RESULT_BYTES = 64 * 1024;
const MAX_CHECKS = 1000;

function isStatus(value: unknown): value is CheckStatus {
	return value === 'passed' || value === 'failed' || value === 'blocked';
}

/** Schema validity, NOT completion: a valid failed/blocked result is also true. */
export function validateCheckResult(input: unknown, runId: string): boolean {
	try {
		identifier(runId, 'Expected runId');
		// The snapshot bounds work and rejects accessors, cycles, symbols and coercion.
		// Its conservative punctuation accounting needs headroom; enforce exact bytes below.
		const result = record(jsonSnapshot(input, MAX_CHECK_RESULT_BYTES + 4096, 'Check result'), 'Check result');
		onlyKeys(result, ['schemaVersion', 'runId', 'status', 'checks'], 'Check result');
		if (result.schemaVersion !== 1 || result.runId !== runId || !isStatus(result.status) ||
			!Array.isArray(result.checks) || result.checks.length === 0 || result.checks.length > MAX_CHECKS) {
			return false;
		}
		const ids = new Set<string>();
		let allPassed = true;
		for (const item of result.checks) {
			const check = record(item, 'Check');
			onlyKeys(check, ['id', 'status', 'message'], 'Check');
			const id = identifier(check.id, 'Check id');
			if (ids.has(id) || !isStatus(check.status) ||
				('message' in check && typeof check.message !== 'string')) { return false; }
			ids.add(id);
			allPassed = allPassed && check.status === 'passed';
		}
		if (result.status === 'passed' && !allPassed) { return false; }
		return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_CHECK_RESULT_BYTES;
	} catch {
		return false;
	}
}