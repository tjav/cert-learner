// Exercise the same smoke suite in an explicitly selected desktop host.
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const executable = process.argv[2];
if (!executable) { throw new Error('Supply the target editor executable.'); }
runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'out/src/test/hostRunner.js'),
  launchArgs: [
    path.join(root, 'examples'), '--disable-extensions', '--disable-workspace-trust',
    '--user-data-dir', path.join(root, '.vscode-test', 'target-host-data'),
    '--extensions-dir', path.join(root, '.vscode-test', 'target-host-extensions')
  ]
}).catch(error => { console.error(error); process.exitCode = 1; });