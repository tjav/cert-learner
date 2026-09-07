// Preserve license notices for every third-party package actually bundled by esbuild.
const fs = require('node:fs/promises');
const path = require('node:path');

// Reviewed upstream notices for exact releases that omitted license files.
// Never apply a fallback to another version without verifying its provenance.
const licenseFallbacks = new Map([
  ['launder@1.7.1', 'licenses/launder-1.7.1.txt']
]);

async function packageRoot(input) {
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name && metadata.version) { return { directory, metadata }; }
    } catch (error) {
      if (error.code !== 'ENOENT') { throw error; }
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate package license metadata for ${input}`);
}

async function writeNotices(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) { continue; }
    const found = await packageRoot(input);
    packages.set(found.directory, found);
  }
  const sections = ['Third-party notices for Certification Learning',
    'These licenses apply to the bundled dependencies, independently of the extension license.'];
  for (const { directory, metadata } of [...packages.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    const names = (await fs.readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name)).sort();
    const notices = [];
    for (const name of names) {
      const file = path.join(directory, name);
      if ((await fs.stat(file)).isFile()) { notices.push({ name, text: await fs.readFile(file, 'utf8') }); }
    }
    const packageId = `${metadata.name}@${metadata.version}`;
    if (!notices.length) {
      const fallback = licenseFallbacks.get(packageId);
      if (!fallback) { throw new Error(`Missing license notice for bundled package ${packageId}`); }
      notices.push({ name: `Upstream fallback: ${fallback}`, text: await fs.readFile(path.join(__dirname, fallback), 'utf8') });
    }
    if (notices.some(notice => !notice.text.trim())) { throw new Error(`Empty license notice for bundled package ${packageId}`); }
    sections.push(`${'='.repeat(72)}\n${metadata.name} ${metadata.version}\nLicense: ${JSON.stringify(metadata.license ?? 'See notice below')}`);
    for (const { name, text } of notices) { sections.push(`${name}\n${text}`); }
  }
  await fs.mkdir('dist', { recursive: true });
  await fs.writeFile('dist/THIRD_PARTY_NOTICES.txt', sections.join('\n\n') + '\n');
}

module.exports = { writeNotices };