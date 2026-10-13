import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createToolsEngine } from '../src/server.js';
import { desktopToolDescriptors } from '../src/desktop.js';
import { assertReviewable, assertStatedEffects } from './descriptor-rules.js';
import { PACKAGE_FILES, comparePacked } from './package-files.js';
if (!process.env.npm_execpath) throw new Error('Run with npm run audit:package');
const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0];
// The packed files are the files of the package, no more and no fewer. The
// release build checks the same list (tools/package-files.js).
const difference = comparePacked(packed.files.map(file => file.path));
assert.deepEqual(difference, { unexpected: [], missing: [] }, 'The packed files are not exactly the files of the package');
const allowed = { test: name => PACKAGE_FILES.includes(name) };
for (const file of packed.files) {
  assert.ok(allowed.test(file.path), `Unexpected archive file: ${file.path}`);
  assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
  assert.ok(file.mode & 0o004, `File not readable after normal shared installation: ${file.path}`);
}
for (const name of ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'npm-shrinkwrap.json', 'bin/toolsengine.js', 'docs/clients.md', 'docs/tool-catalogue.json', 'docs/desktop-catalogue.json', 'native/accessibility-desktop.cjs', 'native/accessibility-desktop.ps1', 'src/desktop.js'])
  assert.ok(packed.files.some(f => f.path === name), `Missing required file: ${name}`);
assert.ok(packed.files.find(f => f.path === 'bin/toolsengine.js').mode & 0o111, 'CLI is not executable');
// Development records stay in the source repository. Nothing in the archive
// may name a person's course, account or site, or the internal tool list.
const internal = /canvas|homework|\bHW\d|coursework|elearn\.|\.ucr\.|duo\.|mechanics-lab|\ba_ledger\.|\bagent\.spawn\b|\bpurchase\.|owner_forms/i;
for (const file of packed.files) {
  if (!/\.(?:md|json|js|cjs|ps1)$|^(?:LICENSE|NOTICE)$/.test(file.path)) continue;
  const found = (await fs.readFile(file.path, 'utf8')).match(internal);
  assert.equal(found, null, `Internal material in the archive: ${file.path} contains "${found?.[0]}"`);
}
const catalogue = JSON.parse(await fs.readFile('docs/tool-catalogue.json', 'utf8'));
// The record of what was decided for each legacy tool is kept beside the
// source, outside the package (it lists internal tool names). The public
// repository carries, at reference/curation.json in the package tree, the
// part of it this audit needs without the live-source fields; that copy is
// read when the source record is absent and checked against it otherwise.
const readRecord = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const sourceRecord = await readRecord('../reference/curation.json');
const publicRecord = await readRecord('reference/curation.json');
assert.ok(sourceRecord ?? publicRecord, 'No curation record: neither ../reference/curation.json (beside the source) nor reference/curation.json (the public copy) is present');
const curation = JSON.parse(sourceRecord ?? publicRecord);
if (sourceRecord && publicRecord)
  assert.deepEqual(JSON.parse(publicRecord).tools, curation.tools, 'reference/curation.json, the public copy, differs from ../reference/curation.json in its tools');
const desktopCatalogue = JSON.parse(await fs.readFile('docs/desktop-catalogue.json', 'utf8'));
assert.deepEqual(desktopCatalogue.tools.map(t => t.name).sort(), ['desktop.act','desktop.capture','desktop.inspect','desktop.pointer']);
// The desktop catalogue is compared in full, as the core one is below: it
// used to be checked by tool name only, so its text could drift unnoticed.
assert.deepEqual(desktopCatalogue.tools, JSON.parse(JSON.stringify(desktopToolDescriptors())));
const packageVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
for (const document of [catalogue, desktopCatalogue]) assert.equal(document.version, packageVersion);
assert.equal(catalogue.count, catalogue.tools.length);
for (const tool of [...catalogue.tools, ...desktopCatalogue.tools]) assertReviewable(tool);
assertStatedEffects([...catalogue.tools, ...desktopCatalogue.tools]);
assert.equal(curation.tools.length, 261);
assert.equal(new Set(curation.tools.map(t => t.id)).size, 261);
const engine = await createToolsEngine({ workspace: process.cwd(), headless: true });
try {
  assert.deepEqual(engine.tools.map(t => t.name).sort(), catalogue.tools.map(t => t.name).sort());
  assert.deepEqual(JSON.parse(JSON.stringify(engine.tools.map(({ handler, ...tool }) => tool))), catalogue.tools);
  assert.equal(engine.tools.length, 27);
  for (const row of curation.tools) {
    assert.ok(row.reason && ['replace', 'defer', 'exclude', 'separate'].includes(row.decision));
    for (const name of row.publicTools) assert.ok([...engine.tools, ...desktopCatalogue.tools].some(t => t.name === name));
    if (!engine.tools.some(t => t.name === row.id))
      assert.equal((await engine.call(row.id, {})).isError, true, `Legacy dispatch reachable: ${row.id}`);
  }
  for (const name of ['browser.evaluate', 'browser.run_code_unsafe', 'browser.cookies', 'browser.storage_state'])
    assert.equal((await engine.call(name, {})).isError, true);
} finally { await engine.close(); }
const bytes = await fs.readFile(packed.filename);
const report = {
  artifact: packed.filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  files: packed.files.map(({ path, size, mode }) => ({ path, size, mode })),
  offeredTools: 27, optionalWindowsDesktopTools: 4, reviewedLegacyTools: 261, unofferedDispatch: 'refused',
};
await fs.mkdir('artifacts', { recursive: true });
await fs.writeFile('artifacts/package-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
