'use strict';

// Harmless local runner demonstration, not an exam or learner-answer assessment.
// No network or credential access; only the runner-supplied result file is written.
const fs = require('node:fs/promises');
const { parseArgs } = require('node:util');

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      result: { type: 'string' },
      'run-id': { type: 'string' }
    },
    strict: true,
    allowPositionals: false
  });
  const resultPath = values.result;
  const runId = values['run-id'];
  if (!resultPath || !runId || runId.length > 128 || /[\u0000-\u001f\u007f]/u.test(runId)) {
    throw new Error('Expected --result <filepath> and --run-id <value>.');
  }

  const sum = 2 + 2;
  if (sum !== 4) {
    throw new Error('The local addition demonstration did not match its expectation.');
  }
  const result = {
    schemaVersion: 1,
    runId,
    status: 'passed',
    checks: [{ id: 'addition', status: 'passed', message: '2 + 2 equals 4' }]
  };
  await fs.writeFile(resultPath, JSON.stringify(result), { encoding: 'utf8', flag: 'wx' });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Local demonstration failed.');
  process.exitCode = 1;
});