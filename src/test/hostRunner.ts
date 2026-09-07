import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: 'tdd', timeout: 20000 });
	mocha.addFile(path.join(__dirname, 'extension.test.js'));
	return new Promise((resolve, reject) => {
		mocha.run(failures => failures ? reject(new Error(`${failures} host tests failed`)) : resolve());
	});
}