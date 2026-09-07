import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/src/test/extension.test.js',
	workspaceFolder: './examples',
	mocha: { ui: 'tdd', timeout: 20000 },
	launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
});
